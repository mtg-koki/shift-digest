import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { StrictCategoryIdSchema, JstDateSchema } from "../shared/schema";

/**
 * 利用条件の判断。「RSS の私的利用（取得・保存・自分専用画面への表示）」と「AI へのメタデータ送信」を別々に持つ。
 * - allowed:     規約・ライセンス等が今回の利用方法をカバーしている（根拠を basis に記録）
 * - conditional: 条件付きで認められ、条件を満たす運用にしている（条件を conditions に記録）
 * - prohibited:  禁止が明確
 * - unreviewed:  未確認、または今回の利用方法に当たるか判断できない（許可とは扱わない。不明点を openQuestions に書く）
 * 処理してよいのは allowed / conditional のみ。規約上の判断であり、技術的に取得できるかどうかとは別。
 */
export const UseStatusSchema = z.enum(["allowed", "conditional", "prohibited", "unreviewed"]);
export type UseStatus = z.infer<typeof UseStatusSchema>;

export function isPermitted(s: UseStatus): boolean {
  return s === "allowed" || s === "conditional";
}

const ScopeSchema = z.enum(["privateRss", "aiMetadata"]);
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * 条件。
 * - implemented: 実装・運用で満たしている条件（例: 出典表示、本文を保存しない、認証で非公開）
 * - userConfirmation: ユーザーが確認・判断する必要がある条件。confirmedAt が入るまでその用途では処理しない
 */
export const ConditionSchema = z.object({
  appliesTo: ScopeSchema,
  kind: z.enum(["implemented", "userConfirmation"]),
  text: z.string().min(1).max(400),
  confirmedAt: JstDateSchema.nullable().default(null),
});
export type Condition = z.infer<typeof ConditionSchema>;

const httpsUrl = z.string().url().refine((u) => /^https:\/\//.test(u), "https only");

export const SourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(100),
    homepageUrl: httpsUrl,
    /** 公式の RSS 1.0 / RSS 2.0 / Atom。https のみ（file: はローカル検証用で ALLOW_FILE_FEEDS=true のときだけ） */
    feedUrl: z.string().url(),
    /** 分類（先頭が評価のない記事の表示分類） */
    categories: z.array(StrictCategoryIdSchema).min(1).max(4),
    /** 既定は無効。利用条件を確認してから有効にする */
    enabled: z.boolean().default(false),
    /** 判断の根拠にした規約・ライセンス・案内ページ */
    termsUrl: httpsUrl.nullable().default(null),
    /** 確認日（YYYY-MM-DD） */
    reviewedAt: JstDateSchema.nullable().default(null),
    privateRssUseStatus: UseStatusSchema.default("unreviewed"),
    aiMetadataStatus: UseStatusSchema.default("unreviewed"),
    /** allowed / conditional の根拠（短く。確認した内容だけを書く） */
    basis: z.object({ privateRss: z.string().max(500).optional(), aiMetadata: z.string().max(500).optional() }).default({}),
    conditions: z.array(ConditionSchema).max(20).default([]),
    /** 未確認事項（どの条項がどう不明か） */
    openQuestions: z.array(z.string().max(400)).max(20).default([]),
    /** 画面に表示する出典表記 */
    attributionText: z.string().max(300).default(""),
    /** 小さいほど優先（同一タイトルの重複時の代表選び・同点時の順序） */
    priority: z.number().int().min(1).max(9).default(5),
    /** 1 回の取得で扱う最大件数（既定 MAX_ITEMS_PER_SOURCE） */
    maxItems: z.number().int().min(1).max(100).optional(),
    /** 取得間隔の下限（時間）。媒体の条件があればそれに合わせる（既定は日次バッチと同じ） */
    minFetchIntervalHours: z.number().int().min(1).max(24 * 30).optional(),
    /** 一覧に残す日数（既定 FEED_RETENTION_DAYS）。媒体の条件があればそれに合わせる */
    retentionDays: z.number().int().min(1).max(365).optional(),
  })
  .superRefine((s, ctx) => {
    for (const scope of ScopeSchema.options) {
      const status = scope === "privateRss" ? s.privateRssUseStatus : s.aiMetadataStatus;
      if (!isPermitted(status)) continue;
      // 許可・条件付きとするなら、根拠（ページ・確認日・根拠の要約）を必須にする
      if (!s.termsUrl || !s.reviewedAt) ctx.addIssue({ code: "custom", message: `${s.id}: termsUrl and reviewedAt are required when ${scope} is ${status}` });
      if (!s.basis[scope]) ctx.addIssue({ code: "custom", message: `${s.id}: basis.${scope} is required when ${scope} is ${status}` });
      if (status === "conditional" && !s.conditions.some((c) => c.appliesTo === scope)) {
        ctx.addIssue({ code: "custom", message: `${s.id}: conditions for ${scope} are required when conditional` });
      }
    }
    // AI 送信は RSS の私的利用が認められていることが前提
    if (isPermitted(s.aiMetadataStatus) && !isPermitted(s.privateRssUseStatus)) {
      ctx.addIssue({ code: "custom", message: `${s.id}: aiMetadata cannot be permitted while privateRss is not` });
    }
  });
