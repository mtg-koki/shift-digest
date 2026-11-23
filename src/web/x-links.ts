import { CATEGORY_IDS, CATEGORY_LABELS, type CategoryId } from "../shared/schema";

/**
 * テーマごとの X（旧 Twitter）検索へのリンク。X のデータは取得・保存しない（リンクを開くだけ）。
 * 検索語はカテゴリ名そのもの（例: クラウド）。「話題」タブ（f=top）で開く。
 */
export function xSearchUrl(c: CategoryId): string {
  const q = new URLSearchParams({ q: CATEGORY_LABELS[c], f: "top" });
  return `https://x.com/search?${q.toString()}`;
}

export const X_LINKS = CATEGORY_IDS.map((c) => ({ id: c, label: CATEGORY_LABELS[c], url: xSearchUrl(c) }));
