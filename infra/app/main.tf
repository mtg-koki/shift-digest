data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = var.aws_region
  p          = var.name_prefix
  i          = var.name_index
  tags       = merge({ project = var.name_prefix, managed-by = "terraform", layer = "app" }, var.tags)

  # バケット名・ロール名は bootstrap の CI 権限の範囲（<prefix>-s3-site-NN, <prefix>-s3-internal-NN, <prefix>-role-app*, <prefix>-lambda-*, <prefix>-sch-*, <prefix>-sns-*, <prefix>-budget-*）に合わせる
  site_bucket_name     = "${local.p}-s3-site-${local.i}"
  internal_bucket_name = "${local.p}-s3-internal-${local.i}"
  function_name        = "${local.p}-lambda-${local.i}"
  public_data_prefix   = "data/"
  ecr_repository_name  = var.ecr_repository_name != "" ? var.ecr_repository_name : "${local.p}-ecr-${local.i}"
}

# =====================================================================
# S3（2 バケット）
# - site     : Web 静的ファイル（ルート）＋画面用 JSON（data/）。CloudFront（OAC）だけが読み、閲覧には Basic 認証が必要
# - internal : 既出判定・要約キャッシュ（state/）とロック（locks/）。CloudFront からは一切読めない
# 同一バケットの prefix 分離より、内部データを配信経路から構造的に切り離せる別バケットを選んだ（費用は同じ）。
# =====================================================================
resource "aws_s3_bucket" "site" {
  bucket = local.site_bucket_name
}

resource "aws_s3_bucket" "internal" {
  bucket = local.internal_bucket_name
}

locals {
  buckets = { site = aws_s3_bucket.site, internal = aws_s3_bucket.internal }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = local.buckets
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = local.buckets
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets
  bucket   = each.value.id
  rule {
    # SSE-S3。OAC 経由の配信で KMS キーポリシーの管理が不要
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 誤上書き・誤削除からの復旧用（旧バージョンは 30 日で削除）
resource "aws_s3_bucket_versioning" "this" {
  for_each = local.buckets
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = local.buckets
  bucket   = each.value.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  depends_on = [aws_s3_bucket_versioning.this]
}

data "aws_iam_policy_document" "site_bucket" {
  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

data "aws_iam_policy_document" "internal_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.internal.arn, "${aws_s3_bucket.internal.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket     = aws_s3_bucket.site.id
  policy     = data.aws_iam_policy_document.site_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.this]
}

resource "aws_s3_bucket_policy" "internal" {
  bucket     = aws_s3_bucket.internal.id
  policy     = data.aws_iam_policy_document.internal_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.this]
}

# =====================================================================
# CloudFront（標準ドメイン *.cloudfront.net、OAC、HTTP→HTTPS リダイレクト）
# OAC は「S3 を直接読ませない」ための仕組みで、閲覧者の認証ではない（認証は下の CloudFront Function）
# =====================================================================
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.p}-oac-${local.i}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# =====================================================================
# 自分専用のアクセス制御: CloudFront Functions（viewer-request）による Basic 認証
# - すべてのビヘイビアに関連付ける（HTML・アセット・/data/ の JSON・過去データ）
# - viewer-request はキャッシュ判定より前に毎回実行されるため、キャッシュ経由で認証を回避できない
# - 期待値（資格情報の SHA-256）は KeyValueStore のキー basic-auth-sha256。値は Terraform では管理せず
#   CLI で投入する（Git・state に残さない）。未投入の間は全員 401（fail closed）
# =====================================================================
resource "aws_cloudfront_key_value_store" "auth" {
  name    = "${local.p}-kvs-${local.i}"
  comment = "Basic auth credential hash for ${local.p} (value is set out-of-band)"
}

resource "aws_cloudfront_function" "auth" {
  name                         = "${local.p}-cff-${local.i}"
  runtime                      = "cloudfront-js-2.0"
  comment                      = "Basic auth for the private dashboard"
  publish                      = true
  code                         = file("${path.module}/functions/basic-auth.js")
  key_value_store_associations = [aws_cloudfront_key_value_store.auth.arn]
}

