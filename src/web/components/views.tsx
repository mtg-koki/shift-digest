import Link from "next/link";
import { formatJst } from "../../shared/date";
import { CATEGORY_DESCRIPTIONS, CATEGORY_IDS, CATEGORY_LABELS, type Article, type CategoryId, type DailyReport, type DigestIndex } from "../../shared/schema";
import type { ArchiveView, ReportView, RunStatus } from "../data";
import { emptyMarks, safeHref, type MarkAction, type Marks } from "../marks";

/**
 * 画面の URL。静的配信（index.html 1 枚）のため、表示内容はクエリで表す。
 *   /                     新着順の一覧（RSS リーダー）と今日の読む候補。&source= &category= &q= &unread=1 &hidden=1 で絞り込み
 *   /?view=sources        情報源の状態（最終正常取得・エラー・AI 評価の対象か）と手動リンク
 *   /?view=saved          保存した記事（この端末のブラウザー内）
 *   /?view=archive        日別の記録の一覧
 *   /?date=YYYY-MM-DD     日別の記録（その日の新着と読む候補）。&category= で絞り込み
 */
export function pageHref(p: { date?: string | null; category?: CategoryId | null; view?: "archive" | "saved" | "sources" }): string {
  const q = new URLSearchParams();
  if (p.view) q.set("view", p.view);
  if (p.date) q.set("date", p.date);
  if (p.category) q.set("category", p.category);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}

type Act = (a: MarkAction) => void;
const noop: Act = () => undefined;

export function StatusBar({ status }: { status: RunStatus }) {
  return (
    <div className="status">
      <span>
        最終正常更新: {status.lastSuccessAt ? <time dateTime={status.lastSuccessAt}>{formatJst(status.lastSuccessAt)}（JST）</time> : "なし"}
      </span>
      {status.latestRunFailed && status.lastRun && (
        <p className="notice notice-warn" role="status">
          {formatJst(status.lastRun.at)} の更新に失敗したため、前回の正常なデータを表示しています。
        </p>
      )}
    </div>
  );
}

export function CategoryFilter({ date, active }: { date: string | null; active: CategoryId | null }) {
  return (
    <nav className="filter" aria-label="カテゴリで絞り込み">
      <Link href={pageHref({ date })} className={active === null ? "chip chip-active" : "chip"} aria-current={active === null ? "page" : undefined}>
        すべて
      </Link>
      {CATEGORY_IDS.map((c) => (
        <Link
          key={c}
          href={pageHref({ date, category: c })}
          className={active === c ? "chip chip-active" : "chip"}
          aria-current={active === c ? "page" : undefined}
          title={CATEGORY_DESCRIPTIONS[c]}
        >
          {CATEGORY_LABELS[c]}
        </Link>
      ))}
    </nav>
  );
}

function Meta({ a }: { a: Article }) {
  return (
    <div className="card-meta">
      <span className={`badge badge-${a.category}`}>{CATEGORY_LABELS[a.category]}</span>
      <span>{a.sourceName}</span>
      {a.publishedAt && (
        <span>
          公開 <time dateTime={a.publishedAt}>{formatJst(a.publishedAt)}</time>
        </span>
      )}
    </div>
  );
}

/** 元記事へのリンク（新しいタブ）。開いたら既読にする */
function ArticleLink({ a, act }: { a: Article; act: Act }) {
  const href = safeHref(a.url);
  if (!href) return <span>{a.title}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={() => act({ type: "read", id: a.id })}>
      {a.title}
    </a>
  );
}

function Actions({ a, date, marks, act }: { a: Article; date: string; marks: Marks; act: Act }) {
  const read = !!marks.read[a.id];
  const hidden = !!marks.hidden[a.id];
  const saved = !!marks.saved[a.id];
  return (
    <div className="actions">
      <button type="button" onClick={() => act({ type: read ? "unread" : "read", id: a.id })} aria-pressed={read}>
        {read ? "未読に戻す" : "既読にする"}
      </button>
      <button
        type="button"
        onClick={() => act(saved ? { type: "unsave", id: a.id } : { type: "save", id: a.id, item: { title: a.title, url: a.url, sourceName: a.sourceName, date } })}
        aria-pressed={saved}
      >
        {saved ? "保存を解除" : "保存"}
      </button>
      <button type="button" onClick={() => act({ type: hidden ? "unhide" : "hide", id: a.id })} aria-pressed={hidden}>
        {hidden ? "再表示" : "非表示"}
      </button>
    </div>
  );
}

