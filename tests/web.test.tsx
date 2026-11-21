import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../src/shared/schema";
import { DigestReader } from "../src/web/data";
import { ArchivePage, ReportPage } from "../src/web/components/views";
import { tmpStorage } from "./helpers";

vi.spyOn(console, "error").mockImplementation(() => undefined);

const sampleIndex = readFileSync("sample-data/index.json", "utf8");
const sampleReport = readFileSync("sample-data/reports/2026-11-21.json", "utf8");

async function seeded() {
  const { storage } = tmpStorage();
  await storage.putText(STORAGE_KEYS.index, sampleIndex);
  await storage.putText(STORAGE_KEYS.report("2026-11-21"), sampleReport);
  return storage;
}

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("web data loading and display", () => {
  it("shows a no-data message when nothing has been generated yet", async () => {
    const { storage } = tmpStorage();
    const view = await new DigestReader(storage).latest();
    expect(view.kind).toBe("no-data");
    expect(html(<ReportPage view={view} category={null} basePath="/" />)).toContain("まだまとめデータがありません");
    expect(html(<ArchivePage view={await new DigestReader(storage).archive()} />)).toContain("まだまとめデータがありません");
  });

  it("shows an error message (without internals) when storage fails", async () => {
    const reader = new DigestReader({
      getText: async () => {
        throw new Error("ECONNREFUSED secret-host.blob.core.windows.net");
      },
      putText: async () => undefined,
      tryLock: async () => null,
    });
    const view = await reader.latest();
    expect(view.kind).toBe("error");
    const out = html(<ReportPage view={view} category={null} basePath="/" />);
    expect(out).toContain("データを取得できませんでした");
    expect(out).not.toContain("secret-host");
  });

  it("treats corrupt data as an error, not as empty", async () => {
    const { storage } = tmpStorage();
    await storage.putText(STORAGE_KEYS.index, "{ broken");
    expect((await new DigestReader(storage).latest()).kind).toBe("error");
  });

  it("renders the latest report with source links, dates and partial notice", async () => {
    const view = await new DigestReader(await seeded()).latest();
    expect(view.kind).toBe("ok");
    const out = html(<ReportPage view={view} category={null} basePath="/" />);
    expect(out).toContain("2026-11-21 のまとめ");
    expect(out).toContain('href="https://example.com/news/copyright-comment"');
    expect(out).toContain("最終正常更新");
    expect(out).toContain("2026-11-21 07:00");
    expect(out).toContain("一部の取得元から取得できませんでした");
    expect(out).toContain("タイトルのみ（本文・説明文なし）");
  });

  it("filters by category and shows a message for an empty category", async () => {
    const view = await new DigestReader(await seeded()).latest();
    const policy = html(<ReportPage view={view} category="policy" basePath="/" />);
    expect(policy).toContain("著作権制度");
    expect(policy).not.toContain("ロボット導入事例");
    expect(html(<ReportPage view={view} category="employment" basePath="/" />)).toContain("このカテゴリの記事はありません");
  });

  it("shows a 0-article day as a normal empty day", async () => {
    const storage = await seeded();
    const r = JSON.parse(sampleReport);
    r.articles = [];
    r.status = "ok";
    await storage.putText(STORAGE_KEYS.report("2026-11-21"), JSON.stringify(r));
    const out = html(<ReportPage view={await new DigestReader(storage).latest()} category={null} basePath="/" />);
    expect(out).toContain("掲載対象のニュースがありませんでした");
  });

  it("warns when the latest run failed and previous data is shown", async () => {
    const storage = await seeded();
    await storage.putText(
      STORAGE_KEYS.lastRun,
      JSON.stringify({ schemaVersion: 1, at: "2026-11-21T22:00:30.000Z", date: "2026-11-22", status: "failed", message: "all sources failed" }),
    );
    const view = await new DigestReader(storage).latest();
    expect(view.kind === "ok" && view.status.latestRunFailed).toBe(true);
    const out = html(<ReportPage view={view} category={null} basePath="/" />);
    expect(out).toContain("更新に失敗したため、前回の正常なデータを表示しています");
    expect(out).toContain("2026-11-21 のまとめ");
  });

  it("returns not-found for unknown or malformed dates", async () => {
    const reader = new DigestReader(await seeded());
    expect((await reader.byDate("2026-01-01")).kind).toBe("not-found");
    expect((await reader.byDate("..%2Findex")).kind).toBe("not-found");
  });

  it("caches briefly, then picks up new data after the TTL", async () => {
    const storage = await seeded();
    let t = 0;
    const reader = new DigestReader(storage, 60_000, () => t);
    expect((await reader.archive()).kind).toBe("ok");
    const idx = JSON.parse(sampleIndex);
    idx.dates.unshift({ date: "2026-11-22", articleCount: 0, status: "ok", generatedAt: "2026-11-21T22:00:00.000Z" });
    await storage.putText(STORAGE_KEYS.index, JSON.stringify(idx));
    const before = await reader.archive();
    expect(before.kind === "ok" && before.index.dates.length).toBe(2);
    t = 61_000;
    const after = await reader.archive();
    expect(after.kind === "ok" && after.index.dates.length).toBe(3);
  });
});
