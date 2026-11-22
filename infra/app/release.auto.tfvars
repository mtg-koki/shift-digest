# Lambda に使うイメージの Git commit SHA（40 桁）。
# 「Publish batch image」ワークフローで ECR に push した SHA に更新してコミットし、Terraform を plan / apply する。
# ※初回 push 前のため仮の値。このままでは plan 時のイメージ存在確認（data.aws_ecr_image）で失敗する。
image_tag = "0000000000000000000000000000000000000000"
