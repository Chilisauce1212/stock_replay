require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TRADE_DAY_URL = 'https://data.10jqka.com.cn/dataapi/limit_up/trade_day';
const TIMELINE_URL = 'https://m.10jqka.com.cn/app/timeline/v2/list';
const REQUEST_CONCURRENCY = 3;
const REQUEST_INTERVAL_MS = 100;
const THS_COOKIE = String(process.env.THS_COOKIE || '').trim();
let requestQueue = Promise.resolve();
let nextRequestAt = 0;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForRequestSlot() {
  let release;
  const previous = requestQueue;
  requestQueue = new Promise(resolve => { release = resolve; });
  await previous;
  const delay = Math.max(0, nextRequestAt - Date.now());
  if (delay) await sleep(delay);
  nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
  release();
}

function getRequestUrl(config) {
  try {
    return axios.getUri(config);
  } catch {
    return config?.url || '未知请求地址';
  }
}

function getRequestHeaders(referer) {
  return {
    'User-Agent': 'Mozilla/5.0',
    Referer: referer,
    ...(THS_COOKIE ? { Cookie: THS_COOKIE } : {}),
  };
}

function getMarketCode(code) {
  const value = String(code);
  if (value.startsWith('6')) return '17';
  if (value.startsWith('0') || value.startsWith('3')) return '33';
  if (value.startsWith('8') || value.startsWith('4')) return '151';
  return '33';
}

function toDateString(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return '';
}

function toCompactDate(value) {
  return toDateString(value).replaceAll('-', '');
}

function dayStart(dateString) {
  return new Date(`${dateString}T00:00:00+08:00`).getTime();
}

function dayEnd(dateString) {
  return dayStart(dateString) + 24 * 60 * 60 * 1000;
}

function createInitialNewsOffset() {
  const fraction = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  return `${Math.floor(Date.now() / 1000)}.${fraction}`;
}

async function getPreviousTradingDays(dateString) {
  await waitForRequestSlot();
  const response = await axios.get(TRADE_DAY_URL, {
    params: { date: toCompactDate(dateString), stock: 'stock', next: 1, prev: 5 },
    headers: getRequestHeaders('https://data.10jqka.com.cn/'),
    timeout: 15000,
  });
  const data = response.data?.status_code === 0 ? response.data.data : null;
  const previous = Array.isArray(data?.prev_dates) ? data.prev_dates.map(toDateString) : [];
  if (!data?.trade_day || previous.length < 4) return [];
  return previous.slice(-4);
}

function normalizeTimelineItem(item) {
  const combination = Array.isArray(item?.combination) ? item.combination : [];
  const titlePart = combination.find(part => part?.title?.content);
  const timePart = combination.find(part => Number.isFinite(Number(part?.bottomBar?.time)));
  const publishTime = Number(timePart?.bottomBar?.time);
  const title = String(titlePart?.title?.content || '').trim();
  if (!Number.isFinite(publishTime) || !title) return null;
  return { publishTime, title };
}

async function fetchNews(code, startDate, endDate) {
  const startTime = dayStart(startDate);
  const endTime = dayEnd(endDate);
  let offset = createInitialNewsOffset();
  const news = [];

  for (let page = 0; page < 100; page += 1) {
    await waitForRequestSlot();
    const marketCode = getMarketCode(code);
    const stockCode = String(code).padStart(6, '0');
    const response = await axios.get(`${TIMELINE_URL}/${marketCode}/${stockCode}/${offset}`, {
      headers: getRequestHeaders('https://m.10jqka.com.cn/'),
      validateStatus: status => status < 500,
      timeout: 15000,
    });
    if (response.data?.errorCode !== 0) {
      throw new Error(`时间线接口返回异常: HTTP ${response.status}，${response.data?.errorMsg || '未知错误'}，GET ${getRequestUrl(response.config)}`);
    }
    const data = response.data || {};
    const list = Array.isArray(data.pageItems) ? data.pageItems : [];
    list.forEach(item => {
      const normalized = normalizeTimelineItem(item);
      if (normalized && normalized.publishTime >= startTime && normalized.publishTime < endTime) {
        news.push(normalized);
      }
    });

    const oldestTime = Math.min(...list.map(item => {
      const normalized = normalizeTimelineItem(item);
      return normalized?.publishTime || Number.POSITIVE_INFINITY;
    }));
    const nextOffset = data.offset;
    if (!data.hasMore || !list.length || oldestTime < startTime || !nextOffset) break;
    offset = nextOffset;
  }

  const unique = new Map(news.map(item => [`${item.publishTime}-${item.title}`, item]));
  return [...unique.values()].sort((left, right) => right.publishTime - left.publishTime);
}

async function enrichCase(item, overwrite) {
  const date = toDateString(item.date);
  if (!date || !item.code) throw new Error(`记录缺少有效 code/date: ${JSON.stringify(item)}`);
  if (!overwrite && Array.isArray(item.news)) return item;
  const previousDays = await getPreviousTradingDays(date);
  if (previousDays.length < 4) return { ...item, news: [] };
  const startDate = previousDays[0];
  const endDate = date;
  const news = await fetchNews(item.code, startDate, endDate);
  return { ...item, news };
}

function resolveInputPath(input) {
  const inputPath = path.resolve(process.cwd(), input);
  const root = path.resolve(__dirname);
  if (!inputPath.startsWith(`${root}${path.sep}`) || !inputPath.toLowerCase().endsWith('.json')) {
    throw new Error('输入必须是项目目录内的 JSON 文件，例如 test-cases/文件.json');
  }
  return inputPath;
}

async function main() {
  const args = process.argv.slice(2);
  const overwrite = args.includes('--overwrite');
  const inputs = args.filter(arg => arg !== '--overwrite');
  const input = inputs[0];
  if (!input || inputs.length > 1) {
    throw new Error('用法: npm run add-news -- [--overwrite] test-cases/输入文件.json');
  }
  const inputPath = resolveInputPath(input);
  const records = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!Array.isArray(records)) throw new Error('JSON 根节点必须是数组');

  const result = new Array(records.length);
  let nextIndex = 0;
  let completed = 0;
  let errors = 0;

  async function worker() {
    while (nextIndex < records.length) {
      const index = nextIndex++;
      try {
        result[index] = await enrichCase(records[index], overwrite);
      } catch (error) {
        errors += 1;
        result[index] = records[index];
        console.error(`新闻查询失败 ${records[index].code || '--'} ${records[index].date || '--'}: ${error.message}`);
      }
      completed += 1;
      if (completed % 20 === 0 || completed === records.length) {
        console.log(`新闻处理进度: ${completed}/${records.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(REQUEST_CONCURRENCY, records.length || 1) }, worker));
  fs.writeFileSync(inputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`新闻写入完成: ${path.relative(process.cwd(), inputPath)}，记录 ${result.length} 条，失败 ${errors} 条`);
}

main().catch(error => {
  console.error(`添加新闻失败: ${error.message}`);
  process.exitCode = 1;
});