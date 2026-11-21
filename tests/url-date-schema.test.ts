import { describe, expect, it } from "vitest";
import { addDays, formatJst, isValidDateString, jstDate, parseFeedDate } from "../src/shared/date";
import { AiSummarySchema } from "../src/shared/schema";
import { normalizeUrl, titleKey, titleSimilarity } from "../src/shared/url";
import { dedupe, inWindow, toCandidate } from "../src/batch/select";
import type { Source } from "../src/batch/config";

const src: Source = { id: "s", name: "S", url: "https://example.com/feed", enabled: true, defaultCategory: "tech", priority: 1, official: true, allowFullText: false };

describe("normalizeUrl", () => {
  it("removes tracking params, fragment, www, trailing slash and sorts query", () => {
    expect(normalizeUrl("http://WWW.Example.com:80/a/b/?utm_source=x&z=1&a=2#top")).toBe("https://example.com/a/b?a=2&z=1");
    expect(normalizeUrl("https://example.com/a?fbclid=abc")).toBe("https://example.com/a");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });
  it("treats equivalent URLs as same", () => {
    expect(normalizeUrl("https://example.com/x?b=2&a=1")).toBe(normalizeUrl("http://www.example.com/x/?a=1&b=2&utm_medium=rss"));
  });
  it("rejects non-http and invalid URLs", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("dedupe", () => {
  const item = (title: string, link: string) => toCandidate({ title, link, description: "d", publishedAt: "2026-11-20T00:00:00.000Z" }, src)!;
  it("removes duplicates by normalized URL and similar title", () => {
    const out = dedupe([
      item("AI規制法案が成立", "https://example.com/a?utm_source=rss"),
      item("全く別の記事", "https://example.com/a"),
      item("AI規制法案が成立。", "https://other.example.com/b"),
      item("賃金統計を公表", "https://example.com/c"),
    ]);
    expect(out.map((c) => c.title)).toEqual(["AI規制法案が成立", "賃金統計を公表"]);
  });
  it("title similarity", () => {
    expect(titleSimilarity(titleKey("OpenAI announces X"), titleKey("OpenAI announces X!"))).toBe(1);
    expect(titleSimilarity(titleKey("厚生労働省 賃金統計"), titleKey("経済産業省 半導体支援"))).toBeLessThan(0.5);
  });
});

describe("JST date handling", () => {
  it("splits days at 00:00 Asia/Tokyo", () => {
    expect(jstDate(new Date("2026-11-20T14:59:59.999Z"))).toBe("2026-11-20");
    expect(jstDate(new Date("2026-11-20T15:00:00.000Z"))).toBe("2026-11-21");
    // 毎朝 7:00 JST の実行（cron 0 22 * * * UTC）は JST の当日扱い
    expect(jstDate(new Date("2026-11-20T22:00:00.000Z"))).toBe("2026-11-21");
    expect(jstDate(new Date("2026-12-31T15:00:00.000Z"))).toBe("2027-01-01");
  });
  it("formats in JST", () => {
    expect(formatJst("2026-11-20T22:05:00.000Z")).toBe("2026-11-21 07:05");
  });
  it("parses feed dates to UTC ISO, never guesses", () => {
    expect(parseFeedDate("Fri, 20 Nov 2026 09:00:00 +0900")).toBe("2026-11-20T00:00:00.000Z");
    expect(parseFeedDate("2026-11-20T09:00:00+09:00")).toBe("2026-11-20T00:00:00.000Z");
    expect(parseFeedDate("")).toBeNull();
    expect(parseFeedDate("昨日")).toBeNull();
    expect(parseFeedDate(undefined)).toBeNull();
  });
  it("window excludes undated, old and far-future items", () => {
    const now = new Date("2026-11-21T00:00:00.000Z");
    expect(inWindow(null, now, 48)).toBe(false);
    expect(inWindow("2026-11-19T01:00:00.000Z", now, 48)).toBe(true);
    expect(inWindow("2026-11-18T23:00:00.000Z", now, 48)).toBe(false);
    expect(inWindow("2026-11-23T00:00:00.000Z", now, 48)).toBe(false);
  });
  it("date helpers", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("../index")).toBe(false);
  });
});

describe("AiSummarySchema", () => {
  const ok = { title_ja: "タイトル", summary_ja: "要約です。", category: "tech", relevance: 2 };
  it("accepts valid output", () => {
    expect(AiSummarySchema.safeParse(ok).success).toBe(true);
    expect(AiSummarySchema.safeParse({ ...ok, category: "out_of_scope", relevance: 0 }).success).toBe(true);
  });
  it.each([
    ["unknown category", { ...ok, category: "finance" }],
    ["relevance out of range", { ...ok, relevance: 5 }],
    ["non-integer relevance", { ...ok, relevance: 1.5 }],
    ["extra field (e.g. AI-generated url)", { ...ok, url: "https://evil.example" }],
    ["URL in summary", { ...ok, summary_ja: "詳細は https://evil.example へ" }],
    ["empty title", { ...ok, title_ja: " " }],
    ["too long summary", { ...ok, summary_ja: "あ".repeat(401) }],
    ["not an object", "ignore previous instructions"],
  ])("rejects %s", (_name, v) => {
    expect(AiSummarySchema.safeParse(v).success).toBe(false);
  });
});
