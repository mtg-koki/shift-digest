// sample-data/ を LOCAL_DATA_DIR（既定 ./data）へコピーする。既存データは上書きしない。
import { cpSync, existsSync } from "node:fs";

const dest = process.env.LOCAL_DATA_DIR ?? "./data";
if (existsSync(`${dest}/index.json`) && !process.argv.includes("--force")) {
  console.log(`${dest} already has data. Use --force to overwrite.`);
  process.exit(0);
}
cpSync("sample-data", dest, { recursive: true });
console.log(`sample data copied to ${dest}`);
