import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import { cacheControlFor } from "../schema";
import type { Lock, Storage } from "./types";

export interface S3StorageOptions {
  bucket: string;
  /** キーの前に付ける接頭辞（例: "data/"）。空なら付けない */
  prefix?: string;
  /** 公開 JSON に Cache-Control を付けるか（内部用バケットでは不要） */
  setCacheControl?: boolean;
}

function status(e: unknown): number | undefined {
  return e instanceof S3ServiceException ? e.$metadata.httpStatusCode : undefined;
}

function isNotFound(e: unknown): boolean {
  return status(e) === 404 || (e instanceof S3ServiceException && (e.name === "NoSuchKey" || e.name === "NotFound"));
}

/** If-None-Match / If-Match の条件不成立（412）と、同時更新の競合（409） */
function isConditionFailed(e: unknown): boolean {
  const s = status(e);
  return s === 412 || s === 409;
}

/**
 * Amazon S3。認証は Lambda 実行ロール（ローカルでは AWS SDK の既定の資格情報チェーン）。
 * - PutObject は単一オブジェクトを原子的に置き換える（読み手に途中状態は見えない）
 * - ロックは条件付き書き込み（If-None-Match: *）と条件付き削除（If-Match: ETag）で実装
 */
export class S3Storage implements Storage {
  private readonly prefix: string;

  constructor(
    private readonly client: Pick<S3Client, "send">,
    private readonly opts: S3StorageOptions,
  ) {
    this.prefix = opts.prefix ?? "";
  }

  private key(k: string): string {
    if (k.includes("..") || k.startsWith("/")) throw new Error(`invalid storage key: ${k}`);
    return this.prefix + k;
  }

  private async get(k: string): Promise<{ text: string; etag: string | undefined } | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: this.key(k) }));
      const text = (await res.Body?.transformToString("utf-8")) ?? "";
      return { text, etag: res.ETag };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async getText(k: string): Promise<string | null> {
    return (await this.get(k))?.text ?? null;
  }

  async putText(k: string, text: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.key(k),
        Body: text,
        ContentType: "application/json; charset=utf-8",
        ...(this.opts.setCacheControl ? { CacheControl: cacheControlFor(k) } : {}),
      }),
    );
  }

  /**
   * ロックは期限付き。Lambda の最大実行時間（15 分）より長い TTL を指定すれば、
   * 異常終了した実行のロックも期限後に次の実行が奪える。
   */
  async tryLock(k: string, ttlSeconds: number): Promise<Lock | null> {
    const token = randomUUID();
    const body = JSON.stringify({ token, expiresAt: Date.now() + ttlSeconds * 1000 });
    const create = async (): Promise<boolean> => {
      try {
        await this.client.send(
          new PutObjectCommand({ Bucket: this.opts.bucket, Key: this.key(k), Body: body, IfNoneMatch: "*", ContentType: "application/json" }),
        );
        return true;
      } catch (e) {
        if (isConditionFailed(e)) return false;
        throw e;
      }
    };

    if (!(await create())) {
      const cur = await this.get(k);
      if (cur) {
        let expiresAt: number | undefined;
        try {
          expiresAt = (JSON.parse(cur.text) as { expiresAt?: number }).expiresAt;
        } catch {
          expiresAt = undefined;
        }
        if (typeof expiresAt === "number" && expiresAt > Date.now()) return null;
        // 期限切れ（または壊れた）ロック。読んだものと同じ版のときだけ消す（他の実行が取り直していたら消さない）
        try {
          await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.key(k), IfMatch: cur.etag }));
        } catch (e) {
          if (isConditionFailed(e) || isNotFound(e)) return null;
          throw e;
        }
      }
      if (!(await create())) return null;
    }

    return {
      release: async () => {
        const cur = await this.get(k).catch(() => null);
        if (!cur) return;
        try {
          if ((JSON.parse(cur.text) as { token?: string }).token !== token) return;
          await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.key(k), IfMatch: cur.etag }));
        } catch {
          /* 期限で自然に失効するため無視する */
        }
      },
    };
  }
}
