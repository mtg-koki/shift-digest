import Link from "next/link";
import {
  CATEGORY_DESCRIPTIONS,
  CATEGORY_IDS,
  CATEGORY_LABELS,
  type Article,
  type CategoryId,
  type DailyReport,
  type DigestIndex,
} from "../../shared/schema";
import { formatJst } from "../../shared/date";
import type { ArchiveView, ReportView, RunStatus } from "../data";

const BASIS_LABELS: Record<Article["contentBasis"], string> = {
  rss_description: "RSSの説明文のみから要約",
  title_only: "タイトルのみ（本文・説明文なし）",
  full_text: "本文から要約",
};

export function StatusBar({ status }: { status: RunStatus }) {
  return (
    <div className="status">
      <span>
        最終正常更新:{" "}
        {status.lastSuccessAt ? <time dateTime={status.lastSuccessAt}>{formatJst(status.lastSuccessAt)}（JST）</time> : "なし"}
      </span>
      {status.latestRunFailed && status.lastRun && (
        <p className="notice notice-warn" role="status">
          {formatJst(status.lastRun.at)} の更新に失敗したため、前回の正常なデータを表示しています。
        </p>
      )}
    </div>
  );
}

export function CategoryFilter({ basePath, active }: { basePath: string; active: CategoryId | null }) {
  return (
    <nav className="filter" aria-label="カテゴリで絞り込み">
      <Link href={basePath} className={active === null ? "chip chip-active" : "chip"} aria-current={active === null ? "page" : undefined}>
        すべて
      </Link>
      {CATEGORY_IDS.map((c) => (
        <Link
          key={c}
          href={`${basePath}?category=${c}`}
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

export function ArticleCard({ article }: { article: Article }) {
  return (
    <article className="card">
      <div className="card-meta">
        <span className={`badge badge-${article.category}`}>{CATEGORY_LABELS[article.category]}</span>
        <span>{article.sourceName}</span>
      </div>
      <h3 className="card-title">
        <a href={article.url} target="_blank" rel="noopener noreferrer">
          {article.titleJa}
        </a>
      </h3>
      <p className="card-summary">{article.summaryJa}</p>
      <dl className="card-dl">
        {article.publishedAt && (
          <>
            <dt>公開</dt>
            <dd>
              <time dateTime={article.publishedAt}>{formatJst(article.publishedAt)}</time>
            </dd>
          </>
        )}
        <dt>取得</dt>
        <dd>
          <time dateTime={article.fetchedAt}>{formatJst(article.fetchedAt)}</time>
        </dd>
        <dt>要約元</dt>
        <dd>
          {BASIS_LABELS[article.contentBasis]}
          {article.summarizer.provider === "mock" && "・AI未使用（サンプル要約）"}
        </dd>
      </dl>
      <a className="card-source" href={article.url} target="_blank" rel="noopener noreferrer">
        出典: {article.sourceName} ↗
      </a>
    </article>
  );
}

export function ReportBody({ report, category, basePath }: { report: DailyReport; category: CategoryId | null; basePath: string }) {
  const articles = category ? report.articles.filter((a) => a.category === category) : report.articles;
  const failed = report.sources.filter((s) => !s.ok);
  return (
    <section>
      <h2 className="report-date">{report.date} のまとめ</h2>
      <CategoryFilter basePath={basePath} active={category} />
      {report.status === "partial" && (
        <p className="notice notice-info">
          一部の取得元から取得できませんでした（{failed.map((s) => s.name).join("、")}）。取得できた分のみ掲載しています。
        </p>
      )}
      {articles.length === 0 ? (
        <p className="empty">
          {report.articles.length === 0
            ? "この日は掲載対象のニュースがありませんでした。"
            : "このカテゴリの記事はありません。"}
        </p>
      ) : (
        <div className="cards">
          {articles.map((a) => (
            <ArticleCard key={a.id} article={a} />
          ))}
        </div>
      )}
    </section>
  );
}

export function ReportPage({ view, category, basePath }: { view: ReportView; category: CategoryId | null; basePath: string }) {
  switch (view.kind) {
    case "error":
      return <p className="notice notice-error" role="alert">{view.message}</p>;
    case "no-data":
      return (
        <>
          <StatusBar status={view.status} />
          <p className="empty">まだまとめデータがありません。最初の日次更新後に表示されます。</p>
        </>
      );
    case "not-found":
      return (
        <>
          <StatusBar status={view.status} />
          <p className="empty">{view.date} のまとめはありません。</p>
          <p>
            <Link href="/archive">過去の日付一覧へ</Link>
          </p>
        </>
      );
    case "ok":
      return (
        <>
          <StatusBar status={view.status} />
          <ReportBody report={view.report} category={category} basePath={basePath} />
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
          <Link href={`/d/${d.date}`}>{d.date}</Link>
          <span className="archive-count">{d.articleCount}件</span>
          {d.status === "partial" && <span className="archive-note">一部取得失敗</span>}
        </li>
      ))}
    </ul>
  );
}

export function ArchivePage({ view }: { view: ArchiveView }) {
  switch (view.kind) {
    case "error":
      return <p className="notice notice-error" role="alert">{view.message}</p>;
    case "no-data":
      return (
        <>
          <StatusBar status={view.status} />
          <p className="empty">まだまとめデータがありません。</p>
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

export function parseCategory(v: string | string[] | undefined): CategoryId | null {
  const s = Array.isArray(v) ? v[0] : v;
  return (CATEGORY_IDS as readonly string[]).includes(s ?? "") ? (s as CategoryId) : null;
}
