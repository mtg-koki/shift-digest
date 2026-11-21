import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBatchEnv, type Source } from "../src/batch/config";
import type { FeedFetcher, FeedItem } from "../src/batch/feed";
import type { Summarizer, SummarizeInput } from "../src/batch/summarize";
import { FsStorage, type Storage } from "../src/shared/storage";

export function tmpStorage(): { dir: string; storage: FsStorage } {
  const dir = mkdtempSync(path.join(tmpdir(), "digest-test-"));
  return { dir, storage: new FsStorage(dir) };
}

export const env = loadBatchEnv({});

export function source(id: string, priority = 1): Source {
  return { id, name: `Source ${id}`, url: `https://${id}.example.com/feed`, enabled: true, defaultCategory: "tech", priority, official: true, allowFullText: false };
}

export function feedItem(n: number, hoursAgo: number, now: Date, opts: Partial<FeedItem> = {}): FeedItem {
  return {
    title: `記事タイトル${n} ${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[n % 26]}${n * 7919}`,
    link: `https://news.example.com/article/${n}`,
    description: `記事${n}の説明文です。`,
    publishedAt: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(),
    ...opts,
  };
}

/** 取得元ごとの結果を返す偽フェッチャー。Error を入れるとその取得元は失敗する */
export function fakeFetcher(map: Record<string, FeedItem[] | Error>): FeedFetcher {
  return async (s) => {
    const v = map[s.id];
    if (v === undefined || v instanceof Error) throw v ?? new Error("not found");
    return v;
  };
}

/** 呼び出し回数と入力を記録する偽要約器 */
export class CountingSummarizer implements Summarizer {
  readonly info = { provider: "claude" as const, model: "test-model" };
  calls: SummarizeInput[] = [];
  constructor(private readonly output: (i: SummarizeInput) => unknown = defaultOutput) {}
  async summarize(input: SummarizeInput) {
    this.calls.push(input);
    return { raw: this.output(input), usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

export function defaultOutput(i: SummarizeInput) {
  return { title_ja: `和訳: ${i.originalTitle}`, summary_ja: `要約: ${i.originalTitle}`, category: "tech", relevance: 2 };
}

/** 指定キーへの書き込みだけ失敗させる */
export class FailingWriteStorage implements Storage {
  constructor(
    private readonly inner: Storage,
    private readonly failKey: (k: string) => boolean,
  ) {}
  getText(k: string) {
    return this.inner.getText(k);
  }
  async putText(k: string, t: string) {
    if (this.failKey(k)) throw new Error(`simulated write failure: ${k}`);
    return this.inner.putText(k, t);
  }
  tryLock(k: string, ttl: number) {
    return this.inner.tryLock(k, ttl);
  }
}
