# npm 命令说明

项目中的 npm 命令定义在 [package.json](package.json) 的 `scripts` 字段中。

> Windows PowerShell 当前可能禁止执行 `npm.ps1`。如果直接执行 `npm` 报脚本策略错误，请使用 `npm.cmd` 替代。

## 1. 安装依赖

```text
npm.cmd install
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
& 'C:\Program Files\nodejs\npm.cmd' exec -- playwright install chromium
```

## 2. 启动网站服务

```text
npm.cmd start
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
npm.cmd run turnover -- YYYYMMDD YYYYMMDD
```

示例：

```text
npm.cmd run turnover -- 20250104 20251231
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

## 4. 生成今日首板数据

```text
npm.cmd run turnover -- --today
```

对应命令为：

```text
node turnover_json.js --today
```

功能：

- 只在北京时间 15:00 至 24:00 执行；
- 自动判断当天是否为交易日；
- 查询当天收盘涨停、前一交易日收盘未涨停、当天涨幅大于 9%、主板、非 ST；
- 输出到 `daily-review/今日首板.json`，配置 R2 后实际写入 R2 的 `daily-review/今日首板.json`；
- 如果当天数据已经存在，则跳过，不重复生成。

## 5. 从 R2 恢复所有文件

```text
npm.cmd run download:r2
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

## 6. 恢复 R2 目录布局

如果此前误将回测文件迁移到了 R2 的 `daily-review/` 目录，执行：

```text
npm.cmd run restore:r2-layout
```

该命令只保留 `daily-review/今日首板.json`，并将其他每日复盘对象恢复到 `test-cases/`。确认复制成功后会删除 `daily-review/` 中对应的回测对象。只需执行一次。

## 7. 测试命令

```text
npm.cmd test
```

当前对应的命令是：

```text
 echo "Error: no test specified" && exit 1
```

项目目前没有配置自动化测试，因此该命令会主动返回失败状态。它只是 npm 的默认占位命令，暂时不用于验证业务功能。

## 8. npm 安全审计

```text
npm.cmd audit
```

检查项目依赖是否存在已知安全漏洞。该命令只进行检查，不会修改依赖。

尝试自动修复兼容范围内的问题：

```text
npm.cmd audit fix
```

执行后应检查 [package.json](package.json) 和 [package-lock.json](package-lock.json) 是否发生变化，并重新运行项目验证兼容性。

## 常用首次配置流程

```text
npm.cmd install
npx playwright install chromium
npm.cmd run turnover -- --today
npm.cmd start
```

如果要从 R2 恢复本地副本：

```text
npm.cmd run download:r2
```
