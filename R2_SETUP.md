# Cloudflare R2 数据持久化

项目现在使用同一个 R2 Bucket 保存收藏和每日复盘 JSON：

- `favorites.json`：收藏数据
- `daily-review/*.json`：每日复盘数据

在 Render 的 Environment Variables 中配置：

- `R2_ENDPOINT`: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- `R2_ACCESS_KEY_ID`: Cloudflare R2 API Token 的 Access Key ID
- `R2_SECRET_ACCESS_KEY`: Cloudflare R2 API Token 的 Secret Access Key
- `R2_BUCKET`: R2 Bucket 名称，例如 `favorites`
- `R2_OBJECT_KEY`: 收藏对象路径，默认 `favorites.json`

R2 API Token 需要对目标 Bucket 具有 Object Read 和 Object Write 权限。

配置完成后，收藏和取消收藏都会把完整的 `favorites.json` 写入 R2。每日复盘列表、读取和生成脚本也会从 `daily-review/` 前缀读取或写入。

R2 中的对象可以一次性恢复到本地：

```text
npm.cmd run download:r2
```

该命令会下载 R2 中的全部对象，自动创建对象路径对应的本地文件夹和文件。例如 `daily-review/今日首板.json` 会恢复为本地的 `daily-review/今日首板.json`。

如果此前误将回测 JSON 迁移到了 `daily-review/`，执行一次：

```text
npm.cmd run restore:r2-layout
```

该命令会保留 `daily-review/今日首板.json`，并将其他对象恢复到 `test-cases/`。

本地未配置这些 R2 变量时，程序继续使用本地文件，便于开发调试。

项目全部 npm 命令请参阅 [NPM_COMMANDS.md](NPM_COMMANDS.md)。
