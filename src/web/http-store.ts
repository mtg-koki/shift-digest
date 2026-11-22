import type { ReadableStore } from "../shared/storage/types";

/**
 * 公開ニュース JSON を同一オリジンの /data/ から取得する（CloudFront → S3 の data/ 配下）。
 * cache: "no-cache" で毎回再検証し、日次更新を Web の再ビルドなしで反映する（変更がなければ 304）。
 */
export class HttpStore implements ReadableStore {
  constructor(
    private readonly baseUrl = "/data",
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async getText(key: string): Promise<string | null> {
    if (key.includes("..") || key.startsWith("/")) throw new Error(`invalid key: ${key}`);
    // ページ URL に認証情報が含まれる場合（https://user:pass@…）でも取得できるよう、origin（認証情報を含まない）から組み立てる
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const res = await this.fetchImpl(`${origin}${this.baseUrl}/${key}`, { cache: "no-cache", headers: { accept: "application/json" } });
    // 未作成のデータ。CloudFront では S3 の 403/404 を 404 として返す設定にしている
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`);
    return res.text();
  }
}
