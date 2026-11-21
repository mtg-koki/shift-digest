import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shift Digest",
  description: "技術・雇用・所有・制度の最新ニュースを日本語で短くまとめた個人用ダイジェスト",
  robots: { index: false, follow: false },
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
              <Link href="/">最新</Link>
              <Link href="/archive">過去の日付</Link>
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="site-footer wrap">
          <p>要約は出典の公開情報（主にRSSの説明文）に基づく自動生成です。正確な内容は必ず出典をご確認ください。</p>
        </footer>
      </body>
    </html>
  );
}
