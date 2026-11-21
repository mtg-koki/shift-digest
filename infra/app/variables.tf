variable "subscription_id" {
  description = "対象の Azure サブスクリプション ID"
  type        = string
}

variable "app_resource_group_name" {
  description = "ブートストラップで作成したアプリ用 RG 名"
  type        = string
}

variable "name_prefix" {
  description = "リソース名の接頭辞（ブートストラップと同じ値）"
  type        = string
  default     = "shiftdg"
  validation {
    condition     = can(regex("^[a-z0-9]{3,10}$", var.name_prefix))
    error_message = "name_prefix must be 3-10 lowercase letters or digits."
  }
}

# ---------------- イメージ ----------------
variable "image_registry" {
  description = "コンテナーレジストリ（GHCR を使用し ACR は作らない）"
  type        = string
  default     = "ghcr.io"
}

variable "image_namespace" {
  description = "GHCR の名前空間（GitHub ユーザー名・小文字）"
  type        = string
  default     = "mtg-koki"
}

variable "image_tag" {
  description = "デプロイするイメージタグ。Git commit SHA（不変タグ）。release.auto.tfvars で管理"
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.image_tag))
    error_message = "image_tag must be a full 40-char git commit SHA (do not use latest)."
  }
}

variable "ghcr_pull_username" {
  description = "GHCR を非公開にする場合のみ設定（GitHub ユーザー名）。空なら公開イメージとして匿名 pull"
  type        = string
  default     = ""
}

variable "ghcr_pull_token" {
  description = "非公開 GHCR 用の read:packages トークン。Terraform state に保存される点に注意（README 参照）"
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------- サイズ・スケール ----------------
variable "web_cpu" {
  description = "Web の vCPU（Consumption の有効な組み合わせ: 0.25/0.5Gi, 0.5/1Gi, ...）"
  type        = number
  default     = 0.25
}

variable "web_memory" {
  type    = string
  default = "0.5Gi"
}

variable "web_max_replicas" {
  type    = number
  default = 1
}

variable "batch_cpu" {
  type    = number
  default = 0.25
}

variable "batch_memory" {
  type    = string
  default = "0.5Gi"
}

variable "batch_cron" {
  description = "Container Apps Jobs の cron は UTC で評価される。0 22 * * * = 毎日 07:00 JST"
  type        = string
  default     = "0 22 * * *"
}

variable "batch_timeout_seconds" {
  description = "1 実行（レプリカ）の最大秒数"
  type        = number
  default     = 1200
}

variable "batch_retry_limit" {
  description = "失敗時の再試行回数（再試行しても AI 呼び出しは日次上限内に収まる）"
  type        = number
  default     = 1
}

# ---------------- アプリ設定（秘密でない値のみ） ----------------
variable "ai_provider" {
  description = "mock / claude / azure-openai"
  type        = string
  default     = "mock"
  validation {
    condition     = contains(["mock", "claude", "azure-openai"], var.ai_provider)
    error_message = "ai_provider must be mock, claude or azure-openai."
  }
}

variable "ai_model" {
  description = "AI モデル名（利用可能なものを確認してから設定）"
  type        = string
  default     = ""
}

variable "batch_extra_env" {
  description = "バッチの追加環境変数（秘密でない値のみ。例: MAX_AI_ARTICLES_PER_DAY）"
  type        = map(string)
  default     = {}
}

# ---------------- ログ ----------------
variable "enable_log_analytics" {
  description = "false にするとログを保存しない（リアルタイムのログストリームのみ）"
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Log Analytics の保存期間（日）"
  type        = number
  default     = 30
}

variable "log_daily_quota_gb" {
  description = "Log Analytics の 1 日あたり取り込み上限（GB）。超過分は破棄される"
  type        = number
  default     = 0.1
}

# ---------------- 予算通知 ----------------
variable "budget_contact_emails" {
  description = "予算通知の送信先。空なら予算を作らない。個人情報のため tfvars（git 管理外）か CI 変数で渡す"
  type        = list(string)
  default     = []
}

variable "budget_amount" {
  description = "アプリ RG の月額予算（請求通貨建て。JPY 請求なら 500 = 500 円）"
  type        = number
  default     = 500
}

variable "budget_start_date" {
  description = "予算の開始日（月初、RFC3339）"
  type        = string
  default     = "2026-12-01T00:00:00Z"
}

variable "tags" {
  type    = map(string)
  default = {}
}
