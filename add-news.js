require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TRADE_DAY_URL = 'https://data.10jqka.com.cn/dataapi/limit_up/trade_day';
const NEWS_URL = 'https://news.10jqka.com.cn/timeline_web/web/v1/news/list';
const REQUEST_CONCURRENCY = 3;
const PAGE_SIZE = 100;

function getMarketId(code) {
  return String(code).startsWith('6') ? '17' : '33';
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
  return `${Date.now()}.${fraction}`;
}

async function getPreviousTradingDays(dateString) {
  const response = await axios.get(TRADE_DAY_URL, {
    params: { date: toCompactDate(dateString), stock: 'stock', next: 1, prev: 5 },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
  });
  const data = response.data?.status_code === 0 ? response.data.data : null;
  const previous = Array.isArray(data?.prev_dates) ? data.prev_dates.map(toDateString) : [];
  if (!data?.trade_day || previous.length < 5) return [];
  return previous.slice(-5);
}

function normalizeNews(item) {
  const publishTime = Number(item.publishTime);
  const title = String(item.title || item.newsTitle || item.name || item.summary || '').trim();
  if (!Number.isFinite(publishTime) || !title) return null;
  return {
    publishTime,
    title,
    url: String(item.url || item.detailUrl || '').trim() || undefined,
  };
}

async function fetchNews(code, startDate, endDate) {
  const startTime = dayStart(startDate);
  const endTime = dayStart(endDate);
  let offset = createInitialNewsOffset();
  const news = [];

  for (let page = 0; page < 100; page += 1) {
    const response = await axios.get(NEWS_URL, {
      params: { marketId: getMarketId(code), code: String(code).padStart(6, '0'), offset, size: PAGE_SIZE },
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://news.10jqka.com.cn/' },
      validateStatus: status => status < 500,
      timeout: 15000,
    });
    if (response.data?.status_code !== 0) {
      throw new Error(`新闻接口返回异常: HTTP ${response.status}，${response.data?.status_msg || '未知错误'}`);
    }
    const data = response.data?.data || {};
    const list = Array.isArray(data.newsList) ? data.newsList : [];
    list.forEach(item => {
      const normalized = normalizeNews(item);
      if (normalized && normalized.publishTime >= startTime && normalized.publishTime < endTime) {
        news.push(normalized);
      }
    });

    const oldestTime = Number(list.at(-1)?.publishTime || 0);
    const nextOffset = data.offset;
    if (!data.hasMore || !list.length || oldestTime < startTime || !nextOffset) break;
    offset = nextOffset;
  }

  const unique = new Map(news.map(item => [`${item.publishTime}-${item.title}`, item]));
  return [...unique.values()].sort((left, right) => left.publishTime - right.publishTime);
}

async function enrichCase(item) {
  const date = toDateString(item.date);
  if (!date || !item.code) throw new Error(`记录缺少有效 code/date: ${JSON.stringify(item)}`);
  const previousDays = await getPreviousTradingDays(date);
  if (previousDays.length < 5) return { ...item, news: [] };
  const news = await fetchNews(item.code, previousDays[0], date);
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
  const input = process.argv[2];
  if (!input || process.argv.length > 3) {
    throw new Error('用法: npm run add-news -- test-cases/输入文件.json');
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
        result[index] = await enrichCase(records[index]);
      } catch (error) {
        errors += 1;
        result[index] = { ...records[index], news: [] };
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