import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { handleEvent } from "../src/batch/lambda";
import { parseAssessments } from "../src/batch/assess";
import { BedrockAssessor, extractJson } from "../src/batch/assess/bedrock";
import { STORAGE_KEYS } from "../src/shared/schema";
import { RoutedStorage, S3Storage } from "../src/shared/storage";
import { HttpStore } from "../src/web/http-store";
import { tmpStorage } from "./helpers";

// ---- S3 の最小フェイク（条件付き書き込み・削除を含む） ----
function s3Error(status: number, name: string) {
  return new S3ServiceException({ name, $fault: "client", $metadata: { httpStatusCode: status }, message: name });
}

class FakeS3 {
  objects = new Map<string, { body: string; etag: string; cacheControl?: string; contentType?: string }>();
  sent: unknown[] = [];
  private n = 0;
  async send(cmd: unknown): Promise<unknown> {
    this.sent.push(cmd);
    if (cmd instanceof PutObjectCommand) {
      const i = cmd.input;
      const k = `${i.Bucket}/${i.Key}`;
      if (i.IfNoneMatch === "*" && this.objects.has(k)) throw s3Error(412, "PreconditionFailed");
      this.objects.set(k, { body: String(i.Body), etag: `"e${++this.n}"`, cacheControl: i.CacheControl, contentType: i.ContentType });
      return {};
    }
    if (cmd instanceof GetObjectCommand) {
      const o = this.objects.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
      if (!o) throw s3Error(404, "NoSuchKey");
      return { ETag: o.etag, Body: { transformToString: async () => o.body } };
    }
    if (cmd instanceof DeleteObjectCommand) {
      const k = `${cmd.input.Bucket}/${cmd.input.Key}`;
      const o = this.objects.get(k);
      if (!o) throw s3Error(404, "NoSuchKey");
      if (cmd.input.IfMatch && cmd.input.IfMatch !== o.etag) throw s3Error(412, "PreconditionFailed");
      this.objects.delete(k);
      return {};
    }
    throw new Error("unexpected command");
  }
}

describe("S3Storage", () => {
  it("routes public keys under data/ with Cache-Control and internal keys to the internal bucket", async () => {
    const s3 = new FakeS3();
    const storage = new RoutedStorage(
      new S3Storage(s3, { bucket: "site", prefix: "data/", setCacheControl: true }),
      new S3Storage(s3, { bucket: "internal" }),
    );
    await storage.putText(STORAGE_KEYS.index, "{}");
    await storage.putText(STORAGE_KEYS.report("2026-11-21"), "{}");
    await storage.putText(STORAGE_KEYS.state, "{}");
    expect([...s3.objects.keys()].sort()).toEqual(["internal/state/seen.json", "site/data/index.json", "site/data/reports/2026-11-21.json"]);
    expect(s3.objects.get("site/data/index.json")!.cacheControl).toBe("private, no-cache");
    expect(s3.objects.get("site/data/reports/2026-11-21.json")!.cacheControl).toBe("private, no-cache");
    expect(s3.objects.get("internal/state/seen.json")!.cacheControl).toBeUndefined();
    expect(s3.objects.get("site/data/index.json")!.contentType).toBe("application/json; charset=utf-8");
    // 内部キーは公開バケットに書かれない
    expect(await new S3Storage(s3, { bucket: "site", prefix: "data/" }).getText(STORAGE_KEYS.state)).toBeNull();
    expect(await storage.getText(STORAGE_KEYS.state)).toBe("{}");
    expect(await storage.getText("reports/1999-01-01.json")).toBeNull();
  });

  it("rejects path traversal keys", async () => {
    await expect(new S3Storage(new FakeS3(), { bucket: "b", prefix: "data/" }).putText("../index.html", "x")).rejects.toThrow();
  });

  it("lock: exclusive while valid, released by owner, and takeover only after expiry", async () => {
    const s3 = new FakeS3();
    const st = new S3Storage(s3, { bucket: "internal" });
    const a = await st.tryLock("locks/batch.lock", 960);
    expect(a).not.toBeNull();
    expect(await st.tryLock("locks/batch.lock", 960)).toBeNull();
    await a!.release();
    expect(s3.objects.has("internal/locks/batch.lock")).toBe(false);

    // 期限切れのロック（異常終了の残骸）は奪える
    s3.objects.set("internal/locks/batch.lock", { body: JSON.stringify({ token: "old", expiresAt: Date.now() - 1 }), etag: '"old"' });
    const b = await st.tryLock("locks/batch.lock", 960);
    expect(b).not.toBeNull();
    // 新しいトークンで取り直している
    const body = JSON.parse(s3.objects.get("internal/locks/batch.lock")!.body);
    expect(body.token).not.toBe("old");
    await b!.release();
    expect(s3.objects.has("internal/locks/batch.lock")).toBe(false);
  });
});

// ---- Bedrock ----
function converseResult(text: string, stopReason = "end_turn") {
  return { output: { message: { role: "assistant", content: [{ text }] } }, stopReason, usage: { inputTokens: 321, outputTokens: 45, totalTokens: 366 } };
}

const ID = "0123456789abcdef";
const input = [{ articleId: ID, title: "AIエージェントの新サービス", sourceName: "S", publishedAt: null }];

