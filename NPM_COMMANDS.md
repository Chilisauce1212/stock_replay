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

## 0. 每日全自动更新（推荐）

```text
npm run daily-update                # 默认读写 R2，本地 daily-review/ 同步一份
npm run daily-update -- --local     # 强制只用本地文件，不读写 R2
npm run daily-update -- --yes       # 新闻判断要调用大模型超过 100 只时不询问
```

从交易日 T(X) 15:00 到 T(X+1) 15:00 之前运行（含周末、节假日），都更新到 T(X)。依次做：

1. 今日首板（第 7 节）；
2. T(X) 所在年份的一进二回测（第 3 节，含后续全部步骤）；1 月份同时处理上一年的文件，12 月末的票要到 1 月才算得出盈亏；
3. 删除 R2 上 30 天前的覆盖备份（`backups/`）。

不用先 `npm start`：新闻判断需要网站服务时，没开会自动临时启动一个，跑完关掉。某一步失败不影响后面的步骤，最后列出哪些失败；修好后重跑同一命令，已完成的会跳过。

**R2 写入保护**（所有脚本通过 `r2-storage.js` 写 R2 时都生效）：

- 覆盖前先把原对象复制到 `backups/<北京时间>/<原路径>`，误写时可以从备份找回；`npm run download:r2` 不下载备份；
- 原对象和新内容都是数组、新数组更短时拒绝写入，防止拿不完整的本地文件覆盖 R2。今日首板每天整体替换，不受这条限制；`npm run upload -- --force` 确认要删记录时才用。

## 3. 运行回测数据生成脚本

```text
npm run turnover -- YYYYMMDD YYYYMMDD [--only-cases] [--yes]
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

- 起止日期是二板日（买入日）范围，生成 `一进二回测_<起始>_<结束>.json`：首板日收盘涨停、前一日未涨停、主板、非 ST，二板日 10:30 前（含 10:30 那一分钟）在涨停价有成交、且不是一字板；
- 判断交给 `yijiner-cases.js`（见第 20 节），用全市场涨停名单和通达信逐笔成交，不再用问财。原来的问句「T 日 10 点 30 前达到过 T 日涨停价」被问财解析成「10:30 那一分钟的最高价」，早盘触板后又开板的票会被漏掉（2026-10 发现，三年样本已按新规则重建）；
- 已有同名数据时从最后一个首板日之后继续；
- 配置 R2 时先读 R2 `test-cases/` 的已有记录，追加后写回 R2；未配置 R2 时只用本地 `test-cases/`；
- 追加完成后（或数据已覆盖日期范围、无需追加时），把新记录合并进 `daily-review/` 下的同名文件，供每日复盘页面读取：原有记录和 `pnl` 字段不动，只追加没有的记录。配了 R2 时更新 R2 的 `daily-review/`，本地 `daily-review/` 已有该文件时一并更新；没配 R2 时只写本地。
- 同时补齐每日复盘页面「连板股票」用的 `daily-review/连板股票.json`：对这些回测日运行 `chain-stocks.js`，全市场涨停名单覆盖的日期直接从名单生成（当天收盘封死涨停、连板数 ≥ 2、主板、非 ST；和问财「涨停」同口径，收盘在涨停价但没封死的不算），名单没有的更早日期才用问财；生成后更新 R2。也可以单独运行 `npm run chain-stocks -- 2026-10-29`（不带参数则处理 daily-review 里全部回测日，已有日期跳过，加 `--overwrite` 并指定日期才重新生成，不指定日期会报错，避免覆盖问财历史）。

- 接着自动跑后续步骤（[review-pipeline.js](review-pipeline.js)），某一步失败只记下来、继续后面的：
  1. 小于 30 元版本（第 4 节，只处理这一年）；
  2. 预计算盈亏（`pnl.js`）：配了 R2 时先以 R2 为准更新本地文件，算完把 `pnl` 字段合并上传；二板日的次日还没到的票会显示「没有后续交易日」，下次再算；
  3. 新闻判断：没判断过的记录，加最近 3 个首板日的（新闻、涨停原因变了会重新调用，没变走缓存不花钱）→ 涨停原因（涨停池，`first-board-reason.js --max-queries 0`）→ 新闻和 K 线（`news-theme-table.js`，写 `reports/每日更新新闻.*`）→ 大模型（`news-llm.js`，超过 100 只先询问）；
  4. 写入每日复盘（第 21 节 `review-judge.js`，配了 R2 时 `--upload`）。
  5. 自由流通市值（第 22 节 `free-float.js`，问财，每次最多问 20 次，配了 R2 时 `--upload`）。
- `--only-cases` 只追加回测和同步，不跑后续步骤；`--yes` 大模型超过 100 只时不询问。

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

不带参数处理 `test-cases/` 下全部年份；`npm run filter-under30 -- 2026` 只处理匹配的文件。首板日收盘价缓存在 `reports/under30-close.json`，查过的不再请求，每天只查新增的记录（查不到收盘价的，如已退市，和原来一样保留）。配置 R2 后，生成的文件会同时写入 R2 的 `test-cases/` 目录。

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

- 目标日是最近一个已收盘的交易日 T(X)：从 T(X) 15:00 到 T(X+1) 15:00 之前运行（含周末、节假日）都生成 T(X)；北京时间 15:00 前从昨天往前找，涨停池接口非交易日返回空，第一个有数据的日期就是 T(X)；
- 条件：T(X) 收盘封死涨停、前一交易日没有封死涨停、主板、非 ST，从全市场涨停名单（同花顺涨停池，和问财「涨停」同口径）生成，不再开问财浏览器；
- 每次整体覆盖 `daily-review/今日首板.json`，配置 R2 后同时写 R2 的 `daily-review/今日首板.json`。

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
npm run upload -- --force   # 允许记录变少（默认拒绝，防止拿旧的本地文件覆盖 R2）
```

