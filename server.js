require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { r2Client: sharedR2Client, R2_BUCKET: sharedR2Bucket, FORCE_LOCAL, readJson, writeJson, listJsonKeys } = require('./r2-storage');
const { calcReviewPnl, RULES_VERSION } = require('./review-pnl');
const pnlKey = (code, date) => `${code}|${date}`;
const app = express();
const PORT = process.env.PORT || 3000;
const USE_LOCAL_JSON = process.env.USE_LOCAL_JSON === 'true';
const DAILY_REVIEW_DIR = path.join(__dirname, 'daily-review');
const CHAIN_STOCKS_FILE = '连板股票.json';
const TEST_CASE_DIR = path.join(__dirname, 'test-cases');
const FAVORITES_FILE = path.join(__dirname, 'favorites.json');
const REPLAY_BEFORE_COUNT = 500;
const REPLAY_AFTER_COUNT = 30;
const HISTORY_REQUEST_COUNT = 300;
const TRADE_DAY_URL = 'https://data.10jqka.com.cn/dataapi/limit_up/trade_day';
const TIMELINE_URL = 'https://m.10jqka.com.cn/app/timeline/v2/list';
const THS_COOKIE = String(process.env.THS_COOKIE || '').trim();
const R2_BUCKET = sharedR2Bucket;
const R2_OBJECT_KEY = process.env.R2_OBJECT_KEY || 'favorites.json';
const R2_ENDPOINT = process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID
  ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : '');
const r2Client = sharedR2Client || (!FORCE_LOCAL && R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  ? new S3Client({
    endpoint: R2_ENDPOINT,
    region: 'auto',
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })
  : null);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readLocalFavorites() {
  try {
    return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
  } catch {
    return { groups: {} };
  }
}

function writeLocalFavorites(favorites) {
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favorites, null, 2), 'utf8');
}

async function readFavorites() {
  if (!r2Client) return readLocalFavorites();

  try {
    const response = await r2Client.send(new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: R2_OBJECT_KEY,
    }));
    const bytes = await response.Body.transformToByteArray();
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
    const localFavorites = readLocalFavorites();
    if (Object.keys(localFavorites.groups || {}).length) await writeFavorites(localFavorites);
    return localFavorites;
  }
}

async function writeFavorites(favorites) {
  writeLocalFavorites(favorites);
  if (!r2Client) return;

  await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: R2_OBJECT_KEY,
    Body: JSON.stringify(favorites, null, 2),
    ContentType: 'application/json; charset=utf-8',
  }));
}

function safeDailyReviewPath(fileName) {
  const safeName = path.basename(fileName || '');
  if (!/\.(xlsx|json)$/i.test(safeName)) return null;
  const filePath = path.join(DAILY_REVIEW_DIR, safeName);
  return filePath.startsWith(DAILY_REVIEW_DIR) ? filePath : null;
}

function safeDailyReviewKey(fileName) {
  const safeName = path.basename(fileName || '');
  return /\.json$/i.test(safeName) ? `daily-review/${safeName}` : null;
}

function safeTestCasePath(fileName) {
  const safeName = path.basename(fileName || '');
  if (!/\.(xlsx|json)$/i.test(safeName)) return null;
  const filePath = path.join(TEST_CASE_DIR, safeName);
  return filePath.startsWith(TEST_CASE_DIR) ? filePath : null;
}

function safeTestCaseKey(fileName) {
  const safeName = path.basename(fileName || '');
  return /\.json$/i.test(safeName) ? `test-cases/${safeName}` : null;
}

function parseXlsxTestCases(fileName) {
  const filePath = safeTestCasePath(fileName);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('测试表格不存在');

  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows.map((row, index) => {
    const dateValue = String(row['日期'] || '').trim();
    const codeValue = String(row['股票代码'] || '').trim().toUpperCase();
    const stockName = String(row['股票简称'] || '').trim();
    if (!/^\d{8}$/.test(dateValue) || !/^\d{6}\.(SH|SZ)$/.test(codeValue)) {
      return null;
    }
    return {
      id: `${index}-${dateValue}-${codeValue}`,
      date: `${dateValue.slice(0, 4)}-${dateValue.slice(4, 6)}-${dateValue.slice(6, 8)}`,
      code: codeValue.slice(0, 6),
      marketCode: codeValue,
      stockName,
    };
  }).filter(Boolean);
}

function syncJsonTestCases() {
  if (!fs.existsSync(DAILY_REVIEW_DIR)) return;
  const xlsxFiles = fs.readdirSync(DAILY_REVIEW_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.xlsx'))
    .map(entry => entry.name);

  xlsxFiles.forEach(xlsxFile => {
    const jsonFile = `${path.basename(xlsxFile, path.extname(xlsxFile))}.json`;
    const xlsxPath = path.join(DAILY_REVIEW_DIR, xlsxFile);
    const jsonPath = path.join(DAILY_REVIEW_DIR, jsonFile);
    if (!fs.existsSync(jsonPath) || fs.statSync(xlsxPath).mtimeMs > fs.statSync(jsonPath).mtimeMs) {
      fs.writeFileSync(jsonPath, JSON.stringify(parseXlsxTestCases(xlsxFile), null, 2), 'utf8');
    }
  });
}

function listLocalJson(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map(entry => entry.name);
}

async function parseChainStocks() {
  const fileName = CHAIN_STOCKS_FILE;
  if (!USE_LOCAL_JSON && sharedR2Client) {
    try {
      const data = await readJson(`daily-review/${fileName}`);
      if (!Array.isArray(data)) throw new Error('连板股票 JSON 格式错误');
      return data;
    } catch (error) {
      if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
    }
  }
  const filePath = path.join(DAILY_REVIEW_DIR, fileName);
  if (!fs.existsSync(filePath)) return [];
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(data)) throw new Error('连板股票 JSON 格式错误');
  return data;
}