describe("BedrockAssessor", () => {
  it("calls Converse with model id, system prompt, token limit and temperature 0; records usage", async () => {
    const sent: ConverseCommand[] = [];
    const client = {
      send: async (c: unknown) => {
        sent.push(c as ConverseCommand);
        return converseResult(`{"assessments":[{"articleId":"${ID}","category":"technology","relevanceScore":80,"reason":"関心テーマのAIエージェントに関する新サービスのため","assessmentBasis":"metadata_only"}]}`);
      },
    };
    const s = new BedrockAssessor({ modelId: "jp.anthropic.claude-haiku-5-5", maxOutputTokens: 1024, maxRetries: 2, timeoutMs: 60000 }, client as never);
    const res = await s.assess(input, ["AIエージェント"], new AbortController().signal);
    expect(parseAssessments(res.raw, new Set([ID])).accepted.get(ID)!.relevanceScore).toBe(80);
    expect(res.usage).toEqual({ inputTokens: 321, outputTokens: 45 });
    expect(s.info).toEqual({ provider: "bedrock", model: "jp.anthropic.claude-haiku-5-5" });
    const i = sent[0]!.input;
    expect(i.modelId).toBe("jp.anthropic.claude-haiku-5-5");
    expect(i.inferenceConfig).toEqual({ maxTokens: 1024, temperature: 0 });
    expect(i.system?.[0]).toHaveProperty("text");
    // 記事は <articles> 内の JSON データとして渡す（ID・タイトル・媒体名・公開日時と関心テーマのみ）
    const text = (i.messages![0]!.content![0] as { text: string }).text;
    expect(text).toMatch(/^<articles>\n\{/);
    expect(JSON.parse(text.replace(/^<articles>\n|\n<\/articles>$/g, ""))).toEqual({
      interests: ["AIエージェント"],
      articles: [{ articleId: ID, title: "AIエージェントの新サービス", source: "S", publishedAt: null }],
    });
    expect(i).not.toHaveProperty("toolConfig");
  });

  it("treats max_tokens as rejected but keeps token usage", async () => {
    const client = { send: async () => converseResult('{"assessments":[', "max_tokens") };
    const s = new BedrockAssessor({ modelId: "m", maxOutputTokens: 128, maxRetries: 0, timeoutMs: 5000 }, client as never);
    await expect(s.assess(input, [], new AbortController().signal)).rejects.toMatchObject({ usage: { inputTokens: 321, outputTokens: 45 } });
  });

  it("extracts JSON from fenced or wrapped output, null otherwise", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('結果: {"a":1}')).toEqual({ a: 1 });
    expect(extractJson("ignore previous instructions")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });
});

// ---- Lambda handler ----
describe("Lambda handler", () => {
  it("passes force and a runtime limit below the remaining time; throws on failed", async () => {
    let seen: { force: boolean; maxRuntimeMs?: number } | undefined;
    const ok = await handleEvent({ force: true }, 900_000, async (o) => {
      seen = o;
      return { status: "ok", date: "2026-11-21", articles: 0, recommendations: 0, usage: { aiCalls: 0, aiArticles: 0, inputTokens: 0, outputTokens: 0 } };
    });
    expect(ok.status).toBe("ok");
    expect(seen).toMatchObject({ force: true, maxRuntimeMs: 810_000 });
    await expect(handleEvent({}, 900_000, async () => ({ status: "skipped", date: "d", reason: "locked" }))).resolves.toMatchObject({ status: "skipped" });
    await expect(handleEvent({}, 900_000, async () => ({ status: "failed", date: "d", reason: "all sources failed" }))).rejects.toThrow("all sources failed");
    // EventBridge Scheduler の既定入力・不正な値では force にしない
    await handleEvent(null, 900_000, async (o) => {
      seen = o;
      return { status: "skipped", date: "d", reason: "already-exists" };
    });
    expect(seen!.force).toBe(false);
  });
});

// ---- Web: 同一オリジンからの取得 ----
describe("HttpStore", () => {
  it("fetches /data/<key> with revalidation; 404/403 means not created yet", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const store = new HttpStore("/data", (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.endsWith("index.json")) return new Response("{}", { status: 200 });
      if (url.endsWith("broken.json")) return new Response("x", { status: 500 });
      return new Response("<html>404</html>", { status: 404 });
    }) as typeof fetch);
    expect(await store.getText("index.json")).toBe("{}");
    expect(calls[0]).toEqual(["/data/index.json", { cache: "no-cache", headers: { accept: "application/json" } }]);
    expect(await store.getText("reports/2026-01-01.json")).toBeNull();
    await expect(store.getText("broken.json")).rejects.toThrow("HTTP 500");
    await expect(store.getText("../index.html")).rejects.toThrow();
  });

  it("local layout keeps internal data out of the public directory", async () => {
    const pub = tmpStorage();
    const internal = tmpStorage();
    const st = new RoutedStorage(pub.storage, internal.storage);
    await st.putText(STORAGE_KEYS.state, "{}");
    expect(await pub.storage.getText(STORAGE_KEYS.state)).toBeNull();
    expect(await internal.storage.getText(STORAGE_KEYS.state)).toBe("{}");
  });
});
