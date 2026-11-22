import { describe, expect, it } from "vitest";
import { runDaily, type RunDeps } from "../src/batch/run";
import { loadBatchEnv } from "../src/batch/config";
import { DailyReportSchema, DigestIndexSchema, LastRunSchema, StateSchema, STORAGE_KEYS } from "../src/shared/schema";
import type { Storage } from "../src/shared/storage";
import { FailingWriteStorage, FakeAssessor, env, fakeFetcher, feedItem, interests, source, tmpStorage } from "./helpers";

// 2026-11-21 07:00 JST
const NOW = new Date("2026-11-20T22:00:00.000Z");
const NEXT_DAY = new Date("2026-11-21T22:00:00.000Z");
const silent = () => undefined;

async function read<T>(storage: Storage, key: string, schema: { parse: (v: unknown) => T }): Promise<T | null> {
  const t = await storage.getText(key);
  return t === null ? null : schema.parse(JSON.parse(t));
}

function deps(storage: Storage, over: Partial<RunDeps>): RunDeps {
  return { storage, fetcher: fakeFetcher({}), assessor: new FakeAssessor(), sources: [source("a")], interests, env, now: () => NOW, log: silent, ...over };
}

describe("runDaily", () => {
  it("creates report with recommendations (max 5) and the new-article list; stores metadata only", async () => {
    const { storage } = tmpStorage();
    const items = Array.from({ length: 8 }, (_, i) => feedItem(i, i + 1, NOW));
    const ai = new FakeAssessor();
    const out = await runDaily(deps(storage, { fetcher: fakeFetcher({ a: items }), assessor: ai, sources: [source("a"), source("b")], env: { ...env, MAX_RECOMMENDATIONS_PER_SOURCE: 5 } }));
    expect(out).toMatchObject({ status: "partial", date: "2026-11-21", articles: 8, recommendations: 5 });
    const report = (await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema))!;
    expect(report.recommendations).toHaveLength(5);
    expect(report.articles).toHaveLength(8);
    // URL は取得プログラムのもの。AI に URL は渡さない
    expect(report.articles[0]!.url).toMatch(/^https:\/\/news\.example\.com\/article\//);
    expect(Object.keys(ai.calls[0]![0]!).sort()).toEqual(["articleId", "publishedAt", "sourceName", "title"]);
    expect(report.articles[0]!.assessment!.assessmentBasis).toBe("metadata_only");
    expect(report.stats.usage).toMatchObject({ aiCalls: 1, aiArticles: 8, inputTokens: 100, outputTokens: 50 });
    // 本文・説明文のフィールドは無い
    expect(JSON.stringify(report)).not.toMatch(/description|summary_ja|body/);
    expect((await read(storage, STORAGE_KEYS.index, DigestIndexSchema))!.latestDate).toBe("2026-11-21");
    expect((await read(storage, STORAGE_KEYS.lastRun, LastRunSchema))!.status).toBe("partial");
  });

  it("does not fetch sources whose fetch/display terms are not permitted, and never sends non-AI sources to AI", async () => {
    const { storage } = tmpStorage();
    const fetcher = fakeFetcher({
      ok: [feedItem(1, 1, NOW)],
      noai: [feedItem(2, 1, NOW)],
      "unknown-fetch": [feedItem(3, 1, NOW)],
      prohibited: [feedItem(4, 1, NOW)],
      nodisplay: [feedItem(5, 1, NOW)],
      disabled: [feedItem(6, 1, NOW)],
    });
    const ai = new FakeAssessor();
    const out = await runDaily(
      deps(storage, {
        fetcher,
        assessor: ai,
        sources: [
          source("ok"),
          source("noai", { ai: "unknown" }),
          source("unknown-fetch", { fetch: "unknown" }),
          source("prohibited", { fetch: "prohibited" }),
          source("nodisplay", { display: "unknown" }),
          source("disabled", { enabled: false }),
        ],
      }),
    );
    expect(out.status).toBe("ok");
    expect(fetcher.called.sort()).toEqual(["noai", "ok"]);
    const report = (await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema))!;
    const noai = report.articles.find((a) => a.sourceId === "noai")!;
    const ok = report.articles.find((a) => a.sourceId === "ok")!;
    expect(ai.sentIds).toEqual([ok.id]);
    // AI 対象外の記事は新着一覧に載るが、評価は無い
    expect(noai).toMatchObject({ aiEligible: false });
    expect(noai.assessment).toBeUndefined();
    expect(report.recommendations.map((r) => r.articleId)).toEqual([ok.id]);
  });

  it("caps AI articles per day (including re-runs) and per source", async () => {
    const { storage } = tmpStorage();
    const a = Array.from({ length: 25 }, (_, i) => feedItem(i, 1, NOW));
    const b = Array.from({ length: 25 }, (_, i) => feedItem(100 + i, 1, NOW, { link: `https://b.example.com/${i}` }));
    const ai = new FakeAssessor();
    const e = { ...env, MAX_AI_ARTICLES_PER_DAY: 30, MAX_AI_ARTICLES_PER_SOURCE: 12 };
    await runDaily(deps(storage, { fetcher: fakeFetcher({ a, b }), assessor: ai, sources: [source("a"), source("b")], env: e }));
    expect(ai.sentIds).toHaveLength(24);
    expect(ai.calls.every((c) => c.length <= env.AI_BATCH_SIZE)).toBe(true);
    // 強制再実行: 評価済みは再送しない。未評価分は日次上限の残り（6 件）まで
    const ai2 = new FakeAssessor();
    await runDaily(deps(storage, { fetcher: fakeFetcher({ a, b }), assessor: ai2, sources: [source("a"), source("b")], env: { ...e, MAX_AI_ARTICLES_PER_SOURCE: 25 }, force: true }));
    expect(ai2.sentIds).toHaveLength(6);
    const state = (await read(storage, STORAGE_KEYS.state, StateSchema))!;
    expect(state.usageByDate["2026-11-21"]!.aiArticles).toBe(30);
  });

  it("is idempotent: same-day re-run is skipped; force reuses cached assessments", async () => {
    const { storage } = tmpStorage();
    const fetcher = fakeFetcher({ a: [feedItem(1, 1, NOW), feedItem(2, 2, NOW)] });
    const ai1 = new FakeAssessor();
    await runDaily(deps(storage, { fetcher, assessor: ai1 }));
    const first = await storage.getText(STORAGE_KEYS.report("2026-11-21"));
    const ai2 = new FakeAssessor();
    expect((await runDaily(deps(storage, { fetcher, assessor: ai2 }))).status).toBe("skipped");
    expect(await storage.getText(STORAGE_KEYS.report("2026-11-21"))).toBe(first);
    const ai3 = new FakeAssessor();
    expect(await runDaily(deps(storage, { fetcher, assessor: ai3, force: true }))).toMatchObject({ status: "ok", articles: 2 });
    expect(ai2.calls).toHaveLength(0);
    expect(ai3.calls).toHaveLength(0);
  });

  it("does not re-assess articles seen on previous days; re-assesses when interests or model change", async () => {
    const { storage } = tmpStorage();
    const item = feedItem(1, 2, NOW);
    await runDaily(deps(storage, { fetcher: fakeFetcher({ a: [item] }) }));
    // 翌日も同じ記事がフィードに残っている → 新着にも載せず、再評価もしない
    const ai = new FakeAssessor();
    const fresh = feedItem(2, 1, NEXT_DAY);
    const out = await runDaily(deps(storage, { fetcher: fakeFetcher({ a: [{ ...item, link: `${item.link}?utm_source=rss` }, fresh] }), assessor: ai, now: () => NEXT_DAY }));
    expect(out).toMatchObject({ date: "2026-11-22", articles: 1 });
    expect(ai.calls.flat().map((c) => c.title)).toEqual([fresh.title]);

    // 同じ日に関心テーマを変えて force → 再評価される
    const ai2 = new FakeAssessor();
    const changed = { themes: [...interests.themes, { id: "new", label: "新テーマ", keywords: ["新"] }] };
    await runDaily(deps(storage, { fetcher: fakeFetcher({ a: [fresh] }), assessor: ai2, interests: changed, now: () => NEXT_DAY, force: true }));
    expect(ai2.calls).toHaveLength(1);
    // モデルを変えても再評価される
    const ai3 = new FakeAssessor();
    Object.assign(ai3, { info: { provider: "bedrock", model: "other-model" } });
    await runDaily(deps(storage, { fetcher: fakeFetcher({ a: [fresh] }), assessor: ai3, interests: changed, now: () => NEXT_DAY, force: true }));
    expect(ai3.calls).toHaveLength(1);
  });

  it("rejects AI output with unknown/duplicate IDs, bad scores, URLs or extra keys; never adopts AI URLs", async () => {
    const { storage } = tmpStorage();
    const items = [1, 2, 3, 4, 5].map((n) => feedItem(n, 1, NOW));
    const ai = new FakeAssessor((input) => {
      const [a, b, c, d, e] = input.map((i) => i.articleId);
      const ok = (id: string | undefined, extra = {}) => ({ articleId: id, category: "technology", relevanceScore: 90, reason: "理由", assessmentBasis: "metadata_only", ...extra });
      return {
        assessments: [
          ok(a),
          ok("ffffffffffffffff"), // 入力にない ID
          ok(b, { relevanceScore: 150 }),
          ok(c, { reason: "詳細は https://evil.example へ" }),
          ok(d, { url: "https://evil.example" }),
          ok(e),
          ok(e, { relevanceScore: 10 }), // 重複 ID
        ],
      };
    });
    await runDaily(deps(storage, { fetcher: fakeFetcher({ a: items }), assessor: ai }));
    const report = (await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema))!;
    const assessed = report.articles.filter((x) => x.assessment);
    expect(assessed.map((x) => x.id)).toEqual([ai.calls[0]![0]!.articleId]);
    expect(JSON.stringify(report)).not.toContain("evil.example");
  });

  it("does not fill recommendations with low-relevance items (0 is fine)", async () => {
    const { storage } = tmpStorage();
    const ai = new FakeAssessor((input) => ({
      assessments: input.map((i) => ({ articleId: i.articleId, category: null, relevanceScore: 20, reason: "関係が薄い", assessmentBasis: "metadata_only" })),
    }));
    const out = await runDaily(deps(storage, { fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW), feedItem(2, 1, NOW)] }), assessor: ai }));
    expect(out).toMatchObject({ status: "ok", recommendations: 0, articles: 2 });
  });

  it("limits recommendations per source and skips near-duplicate titles", async () => {
    const { storage } = tmpStorage();
    const a = [1, 2, 3].map((n) => feedItem(n, n, NOW));
    const b = [feedItem(10, 1, NOW, { link: "https://b.example.com/1", title: `${a[0]!.title}!` })];
    const out = await runDaily(deps(storage, { fetcher: fakeFetcher({ a, b }), sources: [source("a"), source("b")] }));
    const report = (await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema))!;
    expect(out).toMatchObject({ recommendations: 2 });
    expect(report.recommendations.map((r) => report.articles.find((x) => x.id === r.articleId)!.sourceId)).toEqual(["a", "a"]);
  });

  it("marks exact-title duplicates across sources instead of deleting them", async () => {
    const { storage } = tmpStorage();
    const t = "同じタイトルのニュース記事ですよ";
    const ai = new FakeAssessor();
    await runDaily(
      deps(storage, {
        fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW, { title: t })], b: [feedItem(2, 1, NOW, { title: t, link: "https://b.example.com/x" })] }),
        assessor: ai,
        sources: [source("a", { priority: 1 }), source("b", { priority: 2 })],
      }),
    );
    const report = (await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema))!;
    expect(report.articles).toHaveLength(2);
    const dup = report.articles.find((x) => x.sourceId === "b")!;
    expect(dup.duplicateOf).toBe(report.articles.find((x) => x.sourceId === "a")!.id);
    expect(ai.sentIds).toHaveLength(1);
  });

  it("distinguishes normal zero articles from all sources failing; no sources is a normal empty day", async () => {
    const ok = tmpStorage();
    expect(await runDaily(deps(ok.storage, { fetcher: fakeFetcher({ a: [] }) }))).toMatchObject({ status: "ok", articles: 0 });
    const ng = tmpStorage();
    const failed = await runDaily(deps(ng.storage, { fetcher: fakeFetcher({ a: new Error("timeout"), b: new Error("HTTP 500") }), sources: [source("a"), source("b")] }));
    expect(failed).toMatchObject({ status: "failed", reason: "all sources failed" });
    expect(await ng.storage.getText(STORAGE_KEYS.index)).toBeNull();
    expect((await read(ng.storage, STORAGE_KEYS.lastRun, LastRunSchema))!.status).toBe("failed");
    const none = tmpStorage();
    expect(await runDaily(deps(none.storage, { sources: [source("x", { fetch: "unknown" })] }))).toMatchObject({ status: "ok", articles: 0 });
  });

  it("keeps the previous latest when today's run fails", async () => {
    const { storage } = tmpStorage();
    await runDaily(deps(storage, { fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW)] }) }));
    const indexBefore = await storage.getText(STORAGE_KEYS.index);
    expect((await runDaily(deps(storage, { fetcher: fakeFetcher({ a: new Error("down") }), now: () => NEXT_DAY }))).status).toBe("failed");
    expect(await storage.getText(STORAGE_KEYS.index)).toBe(indexBefore);
    const broken = new FailingWriteStorage(storage, (k) => k.startsWith("reports/"));
    expect((await runDaily(deps(broken, { fetcher: fakeFetcher({ a: [feedItem(2, 1, NEXT_DAY)] }), now: () => NEXT_DAY }))).status).toBe("failed");
    expect(await storage.getText(STORAGE_KEYS.index)).toBe(indexBefore);
    expect(await storage.getText(STORAGE_KEYS.report("2026-11-22"))).toBeNull();
  });

  it("continues when an AI call fails and records the article without assessment", async () => {
    const { storage } = tmpStorage();
    const ai = new FakeAssessor(() => {
      throw new Error("ThrottlingException");
    });
    const out = await runDaily(deps(storage, { fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW)] }), assessor: ai }));
    expect(out).toMatchObject({ status: "ok", articles: 1, recommendations: 0 });
  });

  it("rule-based mode (no AI) recommends by interest keywords", async () => {
    const { storage } = tmpStorage();
    const items = [feedItem(1, 1, NOW, { title: "AIエージェントの新サービスを発表" }), feedItem(2, 1, NOW, { title: "新型スマートフォンの発表会" })];
    await runDaily(deps(storage, { fetcher: fakeFetcher({ a: items }), assessor: null }));
    const report = (await read(storage, STORAGE_KEYS.report("2026-11-21"), DailyReportSchema))!;
    expect(report.recommendations).toHaveLength(1);
    const rec = report.articles.find((a) => a.id === report.recommendations[0]!.articleId)!;
    expect(rec.title).toContain("エージェント");
    expect(rec.assessment).toMatchObject({ assessor: { provider: "rules" }, assessmentBasis: "metadata_only" });
  });

  it("excludes undated items unless INCLUDE_UNDATED is set", async () => {
    const items = [feedItem(1, 1, NOW, { publishedAt: null })];
    const a = tmpStorage();
    expect(await runDaily(deps(a.storage, { fetcher: fakeFetcher({ a: items }) }))).toMatchObject({ articles: 0 });
    const b = tmpStorage();
    expect(await runDaily(deps(b.storage, { fetcher: fakeFetcher({ a: items }), env: loadBatchEnv({ INCLUDE_UNDATED: "true" }) }))).toMatchObject({ articles: 1 });
  });

  it("skips when another run holds the lock", async () => {
    const { storage } = tmpStorage();
    const lock = await storage.tryLock(STORAGE_KEYS.lock, 60);
    expect(await runDaily(deps(storage, { fetcher: fakeFetcher({ a: [feedItem(1, 1, NOW)] }) }))).toMatchObject({ status: "skipped", reason: "locked" });
    await lock!.release();
  });
});
