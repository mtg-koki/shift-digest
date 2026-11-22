"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DigestReader, type ArchiveView, type FeedView, type ReportView } from "../data";
import { filterFromQuery, filterToQuery, type ReaderFilter } from "../filter";
import { HttpStore } from "../http-store";
import { applyMark, emptyMarks, loadMarks, MARKS_KEY, storeMarks, type MarkAction, type Marks } from "../marks";
import { ReaderPage, SourcesPage } from "./reader";
import { ArchivePage, ReportPage, SavedPage, parseCategory } from "./views";

type Loaded = { kind: "report"; view: ReportView } | { kind: "archive"; view: ArchiveView } | { kind: "feed"; view: FeedView };

export function Loading() {
  return (
    <p className="empty" aria-busy="true">
      読み込み中…
    </p>
  );
}

const TITLES: Record<string, string> = { archive: "日別 | Shift Digest", saved: "保存 | Shift Digest", sources: "情報源 | Shift Digest", feed: "Shift Digest" };

/**
 * 静的エクスポートした index.html 上で動く画面本体。
 * データはブラウザーから同一オリジンの /data/ を取得する（CloudFront の認証を通ったリクエストだけが届く）。
 */
export function DigestApp() {
  const sp = useSearchParams();
  const view = sp.get("view");
  const date = sp.get("date");
  const category = parseCategory(sp.get("category") ?? undefined);
  const reader = useMemo(() => new DigestReader(new HttpStore()), []);
  const [loaded, setLoaded] = useState<{ key: string; data: Loaded } | null>(null);
  const [marks, setMarks] = useState<Marks>(emptyMarks);
  const [showHidden, setShowHidden] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [filter, setFilter] = useState<ReaderFilter>(() => filterFromQuery(new URLSearchParams(sp.toString())));
  const key = view === "archive" || view === "saved" || view === "sources" ? view : date ? `date:${date}` : "feed";

  useEffect(() => {
    setMarks(loadMarks());
    // 他のタブでの変更を反映
    const onStorage = (e: StorageEvent) => {
      if (e.key === MARKS_KEY) setMarks(loadMarks());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ナビゲーションで一覧に戻ったときは URL の条件を反映する
  useEffect(() => {
    if (key === "feed") setFilter(filterFromQuery(new URLSearchParams(sp.toString())));
  }, [key, sp]);

  const act = useCallback((a: MarkAction) => {
    setMarks((m) => {
      const next = applyMark(m, a);
      setStorageOk(storeMarks(next));
      return next;
    });
  }, []);

  const onFilter = useCallback((f: ReaderFilter) => {
    setFilter(f);
    // 絞り込み条件を URL に残す（再読み込み・ブックマーク用）。履歴は増やさない
    window.history.replaceState(null, "", filterToQuery(f));
  }, []);

  useEffect(() => {
    if (key === "saved") return;
    let cancelled = false;
    const load = async (): Promise<Loaded> => {
      if (key === "archive") return { kind: "archive", view: await reader.archive() };
      if (key === "feed" || key === "sources") return { kind: "feed", view: await reader.feed() };
      return { kind: "report", view: await reader.byDate(date!) };
    };
    load().then((data) => {
      if (!cancelled) setLoaded({ key, data });
    });
    return () => {
      cancelled = true;
    };
  }, [key, date, reader]);

  useEffect(() => {
    document.title = TITLES[key] ?? `${date} | Shift Digest`;
  }, [key, date]);

  const warn = !storageOk && <p className="notice notice-warn">このブラウザーでは既読・保存を記録できません（プライベートモード等）。</p>;
  if (key === "saved")
    return (
      <>
        {warn}
        <SavedPage marks={marks} act={act} />
      </>
    );
  if (!loaded || loaded.key !== key) return <Loading />;
  const d = loaded.data;
  if (d.kind === "archive") return <ArchivePage view={d.view} />;
  if (d.kind === "feed")
    return key === "sources" ? (
      <SourcesPage view={d.view} />
    ) : (
      <>
        {warn}
        <ReaderPage view={d.view} marks={marks} act={act} filter={filter} onFilter={onFilter} />
      </>
    );
  return (
    <>
      {warn}
      <label className="toggle">
        <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> 非表示にした記事も表示
      </label>
      <ReportPage view={d.view} category={category} date={date} marks={marks} act={act} showHidden={showHidden} />
    </>
  );
}
