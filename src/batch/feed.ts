import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { parseFeedDate } from "../shared/date";
import type { Source } from "./config";
import { safeFetch } from "./net";

/**
 * RSS から取り出すメタデータ。本文・説明文・画像は取り出さない（保存も AI 送信もしない）。
 */
export interface FeedItem {
  title: string;
  link: string;
  /** 取得できた場合のみ */
  publishedAt: string | null;
  /** RSS 側のカテゴリ（ある場合のみ） */
  categories: string[];
}

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  allowFileFeeds: boolean;
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

/** RSS を取得する。https のみ・内部アドレス不可・リダイレクト先も検査（net.ts）。認証や有料制限は回避しない。 */
export const fetchFeed: FeedFetcher = async (source, opts) => {
  if (source.feedUrl.startsWith("file:")) {
    // ローカルのサンプルフィード専用。Lambda では ALLOW_FILE_FEEDS を設定しない
    if (!opts.allowFileFeeds) throw new Error("file: feeds are disabled");
    const p = source.feedUrl.startsWith("file:///") ? fileURLToPath(source.feedUrl) : source.feedUrl.replace(/^file:/, "");
    return parseFeed(decodeFeed(await readFile(p), null));
  }
  const res = await safeFetch(source.feedUrl, {
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    maxRedirects: opts.maxRedirects,
    userAgent: opts.userAgent,
    accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9",
  });
  return parseFeed(decodeFeed(res.body, res.contentType));
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  // 標準の実体参照（&amp; 等）と HTML 実体だけを処理する。DTD による実体定義は parseFeed の前段で拒否する
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ["item", "entry", "link", "category", "dc:subject"].includes(name),
});

function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return text((v as Record<string, unknown>)["#text"]);
  return "";
}

/** タグを除去したプレーンテキスト（表示は React がエスケープする。HTML として埋め込まない） */
export function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    // 制御文字・双方向制御文字を除く
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function atomLink(links: unknown): string {
  if (!Array.isArray(links)) return text(links);
  const objs = links as Array<Record<string, unknown> | string>;
  const alt = objs.find((l) => typeof l === "object" && (l["@_rel"] === undefined || l["@_rel"] === "alternate")) ?? objs[0];
  if (typeof alt === "string") return alt;
  return typeof alt?.["@_href"] === "string" ? alt["@_href"] : "";
}

function categories(v: unknown, atom: boolean): string[] {
  if (!Array.isArray(v)) return [];
  const out = v
    .map((c) => (atom && typeof c === "object" && c ? String((c as Record<string, unknown>)["@_term"] ?? (c as Record<string, unknown>)["@_label"] ?? "") : text(c)))
    .map((c) => stripHtml(c).slice(0, 80))
    .filter(Boolean);
  return [...new Set(out)].slice(0, 10);
}

/** RSS 2.0 / RSS 1.0(RDF) / Atom を共通形式にする。外部実体・DTD は処理しない */
export function parseFeed(xml: string): FeedItem[] {
  if (/<!ENTITY/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error("DTD / entity declarations are not allowed");
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
    const title = stripHtml(text(it.title)).slice(0, 300);
    const link = (kind === "atom" ? atomLink(it.link) : text(it.link) || text(it.guid)).trim();
    if (!title || !link) continue;
    const publishedAt =
      kind === "atom" ? parseFeedDate(text(it.published) || text(it.updated)) : parseFeedDate(text(it.pubDate) || text(it["dc:date"]));
    const cats = kind === "atom" ? categories(it.category, true) : [...categories(it.category, false), ...categories(it["dc:subject"], false)];
    items.push({ title, link, publishedAt, categories: [...new Set(cats)].slice(0, 10) });
  }
  return items;
}
