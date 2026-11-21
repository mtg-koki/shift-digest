import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { parseFeedDate } from "../shared/date";
import type { Source } from "./config";

export interface FeedItem {
  title: string;
  link: string;
  /** HTML を除去した説明文（なければ空） */
  description: string;
  /** 取得できた場合のみ */
  publishedAt: string | null;
}

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
}

export type FeedFetcher = (source: Source, opts: FetchOptions) => Promise<FeedItem[]>;

function detectEncoding(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder("ascii").decode(bytes.slice(0, 200));
  const decl = /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  const header = contentType ? /charset=([\w-]+)/i.exec(contentType)?.[1] : undefined;
  return (decl ?? header ?? "utf-8").toLowerCase();
}

export function decodeFeed(bytes: Uint8Array, contentType: string | null): string {
  const enc = detectEncoding(bytes, contentType);
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** HTTP(S) でフィードを取得する。サイズ・時間に上限を設け、認証や有料制限は回避しない。 */
export const fetchFeed: FeedFetcher = async (source, opts) => {
  if (source.url.startsWith("file:")) {
    // 検証用。file:relative/path は作業ディレクトリ基準、file:///abs は絶対パス
    const p = source.url.startsWith("file:///") ? fileURLToPath(source.url) : source.url.replace(/^file:/, "");
    const buf = await readFile(p);
    return parseFeed(decodeFeed(buf, null));
  }
  const res = await fetch(source.url, {
    headers: { "user-agent": opts.userAgent, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > opts.maxBytes) throw new Error(`feed too large (${len} bytes)`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > opts.maxBytes) throw new Error(`feed too large (${buf.byteLength} bytes)`);
  return parseFeed(decodeFeed(buf, res.headers.get("content-type")));
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ["item", "entry", "link"].includes(name),
});

function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return text((v as Record<string, unknown>)["#text"]);
  return "";
}

export function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function atomLink(links: unknown): string {
  if (!Array.isArray(links)) return text(links);
  const objs = links as Array<Record<string, unknown> | string>;
  const alt =
    objs.find((l) => typeof l === "object" && (l["@_rel"] === undefined || l["@_rel"] === "alternate")) ?? objs[0];
  if (typeof alt === "string") return alt;
  return typeof alt?.["@_href"] === "string" ? alt["@_href"] : "";
}

/** RSS 2.0 / RSS 1.0(RDF) / Atom を共通形式にする */
export function parseFeed(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  let raw: Array<Record<string, unknown>> = [];
  let kind: "rss" | "atom";
  if (doc.rss?.channel) {
    raw = doc.rss.channel.item ?? [];
    kind = "rss";
  } else if (doc["rdf:RDF"]) {
    raw = doc["rdf:RDF"].item ?? [];
    kind = "rss";
  } else if (doc.feed) {
    raw = doc.feed.entry ?? [];
    kind = "atom";
  } else {
    throw new Error("unsupported feed format");
  }
  const items: FeedItem[] = [];
  for (const it of raw) {
    const title = stripHtml(text(it.title));
    const link = (kind === "atom" ? atomLink(it.link) : text(it.link) || text(it.guid)).trim();
    if (!title || !link) continue;
    const description = stripHtml(
      text(kind === "atom" ? (it.summary ?? it.content) : (it.description ?? it["content:encoded"])),
    );
    const publishedAt =
      kind === "atom"
        ? parseFeedDate(text(it.published) || text(it.updated))
        : parseFeedDate(text(it.pubDate) || text(it["dc:date"]));
    items.push({ title, link, description, publishedAt });
  }
  return items;
}
