variable "subscription_id" {
  description = "対象の Azure サブスクリプション ID"
  type        = string
}

variable "location" {
  description = "リージョン。利用可否・料金は公式情報で確認すること"
  type        = string
  default     = "japaneast"
}

variable "name_prefix" {
  description = "リソース名の接頭辞（英小文字・数字のみ、3〜10文字）"
  type        = string
  default     = "shiftdg"
  validation {
    condition     = can(regex("^[a-z0-9]{3,10}$", var.name_prefix))
    error_message = "name_prefix must be 3-10 lowercase letters or digits."
  }
}

variable "github_repository" {
  description = "OIDC を許可する GitHub リポジトリ（owner/name）"
  type        = string
  default     = "mtg-koki/shift-digest"
}

variable "tags" {
  description = "追加タグ"
  type        = map(string)
  default     = {}
}
