require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { r2Client, writeJson } = require('./r2-storage');

const TEST_CASE_DIR = path.join(__dirname, 'test-cases');
// 首板日收盘价缓存 { '代码|日期': 收盘价 }：查过的不再请求，每天只查新增的记录
const CLOSE_CACHE_FILE = path.join(__dirname, 'reports', 'under30-close.json');
const KLINE_URL = 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1/single_kline';
const REQUEST_CONCURRENCY = 5;
// test-cases/ 下的全部「一进二回测_起始_结束.json」（daily-update 跨年时会新建当年的文件）
const SOURCE_RANGES = fs.readdirSync(TEST_CASE_DIR)
  .map(file => /^一进二回测_(\d{8})_(\d{8})\.json$/.exec(file))
  .filter(Boolean)
  .map(match => [match[1], match[2]])
  .sort((left, right) => left[0].localeCompare(right[0]));

function sourceFile(start, end) {
  return path.join(TEST_CASE_DIR, `一进二回测_${start}_${end}.json`);
}

function outputFile(start, end) {
  return path.join(TEST_CASE_DIR, `一进二回测_小于30元_${start}_${end}.json`);
}

function outputKey(start, end) {
  return `test-cases/一进二回测_小于30元_${start}_${end}.json`;
}

function getMarketCode(code) {
  if (code.startsWith('6')) return '17';
  if (code.startsWith('0') || code.startsWith('3')) return '33';
  if (code.startsWith('8') || code.startsWith('4')) return '151';
  return '33';
}

function getTradingDate(timestamp) {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 1);
  if (day === 5) date.setUTCDate(date.getUTCDate() + 2);
  if (day === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().split('T')[0];
}

async function getHistory(code, cutoffDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cutoffDate);
  if (!match) throw new Error(`日期格式无效: ${cutoffDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextMonthYear = month === 12 ? year + 1 : year;
  const endTime = Date.UTC(nextMonthYear, nextMonth - 1, day);
  const response = await axios.post(KLINE_URL, {
    code_list: [{ codes: [code], market: getMarketCode(code) }],
    trade_class: 'intraday',
    time_period: 'day_1',
    trade_date: -1,
    begin_time: -350,
    end_time: endTime,
    adjust_type: 'forward',
    gpid: 1,
  }, {
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      origin: 'https://www.iwencai.com',
      referer: 'https://www.iwencai.com/',
      'source-id': 'hxkline-AIME_Component_Library_Component',
      'user-agent': 'Mozilla/5.0',
      'x-auth-appname': 'AINVEST',
      'x-auth-progid': '7047',
      'x-auth-type': 'ths',
      'x-auth-version': '1.0',
      'x-fuyao-auth': 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhdXRob3JpemVyX25hbWVzcGFjZSI6ImNvbW1vbi1ocS1hZ2dyIiwibGljZW5zZWVfdHlwZSI6IkZST05UX0FQUCIsImxpY2Vuc2VlX25hbWVzcGFjZSI6Imh4a2xpbmUtQUlNRV9Db21wb25lbnRfTGlicmFyeV9Db21wb25lbnQifQ.MWqYrKk4Y2_oWTbG3XZjNGoHK_GmIi_KeJKc_mNDqTA',
    },
    timeout: 30000,
  });
  const values = response.data?.status_code === 0
    ? response.data.data?.quote_data?.[0]?.value || []
    : [];
  return values.map(value => ({
    date: getTradingDate(value[0]),
    close: Number(value[4]),
  }));
}

async function getClosePrice(item) {
  const rows = await getHistory(item.code, item.date);
  const target = rows.find(row => row.date === item.date);
  const price = Number(target?.close);
  return Number.isFinite(price) ? price : null;
}

async function filterFile(start, end) {
  const inputPath = sourceFile(start, end);
  const outputPath = outputFile(start, end);
  if (!fs.existsSync(inputPath)) throw new Error(`找不到源文件: ${inputPath}`);

  const cases = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const closeCache = fs.existsSync(CLOSE_CACHE_FILE) ? JSON.parse(fs.readFileSync(CLOSE_CACHE_FILE, 'utf8')) : {};
  const cacheKey = item => `${item.code}|${item.date}`;
  const prices = cases.map(item => closeCache[cacheKey(item)] ?? null);
  const todo = cases.map((item, index) => index).filter(index => prices[index] === null);
  let nextIndex = 0;
  let completed = 0;
  let missing = 0;

  async function worker() {
    while (nextIndex < todo.length) {
      const index = todo[nextIndex];
      nextIndex += 1;
      let price = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          price = await getClosePrice(cases[index]);
          break;
        } catch (error) {
          if (attempt === 3) {
            console.error(`查询失败 ${cases[index].code} ${cases[index].date}: ${error.message}`);
          } else {
            await new Promise(resolve => setTimeout(resolve, attempt * 300));
          }
        }
      }
      prices[index] = price;
      if (price === null) missing += 1;
      else closeCache[cacheKey(cases[index])] = price;
      completed += 1;
      if (completed % 50 === 0 || completed === todo.length) {
        console.log(`${start}-${end} 查询收盘价: ${completed}/${todo.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: REQUEST_CONCURRENCY }, worker));
  fs.mkdirSync(path.dirname(CLOSE_CACHE_FILE), { recursive: true });
  fs.writeFileSync(CLOSE_CACHE_FILE, `${JSON.stringify(closeCache)}
`, 'utf8');
  // 查不到收盘价的（如已退市）和原来一样保留
  const filtered = cases.filter((_, index) => prices[index] === null || prices[index] < 30);
  fs.writeFileSync(outputPath, `${JSON.stringify(filtered, null, 2)}\n`, 'utf8');

  if (r2Client) {
    await writeJson(outputKey(start, end), filtered);
  }
  console.log(`${path.basename(outputPath)}: ${filtered.length}/${cases.length} 条，新查 ${todo.length} 条，未匹配 ${missing} 条${r2Client ? '，已写入 R2' : ''}`);
}

// 用法: npm run filter-under30 -- [关键字...]   不带参数处理全部年份；如 2026 或 20260106 只处理匹配的源文件
async function main() {
  const keywords = process.argv.slice(2);
  const ranges = keywords.length
    ? SOURCE_RANGES.filter(range => keywords.some(keyword => `${range[0]}_${range[1]}`.includes(keyword)))
    : SOURCE_RANGES;
  if (!ranges.length) throw new Error(`没有匹配 ${keywords.join(' ')} 的源文件`);
  for (const [start, end] of ranges) {
    await filterFile(start, end);
  }
}

main().catch(error => {
  console.error(`低价回测筛选失败: ${error.message}`);
  process.exitCode = 1;
});
