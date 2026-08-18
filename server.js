const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const app = express();
const PORT = process.env.PORT || 3000;
const TEST_CASE_DIR = path.join(__dirname, 'test-cases');
const FAVORITES_FILE = path.join(__dirname, 'favorites.json');
const REPLAY_BEFORE_COUNT = 240;
const REPLAY_AFTER_COUNT = 20;
const HISTORY_REQUEST_COUNT = 600;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readFavorites() {
  try {
    return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
  } catch {
    return { groups: {} };
  }
}

function safeTestCasePath(fileName) {
  const safeName = path.basename(fileName || '');
  if (!/\.(xlsx|json)$/i.test(safeName)) return null;
  const filePath = path.join(TEST_CASE_DIR, safeName);
  return filePath.startsWith(TEST_CASE_DIR) ? filePath : null;
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
  const xlsxFiles = fs.readdirSync(TEST_CASE_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.xlsx'))
    .map(entry => entry.name);

  xlsxFiles.forEach(xlsxFile => {
    const jsonFile = `${path.basename(xlsxFile, path.extname(xlsxFile))}.json`;
    const xlsxPath = path.join(TEST_CASE_DIR, xlsxFile);
    const jsonPath = path.join(TEST_CASE_DIR, jsonFile);
    if (!fs.existsSync(jsonPath) || fs.statSync(xlsxPath).mtimeMs > fs.statSync(jsonPath).mtimeMs) {
      fs.writeFileSync(jsonPath, JSON.stringify(parseXlsxTestCases(xlsxFile), null, 2), 'utf8');
    }
  });
}

function parseTestCases(fileName) {
  const filePath = safeTestCasePath(fileName);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('测试用例文件不存在');
  if (fileName.toLowerCase().endsWith('.xlsx')) return parseXlsxTestCases(fileName);

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(data)) throw new Error('JSON 测试用例格式错误');
  return data;
}

app.get('/api/test-cases', (req, res) => {
  syncJsonTestCases();
  const files = fs.readdirSync(TEST_CASE_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map(entry => entry.name);
  res.json({ status_code: 0, files });
});

app.get('/api/test-cases/:fileName', (req, res) => {
  try {
    const cases = parseTestCases(req.params.fileName);
    res.json({ status_code: 0, total: cases.length, data: cases });
  } catch (error) {
    res.status(400).json({ status_code: -1, msg: error.message });
  }
});

app.get('/api/favorites', (req, res) => {
  res.json({ status_code: 0, data: readFavorites() });
});

app.post('/api/favorites', (req, res) => {
  const group = String(req.body.group || '').trim();
  const item = req.body.item;
  if (!group || !item || !item.code || !item.date) {
    return res.status(400).json({ status_code: -1, msg: '收藏分组和股票信息不能为空' });
  }
  const favorites = readFavorites();
  favorites.groups[group] = favorites.groups[group] || [];
  if (!favorites.groups[group].some(saved => saved.code === item.code && saved.date === item.date)) {
    favorites.groups[group].push({
      code: item.code,
      marketCode: item.marketCode,
      stockName: item.stockName,
      date: item.date,
      savedAt: new Date().toISOString(),
    });
  }
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favorites, null, 2), 'utf8');
  res.json({ status_code: 0, data: favorites });
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

async function fetchThsKlineData(code = "000620") {
  const url = 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1/single_kline';
  
  // 动态获取市场代码
  const market = getMarketCode(code);

  const payload = {
    code_list: [{ codes: [code], market: market }],
    trade_class: "intraday",
    time_period: "day_1",
    trade_date: -1,
    // 请求足够长的历史，才能覆盖较早的回放日期及其前 240 根 K 线
    begin_time: -HISTORY_REQUEST_COUNT,
    end_time: 0,
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

  try {
    const response = await axios.post(url, payload, { headers });
    if (response.data && response.data.status_code === 0) {
      const quoteData = response.data.data.quote_data[0];
      return quoteData ? quoteData.value : [];
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
  const cutoffDate = req.query.cutoffDate; // 例如 "2025-03-12"

  try {
    const rawValues = await fetchThsKlineData(code);
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

app.listen(PORT, () => {
  console.log(`服务启动成功: http://localhost:${PORT}`);
});