上传本地 `test-cases/`、`daily-review/` 下全部 JSON 和 `favorites.json`，逐个覆盖 R2 同名对象（覆盖前自动备份到 `backups/`）。日常更新用 `npm run daily-update`，它只改有变化的字段，不需要这个命令。

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

## 15. 生成连板题材演绎表（Excel，可编辑）

用途：用四连板股票检验「新闻/题材判断」程序化之后准不准。先运行网站服务（新闻和 K 线都从服务接口获取）：

```text
npm start
npm run news-theme
npm run news-theme -- --start 20250101 --end 20251231 --out reports/2025四连板题材演绎.xlsx
```

默认从 `test-cases/四连板及以上.json` 取股票（只用 `code`、`date`、`stockName`），对每只股票调用 `/api/news` 获取新闻（与回放页面新闻面板同源，含临时置顶；脚本传 `days=2`，只取首板日和前一个交易日，按同花顺交易日历取连续交易日，两日之间的周末/假期新闻也算，前一个交易日没有新闻就只有首板日的新闻；起始日写在「新闻起始日期」列），输出 `reports/四连板题材演绎.xlsx`。脚本见 [news-theme-table.js](news-theme-table.js)。

新闻按「代码|首板日」缓存在 `reports/news-cache.json`，重跑时不重复请求（新闻天数变了会自动重新获取）；加 `--refresh-news` 重新获取。

不使用 `daily-review/连板股票.json` 的涨停原因：那是同花顺事后整理的，不是首板时能看到的新闻。`连板股票.json` 留给「同题材更高连板」因子使用（见 [ROADMAP.md](ROADMAP.md)）。

工作簿包含四张表：

- **题材演绎**：每只股票一行，按首板日期排序。先列锚定的重要新闻（标题、时间、原文链接、类别、命中关键词、是否有重要新闻、其他候选），再列连板高度、首板到见顶/断板的天数和涨幅。
- **题材汇总**：只用 `人工题材`（按「+」拆成标签）：首次/最后出现日期、股票数、平均到见顶和断板天数、平均涨幅、股票列表和代表新闻。还没填人工题材时这张表是空的。
- **类别汇总**：按新闻类别（有人工类别时用人工类别）做同样的汇总，可以对比各类新闻的股票走得多远。
- **说明**：本次运行的输入、日期范围和全部判定规则。

重要新闻的判定规则：

