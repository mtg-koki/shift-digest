/**
 * 前回の閲覧日時（ブラウザーの localStorage にだけ保存する。同期しない）。
 * 「前回の閲覧以降の新着」の判定に使う。続けて開き直した場合（30 分以内）は同じ閲覧として扱う。
 */
export interface Visit {
  /** 直近の閲覧 */
  last: string;
  /** その前の閲覧（新着の基準） */
  prev: string | null;
}

export const VISIT_KEY = "shift-digest:visit:v1";
export const SAME_VISIT_MS = 30 * 60_000;

const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v);

export function parseVisit(text: string | null): Visit | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { last?: unknown; prev?: unknown };
    if (!isIso(v.last)) return null;
    return { last: v.last, prev: isIso(v.prev) ? v.prev : null };
  } catch {
    return null;
  }
}

export function nextVisit(stored: Visit | null, now: Date): Visit {
  const at = now.toISOString();
  if (!stored) return { last: at, prev: null };
  if (now.getTime() - Date.parse(stored.last) < SAME_VISIT_MS) return { last: at, prev: stored.prev };
  return { last: at, prev: stored.last };
}

/** 今回の閲覧を記録し、新着の基準（前回の閲覧日時）を返す */
export function recordVisit(now = new Date()): string | null {
  try {
    const v = nextVisit(parseVisit(window.localStorage.getItem(VISIT_KEY)), now);
    window.localStorage.setItem(VISIT_KEY, JSON.stringify(v));
    return v.prev;
  } catch {
    return null;
  }
}
