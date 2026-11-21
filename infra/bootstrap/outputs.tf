output "tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

output "subscription_id" {
  value = var.subscription_id
}

output "tfstate_resource_group_name" {
  value = azurerm_resource_group.tfstate.name
}

output "tfstate_storage_account_name" {
  value = azurerm_storage_account.tfstate.name
}

output "tfstate_container_name" {
  value = azurerm_storage_container.tfstate.name
}

output "app_resource_group_name" {
  value = azurerm_resource_group.app.name
}

output "github_plan_client_id" {
  description = "GitHub Environment 'plan' の変数 AZURE_CLIENT_ID に設定する（秘密情報ではない）"
  value       = azurerm_user_assigned_identity.gh_plan.client_id
}

output "github_deploy_client_id" {
  description = "GitHub Environment 'production' の変数 AZURE_CLIENT_ID に設定する（秘密情報ではない）"
  value       = azurerm_user_assigned_identity.gh_deploy.client_id
}

output "backend_hcl" {
  description = "infra/app/backend.hcl に保存する内容"
  value       = <<-EOT
    resource_group_name  = "${azurerm_resource_group.tfstate.name}"
    storage_account_name = "${azurerm_storage_account.tfstate.name}"
    container_name       = "${azurerm_storage_container.tfstate.name}"
    key                  = "app.tfstate"
    use_azuread_auth     = true
  EOT
}
