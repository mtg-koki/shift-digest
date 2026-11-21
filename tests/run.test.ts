import { describe, expect, it } from "vitest";
import { runDaily } from "../src/batch/run";
import { DailyReportSchema, DigestIndexSchema, LastRunSchema, StateSchema, STORAGE_KEYS } from "../src/shared/schema";
import type { Storage } from "../src/shared/storage";
import { CountingSummarizer, FailingWriteStorage, env, fakeFetcher, feedItem, source, tmpStorage } from "./helpers";

// 2026-11-21 07:00 JST
const NOW = new Date("2026-11-20T22:00:00.000Z");
const NEXT_DAY = new Date("2026-11-21T22:00:00.000Z");
const silent = () => undefined;

async function read<T>(storage: Storage, key: string, schema: { parse: (v: unknown) => T }): Promise<T | null> {
  const t = await storage.getText(key);
  return t === null ? null : schema.parse(JSON.parse(t));
}

describe("runDaily", () => {
  it("creates report, then index; respects publish limit", async () => {
    const { storage } = tmpStorage();
    const items = Array.from({ length: 8 }, (_, i) => feedItem(i, i + 1, NOW));
    const summarizer = new CountingSummarizer();
    const out = await runDaily({ storage, fetcher: fakeFetcher({ a: items }), summarizer, sources: [source("a")], env, now: () => NOW, log: silent });
    expect(out).toMatchObject({ status: "ok", date: "2026-11-21", published: 5 });
    const report = await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema);
    expect(report!.articles).toHaveLength(5);
    // URL は取得プログラムのものを使う
    expect(report!.articles[0]!.url).toMatch(/^https:\/\/news\.example\.com\/article\//);
    expect(report!.stats.usage).toEqual({ aiCalls: 8, inputTokens: 800, outputTokens: 400 });
    const index = await read(storage, STORAGE_KEYS.index, DigestIndexSchema);
    expect(index!.latestDate).toBe("2026-11-21");
    expect((await read(storage, STORAGE_KEYS.lastRun, LastRunSchema))!.status).toBe("ok");
  });

  it("caps AI calls per day at MAX_AI_ARTICLES_PER_DAY, including manual re-runs", async () => {
    const { storage } = tmpStorage();
    const items = Array.from({ length: 15 }, (_, i) => feedItem(i, 1, NOW));
    const s1 = new CountingSummarizer();
    await runDaily({ storage, fetcher: fakeFetcher({ a: items }), summarizer: s1, sources: [source("a")], env, now: () => NOW, log: silent });
    expect(s1.calls).toHaveLength(10);

    // 新しい記事が増えた状態で強制再実行しても、当日の上限を超えない
    const more = [...items, ...Array.from({ length: 5 }, (_, i) => feedItem(100 + i, 1, NOW))];
    const s2 = new CountingSummarizer();
    await runDaily({ storage, fetcher: fakeFetcher({ a: more }), summarizer: s2, sources: [source("a")], env, now: () => NOW, force: true, log: silent });
    expect(s2.calls).toHaveLength(0);
    const state = await read(storage, STORAGE_KEYS.state, StateSchema);
    expect(state!.usageByDate["2026-11-21"]!.aiCalls).toBe(10);
  });

  it("is idempotent: same-day re-run is skipped; --force reuses cached summaries", async () => {
    const { storage } = tmpStorage();
    const items = Array.from({ length: 3 }, (_, i) => feedItem(i, 1, NOW));
    const deps = { storage, fetcher: fakeFetcher({ a: items }), sources: [source("a")], env, now: () => NOW, log: silent };
    const s1 = new CountingSummarizer();
    await runDaily({ ...deps, summarizer: s1 });
    const first = await storage.getText(STORAGE_KEYS.report("2026-11-21"));

    const s2 = new CountingSummarizer();
    const again = await runDaily({ ...deps, summarizer: s2 });
    expect(again.status).toBe("skipped");
    expect(s2.calls).toHaveLength(0);
    expect(await storage.getText(STORAGE_KEYS.report("2026-11-21"))).toBe(first);

    const s3 = new CountingSummarizer();
    const forced = await runDaily({ ...deps, summarizer: s3, force: true });
    expect(forced).toMatchObject({ status: "ok", published: 3 });
    expect(s3.calls).toHaveLength(0);
    const index = await read(storage, STORAGE_KEYS.index, DigestIndexSchema);
    expect(index!.dates).toHaveLength(1);
  });

  it("does not republish articles already published on a previous day", async () => {
    const { storage } = tmpStorage();
    const items = [feedItem(1, 2, NOW), feedItem(2, 3, NOW)];
    await runDaily({ storage, fetcher: fakeFetcher({ a: items }), summarizer: new CountingSummarizer(), sources: [source("a")], env, now: () => NOW, log: silent });
    const fresh = feedItem(3, 1, NEXT_DAY);
    // 同じ記事が URL の表記ゆれ付きで再掲されても既出扱い
    const repost = { ...items[0]!, link: `${items[0]!.link}/?utm_source=rss` };
    const s = new CountingSummarizer();
    const out = await runDaily({ storage, fetcher: fakeFetcher({ a: [repost, fresh] }), summarizer: s, sources: [source("a")], env, now: () => NEXT_DAY, log: silent });
    expect(out).toMatchObject({ status: "ok", date: "2026-11-22", published: 1 });
    expect(s.calls.map((c) => c.originalTitle)).toEqual([fresh.title]);
    const index = await read(storage, STORAGE_KEYS.index, DigestIndexSchema);
    expect(index!.dates.map((d) => d.date)).toEqual(["2026-11-22", "2026-11-21"]);
  });

  it("partial source failure still produces a report with status partial", async () => {
    const { storage } = tmpStorage();
    const out = await runDaily({
      storage,
      fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW)], b: new Error("HTTP 503") }),
      summarizer: new CountingSummarizer(),
      sources: [source("a"), source("b")],
      env,
      now: () => NOW,
      log: silent,
    });
    expect(out.status).toBe("partial");
    const report = await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema);
    expect(report!.sources.find((s) => s.id === "b")).toMatchObject({ ok: false, error: "HTTP 503" });
    expect(report!.articles).toHaveLength(1);
  });

  it("distinguishes normal zero articles from all sources failing", async () => {
    // 正常 0 件: report と index が作られる
    const ok = tmpStorage();
    const zero = await runDaily({ storage: ok.storage, fetcher: fakeFetcher({ a: [] }), summarizer: new CountingSummarizer(), sources: [source("a")], env, now: () => NOW, log: silent });
    expect(zero).toMatchObject({ status: "ok", published: 0 });
    expect((await read(ok.storage, STORAGE_KEYS.index, DigestIndexSchema))!.dates[0]!.articleCount).toBe(0);

    // 全取得失敗: failed。report も index も作られない
    const ng = tmpStorage();
    const failed = await runDaily({ storage: ng.storage, fetcher: fakeFetcher({ a: new Error("timeout"), b: new Error("HTTP 500") }), summarizer: new CountingSummarizer(), sources: [source("a"), source("b")], env, now: () => NOW, log: silent });
    expect(failed).toMatchObject({ status: "failed", reason: "all sources failed" });
    expect(await ng.storage.getText(STORAGE_KEYS.report("2026-11-21"))).toBeNull();
    expect(await ng.storage.getText(STORAGE_KEYS.index)).toBeNull();
    expect((await read(ng.storage, STORAGE_KEYS.lastRun, LastRunSchema))!.status).toBe("failed");
  });

  it("keeps the previous latest when today's run fails", async () => {
    const { storage } = tmpStorage();
    await runDaily({ storage, fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW)] }), summarizer: new CountingSummarizer(), sources: [source("a")], env, now: () => NOW, log: silent });
    const indexBefore = await storage.getText(STORAGE_KEYS.index);

    // 翌日: 全取得失敗
    const r1 = await runDaily({ storage, fetcher: fakeFetcher({ a: new Error("down") }), summarizer: new CountingSummarizer(), sources: [source("a")], env, now: () => NEXT_DAY, log: silent });
    expect(r1.status).toBe("failed");
    expect(await storage.getText(STORAGE_KEYS.index)).toBe(indexBefore);

    // 翌日: report の書き込みで失敗
    const broken = new FailingWriteStorage(storage, (k) => k.startsWith("reports/"));
    const r2 = await runDaily({ storage: broken, fetcher: fakeFetcher({ a: [feedItem(2, 1, NEXT_DAY)] }), summarizer: new CountingSummarizer(), sources: [source("a")], env, now: () => NEXT_DAY, log: silent });
    expect(r2.status).toBe("failed");
    expect(await storage.getText(STORAGE_KEYS.index)).toBe(indexBefore);
    expect(await storage.getText(STORAGE_KEYS.report("2026-11-22"))).toBeNull();

    // 翌日: index の書き込みで失敗しても、既存 index は壊れない
    const brokenIndex = new FailingWriteStorage(storage, (k) => k === STORAGE_KEYS.index);
    const r3 = await runDaily({ storage: brokenIndex, fetcher: fakeFetcher({ a: [feedItem(2, 1, NEXT_DAY)] }), summarizer: new CountingSummarizer(), sources: [source("a")], env, now: () => NEXT_DAY, log: silent });
    expect(r3.status).toBe("failed");
    const idx = await read(storage, STORAGE_KEYS.index, DigestIndexSchema);
    expect(idx!.latestDate).toBe("2026-11-21");
  });

  it("skips invalid AI output and never trusts AI for URLs", async () => {
    const { storage } = tmpStorage();
    const s = new CountingSummarizer((i) =>
      i.originalTitle.includes("1 ")
        ? { title_ja: "x", summary_ja: "詳細は https://evil.example", category: "tech", relevance: 3 }
        : { title_ja: `和訳 ${i.originalTitle}`, summary_ja: "要約", category: "tech", relevance: 2, url: "https://evil.example" },
    );
    const out = await runDaily({ storage, fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW), feedItem(2, 1, NOW)] }), summarizer: s, sources: [source("a")], env, now: () => NOW, log: silent });
    expect(out).toMatchObject({ status: "ok", published: 0 });
  });

  it("passes title_only basis to the summarizer and keeps it in data", async () => {
    const { storage } = tmpStorage();
    const s = new CountingSummarizer();
    await runDaily({ storage, fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW, { description: "" })] }), summarizer: s, sources: [source("a")], env, now: () => NOW, log: silent });
    expect(s.calls[0]!.contentBasis).toBe("title_only");
    expect(s.calls[0]!.text).toBe("");
    const report = await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema);
    expect(report!.articles[0]!.contentBasis).toBe("title_only");
  });

  it("truncates AI input to AI_MAX_INPUT_CHARS and records it", async () => {
    const { storage } = tmpStorage();
    const s = new CountingSummarizer();
    const long = "あ".repeat(env.AI_MAX_INPUT_CHARS + 500);
    await runDaily({ storage, fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW, { description: long })] }), summarizer: s, sources: [source("a")], env, now: () => NOW, log: silent });
    expect(s.calls[0]!.text).toHaveLength(env.AI_MAX_INPUT_CHARS);
    const report = await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema);
    expect(report!.articles[0]!.inputTruncated).toBe(true);
  });

  it("skips when another run holds the lock", async () => {
    const { storage } = tmpStorage();
    const lock = await storage.tryLock(STORAGE_KEYS.lock, 60);
    const s = new CountingSummarizer();
    const out = await runDaily({ storage, fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW)] }), summarizer: s, sources: [source("a")], env, now: () => NOW, log: silent });
    expect(out).toMatchObject({ status: "skipped", reason: "locked" });
    expect(s.calls).toHaveLength(0);
    await lock!.release();
    expect((await runDaily({ storage, fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW)] }), summarizer: s, sources: [source("a")], env, now: () => NOW, log: silent })).status).toBe("ok");
  });
});
