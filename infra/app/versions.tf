terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }

  # S3 バックエンド（部分構成）。値は backend.hcl（git 管理外）または CI の -backend-config で渡す。
  # ロックは S3 ネイティブ（use_lockfile = true）。
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = local.tags
  }
}
