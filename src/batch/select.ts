import type { Assessment, CategoryId } from "../shared/schema";
import { normalizeUrl, titleKey, titleSimilarity, urlId } from "../shared/url";
import type { Interests, Source } from "./config";
import type { FeedItem } from "./feed";

export interface Candidate {
  id: string;
  normalizedUrl: string;
  /** 表示用の元 URL（RSS から取得し、http(s) であることを確認したもの） */
  url: string;
  title: string;
  titleKey: string;
  publishedAt: string | null;
  feedCategories: string[];
  source: Source;
  /** AI に送ってよい情報源か */
  aiEligible: boolean;
  /** 同じタイトルの代表記事 ID（重複扱い） */
  duplicateOf?: string;
}

/** 近似タイトルを「重複候補」とみなす閾値。誤って別記事を消さないよう、除外ではなく推薦の重複回避にだけ使う */
export const SIMILAR_TITLE_THRESHOLD = 0.85;

export function toCandidate(item: FeedItem, source: Source, aiEligible: boolean): Candidate | null {
  const normalizedUrl = normalizeUrl(item.link);
  if (!normalizedUrl) return null;
  // 表示用 URL も http(s) のみ（javascript: 等は normalizeUrl で弾かれる）
  let url: string;
  try {
    url = new URL(item.link.trim()).href;
  } catch {
    return null;
  }
  return {
    id: urlId(normalizedUrl),
    normalizedUrl,
    url,
    title: item.title,
    titleKey: titleKey(item.title),
    publishedAt: item.publishedAt,
    feedCategories: item.categories,
    source,
    aiEligible,
  };
}

/** 対象期間内か。日時不明の記事は includeUndated のときだけ対象（初回の大量取り込み防止） */
export function inWindow(publishedAt: string | null, now: Date, lookbackHours: number, includeUndated = false): boolean {
  if (!publishedAt) return includeUndated;
  const t = Date.parse(publishedAt);
  const from = now.getTime() - lookbackHours * 3600_000;
  // 未来日時はフィード側の誤りとして 1 日まで許容
  return t >= from && t <= now.getTime() + 86400_000;
}

export function isSimilarTitle(a: string, b: string): boolean {
  return titleSimilarity(a, b) >= SIMILAR_TITLE_THRESHOLD;
}

/** 優先度 → 新しい順 */
export function sortCandidates(cands: Candidate[]): Candidate[] {
  return [...cands].sort(
    (a, b) => a.source.priority - b.source.priority || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.id.localeCompare(b.id),
  );
}

/**
 * 保守的な重複除去。
 * - 正規化 URL が同じ → 同一記事として 1 件にまとめる（先に並ぶ優先度の高い方を残す）
 * - 正規化タイトルが完全一致（10 文字以上）→ 別 URL でも重複として印を付ける（一覧には残し、推薦・AI 評価は代表だけ）
 * - 近似タイトル → ここでは何もしない（推薦時の重複回避のみ）
 */
export function dedupe(cands: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  const ids = new Set<string>();
  const byTitle = new Map<string, string>();
  for (const c of sortCandidates(cands)) {
    if (ids.has(c.id)) continue;
    ids.add(c.id);
    const rep = c.titleKey.length >= 10 ? byTitle.get(c.titleKey) : undefined;
    if (rep) out.push({ ...c, duplicateOf: rep });
    else {
      if (c.titleKey.length >= 10) byTitle.set(c.titleKey, c.id);
      out.push(c);
    }
  }
  return out;
}

// ---------------- ルールベース ----------------
const norm = (s: string) => s.normalize("NFKC").toLowerCase();

export interface KeywordMatch {
  themeId: string;
  themeLabel: string;
  keyword: string;
}

/** タイトルに含まれる関心キーワード（テーマごとに最初の 1 語） */
export function keywordMatches(title: string, interests: Interests): KeywordMatch[] {
  const t = norm(title);
  const out: KeywordMatch[] = [];
  for (const th of interests.themes) {
    const kw = th.keywords.find((k) => t.includes(norm(k)));
    if (kw) out.push({ themeId: th.id, themeLabel: th.label, keyword: kw });
  }
  return out;
}

/** 0〜100: キーワード一致テーマ数に応じた点（1 テーマ 60、2 テーマ 80、3 以上 90） */
export function keywordScore(matches: KeywordMatch[]): number {
  return matches.length === 0 ? 0 : matches.length === 1 ? 60 : matches.length === 2 ? 80 : 90;
}

