import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CategoryIdSchema, JstDateSchema } from "../shared/schema";

/**
 * 利用条件の状態。
 * - allowed:     規約等で明示的に認められている（根拠を note / 規約 URL に残す）
 * - conditional: 条件付きで認められており、その条件を満たす運用にしている（条件を note に書く）
 * - prohibited:  禁止されている
 * - unknown:     未確認、または規約に明記がなく判断できない（許可とは扱わない。禁止と断定もしない）
 * 処理してよいのは allowed / conditional のみ。
 */
export const PermissionStatusSchema = z.enum(["allowed", "conditional", "prohibited", "unknown"]);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

const PermissionSchema = z.object({
  status: PermissionStatusSchema.default("unknown"),
  note: z.string().max(500).optional(),
});

export const TermsSchema = z.object({
  /** 利用規約・RSS 利用条件のページ */
  url: z.string().url().nullable().default(null),
  /** 条件を確認した日（YYYY-MM-DD） */
  checkedAt: JstDateSchema.nullable().default(null),
  /** 条件の要点（自分で確認した内容。推測で書かない） */
  summary: z.string().max(1000).default(""),
  /** RSS の自動取得（1 日 1 回） */
  fetch: PermissionSchema.default({ status: "unknown" }),
  /** 自作の非公開画面へのタイトル・リンクの表示 */
  display: PermissionSchema.default({ status: "unknown" }),
  /** AI（Amazon Bedrock）へのタイトル等メタデータの送信 */
  aiMetadata: PermissionSchema.default({ status: "unknown" }),
  /** 本文の取得・要約（未実装。将来の拡張用） */
  fullText: PermissionSchema.default({ status: "unknown" }),
  /** 出典表記等の必要事項（画面に表示する） */
  attribution: z.string().max(300).optional(),
});
export type Terms = z.infer<typeof TermsSchema>;

export const SourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(100),
    /** RSS 1.0 / RSS 2.0 / Atom。https のみ（file: はローカル検証用で ALLOW_FILE_FEEDS=true のときだけ） */
    feedUrl: z.string().url(),
    /** 既定は無効。利用条件を確認してから有効にする */
    enabled: z.boolean().default(false),
    /** 評価がない場合の分類 */
    defaultCategory: CategoryIdSchema,
    /** 小さいほど優先（同一タイトルの重複時の代表選び・同点時の順序） */
    priority: z.number().int().min(1).max(9).default(5),
    maxItems: z.number().int().min(1).max(100).optional(),
    terms: TermsSchema.default({
      url: null,
      checkedAt: null,
      summary: "",
      fetch: { status: "unknown" },
      display: { status: "unknown" },
      aiMetadata: { status: "unknown" },
      fullText: { status: "unknown" },
    }),
  })
  .superRefine((s, ctx) => {
    const t = s.terms;
    const granted = (["fetch", "display", "aiMetadata", "fullText"] as const).filter((k) => isPermitted(t[k].status));
    // 許可・条件付きとするなら、根拠（規約 URL と確認日）を必須にする
    if (granted.length > 0 && (!t.url || !t.checkedAt)) {
      ctx.addIssue({ code: "custom", message: `${s.id}: terms.url and terms.checkedAt are required when ${granted.join(", ")} is allowed/conditional` });
    }
    for (const k of granted) {
      if (t[k].status === "conditional" && !t[k].note) {
        ctx.addIssue({ code: "custom", message: `${s.id}: terms.${k}.note is required for conditional` });
      }
    }
  });
export type Source = z.infer<typeof SourceSchema>;

export function isPermitted(s: PermissionStatus): boolean {
  return s === "allowed" || s === "conditional";
}

export interface SourcePolicy {
  /** RSS を取得するか（有効かつ 取得・表示の両方が許可/条件付き） */
  fetch: boolean;
  /** タイトル等を AI に送るか（上記に加え AI 送信が許可/条件付き） */
  ai: boolean;
  /** 処理しない・AI に送らない理由（ログ・画面用） */
  reasons: string[];
}

/** 情報源ごとの処理可否。未確認は許可と扱わない。 */
export function sourcePolicy(s: Source): SourcePolicy {
  const reasons: string[] = [];
  if (!s.enabled) reasons.push("disabled");
  if (!isPermitted(s.terms.fetch.status)) reasons.push(`fetch:${s.terms.fetch.status}`);
  if (!isPermitted(s.terms.display.status)) reasons.push(`display:${s.terms.display.status}`);
  const fetch = reasons.length === 0;
  if (fetch && !isPermitted(s.terms.aiMetadata.status)) reasons.push(`aiMetadata:${s.terms.aiMetadata.status}`);
  return { fetch, ai: fetch && isPermitted(s.terms.aiMetadata.status), reasons };
}

export const SourcesFileSchema = z.object({ sources: z.array(SourceSchema) });

/** 情報源の設定を読む（無効なものも含めて返す。処理可否は sourcePolicy で判断） */
export async function loadSources(path: string): Promise<Source[]> {
  return parseSources(JSON.parse(await readFile(path, "utf8")));
}

export function parseSources(raw: unknown): Source[] {
  const parsed = SourcesFileSchema.parse(raw).sources;
  const ids = new Set<string>();
  for (const s of parsed) {
    if (ids.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
    ids.add(s.id);
  }
  return parsed;
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
  /** 取得・選定対象期間（時間） */
  LOOKBACK_HOURS: int(48, 1, 24 * 14),
  /** 公開日時のない記事を新着として扱うか（初回の大量取り込みを避けるため既定 false） */
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
  SOURCES_FILE: z.string().default("config/sources.json"),
  INTERESTS_FILE: z.string().default("config/interests.json"),
});
export type BatchEnv = z.infer<typeof BatchEnvSchema>;

export function loadBatchEnv(env: Record<string, string | undefined> = process.env): BatchEnv {
  // 空文字は未設定扱い
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  return BatchEnvSchema.parse(cleaned);
}
