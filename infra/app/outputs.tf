output "web_url" {
  value = "https://${azurerm_container_app.web.ingress[0].fqdn}"
}

output "job_name" {
  value = azurerm_container_app_job.batch.name
}

output "resource_group_name" {
  value = local.rg
}

output "storage_account_name" {
  value = azurerm_storage_account.data.name
}

output "web_image" {
  value = local.web_image
}

output "batch_image" {
  value = local.job_image
}
