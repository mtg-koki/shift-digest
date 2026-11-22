import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shift Digest",
  description: "関心に合いそうな新着記事を選ぶための自分専用ダッシュボード",
  // 検索エンジン向けの指定にすぎず、アクセス制御ではない（アクセス制御は CloudFront の認証で行う）
  robots: { index: false, follow: false },
  referrer: "strict-origin-when-cross-origin",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="site-header">
          <div className="wrap">
            <Link href="/" className="site-title">
              Shift Digest
            </Link>
            <nav className="site-nav">
              <Link href="/">今日</Link>
              <Link href="/?view=saved">保存</Link>
              <Link href="/?view=archive">過去の日付</Link>
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="site-footer wrap">
          <p>
            読む候補は RSS のタイトル等のメタデータだけに基づく推薦です（本文は取得・要約していません）。記事は元サイトでお読みください。
          </p>
        </footer>
      </body>
    </html>
  );
}
