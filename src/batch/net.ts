import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * 外部 URL（RSS の URL・リダイレクト先）は信頼できない入力として扱う。
 * - https のみ（http は不可）
 * - 接続先 IP を名前解決の時点で検査し、内部・ループバック・リンクローカル（メタデータエンドポイント）等を拒否
 *   （検査済みのアドレスにそのまま接続するため DNS rebinding も防ぐ）
 * - リダイレクトは手動で追い、行き先ごとに同じ検査をする
 * - タイムアウトと最大サイズを設ける
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // リンクローカル（EC2/Lambda のメタデータ 169.254.169.254 等）
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // マルチキャスト
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // ULA（fd00:ec2::254 のメタデータを含む）
  ["fe80::", 10], // リンクローカル
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** 接続してはいけないアドレスか */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return blocked.check(mapped, "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true;
}

export class UnsafeUrlError extends Error {}

/** URL の形式を検査する（接続前）。https のみ、認証情報付き・IP 直書きの内部アドレスは不可 */
export function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }
  if (u.protocol !== "https:") throw new UnsafeUrlError(`protocol not allowed: ${u.protocol}`);
  if (u.username || u.password) throw new UnsafeUrlError("credentials in URL are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new UnsafeUrlError(`host not allowed: ${host}`);
  }
  if (isIP(host) && isBlockedAddress(host)) throw new UnsafeUrlError(`address not allowed: ${host}`);
  if (u.port && u.port !== "443") throw new UnsafeUrlError(`port not allowed: ${u.port}`);
  return u;
}

type LookupFn = (
  hostname: string,
  options: { all: true },
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** 名前解決の結果がすべて安全な場合だけ接続させる lookup（http.request の lookup に渡す） */
export function guardedLookup(resolve: LookupFn = dnsLookup as unknown as LookupFn) {
  return (hostname: string, options: object, cb: (...a: unknown[]) => void) => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err);
      if (!addresses.length) return cb(new UnsafeUrlError(`no address for ${hostname}`));
      const bad = addresses.find((a) => isBlockedAddress(a.address));
      if (bad) return cb(new UnsafeUrlError(`address not allowed: ${bad.address}`));
      const all = (options as { all?: boolean }).all;
      if (all) return cb(null, addresses);
      cb(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  accept?: string;
  /** 条件付き GET（前回の ETag / Last-Modified）。変更がなければ 304 を返す */
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  /** テスト用: 名前解決の差し替え・プロトコルの差し替え */
  lookup?: ReturnType<typeof guardedLookup>;
  /** テスト用: https 以外（ローカルの http テストサーバー）を許可 */
  insecureAllowHttpForTest?: boolean;
}

export interface SafeFetchResult {
  status: number;
  contentType: string | null;
  body: Uint8Array;
  finalUrl: string;
  etag?: string;
  lastModified?: string;
}

function requestOnce(u: URL, opts: SafeFetchOptions, deadline: number): Promise<SafeFetchResult & { location?: string }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "http:" ? http : https;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Error("timeout"));
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: {
          "user-agent": opts.userAgent,
          accept: opts.accept ?? "*/*",
          "accept-encoding": "identity",
          ...(opts.ifNoneMatch ? { "if-none-match": opts.ifNoneMatch } : {}),
          ...(opts.ifModifiedSince ? { "if-modified-since": opts.ifModifiedSince } : {}),
        },
        lookup: (opts.lookup ?? guardedLookup()) as never,
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({ status, contentType: null, body: new Uint8Array(), finalUrl: u.href, location });
        }
        const header = (name: string) => {
          const v = res.headers[name];
          return typeof v === "string" && v.length <= 300 ? v : undefined;
        };
        const validators = { etag: header("etag"), lastModified: header("last-modified") };
        if (status === 304) {
          res.resume();
          return resolve({ status, contentType: null, body: new Uint8Array(), finalUrl: u.href, ...validators });
        }
        const len = Number(res.headers["content-length"] ?? "0");
        if (len > opts.maxBytes) {
          res.destroy();
          return reject(new Error(`response too large (${len} bytes)`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            reject(new Error(`response too large (> ${opts.maxBytes} bytes)`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            status,
            contentType: (res.headers["content-type"] as string | undefined) ?? null,
            body: new Uint8Array(Buffer.concat(chunks)),
            finalUrl: u.href,
            ...validators,
          }),
        );
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("timeout")), remaining);
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** 安全な GET。リダイレクト先も検査する。2xx と（条件付き GET の）304 以外はエラー */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const deadline = Date.now() + opts.timeoutMs;
  const check = (raw: string) => {
    if (opts.insecureAllowHttpForTest && raw.startsWith("http://")) return new URL(raw);
    return assertSafeUrl(raw);
  };
  let current = check(url);
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(current, opts, deadline);
    if (res.location) {
      if (hop >= opts.maxRedirects) throw new Error("too many redirects");
      current = check(new URL(res.location, current).href);
      continue;
    }
    if (res.status === 304 && (opts.ifNoneMatch || opts.ifModifiedSince)) return res;
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return res;
  }
}
