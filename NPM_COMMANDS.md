# npm 命令说明

项目中的 npm 命令定义在 [package.json](package.json) 的 `scripts` 字段中。

> 使用本项目命令前，请先将 VS Code 集成终端和 Copilot 终端的默认 Shell 都切换为 Git Bash。下面的命令均按 Git Bash 环境编写。
> Windows PowerShell 当前可能禁止执行 `npm.ps1`。如果直接执行 `npm` 报脚本策略错误，请调整 PowerShell 执行策略后再使用 `npm`。

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

`npm start` 默认从项目本地的 `daily-review/`、`test-cases/` 和其他本地 JSON 文件读取数据，即使 `.env` 中配置了 R2 也不会切换数据源。需要使用 R2 数据时，显式设置：

```dotenv
USE_LOCAL_JSON=false
```

R2 环境变量配置见 [R2_SETUP.md](R2_SETUP.md)。收藏数据仍可按服务端配置使用本地文件或 R2。

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

## 5. 生成四连板及以上数据

```text
npm run extract-price-cases
```

该命令会读取三个原始一进二回测文件，查询目标日及后续交易日的历史行情，并在 `test-cases/` 下生成：

```text
test-cases/四连板及以上.json
```

同时会重新生成大于 30 元、小于 3 元、三连板及以上和五连板及以上文件。行情查询失败或找不到目标日期的记录不会进入连板筛选结果。

## 6. 筛选闷杀股票

```text
npm run filter -- 输入R2 JSON路径 [输入R2 JSON路径 ...]
```

例如，可以同时输入多个回测文件：

```text
npm run filter -- test-cases/一进二回测_小于30元_20240104_20241231.json test-cases/一进二回测_小于30元_20250104_20251231.json test-cases/一进二回测_小于30元_20260106_20261231.json
```

命令会读取所有输入 R2 JSON，合并并去重后，直接查询外部历史行情，筛选出回测日的后一个交易日最高价达到涨停价 `t`、再后一个交易日最高价低于涨停价 `t` 的股票，固定写入 `test-cases/闷杀.json`，不需要启动本地网站服务。

## 7. 生成今日首板数据

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

## 8. 为 JSON 添加同花顺新闻

```text
npm run add-news -- test-cases/输入文件.json
```

命令会遍历输入 JSON 的每条股票记录，按记录的 `date` 查询“前 4 个交易日 + 回测日”共 5 个交易日的数据，并分页获取同花顺新闻和股票公告，将两者按发布时间合并写入该记录的 `news` 数组。命令只修改本地 JSON 文件，不写入 R2；原有 `code`、`date` 等字段保持不变。

新闻时间线会递归检查 `combination` 的所有层级；标题只采集字符串，时间戳支持数字或数字字符串。

脚本对外部接口使用全局频率限制，相邻请求至少间隔 10ms。

如果接口返回 `403`，可以在浏览器开发者工具的 Network 面板中复制同花顺请求的完整 Cookie，填入项目根目录 `.env`：

```dotenv
THS_COOKIE=粘贴完整Cookie字符串，不要加引号
```

脚本会把它用于新闻、公告和交易日历请求。Cookie 属于临时登录凭证，不要提交到 Git 或发送给他人。

如果需要重新查询并覆盖已有 `news` 数组，使用：

```text
npm run add-news -- --overwrite test-cases/输入文件.json
```

页面加载带有 `news` 的回测文件后，点击图表上方 legend 右侧的“新闻”按钮，可以打开半透明新闻面板，通过手机上下滑动或电脑滚轮/右侧滚动条查看新闻和公告；再次点击按钮关闭。

## 9. 从 R2 恢复所有文件

## 9. 保持 Render 服务活跃

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

## 10. 从 R2 恢复所有文件

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

## 10. 将本地数据上传到 R2

```text
npm run upload
```

## 11. 查询同花顺股票新闻

接口地址：

```text
https://news.10jqka.com.cn/timeline_web/web/v1/news/list
```

第一页请求使用当前时间的毫秒时间戳加 6 位小数作为 `offset`：

```text
https://news.10jqka.com.cn/timeline_web/web/v1/news/list?marketId=33&code=003032&offset=当前毫秒时间戳.六位数字&size=100
```

例如：

```text
https://news.10jqka.com.cn/timeline_web/web/v1/news/list?marketId=33&code=003032&offset=1789700000000.245617&size=100
```

参数说明：

| 参数 | 示例 | 说明 |
| --- | --- | --- |
| `marketId` | `33` | A 股深圳市场使用 `33` 上海使用 `17` |
| `code` | `003032` | 股票代码 |
| `offset` | `1789700000000.214685` | 第一页使用毫秒时间戳加 6 位小数 |
| `size` | `100` | 每页数量，建议使用 `100` |

接口返回的 `data.offset` 是下一页游标，必须原样传递，不要乘以 `1000` 或自行转换：

```text
https://news.10jqka.com.cn/timeline_web/web/v1/news/list?marketId=33&code=003032&offset=1785629606.605479&size=100
```

返回结果按 `publishTime` 倒序排列，`publishTime` 是毫秒时间戳。查询指定日期范围时，持续使用下一页游标，直到最旧新闻早于起始日期，再按时间过滤。例如查询 `003032` 在 2026-09-01 至今的新闻：

```js
const https = require('https');

function fetchNews(code, startDate) {
	const startTime = new Date(`${startDate}T00:00:00+08:00`).getTime();
	const news = [];
	let offset = `${Date.now()}.${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;

	function requestPage() {
		const url = new URL(
			'https://news.10jqka.com.cn/timeline_web/web/v1/news/list'
		);

		url.searchParams.set('marketId', '33');
		url.searchParams.set('code', code);
		url.searchParams.set('offset', String(offset));
		url.searchParams.set('size', '100');

		https.get(url, response => {
			let body = '';

			response.on('data', chunk => {
				body += chunk;
			});

			response.on('end', () => {
				const result = JSON.parse(body);
				const list = result.data.newsList || [];

				news.push(...list.filter(item => item.publishTime >= startTime));

				const oldestTime = list.at(-1)?.publishTime || 0;

				if (
					result.data.hasMore &&
					oldestTime >= startTime &&
					result.data.offset
				) {
					offset = result.data.offset;
					requestPage();
					return;
				}

				console.log(JSON.stringify(news, null, 2));
			});
		});
	}

	requestPage();
}

fetchNews('003032', '2026-09-01');
```

该命令会上传本地 `test-cases/`、`daily-review/` 下的全部 JSON 文件，以及根目录的 `favorites.json`（如果存在），并覆盖 R2 中的同名对象。

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

## 提交前约定

每次 `git commit` 前，都要同步检查并更新相关 Markdown 文档，至少确认命令、配置项、数据来源和使用说明与当前代码一致。完成文档更新后，再执行语法检查、功能验证和提交。

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
