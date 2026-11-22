# ブートストラップ層（最初に手元で 1 回 apply する。最初はローカル state。README の手順でリモートへ移行可）
# - Terraform state 用 S3 バケット（アプリ用データとは別）
# - GitHub Actions 用 OIDC プロバイダー（既存があれば再利用）と IAM ロール（plan 用 / deploy 用）
# - Lambda 用 ECR リポジトリ（アプリ層より先に存在させ、イメージ push → アプリ層 apply の順にする）
# - アプリ層が作る IAM ロールに必須の Permissions Boundary
terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = local.tags
  }
}
