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

`npm start` 默认从 R2 读取 `daily-review/` 和 `test-cases/` 数据，适合 Render 部署。需要使用项目本地 JSON 时，在 `.env` 中显式设置：

```dotenv
USE_LOCAL_JSON=true
```

修改后需要重启服务才能生效。也可以只在本次启动时临时开启：

```text
# Git Bash
USE_LOCAL_JSON=true npm start

# PowerShell（npm.ps1 被执行策略拦截时改用 npm.cmd）
$env:USE_LOCAL_JSON='true'; npm.cmd start

# cmd
set USE_LOCAL_JSON=true && npm start
```

本地模式下，`test-cases/`、`daily-review/` 的文件列表和内容都从项目目录读取，盈亏缓存也从本地 `daily-review/` 读取。收藏夹仍按 `.env` 中的 R2 配置读写；要让收藏夹也只使用本地 `favorites.json`，需要移除或清空 `R2_*` 配置后再启动。

`npm run start` 与 `npm start` 等价。R2 环境变量配置见 [R2_SETUP.md](R2_SETUP.md)。本地 JSON 模式只在 `USE_LOCAL_JSON=true` 时启用。

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

`daily-review` 页面通过 `/api/news?code=股票代码&date=回测日期` 查询实时新闻。除历史分页接口外，服务端还会请求同花顺 `https://m.10jqka.com.cn/app/timeline/v2/list/{market}/{code}/first`，筛选回测日的 `recommendType: 2` 临时置顶新闻并放在列表最前。这些新闻返回时带有 `isPinned: true`，页面会额外显示“置顶”标记；`first` 接口失败时仍会返回历史新闻。

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

## 13. 导出量堆统计 CSV

先运行网站服务，再指定一个或多个每日复盘 JSON：

```text
npm start
npm run volume-pile-report -- 一进二回测_20260106_20261231.json
npm run volume-pile-report -- daily-review/文件A.json daily-review/文件B.json --out reports/量堆汇总.csv
```

脚本对每条股票信号记录扫描信号日之前的历史 K 线，输出吸筹/承接候选量堆数、获利兑现倾向量堆数、最新量堆类型和该记录的收益率。固定检测配置见 [volume-pile-report.js](volume-pile-report.js)。文件可以指定为路径或 `daily-review/` 下的文件名。

可选参数：

```text
--workers 3                      并发 K 线请求数（范围 1–16，默认 3）
--base-url http://localhost:3000 网站服务地址
--out reports/summary.csv        输出 CSV 路径；省略时自动生成文件名
```

收益按 [review-pnl.js](review-pnl.js) 的逐笔成交规则实时重算，不读 JSON 中的 `pnl` 缓存，也不修改输入文件。脚本会连接通达信逐笔行情服务器，因此网络行情不可用时会在收益计算错误列注明；量堆检测或收益计算失败的记录仍写入 CSV，脚本结束时以非零状态提醒存在失败项。

CSV 使用不带双引号的逗号分隔格式：字段内的换行改为空格、双引号改为单引号、英文逗号改为全角逗号；`量堆检测参数` 列写成 `key=value;key=value`，因此每行都可以直接用英文逗号切分。旧版带引号的 CSV 仍可被下一节的转换脚本读取。

需要把导出的 CSV 转成回测页面可直接加载的 JSON 时，见下一节。

## 14. 将量堆统计 CSV 转换为回测 JSON

将上一节导出的 CSV 转换成回测用例 JSON：

```text
npm run volume-pile-backtest -- volume-pile-report-20261026_101051.csv
```

默认输出 `test-cases/volume-pile-report-20261026_101051.json`。输出文件已存在时命令会报错；确认覆盖请加 `--force`，或用 `--out` 指定其他路径。生成的 JSON 会出现在页面的测试用例下拉框中，直接选择即可回测。

转换规则：

- 只保留 `股票代码`、`市场代码`、`信号日期` 有效的记录，其余行跳过并在命令结束时汇总；
- 每条记录保留回测页面需要的 `id`、`date`、`code`、`marketCode`、`stockName`，并补充 `source`（原始每日复盘文件名）；
- `volumePile` 保存量堆统计：检测状态与错误、全局基线和全局中位量、吸筹/承接与获利兑现数量、最近量堆类型、起止日、峰值日、缩量 Top50 均值比；
- `pnl` 保存 CSV 中已算好的收益结果（`pnlPct`、买入/卖出日期和价格、计算状态与错误），便于离线核对；页面回放时仍按逐笔行情实时重算，不读取该字段；
- 量堆检测参数保留在源 CSV 的 `量堆检测参数` 列（`key=value;...`），转换结果不重复写入；
- 兼容旧版全字段带引号的 CSV、Excel 另存的混合格式（表头不带引号、含逗号的字段仍带引号）以及新版完全不带引号的 CSV；`2024/2/8` 这类日期会统一写成 `2024-02-08`；
- 多个 CSV 可以一起传入，按 `市场代码|信号日期` 去重，重复项保留第一次出现的记录。

可选参数：

| 参数 | 说明 |
| --- | --- |
| `--out <路径>` | 指定输出 JSON 路径；省略时写入 `test-cases/<第一个CSV文件名>.json` |
| `--latest-type 吸筹\|获利兑现\|无量堆` | 只导出最近量堆类型匹配的记录，也接受 `accumulation` / `profit-taking` / `none` |
| `--min-piles <数量>` | 只导出量堆总数不少于该值的记录 |
| `--strict` | 只导出 `量堆检测状态=成功` 且 `收益计算状态=实时计算成功` 的记录 |
| `--force` | 覆盖已存在的输出文件 |
| `--help` | 显示命令说明 |

示例：

```text
npm run volume-pile-backtest -- volume-pile-report-20261026_101051.csv --latest-type 获利兑现 --out test-cases/获利兑现回测.json
npm run volume-pile-backtest -- reports/量堆汇总.csv --min-piles 6 --strict
```

转换完成后终端会输出读取行数、跳过和重复数量、导出条数、各量堆类型数量以及输出路径。`test-cases/` 已加入 [.gitignore](.gitignore)，生成的 JSON 不会提交到 Git。

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
