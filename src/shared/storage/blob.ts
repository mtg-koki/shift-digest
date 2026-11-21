import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, RestError, type ContainerClient } from "@azure/storage-blob";
import type { Lock, Storage } from "./types";

/**
 * Azure Blob Storage。認証は Managed Identity（Azure 上）または
 * az login 済みの開発者資格情報（ローカル）。アカウントキーは使わない。
 */
export class BlobStorage implements Storage {
  private readonly container: ContainerClient;

  constructor(accountUrl: string, containerName: string, managedIdentityClientId?: string) {
    const credential = new DefaultAzureCredential(
      managedIdentityClientId ? { managedIdentityClientId } : undefined,
    );
    this.container = new BlobServiceClient(accountUrl, credential).getContainerClient(containerName);
  }

  async getText(key: string): Promise<string | null> {
    try {
      const buf = await this.container.getBlobClient(key).downloadToBuffer();
      return buf.toString("utf8");
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 404) return null;
      throw e;
    }
  }

  async putText(key: string, text: string): Promise<void> {
    // 単一 Blob の Put は原子的に置き換わる
    await this.container.getBlockBlobClient(key).upload(text, Buffer.byteLength(text), {
      blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" },
    });
  }

  async tryLock(key: string, ttlSeconds: number): Promise<Lock | null> {
    const blob = this.container.getBlockBlobClient(key);
    try {
      await blob.upload("", 0, { conditions: { ifNoneMatch: "*" } });
    } catch (e) {
      if (!(e instanceof RestError && (e.statusCode === 409 || e.statusCode === 412))) throw e;
    }
    // リースは 15〜60 秒。異常終了しても期限で自動解放されるよう、短いリースを更新し続ける。
    const duration = Math.min(60, Math.max(15, ttlSeconds));
    const lease = blob.getBlobLeaseClient();
    try {
      await lease.acquireLease(duration);
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 409) return null;
      throw e;
    }
    const timer = setInterval(
      () => {
        lease.renewLease().catch((err: unknown) => console.error("[lock] renew failed", err));
      },
      (duration * 1000) / 3,
    );
    timer.unref();
    return {
      release: async () => {
        clearInterval(timer);
        await lease.releaseLease().catch(() => undefined);
      },
    };
  }
}
