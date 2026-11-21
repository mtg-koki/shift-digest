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

  # 値は backend.hcl（git 管理外）または CI の -backend-config で渡す（部分構成）
  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  # CI の ID は RG スコープの権限しか持たないため、プロバイダー登録は行わない
  # （必要な登録は README の手順でサブスクリプション所有者が 1 回実施）
  resource_provider_registrations = "none"
}
