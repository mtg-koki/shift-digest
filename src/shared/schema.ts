import { z } from "zod";

/** 分類。表示順もこの順。 */
export const CATEGORY_IDS = ["cloud", "ai", "politics", "economy", "finance", "world"] as const;
/** 分類 ID（厳密）。設定ファイルと AI の出力はこれで検証する */
export const StrictCategoryIdSchema = z.enum(CATEGORY_IDS);
export type CategoryId = z.infer<typeof StrictCategoryIdSchema>;

/** 旧分類（〜2026-11）の ID。保存済みの state・レポートを読むときだけ読み替える */
const LEGACY_CATEGORY: Record<string, CategoryId> = { technology: "ai", employment: "economy", ownership: "economy", policy: "politics" };
/** 保存済みデータ用の分類 ID。旧分類の ID は新しい分類に読み替える */
export const CategoryIdSchema = z.preprocess((v) => (typeof v === "string" && v in LEGACY_CATEGORY ? LEGACY_CATEGORY[v] : v), StrictCategoryIdSchema);

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  cloud: "クラウド",
  ai: "AI",
  politics: "政治",
  economy: "経済",
  finance: "金融",
  world: "世界情勢",
};

export const CATEGORY_DESCRIPTIONS: Record<CategoryId, string> = {
  cloud: "クラウド、開発基盤、インフラ、導入・移行・運用の事例",
  ai: "生成 AI、AI の新機能・業務活用・導入事例・ルール整備",
  politics: "政策、国会、選挙、外交・防衛、行政",
  economy: "国内外の経済、産業、企業、経済政策",
  finance: "金融、市場、株価、為替、金利",
  world: "国際情勢、外交、紛争、各国の動き",
};

/** UTC の ISO 8601（例: 2026-11-21T22:00:00.000Z）。保存する時刻はすべてこの形式。 */
export const IsoUtcSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "UTC ISO 8601 (Z) expected");

/** Asia/Tokyo 基準の日付（YYYY-MM-DD）。 */
export const JstDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 記事 ID（正規化 URL の SHA-256 先頭 16 桁） */
export const ArticleIdSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** 評価した仕組み。rules: キーワードによるルールベース（AI 不使用） / bedrock: Amazon Bedrock */
export const AssessorInfoSchema = z.object({
  provider: z.enum(["rules", "bedrock"]),
  /** bedrock の場合はモデル ID または推論プロファイル ID */
  model: z.string().nullable(),
});
export type AssessorInfo = z.infer<typeof AssessorInfoSchema>;

/**
 * 関心度の評価。タイトル等のメタデータだけに基づく（本文は読んでいない）。
 * relevanceScore は「関心テーマとの関連度」であり、事実の正確性・社会的重要性・必読度ではない。
 */
export const AssessmentSchema = z.object({
  category: CategoryIdSchema.nullable(),
  relevanceScore: z.number().int().min(0).max(100),
  reason: z.string().min(1).max(200),
  assessmentBasis: z.literal("metadata_only"),
  assessor: AssessorInfoSchema,
  assessedAt: IsoUtcSchema,
});
export type Assessment = z.infer<typeof AssessmentSchema>;

/**
 * 新着記事（メタデータのみ）。本文・説明文・画像は保存しない。
 * url は取得プログラムが RSS から取得して検証したもの（AI の出力は使わない）。
 */
