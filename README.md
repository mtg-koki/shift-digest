# Shift Digest

技術・雇用・所有・制度の最新情報を、日本語で短時間にキャッチアップするための個人向けニュースまとめサイト。

- ニュースをまとめて読むだけのサイト。キャリア助言・投資助言・行動提案・自己分析は行わない。
- 要約は出典（主に RSS の説明文）に書かれた事実に限定し、予測や意見を事実として加えない。
- Web と日次バッチは別コンテナー。日次更新は Blob のデータを書き換えるだけで、再ビルド・再デプロイ・Terraform 実行は行わない。

## 構成

```
                          （コード更新時）
GitHub ── CI: lint / 型 / テスト / build / docker build / terraform validate
   │
   ├─ Publish images（手動） ── docker push ──▶ GHCR  ghcr.io/<owner>/shift-digest-{web,batch}:<commit SHA>
   │                                              │ pull
   └─ Terraform（手動, 承認付き apply） ──▶ Azure  ▼
                                      ┌──────────────────────── rg-<prefix>-app ─────────────────────────┐
 ブラウザー ──HTTPS──▶ Container App（Web, 0〜1 レプリカ）──読み取り(MI: Blob Data Reader)──▶ Blob Storage │
                                      │                                                    ▲  digest/    │
                                      │  Container Apps Job（毎日 07:00 JST）──読み書き(MI)──┘  ├ index.json│
                                      │    ├ RSS / Atom 取得（公式発表優先）                    ├ reports/  │
                                      │    └ AI API で日本語要約・分類（mock / Claude / Azure OpenAI）       │
                                      │  Log Analytics（保存30日・日次上限0.1GB） / 予算通知                 │
                                      └──────────────────────────────────────────────────────────────────┘
                                      ┌──── rg-<prefix>-tfstate ────┐
                                      │ Terraform state 用 Storage   │  ← アプリとは別 RG・別アカウント
                                      │ GitHub OIDC 用 Managed ID    │
                                      └──────────────────────────────┘
```

| ディレクトリ | 内容 |
|---|---|
| `app/` | Next.js（App Router）の画面 |
| `src/web/` | Web のデータ読み込み・表示コンポーネント |
| `src/batch/` | 収集・選定・要約バッチ |
| `src/shared/` | 共通（スキーマ、日付、URL 正規化、ストレージ） |
| `config/sources.json` | 取得元設定 |
| `sample-data/` | 表示確認用の**架空**データ（example.com） |
| `infra/bootstrap/` | state 保管・アプリ RG・CI 用 ID（最初に 1 回） |
| `infra/app/` | アプリ本体のリソース |
| `.github/workflows/` | CI / イメージ公開 / Terraform / バッチ手動実行 |

### Blob のデータ配置

| キー | 内容 |
|---|---|
| `reports/YYYY-MM-DD.json` | 日次まとめ（日付は Asia/Tokyo） |
| `index.json` | latest 参照と日付一覧。**日次データの保存・読み戻し検証が終わってから**更新 |
| `status/last-run.json` | 直近の実行結果（失敗時もここだけ更新） |
| `state/seen.json` | 既出 URL・要約キャッシュ・日別 AI 使用量 |
| `locks/batch.lock` | 多重実行防止（Blob リース。異常終了しても 60 秒以内に自動解放） |

時刻はすべて UTC の ISO 8601（`2026-11-20T22:00:00.000Z`）で保存し、表示時に JST へ変換する。

## ローカル起動

前提: Node.js 22.12 以上（開発は 24 で確認）。

```bash
npm ci
npm run seed:sample      # sample-data/ を ./data にコピー（架空データ）
npm run dev              # http://localhost:3000
```

### AI なしのサンプル実行（バッチ）

```bash
# 1) ネットワークも AI も使わない（架空フィードを生成して処理）
npm run batch:offline

# 2) 実在の RSS を取得し、要約はモック（AI 不使用・API 費用なし）
npm run batch
```

既定は `AI_PROVIDER=mock`。モックは説明文をそのまま短く使い、分類はキーワードで行う（重要度は判定しない）。
画面では「AI未使用（サンプル要約）」と表示される。出力先は `LOCAL_DATA_DIR`（既定 `./data`）。

