"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { addDays, formatJst, jstDate } from "../../shared/date";
import { CATEGORY_DESCRIPTIONS, CATEGORY_IDS, CATEGORY_LABELS, type Article, type FeedSnapshot, type SourceStatus } from "../../shared/schema";
import type { FeedView } from "../data";
import { filterArticles, isNewSince, type ReaderFilter } from "../filter";
import { safeHref, type MarkAction, type Marks } from "../marks";
import { X_LINKS } from "../x-links";
import { ArticleRow, RecommendationCard, StatusBar, pageHref } from "./views";

type Act = (a: MarkAction) => void;
const PAGE = 100;

const RESULT_LABELS: Record<SourceStatus["lastResult"], string> = {
  updated: "取得",
  "not-modified": "変更なし",
  "skipped-interval": "取得間隔のため省略",
  failed: "失敗",
  none: "未取得",
};

function Recommendations({ view, marks, act, filter }: { view: Extract<FeedView, { kind: "ok" }>; marks: Marks; act: Act; filter: ReaderFilter }) {
  const report = view.latest;
  if (!report) return null;
  const byId = new Map(report.articles.map((a) => [a.id, a]));
  const recs = report.recommendations
    .map((r) => byId.get(r.articleId))
    .filter((a): a is Article => !!a && (filter.showHidden || !marks.hidden[a.id]));
  return (
    <section aria-labelledby="recs">
      <h2 id="recs" className="section-title">
        今日の読む候補 <span className="muted small">（{report.date}・全媒体から）</span>
      </h2>
      <p className="note">
        すべての媒体の新着から、関心テーマに合いそうな記事を<strong>タイトル等に基づいて</strong>選んでいます。本文は読んでいません。関連度は関心との近さで、記事の重要性や正確性ではありません。
        AI で評価するのは AI 送信の条件を確認できた情報源の記事だけで、それ以外はタイトルのキーワード一致（外部に送らない）で評価しています。
      </p>
      {recs.length === 0 ? (
        <p className="empty">今日は関心に合いそうな候補はありませんでした。</p>
      ) : (
        <div className="cards">
          {recs.map((a, i) => (
            <RecommendationCard key={a.id} a={a} rank={i + 1} date={report.date} marks={marks} act={act} />
          ))}
        </div>
      )}
    </section>
  );
}

function Chip({ active, onClick, title, disabled, children }: { active: boolean; onClick: () => void; title?: string; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={active ? "chip chip-active" : "chip"} aria-pressed={active} onClick={onClick} title={title} disabled={disabled}>
      {children}
    </button>
  );
}

function Filters({
  filter,
  onChange,
  count,
  since,
  newCount,
  interestCount,
}: {
  filter: ReaderFilter;
  onChange: (f: ReaderFilter) => void;
  count: number;
  since: string | null;
  newCount: number;
  interestCount: number;
}) {
  return (
    <div className="filters">
      <div className="filter" role="group" aria-label="カテゴリで絞り込み">
        <Chip active={filter.category === null} onClick={() => onChange({ ...filter, category: null })}>
          すべて
        </Chip>
        {CATEGORY_IDS.map((c) => (
          <Chip key={c} active={filter.category === c} onClick={() => onChange({ ...filter, category: c })} title={CATEGORY_DESCRIPTIONS[c]}>
            {CATEGORY_LABELS[c]}
          </Chip>
        ))}
      </div>
      <div className="filter" role="group" aria-label="表示の切り替え">
        <Chip
          active={filter.newOnly}
          onClick={() => onChange({ ...filter, newOnly: !filter.newOnly })}
          disabled={!since && !filter.newOnly}
          title={since ? `前回の閲覧（${formatJst(since)}）以降に取得した記事` : "2 回目の閲覧から使えます"}
        >
          前回以降の新着（{newCount}）
        </Chip>
        <Chip active={filter.interestOnly} onClick={() => onChange({ ...filter, interestOnly: !filter.interestOnly })} title="関心テーマのキーワードがタイトルに含まれる記事">
          関心テーマに一致（{interestCount}）
        </Chip>
        <Chip active={filter.unreadOnly} onClick={() => onChange({ ...filter, unreadOnly: !filter.unreadOnly })}>
          未読のみ
        </Chip>
        <Chip active={filter.showHidden} onClick={() => onChange({ ...filter, showHidden: !filter.showHidden })}>
          非表示も表示
        </Chip>
        <span className="muted small filter-count" aria-live="polite">
          {count}件
        </span>
      </div>
    </div>
  );
}

