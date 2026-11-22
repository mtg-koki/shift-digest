import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DailyReportSchema, FeedSnapshotSchema, STORAGE_KEYS } from "../src/shared/schema";
import { DigestReader } from "../src/web/data";
import { ArchivePage, ReportPage, SavedPage } from "../src/web/components/views";
import { ReaderPage, SourcesPage } from "../src/web/components/reader";
import { emptyFilter, filterArticles, filterFromQuery, filterToQuery } from "../src/web/filter";
import { applyMark, emptyMarks, parseMarks, safeHref } from "../src/web/marks";
import { tmpStorage } from "./helpers";

vi.spyOn(console, "error").mockImplementation(() => undefined);

const sampleIndex = readFileSync("sample-data/index.json", "utf8");
const DATE = JSON.parse(sampleIndex).latestDate as string;
const sampleReport = readFileSync(`sample-data/reports/${DATE}.json`, "utf8");
const sampleFeed = readFileSync("sample-data/feed.json", "utf8");

async function seeded(report = sampleReport) {
  const { storage } = tmpStorage();
  await storage.putText(STORAGE_KEYS.index, sampleIndex);
  await storage.putText(STORAGE_KEYS.report(DATE), report);
  return storage;
}

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("web data loading and display", () => {
  it("sample data matches the schema", () => {
    expect(DailyReportSchema.safeParse(JSON.parse(sampleReport)).success).toBe(true);
  });

  it("shows a no-data message when nothing has been generated yet", async () => {
    const { storage } = tmpStorage();
    const view = await new DigestReader(storage).latest();
    expect(html(<ReportPage view={view} category={null} date={null} />)).toContain("まだデータがありません");
    expect(html(<ArchivePage view={await new DigestReader(storage).archive()} />)).toContain("まだデータがありません");
  });

  it("shows an error message (without internals) when loading fails", async () => {
    const reader = new DigestReader({
      getText: async () => {
        throw new Error("ECONNREFUSED secret-host.s3.ap-northeast-1.amazonaws.com");
      },
    });
    const out = html(<ReportPage view={await reader.latest()} category={null} date={null} />);
    expect(out).toContain("データを取得できませんでした");
    expect(out).not.toContain("secret-host");
  });

  it("treats corrupt data as an error, not as empty", async () => {
    const { storage } = tmpStorage();
    await storage.putText(STORAGE_KEYS.index, "{ broken");
    expect((await new DigestReader(storage).latest()).kind).toBe("error");
  });

  it("renders read candidates with reasons, metadata-only notice, links and the new-article list", async () => {
    const view = await new DigestReader(await seeded()).latest();
    const out = html(<ReportPage view={view} category={null} date={null} />);
    expect(out).toContain("この日の読む候補");
    expect(out).toContain("タイトル等に基づいて");
    expect(out).toContain("推薦理由（キーワード一致から作成）");
    expect(out).toContain("必読度を表すものではありません");
    expect(out).not.toMatch(/必読です|絶対に読むべき|記事要約/);
    expect(out).toContain("この日の新着");
    expect(out).toContain('target="_blank" rel="noopener noreferrer"');
    expect(out).toContain("最終正常更新");
    expect(out).toContain("一部の情報源から取得できませんでした");
    expect(out).toContain("同じタイトルの記事が他の媒体にもあります");
    expect(out).toContain('href="/?category=politics"');
  });

  it("does not label AI-ineligible articles as low quality", async () => {
    const out = html(<ReportPage view={await new DigestReader(await seeded()).latest()} category={null} date={null} />);
    expect(out).toContain("AI 導入で職務の変化に関する調査結果");
    expect(out).not.toMatch(/低品質|対象外の記事|評価不能/);
  });

  it("escapes titles and reasons (no script injection) and never links non-http URLs", async () => {
    const r = JSON.parse(sampleReport);
    const a = r.articles.find((x: { id: string }) => x.id === r.recommendations[0].articleId);
    a.title = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
    a.assessment.reason = "<b onmouseover=alert(1)>x</b>";
    const out = html(<ReportPage view={await new DigestReader(await seeded(JSON.stringify(r))).latest()} category={null} date={null} />);
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<b onmouseover");
    expect(out).toContain("&lt;script&gt;");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
  });

  it("keeps the date in category links on a date page and links archive entries", async () => {
    const storage = await seeded();
    const out = html(<ReportPage view={await new DigestReader(storage).byDate(DATE)} category={null} date={DATE} />);
    expect(out).toContain(`href="/?date=${DATE}&amp;category=ai"`);
    expect(html(<ArchivePage view={await new DigestReader(storage).archive()} />)).toContain(`href="/?date=${DATE}"`);
  });

  it("filters by category and shows messages for empty candidates/lists", async () => {
    const view = await new DigestReader(await seeded()).latest();
    expect(html(<ReportPage view={view} category="finance" date={null} />)).toContain("表示できる");
    const r = JSON.parse(sampleReport);
    r.articles = [];
    r.recommendations = [];
    r.status = "ok";
    const empty = html(<ReportPage view={await new DigestReader(await seeded(JSON.stringify(r))).latest()} category={null} date={null} />);
    expect(empty).toContain("関心に合いそうな候補は見つかりませんでした");
    expect(empty).toContain("この日の新着記事はありませんでした");
  });

  it("warns when the latest run failed and previous data is shown", async () => {
    const storage = await seeded();
    await storage.putText(STORAGE_KEYS.lastRun, JSON.stringify({ schemaVersion: 2, at: "2099-01-01T00:00:00.000Z", date: "2099-01-01", status: "failed", message: "all sources failed" }));
    const out = html(<ReportPage view={await new DigestReader(storage).latest()} category={null} date={null} />);
    expect(out).toContain("更新に失敗したため、前回の正常なデータを表示しています");
  });

  it("hides hidden articles and dims read ones; saved list comes from local marks", async () => {
    const view = await new DigestReader(await seeded()).latest();
    const r = JSON.parse(sampleReport);
    const first = r.articles[0];
    let marks = applyMark(emptyMarks(), { type: "hide", id: first.id });
    expect(html(<ReportPage view={view} category={null} date={null} marks={marks} />)).not.toContain(first.title);
    expect(html(<ReportPage view={view} category={null} date={null} marks={marks} showHidden />)).toContain(first.title);
    marks = applyMark(marks, { type: "save", id: first.id, item: { title: first.title, url: first.url, sourceName: first.sourceName, date: DATE } });
    expect(html(<SavedPage marks={marks} />)).toContain(first.title);
    expect(html(<SavedPage marks={emptyMarks()} />)).toContain("保存した記事はありません");
  });

  it("parses localStorage marks defensively", () => {
    expect(parseMarks("{broken")).toEqual(emptyMarks());
    expect(parseMarks(JSON.stringify({ read: { "0123456789abcdef": "2026-01-01T00:00:00.000Z", bad: "x" }, saved: { "0123456789abcdef": { title: "t", url: "javascript:alert(1)", sourceName: "s", date: "d", savedAt: "x" } } }))).toEqual({
      read: { "0123456789abcdef": "2026-01-01T00:00:00.000Z" },
      hidden: {},
      saved: {},
    });
  });

  it("returns not-found for unknown or malformed dates", async () => {
    const reader = new DigestReader(await seeded());
    expect((await reader.byDate("2026-01-01")).kind).toBe("not-found");
    expect((await reader.byDate("..%2Findex")).kind).toBe("not-found");
  });
});