export const ArticleSchema = z.object({
  id: ArticleIdSchema,
  title: z.string().min(1).max(300),
  url: z.string().url().refine((u) => /^https?:\/\//.test(u), "http(s) only"),
  sourceId: z.string(),
  sourceName: z.string(),
  /** RSS に公開日時がある場合のみ。推定補完しない */
  publishedAt: IsoUtcSchema.nullable(),
  /** 初めて取得した日時（一覧の並び順で公開日時がない場合に使う） */
  fetchedAt: IsoUtcSchema,
  /** RSS 側のカテゴリ（ある場合のみ） */
  feedCategories: z.array(z.string().max(80)).max(10),
  /** 表示用の分類（評価があればその分類、なければ情報源の初期値） */
  category: CategoryIdSchema,
  /** 同じタイトルの記事が他の情報源にもある場合、代表記事の ID */
  duplicateOf: z.string().optional(),
  /** AI に送るかどうか（情報源の「AI へのメタデータ送信」の扱いで決まる） */
  aiEligible: z.boolean(),
  /** タイトルに含まれる関心テーマのキーワード（キーワード一致。テーマごとに 1 語） */
  interestMatches: z.array(z.object({ theme: z.string().max(80), keyword: z.string().max(80) })).max(20).optional(),
  /** 評価済みならその結果（AI 評価、または AI を使わないキーワード一致の評価） */
  assessment: AssessmentSchema.optional(),
});
export type Article = z.infer<typeof ArticleSchema>;

export const RecommendationSchema = z.object({
  articleId: ArticleIdSchema,
  /** 推薦順の基準（関心度・キーワード・新しさを決定的なルールで合成。0〜100） */
  rankScore: z.number().int().min(0).max(100),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const SourceResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  ok: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  error: z.string().optional(),
  /** 出典表記等の必要事項（情報源設定から転記） */
  attribution: z.string().optional(),
});
export type SourceResult = z.infer<typeof SourceResultSchema>;

export const UsageSchema = z.object({
  aiCalls: z.number().int().nonnegative(),
  aiArticles: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const DailyReportSchema = z.object({
  schemaVersion: z.literal(2),
  date: JstDateSchema,
  generatedAt: IsoUtcSchema,
  /** ok: 取得対象の情報源がすべて成功 / partial: 一部失敗（取得できた分で作成） */
  status: z.enum(["ok", "partial"]),
  /** 今日の読む候補（最大件数は設定。適切な候補がなければ 0 件） */
  recommendations: z.array(RecommendationSchema),
  /** この日に初めて見つかった記事（新着一覧） */
  articles: z.array(ArticleSchema),
  sources: z.array(SourceResultSchema),
  interests: z.array(z.string()),
  stats: z.object({
    fetchedItems: z.number().int().nonnegative(),
    newArticles: z.number().int().nonnegative(),
    usage: UsageSchema,
  }),
});
export type DailyReport = z.infer<typeof DailyReportSchema>;

export const IndexEntrySchema = z.object({
  date: JstDateSchema,
  articleCount: z.number().int().nonnegative(),
  recommendationCount: z.number().int().nonnegative(),
  status: z.enum(["ok", "partial"]),
  generatedAt: IsoUtcSchema,
});

/** latest への参照。日次データの保存・検証完了後にのみ更新する。 */
export const DigestIndexSchema = z.object({
  schemaVersion: z.literal(2),
  latestDate: JstDateSchema,
  lastSuccessAt: IsoUtcSchema,
  dates: z.array(IndexEntrySchema),
});
export type DigestIndex = z.infer<typeof DigestIndexSchema>;

/** 直近の実行結果。失敗時もここだけは更新する（index は触らない）。 */
export const LastRunSchema = z.object({
  schemaVersion: z.literal(2),
  at: IsoUtcSchema,
  date: JstDateSchema,
  status: z.enum(["ok", "partial", "failed", "skipped"]),
  message: z.string().optional(),
});
export type LastRun = z.infer<typeof LastRunSchema>;

/** 既出記事（内部データ）。同じ記事を毎日再評価しないためのキャッシュを兼ねる。 */
export const SeenItemSchema = z.object({
  url: z.string(),
  title: z.string(),
  sourceId: z.string(),
  firstSeenAt: IsoUtcSchema,
  /** 初めて見つかった日（JST）。新着一覧はこの日のレポートに載る */
  firstSeenDate: JstDateSchema,
  assessment: AssessmentSchema.optional(),
  /** 評価の前提（タイトル・関心テーマ・モデル・プロンプト版）。変わったら再評価する */
  assessmentKey: z.string().optional(),
});
export type SeenItem = z.infer<typeof SeenItemSchema>;

/** 情報源ごとの取得状態（内部データ）。条件付き GET（ETag / Last-Modified）と取得間隔の判断に使う */
export const SourceFetchStateSchema = z.object({
  etag: z.string().max(300).optional(),
  lastModified: z.string().max(100).optional(),
  /** 取得の対象 URL（変わったら検証値を捨てる） */
  feedUrl: z.string().optional(),
  lastAttemptAt: IsoUtcSchema.optional(),
  lastSuccessAt: IsoUtcSchema.optional(),
  lastError: z.string().max(200).optional(),
  lastItemCount: z.number().int().nonnegative().optional(),
});
export type SourceFetchState = z.infer<typeof SourceFetchStateSchema>;

export const StateSchema = z.object({
  schemaVersion: z.literal(2),
  items: z.record(z.string(), SeenItemSchema),
  usageByDate: z.record(z.string(), UsageSchema),
  sources: z.record(z.string(), SourceFetchStateSchema).default({}),
});
export type State = z.infer<typeof StateSchema>;

/** 画面に出す情報源の状態（feed.json）。規約の判断の詳細は設定ファイルにあり、画面には要点だけを出す */
export const SourceStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  homepageUrl: z.string().url(),
  categories: z.array(CategoryIdSchema),
  attributionText: z.string(),
  /** AI（関心度評価）に送る対象か */
  aiEnabled: z.boolean(),
  lastAttemptAt: IsoUtcSchema.nullable(),
  /** 最終正常取得日時（変更なし応答 304 も正常） */
  lastSuccessAt: IsoUtcSchema.nullable(),
  /** 直近の取得エラー（正常なら null） */
  lastError: z.string().max(200).nullable(),
  /** 直近の取得の結果 */
  lastResult: z.enum(["updated", "not-modified", "skipped-interval", "failed", "none"]),
  /** 一覧に載っている件数 */
  articleCount: z.number().int().nonnegative(),
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const ManualLinkPublicSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  categories: z.array(CategoryIdSchema),
  note: z.string(),
});

/** 自分用 RSS リーダーの一覧データ（保存期間内の記事を新しい順）。日次バッチが更新する */
export const FeedSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoUtcSchema,
  retentionDays: z.number().int().positive(),
  articles: z.array(ArticleSchema),
  sources: z.array(SourceStatusSchema),
  manualLinks: z.array(ManualLinkPublicSchema),
});
export type FeedSnapshot = z.infer<typeof FeedSnapshotSchema>;

/**
 * ストレージのキー。
 * - 自分用画面が取得するデータ（認証付きで配信）: feed.json / index.json / status/ / reports/
 * - 内部データ（配信しない）: state/ / locks/
 * AWS では前者はサイト用バケットの data/ 配下、後者は別の内部用バケットに保存する。
 */
export const STORAGE_KEYS = {
  index: "index.json",
  feed: "feed.json",
  lastRun: "status/last-run.json",
  state: "state/seen.json",
  lock: "locks/batch.lock",
  report: (date: string) => `reports/${date}.json`,
} as const;

export const INTERNAL_KEY_PREFIXES = ["state/", "locks/"] as const;

export function isInternalKey(key: string): boolean {
  return INTERNAL_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * 画面用 JSON の Cache-Control（S3 オブジェクトのメタデータ）。
 * 自分専用のデータのため private（共有キャッシュに保存させない）。ブラウザーは毎回再検証する。
 * CloudFront 側の保持はキャッシュポリシーで決まり、認証は常にキャッシュ判定より前（viewer-request）で行う。
 */
export function cacheControlFor(_key: string): string {
  return "private, no-cache";
}