# ハッシュ付きアセット（_next/static/）: オブジェクトの Cache-Control（1 年・immutable）に従ってエッジでキャッシュ
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# HTML と画面用 JSON（data/）: エッジでキャッシュしない（自分専用のデータ。オブジェクトも private, no-cache）
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "${local.p}-cf-${local.i} private dashboard"
  default_root_object = "index.html"
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = var.cloudfront_price_class

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  # HTML・data/ の JSON・その他（キャッシュしない）
  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.auth.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/_next/static/*"
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.auth.arn
    }
  }

  # 存在しないキーは S3 が 403 を返す（OAC に ListBucket を与えていないため）。どちらも 404 ページにする。
  # 未作成の JSON も 404 になり、画面は「データ未作成」を表示する（認証済みのリクエストに限る）。
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 10
  }
  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  lifecycle {
    # CloudFront の定額プラン（Free 等）をコンソールで適用すると Web ACL が関連付けられる。
    # Terraform では定額プランを管理しない（README 参照）ため、その差分は無視する。
    ignore_changes = [web_acl_id]
  }
}

# =====================================================================
# Lambda（定期バッチ。VPC に接続しない＝NAT Gateway 不要）
# =====================================================================
data "aws_ecr_repository" "batch" {
  name = local.ecr_repository_name
}

# イメージが push 済みであることを plan 時に確認し、digest で固定して参照する（latest に依存しない）
data "aws_ecr_image" "batch" {
  repository_name = data.aws_ecr_repository.batch.name
  image_tag       = var.image_tag
}

locals {
  image_uri = "${data.aws_ecr_repository.batch.repository_url}@${data.aws_ecr_image.batch.image_digest}"

  # ---- Bedrock の IAM リソース ----
  bedrock_enabled = var.bedrock_model_id != ""
  id_parts        = split(".", var.bedrock_model_id)
  # 推論プロファイル ID は "<地域>.<基盤モデルID>"（例 jp.anthropic.claude-haiku-5-5）
  is_profile          = local.bedrock_enabled && contains(["global", "jp", "apac", "us", "eu", "au", "ca", "us-gov"], local.id_parts[0])
  is_global           = local.is_profile && local.id_parts[0] == "global"
  base_model_id       = local.is_profile ? join(".", slice(local.id_parts, 1, length(local.id_parts))) : var.bedrock_model_id
  profile_arn         = "arn:${local.partition}:bedrock:${local.region}:${local.account_id}:inference-profile/${var.bedrock_model_id}"
  in_region_model_arn = "arn:${local.partition}:bedrock:${local.region}::foundation-model/${local.base_model_id}"
  # 地域別プロファイル: 各推論先リージョンの基盤モデル。global: 呼び出し元リージョン＋リージョン指定なしの ARN（公式の指定どおり）
  profile_model_arns = local.is_global ? [local.in_region_model_arn, "arn:${local.partition}:bedrock:::foundation-model/${local.base_model_id}"] : [
    for r in var.bedrock_destination_regions : "arn:${local.partition}:bedrock:${r}::foundation-model/${local.base_model_id}"
  ]
}

resource "aws_cloudwatch_log_group" "batch" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "batch" {
  name                 = "${local.p}-role-appbatch-${local.i}"
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "batch" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.batch.arn}:*"]
  }
  # 画面用 JSON: data/ 配下だけ書ける（Web の HTML・JS は上書きできない）
  statement {
    sid       = "PublicData"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.site.arn}/${local.public_data_prefix}*"]
  }
  # 未作成オブジェクトの取得を 403 でなく 404 として判定するために必要（S3 の仕様）。
  # GetObject 時の判定には s3:prefix が渡らないため prefix 条件は付けられない。一覧で見えるのは公開ファイル名のみ。
  statement {
    sid       = "PublicDataList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn]
  }
  statement {
    sid       = "InternalData"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.internal.arn}/state/*", "${aws_s3_bucket.internal.arn}/locks/*"]
  }
  statement {
    sid       = "InternalList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.internal.arn]
  }
  statement {
    sid       = "NotifyFailure"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }

  # ---- Bedrock（Converse は bedrock:InvokeModel 権限で呼べる） ----
  dynamic "statement" {
    for_each = local.bedrock_enabled && !local.is_profile ? [1] : []
    content {
      sid       = "BedrockInRegion"
      actions   = ["bedrock:InvokeModel"]
      resources = [local.in_region_model_arn]
    }
  }
  dynamic "statement" {
    for_each = local.is_profile ? [1] : []
    content {
      sid       = "BedrockInferenceProfile"
      actions   = ["bedrock:InvokeModel"]
      resources = [local.profile_arn]
    }
  }
  dynamic "statement" {
    for_each = local.is_profile ? [1] : []
    content {
      sid       = "BedrockProfileModels"
      actions   = ["bedrock:InvokeModel"]
      resources = local.profile_model_arns
      condition {
        test     = "StringEquals"
        variable = "bedrock:InferenceProfileArn"
        values   = [local.profile_arn]
      }
    }
  }
}

resource "aws_iam_role_policy" "batch" {
  name   = "${local.p}-policy-appbatch-${local.i}"
  role   = aws_iam_role.batch.id
  policy = data.aws_iam_policy_document.batch.json
}

resource "aws_lambda_function" "batch" {
  function_name = local.function_name
  description   = "Daily RSS collection and interest ranking (${var.bedrock_model_id != "" ? var.bedrock_model_id : "rules"})"
  role          = aws_iam_role.batch.arn
  package_type  = "Image"
  image_uri     = local.image_uri
  architectures = [var.lambda_architecture]
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_seconds

  reserved_concurrent_executions = var.lambda_reserved_concurrency == null ? -1 : var.lambda_reserved_concurrency

  environment {
    variables = merge(var.batch_settings, {
      STORAGE_MODE     = "s3"
      PUBLIC_BUCKET    = aws_s3_bucket.site.bucket
      PUBLIC_PREFIX    = local.public_data_prefix
      INTERNAL_BUCKET  = aws_s3_bucket.internal.bucket
      AI_PROVIDER      = local.bedrock_enabled ? "bedrock" : "mock"
      BEDROCK_MODEL_ID = var.bedrock_model_id
      # Lambda の上限（timeout）より余裕をもって打ち切る。実際は残り時間からも計算する
      BATCH_MAX_RUNTIME_MS = tostring((var.lambda_timeout_seconds - 120) * 1000)
    })
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.batch.name
  }

  depends_on = [aws_iam_role_policy.batch]
}

# 非同期呼び出しの再試行と失敗通知
resource "aws_lambda_function_event_invoke_config" "batch" {
  function_name                = aws_lambda_function.batch.function_name
  maximum_retry_attempts       = var.lambda_async_retries
  maximum_event_age_in_seconds = 3600
  destination_config {
    on_failure {
      destination = aws_sns_topic.alerts.arn
    }
  }
}

# =====================================================================
# EventBridge Scheduler（既定 7:00・12:00・18:00 Asia/Tokyo）
# =====================================================================
data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name                 = "${local.p}-role-appscheduler-${local.i}"
  assume_role_policy   = data.aws_iam_policy_document.scheduler_trust.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.batch.arn, "${aws_lambda_function.batch.arn}:*"]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${local.p}-policy-appscheduler-${local.i}"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "daily" {
  name                         = "${local.p}-sch-${local.i}"
  description                  = "Run ${local.function_name} on schedule"
  state                        = var.schedule_enabled ? "ENABLED" : "DISABLED"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = var.schedule_timezone

  flexible_time_window {
    mode                      = var.schedule_flexible_window_minutes > 0 ? "FLEXIBLE" : "OFF"
    maximum_window_in_minutes = var.schedule_flexible_window_minutes > 0 ? var.schedule_flexible_window_minutes : null
  }

  target {
    arn      = aws_lambda_function.batch.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({})
    # Lambda への非同期投入自体の再試行（スロットリング等）。関数の失敗時の再試行は event_invoke_config 側
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
}

# =====================================================================
# 失敗通知（SNS メール）と予算
# =====================================================================
resource "aws_sns_topic" "alerts" {
  name = "${local.p}-sns-${local.i}"
}

# 宛先は sensitive。plan の表示（公開リポジトリの Actions ログ）にメールアドレスを出さない
resource "aws_sns_topic_subscription" "alerts" {
  count     = nonsensitive(length(var.alert_emails))
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_emails[count.index]
}

# アカウント全体の月額コスト（Bedrock を含む）。通知するだけで、課金は止まらない
resource "aws_budgets_budget" "monthly" {
  count        = var.budget_monthly_usd > 0 && nonsensitive(length(var.budget_emails)) > 0 ? 1 : 0
  name         = "${local.p}-budget-${local.i}"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_emails
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_emails
  }
}
