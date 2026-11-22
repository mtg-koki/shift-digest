import type { NextConfig } from "next";

/**
 * 静的エクスポート（out/）。SSR・Server Actions・API Routes は使わない。
 * - 画面は index.html と 404.html だけ。日付・一覧・カテゴリはクエリで切り替えるため、
 *   S3 + CloudFront（インデックス文書の自動補完なし）でも直接アクセスでき、CloudFront Functions は不要。
 * - キャッシュ用ヘッダーは S3 へのアップロード時に付ける（README「キャッシュ」参照）。
 */
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: false,
  poweredByHeader: false,
  images: { unoptimized: true },
};

export default nextConfig;
