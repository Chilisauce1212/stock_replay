# Cloudflare R2 收藏持久化

在 Render 的 Environment Variables 中配置：

- `R2_ENDPOINT`: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- `R2_ACCESS_KEY_ID`: Cloudflare R2 API Token 的 Access Key ID
- `R2_SECRET_ACCESS_KEY`: Cloudflare R2 API Token 的 Secret Access Key
- `R2_BUCKET`: R2 Bucket 名称，例如 `favorites`
- `R2_OBJECT_KEY`: 对象路径，例如 `favorites.json`

R2 API Token 需要对目标 Bucket 具有 Object Read 和 Object Write 权限。

配置完成后，收藏和取消收藏都会把完整的 `favorites.json` 写入 R2。服务启动时从 R2 读取；如果对象第一次不存在，会把项目中的本地 `favorites.json` 迁移到 R2。

本地未配置这些 R2 变量时，程序继续使用本地 `favorites.json`。
