"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { formatJst, jstDate } from "../../shared/date";
import { CATEGORY_IDS, CATEGORY_LABELS, type Article, type FeedSnapshot, type SourceStatus } from "../../shared/schema";
import type { FeedView } from "../data";
import { filterArticles, type ReaderFilter } from "../filter";
import { safeHref, type MarkAction, type Marks } from "../marks";
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
        今日の読む候補 <span className="muted small">（{report.date}・任意機能）</span>
      </h2>
      <p className="note">
        関心テーマに合いそうな記事を<strong>タイトル等に基づいて</strong>選んでいます。本文は読んでいません。関連度は関心との近さで、記事の重要性や正確性ではありません。
        推薦の対象は、AI 送信の条件を確認できた情報源の記事だけです。対象外の記事も下の一覧にすべて並びます。
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

function Filters({ feed, filter, onChange, count }: { feed: FeedSnapshot; filter: ReaderFilter; onChange: (f: ReaderFilter) => void; count: number }) {
  const sources = [...feed.sources].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return (
    <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
      <label>
        <span>媒体</span>
        <select value={filter.source ?? ""} onChange={(e) => onChange({ ...filter, source: e.target.value || null })}>
          <option value="">すべて</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.articleCount}）
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>カテゴリ</span>
        <select value={filter.category ?? ""} onChange={(e) => onChange({ ...filter, category: (e.target.value || null) as ReaderFilter["category"] })}>
          <option value="">すべて</option>
          {CATEGORY_IDS.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="grow">
        <span>タイトルで検索</span>
        <input type="search" value={filter.q} maxLength={100} placeholder="キーワード（空白区切りで AND）" onChange={(e) => onChange({ ...filter, q: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={filter.unreadOnly} onChange={(e) => onChange({ ...filter, unreadOnly: e.target.checked })} /> 未読のみ
      </label>
      <label className="check">
        <input type="checkbox" checked={filter.showHidden} onChange={(e) => onChange({ ...filter, showHidden: e.target.checked })} /> 非表示も表示
      </label>
      <p className="muted small" aria-live="polite">
        {count}件
      </p>
    </form>
  );
}

export function ReaderPage({ view, marks, act, filter, onFilter }: { view: FeedView; marks: Marks; act: Act; filter: ReaderFilter; onFilter: (f: ReaderFilter) => void }) {
  const [limit, setLimit] = useState(PAGE);
  const list = useMemo(() => (view.kind === "ok" ? filterArticles(view.feed.articles, filter, marks) : []), [view, filter, marks]);
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
        <p className="empty">まだデータがありません。最初の日次更新後に表示されます。</p>
      </>
    );
  const { feed } = view;
  const failed = feed.sources.filter((s) => s.lastError);
  return (
    <>
      <StatusBar status={view.status} />
      {failed.length > 0 && (
        <p className="notice notice-warn" role="status">
          取得できなかった情報源があります（{failed.map((s) => s.name).join("、")}）。前回までの記事を表示しています。<Link href={pageHref({ view: "sources" })}>情報源の状態</Link>
        </p>
      )}
      {feed.sources.length === 0 && <p className="notice notice-info">有効な情報源がありません。情報源の設定（利用条件の確認と有効化）を確認してください。</p>}
      <Recommendations view={view} marks={marks} act={act} filter={filter} />

      <section aria-labelledby="list">
        <h2 id="list" className="section-title">
          新着順の一覧 <span className="muted small">（直近 {feed.retentionDays} 日）</span>
        </h2>
        <Filters
          feed={feed}
          filter={filter}
          onChange={(f) => {
            setLimit(PAGE);
            onFilter(f);
          }}
          count={list.length}
        />
        {list.length === 0 ? (
          <p className="empty">{feed.articles.length === 0 ? "まだ記事がありません。" : "条件に合う記事はありません。"}</p>
        ) : (
          <ul className="rows">
            {list.slice(0, limit).map((a) => (
              <ArticleRow key={a.id} a={a} date={jstDate(new Date(a.publishedAt ?? a.fetchedAt))} marks={marks} act={act} dupTitle={a.duplicateOf} />
            ))}
          </ul>
        )}
        {list.length > limit && (
          <p>
            <button type="button" onClick={() => setLimit((n) => n + PAGE)}>
              さらに表示（残り {list.length - limit}件）
            </button>
          </p>
        )}
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
          <h3 className="section-title">手動リンク（RSS なし）</h3>
          <p className="note">公式 RSS が見つからない媒体です。自動取得（スクレイピング）はしていません。</p>
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
