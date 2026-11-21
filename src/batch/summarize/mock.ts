import type { Summarizer } from "./types";

const KEYWORDS: Array<[RegExp, string]> = [
  [/(法案|法律|規制|税|社会保障|年金|著作権|ガイドライン|省令|政令|パブリックコメント|regulat|law|tax|copyright)/i, "policy"],
  [/(雇用|採用|賃金|労働|働き方|テレワーク|求人|人材|hiring|wage|labor|workforce)/i, "employment"],
  [/(買収|出資|資本|提携|投資|事業|プラットフォーム|データセンター|計算資源|acquisition|invest|funding|platform)/i, "ownership"],
  [/(AI|人工知能|ロボット|クラウド|自動化|生成|LLM|model|robot|cloud|automation|GPU)/i, "tech"],
];

/**
 * AI を使わないモック。外部 API を呼ばず、費用は発生しない。
 * タイトル・説明文をそのまま短く使い、分類はキーワードと取得元の既定値で決める。
 */
export class MockSummarizer implements Summarizer {
  readonly info = { provider: "mock" as const, model: null };

  async summarize(input: Parameters<Summarizer["summarize"]>[0]) {
    const text = `${input.originalTitle} ${input.text}`;
    const category = KEYWORDS.find(([re]) => re.test(text))?.[1] ?? input.defaultCategory;
    const desc = input.text.length > 160 ? `${input.text.slice(0, 160)}…` : input.text;
    const summary =
      input.contentBasis === "title_only" || desc === ""
        ? "（説明文がないため、タイトルのみ取得しています）"
        : desc.replace(/https?:\/\/\S+/g, "");
    return {
      raw: {
        title_ja: input.originalTitle.slice(0, 120),
        summary_ja: summary,
        category,
        relevance: 2,
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
