data "azurerm_resource_group" "app" {
  name = var.app_resource_group_name
}

locals {
  location         = data.azurerm_resource_group.app.location
  rg               = data.azurerm_resource_group.app.name
  tags             = merge({ project = var.name_prefix, managed-by = "terraform", layer = "app" }, var.tags)
  web_image        = "${var.image_registry}/${var.image_namespace}/shift-digest-web:${var.image_tag}"
  job_image        = "${var.image_registry}/${var.image_namespace}/shift-digest-batch:${var.image_tag}"
  private_registry = var.ghcr_pull_username != ""

  storage_env = {
    STORAGE_MODE              = "azure"
    AZURE_STORAGE_ACCOUNT_URL = azurerm_storage_account.data.primary_blob_endpoint
    AZURE_STORAGE_CONTAINER   = azurerm_storage_container.digest.name
  }
}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

# ---------------- ログ（最小限・保存期間と日次上限を明示） ----------------
resource "azurerm_log_analytics_workspace" "this" {
  count               = var.enable_log_analytics ? 1 : 0
  name                = "log-${var.name_prefix}"
  location            = local.location
  resource_group_name = local.rg
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  daily_quota_gb      = var.log_daily_quota_gb
  tags                = local.tags
}

# ---------------- Container Apps 環境（Consumption） ----------------
resource "azurerm_container_app_environment" "this" {
  name                       = "cae-${var.name_prefix}"
  location                   = local.location
  resource_group_name        = local.rg
  logs_destination           = var.enable_log_analytics ? "log-analytics" : null
  log_analytics_workspace_id = var.enable_log_analytics ? azurerm_log_analytics_workspace.this[0].id : null
  tags                       = local.tags
}

# ---------------- データ用 Storage ----------------
resource "azurerm_storage_account" "data" {
  name                       = "st${var.name_prefix}${random_string.suffix.result}"
  resource_group_name        = local.rg
  location                   = local.location
  account_tier               = "Standard"
  account_replication_type   = "LRS"
  account_kind               = "StorageV2"
  access_tier                = "Hot"
  min_tls_version            = "TLS1_2"
  https_traffic_only_enabled = true
  # Web 表示のために Blob を匿名公開しない
  allow_nested_items_to_be_public = false
  # アプリは Managed Identity + RBAC で認証。アカウントキーは無効化
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true

  blob_properties {
    delete_retention_policy {
      days = 7
    }
    container_delete_retention_policy {
      days = 7
    }
  }
  tags = local.tags
}

resource "azurerm_storage_container" "digest" {
  name                  = "digest"
  storage_account_id    = azurerm_storage_account.data.id
  container_access_type = "private"
}

# ---------------- Managed Identity と最小 RBAC ----------------
resource "azurerm_user_assigned_identity" "web" {
  name                = "id-${var.name_prefix}-web"
  location            = local.location
  resource_group_name = local.rg
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "batch" {
  name                = "id-${var.name_prefix}-batch"
  location            = local.location
  resource_group_name = local.rg
  tags                = local.tags
}

# Web: 対象コンテナーの読み取りのみ
resource "azurerm_role_assignment" "web_blob_reader" {
  scope                = azurerm_storage_container.digest.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.web.principal_id
  principal_type       = "ServicePrincipal"
}

# バッチ: 対象コンテナーの読み書きのみ（ロックのリース取得を含む）
resource "azurerm_role_assignment" "batch_blob_contributor" {
  scope                = azurerm_storage_container.digest.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.batch.principal_id
  principal_type       = "ServicePrincipal"
}

# ---------------- Web（最小 0 / 最大 1 レプリカ） ----------------
resource "azurerm_container_app" "web" {
  name                         = "ca-${var.name_prefix}-web"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = local.rg
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.web.id]
  }

  dynamic "secret" {
    for_each = local.private_registry ? [1] : []
    content {
      name  = "ghcr-pull-token"
      value = var.ghcr_pull_token
    }
  }

  dynamic "registry" {
    for_each = local.private_registry ? [1] : []
    content {
      server               = var.image_registry
      username             = var.ghcr_pull_username
      password_secret_name = "ghcr-pull-token"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = var.web_max_replicas

    container {
      name   = "web"
      image  = local.web_image
      cpu    = var.web_cpu
      memory = var.web_memory

      dynamic "env" {
        for_each = merge(local.storage_env, {
          AZURE_CLIENT_ID       = azurerm_user_assigned_identity.web.client_id
          WEB_CACHE_TTL_SECONDS = "60"
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 3000
      }
    }
  }

  depends_on = [azurerm_role_assignment.web_blob_reader]
}

# ---------------- 日次バッチ（Container Apps Job） ----------------
resource "azurerm_container_app_job" "batch" {
  name                         = "caj-${var.name_prefix}-daily"
  location                     = local.location
  resource_group_name          = local.rg
  container_app_environment_id = azurerm_container_app_environment.this.id
  replica_timeout_in_seconds   = var.batch_timeout_seconds
  replica_retry_limit          = var.batch_retry_limit
  tags                         = local.tags

  schedule_trigger_config {
    cron_expression          = var.batch_cron
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.batch.id]
  }

  # AI API キーはここではダミー値で作成し、実値は Terraform 外（az CLI）で設定する。
  # 実値を Terraform 変数で渡すと state に平文で残るため。
  secret {
    name  = "ai-api-key"
    value = "set-out-of-band"
  }

  dynamic "secret" {
    for_each = local.private_registry ? [1] : []
    content {
      name  = "ghcr-pull-token"
      value = var.ghcr_pull_token
    }
  }

  dynamic "registry" {
    for_each = local.private_registry ? [1] : []
    content {
      server               = var.image_registry
      username             = var.ghcr_pull_username
      password_secret_name = "ghcr-pull-token"
    }
  }

  template {
    container {
      name   = "batch"
      image  = local.job_image
      cpu    = var.batch_cpu
      memory = var.batch_memory

      dynamic "env" {
        for_each = merge(var.batch_extra_env, local.storage_env, {
          AZURE_CLIENT_ID      = azurerm_user_assigned_identity.batch.client_id
          AI_PROVIDER          = var.ai_provider
          AI_MODEL             = var.ai_model
          BATCH_MAX_RUNTIME_MS = tostring((var.batch_timeout_seconds - 60) * 1000)
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name        = "AI_API_KEY"
        secret_name = "ai-api-key"
      }
    }
  }

  lifecycle {
    # 帯域外で設定した秘密値を Terraform が上書きしないようにする
    ignore_changes = [secret]
  }

  depends_on = [azurerm_role_assignment.batch_blob_contributor]
}

# ---------------- 予算通知（支出を止める仕組みではない） ----------------
resource "azurerm_consumption_budget_resource_group" "app" {
  count             = length(var.budget_contact_emails) > 0 ? 1 : 0
  name              = "budget-${var.name_prefix}-app"
  resource_group_id = data.azurerm_resource_group.app.id
  amount            = var.budget_amount
  time_grain        = "Monthly"

  time_period {
    start_date = var.budget_start_date
  }

  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = var.budget_contact_emails
  }

  lifecycle {
    ignore_changes = [time_period]
  }
}
