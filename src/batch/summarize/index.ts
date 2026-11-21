import type { BatchEnv } from "../config";
import { AzureOpenAISummarizer } from "./azure-openai";
import { ClaudeSummarizer } from "./claude";
import { MockSummarizer } from "./mock";
import type { Summarizer } from "./types";

export type { Summarizer, SummarizeInput, SummarizeResult } from "./types";
export { SummarizeRejected } from "./claude";

function required(name: string, v: string | undefined): string {
  if (!v) throw new Error(`${name} is required for the selected AI_PROVIDER`);
  return v;
}

/** 設定でプロバイダーを選ぶ。モデル名に既定値は置かない（利用可能なものを確認して設定する）。 */
export function createSummarizer(env: BatchEnv): Summarizer {
  switch (env.AI_PROVIDER) {
    case "mock":
      return new MockSummarizer();
    case "claude":
      return new ClaudeSummarizer({
        apiKey: required("AI_API_KEY", env.AI_API_KEY),
        model: required("AI_MODEL", env.AI_MODEL),
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
        maxRetries: env.AI_MAX_RETRIES,
        timeoutMs: env.AI_TIMEOUT_MS,
        effort: env.AI_EFFORT,
        fallbacks: env.CLAUDE_FALLBACKS,
      });
    case "azure-openai":
      return new AzureOpenAISummarizer({
        endpoint: required("AZURE_OPENAI_ENDPOINT", env.AZURE_OPENAI_ENDPOINT),
        deployment: required("AZURE_OPENAI_DEPLOYMENT", env.AZURE_OPENAI_DEPLOYMENT),
        apiVersion: required("AZURE_OPENAI_API_VERSION", env.AZURE_OPENAI_API_VERSION),
        apiKey: required("AI_API_KEY", env.AI_API_KEY),
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
        maxRetries: env.AI_MAX_RETRIES,
        timeoutMs: env.AI_TIMEOUT_MS,
      });
  }
}