export function RecommendationCard({ a, rank, date, marks, act }: { a: Article; rank: number; date: string; marks: Marks; act: Act }) {
  const as = a.assessment;
  return (
    <article className={marks.read[a.id] ? "card card-read" : "card"}>
      <Meta a={a} />
      <h3 className="card-title">
        <span className="rank">{rank}.</span> <ArticleLink a={a} act={act} />
      </h3>
      {as && (
        <p className="reason">
          <span className="reason-label">{as.assessor.provider === "bedrock" ? "推薦理由（AI がタイトル等から作成）:" : "推薦理由（キーワード一致から作成）:"}</span> {as.reason}
          <span className="score" title="関心テーマとの関連度です。記事の正確性・重要性・必読度ではありません。">
            関心との関連度 {as.relevanceScore}
          </span>
          {as.assessor.provider === "rules" && <span className="muted">・ルールベース評価（AI 不使用）</span>}
        </p>
      )}
      <Actions a={a} date={date} marks={marks} act={act} />
    </article>
  );
}

export function ArticleRow({ a, date, marks, act, dupTitle }: { a: Article; date: string; marks: Marks; act: Act; dupTitle?: string }) {
  return (
    <li className={marks.read[a.id] ? "row row-read" : "row"}>
      <Meta a={a} />
      <div className="row-title">
        <ArticleLink a={a} act={act} />
        {marks.read[a.id] && <span className="muted">（既読）</span>}
      </div>
      {dupTitle && <p className="muted small">同じタイトルの記事が他の媒体にもあります</p>}
      <Actions a={a} date={date} marks={marks} act={act} />
    </li>
  );
}