```bash
npm run check            # lint + 型チェック + テスト
npm run build            # Next.js build
```

### Docker（ローカル）

```bash
docker build -f Dockerfile.web   -t shift-digest-web .
docker build -f Dockerfile.batch -t shift-digest-batch .
docker run --rm -p 3000:3000 -v "$PWD/data:/data" -e LOCAL_DATA_DIR=/data shift-digest-web
docker run --rm -v "$PWD/data:/data" -e LOCAL_DATA_DIR=/data shift-digest-batch
```

> ローカルの `data/` を書き込む場合はコンテナー内ユーザー（`node`, uid 1000）に書き込み権限が必要。

## バッチの動作

1. ロック取得（取れなければ別実行中としてスキップ）
2. 当日（JST）の `reports/<日付>.json` があればスキップ（`--force` / `FORCE=true` で作り直し）
3. 各取得元を取得（一部失敗は `partial` として継続。全失敗は `failed` として index を更新しない）
4. 対象期間（既定 48 時間）外・日時不明の記事を除外（初回でも古い記事を大量に処理しない）
5. URL 正規化とタイトル類似度で重複を除外。過去日に掲載済み・直近 7 日の掲載と同じニュースも除外
6. 要約: キャッシュがあれば再利用。AI 呼び出しは**日付単位で**最大 10 件（再実行を含む）
7. AI 出力を JSON スキーマで検証（URL を含む出力・不正な分類は破棄）。重要度順に最大 5 件掲載
8. `reports/<日付>.json` 保存 → 読み戻し検証 → `state` 更新 → `index.json` 更新 → `last-run.json`

| 状態 | report | index（latest） | 画面 |
|---|---|---|---|
| 正常（記事あり / 0 件） | 作成 | 更新 | まとめ / 「掲載対象のニュースがありませんでした」 |
| 一部取得元失敗 | 作成（`partial`） | 更新 | 失敗した取得元名を表示 |
| 全取得元失敗・途中失敗 | 作らない | **前回のまま** | 前回データ＋「更新に失敗」表示 |

### AI 処理の制御

- 記事は `<article>` 内の JSON データとして渡し、記事中の命令に従わないようシステムプロンプトで指示。AI にはツール・権限を一切渡さない（テキスト入出力のみ）
- 出典 URL・日時・出典名はプログラムが保持し、AI には生成させない
- 説明文がない記事は `title_only`、説明文のみなら `rss_description` としてデータに保持し、AI にも伝える（本文取得は未実装）
- 上限（設定可能）: 入力 3000 文字/記事、出力 2048 トークン、リトライ 2 回、1 リクエスト 60 秒、バッチ全体はジョブのタイムアウト −60 秒
- トークン使用量は `reports/*.json` の `stats.usage` と `state/seen.json` の `usageByDate` に記録

### AI プロバイダー

| `AI_PROVIDER` | 状態 |
|---|---|
| `mock`（既定） | 実装・テスト済み。費用なし |
| `claude` | 公式 SDK（`@anthropic-ai/sdk`）で実装。**実 API では未検証**。構造化出力（JSON Schema）を使用。拒否時のサーバー側フォールバック（beta, `CLAUDE_FALLBACKS=default`）を既定で有効化 |
| `azure-openai` | REST で最小実装。**実環境では未検証** |

モデル名に既定値は置いていない。利用可能なモデル・料金を確認して `AI_MODEL` に設定する（Claude の例: `claude-opus-5-5`。費用を抑える場合は各モデルの料金を確認して選ぶ）。
**AI API の従量課金は、Claude Code の利用料金とは別に請求される。**

## 取得元の追加

`config/sources.json` に追記する。

```json
{
  "id": "example",                 // 英小文字・数字・ハイフン
  "name": "表示名",
  "url": "https://…/feed.xml",     // RSS 1.0 / RSS 2.0 / Atom
  "enabled": true,
  "defaultCategory": "tech",       // tech / employment / ownership / policy
  "priority": 1,                   // 小さいほど優先。公式発表・一次情報は 1
  "official": true,
  "allowFullText": false,          // 本文取得（未実装）。利用条件を確認したものだけ true に
  "termsNote": "確認日・確認内容"
}
```

