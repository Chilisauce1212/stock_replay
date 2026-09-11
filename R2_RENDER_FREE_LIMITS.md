# Cloudflare R2 与 Render 免费版限制

> 本文按 2026 年 9 月查阅的官方文档整理。免费额度、价格和平台规则可能调整，实际使用前请以控制台 Billing 页面和官方文档为准。

## 结论先看

- Cloudflare R2 Standard 存储的免费额度是按月提供的，不是一次性试用额度。
- R2 免费额度本身没有官方公布的固定到期日，但超出免费额度后会按量计费。
- Render 免费 Web Service 没有固定的“几天后到期”规则，但有每月额度、空闲休眠和临时文件系统限制。
- Render 免费 Postgres 有明确的 30 天期限；本项目目前使用 R2，不是 Render Postgres。
- 本项目的 `.env`、R2 Access Key 和 Secret Key 不要提交到 Git 仓库。

## Cloudflare R2 免费额度

R2 免费层仅适用于 **Standard storage**：

| 项目 | 每月免费额度 |
| --- | ---: |
| 存储 | 10 GB-month |
| Class A 操作 | 1,000,000 次请求 |
| Class B 操作 | 10,000,000 次请求 |
| Internet 出站流量 | 免费 |

### 常见操作分类

- **Class A**：`PutObject`、`CopyObject`、`ListObjects` 等写入、复制和列表操作。
- **Class B**：`GetObject`、`HeadObject` 等读取操作。
- **删除对象**：官方列为免费操作。

本项目中：

- 读取 `daily-review/*.json` 或 `test-cases/*.json`，主要消耗 Class B。
- 写入或覆盖 JSON，主要消耗 Class A。
- 页面读取收藏数据时会读取 `favorites.json`。
- `keep-render` 只请求 Render 首页，不会直接请求 R2；但 Render 首页或接口自身如果触发 R2 读取，仍会消耗 R2 操作次数。

### R2 需要注意

1. 免费额度按月计算，通常每月重新计算，不是永久锁定的总额度。
2. 超出 10 GB-month、100 万次 Class A 或 1,000 万次 Class B 后，超出部分可能产生费用。
3. 免费层不适用于 Infrequent Access 存储；该存储类型还有数据取回费用和 30 天最短存储期。
4. R2 直接出站流量免费，但连接的其他 Cloudflare 或第三方产品可能有各自费用。
5. 建议在 Cloudflare Billing、R2 Metrics 中设置用量和费用提醒。
6. 如果删除了 R2 对象，应用下次读取可能得到 404；删除不会自动保留历史版本，重要数据应另行备份。
7. R2 的 Access Key 只应授予目标 Bucket 所需权限。密钥泄露后应立即撤销并重新生成。

## Render 免费版限制

### 免费 Web Service

当前官方免费 Web Service 主要限制如下：

| 项目 | 免费限制 |
| --- | --- |
| 计算资源 | 0.1 CPU、512 MB RAM |
| 免费实例时数 | 每个 workspace 每自然月 750 小时 |
| 空闲休眠 | 15 分钟没有入站 HTTP 请求或 WebSocket 消息后休眠 |
| 唤醒时间 | 收到下一次请求后通常约 1 分钟启动 |
| 出站带宽 | Hobby workspace 每月 5 GB，超出后可能计费或暂停服务 |
| 构建流水线 | Hobby workspace 每月 500 分钟，超出后可能计费或停止新构建 |
| 本地文件 | 临时文件系统，重启、重新部署或休眠后可能丢失 |
| 实例数量 | 免费服务只能单实例运行，不能水平扩展 |
| 持久化磁盘 | 免费 Web Service 不支持 |

Render 免费 Web Service 可能随时重启。因此本项目不能把本地文件当作长期数据源，数据应写入 R2。

### 这个项目的保活命令

项目提供了：

```bash
npm.cmd run keep-render
```

它默认每 10 分钟访问一次：

```text
https://stock-replay.onrender.com
```

注意：持续保活会让 Web Service 长时间处于运行状态，可能消耗每月 750 小时额度。它只能减少空闲休眠，不能绕过 Render 的额度、服务暂停或平台策略。终端关闭、电脑休眠或网络中断后，保活命令也会停止。

按 `Ctrl+C` 停止保活。

### Render 免费 Postgres

虽然本项目没有使用 Render Postgres，但需要注意：

- 免费 Postgres 固定 1 GB 存储。
- 创建后 30 天到期。
- 到期后有 14 天升级宽限期。
- 宽限期结束后数据库及数据会被删除。
- 免费 Postgres 不提供备份能力。

不要把 R2 的 30 天规则和 Render 免费 Postgres 的 30 天规则混淆。R2 Standard 存储不是这个 30 天数据库期限。

### Render 免费 Key Value

如果以后使用 Render Key Value：

- 免费实例为内存存储。
- 重启或维护后数据会丢失。
- 不适合保存本项目的回测数据或收藏数据。

## 到期与账单检查清单

每月或修改部署配置后检查：

- [ ] Render Dashboard 的 Billing 页面：实例时数、带宽、构建分钟数。
- [ ] Cloudflare R2 Metrics/Billing：存储量、Class A、Class B 和费用。
- [ ] Render 服务是否仍为 `Free` compute plan。
- [ ] R2 Bucket 是否仍使用 Standard storage。
- [ ] `.env` 是否只保存在本机，没有被 Git 跟踪。
- [ ] R2 Access Key 是否仍有效，权限是否只覆盖目标 Bucket。
- [ ] `daily-review/今日首板.json` 是否能从 R2 正常读取和覆盖。
- [ ] 重要 R2 JSON 是否有额外备份。

## 相关命令

启动网站：

```bash
npm.cmd start
```

生成或覆盖今日复盘：

```bash
npm.cmd run turnover -- --today
```

启动 Render 保活：

```bash
npm.cmd run keep-render
```

下载 R2 对象到本地备份：

```bash
npm.cmd run download:r2
```

## 官方文档

- [Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare R2 Limits](https://developers.cloudflare.com/r2/reference/limits/)
- [Render Pricing](https://render.com/pricing)
- [Render Free Services](https://render.com/docs/free)
