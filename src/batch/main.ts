import { runFromEnv } from "./bootstrap";

/**
 * 日次バッチのローカル実行用 CLI（Lambda では lambda.ts の handler を使う）。
 *   --force             当日分が既にあっても作り直す（評価はキャッシュを再利用、AI 呼び出しは日次上限内）
 *   --sources <file>    情報源設定ファイル（既定: SOURCES_FILE または config/sources.json）
 *   --allow-file-feeds  file: の取得元を許可（ローカルのサンプルフィード専用）
 * 終了コード: 0=成功/スキップ, 1=失敗
 */
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force") || process.env.FORCE === "true";
  const si = args.indexOf("--sources");
  const sourcesFile = si >= 0 && args[si + 1] ? args[si + 1]! : undefined;
  const env = { ...process.env, ...(args.includes("--allow-file-feeds") ? { ALLOW_FILE_FEEDS: "true" } : {}) };
  const outcome = await runFromEnv({ force, sourcesFile, env });
  process.exitCode = outcome.status === "failed" ? 1 : 0;
}

main().catch((e) => {
  // 認証情報等を出さないよう、メッセージのみ出力する
  console.error(JSON.stringify({ msg: "batch crashed", error: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 1;
});
