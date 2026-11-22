// next build の後処理。ローカル用のニュース JSON（public/data → out/data）を成果物から除く。
// 本番のニュース JSON は Lambda が S3 の data/ に書き込むもので、Web の配置対象ではない。
import { existsSync, rmSync } from "node:fs";

if (!existsSync("out/index.html")) {
  console.error("out/index.html not found. Is output: 'export' set?");
  process.exit(1);
}
rmSync("out/data", { recursive: true, force: true });
console.log("static export ready in out/ (out/data removed)");