- 実在・応答を確認したフィードだけを追加する（現在の取得元は 2026-11-21 に応答を確認済み。各サイトの利用規約の確認は未了）
- 有料記事・認証の回避はしない。記事全文は保存・転載しない（保存するのはタイトル・説明文に基づく短い要約と出典リンク）
- 取得は 1 日 1 回・各取得元 1 リクエスト。タイムアウト 15 秒・最大 2MB
- イメージに同梱されるため、反映には「Publish images」→ Terraform apply が必要

## Azure へのデプロイ

### 必要な権限・認証情報

| 用途 | 必要なもの |
|---|---|
| ブートストラップ（手元） | Azure CLI でログインした、サブスクリプションの Owner（ロール割り当てが必要） |
| GitHub Actions → Azure | OIDC（Managed Identity のフェデレーション資格情報）。**クライアントシークレットは不要** |
| GHCR push | ワークフローの `GITHUB_TOKEN`（`packages: write`） |
| GHCR pull | 公開イメージなら不要。非公開なら read:packages のトークン（後述） |
| AI API | `AI_PROVIDER` を mock 以外にする場合のみ。値は Terraform 外で設定（後述） |

### 1. ブートストラップ（state 保管・アプリ RG・CI 用 ID）

```bash
az login
az account set --subscription <SUBSCRIPTION_ID>
# Container Apps 等のリソースプロバイダー登録（初回のみ。アプリ層は登録を行わない設定）
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Storage Microsoft.ManagedIdentity Microsoft.Consumption; do
  az provider register --namespace $ns
done

cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars   # subscription_id 等を記入
terraform init
terraform plan -out=tfplan
terraform apply tfplan
terraform output -raw backend_hcl > ../app/backend.hcl   # git 管理外
```

作成されるもの: `rg-<prefix>-tfstate`（state 用 Storage、CI 用 ID 2 つ）、`rg-<prefix>-app`（空の RG）。

**state バックエンドの保護方針**
- アプリ用とは別 RG・別 Storage。アカウントキー無効（Entra ID 認証のみ）、匿名アクセス無効、TLS1.2 以上
- Blob バージョニング＋削除保持 30 日、Storage に削除ロック（`CanNotDelete`）
- 読み書きできるのは実行者と CI 用 ID のみ（コンテナー単位の `Storage Blob Data Contributor`）

**CI 用 ID の権限（最小化）**
- `id-<prefix>-gh-plan`（GitHub Environment `plan` からのみ使用可）: アプリ RG の `Reader`、state コンテナーの読み書き（ロック用）
- `id-<prefix>-gh-deploy`（Environment `production` からのみ）: アプリ RG の `Contributor`、state コンテナーの読み書き、アプリ RG の `Role Based Access Control Administrator`（**付与できるロールを Storage Blob Data Reader / Contributor に条件で限定**）

### 2. state の移行（ブートストラップ自身の state をリモートへ）

ブートストラップは最初ローカル state（`infra/bootstrap/terraform.tfstate`、git 管理外）で作る。リモートへ移す場合:

```bash
cd infra/bootstrap
cp backend.tf.example backend.tf
terraform init -migrate-state -backend-config=../app/backend.hcl -backend-config="key=bootstrap.tfstate"
# 移行を確認後、ローカルの terraform.tfstate* を安全に削除
```

アプリ層（`infra/app`）は最初からリモート state を使う。
state・plan ファイルは公開リポジトリやワークフローのアーティファクトに出さない（`.gitignore` 済み、ワークフローでも保存しない）。

### 3. GitHub の設定

Environments（Settings → Environments）:
- `plan`: 保護ルールなし
- `production`: **Required reviewers に自分を設定**（apply とバッチ手動実行の承認に使う）。公開リポジトリでは GitHub Free でも Environment を使える（非公開リポジトリでは GitHub Pro / Team 以上が必要）

Variables（Repository variables。秘密情報ではない）:

