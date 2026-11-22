import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFeed, parseFeed } from "../src/batch/feed";
import { assertSafeUrl, guardedLookup, isBlockedAddress, safeFetch } from "../src/batch/net";
import { toCandidate } from "../src/batch/select";
import { source } from "./helpers";

describe("parseFeed (metadata only)", () => {
  it("parses RSS 2.0 title/link/date/categories and drops description", () => {
    const items = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Hello &amp; World</title><link>https://example.com/a</link>
      <description>&lt;p&gt;Body text&lt;/p&gt;</description><category>AI</category><category>Cloud</category>
      <pubDate>Fri, 20 Nov 2026 09:00:00 +0900</pubDate><enclosure url="https://example.com/a.jpg"/></item>
      <item><title>No date</title><link>https://example.com/b</link></item>
    </channel></rss>`);
    expect(items).toEqual([
      { title: "Hello & World", link: "https://example.com/a", publishedAt: "2026-11-20T00:00:00.000Z", categories: ["AI", "Cloud"] },
      { title: "No date", link: "https://example.com/b", publishedAt: null, categories: [] },
    ]);
    expect(JSON.stringify(items)).not.toContain("Body");
  });

  it("parses RSS 1.0 (RDF) with dc:date and dc:subject", () => {
    const items = parseFeed(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>c</title></channel>
      <item><title>報道発表</title><link>https://example.go.jp/x.html</link><dc:date>2026-11-20T10:00:00+09:00</dc:date><dc:subject>制度</dc:subject></item>
    </rdf:RDF>`);
    expect(items).toEqual([{ title: "報道発表", link: "https://example.go.jp/x.html", publishedAt: "2026-11-20T01:00:00.000Z", categories: ["制度"] }]);
  });

  it("parses Atom with alternate link and category terms", () => {
    const items = parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>T</title><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/alt"/>
      <summary>S</summary><category term="ml"/><updated>2026-11-20T00:00:00Z</updated></entry></feed>`);
    expect(items).toEqual([{ title: "T", link: "https://example.com/alt", publishedAt: "2026-11-20T00:00:00.000Z", categories: ["ml"] }]);
  });

  it("strips markup and control characters from titles", () => {
    const [item] = parseFeed(`<rss><channel><item><title>&lt;img src=x onerror=alert(1)&gt;危険‮な&lt;script&gt;alert(1)&lt;/script&gt;タイトル</title><link>https://example.com/x</link></item></channel></rss>`);
    expect(item!.title).toBe("危険 な タイトル");
  });

  it("rejects DTD entity declarations (XXE / entity expansion)", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&x;</title><link>https://e.com</link></item></channel></rss>`;
    expect(() => parseFeed(xxe)).toThrow(/not allowed/);
    const bomb = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><rss/>`;
    expect(() => parseFeed(bomb)).toThrow(/not allowed/);
  });

  it("throws on non-feed or malformed content", () => {
    expect(() => parseFeed("<html><body>not a feed</body></html>")).toThrow();
  });

  it("decodes Shift_JIS declared feeds", () => {
    const head = new TextEncoder().encode('<?xml version="1.0" encoding="Shift_JIS"?><rss version="2.0"><channel><item><title>');
    const sjis = new Uint8Array([0x91, 0x8d, 0x96, 0xb1]); // 総務
    const tail = new TextEncoder().encode("</title><link>https://example.go.jp/a</link></item></channel></rss>");
    expect(parseFeed(decodeFeed(new Uint8Array([...head, ...sjis, ...tail]), null))[0]!.title).toBe("総務");
  });

  it("rejects non-http(s) article links", () => {
    expect(toCandidate({ title: "t", link: "javascript:alert(1)", publishedAt: null, categories: [] }, source("s"), true)).toBeNull();
    expect(toCandidate({ title: "t", link: "data:text/html,x", publishedAt: null, categories: [] }, source("s"), true)).toBeNull();
  });
});

describe("network guard (SSRF)", () => {
  it("blocks internal, loopback, link-local/metadata and mapped addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8"]) expect(isBlockedAddress(a), a).toBe(false);
  });

  it("allows only https URLs without credentials, odd ports or internal hosts", () => {
    expect(assertSafeUrl("https://example.com/feed").hostname).toBe("example.com");
    for (const u of ["http://example.com/feed", "file:///etc/passwd", "ftp://example.com", "https://user:pw@example.com/", "https://localhost/", "https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest/meta-data", "https://example.com:8443/", "not a url"]) {
      expect(() => assertSafeUrl(u), u).toThrow();
    }
  });

  it("rejects hostnames that resolve to internal addresses (checked at connect time)", async () => {
    const lookup = guardedLookup((_h, _o, cb) => cb(null, [{ address: "169.254.169.254", family: 4 }]));
    await new Promise<void>((resolve) =>
      lookup("evil.example", { all: true }, (err) => {
        expect(String(err)).toMatch(/not allowed/);
        resolve();
      }),
    );
  });

  describe("with a local test server", () => {
    let server: Server;
    let base: string;
    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url === "/ok") return res.end("<rss/>");
        if (req.url === "/big") return res.end("x".repeat(5000));
        if (req.url === "/slow") return setTimeout(() => res.end("late"), 2000);
        if (req.url === "/to-metadata") {
          res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data/" });
          return res.end();
        }
        if (req.url === "/to-http") {
          res.writeHead(301, { location: "http://example.com/feed" });
          return res.end();
        }
        if (req.url === "/loop") {
          res.writeHead(302, { location: "/loop" });
          return res.end();
        }
        res.writeHead(500).end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    // テストサーバーは http://127.0.0.1（IP 直指定のため名前解決は行われない）。本番は https のみ・既定の guardedLookup
    const opts = (o: object = {}) => ({
      timeoutMs: 500,
      maxBytes: 1000,
      maxRedirects: 2,
      userAgent: "test",
      insecureAllowHttpForTest: true,
      lookup: guardedLookup((_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }])),
      ...o,
    });

    it("fetches, enforces size and timeout limits, and validates redirect targets", async () => {
      expect(new TextDecoder().decode((await safeFetch(`${base}/ok`, opts())).body)).toBe("<rss/>");
      await expect(safeFetch(`${base}/big`, opts())).rejects.toThrow(/too large/);
      await expect(safeFetch(`${base}/slow`, opts())).rejects.toThrow(/timeout/);
      await expect(safeFetch(`${base}/to-metadata`, opts())).rejects.toThrow(/not allowed/);
      await expect(safeFetch(`${base}/loop`, opts())).rejects.toThrow(/too many redirects/);
      await expect(safeFetch(`${base}/missing`, opts())).rejects.toThrow(/HTTP 500/);
    });

    it("blocks the connection when the resolved address is internal", async () => {
      const internal = guardedLookup((_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]));
      await expect(safeFetch(`http://feed.example:${new URL(base).port}/ok`, opts({ lookup: internal }))).rejects.toThrow(/not allowed/);
    });
  });
});
