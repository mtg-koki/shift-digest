import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { CATEGORY_IDS } from "../../shared/schema";
import { SYSTEM_PROMPT, buildUserContent } from "./prompt";
import type { SummarizeInput, Summarizer } from "./types";

/** 構造化出力用の形だけのスキーマ。厳密な検証は呼び出し側の AiSummarySchema で行う。 */
const OutputShape = z.object({
  title_ja: z.string(),
  summary_ja: z.string(),
  category: z.enum([...CATEGORY_IDS, "out_of_scope"]),
  relevance: z.number().int(),
});

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  maxRetries: number;
  timeoutMs: number;
  effort: "low" | "medium" | "high";
  /** 安全分類器による拒否時、サーバー側で別モデルへ切り替える（beta） */
  fallbacks: "default" | "off";
}

/**
 * Claude API（公式 SDK）。ツールは渡さず、テキスト入力→JSON 出力のみ。
 * 利用料金は Claude Code の利用料金とは別の API 従量課金。
 */
export class ClaudeSummarizer implements Summarizer {
  readonly info;
  private readonly client: Anthropic;

  constructor(private readonly opts: ClaudeOptions) {
    this.info = { provider: "claude" as const, model: opts.model };
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: opts.maxRetries, timeout: opts.timeoutMs });
  }

  async summarize(input: SummarizeInput, signal: AbortSignal) {
    const res = await this.client.beta.messages.parse(
      {
        model: this.opts.model,
        max_tokens: this.opts.maxOutputTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(input) }],
        output_config: { effort: this.opts.effort, format: betaZodOutputFormat(OutputShape) },
        ...(this.opts.fallbacks === "default"
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      },
      { signal },
    );
    const usage = { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 };
    if (res.stop_reason === "refusal") {
      throw new SummarizeRejected(`refusal (${res.stop_details?.category ?? "unknown"})`, usage);
    }
    if (res.stop_reason === "max_tokens") {
      throw new SummarizeRejected("max_tokens reached", usage);
    }
    return { raw: res.parsed_output, usage };
  }
}

/** API 呼び出しは成功したが使える出力がなかった（トークンは消費済み） */
export class SummarizeRejected extends Error {
  constructor(
    message: string,
    readonly usage: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
  }
}
