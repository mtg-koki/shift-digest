import { CATEGORY_IDS, type Article, type CategoryId } from "../shared/schema";
import type { Marks } from "./marks";

/** 一覧の絞り込み条件（URL のクエリと相互変換する） */
export interface ReaderFilter {
  source: string | null;
  category: CategoryId | null;
  /** タイトルのキーワード（空白区切りはすべて含む＝AND。大文字小文字・全角半角を区別しない） */
  q: string;
  unreadOnly: boolean;
  showHidden: boolean;
}

export const emptyFilter = (): ReaderFilter => ({ source: null, category: null, q: "", unreadOnly: false, showHidden: false });

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

export function filterArticles(articles: Article[], f: ReaderFilter, marks: Marks): Article[] {
  const terms = norm(f.q).split(/\s+/).filter(Boolean);
  return articles.filter((a) => {
    if (f.source && a.sourceId !== f.source) return false;
    if (f.category && a.category !== f.category) return false;
    if (!f.showHidden && marks.hidden[a.id]) return false;
    if (f.unreadOnly && marks.read[a.id]) return false;
    if (terms.length) {
      const t = norm(a.title);
      if (!terms.every((x) => t.includes(x))) return false;
    }
    return true;
  });
}

export function filterFromQuery(sp: URLSearchParams): ReaderFilter {
  const c = sp.get("category");
  const src = sp.get("source");
  return {
    source: src && /^[a-z0-9-]{1,64}$/.test(src) ? src : null,
    category: (CATEGORY_IDS as readonly string[]).includes(c ?? "") ? (c as CategoryId) : null,
    q: (sp.get("q") ?? "").slice(0, 100),
    unreadOnly: sp.get("unread") === "1",
    showHidden: sp.get("hidden") === "1",
  };
}

export function filterToQuery(f: ReaderFilter): string {
  const q = new URLSearchParams();
  if (f.source) q.set("source", f.source);
  if (f.category) q.set("category", f.category);
  if (f.q.trim()) q.set("q", f.q.trim());
  if (f.unreadOnly) q.set("unread", "1");
  if (f.showHidden) q.set("hidden", "1");
  const s = q.toString();
  return s ? `/?${s}` : "/";
}
