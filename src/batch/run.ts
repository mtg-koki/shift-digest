import type { z } from "zod";
import { addDays, jstDate } from "../shared/date";
import {
  AiSummarySchema,
  DailyReportSchema,
  DigestIndexSchema,
  StateSchema,
  STORAGE_KEYS,
  type AiSummary,
  type Article,
  type DailyReport,
  type DigestIndex,
  type LastRun,
  type SourceResult,
  type State,
  type SummarizerInfo,
  type Usage,
} from "../shared/schema";
import type { Storage } from "../shared/storage";
import { titleKey } from "../shared/url";
import type { BatchEnv, Source } from "./config";
import type { FeedFetcher } from "./feed";
import { dedupe, inWindow, isSimilarTitle, sortCandidates, toCandidate, type Candidate } from "./select";
import { SummarizeRejected, type Summarizer } from "./summarize";

export type RunOutcome =
  | { status: "ok" | "partial"; date: string; published: number; usage: Usage }
  | { status: "skipped"; date: string; reason: string }
  | { status: "failed"; date: string; reason: string };

export interface RunDeps {
  storage: Storage;
  fetcher: FeedFetcher;
  summarizer: Summarizer;
  sources: Source[];
  env: BatchEnv;
  now?: () => Date;
  force?: boolean;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

type Limits = Pick<
  BatchEnv,
  | "MAX_AI_ARTICLES_PER_DAY"
  | "MAX_PUBLISHED_ARTICLES"
  | "MIN_RELEVANCE"
  | "LOOKBACK_HOURS"
  | "MAX_ITEMS_PER_SOURCE"
  | "AI_MAX_INPUT_CHARS"
  | "BATCH_MAX_RUNTIME_MS"
  | "STATE_RETENTION_DAYS"
  | "FEED_TIMEOUT_MS"
  | "FEED_MAX_BYTES"
  | "FEED_USER_AGENT"
>;

const RECENT_DUP_DAYS = 7;

async function readJson<T>(storage: Storage, key: string, schema: z.ZodType<T>): Promise<T | null> {
  const text = await storage.getText(key);
  if (text === null) return null;
  return schema.parse(JSON.parse(text));
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

function emptyState(): State {
  return { schemaVersion: 1, items: {}, usageByDate: {} };
}

/**
 * 日次バッチ本体。
 * 書き込み順: state(要約キャッシュ) → report → 読み戻し検証 → state(掲載済み) → index → last-run
 * index（latest 参照）は report の検証後にしか更新しないため、途中で失敗しても前回の正常データが表示され続ける。
 */
export async function runDaily(deps: RunDeps): Promise<RunOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const date = jstDate(now);
  const log = deps.log ?? ((m, e) => console.log(JSON.stringify({ msg: m, ...e })));
  const { storage } = deps;

  const lock = await storage.tryLock(STORAGE_KEYS.lock, 60);
  if (!lock) {
    log("another run is in progress; skipping");
    return { status: "skipped", date, reason: "locked" };
  }
  try {
    const outcome = await runLocked(deps, now, date, log);
    await writeLastRun(storage, {
      schemaVersion: 1,
      at: new Date().toISOString(),
      date,
      status: outcome.status,
      message: "reason" in outcome ? outcome.reason : undefined,
    });
    return outcome;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log("run failed", { error: reason });
    await writeLastRun(storage, { schemaVersion: 1, at: new Date().toISOString(), date, status: "failed", message: reason }).catch(
      () => undefined,
    );
    return { status: "failed", date, reason };
  } finally {
    await lock.release();
  }
}

async function writeLastRun(storage: Storage, lr: LastRun) {
  await storage.putText(STORAGE_KEYS.lastRun, json(lr));
}

async function runLocked(
  deps: RunDeps,
  now: Date,
  date: string,
  log: NonNullable<RunDeps["log"]>,
): Promise<RunOutcome> {
  const { storage, env, summarizer } = deps;
  const limits: Limits = env;
  // 実行時間の上限は実時計で測る（now は日付計算用で、テストでは固定値になる）
  const deadline = Date.now() + limits.BATCH_MAX_RUNTIME_MS;

  // 1. 当日分が既にあれば何もしない（再実行の冪等性）。--force 時のみ作り直す。
  const existing = await storage.getText(STORAGE_KEYS.report(date));
  if (existing !== null && !deps.force) {
    log("report already exists; skipping", { date });
    return { status: "skipped", date, reason: "already-exists" };
  }

  const state = (await readJson(storage, STORAGE_KEYS.state, StateSchema)) ?? emptyState();

  // 2. 取得（一部失敗は許容）
  const sourceResults: SourceResult[] = [];
  const candidates: Candidate[] = [];
  let fetchedItems = 0;
  const settled = await Promise.allSettled(
    deps.sources.map((s) =>
      deps.fetcher(s, { timeoutMs: limits.FEED_TIMEOUT_MS, maxBytes: limits.FEED_MAX_BYTES, userAgent: limits.FEED_USER_AGENT }),
    ),
  );
  settled.forEach((r, i) => {
    const source = deps.sources[i]!;
    if (r.status === "rejected") {
      const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
      log("source failed", { source: source.id, error });
      sourceResults.push({ id: source.id, name: source.name, ok: false, itemCount: 0, error: error.slice(0, 200) });
      return;
    }
    const items = r.value.slice(0, source.maxItems ?? limits.MAX_ITEMS_PER_SOURCE);
    fetchedItems += items.length;
    sourceResults.push({ id: source.id, name: source.name, ok: true, itemCount: items.length });
    for (const it of items) {
      if (!inWindow(it.publishedAt, now, limits.LOOKBACK_HOURS)) continue;
      const c = toCandidate(it, source);
      if (c) candidates.push(c);
    }
  });

  const okCount = sourceResults.filter((s) => s.ok).length;
  if (deps.sources.length > 0 && okCount === 0) {
    // 全取得失敗。正常な 0 件とは区別し、index は更新しない
    throw new Error("all sources failed");
  }

  // 3. 既出（過去日に掲載済み）・直近掲載と同じニュースを除外
  const recentFrom = addDays(date, -RECENT_DUP_DAYS);
  const recentTitles = Object.values(state.items)
    .filter((s) => s.reportDate && s.reportDate !== date && s.reportDate >= recentFrom && s.titleKey)
    .map((s) => s.titleKey!);
  const fresh = dedupe(sortCandidates(candidates)).filter((c) => {
    const seen = state.items[c.id];
    if (seen?.reportDate && seen.reportDate !== date) return false;
    return !recentTitles.some((t) => isSimilarTitle(t, c.titleKey));
  });

  // 4. 要約（キャッシュ優先。AI 呼び出しは日付ごとに上限）
  const usage: Usage = state.usageByDate[date] ?? { aiCalls: 0, inputTokens: 0, outputTokens: 0 };
  const runUsage: Usage = { aiCalls: 0, inputTokens: 0, outputTokens: 0 };
  const summarized: Array<{ c: Candidate; summary: AiSummary; info: SummarizerInfo; truncated: boolean }> = [];
  for (const c of fresh) {
    const cached = state.items[c.id];
    const truncated = c.description.length > limits.AI_MAX_INPUT_CHARS;
    if (cached?.summary && cached.summarizer) {
      summarized.push({ c, summary: cached.summary, info: cached.summarizer, truncated });
      continue;
    }
    if (usage.aiCalls >= limits.MAX_AI_ARTICLES_PER_DAY) continue;
    if (Date.now() > deadline) {
      log("runtime limit reached; stop summarizing");
      break;
    }
    usage.aiCalls++;
    runUsage.aiCalls++;
    try {
      const res = await summarizer.summarize(
        {
          sourceName: c.source.name,
          originalTitle: c.title,
          publishedAt: c.publishedAt,
          contentBasis: c.contentBasis,
          text: c.description.slice(0, limits.AI_MAX_INPUT_CHARS),
          defaultCategory: c.source.defaultCategory,
        },
        AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      );
      addUsage(usage, runUsage, res.usage);
      const parsed = AiSummarySchema.safeParse(res.raw);
      if (!parsed.success) {
        log("invalid AI output; skipped", { id: c.id, issues: parsed.error.issues.map((i) => i.message).slice(0, 3) });
        continue;
      }
      state.items[c.id] = {
        url: c.normalizedUrl,
        firstSeenAt: state.items[c.id]?.firstSeenAt ?? now.toISOString(),
        reportDate: state.items[c.id]?.reportDate ?? null,
        summary: parsed.data,
        summarizer: summarizer.info,
        titleKey: c.titleKey,
      };
      summarized.push({ c, summary: parsed.data, info: summarizer.info, truncated });
    } catch (e) {
      if (e instanceof SummarizeRejected) addUsage(usage, runUsage, e.usage);
      log("summarize failed; skipped", { id: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  state.usageByDate[date] = usage;
  pruneState(state, date, limits.STATE_RETENTION_DAYS);
  // 要約結果を先に保存（後続が失敗しても再実行で再要約しない）
  await storage.putText(STORAGE_KEYS.state, json(StateSchema.parse(state)));

  // 5. 掲載記事の選定
  const ranked = summarized
    .filter((s) => s.summary.category !== "out_of_scope" && s.summary.relevance >= limits.MIN_RELEVANCE)
    .sort(
      (a, b) =>
        b.summary.relevance - a.summary.relevance ||
        a.c.source.priority - b.c.source.priority ||
        (b.c.publishedAt ?? "").localeCompare(a.c.publishedAt ?? ""),
    );
  const picked: typeof ranked = [];
  for (const s of ranked) {
    if (picked.length >= limits.MAX_PUBLISHED_ARTICLES) break;
    if (picked.some((p) => isSimilarTitle(titleKey(p.summary.title_ja), titleKey(s.summary.title_ja)))) continue;
    picked.push(s);
  }

  const fetchedAt = now.toISOString();
  const articles: Article[] = picked.map(({ c, summary, info, truncated }) => ({
    id: c.id,
    titleJa: summary.title_ja,
    summaryJa: summary.summary_ja,
    category: summary.category as Article["category"],
    originalTitle: c.title,
    sourceId: c.source.id,
    sourceName: c.source.name,
    url: c.url,
    publishedAt: c.publishedAt,
    fetchedAt,
    contentBasis: c.contentBasis,
    inputTruncated: truncated,
    summarizer: info,
  }));

  const status = okCount === deps.sources.length ? "ok" : "partial";
  const report: DailyReport = DailyReportSchema.parse({
    schemaVersion: 1,
    date,
    generatedAt: new Date().toISOString(),
    status,
    articles,
    sources: sourceResults,
    stats: { fetchedItems, candidates: fresh.length, usage: runUsage },
  });

  // 6. report を保存し、読み戻して検証
  const reportKey = STORAGE_KEYS.report(date);
  await storage.putText(reportKey, json(report));
  const verify = await readJson(storage, reportKey, DailyReportSchema);
  if (!verify || verify.articles.length !== report.articles.length) throw new Error("report verification failed");

  // 7. 掲載済みを state に記録（--force で外れた記事は未掲載に戻す）
  const pickedIds = new Set(articles.map((a) => a.id));
  for (const [id, item] of Object.entries(state.items)) {
    if (item.reportDate === date && !pickedIds.has(id)) item.reportDate = null;
  }
  for (const a of picked) {
    const item = state.items[a.c.id];
    if (item) item.reportDate = date;
    else
      state.items[a.c.id] = {
        url: a.c.normalizedUrl,
        firstSeenAt: now.toISOString(),
        reportDate: date,
        summary: a.summary,
        summarizer: a.info,
        titleKey: a.c.titleKey,
      };
  }
  await storage.putText(STORAGE_KEYS.state, json(StateSchema.parse(state)));

  // 8. 最後に latest 参照（index）を更新
  const prev = await readJson(storage, STORAGE_KEYS.index, DigestIndexSchema).catch(() => null);
  const dates = (prev?.dates ?? []).filter((d) => d.date !== date);
  dates.push({ date, articleCount: articles.length, status, generatedAt: report.generatedAt });
  dates.sort((a, b) => b.date.localeCompare(a.date));
  const index: DigestIndex = DigestIndexSchema.parse({
    schemaVersion: 1,
    latestDate: dates[0]!.date,
    lastSuccessAt: report.generatedAt,
    dates,
  });
  await storage.putText(STORAGE_KEYS.index, json(index));

  log("run completed", { date, status, published: articles.length, candidates: fresh.length, usage: runUsage });
  return { status, date, published: articles.length, usage: runUsage };
}

function addUsage(day: Usage, run: Usage, u: { inputTokens: number; outputTokens: number }) {
  day.inputTokens += u.inputTokens;
  day.outputTokens += u.outputTokens;
  run.inputTokens += u.inputTokens;
  run.outputTokens += u.outputTokens;
}

function pruneState(state: State, date: string, retentionDays: number) {
  const cutoff = addDays(date, -retentionDays);
  for (const [id, item] of Object.entries(state.items)) {
    if (item.firstSeenAt.slice(0, 10) < cutoff) delete state.items[id];
  }
  for (const d of Object.keys(state.usageByDate)) if (d < cutoff) delete state.usageByDate[d];
}