- 新闻只用首板日和前一个交易日（含两日之间的周末/假期）的同花顺个股时间线标题，不用首板之后的信息。
- 五类实质语料：政策规范（部委、政策、规范、免签、补贴等）、新叙事（首个、首次、第一次、全球首等）、行业利好（订单、涨价、景气、开工、中标等）、海外/明星公司（特斯拉、英伟达、华为、DeepSeek 等）、资本运作转型（设立子公司、收购、重组、控制权变更等）。
- 排除龙虎榜、资金流向、涨停分析、例行公告等行情/例行信息；只描述板块拉升暴涨、没有命中五类的标题不算。
- 评分 = 命中类别数 + 1，标题点名个股再 +1；分数 ≥ 2 记为有重要新闻。同分时取更早的一条，作为锚定新闻。
- 规则是关键词匹配，会有误判和漏判，需要人工复核；关键词在脚本顶部的 `CATEGORIES`、`NOISE_PATTERN`、`MARKET_PATTERN` 中修改。
- 同一套标准写成了给大模型用的分类 prompt：[prompts/news-classification.md](prompts/news-classification.md)，包含判断依据、输入输出格式和示例。改判断标准时，脚本关键词和 prompt 要一起改。

到最高点天数：首板日算第 1 天，在首板日起 20 个交易日内找最高价。K 线接口只返回到首板后一个月（约 23 根），所以窗口最大 22。最高点落在窗口内最后一根 K 线时（窗口取满，或近期首板、长假导致数据不足一个窗口），`可能未见顶` 列标「是」。

断板日：首板之后第一根收盘不是涨停的 K 线，首板日算第 1 天，写入 `断板日期`、`到断板天数`。数据内一直涨停时，暂用最后一根 K 线，`断板未出现` 列标「是」。连板高度是首板起连续收盘涨停的天数（含首板），按 K 线计算，涨停按 5%/10%/20%/30% 涨停价识别。

每次运行会在 `--out` 同目录写出三个文件（以默认输出为例）：

```text
reports/四连板题材演绎.xlsx         Excel 表格
reports/四连板题材演绎.json         甘特图页面读取的数据
reports/四连板题材演绎.manual.json  人工列（页面编辑和 Excel 人工列共用）
reports/四连板题材演绎.review.json  新闻核对（Debug）的人工勾选和不符理由，在页面上保存时生成
reports/四连板题材演绎.review-diff.json  点「提交核对差异」时生成：所有不符的新闻和理由
reports/news-cache.json             新闻缓存（所有输出共用）
```

**甘特图页面**：网站服务启动后打开 `http://localhost:3000/theme-gantt.html`（新增了接口，已在运行的服务需要重启一次）。

- 一个月一行，横轴是当月 1～31 日（超出当月天数的部分画斜线），每只股票画一根从首板日到最高点日的横条，标注名称和到最高点天数。跨月的横条在下一行接着画，标「（续）」，断开处是虚线。横条右端有小箭头，表示可能未见顶。
- 顶部的「按断板日结束」开关：关闭时横条画到见顶日，标注到最高点天数；打开时画到断板日，标注到断板天数（开关状态记在浏览器里）。悬停详情里两个日期都会显示。
- 颜色按新闻类别区分：政策规范、新叙事、行业利好、海外/明星公司、资本运作转型、无重要新闻。顶部的类别按钮可以勾选要显示的类型，默认全部显示（勾选状态记在浏览器里）。命中多个类别的股票，只要有一个类别被勾选就显示。
- 搜索框按名称、代码、人工题材、新闻和备注过滤；下拉框可以切换 `reports/` 下的其他数据文件。
- 所有显示新闻的地方（悬停浮窗、侧边栏、其他候选）都带发布时间（年-月-日 时:分）。人工锚定新闻如果和某条新闻标题完全相同，会补上那条的时间，否则显示「时间未知」。
- 鼠标悬停显示详情；点击横条打开右侧编辑栏，可以改 `人工锚定新闻`、`人工类别`、`人工题材`、`备注`，保存后立刻写入 `.manual.json`。改了人工类别，横条颜色会跟着变；编辑过的横条带 ✎ 标记。

**新闻核对（Debug）**：用来检验自动判断准不准。**对比对象**：有大模型结果（`npm run news-llm`，见第 17 节）的股票和大模型比，没有的和关键词规则比。打开顶部的「新闻核对（Debug）」开关后点击股票，侧边栏会出现新闻核对区：

