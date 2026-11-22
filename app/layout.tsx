import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shift Digest",
  description: "自分専用の RSS リーダー（任意で関心に合いそうな記事を推薦）",
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
              <Link href="/">一覧</Link>
              <Link href="/?view=saved">保存</Link>
              <Link href="/?view=sources">情報源</Link>
              <Link href="/?view=archive">日別</Link>
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="site-footer wrap">
          <p>
            RSS のタイトル・リンク等だけを表示しています（本文は取得・要約・翻訳していません）。記事は元サイトでお読みください。読む候補はタイトル等に基づく推薦です。
          </p>
        </footer>
      </body>
    </html>
  );
}
