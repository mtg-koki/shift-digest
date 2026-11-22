import type { AssessorInfo } from "../../shared/schema";

/** AI に渡す情報（これ以外は渡さない。URL・本文・説明文は渡さない） */
export interface AssessInput {
  articleId: string;
  title: string;
  sourceName: string;
  /** 存在する場合のみ */
  publishedAt: string | null;
}

export interface AssessResult {
  /** 未検証の出力。呼び出し側で parseAssessments により検証する */
  raw: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Assessor {
  readonly info: AssessorInfo;
  assess(items: AssessInput[], interestLabels: string[], signal: AbortSignal): Promise<AssessResult>;
}

/** API 呼び出しは成功したが使える出力がなかった（トークンは消費済み） */
export class AssessRejected extends Error {
  constructor(
    message: string,
    readonly usage: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
  }
}
