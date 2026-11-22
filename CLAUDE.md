# CLAUDE.md

Shift Digest: RSS で新着記事を集め、関心に合いそうな「読む候補」を推薦する**自分専用**ダッシュボード。詳細は README.md。

## 構成（AWS）

- Web: Next.js App Router を静的エクスポート（`out/`）→ S3（非公開）+ CloudFront（OAC）。画面は `index.html` 1 枚で、クエリ（`/?date=` `/?view=archive` `/?view=saved` `&category=`）で切り替え
- アクセス制御: CloudFront Functions（viewer-request、全ビヘイビア）の Basic 認証 `infra/app/functions/basic-auth.js`。期待値は KeyValueStore の `basic-auth-sha256`（CLI で投入、Terraform・Git に入れない。未設定なら全員 401）
- データ: ブラウザーが同一オリジンの `/data/*.json` を fetch。既読・非表示・保存は localStorage のみ（同期なし）
- バッチ: EventBridge Scheduler（毎朝 7:00 Asia/Tokyo）→ Lambda コンテナー（`Dockerfile.lambda`、x86_64、VPC なし）
- AI: Amazon Bedrock Converse のみ（`src/batch/assess/bedrock.ts`）。タイトル等のメタデータから関心度・分類・推薦理由。モデル ID 未設定ならルールベース
- S3 は 2 バケット: site（Web ＋ `data/`）と internal（`state/` `locks/`。配信しない）
- IaC: `infra/bootstrap` → `infra/app`。CI/CD は GitHub Actions + OIDC、apply 等は手動かつ `production` の承認付き

## コマンド

```bash
npm run check            # lint + typecheck + test（変更後は必ず通す）
npm run batch:offline    # 架空の情報源・フィードでバッチ（ネットワーク・AI なし）
npm run dev              # 表示確認
npm run build && npm run preview   # 静的配信の確認（PREVIEW_AUTH_HASH で認証も再現）
terraform fmt -recursive infra && terraform -chdir=infra/app validate   # init -backend=false 後
```

## 守ること

- 情報源の利用条件（`config/sources.json` の `terms`）: `unknown` を許可と扱わない。取得は enabled かつ fetch・display が allowed/conditional のときだけ、AI 送信はさらに aiMetadata も必要。規約の内容・実在しない URL を推測で書かない。既定は無効
- 本文・説明文・画像を取得・保存・AI 送信しない（`fullText` は未実装の拡張）。タイトルから作った文章を「要約」と表示しない
- AI に渡すのは記事 ID・タイトル・媒体名・公開日時・関心テーマだけ。URL は渡さず、AI 出力の URL は採用しない。出力は `parseAssessments` で検証（未知/重複 ID・不正スコアを拒否）。toolConfig を渡さない
- 外部 URL は `src/batch/net.ts` の検査（https のみ・内部アドレス拒否・リダイレクト先検査・サイズ/時間制限）を通す。XML の実体宣言は拒否
- 画面に HTML を埋め込まない（`dangerouslySetInnerHTML` 禁止）。リンクは `safeHref` で http(s) のみ
- 文言は「今日の読む候補」「関心に合いそう」「タイトル等に基づく推薦」。「必読」等を使わない。スコアは関心との関連度であり重要度ではない
- 認証を外した状態・認証関数を関連付けない状態で CloudFront に配信しない。パスワード・ハッシュをコード・Git・state・ログ・フロントエンドに置かない
- SSR・Server Actions・API Routes 等の実行時サーバー機能を使わない。サブパスのページを増やさない
- 1 日の AI 送信上限（既定 30）・読む候補上限（既定 5、埋めない）・評価キャッシュ（前提が同じなら再評価しない）を壊さない
- Lambda のイメージ参照は Terraform（`release.auto.tfvars` の SHA → digest）だけが管理する。Web 配置で `data/` を消さない
- AWS リソースの作成・apply・destroy・公開・本番バッチ起動・Bedrock の利用手続き（同意・課金）はユーザーの確認なしに行わない
- モデル ID・料金・提供状況は推測で書かない（公式ドキュメント・AWS Price List で確認）
