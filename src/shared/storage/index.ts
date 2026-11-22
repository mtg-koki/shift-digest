import { S3Client } from "@aws-sdk/client-s3";
import { isInternalKey } from "../schema";
import { FsStorage } from "./fs";
import { S3Storage } from "./s3";
import type { Lock, Storage } from "./types";

export type { Lock, ReadableStore, Storage } from "./types";
export { FsStorage } from "./fs";
export { S3Storage } from "./s3";

/**
 * 公開データ（index / status / reports）と内部データ（state / locks）を別の保存先に振り分ける。
 * 内部データを配信領域に置かないための仕組み。
 */
export class RoutedStorage implements Storage {
  constructor(
    private readonly publicStore: Storage,
    private readonly internalStore: Storage,
  ) {}

  private pick(key: string): Storage {
    return isInternalKey(key) ? this.internalStore : this.publicStore;
  }

  getText(key: string): Promise<string | null> {
    return this.pick(key).getText(key);
  }

  putText(key: string, text: string): Promise<void> {
    return this.pick(key).putText(key, text);
  }

  tryLock(key: string, ttlSeconds: number): Promise<Lock | null> {
    return this.pick(key).tryLock(key, ttlSeconds);
  }
}

/**
 * 環境変数からバッチ用ストレージを作る。
 * - local（既定）: 公開データは LOCAL_PUBLIC_DIR（既定 public/data。next dev が /data/ で配信）、
 *                  内部データは LOCAL_INTERNAL_DIR（既定 .local/internal）
 * - s3: 公開データは PUBLIC_BUCKET の PUBLIC_PREFIX（既定 data/）配下、内部データは INTERNAL_BUCKET
 */
export function createStorageFromEnv(env: Record<string, string | undefined> = process.env): Storage {
  const mode = env.STORAGE_MODE || "local";
  if (mode === "local") {
    return new RoutedStorage(
      new FsStorage(env.LOCAL_PUBLIC_DIR || "./public/data"),
      new FsStorage(env.LOCAL_INTERNAL_DIR || "./.local/internal"),
    );
  }
  if (mode === "s3") {
    const publicBucket = env.PUBLIC_BUCKET;
    const internalBucket = env.INTERNAL_BUCKET;
    if (!publicBucket || !internalBucket) throw new Error("PUBLIC_BUCKET and INTERNAL_BUCKET are required when STORAGE_MODE=s3");
    const client = new S3Client({ maxAttempts: 3 });
    return new RoutedStorage(
      new S3Storage(client, { bucket: publicBucket, prefix: env.PUBLIC_PREFIX ?? "data/", setCacheControl: true }),
      new S3Storage(client, { bucket: internalBucket }),
    );
  }
  throw new Error(`unknown STORAGE_MODE: ${mode}`);
}
