import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssessInput, Assessor } from "../src/batch/assess";
import { InterestsFileSchema, loadBatchEnv, SourceSchema, type Source } from "../src/batch/config";
import type { FeedFetcher, FeedItem } from "../src/batch/feed";
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

type Perm = "allowed" | "conditional" | "prohibited" | "unknown";

/** 取得・表示・AI 送信の可否を指定して情報源を作る（既定はすべて許可・有効） */
export function source(id: string, opts: { priority?: number; fetch?: Perm; display?: Perm; ai?: Perm; enabled?: boolean } = {}): Source {
  const p = (s: Perm) => (s === "conditional" ? { status: s, note: "条件" } : { status: s });
  return SourceSchema.parse({
    id,
    name: `Source ${id}`,
    feedUrl: `https://${id}.example.com/feed`,
    enabled: opts.enabled ?? true,
    defaultCategory: "technology",
    priority: opts.priority ?? 1,
    terms: {
      url: "https://example.com/terms",
      checkedAt: "2026-11-20",
      summary: "test",
      fetch: p(opts.fetch ?? "allowed"),
      display: p(opts.display ?? "allowed"),
      aiMetadata: p(opts.ai ?? "allowed"),
      fullText: { status: "unknown" },
    },
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

/** 取得元ごとの結果を返す偽フェッチャー。Error を入れるとその取得元は失敗する。呼ばれた ID を記録する */
export function fakeFetcher(map: Record<string, FeedItem[] | Error>): FeedFetcher & { called: string[] } {
  const called: string[] = [];
  const f = (async (s: Source) => {
    called.push(s.id);
    const v = map[s.id];
    if (v === undefined || v instanceof Error) throw v ?? new Error("not found");
    return v;
  }) as unknown as FeedFetcher & { called: string[] };
  f.called = called;
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