/** 0〜100: 新しさ（公開日時なしは 50） */
export function recencyScore(publishedAt: string | null, now: Date, lookbackHours: number): number {
  if (!publishedAt) return 50;
  const age = Math.max(0, now.getTime() - Date.parse(publishedAt));
  return Math.round(100 * Math.max(0, 1 - age / (lookbackHours * 3600_000)));
}

/**
 * AI に渡す記事を選ぶ（送信件数を抑える）。
 * 対象: AI 送信が許可された情報源の、未評価（または前提が変わった）代表記事。
 * 順序: キーワード一致 → 新しさ。1 情報源あたり・1 日あたりの上限を守る。
 */
export function selectForAssessment(
  cands: Candidate[],
  opts: { interests: Interests; now: Date; lookbackHours: number; limit: number; perSource: number; needsAssessment: (c: Candidate) => boolean },
): Candidate[] {
  const pool = cands
    .filter((c) => c.aiEligible && !c.duplicateOf && opts.needsAssessment(c))
    .map((c) => ({ c, k: keywordScore(keywordMatches(c.title, opts.interests)), r: recencyScore(c.publishedAt, opts.now, opts.lookbackHours) }))
    .sort((a, b) => b.k - a.k || b.r - a.r || a.c.source.priority - b.c.source.priority || a.c.id.localeCompare(b.c.id));
  const perSource = new Map<string, number>();
  const out: Candidate[] = [];
  for (const { c } of pool) {
    if (out.length >= opts.limit) break;
    const n = perSource.get(c.source.id) ?? 0;
    if (n >= opts.perSource) continue;
    perSource.set(c.source.id, n + 1);
    out.push(c);
  }
  return out;
}

/** ルールベースの評価（モック。AI を使わない） */
export function ruleAssessment(c: Pick<Candidate, "title" | "source">, interests: Interests, at: string): Omit<Assessment, "assessor"> {
  const m = keywordMatches(c.title, interests);
  const score = keywordScore(m);
  return {
    category: null,
    relevanceScore: score,
    reason:
      m.length === 0
        ? "関心テーマのキーワードがタイトルに含まれていません（ルールベース）"
        : `タイトルに関心テーマ「${m.map((x) => x.themeLabel).join("」「")}」のキーワード（${m.map((x) => x.keyword).join("、")}）が含まれるため（ルールベース）`.slice(0, 200),
    assessmentBasis: "metadata_only",
    assessedAt: at,
  };
}

export interface Ranked {
  c: Candidate;
  assessment: Assessment;
  rankScore: number;
}

/**
 * 今日の読む候補を決める（AI だけに依存しない決定的なルール）。
 * rankScore = 関心度 70% + キーワード 20% + 新しさ 10%。
 * 条件: 関心度が下限以上・重複/近似タイトルを除く・情報源ごとの上限。候補が少なければ件数を埋めない。
 */
export function rankRecommendations(
  items: Array<{ c: Candidate; assessment: Assessment | undefined }>,
  opts: { interests: Interests; now: Date; lookbackHours: number; max: number; perSource: number; minScore: number },
): Ranked[] {
  const scored = items
    .filter((x): x is { c: Candidate; assessment: Assessment } => !!x.assessment && !x.c.duplicateOf)
    .filter((x) => x.assessment.relevanceScore >= opts.minScore)
    .map((x) => ({
      ...x,
      rankScore: Math.round(
        0.7 * x.assessment.relevanceScore +
          0.2 * keywordScore(keywordMatches(x.c.title, opts.interests)) +
          0.1 * recencyScore(x.c.publishedAt, opts.now, opts.lookbackHours),
      ),
    }))
    .sort((a, b) => b.rankScore - a.rankScore || (b.c.publishedAt ?? "").localeCompare(a.c.publishedAt ?? "") || a.c.id.localeCompare(b.c.id));
  const out: Ranked[] = [];
  const perSource = new Map<string, number>();
  for (const s of scored) {
    if (out.length >= opts.max) break;
    const n = perSource.get(s.c.source.id) ?? 0;
    if (n >= opts.perSource) continue;
    if (out.some((o) => isSimilarTitle(o.c.titleKey, s.c.titleKey))) continue;
    perSource.set(s.c.source.id, n + 1);
    out.push(s);
  }
  return out;
}

export function displayCategory(c: Candidate, a: Assessment | undefined): CategoryId {
  return a?.category ?? c.source.defaultCategory;
}