| 変数 | 値 |
|---|---|
| `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` | `terraform output` の値 |
| `TFSTATE_RESOURCE_GROUP` / `TFSTATE_STORAGE_ACCOUNT` | 同上 |
| `APP_RESOURCE_GROUP` | `rg-<prefix>-app` |
| `NAME_PREFIX` | bootstrap と同じ |
| `IMAGE_NAMESPACE` | GHCR の名前空間（小文字の GitHub ユーザー名） |
| `AI_PROVIDER` / `AI_MODEL` | 既定 mock / 空 |

Environment variables: `plan` と `production` それぞれに `AZURE_CLIENT_ID`（`github_plan_client_id` / `github_deploy_client_id`）。
Environment secret（任意）: `BUDGET_CONTACT_EMAILS` に `["you@example.com"]` 形式。メールアドレスはリポジトリに書かない。

### 4. 初回のイメージ公開とデプロイ

1. Actions → **Publish images** を実行（GHCR に `<commit SHA>` タグで push。latest は付けない）
2. GHCR のパッケージは**初回は非公開**で作られる。公開イメージで運用する場合は各パッケージの Settings → Change visibility → Public（**一度公開すると非公開に戻せない**）
3. `infra/app/release.auto.tfvars` の `image_tag` をその SHA に変更してコミット
4. Actions → **Terraform**（action=plan）で差分を確認
5. Actions → **Terraform**（action=apply）→ `production` の承認 → apply
6. 出力 `web_url` にアクセス（初回はコンテナー起動待ちで数秒〜数十秒かかる）

手元から行う場合:

```bash
cd infra/app
cp terraform.tfvars.example terraform.tfvars
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan && terraform apply tfplan
```

イメージの更新は常に「Publish images → `release.auto.tfvars` 更新 → plan → 承認 apply」。イメージ参照を Terraform だけが管理するため、CD と Terraform が同じ設定を競合更新しない。日次の記事更新では Terraform を実行しない。

### GHCR を非公開にする場合

`ghcr_pull_username` と `ghcr_pull_token`（read:packages のみの fine-grained/classic トークン）を設定すると、Container Apps のレジストリ認証を使う。
トークンは GitHub の Environment secret（`production`）に保存し、`TF_VAR_ghcr_pull_token` として渡す想定。**この方式ではトークンが Terraform state に平文で保存される**（`sensitive` は表示を隠すだけ）。state は前述の保護下にあるが、避けたい場合は Terraform 外で `az containerapp registry set` で設定する運用にする。

### 秘密値（AI API キー）の投入

Terraform 変数で渡すと state に残るため、Terraform ではダミー値でシークレット枠だけ作り（`ignore_changes`）、実値は帯域外で設定する。

```bash
az containerapp job secret set -n caj-<prefix>-daily -g rg-<prefix>-app \
  --secrets ai-api-key=<API キー>
```

キーを Git・イメージ・ログ・`.env.example` に含めない。`AI_PROVIDER` / `AI_MODEL` は秘密ではないので GitHub Variables → Terraform で設定する。
注意: ジョブを起動できる権限（`Microsoft.App/jobs/start/action`）を持つ ID は、実行テンプレートの上書きでジョブのシークレットを読める。起動権限は信頼できる ID に限る。

## 日次バッチの手動実行・再実行

- GitHub: Actions → **Run daily batch**（`production` の承認後に起動。`force` で当日分を作り直し）
- CLI:

```bash
az containerapp job start -n caj-<prefix>-daily -g rg-<prefix>-app
az containerapp job execution list -n caj-<prefix>-daily -g rg-<prefix>-app -o table
```

当日分があれば再実行はスキップされる。`force` でも要約キャッシュを再利用し、AI 呼び出しは日次上限（10 件）を超えない。スケジュール実行と手動実行が重なっても Blob リースで 1 つだけが処理する。
スケジュールは cron `0 22 * * *`（**Container Apps Jobs の cron は UTC で評価される** → 07:00 JST）。タイムアウト 1200 秒、リトライ 1 回。

## ログ確認と障害時の確認箇所

