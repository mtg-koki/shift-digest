import { createHash } from "node:crypto";
import type { z } from "zod";
import { addDays, jstDate } from "../shared/date";
import {
  DailyReportSchema,
  DigestIndexSchema,
  FeedSnapshotSchema,
  StateSchema,
  STORAGE_KEYS,
  type Article,
  type Assessment,
  type AssessorInfo,
  type DailyReport,
  type DigestIndex,
  type FeedSnapshot,
  type LastRun,
  type SourceFetchState,
  type SourceResult,
  type SourceStatus,
  type State,
  type Usage,
} from "../shared/schema";
import type { Storage } from "../shared/storage";
import { titleKey } from "../shared/url";
import { AssessRejected, parseAssessments, PROMPT_VERSION, type Assessor } from "./assess";
import { defaultCategory, interestsHash, sourcePolicy, type BatchEnv, type Interests, type ManualLink, type Source } from "./config";
import type { FeedFetcher } from "./feed";
import { dedupe, displayCategory, inWindow, keywordMatches, rankRecommendations, ruleAssessment, selectForAssessment, toCandidate, type Candidate } from "./select";

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
  /** RSS のない媒体の手動リンク（画面に並べるだけ） */
  manualLinks?: ManualLink[];
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
  if (text === null) return { schemaVersion: 2, items: {}, usageByDate: {}, sources: {} };
  const raw = JSON.parse(text) as { schemaVersion?: number };
  if (raw.schemaVersion !== 2) {
    // 旧形式（ニュース要約版）の state。記事の扱いが異なるため引き継がない
    log("state has an old schema; starting fresh", { schemaVersion: raw.schemaVersion });
    return { schemaVersion: 2, items: {}, usageByDate: {}, sources: {} };
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
 * バッチ本体（1 日に複数回実行してよい）。
 * 毎回、取得して一覧（feed.json）を更新し、当日分（読む候補・その日の新着）は同じ日の前回分に追記して作り直す。
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

  // 1. 同じ日に既に実行していれば、その日の新着を引き継ぐ（条件付き GET で 304 の情報源の記事も当日分に残す）。
  //    同じ記事は評価キャッシュを使うため、何度実行しても AI 呼び出しは増えず、日次上限も守られる
  const state = await loadState(storage, log);
  const prevReport = await readJson(storage, STORAGE_KEYS.report(date), DailyReportSchema).catch(() => null);

  // 2. 情報源ごとの処理可否（未確認・ユーザー確認待ちは許可と扱わない）
  const policies = new Map(deps.sources.map((s) => [s.id, sourcePolicy(s)]));
  const targets = deps.sources.filter((s) => policies.get(s.id)!.fetch);
  for (const s of deps.sources) {
    const p = policies.get(s.id)!;
    if (!p.fetch) log("source not fetched (terms/enabled)", { source: s.id, reasons: p.reasons });
    else if (!p.ai) log("source not sent to AI (terms)", { source: s.id, reasons: p.reasons });
  }

  // 3. 取得（一部失敗は許容）。条件付き GET で変更がなければ本文を受け取らない。取得間隔の下限があれば守る
  //    force: 条件付き GET と取得間隔を使わずに全件取り直す
  const nowIso = now.toISOString();
  const sourceResults: SourceResult[] = [];
  const lastResult = new Map<string, SourceStatus["lastResult"]>();
  const candidates: Candidate[] = [];
  let fetchedItems = 0;
  const fetchState = (s: Source): SourceFetchState => {
    const prev = state.sources[s.id];
    // 取得先が変わったら検証値は使わない
    return prev && prev.feedUrl === s.feedUrl ? prev : { feedUrl: s.feedUrl, lastSuccessAt: prev?.lastSuccessAt };
  };
  const due = targets.filter((s) => {
    const last = state.sources[s.id]?.lastAttemptAt;
    if (deps.force || !s.minFetchIntervalHours || !last) return true;
    const ok = now.getTime() - Date.parse(last) >= s.minFetchIntervalHours * 3600_000;
    if (!ok) {
      lastResult.set(s.id, "skipped-interval");
      sourceResults.push({ id: s.id, name: s.name, ok: true, itemCount: 0, attribution: s.attributionText || undefined });
      log("source skipped (min fetch interval)", { source: s.id });
    }
    return ok;
  });
  const settled = await Promise.allSettled(
    due.map((s) => {
      const prev = fetchState(s);
      return deps.fetcher(
        s,
        {
          timeoutMs: env.FEED_TIMEOUT_MS,
          maxBytes: env.FEED_MAX_BYTES,
          maxRedirects: env.FEED_MAX_REDIRECTS,
          userAgent: env.FEED_USER_AGENT,
          allowFileFeeds: env.ALLOW_FILE_FEEDS,
        },
        deps.force ? undefined : { etag: prev.etag, lastModified: prev.lastModified },
      );
    }),
  );
  settled.forEach((r, i) => {
    const source = due[i]!;
    const attribution = source.attributionText || undefined;
    const prev = fetchState(source);
    if (r.status === "rejected") {
      const error = (r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 200);
      log("source failed", { source: source.id, error });
      sourceResults.push({ id: source.id, name: source.name, ok: false, itemCount: 0, error, attribution });
      state.sources[source.id] = { ...prev, feedUrl: source.feedUrl, lastAttemptAt: nowIso, lastError: error };
      lastResult.set(source.id, "failed");
      return;
    }
    const res = r.value;
    const base = { feedUrl: source.feedUrl, etag: res.validators.etag, lastModified: res.validators.lastModified, lastAttemptAt: nowIso, lastSuccessAt: nowIso };
    if (res.notModified) {
      sourceResults.push({ id: source.id, name: source.name, ok: true, itemCount: 0, attribution });
      state.sources[source.id] = { ...base, lastItemCount: prev.lastItemCount };
      lastResult.set(source.id, "not-modified");
      return;
    }
    const items = res.items.slice(0, source.maxItems ?? env.MAX_ITEMS_PER_SOURCE);
    fetchedItems += items.length;
    sourceResults.push({ id: source.id, name: source.name, ok: true, itemCount: items.length, attribution });
    state.sources[source.id] = { ...base, lastItemCount: items.length };
    lastResult.set(source.id, "updated");
    const retentionHours = (source.retentionDays ?? env.FEED_RETENTION_DAYS) * 24;
    for (const it of items) {
      // 一覧は保存期間内の記事（公開日時がない記事も載せる）。読む候補・AI 評価の対象期間は後段で絞る
      if (!inWindow(it.publishedAt, now, retentionHours, true)) continue;
      const c = toCandidate(it, source, policies.get(source.id)!.ai);
      if (c) candidates.push(c);
    }
  });
  const okCount = sourceResults.filter((s) => s.ok).length;
  if (targets.length > 0 && okCount === 0) {
    // 全取得失敗。正常な 0 件とは区別し、index・一覧は更新しない（取得状態だけ保存する）
    await storage.putText(STORAGE_KEYS.state, json(StateSchema.parse(state)));
    throw new Error("all sources failed");
  }

  // 4. 同じ日の前回の新着を引き継ぐ（取得対象から外れた情報源の記事は除く）
  const fetchable = new Map(targets.map((s) => [s.id, s]));
  const prevFetchedAt = new Map<string, string>();
  const carried: Candidate[] = [];
  for (const a of prevReport?.articles ?? []) {
    const src = fetchable.get(a.sourceId);
    if (!src) continue;
    prevFetchedAt.set(a.id, a.fetchedAt);
    carried.push({
      id: a.id,
      normalizedUrl: state.items[a.id]?.url ?? a.url,
      url: a.url,
      title: a.title,
      titleKey: titleKey(a.title),
      publishedAt: a.publishedAt,
      feedCategories: a.feedCategories,
      source: src,
      aiEligible: policies.get(src.id)!.ai,
    });
  }

  // 5. 重複除去（保守的）。今日初めて見つかった記事だけを新着とする（過去日に見つかった記事は再掲・再評価しない）
  const fresh = dedupe([...candidates, ...carried]).filter((c) => {
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

  // 読む候補・AI 評価の対象は対象期間内（LOOKBACK_HOURS）の新着だけ。一覧（feed.json）は保存期間内のすべて
  const recent = fresh.filter((c) => inWindow(c.publishedAt, now, env.LOOKBACK_HOURS, env.INCLUDE_UNDATED));

  // 6. 評価。評価済みで前提が同じならキャッシュを使う
  //    - AI: AI 送信が許可された情報源の記事だけ
  //    - ルールベース（キーワード一致。外部に送らない）: AI を使わないとき、および AI 送信が許可されていない情報源の記事
  const infoFor = (c: Candidate): AssessorInfo => (deps.assessor && c.aiEligible ? deps.assessor.info : RULES);
  const keyOf = (c: Candidate) => assessmentKey(c, interests, infoFor(c));
  const needs = (c: Candidate) => state.items[c.id]?.assessmentKey !== keyOf(c);
  const usage: Usage = { ...emptyUsage(), ...state.usageByDate[date] };
  const runUsage = emptyUsage();

  for (const c of recent.filter((x) => !x.duplicateOf && infoFor(x) === RULES && needs(x))) {
    state.items[c.id]!.assessment = { ...ruleAssessment(c, interests, now.toISOString()), assessor: RULES };
    state.items[c.id]!.assessmentKey = keyOf(c);
  }
  if (deps.assessor) {
    const remaining = Math.max(0, env.MAX_AI_ARTICLES_PER_DAY - usage.aiArticles);
    const selected = selectForAssessment(recent, {
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
  pruneSourceStates(state, deps.sources);
  // 評価結果を先に保存（後続が失敗しても再実行で再評価しない）
  await storage.putText(STORAGE_KEYS.state, json(StateSchema.parse(state)));

  // 7. 新着一覧と今日の読む候補
  const fetchedAt = now.toISOString();
  const withAssessment = fresh.map((c) => {
    const s = state.items[c.id];
    const assessment: Assessment | undefined = s?.assessmentKey === keyOf(c) ? s.assessment : undefined;
    return { c, assessment };
  });
  const recentIds = new Set(recent.map((c) => c.id));
  const ranked = rankRecommendations(withAssessment.filter(({ c }) => recentIds.has(c.id)), {
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
    fetchedAt: prevFetchedAt.get(c.id) ?? fetchedAt,
    feedCategories: c.feedCategories,
    category: displayCategory(c, assessment),
    ...(c.duplicateOf ? { duplicateOf: c.duplicateOf } : {}),
    aiEligible: c.aiEligible,
    ...interestField(c.title, interests),
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

  // 8. report を保存し、読み戻して検証
  const reportKey = STORAGE_KEYS.report(date);
  await storage.putText(reportKey, json(report));
  const verify = await readJson(storage, reportKey, DailyReportSchema);
  if (!verify || verify.articles.length !== report.articles.length) throw new Error("report verification failed");

  // 9. 一覧（feed.json）: 前回の一覧に今日の新着を足し、保存期間・件数・有効な情報源で絞る
  const feed = await buildFeed(deps, storage, articles, sourceResults, lastResult, state, now);
  await storage.putText(STORAGE_KEYS.feed, json(feed));
  const verifyFeed = await readJson(storage, STORAGE_KEYS.feed, FeedSnapshotSchema);
  if (!verifyFeed || verifyFeed.articles.length !== feed.articles.length) throw new Error("feed verification failed");

  // 10. 最後に latest 参照（index）を更新（旧形式の index は引き継がない）
  const prev = await readJson(storage, STORAGE_KEYS.index, DigestIndexSchema).catch(() => null);
  const dates = (prev?.dates ?? []).filter((d) => d.date !== date);
  dates.push({ date, articleCount: articles.length, recommendationCount: ranked.length, status, generatedAt: report.generatedAt });
  dates.sort((a, b) => b.date.localeCompare(a.date));
  const index: DigestIndex = DigestIndexSchema.parse({ schemaVersion: 2, latestDate: dates[0]!.date, lastSuccessAt: report.generatedAt, dates });
  await storage.putText(STORAGE_KEYS.index, json(index));

  log("run completed", { date, status, articles: articles.length, recommendations: ranked.length, usage: runUsage });
  return { status, date, articles: articles.length, recommendations: ranked.length, usage: runUsage };
}

async function buildFeed(
  deps: RunDeps,
  storage: Storage,
  todays: Article[],
  results: SourceResult[],
  lastResult: Map<string, SourceStatus["lastResult"]>,
  state: State,
  now: Date,
): Promise<FeedSnapshot> {
  const { env } = deps;
  const prev = await readJson(storage, STORAGE_KEYS.feed, FeedSnapshotSchema).catch(() => null);
  const fetchable = new Map(deps.sources.filter((s) => sourcePolicy(s).fetch).map((s) => [s.id, s]));
  const byId = new Map<string, Article>();
  for (const a of prev?.articles ?? []) byId.set(a.id, a);
  // 今日の分で上書き（評価・分類・重複表示の最新化）。初出日時は前回の値を残す
  for (const a of todays) byId.set(a.id, { ...a, fetchedAt: byId.get(a.id)?.fetchedAt ?? a.fetchedAt });
  const sortKey = (a: Article) => a.publishedAt ?? a.fetchedAt;
  const articles = [...byId.values()]
    // 利用条件の見直し等で取得対象から外れた情報源の記事は一覧から外す
    .filter((a) => fetchable.has(a.sourceId))
    .filter((a) => {
      const days = fetchable.get(a.sourceId)!.retentionDays ?? env.FEED_RETENTION_DAYS;
      return now.getTime() - Date.parse(sortKey(a)) <= days * 86400_000;
    })
    .map((a) => {
      const src = fetchable.get(a.sourceId)!;
      // 情報源の設定（分類・AI 送信の扱い）の変更は、前回までの記事にも反映する
      // 関心テーマの一致も、テーマの変更を前回までの記事に反映する
      const rest = { ...a };
      delete rest.interestMatches;
      return { ...rest, category: a.assessment?.category ?? defaultCategory(src), aiEligible: sourcePolicy(src).ai, ...interestField(a.title, deps.interests) };
    })
    .sort((a, b) => sortKey(b).localeCompare(sortKey(a)) || a.id.localeCompare(b.id))
    .slice(0, env.FEED_MAX_ARTICLES);
  const counts = new Map<string, number>();
  for (const a of articles) counts.set(a.sourceId, (counts.get(a.sourceId) ?? 0) + 1);
  const resultById = new Map(results.map((r) => [r.id, r]));
  const sources: SourceStatus[] = [...fetchable.values()].map((s) => {
    const st = state.sources[s.id];
    const r = resultById.get(s.id);
    return {
      id: s.id,
      name: s.name,
      homepageUrl: s.homepageUrl,
      categories: s.categories,
      attributionText: s.attributionText,
      aiEnabled: sourcePolicy(s).ai,
      lastAttemptAt: st?.lastAttemptAt ?? null,
      lastSuccessAt: st?.lastSuccessAt ?? null,
      lastError: r && !r.ok ? (r.error ?? "取得に失敗しました") : null,
      lastResult: lastResult.get(s.id) ?? "none",
      articleCount: counts.get(s.id) ?? 0,
    };
  });
  return FeedSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    retentionDays: env.FEED_RETENTION_DAYS,
    articles,
    sources,
    manualLinks: (deps.manualLinks ?? []).map((m) => ({ id: m.id, name: m.name, url: m.url, categories: m.categories, note: m.note })),
  });
}

/** タイトルに含まれる関心キーワード（テーマごとに 1 語。端末内のキーワード一致で、外部には送らない） */
function interestField(title: string, interests: Interests): Pick<Article, "interestMatches"> {
  const m = keywordMatches(title, interests);
  return m.length ? { interestMatches: m.map((x) => ({ theme: x.themeLabel, keyword: x.keyword })) } : {};
}

function pruneState(state: State, date: string, retentionDays: number) {
  const cutoff = addDays(date, -retentionDays);
  for (const [id, item] of Object.entries(state.items)) {
    if (item.firstSeenDate < cutoff) delete state.items[id];
  }
  for (const d of Object.keys(state.usageByDate)) if (d < cutoff) delete state.usageByDate[d];
}

function pruneSourceStates(state: State, sources: Source[]) {
  const ids = new Set(sources.map((s) => s.id));
  for (const id of Object.keys(state.sources)) if (!ids.has(id)) delete state.sources[id];
}