export type Source = z.infer<typeof SourceSchema>;

export const defaultCategory = (s: Pick<Source, "categories">) => s.categories[0]!;

/** RSS がない（または初期版で扱わない）媒体の手動リンク。スクレイピングしない */
export const ManualLinkSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  url: httpsUrl,
  categories: z.array(StrictCategoryIdSchema).min(1).max(4),
  note: z.string().max(300).default(""),
});
export type ManualLink = z.infer<typeof ManualLinkSchema>;

export interface SourcePolicy {
  /** RSS を取得・保存・表示するか */
  fetch: boolean;
  /** タイトル等を AI に送るか（上記に加え AI 送信が認められ、確認待ちの条件がない） */
  ai: boolean;
  /** 処理しない・AI に送らない理由（ログ・画面用） */
  reasons: string[];
}

const pendingConfirmations = (s: Source, scope: Scope) => s.conditions.filter((c) => c.appliesTo === scope && c.kind === "userConfirmation" && !c.confirmedAt);

/** 情報源ごとの処理可否。未確認は許可と扱わない。ユーザー確認待ちの条件が残っていれば処理しない。 */
export function sourcePolicy(s: Source): SourcePolicy {
  const reasons: string[] = [];
  if (!s.enabled) reasons.push("disabled");
  if (!isPermitted(s.privateRssUseStatus)) reasons.push(`privateRss:${s.privateRssUseStatus}`);
  if (pendingConfirmations(s, "privateRss").length) reasons.push("privateRss:awaiting-user-confirmation");
  const fetch = reasons.length === 0;
  let ai = false;
  if (fetch) {
    if (!isPermitted(s.aiMetadataStatus)) reasons.push(`aiMetadata:${s.aiMetadataStatus}`);
    else if (pendingConfirmations(s, "aiMetadata").length) reasons.push("aiMetadata:awaiting-user-confirmation");
    else ai = true;
  }
  return { fetch, ai, reasons };
}

export const SourcesFileSchema = z.object({
  sources: z.array(SourceSchema),
  manualLinks: z.array(ManualLinkSchema).default([]),
});
export type SourcesFile = z.infer<typeof SourcesFileSchema>;

/** 情報源の設定を読む（無効なものも含めて返す。処理可否は sourcePolicy で判断） */
export async function loadSourcesFile(path: string): Promise<SourcesFile> {
  return parseSourcesFile(JSON.parse(await readFile(path, "utf8")));
}

export function parseSourcesFile(raw: unknown): SourcesFile {
  const parsed = SourcesFileSchema.parse(raw);
  const ids = new Set<string>();
  for (const s of [...parsed.sources, ...parsed.manualLinks]) {
    if (ids.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
    ids.add(s.id);
  }
  return parsed;
}

export function parseSources(raw: unknown): Source[] {
  return parseSourcesFile(raw).sources;
}

export async function loadSources(path: string): Promise<Source[]> {
  return (await loadSourcesFile(path)).sources;
}

// ---------------- 関心テーマ ----------------
export const InterestsFileSchema = z.object({
  themes: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        label: z.string().min(1).max(60),
        /** ルールベースの選別・評価に使うキーワード（大文字小文字・全角半角は区別しない） */
        keywords: z.array(z.string().min(1).max(40)).max(30).default([]),
      }),
    )
    .min(1)
    .max(20),
});
export type Interests = z.infer<typeof InterestsFileSchema>;