async function parseDailyReview(fileName) {
  if (!USE_LOCAL_JSON && sharedR2Client && fileName.toLowerCase().endsWith('.json')) {
    const key = safeDailyReviewKey(fileName);
    if (!key) throw new Error('测试用例文件名不合法');
    const data = await readJson(key);
    if (!Array.isArray(data)) throw new Error('测试用例 JSON 格式错误');
    return data.map(item => {
      const date = String(item.date || '').trim();
      return /^\d{8}$/.test(date)
        ? { ...item, date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` }
        : item;
    });
  }
  const filePath = safeDailyReviewPath(fileName);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('测试用例文件不存在');
  if (fileName.toLowerCase().endsWith('.xlsx')) return parseXlsxTestCases(fileName);

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(data)) throw new Error('JSON 测试用例格式错误');
  return data.map(item => {
    const date = String(item.date || '').trim();
    return /^\d{8}$/.test(date)
      ? { ...item, date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` }
      : item;
  });
}

async function parseTestCases(fileName) {
  const localPath = safeTestCasePath(fileName);
  if (localPath && fs.existsSync(localPath) && fileName.toLowerCase().endsWith('.json')) {
    const localData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    if (!Array.isArray(localData)) throw new Error('JSON 测试用例格式错误');
    return localData;
  }
  if (!USE_LOCAL_JSON && sharedR2Client && fileName.toLowerCase().endsWith('.json')) {
    const key = safeTestCaseKey(fileName);
    if (!key) throw new Error('测试用例文件名不合法');
    const data = await readJson(key);
    if (!Array.isArray(data)) throw new Error('测试用例 JSON 格式错误');
    return data.map(item => {
      const date = String(item.date || '').trim();
      return /^\d{8}$/.test(date)
        ? { ...item, date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` }
        : item;
    });
  }
  const filePath = localPath;
  if (!filePath || !fs.existsSync(filePath)) throw new Error('测试用例文件不存在');
  if (fileName.toLowerCase().endsWith('.xlsx')) return parseXlsxTestCases(fileName);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(data)) throw new Error('测试用例 JSON 格式错误');
  return data;
}

app.get('/api/daily-review', async (req, res) => {
  try {
    let files;
    if (!USE_LOCAL_JSON && sharedR2Client) {
      const keys = await listJsonKeys('daily-review/');
      files = keys.map(key => key.slice('daily-review/'.length))
        .filter(file => file !== CHAIN_STOCKS_FILE);
    } else {
      syncJsonTestCases();
      files = fs.existsSync(DAILY_REVIEW_DIR)
          ? fs.readdirSync(DAILY_REVIEW_DIR, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
            .filter(entry => entry.name !== CHAIN_STOCKS_FILE)
            .map(entry => entry.name)
          : [];
    }
    res.json({ status_code: 0, files });
  } catch (error) {
    res.status(500).json({ status_code: -1, msg: `读取每日复盘失败: ${error.message}` });
  }
});

app.get('/api/chain-stocks', async (req, res) => {
  try {
    const records = await parseChainStocks();
    res.set('Cache-Control', 'no-store');
    res.json({ status_code: 0, data: records });
  } catch (error) {
    res.status(500).json({ status_code: -1, msg: `读取连板股票失败: ${error.message}` });
  }
});

app.get('/api/daily-review/:fileName', async (req, res) => {
  try {
    const cases = await parseDailyReview(req.params.fileName);
    res.json({ status_code: 0, total: cases.length, data: cases.map(({ pnl, ...item }) => item) });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

app.get('/api/favorites', async (req, res) => {
  try {
    res.json({ status_code: 0, data: await readFavorites() });
  } catch (error) {
    console.error('读取 R2 收藏失败:', error.message);
    res.status(500).json({ status_code: -1, msg: '读取收藏失败' });
  }
});

app.post('/api/favorites', async (req, res) => {
  const group = String(req.body.group || '').trim();
  const item = req.body.item;
  if (!group || !item || !item.code || !item.date) {
    return res.status(400).json({ status_code: -1, msg: '收藏分组和股票信息不能为空' });
  }
  const favorites = await readFavorites();
  favorites.groups[group] = favorites.groups[group] || [];
  const alreadySaved = favorites.groups[group].some(saved => saved.code === item.code && saved.date === item.date);
  if (!alreadySaved) {
    favorites.groups[group].push({
      code: item.code,
      marketCode: item.marketCode,
      stockName: item.stockName,
      date: item.date,
      savedAt: new Date().toISOString(),
    });
  }
  try {
    await writeFavorites(favorites);
    res.json({ status_code: 0, data: favorites, alreadySaved });
  } catch (error) {
    console.error('写入 R2 收藏失败:', error.message);
    res.status(500).json({ status_code: -1, msg: '保存收藏失败，请检查 R2 配置' });
  }
});

app.delete('/api/favorites', async (req, res) => {
  const group = String(req.body.group || '').trim();
  const code = String(req.body.code || '').trim();
  const date = String(req.body.date || '').trim();
  if (!group || !code || !date) {
    return res.status(400).json({ status_code: -1, msg: '收藏分组、股票代码和日期不能为空' });
  }

  const favorites = await readFavorites();
  const groupItems = favorites.groups[group] || [];
  favorites.groups[group] = groupItems.filter(item => !(item.code === code && item.date === date));
  if (!favorites.groups[group].length) delete favorites.groups[group];
  try {
    await writeFavorites(favorites);
    res.json({ status_code: 0, data: favorites });
  } catch (error) {
    console.error('写入 R2 收藏失败:', error.message);
    res.status(500).json({ status_code: -1, msg: '取消收藏失败，请检查 R2 配置' });
  }
});

/**
 * 根据股票代码判断同花顺的市场代码 market
 * - 6开头的沪市股票 (如 600198): market 为 "17"
 * - 0/3开头的深市/创业板股票 (如 000620): market 为 "33"
 * - 8/4开头的北交所股票: market 为 "151"
 */
function getMarketCode(code) {
  if (code.startsWith('6')) return "17";
  if (code.startsWith('0') || code.startsWith('3')) return "33";
  if (code.startsWith('8') || code.startsWith('4')) return "151";
  return "33"; // 默认 33
}

function toDateString(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return '';
}

function dayStart(dateString) {
  return new Date(`${dateString}T00:00:00+08:00`).getTime();
}

function dayEnd(dateString) {
  return dayStart(dateString) + 24 * 60 * 60 * 1000;
}

function createTimelineOffset(dateString) {
  const fraction = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  return `${Math.floor(dayEnd(dateString) / 1000)}.${fraction}`;
}

function collectCombinationFieldValues(value, fieldName, results = []) {
  if (Array.isArray(value)) {
    value.forEach(child => collectCombinationFieldValues(child, fieldName, results));
    return results;
  }
  if (!value || typeof value !== 'object') return results;

  Object.entries(value).forEach(([key, child]) => {
    if (key === fieldName) {
      if (fieldName === 'time' && (typeof child === 'string' || typeof child === 'number')) {
        results.push(String(child).trim());
      } else if (fieldName === 'recommendType' && (typeof child === 'string' || typeof child === 'number')) {
        results.push(String(child).trim());
      } else if (fieldName === 'title' && typeof child === 'string') {
        results.push(child.trim());
      } else if (fieldName === 'title' && child && typeof child === 'object') {
        ['content', 'text', 'value'].forEach(textKey => {
          if (typeof child[textKey] === 'string') results.push(child[textKey].trim());
        });
      }
    }
    collectCombinationFieldValues(child, fieldName, results);
  });
  return results;
}

// 新闻范围：回测日及之前 days - 1 个交易日（按同花顺交易日历，连续的交易日，中间的周末/假期新闻也包含在内）。
async function getNewsDateRange(dateString, days = 5) {
  const response = await axios.get(TRADE_DAY_URL, {
    params: {
      date: dateString.replaceAll('-', ''),
      stock: 'stock',
      next: 1,
      prev: 5,
    },
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://data.10jqka.com.cn/',
      ...(THS_COOKIE ? { Cookie: THS_COOKIE } : {}),
    },
    timeout: 15000,
  });
  const data = response.data?.status_code === 0 ? response.data.data : null;
  const previousDates = Array.isArray(data?.prev_dates)
    ? data.prev_dates.map(toDateString).filter(Boolean)
    : [];
  if (!data?.trade_day || previousDates.length < 4) {
    throw new Error('交易日历不足，无法确定5个交易日范围');
  }
  return {
    startDate: days > 1 ? previousDates[previousDates.length - (days - 1)] : dateString,
    endDate: dateString,
  };
}

function normalizeTimelineItem(item) {
  const combination = Array.isArray(item?.combination) ? item.combination : [];
  const titles = collectCombinationFieldValues(combination, 'title').filter(Boolean);
  const title = [...new Set(titles)].join(' ').trim();
  const time = collectCombinationFieldValues(combination, 'time')
    .find(value => Number.isFinite(Number(value)));
  const recommendType = collectCombinationFieldValues(combination, 'recommendType')
    .map(value => Number(value))
    .find(Number.isFinite);
  const publishTime = Number(time);
  if (!Number.isFinite(publishTime) || !title) return null;
  return {
    publishTime,
    title,
    jumpUrl: typeof item?.info?.jumpUrl === 'string' ? item.info.jumpUrl : '',
    isPinned: recommendType === 2,
  };
}

async function fetchPinnedTimeline(code, date) {
  const marketCode = getMarketCode(code);
  const stockCode = String(code).padStart(6, '0');
  const response = await axios.get(`${TIMELINE_URL}/${marketCode}/${stockCode}/first`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://m.10jqka.com.cn/',
      ...(THS_COOKIE ? { Cookie: THS_COOKIE } : {}),
    },
    timeout: 15000,
    validateStatus: status => status < 500,
  });
  if (response.data?.errorCode !== 0) {
    throw new Error(response.data?.errorMsg || `HTTP ${response.status}`);
  }
  const startTime = dayStart(date);
  const endTime = dayEnd(date);
  const list = Array.isArray(response.data?.pageItems) ? response.data.pageItems : [];
  return list
    .map(normalizeTimelineItem)
    .filter(item => item?.isPinned && item.publishTime >= startTime && item.publishTime < endTime);
}

async function fetchTimeline(code, startDate, endDate) {
  const marketCode = getMarketCode(code);
  const stockCode = String(code).padStart(6, '0');
  let offset = createTimelineOffset(endDate);
  const news = [];
  const startTime = dayStart(startDate);
  const endTime = dayEnd(endDate);

  for (let page = 0; page < 100; page += 1) {
    const response = await axios.get(`${TIMELINE_URL}/${marketCode}/${stockCode}/${offset}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://m.10jqka.com.cn/',
        ...(THS_COOKIE ? { Cookie: THS_COOKIE } : {}),
      },
      timeout: 15000,
      validateStatus: status => status < 500,
    });
    if (response.data?.errorCode !== 0) {
      throw new Error(response.data?.errorMsg || `HTTP ${response.status}`);
    }
    const data = response.data || {};
    const list = Array.isArray(data.pageItems) ? data.pageItems : [];
    const normalizedItems = list.map(normalizeTimelineItem).filter(Boolean);
    normalizedItems.forEach(item => {
      if (item.publishTime >= startTime && item.publishTime < endTime) news.push(item);
    });
    const oldestTime = normalizedItems.length
      ? Math.min(...normalizedItems.map(item => item.publishTime))
      : Number.POSITIVE_INFINITY;
    const nextOffset = data.offset;
    if (!data.hasMore || !list.length || oldestTime < startTime || !nextOffset) break;
    offset = nextOffset;
  }

  return [...new Map(news.map(item => [`${item.publishTime}-${item.title}`, item])).values()]
    .sort((left, right) => right.publishTime - left.publishTime);
}

app.get('/api/news', async (req, res) => {
  const code = String(req.query.code || '').trim();
  const date = toDateString(req.query.date);
  // days：包括回测日在内的交易日数，默认 5（回放页面）；题材演绎脚本传 2。
  const days = req.query.days === undefined ? 5 : Number(req.query.days);
  if (!/^\d{6}$/.test(code) || !date || !Number.isInteger(days) || days < 1 || days > 5) {
    return res.status(400).json({ status_code: -1, msg: '股票代码、回测日期或天数格式无效' });
  }

  try {
    const { startDate, endDate } = await getNewsDateRange(date, days);
    const [timelineNews, pinnedNews] = await Promise.all([
      fetchTimeline(code, startDate, endDate),
      fetchPinnedTimeline(code, endDate).catch(error => {
        console.error(`临时置顶新闻查询失败 ${code}: ${error.message}`);
        return [];
      }),
    ]);
    const seen = new Set();
    const news = [...pinnedNews, ...timelineNews].filter(item => {
      const key = `${item.publishTime}-${item.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.set('Cache-Control', 'no-store');
    res.json({ status_code: 0, code, startDate, endDate, data: news });
  } catch (error) {
    console.error(`实时新闻查询失败 ${code}: ${error.message}`);
    res.status(502).json({ status_code: -1, msg: `实时新闻获取失败: ${error.message}` });
  }
});

async function fetchThsKlineData(code = "000620", cutoffDate) {
  const url = 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1/single_kline';
  
  // 动态获取市场代码
  const market = getMarketCode(code);

  let endTime = 0;
  if (cutoffDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cutoffDate);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextMonthYear = month === 12 ? year + 1 : year;
      const lastDay = new Date(Date.UTC(nextMonthYear, nextMonth, 0)).getUTCDate();
      endTime = Date.UTC(nextMonthYear, nextMonth - 1, Math.min(day, lastDay));
    }
  }

  const payload = {
    code_list: [{ codes: [code], market: market }],
    trade_class: "intraday",
    time_period: "day_1",
    // trade_date=-1 表示使用当前数据，end_time 使用回测日期后一个月的时间戳。
    trade_date: -1,
    // 预留额外缓冲，避免接口按自身交易日规则返回时前置数据不足。
    begin_time: -(HISTORY_REQUEST_COUNT + 50),
    end_time: endTime,
    adjust_type: "forward",
    gpid: 1
  };

  const headers = {
    'accept': '*/*',
    'accept-language': 'en,zh;q=0.9,zh-CN;q=0.8',
    'content-type': 'application/json',
    'origin': 'https://www.iwencai.com',
    'referer': 'https://www.iwencai.com/',
    'source-id': 'hxkline-AIME_Component_Library_Component',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'x-auth-appname': 'AINVEST',
    'x-auth-progid': '7047',
    'x-auth-type': 'ths',
    'x-auth-version': '1.0',
    'x-fuyao-auth': 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhdXRob3JpemVyX25hbWVzcGFjZSI6ImNvbW1vbi1ocS1hZ2dyIiwibGljZW5zZWVfdHlwZSI6IkZST05UX0FQUCIsImxpY2Vuc2VlX25hbWVzcGFjZSI6Imh4a2xpbmUtQUlNRV9Db21wb25lbnRfTGlicmFyeV9Db21wb25lbnQifQ.MWqYrKk4Y2_oWTbG3XZjNGoHK_GmIi_KeJKc_mNDqTA'
  };

  // 沪市 ST/风险警示股在同花顺使用市场代码 22，普通沪市股票为 17：主代码无数据时再试备用代码
  const markets = [market];
  if (market === '17') markets.push('22');

  try {
    for (const candidate of markets) {
      const response = await axios.post(url, { ...payload, code_list: [{ codes: [code], market: candidate }] }, { headers });
      if (response.data && response.data.status_code === 0) {
        const quoteData = response.data.data.quote_data[0];
        if (quoteData && quoteData.value && quoteData.value.length) return quoteData.value;
      }
    }
    return [];
  } catch (error) {
    console.error('调用同花顺接口失败:', error.message);
    throw error;
  }
}

// 计算移动平均线 (MA)
function calculateMA(data, day) {
  return data.map((_, index) => {
    if (index < day - 1) return null;
    let sum = 0;
    for (let i = 0; i < day; i++) {
      sum += data[index - i].close;
    }
    return parseFloat((sum / day).toFixed(3));
  });
}

// 主板按 10% 涨跌停计算，价格按 A 股交易规则保留两位小数
function roundPrice(price) {
  return Math.round((price + Number.EPSILON) * 100) / 100;
}

function getLimitStatus(item, previousClose) {
  if (!Number.isFinite(previousClose)) return 'normal';

  const limitUp = roundPrice(previousClose * 1.1);
  const limitDown = roundPrice(previousClose * 0.9);
  const close = Number(item.close);
  const high = Number(item.high);
  const open = Number(item.open);
  const priceTolerance = 0.01;
  const closedAtHigh = Math.abs(close - high) < 0.000001;

  // 接口价格可能保留三位小数或经过前复权，实际涨停价可能比两位小数理论值低几厘。
  if (close >= limitUp || (closedAtHigh && close >= limitUp - priceTolerance)) {
    return 'limit-up';
  }
  if (close <= limitDown) return 'limit-down';
  if (high >= limitUp - priceTolerance) {
    return close >= open ? 'touch-limit-up-up' : 'touch-limit-up-down';
  }
  return close >= open ? 'up' : 'down';
}

// 同花顺这批日线数据的时间戳比实际交易日早一天。
// 例如时间戳 1752076800000 是 2025-07-09 00:00 UTC，
// 但对应的 K 线实际是 2025-07-10，因此映射到下一个交易日。
function getTradingDate(timestamp) {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 1);
  if (day === 5) date.setUTCDate(date.getUTCDate() + 2);
  if (day === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().split('T')[0];
}

// 格式化同花顺返回的数据并计算 MA 均线
function processThsValues(rawValues) {
  const formatted = rawValues.map((v, index) => ({
    timestamp: v[0],
    date: getTradingDate(v[0]),
    open: v[1],
    high: v[2],
    low: v[3],
    close: v[4],
    volume: v[5],
    amount: v[6],
    limitStatus: getLimitStatus(
      { open: v[1], high: v[2], close: v[4] },
      index > 0 ? Number(rawValues[index - 1][4]) : NaN
    )
  }));

  const ma5 = calculateMA(formatted, 5);
  const ma10 = calculateMA(formatted, 10);
  const ma20 = calculateMA(formatted, 20);

  return formatted.map((item, idx) => ({
    ...item,
    ma5: ma5[idx],
    ma10: ma10[idx],
    ma20: ma20[idx]
  }));
}

/**
 * API: 获取指定股票的 K 线数据。cutoffDate 仅作为回放起始日期提示，
 * 不再过滤掉该日期之后的最新数据。
 * Query 参数: 
 * - code: 股票代码，如 000620
 * - cutoffDate: 回放起始日期 (YYYY-MM-DD)，如 2026-03-01
 */
app.get('/api/kline', async (req, res) => {
  const code = req.query.code || '000620';
  const rawCutoffDate = String(req.query.cutoffDate || '').trim();
  const cutoffDate = /^\d{8}$/.test(rawCutoffDate)
    ? `${rawCutoffDate.slice(0, 4)}-${rawCutoffDate.slice(4, 6)}-${rawCutoffDate.slice(6, 8)}`
    : rawCutoffDate || undefined;

  try {
    res.set('Cache-Control', 'no-store');
    const rawValues = await fetchThsKlineData(code, cutoffDate);
    const allProcessedData = processThsValues(rawValues);
    let processedData = allProcessedData;

    // 指定回放日期时，只保留该日期前 240 根、当日和之后 20 根 K 线。
    // MA 已经基于完整历史计算，再截取窗口不会影响均线值。
    if (cutoffDate && allProcessedData.length > 0) {
      const targetIndex = allProcessedData.findIndex(item => item.date >= cutoffDate);
      if (targetIndex >= 0) {
        const from = Math.max(0, targetIndex - REPLAY_BEFORE_COUNT);
        const to = Math.min(allProcessedData.length, targetIndex + REPLAY_AFTER_COUNT + 1);
        processedData = allProcessedData.slice(from, to);
      }
    }

    res.json({
      status_code: 0,
      code: code,
      startDate: cutoffDate || null,
      beforeCount: REPLAY_BEFORE_COUNT,
      afterCount: REPLAY_AFTER_COUNT,
      total: processedData.length,
      data: processedData
    });
  } catch (err) {
    res.status(500).json({ status_code: -1, msg: "数据获取失败" });
  }
});

async function computeReviewPnl(code, date, name, worker) {
  const kline = processThsValues(await fetchThsKlineData(code, date));
  const result = await calcReviewPnl({ code, name, date, tradingDates: kline.map(item => item.date), worker });

  // K 线可能经过复权，把逐笔原始价格换算到图表价格
  const chartFactor = (day) => {
    const candle = kline.find(item => item.date === day);
    const raw = result.days.find(item => item.date === day);
    return candle && raw && raw.close ? Number(candle.close) / raw.close : 1;
  };
  const { sell } = result;
  return {
    status_code: 0,
    rulesVersion: RULES_VERSION,
    code,
    date,
    buyDate: result.buyDate,
    buyPrice: result.buyPrice,
    buyChartPrice: Number((result.buyPrice * chartFactor(result.buyDate)).toFixed(3)),
    sellDate: sell.date,
    sellPrice: sell.price,
    sellChartPrice: Number((sell.price * chartFactor(sell.date)).toFixed(3)),
    sellReason: sell.reason,
    pnlPct: result.pnlPct,
    sellTick: { date: sell.date, time: sell.tick.time, price: sell.tick.price, vol: sell.tick.vol, buyorsell: sell.tick.buyorsell },
  };
}

// 本地预计算的盈亏（npm run pnl 写入 daily-review JSON 每条记录的 pnl 字段），命中则不再实时抓取
const PNL_CACHE_TTL_MS = 10 * 60 * 1000;
let pnlCache = new Map();
let pnlCacheLoadedAt = 0;
let pnlCacheLoading = null;

async function loadPnlCache() {
  const items = new Map();
  const add = (data) => {
    for (const item of Array.isArray(data) ? data : []) {
      if (!item || !item.pnl || item.pnl.rulesVersion !== RULES_VERSION) continue;
      const date = String(item.date || '').trim();
      const normalized = /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
      items.set(pnlKey(String(item.code || '').trim(), normalized), item.pnl);
    }
  };
  if (!USE_LOCAL_JSON && sharedR2Client) {
    for (const key of await listJsonKeys('daily-review/')) add(await readJson(key));
  } else if (fs.existsSync(DAILY_REVIEW_DIR)) {
    for (const name of fs.readdirSync(DAILY_REVIEW_DIR)) {
      if (name.toLowerCase().endsWith('.json')) add(JSON.parse(fs.readFileSync(path.join(DAILY_REVIEW_DIR, name), 'utf8')));
    }
  }
  return items;
}

async function getPnlCache() {
  if (Date.now() - pnlCacheLoadedAt < PNL_CACHE_TTL_MS) return pnlCache;
  if (!pnlCacheLoading) {
    pnlCacheLoading = loadPnlCache()
      .then(items => { pnlCache = items; })
      .catch(error => console.error(`读取盈亏缓存失败: ${error.message}`))
      .finally(() => {
        pnlCacheLoadedAt = Date.now();
        pnlCacheLoading = null;
      });
  }
  await pnlCacheLoading;
  return pnlCache;
}

// 盈亏任务队列：串行执行并限速，避免预加载抢占 K 线接口；用户主动请求优先
const pnlJobs = new Map();
const pnlHighQueue = [];
const pnlLowQueue = [];
const PNL_JOB_GAP_MS = 300;
let pnlRunning = false;

function enqueuePnlJob(code, date, name, highPriority) {
  const key = `${code}|${date}`;
  let job = pnlJobs.get(key);
  if (!job) {
    job = { key, code, date, name, state: 'queued' };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.promise.catch(() => {});
    pnlJobs.set(key, job);
    (highPriority ? pnlHighQueue : pnlLowQueue).push(job);
    runPnlQueue();
  } else if (highPriority && job.state === 'queued') {
    const index = pnlLowQueue.indexOf(job);
    if (index >= 0) {
      pnlLowQueue.splice(index, 1);
      pnlHighQueue.push(job);
    }
  }
  return job;
}

async function runPnlQueue() {
  if (pnlRunning) return;
  pnlRunning = true;
  try {
    for (;;) {
      const job = pnlHighQueue.shift() || pnlLowQueue.shift();
      if (!job) break;
      job.state = 'running';
      try {
        job.result = await computeReviewPnl(job.code, job.date, job.name);
        job.state = 'done';
        job.resolve(job.result);
      } catch (err) {
        job.state = 'failed';
        job.error = err.message;
        pnlJobs.delete(job.key); // 失败不缓存，允许重试
        job.reject(err);
      }
      await new Promise(resolve => setTimeout(resolve, PNL_JOB_GAP_MS));
    }
  } finally {
    pnlRunning = false;
  }
}

function parsePnlParams(source) {
  const code = String(source.code || '').trim();
  const date = String(source.date || '').trim();
  const name = String(source.name || '').trim();
  if (!/^\d{6}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { code, date, name };
}

// 预加载：只入队，立即返回
app.post('/api/review-pnl/preload', express.json({ limit: '1mb' }), async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const cache = await getPnlCache();
  let queued = 0;
  for (const item of items) {
    const params = parsePnlParams(item);
    if (!params || cache.has(pnlKey(params.code, params.date))) continue;
    enqueuePnlJob(params.code, params.date, params.name, false);
    queued++;
  }
  res.json({ status_code: 0, queued });
});

// 查询：已算好直接返回，否则插队到优先队列并等待结果
app.get('/api/review-pnl', async (req, res) => {
  const params = parsePnlParams(req.query);
  if (!params) return res.status(400).json({ status_code: -1, msg: '参数错误' });
  res.set('Cache-Control', 'no-store');
  try {
    const cached = (await getPnlCache()).get(pnlKey(params.code, params.date));
    if (cached) return res.json(cached);
    const job = enqueuePnlJob(params.code, params.date, params.name, true);
    res.json(await job.promise);
  } catch (err) {
    res.status(502).json({ status_code: -1, msg: `盈亏计算失败: ${err.message}` });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`服务启动成功: http://localhost:${PORT}`);
  });
}

app.get('/api/test-cases', async (req, res) => {
  try {
    const files = !USE_LOCAL_JSON && sharedR2Client
      ? (await listJsonKeys('test-cases/')).map(key => key.slice('test-cases/'.length))
      : listLocalJson(TEST_CASE_DIR);
    res.json({ status_code: 0, files });
  } catch (error) {
    res.status(500).json({ status_code: -1, msg: `读取测试用例失败: ${error.message}` });
  }
});

app.get('/api/test-cases/:fileName', async (req, res) => {
  try {
    const cases = await parseTestCases(req.params.fileName);
    res.json({ status_code: 0, total: cases.length, data: cases });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

// 题材演绎甘特图：读取 news-theme-table.js 生成的 reports/*.json，
// 页面上的人工编辑写入同名 .manual.json，下次生成表格时与 Excel 人工列合并；
// 新闻核对（Debug）的人工勾选写入同名 .review.json，与自动判断对比：
// 有大模型结果（news-llm.js 写入 reports/news-llm.json）时和大模型比，否则和关键词规则比。
const REPORTS_DIR = path.join(__dirname, 'reports');
const THEME_MANUAL_COLUMNS = ['人工锚定新闻', '人工类别', '人工题材', '备注'];
const THEME_SIDE_FILE = /\.(manual|review|review-diff)\.json$/i;
const NEWS_CACHE_NAME = 'news-cache.json';
// reports/ 里不是题材演绎表的数据文件，不出现在页面的文件下拉框里。
const REPORT_AUX_FILES = new Set([NEWS_CACHE_NAME, 'news-llm.json', 'news-llm-fast.json', 'news-body-cache.json', '首板涨停原因.json', '全市场涨停原因.json']);

function themeReportPaths(name) {
  const base = path.basename(String(name || '')).replace(/\.json$/i, '');
  if (!base || /\.(manual|review|review-diff)$/i.test(base) || REPORT_AUX_FILES.has(`${base}.json`)) {
    throw new Error('题材演绎文件名无效');
  }
  const dataPath = path.join(REPORTS_DIR, `${base}.json`);
  if (!fs.existsSync(dataPath)) throw new Error(`找不到 reports/${base}.json，请先运行 npm run news-theme`);
  return {
    dataPath,
    manualPath: path.join(REPORTS_DIR, `${base}.manual.json`),
    reviewPath: path.join(REPORTS_DIR, `${base}.review.json`),
    diffPath: path.join(REPORTS_DIR, `${base}.review-diff.json`),
  };
}

// reports/ 下的大 JSON 按修改时间缓存，文件没变就不重新读。
const reportJsonCache = new Map();

function readReportJson(name) {
  const filePath = path.join(REPORTS_DIR, name);
  if (!fs.existsSync(filePath)) return {};
  const { mtimeMs } = fs.statSync(filePath);
  const cached = reportJsonCache.get(name);
  if (cached?.mtimeMs === mtimeMs) return cached.data;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  reportJsonCache.set(name, { mtimeMs, data });
  return data;
}

function readThemeNewsCache() {
  return readReportJson(NEWS_CACHE_NAME);
}

function themeNewsId(item) {
  return `${item.time}|${item.title}`;
}

// 自动判断：有大模型结果、且模型看到的新闻列表和现在一致时用大模型，否则用 news-theme-table.js 的关键词规则
// （规则改了不用重新生成表格也能看到最新结果）。两边的结果都放进每条新闻，页面上一起显示。
function classifyThemeNews(row, cacheEntry) {
  const { classifyNews, pickAnchor, cachedNews } = require('./news-theme-table');
  const news = cachedNews(cacheEntry);
  const { anchor } = pickAnchor({ stockName: row['名称'], news });
  const ids = news.map(themeNewsId);
  const llmEntry = readReportJson('news-llm.json')[row.key];
  const llm = llmEntry && llmEntry.newsIds.join('\n') === ids.join('\n') ? llmEntry : null;
  const llmIdOf = id => ids[Number(String(id).slice(1)) - 1] || '';
  const items = news.map((item, index) => {
    const result = classifyNews(item, row['名称']);
    const judged = llm?.result.news[index];
    return {
      id: ids[index],
      title: item.title,
      time: item.time,
      url: item.url || '',
      pinned: Boolean(item.pinned),
      verdict: result.verdict,
      categories: result.categories,
      keywords: result.keywords,
      ruleImportant: result.score > 0,
      llm: judged ? {
        relevant: judged.relevant, polarity: judged.polarity, newThing: judged.newThing,
        categories: judged.categories, reason: judged.reason,
      } : null,
      important: judged ? judged.important : result.score > 0,
    };
  });
  return {
    items,
    basis: llm ? '大模型' : '关键词规则',
    anchorId: llm ? llmIdOf(llm.result.anchorId) : anchor ? themeNewsId(anchor) : '',
    llm: llm ? {
      hasImportantNews: llm.result.hasImportantNews, newThing: llm.result.newThing, theme: llm.result.theme,
      reason: llm.result.reason, limitUpReason: llm.limitUpReason, model: llm.model,
    } : null,
  };
}

// 人工勾选与自动判断的对比：有无重要新闻是否一致、自动锚定是否被人工选中、逐条的交集差集。
// 勾选的新闻不在当前新闻范围里（如新闻天数从 5 天改成 2 天）时忽略，记为 stale；
// 勾选的全部失效、又没选「没有重要新闻」的，需要重新核对（needsRecheck），不计入一致率。
function currentSelection(review, classified) {
  const ids = new Set(classified.items.map(item => item.id));
  const picked = review.noImportant ? [] : review.selected;
  return { selected: new Set(picked.filter(id => ids.has(id))), stale: picked.filter(id => !ids.has(id)).length };
}

function compareThemeReview(review, classified) {
  const { selected, stale } = currentSelection(review, classified);
  const auto = new Set(classified.items.filter(item => item.important).map(item => item.id));
  return {
    noImportant: Boolean(review.noImportant),
    stale,
    needsRecheck: !review.noImportant && stale > 0 && selected.size === 0,
    selected: [...selected],
    updatedAt: review.updatedAt || '',
    autoIds: [...auto],
    anchorId: classified.anchorId,
    userHasNews: selected.size > 0,
    autoHasNews: auto.size > 0,
    agree: (selected.size > 0) === (auto.size > 0),
    anchorHit: classified.anchorId ? selected.has(classified.anchorId) : null,
    both: [...selected].filter(id => auto.has(id)).length,
    userOnly: [...selected].filter(id => !auto.has(id)).length,
    autoOnly: [...auto].filter(id => !selected.has(id)).length,
    basis: classified.basis,
    reasons: review.reasons || {},
  };
}

// 不符的新闻：你选了但自动没选、自动选了但你没选。
function themeMismatches(review, classified) {
  const { selected } = currentSelection(review, classified);
  return classified.items
    .filter(item => selected.has(item.id) !== item.important)
    .map(item => ({ ...item, type: selected.has(item.id) ? `你选了·${classified.basis}没选` : `${classified.basis}选了·你没选` }));
}

function readThemeManual(manualPath) {
  try {
    return JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  } catch {
    return {};
  }
}

app.get('/api/theme-gantt', (req, res) => {
  const files = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR)
      .filter(file => file.toLowerCase().endsWith('.json') && !THEME_SIDE_FILE.test(file) && !REPORT_AUX_FILES.has(file))
      .map(file => file.replace(/\.json$/i, ''))
    : [];
  res.json({ status_code: 0, files });
});

app.get('/api/theme-gantt/:name', (req, res) => {
  try {
    const { dataPath, manualPath, reviewPath } = themeReportPaths(req.params.name);
    const report = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const manual = readThemeManual(manualPath);
    const reviews = readThemeManual(reviewPath);
    const newsCache = readThemeNewsCache();
    const rows = report.rows.map(row => {
      const saved = manual[row.key];
      const merged = saved
        ? { ...row, ...Object.fromEntries(THEME_MANUAL_COLUMNS.map(column => [column, saved[column] ?? ''])) }
        : { ...row };
      const news = newsCache[row.key]?.news || [];
      // 人工锚定新闻是手填文本；能在新闻里找到同名标题时补上发布时间，方便页面显示日期。
      if (merged['人工锚定新闻']) {
        merged['人工锚定新闻时间'] = news.find(item => item.title === merged['人工锚定新闻'].trim())?.time || '';
      }
      if (reviews[row.key]) merged['核对'] = compareThemeReview(reviews[row.key], classifyThemeNews(merged, newsCache[row.key]));
      return merged;
    });
    res.set('Cache-Control', 'no-store');
    res.json({ status_code: 0, ...report, rows });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

app.get('/api/theme-gantt/:name/news', (req, res) => {
  try {
    const { dataPath, reviewPath } = themeReportPaths(req.params.name);
    const key = String(req.query.key || '');
    const row = JSON.parse(fs.readFileSync(dataPath, 'utf8')).rows.find(item => item.key === key);
    if (!row) throw new Error(`找不到记录 ${key}`);
    const classified = classifyThemeNews(row, readThemeNewsCache()[key]);
    const review = readThemeManual(reviewPath)[key];
    // 原文正文（news-body.js 抓取），页面上每条新闻可以展开看。
    const bodies = readReportJson('news-body-cache.json');
    classified.items.forEach(item => { item.body = bodies[item.url]?.text || ''; });
    res.set('Cache-Control', 'no-store');
    res.json({
      status_code: 0,
      key,
      ...classified,
      review: review ? compareThemeReview(review, classified) : null,
    });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

app.put('/api/theme-gantt/:name/review', (req, res) => {
  try {
    const { dataPath, reviewPath } = themeReportPaths(req.params.name);
    const key = String(req.body?.key || '');
    const row = JSON.parse(fs.readFileSync(dataPath, 'utf8')).rows.find(item => item.key === key);
    if (!row) throw new Error(`找不到记录 ${key}`);
    const classified = classifyThemeNews(row, readThemeNewsCache()[key]);
    const validIds = new Set(classified.items.map(item => item.id));
    const noImportant = req.body?.noImportant === true;
    const selected = noImportant ? [] : [...new Set((req.body?.selected || []).map(String))];
    if (selected.some(id => !validIds.has(id))) throw new Error('勾选的新闻不在该股票的新闻列表里');
    if (!noImportant && !selected.length) throw new Error('请勾选重要新闻，或选择「没有重要新闻」');
    const reviews = readThemeManual(reviewPath);
    // 重新选择后保留已写的理由，导出时只取当前仍不符的新闻。
    reviews[key] = { noImportant, selected, reasons: reviews[key]?.reasons || {}, updatedAt: new Date().toISOString() };
    fs.writeFileSync(reviewPath, `${JSON.stringify(reviews, null, 2)}\n`, 'utf8');
    res.json({ status_code: 0, key, review: compareThemeReview(reviews[key], classified) });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

// 不符新闻旁填写的理由：{ key, id, reason }，空理由表示删除。
app.put('/api/theme-gantt/:name/review/reason', (req, res) => {
  try {
    const { dataPath, reviewPath } = themeReportPaths(req.params.name);
    const key = String(req.body?.key || '');
    const id = String(req.body?.id || '');
    const reason = String(req.body?.reason || '').trim();
    const row = JSON.parse(fs.readFileSync(dataPath, 'utf8')).rows.find(item => item.key === key);
    if (!row) throw new Error(`找不到记录 ${key}`);
    const reviews = readThemeManual(reviewPath);
    if (!reviews[key]) throw new Error('请先保存核对结果');
    const classified = classifyThemeNews(row, readThemeNewsCache()[key]);
    if (!classified.items.some(item => item.id === id)) throw new Error('这条新闻不在该股票的新闻列表里');
    const reasons = { ...(reviews[key].reasons || {}) };
    if (reason) reasons[id] = reason;
    else delete reasons[id];
    reviews[key] = { ...reviews[key], reasons, updatedAt: new Date().toISOString() };
    fs.writeFileSync(reviewPath, `${JSON.stringify(reviews, null, 2)}\n`, 'utf8');
    res.json({ status_code: 0, key, review: compareThemeReview(reviews[key], classified) });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

// 提交核对：把所有已核对股票里不符的新闻和理由写成 reports/<name>.review-diff.json，供优化关键词规则。
app.post('/api/theme-gantt/:name/review-diff', (req, res) => {
  try {
    const { dataPath, reviewPath, diffPath } = themeReportPaths(req.params.name);
    const report = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const reviews = readThemeManual(reviewPath);
    const newsCache = readThemeNewsCache();
    const stocks = [];
    const totals = { reviewed: 0, agree: 0, both: 0, userOnly: 0, autoOnly: 0, withReason: 0 };
    for (const row of report.rows) {
      const review = reviews[row.key];
      if (!review) continue;
      const classified = classifyThemeNews(row, newsCache[row.key]);
      const compared = compareThemeReview(review, classified);
      if (compared.needsRecheck) {
        totals.needsRecheck = (totals.needsRecheck || 0) + 1;
        continue;
      }
      const mismatches = themeMismatches(review, classified).map(item => ({
        type: item.type,
        time: item.time,
        title: item.title,
        autoAnchor: item.id === classified.anchorId,
        // 大模型的判断（有时）和关键词规则的判断都写上，方便对照。
        llm: item.llm,
        rule: { important: item.ruleImportant, verdict: item.verdict, categories: item.categories, keywords: item.keywords },
        reason: review.reasons?.[item.id] || '',
      }));
      totals.reviewed++;
      if (compared.agree) totals.agree++;
      totals.both += compared.both;
      totals.userOnly += compared.userOnly;
      totals.autoOnly += compared.autoOnly;
      totals.withReason += mismatches.filter(item => item.reason).length;
      if (!mismatches.length) continue;
      const anchor = classified.items.find(item => item.id === classified.anchorId);
      stocks.push({
        key: row.key,
        名称: row['名称'],
        首板日期: row['首板日期'],
        新闻起始日期: row['新闻起始日期'] || '',
        对比对象: classified.basis,
        有无重要新闻一致: compared.agree,
        人工: compared.userHasNews ? '有重要新闻' : '没有重要新闻',
        自动: compared.autoHasNews ? '有重要新闻' : '没有重要新闻',
        自动锚定: anchor ? `${anchor.time} ${anchor.title}` : '',
        自动锚定被选中: compared.anchorHit,
        自动理由: classified.llm?.reason || '',
        涨停原因: classified.llm?.limitUpReason || '',
        不符新闻: mismatches,
      });
    }
    const diff = { generatedAt: new Date().toISOString(), source: path.basename(dataPath), totals, stocks };
    fs.writeFileSync(diffPath, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
    res.json({ status_code: 0, file: `reports/${path.basename(diffPath)}`, totals, stocks: stocks.length });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

app.put('/api/theme-gantt/:name/manual', (req, res) => {
  try {
    const { dataPath, manualPath } = themeReportPaths(req.params.name);
    const key = String(req.body?.key || '');
    const report = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (!report.rows.some(row => row.key === key)) throw new Error(`找不到记录 ${key}`);
    const values = Object.fromEntries(THEME_MANUAL_COLUMNS.map(column => [
      column, String(req.body?.values?.[column] ?? '').slice(0, 2000),
    ]));
    const manual = readThemeManual(manualPath);
    manual[key] = { ...values, updatedAt: new Date().toISOString() };
    fs.writeFileSync(manualPath, `${JSON.stringify(manual, null, 2)}\n`, 'utf8');
    res.json({ status_code: 0, key, values });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

// 新闻类别评审：按类别浏览大模型判为重要的新闻和判断依据，人工评审写入 reports/news-category.review.json，
// 键是「代码|首板日|新闻时间|标题」，值 { verdict: ok/wrongCategory/notImportant, categories, note }。
const NEWS_CATEGORIES = ['政策规范', '行业利好', '新叙事', '海外/明星公司', '企业荣誉/重要会议', '资本运作转型'];
const NEWS_CATEGORY_VERDICTS = new Set(['ok', 'wrongCategory', 'notImportant']);
const NEWS_CATEGORY_REVIEW_PATH = path.join(REPORTS_DIR, 'news-category.review.json');

// 稳定的乱序：同一条新闻每次排在同一位置，又不会一只股票的新闻扎堆。
function shuffleRank(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function newsCategoryItems(reportName) {
  const { dataPath } = themeReportPaths(reportName);
  const report = readReportJson(path.basename(dataPath));
  const llm = readReportJson('news-llm.json');
  const newsCache = readThemeNewsCache();
  const items = [];
  for (const row of report.rows) {
    const entry = llm[row.key];
    if (!entry?.result?.news) continue;
    const urls = new Map((newsCache[row.key]?.news || []).map(item => [themeNewsId(item), item.url]));
    for (const news of entry.result.news) {
      if (!news.important || !news.categories?.length) continue;
      const newsId = entry.newsIds[Number(String(news.id).slice(1)) - 1];
      if (!newsId) continue;
      const [time, ...titleParts] = newsId.split('|');
      const id = `${row.key}|${newsId}`;
      items.push({
        id, key: row.key, name: row['名称'], date: row['首板日期'], limitUpReason: entry.limitUpReason || '',
        time, title: titleParts.join('|'), url: urls.get(newsId) || '',
        categories: news.categories, newThing: news.newThing || '', reason: news.reason || '', rank: shuffleRank(id),
      });
    }
  }
  return items.sort((left, right) => left.rank - right.rank);
}

app.get('/api/news-category', (req, res) => {
  try {
    const category = String(req.query.category || '');
    const filter = String(req.query.filter || 'all');
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 50));
    const items = newsCategoryItems(req.query.report || '一进二题材演绎');
    const reviews = readThemeManual(NEWS_CATEGORY_REVIEW_PATH);
    // 每个类别的条数、已评审、有异议（类别不对或不算重要）
    const counts = Object.fromEntries(NEWS_CATEGORIES.map(name => [name, { total: 0, reviewed: 0, disagree: 0 }]));
    for (const item of items) {
      for (const name of item.categories) {
        if (!counts[name]) continue;
        counts[name].total++;
        const review = reviews[item.id];
        if (review) {
          counts[name].reviewed++;
          if (review.verdict !== 'ok') counts[name].disagree++;
        }
      }
    }
    const matched = items.filter(item => {
      if (category && !item.categories.includes(category)) return false;
      const review = reviews[item.id];
      if (filter === 'unreviewed') return !review;
      if (filter === 'reviewed') return Boolean(review);
      if (filter === 'disagree') return review && review.verdict !== 'ok';
      if (filter === 'only') return item.categories.length === 1;
      return true;
    });
    const pageItems = matched.slice((page - 1) * pageSize, page * pageSize)
      .map(({ rank, ...item }) => ({ ...item, review: reviews[item.id] || null }));
    res.set('Cache-Control', 'no-store');
    res.json({ status_code: 0, categories: NEWS_CATEGORIES, counts, total: matched.length, page, pageSize, items: pageItems });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

app.get('/api/news-category/body', (req, res) => {
  const text = readReportJson('news-body-cache.json')[String(req.query.url || '')]?.text || '';
  res.json({ status_code: 0, text });
});

// { id, verdict, categories, note }；verdict 为空表示撤销评审。
app.put('/api/news-category/review', (req, res) => {
  try {
    const id = String(req.body?.id || '');
    if (!/^\d{6}\|\d{4}-\d{2}-\d{2}\|/.test(id)) throw new Error('新闻编号无效');
    const verdict = String(req.body?.verdict || '');
    const reviews = readThemeManual(NEWS_CATEGORY_REVIEW_PATH);
    if (!verdict) {
      delete reviews[id];
    } else {
      if (!NEWS_CATEGORY_VERDICTS.has(verdict)) throw new Error('评审结论无效');
      const categories = verdict === 'wrongCategory'
        ? [...new Set((req.body?.categories || []).map(String))].filter(name => NEWS_CATEGORIES.includes(name))
        : [];
      if (verdict === 'wrongCategory' && !categories.length) throw new Error('请选出正确的类别');
      reviews[id] = { verdict, categories, note: String(req.body?.note || '').slice(0, 500), updatedAt: new Date().toISOString() };
    }
    fs.writeFileSync(NEWS_CATEGORY_REVIEW_PATH, `${JSON.stringify(reviews, null, 2)}\n`, 'utf8');
    res.json({ status_code: 0, id, review: reviews[id] || null });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

module.exports = { computeReviewPnl };