1. 按天分组列出首板日和前一个交易日（含两日之间的周末/假期）的全部新闻（新的在上，默认展开前两天），每条带发布时间和链接；抓到原文的可以点「原文」展开正文（`npm run news-body` 抓取）。
2. 勾选你认为重要的新闻；一条都不重要就勾「没有重要新闻」。
3. 先盲选：保存之前不显示自动判断，避免被带偏。点「保存并对比」后才揭晓：
   - 每条新闻标出「一致 / 你选了·模型没选 / 模型选了·你没选」，以及模型锚定的是哪条；
   - 大模型的类别、「新东西」和判断理由，无关或否定、中性、表象时另外标出，关键词规则的结论（规则：重要/不重要）放在后面做对照；
   - 结果区显示首板涨停原因和模型对整只股票的理由。
4. 不符的新闻下面有理由输入框，每条都可以写为什么，离开输入框自动保存（清空即删除）。
5. 点「重新选择」可以修改（已写的理由会保留）；「下一只未核对」跳到下一只没核对过的股票；「下一只不一致」跳到下一只「有无重要新闻」和自动判断不一致的股票，用来逐只重看分歧。
6. 核对完一批后点顶部的「提交核对差异」，把所有已核对股票里不符的新闻写入 `reports/四连板题材演绎.review-diff.json`：每条带模型的判断和理由、关键词规则的结论、涨停原因和你的理由，交给 Claude 读取并据此调 prompt。

顶部汇总所有已核对的股票：和谁比、有无重要新闻一致率、锚定命中率（你认为有重要新闻、且自动也锚定了一条时，锚定的那条在不在你的选择里）、逐条精确率（一致 ÷ 自动选中）和召回率（一致 ÷ 你选中）。甘特图上已核对的股票标 ✓（有无重要新闻与自动一致）或 ✗（不一致）。

核对结果保存在 `reports/四连板题材演绎.review.json`，与人工列分开，不进 Excel。对比每次打开时重新计算：重跑大模型或改了关键词规则，刷新页面就能看到新的一致率，不用重新生成表格。

**人工编辑**：上面四列在页面和 Excel 里都可以改，按「代码 + 首板日期」匹配。

- 页面上保存的内容立刻生效，下次运行脚本时写进 Excel。
- Excel 里改的内容，下次运行脚本时同步到页面。
- 两边改的不一样时，以较新的一方为准：页面编辑的保存时间晚于 Excel 文件的修改时间，就用页面的，否则用 Excel 的。
- 题材汇总优先使用 `人工题材`。其他列会按规则重新生成，手动改了也会被覆盖。
- 编辑只保存在本地 `reports/` 目录，不上传 R2。

可选参数：

| 参数 | 说明 |
| --- | --- |
| `--input <JSON>` | 用例文件（`code`、`date`、`stockName`），默认 `test-cases/四连板及以上.json` |
| `--start <日期>` | 只统计首板日不早于该日期的股票（`YYYYMMDD` 或 `YYYY-MM-DD`） |
| `--end <日期>` | 只统计首板日不晚于该日期的股票 |
| `--out <xlsx>` | 输出路径，默认 `reports/四连板题材演绎.xlsx` |
| `--window <天数>` | 首板日起找最高点的交易日窗口，默认 20，最大 22 |
| `--base-url <地址>` | 网站服务地址，默认 `http://localhost:3000` |
| `--workers <数量>` | 并发请求数（新闻和 K 线），默认 3 |
| `--refresh-news` | 忽略 `reports/news-cache.json` 的缓存，重新获取新闻 |

## 16. 获取首板当天的涨停原因

```bash
npm run first-board-reason
npm run first-board-reason -- test-cases/四连板及以上.json test-cases/三连板及以上.json
npm run first-board-reason -- --max-queries 30
```

获取用例 JSON 里每只股票首板当天的同花顺涨停原因（如「华为+鸿蒙概念+类脑智能感知」），按「代码|首板日」保存到 `reports/首板涨停原因.json`，供新闻判断读取。涨停原因是同花顺当天收盘后给出的，首板晚上复盘时能看到；它只用来判断新闻和个股有没有关联，不当作新闻本身。脚本见 [first-board-reason.js](first-board-reason.js)。

两个数据来源，脚本自动选择：