/** テーマごとの X 検索へのリンク（外部サイトを開くだけ。X のデータは取得しない） */
function XLinks() {
  return (
    <nav className="filter x-links" aria-label="X でテーマの話題を見る">
      <span className="muted small">X で話題を見る（外部サイト）:</span>
      {X_LINKS.map((x) => (
        <a key={x.id} className="chip" href={safeHref(x.url) ?? undefined} target="_blank" rel="noopener noreferrer">
          {x.label}
        </a>
      ))}
    </nav>
  );
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 一覧の日付見出し（JST）: 今日 11月23日（月） / 昨日 … / 11月21日（土） */
export function dayHeading(day: string, today: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const label = `${m}月${d}日（${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
  if (day === today) return `今日 ${label}`;
  if (day === addDays(today, -1)) return `昨日 ${label}`;
  return label;
}

function groupByDay(list: Article[]): Array<{ day: string; items: Article[] }> {
  const groups: Array<{ day: string; items: Article[] }> = [];
  for (const a of list) {
    const day = jstDate(new Date(a.publishedAt ?? a.fetchedAt));
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(a);
    else groups.push({ day, items: [a] });
  }
  return groups;
}

export function ReaderPage({
  view,
  marks,
  act,
  filter,
  onFilter,
  since = null,
}: {
  view: FeedView;
  marks: Marks;
  act: Act;
  filter: ReaderFilter;
  onFilter: (f: ReaderFilter) => void;
  /** 前回の閲覧日時（これより後に取得した記事を「新着」とする） */
  since?: string | null;
}) {
  const [limit, setLimit] = useState(PAGE);
  const list = useMemo(() => (view.kind === "ok" ? filterArticles(view.feed.articles, filter, marks, since) : []), [view, filter, marks, since]);
  if (view.kind === "error")
    return (
      <p className="notice notice-error" role="alert">
        {view.message}
      </p>
    );
  if (view.kind === "no-data")
    return (
      <>
        <StatusBar status={view.status} />
        <p className="empty">まだデータがありません。最初の更新後に表示されます。</p>
      </>
    );
  const { feed } = view;
  const failed = feed.sources.filter((s) => s.lastError);
  // ボタンの件数は「非表示」を除いた数（カテゴリ等の他の条件はかけない）
  const visible = feed.articles.filter((a) => !marks.hidden[a.id]);
  const newCount = visible.filter((a) => isNewSince(a, since)).length;
  const interestCount = visible.filter((a) => a.interestMatches?.length).length;
  const shown = list.slice(0, limit);
  const unreadShown = shown.filter((a) => !marks.read[a.id]).map((a) => a.id);
  const today = jstDate();
  return (
    <>
      <StatusBar status={view.status} />
      {failed.length > 0 && (
        <p className="notice notice-warn" role="status">
          取得できなかった情報源があります（{failed.map((s) => s.name).join("、")}）。前回までの記事を表示しています。<Link href={pageHref({ view: "sources" })}>情報源の状態</Link>
        </p>
      )}
      {feed.sources.length === 0 && <p className="notice notice-info">有効な情報源がありません。情報源の設定（利用条件の確認と有効化）を確認してください。</p>}
      <p className="inbox-summary">
        {since ? (
          <span>
            前回の閲覧（{formatJst(since)}）以降の新着 <strong>{newCount}件</strong>
          </span>
        ) : (
          <span>次回から、前回の閲覧以降の新着だけを表示できます</span>
        )}
        <span className="muted small">
          {feed.sources.length}媒体をまとめて表示・最終取得 {formatJst(feed.generatedAt)}
        </span>
      </p>
      <Recommendations view={view} marks={marks} act={act} filter={filter} />
      <XLinks />

      <section aria-labelledby="list">
        <h2 id="list" className="section-title">
          新着順の一覧 <span className="muted small">（直近 {feed.retentionDays} 日・全媒体）</span>
        </h2>
        <Filters
          filter={filter}
          onChange={(f) => {
            setLimit(PAGE);
            onFilter(f);
          }}
          count={list.length}
          since={since}
          newCount={newCount}
          interestCount={interestCount}
        />
        {list.length === 0 ? (
          <p className="empty">{feed.articles.length === 0 ? "まだ記事がありません。" : filter.newOnly ? "前回の閲覧以降の新着はありません。" : "条件に合う記事はありません。"}</p>
        ) : (
          groupByDay(shown).map((g) => (
            <section key={g.day} aria-label={dayHeading(g.day, today)}>
              <h3 className="day-heading">
                {dayHeading(g.day, today)} <span className="muted small">{g.items.length}件</span>
              </h3>
              <ul className="rows">
                {g.items.map((a) => (
                  <ArticleRow key={a.id} a={a} date={g.day} marks={marks} act={act} dupTitle={a.duplicateOf} isNew={isNewSince(a, since)} />
                ))}
              </ul>
            </section>
          ))
        )}
        <p className="list-actions">
          {list.length > limit && (
            <button type="button" onClick={() => setLimit((n) => n + PAGE)}>
              さらに表示（残り {list.length - limit}件）
            </button>
          )}
          {unreadShown.length > 0 && (
            <button type="button" onClick={() => act({ type: "readMany", ids: unreadShown })}>
              表示中の未読 {unreadShown.length}件をすべて既読にする
            </button>
          )}
        </p>
      </section>
      <Attribution feed={feed} />
    </>
  );
}

function Attribution({ feed }: { feed: FeedSnapshot }) {
  const items = feed.sources.filter((s) => s.attributionText);
  if (items.length === 0) return null;
  return (
    <div className="attribution">
      <h3 className="section-title">出典</h3>
      <ul>
        {items.map((s) => {
          const href = safeHref(s.homepageUrl);
          return (
            <li key={s.id}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {s.name}
                </a>
              ) : (
                s.name
              )}
              : {s.attributionText}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SourcesPage({ view }: { view: FeedView }) {
  if (view.kind === "error")
    return (
      <p className="notice notice-error" role="alert">
        {view.message}
      </p>
    );
  if (view.kind === "no-data")
    return (
      <>
        <StatusBar status={view.status} />
        <p className="empty">まだデータがありません。</p>
      </>
    );
  const { feed } = view;
  return (
    <section>
      <StatusBar status={view.status} />
      <h2 className="report-date">情報源の状態</h2>
      <p className="note">
        取得・表示しているのは、利用条件を確認して有効にした情報源だけです。「AI 評価」は、タイトル等を Amazon Bedrock に送って関心度を評価する対象かどうかです（対象外でも一覧には並びます）。
      </p>
      <div className="table-wrap">
        <table className="sources">
          <thead>
            <tr>
              <th scope="col">媒体</th>
              <th scope="col">カテゴリ</th>
              <th scope="col">最終正常取得</th>
              <th scope="col">直近の取得</th>
              <th scope="col">一覧の件数</th>
              <th scope="col">AI 評価</th>
            </tr>
          </thead>
          <tbody>
            {feed.sources.map((s) => {
              const href = safeHref(s.homepageUrl);
              return (
                <tr key={s.id}>
                  <td>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {s.name}
                      </a>
                    ) : (
                      s.name
                    )}
                  </td>
                  <td>{s.categories.map((c) => CATEGORY_LABELS[c]).join("・")}</td>
                  <td>{s.lastSuccessAt ? <time dateTime={s.lastSuccessAt}>{formatJst(s.lastSuccessAt)}</time> : "なし"}</td>
                  <td>
                    {RESULT_LABELS[s.lastResult]}
                    {s.lastError && <span className="error-text">（{s.lastError}）</span>}
                  </td>
                  <td>{s.articleCount}</td>
                  <td>{s.aiEnabled ? "対象" : "対象外"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {feed.manualLinks.length > 0 && (
        <>
          <h3 className="section-title">手動リンク（自動取得していない媒体）</h3>
          <p className="note">公式 RSS が見つからない、または利用条件の確認待ちの媒体です。自動取得（スクレイピング）はしていません。</p>
          <ul className="rows">
            {feed.manualLinks.map((m) => {
              const href = safeHref(m.url);
              return (
                <li key={m.id} className="row">
                  <div className="row-title">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {m.name}
                      </a>
                    ) : (
                      m.name
                    )}
                  </div>
                  <p className="muted small">
                    {m.categories.map((c) => CATEGORY_LABELS[c]).join("・")}
                    {m.note && ` — ${m.note}`}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
