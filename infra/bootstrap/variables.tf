variable "aws_region" {
  description = "リージョン（Lambda・ECR・S3 を置く場所）。既定は東京"
  type        = string
  default     = "ap-northeast-1"
}

variable "name_prefix" {
  description = "リソース名の接頭辞（英小文字・数字・ハイフン）。アプリ層と同じ値にする"
  type        = string
  default     = "shift-digest"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.name_prefix))
    error_message = "name_prefix must be 3-21 chars: lowercase letters, digits, hyphens."
  }
}

variable "github_repository" {
  description = "OIDC を許可する GitHub リポジトリ（owner/name）。ワイルドカード不可"
  type        = string
  default     = "mtg-koki/shift-digest"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be owner/name without wildcards."
  }
}

variable "github_oidc_provider_arn" {
  description = <<-EOT
    既存の GitHub OIDC プロバイダー（token.actions.githubusercontent.com）の ARN。
    アカウントに既にある場合は必ず指定する（同じ URL のプロバイダーは 1 アカウントに 1 つしか作れない）。
    空なら新規作成する。確認: aws iam list-open-id-connect-providers
  EOT
  type        = string
  default     = ""
}

variable "ecr_keep_tagged_images" {
  description = "ECR に残すタグ付きイメージ数（実行中・ロールバック用。これより古いものは自動削除）"
  type        = number
  default     = 15
}

variable "tags" {
  description = "追加タグ"
  type        = map(string)
  default     = {}
}