1. **同花顺涨停池接口**（`data.10jqka.com.cn/dataapi/limit_up/limit_up_pool`）：不用登录、不限次数，但只能查到大约一年内的日期（2026-10 实测最早到 2025-10-14）。
2. **问财**（更早的日期，以及接口里没有的股票）：通过 Chrome 9222 调试端口打开问财，需要先在 Chrome 窗口（`C:\chrome_temp` 配置，和 `chain-stocks.js` 共用）登录同花顺账号。
   - 免费账号一个问句最多 10 个条件，每个股票代码算一个，所以每问最多放 9 个代码，按月分组，一次拿到区间内每天的涨停原因。
   - 区间结果偶尔会漏掉某天的数据，漏掉的再按「同一天的代码 + 单个日期」补查一次，仍然没有才记为找不到。
   - 每个账号每天大约 100 次查询。次数用完时脚本会停下并提示，已获取的已经保存；在 Chrome 里换账号后重跑同一条命令，会跳过已完成的接着查。

输出格式：

```json
{
  "002819|2024-01-03": {
    "code": "002819",
    "date": "2024-01-03",
    "stockName": "东方中科",
    "reason": "华为+鸿蒙概念+类脑智能感知",
    "found": true,
    "source": "iwencai",
    "fetchedAt": "2026-10-29T01:02:03.000Z"
  }
}
```

`source` 是 `limit_up_pool`（接口）或 `iwencai`（问财）；`found: false` 且 `retried: true` 表示单日补查后仍然没有。

| 参数 | 说明 |
| --- | --- |
| `[用例JSON ...]` | 一个或多个用例文件（`code`、`date`、`stockName`），默认 `test-cases/四连板及以上.json` |
| `--max-queries <次数>` | 本次最多使用的问财查询次数，默认 90；设为 0 只走接口 |
| `--refresh` | 忽略已保存的记录，全部重新获取 |

注意：系统设置了 HTTP 代理时，脚本会自动把 `127.0.0.1` 加进 `NO_PROXY`，否则连不上 Chrome 调试端口。

## 17. 用大模型判断新闻（DeepSeek）

```bash
npm run news-llm -- --limit 20                 # 先跑前 20 只看效果
npm run news-llm -- --only-reviewed
npm run news-llm -- --keys "600593|2024-01-03"
npm run news-body                               # 只抓新闻原文（news-llm 也会自动抓缺的）
```

一次要调用超过 100 只时先显示只数和估算费用并询问（非交互运行时直接停下），加 `--yes` 不询问。

按 [prompts/news-classification.md](prompts/news-classification.md) 的「Prompt 正文」作为 system 消息，每只股票一次调用，逐条判断新闻的关联、肯定/否定、新东西、类别。**重要性只看标题措辞**（散户看到的是标题），原文只用来在标题看不出时确认关联。输入有四样：

- 题材演绎表的股票（`reports/四连板题材演绎.json`）；
- 新闻标题（`reports/news-cache.json`）；
- **新闻原文片段**：只用来确认关联。标题没点名本股时，从正文里截取提到本股（名称或代码）的一两句话，没有就截取提到涨停原因关键词的句子，每段前后各 60 字；
- 首板涨停原因（`reports/首板涨停原因.json`），只用来判断关联。

结果缓存在 `reports/news-llm.json`。prompt、搜索开关或输入（新闻、正文、涨停原因）变了，会自动重新调用。跑完会和人工核对（`.review.json`）对比，同时列出关键词规则的结果做对照。脚本见 [news-llm.js](news-llm.js)。

接口配置在 `.env`：`BASEURL`、`APIKEY`、`MODEL`。`BASEURL` 以 `/anthropic` 结尾时走 Anthropic 格式（如 DeepSeek 官方 `https://api.deepseek.com/anthropic`，支持联网搜索），否则走 OpenAI 格式（如阿里百炼 `.../compatible-mode/v1`，模型 `deepseek-v4.1-flash`）。

**省 token**：system prompt（约 7000 字）每次都一样、放在最前面，靠接口的前缀缓存命中；每只股票不同的部分只有新闻标题和原文片段。2026-10-29 在阿里接口上实测：每只输入约 4.7k token，其中约 85% 命中缓存；开思考时每只输出约 1150 token，关思考约 320 token。之前给 1200 字全文时，每只输入 7.5k、缓存命中只有 49%。

