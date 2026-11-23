/**
 * 既読・非表示・保存の状態（ブラウザーの localStorage にだけ保存する）。
 * 端末・ブラウザー間で同期しない。ブラウザーのデータを消すと失われる（README 参照）。
 */
export interface SavedItem {
  title: string;
  url: string;
  sourceName: string;
  date: string;
  savedAt: string;
}

export interface Marks {
  read: Record<string, string>;
  hidden: Record<string, string>;
  saved: Record<string, SavedItem>;
}

export type MarkAction =
  | { type: "read" | "unread" | "hide" | "unhide" | "unsave"; id: string }
  | { type: "save"; id: string; item: Omit<SavedItem, "savedAt"> }
  /** 表示中の記事をまとめて既読にする */
  | { type: "readMany"; ids: string[] };

export const MARKS_KEY = "shift-digest:marks:v1";
const RETENTION_MS = 180 * 86400_000;

export const emptyMarks = (): Marks => ({ read: {}, hidden: {}, saved: {} });

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 壊れた値・想定外の値は捨てる（localStorage は他のスクリプトや手動編集で変わり得る） */
export function parseMarks(text: string | null): Marks {
  if (!text) return emptyMarks();
  try {
    const v = JSON.parse(text) as unknown;
    if (!isRecord(v)) return emptyMarks();
    const strMap = (x: unknown) =>
      isRecord(x) ? Object.fromEntries(Object.entries(x).filter(([k, t]) => /^[0-9a-f]{16}$/.test(k) && typeof t === "string")) as Record<string, string> : {};
    const saved: Record<string, SavedItem> = {};
    if (isRecord(v.saved)) {
      for (const [k, s] of Object.entries(v.saved)) {
        if (!/^[0-9a-f]{16}$/.test(k) || !isRecord(s)) continue;
        const { title, url, sourceName, date, savedAt } = s;
        if ([title, url, sourceName, date, savedAt].every((x) => typeof x === "string") && /^https?:\/\//.test(url as string)) {
          saved[k] = { title, url, sourceName, date, savedAt } as SavedItem;
        }
      }
    }
    return { read: strMap(v.read), hidden: strMap(v.hidden), saved };
  } catch {
    return emptyMarks();
  }
}

export function applyMark(m: Marks, a: MarkAction, now = new Date()): Marks {
  const at = now.toISOString();
  const next: Marks = { read: { ...m.read }, hidden: { ...m.hidden }, saved: { ...m.saved } };
  switch (a.type) {
    case "read":
      next.read[a.id] = at;
      break;
    case "readMany":
      for (const id of a.ids) if (!next.read[id]) next.read[id] = at;
      break;
    case "unread":
      delete next.read[a.id];
      break;
    case "hide":
      next.hidden[a.id] = at;
      break;
    case "unhide":
      delete next.hidden[a.id];
      break;
    case "save":
      next.saved[a.id] = { ...a.item, savedAt: at };
      break;
    case "unsave":
      delete next.saved[a.id];
      break;
  }
  // 既読・非表示は古いものから消す（保存は消さない）
  const cutoff = now.getTime() - RETENTION_MS;
  for (const k of ["read", "hidden"] as const) {
    for (const [id, t] of Object.entries(next[k])) if (Date.parse(t) < cutoff) delete next[k][id];
  }
  return next;
}

export function loadMarks(): Marks {
  try {
    return parseMarks(window.localStorage.getItem(MARKS_KEY));
  } catch {
    return emptyMarks();
  }
}

export function storeMarks(m: Marks): boolean {
  try {
    window.localStorage.setItem(MARKS_KEY, JSON.stringify(m));
    return true;
  } catch {
    return false;
  }
}

/** http(s) 以外のリンクは作らない（javascript: 等の防止） */
export function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}
