import { createStorageFromEnv } from "../shared/storage";
import { loadBatchEnv, loadSources } from "./config";
import { fetchFeed } from "./feed";
import { runDaily } from "./run";
import { createSummarizer } from "./summarize";

/**
 * 日次バッチの CLI。
 *   --force          当日分が既にあっても作り直す（要約はキャッシュを再利用、AI 呼び出しは日次上限内）
 *   --sources <file> 取得元設定ファイル（既定: SOURCES_FILE または config/sources.json）
 * 終了コード: 0=成功/スキップ, 1=失敗（Container Apps Job のリトライ対象）
 */
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force") || process.env.FORCE === "true";
  const si = args.indexOf("--sources");
  const env = loadBatchEnv();
  const sourcesFile = si >= 0 && args[si + 1] ? args[si + 1]! : env.SOURCES_FILE;

  const sources = await loadSources(sourcesFile);
  const summarizer = createSummarizer(env);
  console.log(
    JSON.stringify({
      msg: "batch start",
      provider: summarizer.info.provider,
      model: summarizer.info.model,
      sources: sources.map((s) => s.id),
      force,
    }),
  );
  const outcome = await runDaily({
    storage: createStorageFromEnv(),
    fetcher: fetchFeed,
    summarizer,
    sources,
    env,
    force,
  });
  console.log(JSON.stringify({ msg: "batch end", ...outcome }));
  process.exitCode = outcome.status === "failed" ? 1 : 0;
}

main().catch((e) => {
  // API キー等を出さないよう、メッセージのみ出力する
  console.error(JSON.stringify({ msg: "batch crashed", error: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 1;
});
