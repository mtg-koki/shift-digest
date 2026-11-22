output "aws_account_id" {
  value = local.account_id
}

output "aws_region" {
  value = local.region
}

output "tfstate_bucket" {
  value = aws_s3_bucket.tfstate.bucket
}

output "ecr_repository_name" {
  value = aws_ecr_repository.batch.name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.batch.repository_url
}

output "app_permissions_boundary_arn" {
  description = "アプリ層の変数 permissions_boundary_arn に渡す"
  value       = aws_iam_policy.app_boundary.arn
}

output "github_oidc_provider_arn" {
  value = local.github_oidc_provider_arn
}

output "github_plan_role_arn" {
  description = "GitHub Environment 'plan' の変数 AWS_ROLE_ARN に設定する（秘密情報ではない）"
  value       = aws_iam_role.gh_plan.arn
}

output "github_deploy_role_arn" {
  description = "GitHub Environment 'production' の変数 AWS_ROLE_ARN に設定する（秘密情報ではない）"
  value       = aws_iam_role.gh_deploy.arn
}

output "backend_hcl" {
  description = "infra/app/backend.hcl に保存する内容（git 管理外）"
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.tfstate.bucket}"
    key          = "app.tfstate"
    region       = "${local.region}"
    use_lockfile = true
    encrypt      = true
  EOT
}
