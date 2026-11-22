import { z } from "zod";
import { StrictCategoryIdSchema } from "../../shared/schema";

/** AI 出力 1 件の形（厳密）。余分なキー（url 等）は受け付けない */
export const AiAssessmentSchema = z
  .object({
    articleId: z.string(),
    category: StrictCategoryIdSchema.nullable(),
    relevanceScore: z.number().int().min(0).max(100),
    reason: z.string().trim().min(1).max(120),
    assessmentBasis: z.literal("metadata_only"),
  })
  .strict()
  .refine((v) => !/https?:\/\/|www\./i.test(v.reason), { message: "reason must not contain URLs" })
  .refine((v) => !/<[a-z/!]/i.test(v.reason), { message: "reason must not contain markup" });
export type AiAssessment = z.infer<typeof AiAssessmentSchema>;

export interface ParsedAssessments {
  accepted: Map<string, AiAssessment>;
  rejected: Array<{ articleId?: string; reason: string }>;
}

/**
 * AI 出力を検証する。
 * - 入力にない記事 ID・重複 ID・不正なスコア/分類・URL やタグを含む理由は受け入れない（その 1 件だけ捨てる）
 * - 形が全体的に不正なら全件不採用
 */
export function parseAssessments(raw: unknown, inputIds: Set<string>): ParsedAssessments {
  const accepted = new Map<string, AiAssessment>();
  const rejected: ParsedAssessments["rejected"] = [];
  const list = raw && typeof raw === "object" && Array.isArray((raw as { assessments?: unknown }).assessments)
    ? ((raw as { assessments: unknown[] }).assessments)
    : null;
  if (!list) return { accepted, rejected: [{ reason: "output is not {assessments: [...]}" }] };
  const seen = new Set<string>();
  for (const item of list) {
    const id = item && typeof item === "object" ? String((item as { articleId?: unknown }).articleId ?? "") : "";
    if (!inputIds.has(id)) {
      rejected.push({ articleId: id || undefined, reason: "unknown articleId" });
      continue;
    }
    if (seen.has(id)) {
      // 重複 ID は曖昧なので、その記事の評価はすべて捨てる
      accepted.delete(id);
      rejected.push({ articleId: id, reason: "duplicate articleId" });
      continue;
    }
    seen.add(id);
    const p = AiAssessmentSchema.safeParse(item);
    if (!p.success) {
      rejected.push({ articleId: id, reason: p.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    accepted.set(id, p.data);
  }
  return { accepted, rejected };
}
