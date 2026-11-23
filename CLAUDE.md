# CLAUDE.md

Shift Digest: RSS で利用が認められる新着記事を新着順に並べる**自分専用の RSS リーダー**＋任意の「読む候補」推薦。詳細は README.md。

## 構成（AWS）

- Web: Next.js App Router を静的エクスポート（`out/`）→ S3（非公開）+ CloudFront（OAC）。画面は `index.html` 1 枚で、クエリで切り替え（`/` 一覧＋読む候補、`&category= &new=1 &interest=1 &unread=1 &hidden=1` 絞り込み。媒体での絞り込みは設けない、`/?view=sources|saved|archive`、`/?date=`）
- アクセス制御: CloudFront Functions（viewer-request、全ビヘイビア）の Basic 認証 `infra/app/functions/basic-auth.js`。期待値は KeyValueStore の `basic-auth-sha256`（CLI で投入、Terraform・Git に入れない。未設定なら全員 401）
- データ: ブラウザーが同一オリジンの `/data/*.json` を fetch。一覧は `feed.json`（保存期間内の記事・情報源の取得状態・手動リンク）、読む候補は `reports/YYYY-MM-DD.json`。既読・非表示・保存・前回の閲覧日時は localStorage のみ（同期なし）
- バッチ: EventBridge Scheduler（7:00・12:00・18:00 Asia/Tokyo）→ Lambda コンテナー（`Dockerfile.lambda`、x86_64、VPC なし）。条件付き GET（ETag / Last-Modified）。同じ日に何度実行しても、取得して一覧を更新し当日分に追記する（スキップしない）
- AI（任意）: Amazon Bedrock Converse のみ（`src/batch/assess/bedrock.ts`）。タイトル等から関心度・分類・推薦理由。モデル ID 未設定ならルールベース
- S3 は 2 バケット: site（Web ＋ `data/`）と internal（`state/` `locks/`。配信しない）
- IaC: `infra/bootstrap` → `infra/app`。CI/CD は GitHub Actions + OIDC、apply 等は手動かつ `production` の承認付き。リソース名は `shift-digest-<略称>[-<用途>]-01`

## コマンド

```bash
npm run check            # lint + typecheck + test（変更後は必ず通す）
npm run batch:offline    # 架空の情報源・フィードでバッチ（ネットワーク・AI なし）
npm run dev              # 表示確認
npm run build && npm run preview   # 静的配信の確認（PREVIEW_AUTH_HASH で認証も再現）
terraform fmt -recursive infra && terraform -chdir=infra/app validate   # init -backend=false 後
```

## 守ること

- 情報源（`config/sources.json`）は「RSS の私的利用（`privateRssUseStatus`）」と「AI 送信（`aiMetadataStatus`）」を別々に判断する。`unreviewed` を許可と扱わない。`userConfirmation` の条件は `confirmedAt` が入るまで処理しない。規約の内容・実在しない URL を推測で書かない。根拠（`termsUrl`・`reviewedAt`・`basis`）と不明点（`openQuestions`）を残す
- 「AI 利用の明記なし」を RSS 表示の禁止理由にしない。AI 送信が未確認でも、私的利用が認められる情報源は一覧に並べる（低品質扱いしない）。自作アプリへの組み込みに相談を求める媒体は確認待ち。RSS がない媒体はスクレイピングせず手動リンク
- 本文・description / summary / content・画像を取得・保存・ログ出力・AI 送信しない。タイトルは原文のまま（サニタイズのみ）。翻訳・要約しない。タイトルから作った文章を「要約」と表示しない
- AI に渡すのは記事 ID・タイトル・媒体名・公開日時・関心テーマだけ。URL は渡さず、AI 出力の URL は採用しない。出力は `parseAssessments` で検証（未知/重複 ID・不正スコアを拒否）。toolConfig を渡さない。AI の推薦理由は AI 作成と明示する
- 外部 URL は `src/batch/net.ts` の検査（https のみ・内部アドレス拒否・リダイレクト先検査・サイズ/時間制限）を通す。XML の実体宣言は拒否
- 画面に HTML を埋め込まない（`dangerouslySetInnerHTML` 禁止）。リンクは `safeHref` で http(s) のみ。画面・データに内部のパスや接続先を出さない
- 文言は「今日の読む候補」「関心に合いそう」「タイトル等に基づく推薦」。「必読」等を使わない。スコアは関心との関連度であり重要度ではない
- 一覧は読む候補の上限（既定 5）で制限しない。保存期間・件数・取得間隔は設定可能で、情報源ごとの条件を優先する。同じ記事を重複登録しない
- 認証を外した状態・認証関数を関連付けない状態で CloudFront に配信しない。パスワード・ハッシュをコード・Git・state・ログ・フロントエンドに置かない
- SSR・Server Actions・API Routes 等の実行時サーバー機能を使わない。サブパスのページを増やさない。DB・常時稼働サーバーを追加しない
- 1 日の AI 送信上限（既定 30）・読む候補上限（既定 5、埋めない）・評価キャッシュ（前提が同じなら再評価しない）を壊さない
- Lambda のイメージ参照は Terraform（`release.auto.tfvars` の SHA → digest）だけが管理する。Web 配置で `data/` を消さない。情報源の設定変更はイメージの再発行→apply で反映
- AWS リソースの作成・apply・destroy・公開・本番バッチ起動・Bedrock の利用手続き（同意・課金）はユーザーの確認なしに行わない
- モデル ID・料金・提供状況は推測で書かない（公式ドキュメント・AWS Price List で確認）
