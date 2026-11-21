// ネットワークも AI も使わずにバッチを試すための架空フィードを、現在時刻基準で生成する。
// 出力先: .offline-feeds/（git 管理外）
import { mkdirSync, writeFileSync } from "node:fs";

const now = Date.now();
const ago = (h) => new Date(now - h * 3600_000);
mkdirSync(".offline-feeds", { recursive: true });

writeFileSync(
  ".offline-feeds/rss2.xml",
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Offline RSS</title>
<item><title>【架空】AIエージェントの業務導入事例を公開</title><link>https://example.com/rss/ai-agent?utm_source=feed</link>
<description>&lt;p&gt;架空の企業がAIエージェントを社内業務に導入した事例を公開した、という想定の検証用記事です。&lt;/p&gt;</description>
<pubDate>${ago(3).toUTCString()}</pubDate></item>
<item><title>【架空】AIエージェントの業務導入事例を公開</title><link>https://example.com/rss/ai-agent</link>
<description>重複（URL正規化で同一）</description><pubDate>${ago(3).toUTCString()}</pubDate></item>
<item><title>【架空】データセンター増設に向けた出資を発表</title><link>https://example.com/rss/dc-investment</link>
<description>架空の事業者が計算資源の拡充に向けた出資を発表した、という想定の検証用記事です。</description>
<pubDate>${ago(10).toUTCString()}</pubDate></item>
<item><title>【架空】タイトルのみの記事</title><link>https://example.com/rss/title-only</link>
<pubDate>${ago(5).toUTCString()}</pubDate></item>
<item><title>【架空】古い記事（対象期間外）</title><link>https://example.com/rss/old</link>
<description>対象期間外のため除外される想定。</description><pubDate>${ago(24 * 30).toUTCString()}</pubDate></item>
<item><title>【架空】日付のない記事</title><link>https://example.com/rss/undated</link><description>日時不明のため除外される想定。</description></item>
</channel></rss>
`,
);

writeFileSync(
  ".offline-feeds/atom.xml",
  `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Offline Atom</title>
<entry><title>【架空】著作権制度の見直しに関する意見募集</title><link rel="alternate" href="https://example.com/atom/copyright"/>
<summary>架空の機関が著作権制度の見直しについて意見募集を開始した、という想定の検証用記事です。</summary>
<published>${ago(6).toISOString()}</published></entry>
<entry><title>【架空】テレワーク制度の運用状況を公表</title><link href="https://example.com/atom/telework"/>
<summary>架空の機関が働き方に関する制度の運用状況を公表した、という想定の検証用記事です。</summary>
<updated>${ago(20).toISOString()}</updated></entry>
</feed>
`,
);
console.log("offline feeds written to .offline-feeds/");
