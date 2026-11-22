import type { BatchEnv } from "../config";
import { BedrockAssessor } from "./bedrock";
import type { Assessor } from "./types";

export type { Assessor, AssessInput, AssessResult } from "./types";
export { AssessRejected } from "./types";
export { parseAssessments } from "./validate";
export { PROMPT_VERSION } from "./prompt";

/**
 * AI 評価器を作る。mock のときは null（AI を使わず、ルールベース評価だけで推薦する）。
 * モデル ID に既定値は置かない。
 */
export function createAssessor(env: BatchEnv): Assessor | null {
  if (env.AI_PROVIDER === "mock") return null;
  if (!env.BEDROCK_MODEL_ID) throw new Error("BEDROCK_MODEL_ID is required when AI_PROVIDER=bedrock");
  return new BedrockAssessor({
    modelId: env.BEDROCK_MODEL_ID,
    region: env.BEDROCK_REGION || env.AWS_REGION,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    maxRetries: env.AI_MAX_RETRIES,
    timeoutMs: env.AI_TIMEOUT_MS,
  });
}
