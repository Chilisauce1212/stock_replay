# npm 命令说明

项目中的 npm 命令定义在 [package.json](package.json) 的 `scripts` 字段中。

> 使用本项目命令前，请先将 VS Code 集成终端和 Copilot 终端的默认 Shell 都切换为 Git Bash。下面的命令均按 Git Bash 环境编写。

## 1. 安装依赖

```text
npm install
```

根据 [package.json](package.json) 和 `package-lock.json` 安装项目依赖，包括 Express、Axios、AWS SDK、Playwright、dotenv 和 XLSX。

首次使用 Playwright 浏览器自动化功能时，还需要安装浏览器：

```text
npx playwright install chromium
```

如果网络需要使用本机 7890 端口代理，可以在 Git Bash 中执行：

```text
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export ALL_PROXY=http://127.0.0.1:7890
npx playwright install chromium
```

如果使用 PowerShell，可以执行：

```text
$env:HTTP_PROXY='http://127.0.0.1:7890'
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:ALL_PROXY='http://127.0.0.1:7890'
npm exec -- playwright install chromium
```

## 2. 启动网站服务

```text
npm start
```

对应命令为：

```text
node server.js
```

启动 Express 服务，默认地址为：

```text
http://localhost:3000
```

如果 Render 或其他平台提供了 `PORT` 环境变量，服务器会自动使用该端口。

启动前需要配置 R2 环境变量，具体见 [R2_SETUP.md](R2_SETUP.md)。本地开发时，如果没有配置 R2，程序会回退使用本地文件。

## 3. 运行回测数据生成脚本

```text
npm run turnover -- YYYYMMDD YYYYMMDD
```

示例：

```text
npm run turnover -- 20250104 20251231
```

对应命令为：

```text
node turnover_json.js 20250104 20251231
```

功能：

- 根据起始日期和结束日期查询回测数据；
- 自动跳过非交易日；
- 已有同名数据时从最后日期继续；
- 配置 R2 后从 `daily-review/` 读取并写回 R2；
- 未配置 R2 时回退使用本地 `daily-review/` 文件夹；
- 该脚本的问财页面查询使用本机原生 Chrome 调试端口 `9222`。

参数必须是 `YYYYMMDD` 格式。

## 4. 根据历史股价生成低价回测版本

```text
npm run filter-under30
```

该命令读取 `test-cases/` 中的三个原始一进二回测文件，通过历史 K 线查询获取每条记录目标日的收盘价，筛选收盘价小于 30 元的股票，生成：

```text
test-cases/一进二回测_小于30元_20240104_20241231.json
test-cases/一进二回测_小于30元_20250104_20251231.json
test-cases/一进二回测_小于30元_20260106_20261231.json
```

运行前需要启动网站服务 `npm start`。配置 R2 后，生成的文件会同时写入 R2 的 `test-cases/` 目录。

## 5. 筛选闷杀股票

```text
npm run filter -- 输入R2 JSON路径 [输入R2 JSON路径 ...]
```

例如，可以同时输入多个回测文件：

```text
npm run filter -- test-cases/一进二回测_小于30元_20240104_20241231.json test-cases/一进二回测_小于30元_20250104_20251231.json test-cases/一进二回测_小于30元_20260106_20261231.json
```

命令会读取所有输入 R2 JSON，合并并去重后，直接查询外部历史行情，筛选出回测日的后一个交易日最高价达到涨停价 `t`、再后一个交易日最高价低于涨停价 `t` 的股票，固定写入 `test-cases/闷杀.json`，不需要启动本地网站服务。

## 6. 生成今日首板数据

```text
npm run turnover -- --today
```

对应命令为：

```text
node turnover_json.js --today
```

功能：

- 只在北京时间 15:00 至 24:00 执行；
- 自动判断当天是否为交易日；周末或非交易日时使用最近的交易日；
- 查询目标交易日收盘涨停、前一交易日收盘未涨停、目标交易日涨幅大于 9%、主板、非 ST；
- 输出到 `daily-review/今日首板.json`，配置 R2 后实际写入 R2 的 `daily-review/今日首板.json`；
- 如果当天数据已经存在，则跳过，不重复生成。

## 7. 从 R2 恢复所有文件

## 8. 保持 Render 服务活跃

```text
npm run keep-render
```

默认每 10 分钟访问一次 `https://stock-replay.onrender.com`。命令会立即访问一次，之后按间隔继续访问；按 `Ctrl+C` 停止。

可以通过环境变量修改地址和间隔：

```text
RENDER_URL=https://stock-replay.onrender.com
RENDER_KEEPALIVE_INTERVAL_MS=600000
```

该命令用于减少 Render 因无访问而休眠的情况，不能绕过 Render 平台本身的休眠或配额策略。

## 9. 从 R2 恢复所有文件

```text
npm run download:r2
```

对应命令为：

```text
node download-r2.js
```

功能：

- 列出 R2 Bucket 中的所有对象；
- 下载全部对象到项目根目录；
- 自动根据对象路径创建文件夹；
- 例如 R2 中的 `daily-review/今日首板.json` 会恢复到本地的 `daily-review/今日首板.json`；
- `favorites.json` 也会恢复到项目根目录。

本地恢复的 `daily-review/`、`test-cases/` 和 `favorites.json` 已加入 [.gitignore](.gitignore)，不会被 Git 提交。

## 10. 恢复 R2 目录布局

如果此前误将回测文件迁移到了 R2 的 `daily-review/` 目录，执行：

```text
npm run restore:r2-layout
```

该命令只保留 `daily-review/今日首板.json`，并将其他每日复盘对象恢复到 `test-cases/`。确认复制成功后会删除 `daily-review/` 中对应的回测对象。只需执行一次。

## 11. 测试命令

```text
npm test
```

当前对应的命令是：

```text
 echo "Error: no test specified" && exit 1
```

项目目前没有配置自动化测试，因此该命令会主动返回失败状态。它只是 npm 的默认占位命令，暂时不用于验证业务功能。

## 12. npm 安全审计

```text
npm audit
```

检查项目依赖是否存在已知安全漏洞。该命令只进行检查，不会修改依赖。

尝试自动修复兼容范围内的问题：

```text
npm audit fix
```

执行后应检查 [package.json](package.json) 和 [package-lock.json](package-lock.json) 是否发生变化，并重新运行项目验证兼容性。

## 常用首次配置流程

```text
npm install
npx playwright install chromium
npm run turnover -- --today
npm start
```

如果要从 R2 恢复本地副本：

```text
npm run download:r2
```
