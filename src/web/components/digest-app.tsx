"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DigestReader, type ArchiveView, type ReportView } from "../data";
import { HttpStore } from "../http-store";
import { applyMark, emptyMarks, loadMarks, MARKS_KEY, storeMarks, type MarkAction, type Marks } from "../marks";
import { ArchivePage, ReportPage, SavedPage, parseCategory } from "./views";

type Loaded = { kind: "report"; view: ReportView } | { kind: "archive"; view: ArchiveView };

export function Loading() {
  return (
    <p className="empty" aria-busy="true">
      読み込み中…
    </p>
  );
}

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
  const key = view === "archive" ? "archive" : view === "saved" ? "saved" : date ? `date:${date}` : "latest";

  useEffect(() => {
    setMarks(loadMarks());
    // 他のタブでの変更を反映
    const onStorage = (e: StorageEvent) => {
      if (e.key === MARKS_KEY) setMarks(loadMarks());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const act = useCallback((a: MarkAction) => {
    setMarks((m) => {
      const next = applyMark(m, a);
      setStorageOk(storeMarks(next));
      return next;
    });
  }, []);

  useEffect(() => {
    if (key === "saved") return;
    let cancelled = false;
    const load = async (): Promise<Loaded> => {
      if (key === "archive") return { kind: "archive", view: await reader.archive() };
      if (date) return { kind: "report", view: await reader.byDate(date) };
      return { kind: "report", view: await reader.latest() };
    };
    load().then((data) => {
      if (!cancelled) setLoaded({ key, data });
    });
    return () => {
      cancelled = true;
    };
  }, [key, date, reader]);

  useEffect(() => {
    document.title = key === "archive" ? "過去の日付 | Shift Digest" : key === "saved" ? "保存 | Shift Digest" : date ? `${date} | Shift Digest` : "Shift Digest";
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
  if (loaded.data.kind === "archive") return <ArchivePage view={loaded.data.view} />;
  return (
    <>
      {warn}
      <label className="toggle">
        <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> 非表示にした記事も表示
      </label>
      <ReportPage view={loaded.data.view} category={category} date={date} marks={marks} act={act} showHidden={showHidden} />
    </>
  );
}
