import type { z } from "zod";
import {
  DailyReportSchema,
  DigestIndexSchema,
  LastRunSchema,
  STORAGE_KEYS,
  type DailyReport,
  type DigestIndex,
  type LastRun,
} from "../shared/schema";
import type { Storage } from "../shared/storage";
import { isValidDateString } from "../shared/date";

export interface RunStatus {
  lastSuccessAt: string | null;
  lastRun: LastRun | null;
  /** 最新の実行が失敗しており、前回の正常データを表示している */
  latestRunFailed: boolean;
}

export type ReportView =
  | { kind: "ok"; report: DailyReport; status: RunStatus }
  | { kind: "no-data"; status: RunStatus }
  | { kind: "not-found"; date: string; status: RunStatus }
  | { kind: "error"; message: string };

export type ArchiveView =
  | { kind: "ok"; index: DigestIndex; status: RunStatus }
  | { kind: "no-data"; status: RunStatus }
  | { kind: "error"; message: string };

class DataError extends Error {}

async function readJson<T>(storage: Storage, key: string, schema: z.ZodType<T>): Promise<T | null> {
  const text = await storage.getText(key);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DataError(`${key} is not valid JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new DataError(`${key} failed schema validation`);
  return parsed.data;
}

function toStatus(index: DigestIndex | null, lastRun: LastRun | null): RunStatus {
  const lastSuccessAt = index?.lastSuccessAt ?? null;
  const latestRunFailed =
    lastRun?.status === "failed" && (lastSuccessAt === null || lastRun.at > lastSuccessAt);
  return { lastSuccessAt, lastRun, latestRunFailed };
}

/** 短時間のメモリキャッシュ。更新が長時間反映されない状態を避けるため TTL は短く。 */
export class DigestReader {
  private cache = new Map<string, { expires: number; value: unknown }>();

  constructor(
    private readonly storage: Storage,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private async cached<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value as T | null;
    const value = await readJson(this.storage, key, schema);
    // 取得失敗（例外）はキャッシュしない
    this.cache.set(key, { expires: this.now() + this.ttlMs, value });
    return value;
  }

  private async status(): Promise<{ index: DigestIndex | null; status: RunStatus }> {
    const [index, lastRun] = await Promise.all([
      this.cached(STORAGE_KEYS.index, DigestIndexSchema),
      // last-run が壊れていても本体は表示する
      this.cached(STORAGE_KEYS.lastRun, LastRunSchema).catch(() => null),
    ]);
    return { index, status: toStatus(index, lastRun) };
  }

  async latest(): Promise<ReportView> {
    try {
      const { index, status } = await this.status();
      if (!index) return { kind: "no-data", status };
      const report = await this.cached(STORAGE_KEYS.report(index.latestDate), DailyReportSchema);
      if (!report) return { kind: "error", message: "最新の日次データが見つかりません" };
      return { kind: "ok", report, status };
    } catch (e) {
      return errorView(e);
    }
  }

  async byDate(date: string): Promise<ReportView> {
    try {
      const { status } = await this.status();
      if (!isValidDateString(date)) return { kind: "not-found", date, status };
      const report = await this.cached(STORAGE_KEYS.report(date), DailyReportSchema);
      if (!report) return { kind: "not-found", date, status };
      return { kind: "ok", report, status };
    } catch (e) {
      return errorView(e);
    }
  }

  async archive(): Promise<ArchiveView> {
    try {
      const { index, status } = await this.status();
      if (!index) return { kind: "no-data", status };
      return { kind: "ok", index, status };
    } catch (e) {
      return errorView(e);
    }
  }
}

function errorView(e: unknown): { kind: "error"; message: string } {
  // 内部情報（接続先など）は画面に出さず、ログにだけ残す
  console.error("[web] failed to load digest data", e);
  return { kind: "error", message: "データを取得できませんでした。時間をおいて再度お試しください。" };
}