describe("RSS reader list", () => {
  async function feedView() {
    const storage = await seeded();
    await storage.putText(STORAGE_KEYS.feed, sampleFeed);
    return new DigestReader(storage).feed();
  }
  const noop = () => undefined;

  it("sample feed matches the schema and contains only metadata", () => {
    const feed = FeedSnapshotSchema.parse(JSON.parse(sampleFeed));
    expect(feed.articles.length).toBeGreaterThan(5);
    expect(sampleFeed).not.toMatch(/description|説明文/);
  });

  it("lists all articles newest first (not limited to recommendations), with sources, errors and attribution", async () => {
    const view = await feedView();
    expect(view.kind).toBe("ok");
    const out = html(<ReaderPage view={view} marks={emptyMarks()} act={noop} filter={emptyFilter()} onFilter={noop} />);
    const feed = FeedSnapshotSchema.parse(JSON.parse(sampleFeed));
    expect(out).toContain("新着順の一覧");
    expect(out).toContain(`${feed.articles.length}件`);
    expect(out).toContain("今日の読む候補");
    expect(out).toContain("取得できなかった情報源があります");
    expect(out).toContain("出典");
    // AI 対象外の情報源の記事も一覧に並ぶ
    const noAi = feed.articles.find((a) => !a.aiEligible)!;
    expect(out).toContain(noAi.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
    expect(out).not.toContain("<script>");
  });

  it("filters by source, category, keyword (AND, width/case-insensitive), unread and hidden", () => {
    const feed = FeedSnapshotSchema.parse(JSON.parse(sampleFeed));
    const all = feed.articles;
    const m = emptyMarks();
    const src = all[0]!.sourceId;
    expect(filterArticles(all, { ...emptyFilter(), source: src }, m).every((a) => a.sourceId === src)).toBe(true);
    expect(filterArticles(all, { ...emptyFilter(), category: "politics" }, m).every((a) => a.category === "politics")).toBe(true);
    const withAi = all.filter((a) => /ＡＩ|AI/i.test(a.title.normalize("NFKC")));
    expect(filterArticles(all, { ...emptyFilter(), q: "ai" }, m)).toHaveLength(withAi.length);
    expect(filterArticles(all, { ...emptyFilter(), q: "ai 存在しない語" }, m)).toHaveLength(0);
    const read = applyMark(m, { type: "read", id: all[0]!.id });
    expect(filterArticles(all, { ...emptyFilter(), unreadOnly: true }, read)).toHaveLength(all.length - 1);
    const hidden = applyMark(m, { type: "hide", id: all[0]!.id });
    expect(filterArticles(all, emptyFilter(), hidden)).toHaveLength(all.length - 1);
    expect(filterArticles(all, { ...emptyFilter(), showHidden: true }, hidden)).toHaveLength(all.length);
  });

  it("round-trips filters through the URL and rejects invalid values", () => {
    const f = { ...emptyFilter(), source: "digital", category: "politics" as const, q: "AI 規制", unreadOnly: true };
    expect(filterFromQuery(new URL("https://x" + filterToQuery(f)).searchParams)).toEqual(f);
    expect(filterFromQuery(new URLSearchParams("source=../x&category=evil"))).toEqual(emptyFilter());
  });

  it("shows source status (last success, error, AI target) and manual links", async () => {
    const out = html(<SourcesPage view={await feedView()} />);
    expect(out).toContain("情報源の状態");
    expect(out).toContain("最終正常取得");
    expect(out).toContain("local feed file not readable");
    expect(out).toContain("対象外");
    expect(out).toContain("手動リンク（自動取得していない媒体）");
    expect(out).not.toContain("Users");
    expect(out).not.toContain("Projects");
  });

  it("shows no-data when the feed has not been generated", async () => {
    const { storage } = tmpStorage();
    const out = html(<ReaderPage view={await new DigestReader(storage).feed()} marks={emptyMarks()} act={noop} filter={emptyFilter()} onFilter={noop} />);
    expect(out).toContain("まだデータがありません");
  });
});