export async function loadInterests(path: string): Promise<Interests> {
  return InterestsFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** 関心テーマの内容のハッシュ（変更されたら再評価する） */
export function interestsHash(i: Interests): string {
  return createHash("sha256").update(JSON.stringify(i.themes)).digest("hex").slice(0, 16);
}

// ---------------- 環境変数 ----------------
const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);
const bool = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

/** 環境変数の設定値。上限値はすべて設定可能、ただし過大な値は拒否する。 */
export const BatchEnvSchema = z.object({
  /** mock: ルールベース評価（AI 不使用・既定） / bedrock: Amazon Bedrock Converse API */
  AI_PROVIDER: z.enum(["mock", "bedrock"]).default("mock"),
  /** Bedrock のモデル ID または推論プロファイル ID（候補は README）。既定値は置かない */
  BEDROCK_MODEL_ID: z.string().regex(/^[a-z0-9.:\-]+$/i, "invalid model id").optional(),
  BEDROCK_REGION: z.string().optional(),
  AWS_REGION: z.string().optional(),
  /** 1 回の AI 呼び出しにまとめる記事数 */
  AI_BATCH_SIZE: int(10, 1, 30),
  /** 1 回の AI 呼び出しの出力トークン上限 */
  AI_MAX_OUTPUT_TOKENS: int(2000, 256, 8000),
  /** スロットリング・一時障害時の再試行回数（初回を含まない） */
  AI_MAX_RETRIES: int(2, 0, 5),
  AI_TIMEOUT_MS: int(60000, 5000, 300000),
  /** 1 日あたり AI に渡す記事数の上限（再実行を含む日単位） */
  MAX_AI_ARTICLES_PER_DAY: int(30, 0, 200),
  /** 1 情報源あたり AI に渡す記事数の上限（媒体の偏り防止） */
  MAX_AI_ARTICLES_PER_SOURCE: int(10, 1, 200),
  /** 今日の読む候補の最大件数 */
  MAX_RECOMMENDATIONS: int(5, 0, 20),
  /** 読む候補に同じ情報源から入れる最大件数 */
  MAX_RECOMMENDATIONS_PER_SOURCE: int(2, 1, 20),
  /** 読む候補にする関心度スコアの下限（0〜100） */
  MIN_RELEVANCE_SCORE: int(60, 0, 100),
  /** 読む候補・AI 評価の対象期間（時間）。一覧は FEED_RETENTION_DAYS */
  LOOKBACK_HOURS: int(48, 1, 24 * 14),
  /** 公開日時のない記事を読む候補・AI 評価の対象にするか（一覧には常に載せる） */
  INCLUDE_UNDATED: bool(false),
  MAX_ITEMS_PER_SOURCE: int(30, 1, 100),
  FEED_TIMEOUT_MS: int(15000, 1000, 60000),
  FEED_MAX_BYTES: int(2_000_000, 10_000, 10_000_000),
  FEED_MAX_REDIRECTS: int(3, 0, 5),
  FEED_USER_AGENT: z.string().default("Mozilla/5.0 (compatible; shift-digest-personal-reader/0.2)"),
  /** file: の取得元を許可する（ローカルのサンプルフィード専用。Lambda では設定しない） */
  ALLOW_FILE_FEEDS: bool(false),
  BATCH_MAX_RUNTIME_MS: int(780_000, 10_000, 3_600_000),
  STATE_RETENTION_DAYS: int(120, 7, 3650),
  /** 一覧（feed.json）に残す日数（情報源の retentionDays が優先） */
  FEED_RETENTION_DAYS: int(30, 1, 365),
  /** 一覧（feed.json）に残す最大件数（新しい順） */
  FEED_MAX_ARTICLES: int(2000, 50, 20000),
  SOURCES_FILE: z.string().default("config/sources.json"),
  INTERESTS_FILE: z.string().default("config/interests.json"),
});
export type BatchEnv = z.infer<typeof BatchEnvSchema>;

export function loadBatchEnv(env: Record<string, string | undefined> = process.env): BatchEnv {
  // 空文字は未設定扱い
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  return BatchEnvSchema.parse(cleaned);
}
