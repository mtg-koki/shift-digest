import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
  "ref_src",
]);

/**
 * 既出判定用に URL を正規化する（表示には元の URL を使う）。
 * - スキーム/ホストを小文字化、既定ポートと www. を除去
 * - フラグメント・utm_* 等のトラッキング用パラメータを除去
 * - クエリをキー順に並べ替え、末尾スラッシュを除去
 * 解釈できない URL は null。
 */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // http/https は同一記事として扱う
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const query = params.length ? "?" + new URLSearchParams(params).toString() : "";
  return `https://${host}${path}${query}`;
}

export function urlId(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** タイトル比較用キー（NFKC・小文字・記号空白除去） */
export function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 文字 bigram の Dice 係数（0〜1） */
export function titleSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}
