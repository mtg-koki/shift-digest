import type { ContentBasis } from "../shared/schema";
import { normalizeUrl, titleKey, titleSimilarity, urlId } from "../shared/url";
import type { Source } from "./config";
import type { FeedItem } from "./feed";

export interface Candidate {
  id: string;
  normalizedUrl: string;
  /** 表示用の元 URL（RSS から取得したもの） */
  url: string;
  title: string;
  titleKey: string;
  description: string;
  publishedAt: string | null;
  contentBasis: ContentBasis;
  source: Source;
}

export const TITLE_DUP_THRESHOLD = 0.8;

export function toCandidate(item: FeedItem, source: Source): Candidate | null {
  const normalizedUrl = normalizeUrl(item.link);
  if (!normalizedUrl) return null;
  return {
    id: urlId(normalizedUrl),
    normalizedUrl,
    url: item.link,
    title: item.title,
    titleKey: titleKey(item.title),
    description: item.description,
    publishedAt: item.publishedAt,
    contentBasis: item.description ? "rss_description" : "title_only",
    source,
  };
}

/** 対象期間内か。日時不明の記事は古い可能性があるため除外する（初回の大量取得防止）。 */
export function inWindow(publishedAt: string | null, now: Date, lookbackHours: number): boolean {
  if (!publishedAt) return false;
  const t = Date.parse(publishedAt);
  const from = now.getTime() - lookbackHours * 3600_000;
  // 未来日時はフィード側の誤りとして 1 日まで許容
  return t >= from && t <= now.getTime() + 86400_000;
}

export function isSimilarTitle(a: string, b: string): boolean {
  return titleSimilarity(a, b) >= TITLE_DUP_THRESHOLD;
}

/** 同一 URL・ほぼ同じタイトルの重複を除く。優先度の高い（先に並ぶ）ものを残す。 */
export function dedupe(cands: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  const ids = new Set<string>();
  for (const c of cands) {
    if (ids.has(c.id)) continue;
    if (out.some((o) => isSimilarTitle(o.titleKey, c.titleKey))) continue;
    ids.add(c.id);
    out.push(c);
  }
  return out;
}

/** 優先度（公式優先）→ 新しい順 */
export function sortCandidates(cands: Candidate[]): Candidate[] {
  return [...cands].sort(
    (a, b) =>
      a.source.priority - b.source.priority ||
      Number(b.source.official) - Number(a.source.official) ||
      (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
}
