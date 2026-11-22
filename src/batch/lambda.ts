import type { Context } from "aws-lambda";
import { runFromEnv, type RunOptions } from "./bootstrap";
import type { RunOutcome } from "./run";

/** 手動実行時に渡せるイベント。EventBridge Scheduler からは {} で起動する */
export interface BatchEvent {
  force?: boolean;
}

/** 書き込み・後処理のために、Lambda のタイムアウトより前に処理を打ち切る余裕 */
export const SAFETY_MARGIN_MS = 90_000;

export async function handleEvent(
  event: BatchEvent | null | undefined,
  remainingMs: number,
  run: (o: RunOptions) => Promise<RunOutcome> = runFromEnv,
): Promise<RunOutcome> {
  const force = event?.force === true;
  const outcome = await run({ force, maxRuntimeMs: remainingMs - SAFETY_MARGIN_MS });
  // failed は例外にして Lambda の失敗として扱う（非同期呼び出しの再試行・失敗通知の対象にする）。
  // skipped（当日分作成済み・別実行中）と ok / partial（0 件を含む）は正常終了。
  if (outcome.status === "failed") throw new Error(`batch failed: ${outcome.reason}`);
  return outcome;
}

export const handler = async (event: BatchEvent, context: Context): Promise<RunOutcome> =>
  handleEvent(event, context.getRemainingTimeInMillis());