export function ReportBody({
  report,
  category,
  date,
  marks = emptyMarks(),
  act = noop,
  showHidden = false,
}: {
  report: DailyReport;
  category: CategoryId | null;
  date: string | null;
  marks?: Marks;
  act?: Act;
  showHidden?: boolean;
}) {
  const byId = new Map(report.articles.map((a) => [a.id, a]));
  const inCat = (a: Article) => !category || a.category === category;
  const visible = (a: Article) => showHidden || !marks.hidden[a.id];
  const recs = report.recommendations.map((r) => byId.get(r.articleId)).filter((a): a is Article => !!a && inCat(a) && visible(a));
  const recIds = new Set(report.recommendations.map((r) => r.articleId));
  const list = report.articles.filter((a) => !recIds.has(a.id) && inCat(a) && visible(a));
  const hiddenCount = report.articles.filter((a) => marks.hidden[a.id]).length;
  const failed = report.sources.filter((s) => !s.ok);
  const attributions = report.sources.filter((s) => s.attribution);
  return (
    <section>
      <h2 className="report-date">{report.date}</h2>
      <CategoryFilter date={date} active={category} />
      {report.status === "partial" && (
        <p className="notice notice-info">
          一部の情報源から取得できませんでした（{failed.map((s) => s.name).join("、")}）。取得できた分のみ表示しています。
        </p>
      )}
      {report.sources.length === 0 && <p className="notice notice-info">有効な情報源がありません。情報源の設定（利用条件の確認と有効化）を確認してください。</p>}

      <h3 className="section-title">この日の読む候補</h3>
      <p className="note">
        関心テーマ（{report.interests.map((l) => `「${l}」`).join("")}）に合いそうな記事を、<strong>タイトル等に基づいて</strong>選んでいます。本文は読んでいません。
        関連度は関心との近さで、記事の正確性・重要性・必読度を表すものではありません。
      </p>
      {recs.length === 0 ? (
        <p className="empty">{report.recommendations.length === 0 ? "関心に合いそうな候補は見つかりませんでした。新着一覧をご覧ください。" : "表示できる候補はありません。"}</p>
      ) : (
        <div className="cards">
          {recs.map((a, i) => (
            <RecommendationCard key={a.id} a={a} rank={i + 1} date={report.date} marks={marks} act={act} />
          ))}
        </div>
      )}

      <h3 className="section-title">この日の新着（{list.length}件）</h3>
      {list.length === 0 ? (
        <p className="empty">{report.articles.length === 0 ? "この日の新着記事はありませんでした。" : "表示できる記事はありません。"}</p>
      ) : (
        <ul className="rows">
          {list.map((a) => (
            <ArticleRow key={a.id} a={a} date={report.date} marks={marks} act={act} dupTitle={a.duplicateOf} />
          ))}
        </ul>
      )}
      {hiddenCount > 0 && <p className="muted small">非表示にした記事: {hiddenCount}件</p>}
      {attributions.length > 0 && (
        <div className="attribution">
          <h3 className="section-title">出典</h3>
          <ul>
            {attributions.map((s) => (
              <li key={s.id}>{s.attribution}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** date: 日付別ページなら YYYY-MM-DD、最新ページなら null（カテゴリ絞り込みのリンク先に使う） */
export function ReportPage({
  view,
  category,
  date,
  marks,
  act,
  showHidden,
}: {
  view: ReportView;
  category: CategoryId | null;
  date: string | null;
  marks?: Marks;
  act?: Act;
  showHidden?: boolean;
}) {
  switch (view.kind) {
    case "error":
      return (
        <p className="notice notice-error" role="alert">
          {view.message}
        </p>
      );
    case "no-data":
      return (
        <>
          <StatusBar status={view.status} />
          <p className="empty">まだデータがありません。最初の日次更新後に表示されます。</p>
        </>
      );
    case "not-found":
      return (
        <>
          <StatusBar status={view.status} />
          <p className="empty">{view.date} のデータはありません。</p>
          <p>
            <Link href={pageHref({ view: "archive" })}>過去の日付一覧へ</Link>
          </p>
        </>
      );
    case "ok":
      return (
        <>
          <StatusBar status={view.status} />
          <ReportBody report={view.report} category={category} date={date} marks={marks} act={act} showHidden={showHidden} />
        </>
      );
  }
}

export function ArchiveList({ index }: { index: DigestIndex }) {
  const dates = [...index.dates].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <ul className="archive">
      {dates.map((d) => (
        <li key={d.date}>
          <Link href={pageHref({ date: d.date })}>{d.date}</Link>
          <span className="archive-count">
            候補 {d.recommendationCount}件・新着 {d.articleCount}件
          </span>
          {d.status === "partial" && <span className="archive-note">一部取得失敗</span>}
        </li>
      ))}
    </ul>
  );
}

export function ArchivePage({ view }: { view: ArchiveView }) {
  switch (view.kind) {
    case "error":
      return (
        <p className="notice notice-error" role="alert">
          {view.message}
        </p>
      );
    case "no-data":
      return (
        <>
          <StatusBar status={view.status} />
          <p className="empty">まだデータがありません。</p>
        </>
      );
    case "ok":
      return (
        <>
          <StatusBar status={view.status} />
          <h2 className="report-date">過去の日付</h2>
          <ArchiveList index={view.index} />
        </>
      );
  }
}

export function SavedPage({ marks, act = noop }: { marks: Marks; act?: Act }) {
  const items = Object.entries(marks.saved).sort(([, a], [, b]) => b.savedAt.localeCompare(a.savedAt));
  return (
    <section>
      <h2 className="report-date">保存した記事</h2>
      <p className="note">保存・既読・非表示はこのブラウザーの中だけに記録されます（他の端末とは同期しません）。</p>
      {items.length === 0 ? (
        <p className="empty">保存した記事はありません。</p>
      ) : (
        <ul className="rows">
          {items.map(([id, s]) => {
            const href = safeHref(s.url);
            return (
              <li key={id} className="row">
                <div className="card-meta">
                  <span>{s.sourceName}</span>
                  <span>{s.date}</span>
                </div>
                <div className="row-title">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{s.title}</a> : s.title}</div>
                <div className="actions">
                  <button type="button" onClick={() => act({ type: "unsave", id })}>
                    保存を解除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function parseCategory(v: string | string[] | undefined): CategoryId | null {
  const s = Array.isArray(v) ? v[0] : v;
  return (CATEGORY_IDS as readonly string[]).includes(s ?? "") ? (s as CategoryId) : null;
}
