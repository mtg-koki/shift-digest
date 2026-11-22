import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * CloudFront Function（infra/app/functions/basic-auth.js）を Node 上で評価する。
 * CloudFront 固有の import を差し替えて、同じコードを実行する（実環境の CloudFront での動作確認ではない）。
 */
const FILE = "infra/app/functions/basic-auth.js";
const src = readFileSync(FILE, "utf8");

type Req = { uri: string; headers: Record<string, { value: string }> };
type Handler = (e: { request: Req }) => Promise<Req | { statusCode: number; headers: Record<string, { value: string }> }>;

function load(kvsValue: string | Error | undefined): Handler {
  const code = src.replace(/^import cf from 'cloudfront';$/m, "");
  const cf = {
    kvs: () => ({
      get: async (k: string) => {
        if (k !== "basic-auth-sha256") throw new Error("unexpected key");
        if (kvsValue instanceof Error || kvsValue === undefined) throw kvsValue ?? new Error("key not found");
        return kvsValue;
      },
    }),
  };
  const req = (m: string) => {
    if (m !== "crypto") throw new Error(`unexpected module ${m}`);
    return { createHash };
  };
  return new Function("cf", "require", `${code}\nreturn handler;`)(cf, req) as Handler;
}

const token = Buffer.from("me:correct-horse-battery-staple-123").toString("base64");
const hash = createHash("sha256").update(token).digest("hex");
const request = (uri: string, auth?: string): { request: Req } => ({ request: { uri, headers: auth ? { authorization: { value: auth } } : {} } });

describe("CloudFront Basic auth function", () => {
  it("is small enough for CloudFront Functions (10 KB)", () => {
    expect(statSync(FILE).size).toBeLessThan(10 * 1024);
  });

  it.each(["/", "/index.html", "/data/index.json", "/data/reports/2026-11-22.json", "/data/status/last-run.json", "/_next/static/chunks/x.js", "/404.html"])(
    "denies unauthenticated access to %s",
    async (uri) => {
      const res = await load(hash)(request(uri));
      expect(res).toMatchObject({ statusCode: 401 });
      expect((res as { headers: Record<string, { value: string }> }).headers["www-authenticate"]!.value).toMatch(/^Basic realm=/);
      expect((res as { headers: Record<string, { value: string }> }).headers["cache-control"]!.value).toBe("no-store");
    },
  );

  it("denies wrong credentials and other schemes", async () => {
    const h = load(hash);
    const wrong = Buffer.from("me:wrong").toString("base64");
    for (const a of [`Basic ${wrong}`, `Bearer ${token}`, "Basic", `Basic ${token}x`]) {
      expect(await h(request("/data/index.json", a))).toMatchObject({ statusCode: 401 });
    }
  });

  it("allows correct credentials and strips the Authorization header before the origin", async () => {
    const res = (await load(hash)(request("/data/index.json", `Basic ${token}`))) as Req;
    expect(res.uri).toBe("/data/index.json");
    expect(res.headers.authorization).toBeUndefined();
    // スキーム名の大文字小文字は区別しない
    expect(await load(hash)(request("/", `basic ${token}`))).toHaveProperty("uri", "/");
  });

  it("fails closed when the KVS key is missing, empty or unreadable", async () => {
    for (const v of [undefined, "", new Error("kvs down")]) {
      expect(await load(v)(request("/", `Basic ${token}`))).toMatchObject({ statusCode: 401 });
    }
  });

  it("does not contain a password or hash in the code", () => {
    expect(src).not.toMatch(/[0-9a-f]{64}/);
    expect(src).not.toMatch(/password\s*[:=]/i);
  });
});
