import { CATEGORY_IDS, type Article, type CategoryId } from "../shared/schema";
import type { Marks } from "./marks";

/** 一覧の絞り込み条件（URL のクエリと相互変換する） */
export interface ReaderFilter {
  category: CategoryId | null;
  /** 前回の閲覧以降に取得した記事だけ */
  newOnly: boolean;
  /** 関心テーマのキーワードがタイトルに含まれる記事だけ */
  interestOnly: boolean;
  unreadOnly: boolean;
  showHidden: boolean;
}

export const emptyFilter = (): ReaderFilter => ({ category: null, newOnly: false, interestOnly: false, unreadOnly: false, showHidden: false });

/** 前回の閲覧（since）より後に取得した記事か。初回（since なし）は新着扱いしない */
export function isNewSince(a: Article, since: string | null): boolean {
  return !!since && a.fetchedAt > since;
}

export function filterArticles(articles: Article[], f: ReaderFilter, marks: Marks, since: string | null = null): Article[] {
  return articles.filter((a) => {
    if (f.category && a.category !== f.category) return false;
    if (f.newOnly && !isNewSince(a, since)) return false;
    if (f.interestOnly && !a.interestMatches?.length) return false;
    if (!f.showHidden && marks.hidden[a.id]) return false;
    if (f.unreadOnly && marks.read[a.id]) return false;
    return true;
  });
}

export function filterFromQuery(sp: URLSearchParams): ReaderFilter {
  const c = sp.get("category");
  return {
    category: (CATEGORY_IDS as readonly string[]).includes(c ?? "") ? (c as CategoryId) : null,
    newOnly: sp.get("new") === "1",
    interestOnly: sp.get("interest") === "1",
    unreadOnly: sp.get("unread") === "1",
    showHidden: sp.get("hidden") === "1",
  };
}

export function filterToQuery(f: ReaderFilter): string {
  const q = new URLSearchParams();
  if (f.category) q.set("category", f.category);
  if (f.newOnly) q.set("new", "1");
  if (f.interestOnly) q.set("interest", "1");
  if (f.unreadOnly) q.set("unread", "1");
  if (f.showHidden) q.set("hidden", "1");
  const s = q.toString();
  return s ? `/?${s}` : "/";
}
