import { describe, expect, it } from "vitest";
import { decodeFeed, parseFeed } from "../src/batch/feed";
import { toCandidate } from "../src/batch/select";
import type { Source } from "../src/batch/config";

const src: Source = { id: "s", name: "S", url: "https://example.com/feed", enabled: true, defaultCategory: "tech", priority: 1, official: true, allowFullText: false };

describe("parseFeed", () => {
  it("parses RSS 2.0 and strips HTML", () => {
    const items = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Hello &amp; World</title><link>https://example.com/a</link>
      <description>&lt;p&gt;Body &lt;b&gt;text&lt;/b&gt;&lt;/p&gt;</description><pubDate>Fri, 20 Nov 2026 09:00:00 +0900</pubDate></item>
      <item><title>No date</title><link>https://example.com/b</link></item>
    </channel></rss>`);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "Hello & World", link: "https://example.com/a", description: "Body text", publishedAt: "2026-11-20T00:00:00.000Z" });
    expect(items[1]!.publishedAt).toBeNull();
    expect(items[1]!.description).toBe("");
  });

  it("parses RSS 1.0 (RDF) with dc:date", () => {
    const items = parseFeed(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>c</title></channel>
      <item><title>報道発表</title><link>https://example.go.jp/x.html</link><dc:date>2026-11-20T10:00:00+09:00</dc:date></item>
    </rdf:RDF>`);
    expect(items).toEqual([{ title: "報道発表", link: "https://example.go.jp/x.html", description: "", publishedAt: "2026-11-20T01:00:00.000Z" }]);
  });

  it("parses Atom with alternate link", () => {
    const items = parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>T</title><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/alt"/>
      <summary>S</summary><updated>2026-11-20T00:00:00Z</updated></entry></feed>`);
    expect(items).toEqual([{ title: "T", link: "https://example.com/alt", description: "S", publishedAt: "2026-11-20T00:00:00.000Z" }]);
  });

  it("throws on non-feed content", () => {
    expect(() => parseFeed("<html><body>not a feed</body></html>")).toThrow();
  });

  it("decodes Shift_JIS declared feeds", () => {
    // 「総務」 in Shift_JIS
    const head = new TextEncoder().encode('<?xml version="1.0" encoding="Shift_JIS"?><rss version="2.0"><channel><item><title>');
    const sjis = new Uint8Array([0x91, 0x8d, 0x96, 0xb1]);
    const tail = new TextEncoder().encode("</title><link>https://example.go.jp/a</link></item></channel></rss>");
    const bytes = new Uint8Array([...head, ...sjis, ...tail]);
    expect(parseFeed(decodeFeed(bytes, null))[0]!.title).toBe("総務");
  });
});

describe("content basis", () => {
  it("marks items without description as title_only", () => {
    const c = toCandidate({ title: "t", link: "https://example.com/a", description: "", publishedAt: null }, src)!;
    expect(c.contentBasis).toBe("title_only");
    const d = toCandidate({ title: "t", link: "https://example.com/a", description: "desc", publishedAt: null }, src)!;
    expect(d.contentBasis).toBe("rss_description");
  });
});
