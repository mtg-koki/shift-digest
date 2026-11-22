import { createHash } from "node:crypto";
import type { z } from "zod";
import { addDays, jstDate } from "../shared/date";
import {
  DailyReportSchema,
  DigestIndexSchema,
  StateSchema,
  STORAGE_KEYS,
  type Article,
  type Assessment,
  type AssessorInfo,
  type DailyReport,
  type DigestIndex,
  type LastRun,
  type SourceResult,
  type State,
  type Usage,
} from "../shared/schema";
import type { Storage } from "../shared/storage";
import { AssessRejected, parseAssessments, PROMPT_VERSION, type Assessor } from "./assess";
import { interestsHash, sourcePolicy, type BatchEnv, type Interests, type Source } from "./config";
import type { FeedFetcher } from "./feed";
import { dedupe, displayCategory, inWindow, rankRecommendations, ruleAssessment, selectForAssessment, toCandidate, type Candidate } from "./select";

export type RunOutcome =
  | { status: "ok" | "partial"; date: string; articles: number; recommendations: number; usage: Usage }
  | { status: "skipped"; date: string; reason: string }
  | { status: "failed"; date: string; reason: string };

export interface RunDeps {
  storage: Storage;
  fetcher: FeedFetcher;
  /** null ならルールベース評価（AI 不使用） */
  assessor: Assessor | null;
  sources: Source[];
  interests: Interests;
  env: BatchEnv;
  now?: () => Date;
  force?: boolean;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * ロックの有効期限。Lambda の最大実行時間（15 分）より長くし、更新（延長）は行わない。
 * 異常終了した実行のロックは期限後に次の実行が奪う。
 */
export const LOCK_TTL_SECONDS = 16 * 60;

const RULES: AssessorInfo = { provider: "rules", model: null };

async function readJson<T>(storage: Storage, key: string, schema: z.ZodType<T>): Promise<T | null> {
  const text = await storage.getText(key);
  if (text === null) return null;
  return schema.parse(JSON.parse(text));
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const emptyUsage = (): Usage => ({ aiCalls: 0, aiArticles: 0, inputTokens: 0, outputTokens: 0 });

async function loadState(storage: Storage, log: NonNullable<RunDeps["log"]>): Promise<State> {
  const text = await storage.getText(STORAGE_KEYS.state);
  if (text === null) return { schemaVersion: 2, items: {}, usageByDate: {} };
  const raw = JSON.parse(text) as { schemaVersion?: number };
  if (raw.schemaVersion !== 2) {
    // 旧形式（ニュース要約版）の state。記事の扱いが異なるため引き継がない
    log("state has an old schema; starting fresh", { schemaVersion: raw.schemaVersion });
    return { schemaVersion: 2, items: {}, usageByDate: {} };
  }
  return StateSchema.parse(raw);
}

/** 評価の前提。タイトル・関心テーマ・評価器（モデル）・プロンプト版のどれかが変われば再評価する */
export function assessmentKey(c: Pick<Candidate, "titleKey">, interests: Interests, assessor: AssessorInfo): string {
  return createHash("sha256")
    .update([c.titleKey, interestsHash(interests), assessor.provider, assessor.model ?? "", PROMPT_VERSION].join("\n"))
    .digest("hex")
    .slice(0, 24);
}

/**
 * 日次バッチ本体。
 * 書き込み順: state（評価キャッシュ） → report → 読み戻し検証 → index → last-run
 * index（latest 参照）は report の検証後にしか更新しないため、途中で失敗しても前回の正常データが表示され続ける。
 */
export async function runDaily(deps: RunDeps): Promise<RunOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const date = jstDate(now);
  const log = deps.log ?? ((m, e) => console.log(JSON.stringify({ msg: m, ...e })));
  const { storage } = deps;

  const lock = await storage.tryLock(STORAGE_KEYS.lock, LOCK_TTL_SECONDS);
  if (!lock) {
    log("another run is in progress; skipping");
    return { status: "skipped", date, reason: "locked" };
  }
  try {
    const outcome = await runLocked(deps, now, date, log);
    await writeLastRun(storage, { schemaVersion: 2, at: new Date().toISOString(), date, status: outcome.status, message: "reason" in outcome ? outcome.reason : undefined });
    return outcome;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log("run failed", { error: reason });
    await writeLastRun(storage, { schemaVersion: 2, at: new Date().toISOString(), date, status: "failed", message: reason.slice(0, 300) }).catch(() => undefined);
    return { status: "failed", date, reason };
  } finally {
    await lock.release();
  }
}

async function writeLastRun(storage: Storage, lr: LastRun) {
  await storage.putText(STORAGE_KEYS.lastRun, json(lr));
}

async function runLocked(deps: RunDeps, now: Date, date: string, log: NonNullable<RunDeps["log"]>): Promise<RunOutcome> {
  const { storage, env, interests } = deps;
  // 実行時間の上限は実時計で測る（now は日付計算用で、テストでは固定値になる）
  const deadline = Date.now() + env.BATCH_MAX_RUNTIME_MS;

  // 1. 当日分が既にあれば何もしない（再実行の冪等性）。force 時のみ作り直す（評価はキャッシュを再利用）
  if ((await storage.getText(STORAGE_KEYS.report(date))) !== null && !deps.force) {
    log("report already exists; skipping", { date });
    return { status: "skipped", date, reason: "already-exists" };
  }
  const state = await loadState(storage, log);

  // 2. 情報源ごとの処理可否（未確認は許可と扱わない）
  const policies = new Map(deps.sources.map((s) => [s.id, sourcePolicy(s)]));
  const targets = deps.sources.filter((s) => policies.get(s.id)!.fetch);
  for (const s of deps.sources) {
    const p = policies.get(s.id)!;
    if (!p.fetch) log("source not fetched (terms/enabled)", { source: s.id, reasons: p.reasons });
    else if (!p.ai) log("source not sent to AI (terms)", { source: s.id, reasons: p.reasons });
  }

  // 3. 取得（一部失敗は許容）
  const sourceResults: SourceResult[] = [];
  const candidates: Candidate[] = [];
  let fetchedItems = 0;
  const settled = await Promise.allSettled(
    targets.map((s) =>
      deps.fetcher(s, {
        timeoutMs: env.FEED_TIMEOUT_MS,
        maxBytes: env.FEED_MAX_BYTES,
        maxRedirects: env.FEED_MAX_REDIRECTS,
        userAgent: env.FEED_USER_AGENT,
        allowFileFeeds: env.ALLOW_FILE_FEEDS,
      }),
    ),
  );
  settled.forEach((r, i) => {
    const source = targets[i]!;
    const attribution = source.terms.attribution;
    if (r.status === "rejected") {
      const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
      log("source failed", { source: source.id, error });
      sourceResults.push({ id: source.id, name: source.name, ok: false, itemCount: 0, error: error.slice(0, 200), attribution });
      return;
    }
    const items = r.value.slice(0, source.maxItems ?? env.MAX_ITEMS_PER_SOURCE);
    fetchedItems += items.length;
    sourceResults.push({ id: source.id, name: source.name, ok: true, itemCount: items.length, attribution });
    for (const it of items) {
      if (!inWindow(it.publishedAt, now, env.LOOKBACK_HOURS, env.INCLUDE_UNDATED)) continue;
      const c = toCandidate(it, source, policies.get(source.id)!.ai);
      if (c) candidates.push(c);
    }
  });
  const okCount = sourceResults.filter((s) => s.ok).length;
  if (targets.length > 0 && okCount === 0) {
    // 全取得失敗。正常な 0 件とは区別し、index は更新しない
    throw new Error("all sources failed");
  }

  // 4. 重複除去（保守的）。今日初めて見つかった記事だけを新着とする（過去日に見つかった記事は再掲・再評価しない）
  const fresh = dedupe(candidates).filter((c) => {
    const seen = state.items[c.id];
    return !seen || seen.firstSeenDate === date;
  });
  for (const c of fresh) {
    const prev = state.items[c.id];
    state.items[c.id] = {
      url: c.normalizedUrl,
      title: c.title,
      sourceId: c.source.id,
      firstSeenAt: prev?.firstSeenAt ?? now.toISOString(),
      firstSeenDate: prev?.firstSeenDate ?? date,
      assessment: prev?.assessment,
      assessmentKey: prev?.assessmentKey,
    };
  }

  // 5. 評価（AI 送信が許可された情報源だけ。評価済みで前提が同じならキャッシュを使う）
  const assessorInfo = deps.assessor?.info ?? RULES;
  const keyOf = (c: Candidate) => assessmentKey(c, interests, assessorInfo);
  const needs = (c: Candidate) => state.items[c.id]?.assessmentKey !== keyOf(c);
  const usage: Usage = { ...emptyUsage(), ...state.usageByDate[date] };
  const runUsage = emptyUsage();

  if (!deps.assessor) {
    // ルールベース（AI 不使用）
    for (const c of fresh.filter((x) => x.aiEligible && !x.duplicateOf && needs(x))) {
      state.items[c.id]!.assessment = { ...ruleAssessment(c, interests, now.toISOString()), assessor: RULES };
      state.items[c.id]!.assessmentKey = keyOf(c);
    }
  } else {
    const remaining = Math.max(0, env.MAX_AI_ARTICLES_PER_DAY - usage.aiArticles);
    const selected = selectForAssessment(fresh, {
      interests,
      now,
      lookbackHours: env.LOOKBACK_HOURS,
      limit: remaining,
      perSource: env.MAX_AI_ARTICLES_PER_SOURCE,
      needsAssessment: needs,
    });
    const labels = interests.themes.map((t) => t.label);
    for (let i = 0; i < selected.length; i += env.AI_BATCH_SIZE) {
      if (Date.now() > deadline) {
        log("runtime limit reached; stop assessing");
        break;
      }
      const chunk = selected.slice(i, i + env.AI_BATCH_SIZE);
      for (const u of [usage, runUsage]) {
        u.aiCalls++;
        u.aiArticles += chunk.length;
      }
      const add = (t: { inputTokens: number; outputTokens: number }) => {
        for (const u of [usage, runUsage]) {
          u.inputTokens += t.inputTokens;
          u.outputTokens += t.outputTokens;
        }
      };
      try {
        const res = await deps.assessor.assess(
          chunk.map((c) => ({ articleId: c.id, title: c.title, sourceName: c.source.name, publishedAt: c.publishedAt })),
          labels,
          AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
        );
        add(res.usage);
        const { accepted, rejected } = parseAssessments(res.raw, new Set(chunk.map((c) => c.id)));
        if (rejected.length) log("AI output partly rejected", { rejected: rejected.slice(0, 5) });
        const at = new Date().toISOString();
        for (const c of chunk) {
          const a = accepted.get(c.id);
          if (!a) continue;
          state.items[c.id]!.assessment = {
            category: a.category,
            relevanceScore: a.relevanceScore,
            reason: a.reason,
            assessmentBasis: "metadata_only",
            assessor: deps.assessor.info,
            assessedAt: at,
          };
          state.items[c.id]!.assessmentKey = keyOf(c);
        }
        log("AI assessed", { requested: chunk.length, accepted: accepted.size, usage: res.usage });
      } catch (e) {
        if (e instanceof AssessRejected) add(e.usage);
        log("AI assessment failed; skipped", { requested: chunk.length, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  state.usageByDate[date] = usage;
  pruneState(state, date, env.STATE_RETENTION_DAYS);
  // 評価結果を先に保存（後続が失敗しても再実行で再評価しない）
  await storage.putText(STORAGE_KEYS.state, json(StateSchema.parse(state)));

  // 6. 新着一覧と今日の読む候補
  const fetchedAt = now.toISOString();
  const withAssessment = fresh.map((c) => {
    const s = state.items[c.id];
    const assessment: Assessment | undefined = s?.assessmentKey === keyOf(c) ? s.assessment : undefined;
    return { c, assessment };
  });
  const ranked = rankRecommendations(withAssessment, {
    interests,
    now,
    lookbackHours: env.LOOKBACK_HOURS,
    max: env.MAX_RECOMMENDATIONS,
    perSource: env.MAX_RECOMMENDATIONS_PER_SOURCE,
    minScore: env.MIN_RELEVANCE_SCORE,
  });
  const articles: Article[] = withAssessment.map(({ c, assessment }) => ({
    id: c.id,
    title: c.title,
    url: c.url,
    sourceId: c.source.id,
    sourceName: c.source.name,
    publishedAt: c.publishedAt,
    fetchedAt,
    feedCategories: c.feedCategories,
    category: displayCategory(c, assessment),
    ...(c.duplicateOf ? { duplicateOf: c.duplicateOf } : {}),
    aiEligible: c.aiEligible,
    ...(assessment ? { assessment } : {}),
  }));

  const status = okCount === targets.length ? "ok" : "partial";
  const report: DailyReport = DailyReportSchema.parse({
    schemaVersion: 2,
    date,
    generatedAt: new Date().toISOString(),
    status,
    recommendations: ranked.map((r) => ({ articleId: r.c.id, rankScore: r.rankScore })),
    articles,
    sources: sourceResults,
    interests: interests.themes.map((t) => t.label),
    stats: { fetchedItems, newArticles: articles.length, usage: runUsage },
  });

  // 7. report を保存し、読み戻して検証
  const reportKey = STORAGE_KEYS.report(date);
  await storage.putText(reportKey, json(report));
  const verify = await readJson(storage, reportKey, DailyReportSchema);
  if (!verify || verify.articles.length !== report.articles.length) throw new Error("report verification failed");

  // 8. 最後に latest 参照（index）を更新（旧形式の index は引き継がない）
  const prev = await readJson(storage, STORAGE_KEYS.index, DigestIndexSchema).catch(() => null);
  const dates = (prev?.dates ?? []).filter((d) => d.date !== date);
  dates.push({ date, articleCount: articles.length, recommendationCount: ranked.length, status, generatedAt: report.generatedAt });
  dates.sort((a, b) => b.date.localeCompare(a.date));
  const index: DigestIndex = DigestIndexSchema.parse({ schemaVersion: 2, latestDate: dates[0]!.date, lastSuccessAt: report.generatedAt, dates });
  await storage.putText(STORAGE_KEYS.index, json(index));

  log("run completed", { date, status, articles: articles.length, recommendations: ranked.length, usage: runUsage });
  return { status, date, articles: articles.length, recommendations: ranked.length, usage: runUsage };
}

function pruneState(state: State, date: string, retentionDays: number) {
  const cutoff = addDays(date, -retentionDays);
  for (const [id, item] of Object.entries(state.items)) {
    if (item.firstSeenDate < cutoff) delete state.items[id];
  }
  for (const d of Object.keys(state.usageByDate)) if (d < cutoff) delete state.usageByDate[d];
}
