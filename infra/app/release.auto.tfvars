# デプロイするイメージの Git commit SHA。
# 「Publish images」ワークフローで GHCR に push 済みの SHA に更新してからコミットし、plan / apply する。
# ※初回 push 前のため仮の値。このままでは apply 前のイメージ存在確認で失敗する。
image_tag = "0000000000000000000000000000000000000000"
