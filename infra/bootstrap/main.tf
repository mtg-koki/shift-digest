# ブートストラップ層:
# - Terraform state 保管用 Storage（アプリ用とは別 RG・別アカウント）
# - アプリ用 Resource Group（CI の権限をこの RG に限定するためにここで作る）
# - GitHub Actions 用 Managed Identity + OIDC フェデレーション + 最小権限
#
# サブスクリプションの Owner（またはロール割り当て権限を持つ人）が手元で 1 回実行する。
# 最初はローカル state。作成後に README の手順で remote state へ移行できる。

terraform {
  required_version = ">= 1.9.0, < 2.0.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.14"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}

data "azurerm_client_config" "current" {}

locals {
  tags               = merge({ project = var.name_prefix, managed-by = "terraform", layer = "bootstrap" }, var.tags)
  github_oidc_issuer = "https://token.actions.githubusercontent.com"
}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

# ---------------- state 保管用 ----------------
resource "azurerm_resource_group" "tfstate" {
  name     = "rg-${var.name_prefix}-tfstate"
  location = var.location
  tags     = local.tags
}

resource "azurerm_storage_account" "tfstate" {
  name                            = "st${var.name_prefix}tf${random_string.suffix.result}"
  resource_group_name             = azurerm_resource_group.tfstate.name
  location                        = azurerm_resource_group.tfstate.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  # state へのアクセスは Entra ID（RBAC）のみ。アカウントキーは無効化
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true

  blob_properties {
    # 誤更新・誤削除からの復旧用
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
  }
  tags = local.tags
}

resource "azurerm_storage_container" "tfstate" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.tfstate.id
  container_access_type = "private"
}

# state 保管アカウントの誤削除防止（削除時はロックを先に外す）
resource "azurerm_management_lock" "tfstate" {
  name       = "protect-tfstate"
  scope      = azurerm_storage_account.tfstate.id
  lock_level = "CanNotDelete"
  notes      = "Terraform state storage. Remove this lock deliberately before deleting."
}

# 実行者自身が state を読み書きできるようにする
resource "azurerm_role_assignment" "operator_state" {
  scope                = azurerm_storage_container.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

# ---------------- アプリ用 RG ----------------
resource "azurerm_resource_group" "app" {
  name     = "rg-${var.name_prefix}-app"
  location = var.location
  tags     = merge(local.tags, { layer = "app" })
}

# ---------------- GitHub Actions 用 ID（OIDC） ----------------
# plan 用: 読み取り＋state ロック。GitHub Environment "plan" からのみ使える
resource "azurerm_user_assigned_identity" "gh_plan" {
  name                = "id-${var.name_prefix}-gh-plan"
  resource_group_name = azurerm_resource_group.tfstate.name
  location            = azurerm_resource_group.tfstate.location
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "gh_plan" {
  name                      = "github-env-plan"
  user_assigned_identity_id = azurerm_user_assigned_identity.gh_plan.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = local.github_oidc_issuer
  subject                   = "repo:${var.github_repository}:environment:plan"
}

# deploy 用: apply・ジョブ手動実行。承認必須の GitHub Environment "production" からのみ使える
resource "azurerm_user_assigned_identity" "gh_deploy" {
  name                = "id-${var.name_prefix}-gh-deploy"
  resource_group_name = azurerm_resource_group.tfstate.name
  location            = azurerm_resource_group.tfstate.location
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "gh_deploy" {
  name                      = "github-env-production"
  user_assigned_identity_id = azurerm_user_assigned_identity.gh_deploy.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = local.github_oidc_issuer
  subject                   = "repo:${var.github_repository}:environment:production"
}

resource "azurerm_role_assignment" "plan_reader" {
  scope                = azurerm_resource_group.app.id
  role_definition_name = "Reader"
  principal_id         = azurerm_user_assigned_identity.gh_plan.principal_id
}

resource "azurerm_role_assignment" "plan_state" {
  scope                = azurerm_storage_container.tfstate.id
  role_definition_name = "Storage Blob Data Contributor" # plan 時の state ロック（リース）に書き込みが必要
  principal_id         = azurerm_user_assigned_identity.gh_plan.principal_id
}

resource "azurerm_role_assignment" "deploy_contributor" {
  scope                = azurerm_resource_group.app.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.gh_deploy.principal_id
}

resource "azurerm_role_assignment" "deploy_state" {
  scope                = azurerm_storage_container.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.gh_deploy.principal_id
}

# アプリ層がアプリ用 ID に Blob の権限を付与するためのロール割り当て権限。
# 条件により、付与・削除できるロールを Storage Blob Data Reader / Contributor に限定する。
locals {
  assignable_role_ids = join(", ", [
    "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1", # Storage Blob Data Reader
    "ba92f5b4-2d11-453d-a403-e96b0029c9fe", # Storage Blob Data Contributor
  ])
}

resource "azurerm_role_assignment" "deploy_rbac_admin" {
  scope                = azurerm_resource_group.app.id
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azurerm_user_assigned_identity.gh_deploy.principal_id
  condition_version    = "2.0"
  condition            = <<-EOT
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
     )
     OR
     (
      @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.assignable_role_ids}}
     )
    )
    AND
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})
     )
     OR
     (
      @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.assignable_role_ids}}
     )
    )
  EOT
}
