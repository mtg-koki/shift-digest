import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssessInput, Assessor } from "../src/batch/assess";
import { InterestsFileSchema, loadBatchEnv, SourceSchema, type Source } from "../src/batch/config";
import type { FeedFetcher, FeedItem, Validators } from "../src/batch/feed";
import { FsStorage, type Storage } from "../src/shared/storage";

export function tmpStorage(): { dir: string; storage: FsStorage } {
  const dir = mkdtempSync(path.join(tmpdir(), "digest-test-"));
  return { dir, storage: new FsStorage(dir) };
}

export const env = loadBatchEnv({});

export const interests = InterestsFileSchema.parse({
  themes: [
    { id: "ai-agents", label: "AIエージェント", keywords: ["エージェント", "agent"] },
    { id: "ai-policy", label: "AI規制・著作権・制度", keywords: ["規制", "著作権"] },
  ],
});

type Perm = "allowed" | "conditional" | "prohibited" | "unreviewed";

/** RSS の私的利用・AI 送信の可否を指定して情報源を作る（既定はどちらも許可・有効） */
export function source(
  id: string,
  opts: { priority?: number; rss?: Perm; ai?: Perm; enabled?: boolean; pending?: "privateRss" | "aiMetadata"; extra?: Record<string, unknown> } = {},
): Source {
  const rss = opts.rss ?? "allowed";
  const ai = opts.ai ?? "allowed";
  const conditions: unknown[] = [];
  if (rss === "conditional") conditions.push({ appliesTo: "privateRss", kind: "implemented", text: "条件" });
  if (ai === "conditional") conditions.push({ appliesTo: "aiMetadata", kind: "implemented", text: "条件" });
  if (opts.pending) conditions.push({ appliesTo: opts.pending, kind: "userConfirmation", text: "確認待ち" });
  return SourceSchema.parse({
    id,
    name: `Source ${id}`,
    homepageUrl: `https://${id}.example.com/`,
    feedUrl: `https://${id}.example.com/feed`,
    enabled: opts.enabled ?? true,
    categories: ["technology"],
    priority: opts.priority ?? 1,
    termsUrl: "https://example.com/terms",
    reviewedAt: "2026-11-20",
    privateRssUseStatus: rss,
    aiMetadataStatus: ai,
    basis: { privateRss: "test", aiMetadata: "test" },
    conditions,
    attributionText: `出典: Source ${id}`,
    ...opts.extra,
  });
}

export function feedItem(n: number, hoursAgo: number, now: Date, opts: Partial<FeedItem> = {}): FeedItem {
  return {
    title: `記事タイトル${n} ${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[n % 26]}${n * 7919}`,
    link: `https://news.example.com/article/${n}`,
    publishedAt: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(),
    categories: [],
    ...opts,
  };
}

/**
 * 取得元ごとの結果を返す偽フェッチャー。Error を入れるとその取得元は失敗する。"304" は変更なし応答。
 * 呼ばれた ID と、渡された検証値（条件付き GET）を記録する
 */
export function fakeFetcher(map: Record<string, FeedItem[] | Error | "304">): FeedFetcher & { called: string[]; validators: Record<string, Validators | undefined> } {
  const called: string[] = [];
  const validators: Record<string, Validators | undefined> = {};
  const f = (async (s: Source, _o: unknown, prev?: Validators) => {
    called.push(s.id);
    validators[s.id] = prev;
    const v = map[s.id];
    if (v === "304") return { notModified: true, validators: { etag: prev?.etag ?? "\"e1\"" } };
    if (v === undefined || v instanceof Error) throw v ?? new Error("not found");
    return { notModified: false, items: v, validators: { etag: "\"e1\"", lastModified: "Sat, 21 Nov 2026 00:00:00 GMT" } };
  }) as unknown as FeedFetcher & { called: string[]; validators: Record<string, Validators | undefined> };
  f.called = called;
  f.validators = validators;
  return f;
}

/** 呼び出しと入力を記録する偽 AI 評価器 */
export class FakeAssessor implements Assessor {
  readonly info = { provider: "bedrock" as const, model: "test-model" };
  calls: AssessInput[][] = [];
  constructor(private readonly output: (items: AssessInput[]) => unknown = defaultOutput) {}
  async assess(items: AssessInput[]) {
    this.calls.push(items);
    return { raw: this.output(items), usage: { inputTokens: 100, outputTokens: 50 } };
  }
  get sentIds(): string[] {
    return this.calls.flat().map((i) => i.articleId);
  }
}

export function defaultOutput(items: AssessInput[]) {
  return {
    assessments: items.map((i) => ({ articleId: i.articleId, category: "technology", relevanceScore: 80, reason: "関心テーマに関係する語がタイトルにあるため", assessmentBasis: "metadata_only" })),
  };
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
