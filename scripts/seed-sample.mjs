// sample-data/（架空データ）を LOCAL_PUBLIC_DIR（既定 public/data）へコピーする。既存データは上書きしない。
// public/data は next dev が /data/ として配信する。git 管理外で、Web の成果物（out/）からも除かれる。
import { cpSync, existsSync } from "node:fs";

const dest = process.env.LOCAL_PUBLIC_DIR ?? "./public/data";
if (existsSync(`${dest}/index.json`) && !process.argv.includes("--force")) {
  console.log(`${dest} already has data. Use --force to overwrite.`);
  process.exit(0);
}
cpSync("sample-data", dest, { recursive: true });
console.log(`sample data copied to ${dest}`);
