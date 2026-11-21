import { createStorageFromEnv } from "../shared/storage";
import { DigestReader } from "./data";

let reader: DigestReader | null = null;

/** プロセス内で1つだけ作る（キャッシュ共有のため） */
export function getReader(): DigestReader {
  if (!reader) {
    const ttl = Number(process.env.WEB_CACHE_TTL_SECONDS || "60");
    reader = new DigestReader(createStorageFromEnv(), Number.isFinite(ttl) ? ttl * 1000 : 60_000);
  }
  return reader;
}
