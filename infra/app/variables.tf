variable "aws_region" {
  description = "リージョン。bootstrap と同じにする（ECR と Lambda は同一リージョン）"
  type        = string
  default     = "ap-northeast-1"
}

variable "name_prefix" {
  description = "リソース名の接頭辞。bootstrap と同じ値（CI ロールの権限範囲がこの名前に依存する）"
  type        = string
  default     = "shift-digest"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.name_prefix))
    error_message = "name_prefix must be 3-21 chars: lowercase letters, digits, hyphens."
  }
}

variable "name_index" {
  description = "リソース名の末尾の連番（命名規則 <name_prefix>-<略称>[-<用途>]-<連番>）。アプリ層と同じ値にする"
  type        = string
  default     = "01"
  validation {
    condition     = can(regex("^[0-9]{2}$", var.name_index))
    error_message = "name_index must be two digits (e.g. 01)."
  }
}

variable "permissions_boundary_arn" {
  description = "bootstrap の出力 app_permissions_boundary_arn"
  type        = string
}

variable "ecr_repository_name" {
  description = "bootstrap で作った ECR リポジトリ名（既定 <name_prefix>-ecr-<name_index>）"
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Lambda に使うイメージのタグ（Git commit SHA 40 桁）。release.auto.tfvars で管理する"
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.image_tag))
    error_message = "image_tag must be a 40-char git commit SHA (latest is not allowed)."
  }
}

# ---------------- Bedrock ----------------
variable "bedrock_model_id" {
  description = <<-EOT
    Bedrock のモデル ID または推論プロファイル ID。空ならルールベース評価（AI 不使用・費用なし）。
    例（2026-11-22 に公式情報で確認。README 参照）:
      jp.anthropic.claude-haiku-5-5   … 日本国内（東京・大阪）のクロスリージョン推論
      amazon.nova-lite-v1:0           … 東京リージョン内のオンデマンド推論
  EOT
  type        = string
  default     = ""
  validation {
    condition     = var.bedrock_model_id == "" || can(regex("^[a-z0-9.:-]+$", var.bedrock_model_id))
    error_message = "bedrock_model_id has invalid characters."
  }
}

variable "bedrock_destination_regions" {
  description = <<-EOT
    地域別（jp. / apac. 等）推論プロファイルの推論先リージョン。IAM で各リージョンの基盤モデルを許可するために使う。
    jp. プロファイルは ap-northeast-1（東京）と ap-northeast-3（大阪）。プロファイルを変えたら公式情報で確認して合わせる。
    リージョン内のモデル ID・global. プロファイルの場合は使わない。
  EOT
  type        = list(string)
  default     = ["ap-northeast-1", "ap-northeast-3"]
}

# ---------------- Lambda / スケジュール ----------------
variable "lambda_architecture" {
  description = "Lambda の CPU アーキテクチャ。イメージのビルド対象（CI の platform）と一致させる"
  type        = string
  default     = "x86_64"
  validation {
    condition     = contains(["x86_64", "arm64"], var.lambda_architecture)
    error_message = "lambda_architecture must be x86_64 or arm64."
  }
}

variable "lambda_memory_mb" {
  type    = number
  default = 512
}

variable "lambda_timeout_seconds" {
  description = "Lambda の最大実行時間（上限 900 秒）。バッチはこれより 90 秒以上前に処理を打ち切る"
  type        = number
  default     = 900
  validation {
    condition     = var.lambda_timeout_seconds >= 120 && var.lambda_timeout_seconds <= 900
    error_message = "lambda_timeout_seconds must be 120-900."
  }
}

variable "lambda_reserved_concurrency" {
  description = <<-EOT
    同時実行数の予約。1 にすると多重実行を Lambda 側でも防げるが、新規アカウント等で同時実行クォータが小さいと
    作成に失敗するため既定は未設定（null）。多重実行はバッチ内の S3 ロックで防いでいる。
  EOT
  type        = number
  default     = null
}

variable "lambda_async_retries" {
  description = "非同期呼び出し（スケジュール・手動）でバッチが失敗したときの Lambda の再試行回数（0〜2）"
  type        = number
  default     = 1
}

variable "schedule_expression" {
  description = "EventBridge Scheduler の式。タイムゾーンは schedule_timezone で解釈される"
  type        = string
  default     = "cron(0 7 * * ? *)"
}

variable "schedule_timezone" {
  type    = string
  default = "Asia/Tokyo"
}

variable "schedule_flexible_window_minutes" {
  description = "Flexible time window（分）。0 なら OFF（毎朝 7:00 ちょうどに起動）。分散させたい場合のみ 1〜1440"
  type        = number
  default     = 0
}

variable "schedule_enabled" {
  description = "false で日次実行を止める（関数・データは残る）"
  type        = bool
  default     = true
}

variable "batch_settings" {
  description = "バッチの環境変数（件数・期間・上限）。キーと意味は .env.example 参照"
  type        = map(string)
  default = {
    MAX_AI_ARTICLES_PER_DAY        = "30"
    MAX_AI_ARTICLES_PER_SOURCE     = "10"
    AI_BATCH_SIZE                  = "10"
    AI_MAX_OUTPUT_TOKENS           = "2000"
    AI_MAX_RETRIES                 = "2"
    AI_TIMEOUT_MS                  = "60000"
    MAX_RECOMMENDATIONS            = "5"
    MAX_RECOMMENDATIONS_PER_SOURCE = "2"
    MIN_RELEVANCE_SCORE            = "60"
    LOOKBACK_HOURS                 = "48"
    MAX_ITEMS_PER_SOURCE           = "30"
    FEED_TIMEOUT_MS                = "15000"
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs の保存日数"
  type        = number
  default     = 30
}

# ---------------- CloudFront ----------------
variable "cloudfront_price_class" {
  description = "PriceClass_200 は日本を含む。PriceClass_100 は北米・欧州のみ（日本からは遠いエッジになる）"
  type        = string
  default     = "PriceClass_200"
}

# ---------------- 通知・予算 ----------------
variable "alert_emails" {
  description = "バッチ失敗通知（SNS メール）の宛先。リポジトリには書かず TF_VAR_alert_emails 等で渡す。空なら購読なし"
  type        = list(string)
  default     = []
  sensitive   = true
}

variable "budget_monthly_usd" {
  description = "AWS Budgets の月額予算（USD、アカウント全体）。0 なら作らない。通知のみで課金は止まらない"
  type        = number
  default     = 5
}

variable "budget_emails" {
  description = "予算通知の宛先。空なら予算を作らない"
  type        = list(string)
  default     = []
  sensitive   = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
