import type { ContentBasis, SummarizerInfo } from "../../shared/schema";

export interface SummarizeInput {
  sourceName: string;
  originalTitle: string;
  publishedAt: string | null;
  contentBasis: ContentBasis;
  /** 入力上限で切り詰め済みのテキスト（説明文。なければ空） */
  text: string;
  defaultCategory: string;
}

export interface SummarizeResult {
  /** 未検証の出力。呼び出し側で AiSummarySchema により検証する */
  raw: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Summarizer {
  readonly info: SummarizerInfo;
  summarize(input: SummarizeInput, signal: AbortSignal): Promise<SummarizeResult>;
}