**回测一律不联网**（默认）：联网搜索拿到的是现在的网页，2026-10-29 试跑时，网址能看出日期的来源有 73% 晚于首板日（首板后的涨停分析、异常波动公告），是未来信息。`--search` 只在每天实盘时用。

| 参数 | 说明 |
| --- | --- |
| `--limit N` | 只处理前 N 只（按首板日期），默认全部 |
| `--keys` | 只处理指定股票，逗号分隔，格式 `代码|首板日` |
| `--only-reviewed` | 只处理已经人工核对过的股票 |
| `--workers N` | 并发请求数，默认 4。DeepSeek 会按账户余额限制并发（余额低时上限 5），超过会报 Too many requests |
| `--no-thinking` | 关闭模型思考，输出少约 70%，但试跑时精确率低 8 个点（默认开） |
| `--out 文件名` | 结果另存到 `reports/<文件名>`，不覆盖页面读取的 `news-llm.json`。关思考对照用 `--no-thinking --out news-llm-fast.json` |
| `--cascade` | 分层：先全部关思考跑（存 `news-llm-fast.json`），关思考结论和关键词规则不一致的（四连板约 23%）再开思考重跑，合并写入 `news-llm.json`（每只记 `cascade` 字段）。四连板实测 453 只空闲价约 1.95 元，比全开思考省约 35%，股票级一致率接近 |
| `--search` | 给模型联网搜索工具（只用于实盘，只支持 Anthropic 格式） |
| `--no-body` | 不抓、不提供新闻原文 |
| `--refresh` | 忽略缓存重新调用 |
| `--report 名称` | 题材演绎表名称，默认 `四连板题材演绎` |

**新闻原文**（[news-body.js](news-body.js)）：同花顺新闻页和微信文章要执行脚本才有正文，所以用无头 Chrome 渲染后，从标题出现的位置往后截取文字。按链接缓存在 `reports/news-body-cache.json`，抓过的不再抓；`npm run news-body -- --retry-failed` 重抓失败的。浏览器用 `--no-proxy-server` 直连，因为新闻站点都在国内，走系统代理经常超时，直连约 0.5 秒一页。2026-10-29 四连板 2883 个链接拿到正文 2841 个，失败的主要是已删除的微信文章。

## 18. 一进二选股（四条件）

```bash
npm run stock-pick -- --start 20261030 --end 20261030 --name 今日选股
```

按 [STOCK_PICK_METHOD.md](STOCK_PICK_METHOD.md) 的条件，从首板股里选出次日（二板日）要盯的票：主板非 ST 首板 → 收盘价 < 30 元 → 活跃（近 20 日均量 ÷ 常态量 ≥ 1.27，且近 60 日放量天数 ≥ 7）→ 当天同题材另有 1–10 家涨停 → 重要新闻至少一条属于新叙事、海外/明星公司、企业荣誉/重要会议、资本运作转型 → 每天按近 60 日放量天数取前 2 只。需要先 `npm start`。脚本见 [stock-pick.js](stock-pick.js)，参数在顶部的 `RULES`。

- 先补齐 `reports/全市场涨停原因.json`（同花顺涨停池接口，近一年免费；15:00 前不取当天），同题材按 [theme-synonyms.json](theme-synonyms.json) 归并近义标签。
- 过了前三个条件的候选写入 `test-cases/<name>.json`。没有新闻结论时，脚本会提示依次运行 `first-board-reason`（加 `--max-queries 0`）、`news-theme --input`、`news-llm --report`，然后再跑一次本命令。
- 结果写入 `reports/<name>.结果.json`：`picks` 是所有条件都满足的票，`candidates` 是过了前三个条件的票。回看历史时，`triggered` 标出次日是否触发了买点（出现在 `test-cases/一进二回测_*.detail.json` 里、且竞价没有涨停开盘），`firstTouch` 是触板时间，`openAtLimit` 为 true 表示竞价涨停开盘（不买），`pnlPct` 是 `daily-review/` 里的收益。

| 参数 | 说明 |
| --- | --- |
| `--start` / `--end` | 首板日范围，`YYYYMMDD` |
| `--name` | 输出文件名，默认 `选股候选` |
| `--base-url` | 网站服务地址，默认 `http://localhost:3000` |
| `--workers` | 并发 K 线请求数，默认 4 |

## 19. 新闻类别评审页面

