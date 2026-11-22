data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = var.aws_region
  p          = var.name_prefix
  i          = var.name_index
  tags       = merge({ project = var.name_prefix, managed-by = "terraform", layer = "bootstrap" }, var.tags)

  state_bucket_name = "${local.p}-s3-tfstate-${local.i}"
  # アプリ層の命名規則（ここで権限の範囲を決めるため、アプリ層もこの名前で作る）
  app_bucket_arns   = ["arn:${local.partition}:s3:::${local.p}-s3-site-${local.i}", "arn:${local.partition}:s3:::${local.p}-s3-internal-${local.i}"]
  app_role_arn_glob = "arn:${local.partition}:iam::${local.account_id}:role/${local.p}-role-app*"
  app_function_glob = "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.p}-lambda-*"
  boundary_arn      = "arn:${local.partition}:iam::${local.account_id}:policy/${local.p}-policy-boundary-${local.i}"

  github_sub_prefix        = var.github_oidc_sub_prefix != "" ? var.github_oidc_sub_prefix : "repo:${var.github_repository}"
  github_oidc_url          = "token.actions.githubusercontent.com"
  github_oidc_provider_arn = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
}

# =====================================================================
# Terraform state 用 S3 バケット（アプリ用データとは別。公開禁止・暗号化・バージョニング）
# ロックは Terraform 1.10+ の S3 ネイティブロック（use_lockfile）を使う（DynamoDB 不要）
# =====================================================================
resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket_name
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "tfstate_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.tfstate.arn, "${aws_s3_bucket.tfstate.arn}/*"]
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

resource "aws_s3_bucket_policy" "tfstate" {
  bucket     = aws_s3_bucket.tfstate.id
  policy     = data.aws_iam_policy_document.tfstate_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.tfstate]
}

# =====================================================================
# ECR（Lambda と同一リージョン）。タグは commit SHA で不変（IMMUTABLE）。latest は使わない
# =====================================================================
resource "aws_ecr_repository" "batch" {
  name                 = "${local.p}-ecr-${local.i}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "batch" {
  repository = aws_ecr_repository.batch.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "タグなし（ビルド途中・上書き残骸）は 1 日で削除"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "タグ付きは新しい順に一定数を残す（実行中・ロールバック用）"
        selection    = { tagStatus = "tagged", tagPatternList = ["*"], countType = "imageCountMoreThan", countNumber = var.ecr_keep_tagged_images }
        action       = { type = "expire" }
      },
    ]
  })
}

# Lambda サービスがこのリポジトリからイメージを取得できるようにする（同一アカウントの対象関数に限定）
data "aws_iam_policy_document" "ecr_lambda_pull" {
  statement {
    sid     = "LambdaECRImageRetrievalPolicy"
    actions = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "aws:sourceArn"
      values   = [local.app_function_glob]
    }
  }
}

resource "aws_ecr_repository_policy" "batch" {
  repository = aws_ecr_repository.batch.name
  policy     = data.aws_iam_policy_document.ecr_lambda_pull.json
}

# =====================================================================
# アプリ層の IAM ロールに付ける Permissions Boundary。
# CI の deploy ロールはこの境界付きのロールしか作れないため、CI 経由での権限昇格を防ぐ。
# 実際の権限はアプリ層の各ロールでさらに絞る。
# =====================================================================
data "aws_iam_policy_document" "app_boundary" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.p}-lambda-*"]
  }
  statement {
    sid       = "AppBuckets"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = concat(local.app_bucket_arns, [for b in local.app_bucket_arns : "${b}/*"])
  }
  statement {
    sid       = "Bedrock"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = ["*"]
  }
  statement {
    sid       = "Notify"
    actions   = ["sns:Publish"]
    resources = ["arn:${local.partition}:sns:${local.region}:${local.account_id}:${local.p}-sns-*"]
  }
  statement {
    sid       = "InvokeBatch"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.app_function_glob, "${local.app_function_glob}:*"]
  }
}

resource "aws_iam_policy" "app_boundary" {
  name        = "${local.p}-policy-boundary-${local.i}"
  description = "Permissions boundary for ${local.p} application roles"
  policy      = data.aws_iam_policy_document.app_boundary.json
}

# =====================================================================
# GitHub Actions OIDC
# =====================================================================
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://${local.github_oidc_url}"
  client_id_list = ["sts.amazonaws.com"]
}

# 信頼条件: 対象リポジトリの、指定した GitHub Environment からのジョブだけ（ブランチ・PR・他リポジトリは不可）
data "aws_iam_policy_document" "gh_trust" {
  for_each = { plan = "plan", deploy = "production" }
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:sub"
      values   = ["${local.github_sub_prefix}:environment:${each.value}"]
    }
  }
}

# ---------- plan 用（読み取り＋state ロックファイルの作成・削除のみ） ----------
resource "aws_iam_role" "gh_plan" {
  name                 = "${local.p}-role-ghplan-${local.i}"
  assume_role_policy   = data.aws_iam_policy_document.gh_trust["plan"].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "gh_plan_readonly" {
  role       = aws_iam_role.gh_plan.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "gh_plan" {
  statement {
    sid       = "StateRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/app.tfstate"]
  }
  statement {
    sid       = "StateLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/app.tfstate.tflock"]
  }
  # ReadOnlyAccess に含まれるが、plan に不要な秘密情報の読み取りは拒否する（認証用 KVS の値を含む）
  statement {
    sid    = "DenySecretReads"
    effect = "Deny"
    actions = [
      "secretsmanager:GetSecretValue",
      "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
      "kms:Decrypt",
      "cloudfront-keyvaluestore:GetKey", "cloudfront-keyvaluestore:ListKeys",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "gh_plan" {
  name   = "${local.p}-policy-ghplan-${local.i}"
  role   = aws_iam_role.gh_plan.id
  policy = data.aws_iam_policy_document.gh_plan.json
}

# ---------- deploy 用（Terraform apply・イメージ push・Web 配置・バッチ手動実行） ----------
resource "aws_iam_role" "gh_deploy" {
  name                 = "${local.p}-role-ghdeploy-${local.i}"
  assume_role_policy   = data.aws_iam_policy_document.gh_trust["deploy"].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "gh_deploy" {
  statement {
    sid       = "State"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/app.tfstate", "${aws_s3_bucket.tfstate.arn}/app.tfstate.tflock"]
  }
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.tfstate.arn]
  }

  # --- ECR: イメージ push とアプリ層の参照 ---
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrRepo"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
      "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages", "ecr:DescribeRepositories",
      "ecr:ListTagsForResource", "ecr:GetRepositoryPolicy",
    ]
    resources = [aws_ecr_repository.batch.arn]
  }

  # --- アプリ用 S3（バケットの作成・設定・Web 配置） ---
  statement {
    sid       = "AppBuckets"
    actions   = ["s3:*"]
    resources = concat(local.app_bucket_arns, [for b in local.app_bucket_arns : "${b}/*"])
  }

  # --- CloudFront（ARN 単位の制限が作成時に効かない操作が多いため、アクション単位で限定） ---
  statement {
    sid = "CloudFront"
    actions = [
      "cloudfront:CreateDistribution", "cloudfront:CreateDistributionWithTags", "cloudfront:UpdateDistribution",
      "cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:DeleteDistribution",
      "cloudfront:TagResource", "cloudfront:UntagResource", "cloudfront:ListTagsForResource",
      "cloudfront:CreateOriginAccessControl", "cloudfront:GetOriginAccessControl", "cloudfront:GetOriginAccessControlConfig",
      "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl", "cloudfront:ListOriginAccessControls",
      "cloudfront:CreateCachePolicy", "cloudfront:GetCachePolicy", "cloudfront:GetCachePolicyConfig",
      "cloudfront:UpdateCachePolicy", "cloudfront:DeleteCachePolicy", "cloudfront:ListCachePolicies",
      "cloudfront:GetResponseHeadersPolicy", "cloudfront:ListResponseHeadersPolicies",
      "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation",
      # 認証用 CloudFront Function と KeyValueStore（ストアの作成のみ。キーの値＝認証情報の操作は許可しない）
      "cloudfront:CreateFunction", "cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction",
      "cloudfront:DescribeFunction", "cloudfront:GetFunction", "cloudfront:ListFunctions",
      "cloudfront:CreateKeyValueStore", "cloudfront:DescribeKeyValueStore", "cloudfront:UpdateKeyValueStore",
      "cloudfront:DeleteKeyValueStore", "cloudfront:ListKeyValueStores",
    ]
    resources = ["*"]
  }

  # --- Lambda ---
  statement {
    sid       = "Lambda"
    actions   = ["lambda:*"]
    resources = [local.app_function_glob, "${local.app_function_glob}:*"]
  }

  # --- IAM: 名前が <prefix>-role-app* で、Permissions Boundary 付きのロールだけ作成・変更できる ---
  statement {
    sid       = "IamCreateWithBoundary"
    actions   = ["iam:CreateRole", "iam:PutRolePolicy", "iam:PutRolePermissionsBoundary"]
    resources = [local.app_role_arn_glob]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
  }
  statement {
    sid = "IamManage"
    actions = [
      "iam:GetRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole",
      "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole", "iam:ListRoleTags",
    ]
    resources = [local.app_role_arn_glob]
  }
  statement {
    sid       = "IamPassRole"
    actions   = ["iam:PassRole"]
    resources = [local.app_role_arn_glob]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com", "scheduler.amazonaws.com"]
    }
  }
  statement {
    sid       = "DenyAuthSecretAccess"
    effect    = "Deny"
    actions   = ["cloudfront-keyvaluestore:*"]
    resources = ["*"]
  }
  statement {
    sid       = "IamDenyEscalation"
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary", "iam:AttachRolePolicy", "iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion"]
    resources = ["*"]
  }

  # --- CloudWatch Logs ---
  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy",
      "logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource", "logs:TagLogGroup", "logs:ListTagsLogGroup",
    ]
    resources = [
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.p}-lambda-*",
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.p}-lambda-*:*",
    ]
  }
  statement {
    sid       = "LogsDescribe"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  # --- EventBridge Scheduler ---
  statement {
    sid       = "Scheduler"
    actions   = ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule", "scheduler:TagResource", "scheduler:UntagResource", "scheduler:ListTagsForResource"]
    resources = ["arn:${local.partition}:scheduler:${local.region}:${local.account_id}:schedule/default/${local.p}-sch-*"]
  }

  # --- SNS（失敗通知） ---
  statement {
    sid = "Sns"
    actions = [
      "sns:CreateTopic", "sns:DeleteTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes",
      "sns:Subscribe", "sns:Unsubscribe", "sns:GetSubscriptionAttributes", "sns:SetSubscriptionAttributes",
      "sns:ListSubscriptionsByTopic", "sns:TagResource", "sns:UntagResource", "sns:ListTagsForResource",
    ]
    resources = ["arn:${local.partition}:sns:${local.region}:${local.account_id}:${local.p}-sns-*"]
  }

  # --- AWS Budgets ---
  statement {
    sid       = "Budgets"
    actions   = ["budgets:ViewBudget", "budgets:ModifyBudget", "budgets:TagResource", "budgets:UntagResource", "budgets:ListTagsForResource"]
    resources = ["arn:${local.partition}:budgets::${local.account_id}:budget/${local.p}-budget-*"]
  }

  # --- Terraform の data source が参照する AWS 管理の情報 ---
  statement {
    sid       = "ReadAccountInfo"
    actions   = ["iam:GetPolicy", "iam:GetPolicyVersion"]
    resources = [local.boundary_arn]
  }
}

resource "aws_iam_role_policy" "gh_deploy" {
  name   = "${local.p}-policy-ghdeploy-${local.i}"
  role   = aws_iam_role.gh_deploy.id
  policy = data.aws_iam_policy_document.gh_deploy.json
}
