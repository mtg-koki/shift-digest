import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CategoryIdSchema } from "../shared/schema";

export const SourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  /** RSS 1.0 / RSS 2.0 / Atom。file: はローカル検証用 */
  url: z.string().url(),
  enabled: z.boolean().default(true),
  /** AI 未使用時・判定不能時の分類 */
  defaultCategory: CategoryIdSchema,
  /** 小さいほど優先。公式発表・一次情報を 1 にする */
  priority: z.number().int().min(1).max(9).default(5),
  official: z.boolean().default(false),
  /** 本文取得の可否。利用条件を確認した場合のみ true（現状は未実装のため常に説明文のみ使用） */
  allowFullText: z.boolean().default(false),
  maxItems: z.number().int().min(1).max(100).optional(),
  /** 確認した利用条件のURLやメモ */
  termsNote: z.string().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const SourcesFileSchema = z.object({ sources: z.array(SourceSchema).min(1) });

export async function loadSources(path: string): Promise<Source[]> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const ids = new Set<string>();
  const parsed = SourcesFileSchema.parse(raw).sources;
  for (const s of parsed) {
    if (ids.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
    ids.add(s.id);
  }
  return parsed.filter((s) => s.enabled);
}

const int = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** 環境変数の設定値。上限値はすべて設定可能、ただし過大な値は拒否する。 */
export const BatchEnvSchema = z.object({
  AI_PROVIDER: z.enum(["mock", "claude", "azure-openai"]).default("mock"),
  AI_MODEL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MAX_OUTPUT_TOKENS: int(2048, 128, 16000),
  AI_MAX_INPUT_CHARS: int(3000, 200, 20000),
  AI_MAX_RETRIES: int(2, 0, 5),
  AI_TIMEOUT_MS: int(60000, 5000, 300000),
  AI_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  CLAUDE_FALLBACKS: z.enum(["default", "off"]).default("default"),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().optional(),
  MAX_AI_ARTICLES_PER_DAY: int(10, 0, 50),
  MAX_PUBLISHED_ARTICLES: int(5, 0, 20),
  MIN_RELEVANCE: int(2, 0, 3),
  LOOKBACK_HOURS: int(48, 1, 24 * 14),
  MAX_ITEMS_PER_SOURCE: int(20, 1, 100),
  FEED_TIMEOUT_MS: int(15000, 1000, 60000),
  FEED_MAX_BYTES: int(2_000_000, 10_000, 10_000_000),
  FEED_USER_AGENT: z.string().default("Mozilla/5.0 (compatible; news-digest-bot/0.1)"),
  BATCH_MAX_RUNTIME_MS: int(900_000, 10_000, 3_600_000),
  STATE_RETENTION_DAYS: int(120, 7, 3650),
  SOURCES_FILE: z.string().default("config/sources.json"),
});
export type BatchEnv = z.infer<typeof BatchEnvSchema>;

export function loadBatchEnv(env: Record<string, string | undefined> = process.env): BatchEnv {
  // 空文字は未設定扱い
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  return BatchEnvSchema.parse(cleaned);
}
