import { createStorageFromEnv } from "../shared/storage";
import { createAssessor } from "./assess";
import { loadBatchEnv, loadInterests, loadSources, sourcePolicy, type BatchEnv } from "./config";
import { fetchFeed } from "./feed";
import { runDaily, type RunOutcome } from "./run";

export interface RunOptions {
  force: boolean;
  sourcesFile?: string;
  /** 実行環境が許す残り時間（Lambda の場合）。BATCH_MAX_RUNTIME_MS と小さい方を使う */
  maxRuntimeMs?: number;
  env?: Record<string, string | undefined>;
}

/** CLI と Lambda 共通: 環境変数から依存を組み立てて 1 回実行する */
export async function runFromEnv(opts: RunOptions): Promise<RunOutcome> {
  const raw = opts.env ?? process.env;
  const loaded = loadBatchEnv(raw);
  const env: BatchEnv =
    opts.maxRuntimeMs !== undefined
      ? { ...loaded, BATCH_MAX_RUNTIME_MS: Math.max(10_000, Math.min(loaded.BATCH_MAX_RUNTIME_MS, opts.maxRuntimeMs)) }
      : loaded;
  const sources = await loadSources(opts.sourcesFile ?? env.SOURCES_FILE);
  const interests = await loadInterests(env.INTERESTS_FILE);
  const assessor = createAssessor(env);
  console.log(
    JSON.stringify({
      msg: "batch start",
      assessor: assessor?.info ?? { provider: "rules", model: null },
      sources: sources.map((s) => ({ id: s.id, ...sourcePolicy(s) })),
      themes: interests.themes.map((t) => t.id),
      force: opts.force,
      maxRuntimeMs: env.BATCH_MAX_RUNTIME_MS,
    }),
  );
  const outcome = await runDaily({ storage: createStorageFromEnv(raw), fetcher: fetchFeed, assessor, sources, interests, env, force: opts.force });
  console.log(JSON.stringify({ msg: "batch end", ...outcome }));
  return outcome;
}
