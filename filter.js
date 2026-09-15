require('dotenv').config();

const axios = require('axios');
const { readJson, writeJson } = require('./r2-storage');

const KLINE_URL = 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1/single_kline';
const REQUEST_CONCURRENCY = 5;
const PRICE_TOLERANCE = 0.01;

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
    high: Number(value[2]),
    close: Number(value[4]),
  }));
}

function roundPrice(price) {
  return Math.round((price + Number.EPSILON) * 100) / 100;
}

async function getMatch(item) {
  const rows = await getHistory(item.code, item.date);
  const targetIndex = rows.findIndex(row => row.date === item.date);
  if (targetIndex < 1 || targetIndex + 1 >= rows.length) return false;

  const previousClose = Number(rows[targetIndex - 1].close);
  const targetHigh = Number(rows[targetIndex].high);
  const nextHigh = Number(rows[targetIndex + 1].high);
  if (![previousClose, targetHigh, nextHigh].every(Number.isFinite)) return false;

  const limitUp = roundPrice(previousClose * 1.1);
  return targetHigh >= limitUp - PRICE_TOLERANCE && nextHigh < limitUp;
}

async function main() {
  const inputKeys = process.argv.slice(2);
  if (!inputKeys.length) {
    throw new Error('用法: npm.cmd run filter -- 输入R2 JSON路径 [输入R2 JSON路径 ...]');
  }

  const inputCases = await Promise.all(inputKeys.map(async inputKey => {
    const cases = await readJson(inputKey);
    if (!Array.isArray(cases)) throw new Error(`输入文件根节点必须是数组: ${inputKey}`);
    return cases;
  }));
  const cases = [];
  const seen = new Set();
  inputCases.flat().forEach(item => {
    const key = `${item.code || ''}|${item.date || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      cases.push(item);
    }
  });
  const outputKey = 'test-cases/闷杀.json';

  const matched = new Array(cases.length);
  let nextIndex = 0;
  let completed = 0;
  let errors = 0;

  async function worker() {
    while (nextIndex < cases.length) {
      const index = nextIndex;
      nextIndex += 1;
      let isMatch = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          isMatch = await getMatch(cases[index]);
          break;
        } catch (error) {
          if (attempt === 3) {
            errors += 1;
            console.error(`查询失败 ${cases[index].code} ${cases[index].date}: ${error.message}`);
          } else {
            await new Promise(resolve => setTimeout(resolve, attempt * 300));
          }
        }
      }
      if (isMatch) matched[index] = cases[index];
      completed += 1;
      if (completed % 50 === 0 || completed === cases.length) {
        console.log(`处理进度: ${completed}/${cases.length}，行情接口查询失败: ${errors} 条`);
      }
    }
  }

  await Promise.all(Array.from({ length: REQUEST_CONCURRENCY }, worker));
  const filtered = matched.filter(Boolean);
  await writeJson(outputKey, filtered);
  const successfulQueries = cases.length - errors;
  console.log(`筛选完成: ${filtered.length}/${cases.length} 条已写入 ${outputKey}`);
  console.log(`查询统计: 总记录 ${cases.length} 条，行情接口查询失败 ${errors} 条，成功查询 ${successfulQueries} 条，成功查询但不符合条件 ${successfulQueries - filtered.length} 条`);
}

main().catch(error => {
  console.error(`闷杀筛选失败: ${error.message}`);
  process.exitCode = 1;
});
