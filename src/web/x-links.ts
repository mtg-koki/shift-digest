import { CATEGORY_IDS, CATEGORY_LABELS, type CategoryId } from "../shared/schema";

/**
 * テーマごとの X（旧 Twitter）検索へのリンク。X のデータは取得・保存しない（リンクを開くだけ）。
 * 検索語は「話題」タブ（f=top）・日本語の投稿で開く。
 */
export const X_QUERIES: Record<CategoryId, string> = {
  cloud: "(クラウド OR AWS OR Azure OR \"Google Cloud\")",
  ai: "(生成AI OR ChatGPT OR Claude OR Gemini OR AIエージェント)",
  politics: "(国会 OR 首相 OR 内閣 OR 選挙 OR 法案)",
  economy: "(経済 OR 景気 OR 物価 OR 賃上げ OR 決算)",
  finance: "(日銀 OR 金利 OR 為替 OR 株価 OR 日経平均)",
  world: "(国際情勢 OR 米国 OR 中国 OR ウクライナ OR 中東)",
};

export function xSearchUrl(c: CategoryId): string {
  const q = new URLSearchParams({ q: `${X_QUERIES[c]} lang:ja`, f: "top" });
  return `https://x.com/search?${q.toString()}`;
}

export const X_LINKS = CATEGORY_IDS.map((c) => ({ id: c, label: CATEGORY_LABELS[c], url: xSearchUrl(c) }));