网站服务启动后打开 `http://localhost:3000/news-category.html`。按六个新闻类别浏览大模型判为重要的新闻：标题、首板涨停原因、模型类别、「新东西」和判断依据，顺序打乱。每条可以评「判断对 / 类别不对（勾选正确类别）/ 不算重要」并写理由，结果写入 `reports/news-category.review.json`。快捷键：J / K 上下移动，1 / 2 / 3 评审，0 撤销，B 展开原文。

## 20. 生成一进二回测用例（逐笔判断）

```bash
npm run yijiner-cases -- --start 20260106 --end 20261231
npm run yijiner-cases -- --start 20240104 --end 20241231 --replace   # 整段重查并重写
```

`npm run turnover -- 起始 结束` 内部调用的就是它（另外负责 R2 读写和每日复盘同步）。脚本见 [yijiner-cases.js](yijiner-cases.js)。

1. 先用同花顺涨停池接口把 `reports/全市场涨停原因.json` 补到 `--end`（见 [limit-up-list.js](limit-up-list.js)；接口只能查一年内，更早的历史是用问财按月区间问句取的）。
2. 对每个二板日 T，取前一交易日 D 的涨停名单里主板（60、00 开头）、非 ST、D 的前一交易日没有涨停的股票。
3. 用通达信逐笔成交：D 的最后一笔是原始收盘价，算出 T 的涨停价（× 1.1）；T 在 10:30 前（含 10:30 那一分钟）有成交在涨停价、且不是全天都在涨停价（一字板），就是一条用例。不需要网站服务，也不用问财额度。

输出 `test-cases/一进二回测_<start>_<end>.json`（格式与原来相同：`id`、`date`=首板日、`code`、`marketCode`、`stockName`），本次运行的首次触板时间和失败明细写入同名 `.detail.json`。已有同名文件时保留已有记录，从最后一个首板日之后接着查；`--replace` 整段重查。`--workers` 是并发的通达信连接数，默认 6，最大 12。

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

## 21. 把选股判断写进每日复盘

```bash
npm run review-judge -- 一进二回测 --upload
```

给 `daily-review/` 下一进二回测 JSON 的每条记录加 `judge` 字段，每日复盘页面的新闻面板会显示：第一行是首板涨停原因，下面是同题材当天涨停（含连板数）、同题材当天刚断板的 2 板以上高标、大模型新闻判断（强类 / 仅弱类 / 无）；新闻列表里大模型判为重要的新闻标红，并显示类别、「新东西」和判断依据。二板日首次触板时间、是否竞价涨停开盘在买入或空仓后才显示。活跃度和量堆由页面按 K 线实时计算，不在这里写。

- 数据来自 `reports/首板涨停原因.json`、`reports/全市场涨停原因.json`、`reports/news-llm.json`、`test-cases/一进二回测_*.detail.json`；同题材的判断规则和 `stock-pick` 一样（[theme-synonyms.json](theme-synonyms.json)）。
- 不带关键字处理全部一进二回测文件；`--upload` 同时更新 R2 的 `daily-review/` 同名文件（读 R2 版本、只改 `judge` 再写回）。
- `npm run turnover` / `npm run daily-update` 会自动跑这一步（第 3 节）。没有新闻判断的记录只显示涨停原因和同题材。

## 22. 自由流通市值

```text
npm run free-float                        # 默认最多问 20 次问财
npm run free-float -- --max-queries 90    # 补历史时加大次数
npm run free-float -- --upload            # 同时更新 R2 的 daily-review/
```

给 `daily-review/` 下今日首板和一进二回测文件的每条记录写 `freeFloatCap`（首板当天的自由流通市值，元），页面固定显示在成交额右边，不随鼠标所指的 K 线变化。

- 通达信只有流通股本（含持股 5% 以上的大股东），没有自由流通股，所以用问财（Chrome 9222 调试端口，需要登录；账号每天约 100 次，和涨停原因共用）。
- 按月分组，每问最多 9 个代码，一次拿到区间内每天的值；从最近的日期往前查，结果缓存在 `reports/自由流通市值.json`，查过的跳过。
- `npm run turnover` / `npm run daily-update` 会自动跑（第 3 节第 5 步），每天新增约 4 问；历史记录每天顺带补 20 问左右。
