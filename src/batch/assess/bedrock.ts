import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { SYSTEM_PROMPT, buildUserContent } from "./prompt";
import { AssessRejected, type AssessInput, type Assessor } from "./types";

export interface BedrockOptions {
  /** モデル ID または推論プロファイル ID */
  modelId: string;
  region?: string;
  maxOutputTokens: number;
  maxRetries: number;
  timeoutMs: number;
}

/** モデルの出力テキストから JSON オブジェクトを取り出す（形の正しさは parseAssessments で判断） */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Amazon Bedrock Converse API。認証は Lambda 実行ロール（固定アクセスキーは使わない）。
 * ツール（toolConfig）は渡さない。テキスト入力 → JSON テキスト出力のみ。
 */
export class BedrockAssessor implements Assessor {
  readonly info;
  private readonly client: Pick<BedrockRuntimeClient, "send">;

  constructor(
    private readonly opts: BedrockOptions,
    client?: Pick<BedrockRuntimeClient, "send">,
  ) {
    this.info = { provider: "bedrock" as const, model: opts.modelId };
    this.client =
      client ??
      new BedrockRuntimeClient({
        region: opts.region,
        // SDK の再試行（スロットリング・5xx のみ。指数バックオフ）。初回を含む試行回数
        maxAttempts: opts.maxRetries + 1,
        requestHandler: { requestTimeout: opts.timeoutMs, connectionTimeout: 5000 },
      });
  }

  async assess(items: AssessInput[], interestLabels: string[], signal: AbortSignal) {
    const res: ConverseCommandOutput = await this.client.send(
      new ConverseCommand({
        modelId: this.opts.modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content: [{ text: buildUserContent(items, interestLabels) }] }],
        inferenceConfig: { maxTokens: this.opts.maxOutputTokens, temperature: 0 },
      }),
      { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs * (this.opts.maxRetries + 1))]) },
    );
    const usage = { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 };
    if (res.stopReason === "max_tokens") throw new AssessRejected("max_tokens reached", usage);
    if (res.stopReason === "guardrail_intervened" || res.stopReason === "content_filtered") {
      throw new AssessRejected(`stopped: ${res.stopReason}`, usage);
    }
    const text = (res.output?.message?.content ?? []).map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("");
    return { raw: extractJson(text), usage };
  }
}
