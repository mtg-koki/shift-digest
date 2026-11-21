// 日付区切りは Asia/Tokyo。日本は夏時間がないため UTC+9 固定で計算する
// （ICU のタイムゾーンデータに依存しない）。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 与えた時刻の Asia/Tokyo における日付 YYYY-MM-DD */
export function jstDate(d: Date = new Date()): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 保存用の UTC ISO 8601 文字列 */
export function toIsoUtc(d: Date): string {
  return d.toISOString();
}

/** フィードの日時文字列を解釈する。解釈できなければ null（推定補完しない）。 */
export function parseFeedDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value.trim());
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/** 表示用: 2026-11-22 07:00（JST） */
export function formatJst(iso: string): string {
  const d = new Date(Date.parse(iso) + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** YYYY-MM-DD を引いた日数ずらす */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
