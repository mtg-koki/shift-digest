output "site_url" {
  description = "自分用画面の URL（CloudFront 標準ドメイン。Basic 認証が必要）"
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "site_bucket" {
  description = "Web 静的ファイル（ルート）と画面用 JSON（data/）。GitHub 変数 SITE_BUCKET に設定"
  value       = aws_s3_bucket.site.bucket
}

output "internal_bucket" {
  value = aws_s3_bucket.internal.bucket
}

output "batch_function_name" {
  description = "GitHub 変数 BATCH_FUNCTION_NAME に設定"
  value       = aws_lambda_function.batch.function_name
}

output "batch_image_uri" {
  value = local.image_uri
}

output "batch_log_group" {
  value = aws_cloudwatch_log_group.batch.name
}

output "schedule_name" {
  value = aws_scheduler_schedule.daily.name
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "ai_provider" {
  value = local.bedrock_enabled ? "bedrock (${var.bedrock_model_id})" : "rules (no AI)"
}

output "auth_kvs_arn" {
  description = "Basic 認証のハッシュを入れる KeyValueStore（README「認証の設定」）"
  value       = aws_cloudfront_key_value_store.auth.arn
}
