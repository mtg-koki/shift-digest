import { z } from "zod";

/** 分類。表示順もこの順。 */
export const CATEGORY_IDS = ["tech", "employment", "ownership", "policy"] as const;
export const CategoryIdSchema = z.enum(CATEGORY_IDS);
export type CategoryId = z.infer<typeof CategoryIdSchema>;

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  tech: "技術",
  employment: "雇用",
  ownership: "所有",
  policy: "制度",
};

export const CATEGORY_DESCRIPTIONS: Record<CategoryId, string> = {
  tech: "AI、ロボット、クラウド、自動化、導入事例",
  employment: "採用、職務、賃金、働き方、業務代替",
  ownership: "事業、資本、計算資源、プラットフォーム、権利",
  policy: "法規制、税制、社会保障、著作権",
};

/** UTC の ISO 8601（例: 2026-11-21T22:00:00.000Z）。保存する時刻はすべてこの形式。 */
export const IsoUtcSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "UTC ISO 8601 (Z) expected");

/** Asia/Tokyo 基準の日付（YYYY-MM-DD）。 */
export const JstDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * 要約に使った入力の種類。
 * - rss_description: RSS/Atom の説明文のみ
 * - title_only: 説明文もなくタイトルのみ
 * - full_text: 本文（利用条件を確認したソースのみ。現状未実装）
 */
export const ContentBasisSchema = z.enum(["rss_description", "title_only", "full_text"]);
export type ContentBasis = z.infer<typeof ContentBasisSchema>;

export const SummarizerInfoSchema = z.object({
  provider: z.enum(["mock", "claude", "azure-openai"]),
  model: z.string().nullable(),
});
export type SummarizerInfo = z.infer<typeof SummarizerInfoSchema>;

export const ArticleSchema = z.object({
  id: z.string().min(8),
  titleJa: z.string().min(1),
  summaryJa: z.string().min(1),
  category: CategoryIdSchema,
  originalTitle: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  /** 出典URL。取得プログラムが RSS から取得したもの。AI には生成させない。 */
  url: z.string().url(),
  /** 取得できた場合のみ。推定補完しない。 */
  publishedAt: IsoUtcSchema.nullable(),
  fetchedAt: IsoUtcSchema,
  contentBasis: ContentBasisSchema,
  /** 入力を上限で切り詰めたか */
  inputTruncated: z.boolean(),
  summarizer: SummarizerInfoSchema,
});
export type Article = z.infer<typeof ArticleSchema>;

export const SourceResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  ok: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type SourceResult = z.infer<typeof SourceResultSchema>;

export const UsageSchema = z.object({
  aiCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const DailyReportSchema = z.object({
  schemaVersion: z.literal(1),
  date: JstDateSchema,
  generatedAt: IsoUtcSchema,
  /** ok: 全取得元成功 / partial: 一部取得元が失敗（取得できた分で作成） */
  status: z.enum(["ok", "partial"]),
  articles: z.array(ArticleSchema),
  sources: z.array(SourceResultSchema),
  stats: z.object({
    fetchedItems: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    usage: UsageSchema,
  }),
});
export type DailyReport = z.infer<typeof DailyReportSchema>;

export const IndexEntrySchema = z.object({
  date: JstDateSchema,
  articleCount: z.number().int().nonnegative(),
  status: z.enum(["ok", "partial"]),
  generatedAt: IsoUtcSchema,
});

/** latest への参照。日次データの保存・検証完了後にのみ更新する。 */
export const DigestIndexSchema = z.object({
  schemaVersion: z.literal(1),
  latestDate: JstDateSchema,
  lastSuccessAt: IsoUtcSchema,
  dates: z.array(IndexEntrySchema),
});
export type DigestIndex = z.infer<typeof DigestIndexSchema>;

/** 直近の実行結果。失敗時もここだけは更新する（index は触らない）。 */
export const LastRunSchema = z.object({
  schemaVersion: z.literal(1),
  at: IsoUtcSchema,
  date: JstDateSchema,
  status: z.enum(["ok", "partial", "failed", "skipped"]),
  message: z.string().optional(),
});
export type LastRun = z.infer<typeof LastRunSchema>;

/** AI の出力。URL・日時・出典はここに含めない（プログラム側が保持）。 */
export const AiSummarySchema = z
  .object({
    title_ja: z.string().trim().min(1).max(120),
    summary_ja: z.string().trim().min(1).max(400),
    category: z.enum([...CATEGORY_IDS, "out_of_scope"]),
    /** 0: 対象外 / 1: 低 / 2: 中 / 3: 高 */
    relevance: z.number().int().min(0).max(3),
  })
  .strict()
  .refine((v) => !/https?:\/\//i.test(v.title_ja + v.summary_ja), {
    message: "AI output must not contain URLs",
  });
export type AiSummary = z.infer<typeof AiSummarySchema>;

export const SeenItemSchema = z.object({
  url: z.string(),
  firstSeenAt: IsoUtcSchema,
  /** 掲載された日付（未掲載なら null） */
  reportDate: JstDateSchema.nullable(),
  summary: AiSummarySchema.optional(),
  summarizer: SummarizerInfoSchema.optional(),
  titleKey: z.string().optional(),
});
export type SeenItem = z.infer<typeof SeenItemSchema>;

export const StateSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.record(z.string(), SeenItemSchema),
  usageByDate: z.record(z.string(), UsageSchema),
});
export type State = z.infer<typeof StateSchema>;

export const STORAGE_KEYS = {
  index: "index.json",
  lastRun: "status/last-run.json",
  state: "state/seen.json",
  lock: "locks/batch.lock",
  report: (date: string) => `reports/${date}.json`,
} as const;
