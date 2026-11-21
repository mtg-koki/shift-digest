import { SYSTEM_PROMPT, buildUserContent } from "./prompt";
import type { SummarizeInput, Summarizer } from "./types";

export interface AzureOpenAIOptions {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  apiKey: string;
  maxOutputTokens: number;
  maxRetries: number;
  timeoutMs: number;
}

/**
 * Azure OpenAI（Chat Completions, REST）。
 * 注意: 実環境では未検証。デプロイ名・API バージョン・パラメーター対応は
 * 利用するモデルの公式ドキュメントで確認してから使うこと。
 */
export class AzureOpenAISummarizer implements Summarizer {
  readonly info;

  constructor(private readonly opts: AzureOpenAIOptions) {
    this.info = { provider: "azure-openai" as const, model: opts.deployment };
  }

  async summarize(input: SummarizeInput, signal: AbortSignal) {
    const url = `${this.opts.endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(
      this.opts.deployment,
    )}/chat/completions?api-version=${encodeURIComponent(this.opts.apiVersion)}`;
    const body = JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserContent(input) },
      ],
      max_completion_tokens: this.opts.maxOutputTokens,
      response_format: { type: "json_object" },
    });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": this.opts.apiKey },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)]),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = json.choices?.[0]?.message?.content ?? "";
        let raw: unknown = null;
        try {
          raw = JSON.parse(content);
        } catch {
          raw = null;
        }
        return {
          raw,
          usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
        };
      } catch (e) {
        lastErr = e;
        if ((e as { fatal?: boolean }).fatal || signal.aborted) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastErr;
  }
}