| 見るもの | 方法 |
|---|---|
| 画面の「最終正常更新」 | `index.json` の `lastSuccessAt` |
| 直近の実行結果 | Blob `status/last-run.json` |
| ジョブの実行履歴 | `az containerapp job execution list ...`（直近 100 件） |
| バッチのログ（JSON 1 行形式） | Log Analytics: `ContainerAppConsoleLogs_CL \| where ContainerJobName_s == "caj-<prefix>-daily"`（列名は環境により異なる場合あり） |
| リアルタイムログ | `az containerapp logs show -n ca-<prefix>-web -g rg-<prefix>-app --follow` |
| 取得元ごとの成否 | `reports/<日付>.json` の `sources` |

典型的な原因: 全取得元失敗（ネットワーク／フィード変更）→ `last-run.json` が `failed`、画面は前回データ。AI キー未設定・モデル名誤り → ログに `summarize failed`、記事は 0 件になり得る。Blob 権限不足 → Web は「データを取得できませんでした」。

## 月額費用の目安と変動要因

目標は**低アクセス時のインフラ費用 月 500 円以内（保証ではない。AI API は別枠）**。以下は 2026-11-21 時点で公式ページから確認した事項。単価・為替・リージョン差は [Azure 料金計算ツール](https://azure.microsoft.com/pricing/calculator/) で確認すること。

| 項目 | 内容 | 見込み |
|---|---|---|
| Container Apps（Consumption） | 無料枠: **サブスクリプションあたり毎月 180,000 vCPU 秒・360,000 GiB 秒・200 万リクエスト**。Web 0.25 vCPU/0.5GiB は無料枠内で稼働約 200 時間分。最小 0 レプリカのため無アクセス時はレプリカなし。ジョブは実行中のみ課金（リクエスト課金なし）、1 日数分 | 低アクセスなら無料枠内の見込み |
| Blob Storage（LRS, Hot） | 数 MB 程度＋少量のトランザクション | 数円程度の見込み |
| Log Analytics | 無料取り込み **課金アカウントあたり 5GB/月**、保存 **31 日まで無料**。本構成は保存 30 日・日次上限 0.1GB（上限超過分は破棄） | 無料枠内の見込み |
| 予算・Managed Identity・RBAC | 追加料金なし | 0 |
| GHCR | 公開パッケージ。非公開時の容量・転送量の無料枠はプランにより異なる（要確認） | 要確認 |
| AI API | **別枠**。1 日最大 10 記事 × 入出力トークン × モデル単価 | モデル次第 |

変動要因: アクセス増（Web の稼働時間、スケールダウンまでの待機時間を含む）、CPU/メモリ増、ログ量、データ転送量、**無料枠は同じサブスクリプション（Log Analytics は同じ課金アカウント）の他リソースと共有**、リージョン、為替。
CPU/メモリは最小の組み合わせ（0.25 vCPU / 0.5Gi）。ローカル実測のピークは Web 約 140MB、バッチ約 115MB（Windows・モック要約時。Azure 上では未計測）。

**予算通知はメールで知らせるだけで、支出を自動停止する仕組みではない。** 予算はアプリ RG のみが対象（state 用 RG・AI API は含まない）。

## 停止・削除

| 目的 | 方法 |
|---|---|
| 日次実行だけ止める | `batch_cron` を実行されない日付にする、またはジョブを Terraform から削除 |
| Web を止める | 0 レプリカならアクセスがなければ課金対象の稼働はない。完全に止めるなら ingress 無効化 or 削除 |
| アプリを全削除 | `cd infra/app && terraform destroy`（手元で、内容を確認してから） |
| state 等も削除 | bootstrap の `azurerm_management_lock` を外してから `cd infra/bootstrap && terraform destroy` |

**データの扱い**: `terraform destroy`（アプリ層）でデータ用 Storage も削除され、過去のまとめは消える（削除保持 7 日はアカウント削除には効かない）。残したい場合は事前に `az storage blob download-batch --auth-mode login ...` で退避する。
**state の扱い**: アプリ層を destroy しても state 用 Storage は残る（バージョニングで履歴も残る）。アプリを再作成しないなら最後に bootstrap を destroy する。bootstrap をローカル state のまま運用している場合、その `terraform.tfstate` を失うと bootstrap リソースの管理ができなくなるため安全に保管する。

## 未実装・制約

ログイン、コメント、お気に入り、全文検索、管理画面、通知、行動提案、DB、記事本文の取得は実装していない。独自ドメインなし。
