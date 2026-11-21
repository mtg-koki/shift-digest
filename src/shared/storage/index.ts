import { BlobStorage } from "./blob";
import { FsStorage } from "./fs";
import type { Storage } from "./types";

export type { Lock, Storage } from "./types";
export { FsStorage } from "./fs";

/** 環境変数からストレージを作る（Web・バッチ共通）。 */
export function createStorageFromEnv(env: Record<string, string | undefined> = process.env): Storage {
  const mode = env.STORAGE_MODE || "local";
  if (mode === "local") {
    return new FsStorage(env.LOCAL_DATA_DIR || "./data");
  }
  if (mode === "azure") {
    const accountUrl = env.AZURE_STORAGE_ACCOUNT_URL;
    if (!accountUrl) throw new Error("AZURE_STORAGE_ACCOUNT_URL is required when STORAGE_MODE=azure");
    return new BlobStorage(accountUrl, env.AZURE_STORAGE_CONTAINER || "digest", env.AZURE_CLIENT_ID || undefined);
  }
  throw new Error(`unknown STORAGE_MODE: ${mode}`);
}
