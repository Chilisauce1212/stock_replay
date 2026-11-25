const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ quiet: true });
const r2 = require('./r2-storage');

const KLINE_URL = 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1/single_kline';
const testCaseDir = path.join(__dirname, 'test-cases');
const sourceFiles = [
  '一进二回测_20240104_20241231.json',
  '一进二回测_20250104_20251231.json',
  '一进二回测_20260106_20261231.json',
];
const requestConcurrency = 5;
// --recent-days N（每日更新用，2026-11-25 加）：只重查首板日在最近 N 天内的样本，只更新 daily-review/四连板及以上.json；
// 更早的记录原样保留（K 线只取首板后一个月，一个多月前的连板数不会再变），test-cases/ 下其他几个文件不动
const recentIndex = process.argv.indexOf('--recent-days');
const recentDays = recentIndex >= 0 ? Number(process.argv[recentIndex + 1]) : 0;
if (recentIndex >= 0 && !(recentDays > 0)) throw new Error('--recent-days 后面要跟天数，如 --recent-days 40');

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

function roundPrice(price) {
  return Math.round((price + Number.EPSILON) * 100) / 100;
}

function isLimitUp(close, high, previousClose) {
  if (!Number.isFinite(previousClose)) return false;
  const limitUp = roundPrice(previousClose * 1.1);
  return close >= limitUp || (Math.abs(close - high) < 0.000001 && close >= limitUp - 0.01);
}

async function getCaseData(item) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.date);
  if (!match) throw new Error(`日期格式无效: ${item.date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextMonthYear = month === 12 ? year + 1 : year;
  const endTime = Date.UTC(nextMonthYear, nextMonth - 1, day);
  const response = await axios.post(KLINE_URL, {
    code_list: [{ codes: [item.code], market: getMarketCode(item.code) }],
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
  const data = values.map((value, index) => ({
    date: getTradingDate(value[0]),
    high: Number(value[2]),
    close: Number(value[4]),
    previousClose: index > 0 ? Number(values[index - 1][4]) : NaN,
  }));
  const targetIndex = data.findIndex(row => row.date === item.date);
  if (targetIndex < 0) return null;

  const target = data[targetIndex];
  let boardCount = 0;
  for (let index = targetIndex; index < data.length; index += 1) {
    if (!isLimitUp(data[index].close, data[index].high, data[index].previousClose)) break;
    boardCount += 1;
  }
  return { price: Number(target.close), boardCount };
}

async function main() {
  const rawCases = sourceFiles.flatMap(fileName => JSON.parse(
    fs.readFileSync(path.join(testCaseDir, fileName), 'utf8')
  ));
  const allCases = Array.from(new Map(rawCases.map(item => [
    `${item.date}-${item.marketCode || item.code}`,
    item,
  ])).values());
  console.log(`指定源文件 ${sourceFiles.length} 个，原始记录 ${rawCases.length} 条，去重后 ${allCases.length} 条`);
  const cutoff = recentDays ? new Date(Date.now() + 8 * 3600e3 - recentDays * 86400e3).toISOString().slice(0, 10) : '';
  const queryCases = recentDays ? allCases.filter(item => item.date >= cutoff) : allCases;
  console.log(recentDays ? `只查首板日 ${cutoff} 起的 ${queryCases.length} 条` : `本地源数据共 ${allCases.length} 条，开始全量查询`);

  const prices = new Array(queryCases.length);
  const boardCounts = new Array(queryCases.length);
  let nextIndex = 0;
  let completed = 0;
  let missing = 0;
  async function worker() {
    while (nextIndex < queryCases.length) {
      const index = nextIndex++;
      let caseData;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          caseData = await getCaseData(queryCases[index]);
          break;
        } catch (error) {
          if (attempt === 3) console.error(`${queryCases[index].code} ${queryCases[index].date}: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, attempt * 300));
        }
      }
      if (!caseData || !Number.isFinite(caseData.price)) missing += 1;
      prices[index] = caseData?.price;
      boardCounts[index] = caseData?.boardCount;
      completed += 1;
      if (completed % 50 === 0 || completed === queryCases.length) {
        const percentage = ((completed / queryCases.length) * 100).toFixed(1);
        console.log(`处理进度: ${completed}/${queryCases.length} (${percentage}%)`);
      }
    }
  }
  await Promise.all(Array.from({ length: requestConcurrency }, worker));

  // 本地 daily-review 可能比 R2 旧（缺记录）：旧值以 R2 为底、本地覆盖，否则本地缺的、查不到行情的记录会被误删（2026-11-11 少了 30 条）
  const remoteFour = r2.r2Client
    ? await r2.readJson('daily-review/四连板及以上.json').catch(error => (r2.isMissing(error) ? [] : Promise.reject(error)))
    : [];
  const allOutputs = [
    ['大于30元.json', queryCases.filter((_, index) => prices[index] > 30)],
    ['小于3元.json', queryCases.filter((_, index) => prices[index] < 3)],
    ['三连板及以上.json', queryCases.filter((_, index) => boardCounts[index] >= 3)],
    ['四连板及以上.json', queryCases.filter((_, index) => boardCounts[index] >= 4)],
    ['五连板及以上.json', queryCases.filter((_, index) => boardCounts[index] >= 5)],
  ];
  const outputs = recentDays ? allOutputs.filter(([fileName]) => fileName === '四连板及以上.json') : allOutputs;
  let fourTotal = 0;
  outputs.forEach(([fileName, cases]) => {
    // 四连板及以上放在每日复盘里：保留已算好的 pnl、judge、freeFloatCap
    const inReview = fileName === '四连板及以上.json';
    const file = path.join(inReview ? path.join(__dirname, 'daily-review') : testCaseDir, fileName);
    const old = new Map(inReview ? [...(Array.isArray(remoteFour) ? remoteFour : []), ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [])].map(item => [`${item.code}|${item.date}`, item]) : []);
    const merged = cases.map(item => ({ ...old.get(`${item.code}|${item.date}`), ...item }));
    // 行情没查到的记录（接口偶尔失败，一次全量会有上百条）不能当成「不再是四连板」删掉：原来在文件里的照样保留
    // （2026-11-07 一次全量查询失败 139 条，误删了 28 只真四连板，如科森科技 10 板、粤桂股份 11 板）
    if (inReview) {
      const present = new Set(merged.map(item => `${item.code}|${item.date}`));
      queryCases.forEach((item, index) => {
        const key = `${item.code}|${item.date}`;
        if (Number.isFinite(prices[index]) || present.has(key) || !old.has(key)) return;
        merged.push(old.get(key));
        present.add(key);
      });
      // 增量模式：没重查的记录（首板日早于 cutoff）原样保留
      if (recentDays) {
        const queried = new Set(queryCases.map(item => `${item.code}|${item.date}`));
        for (const [key, item] of old) {
          if (queried.has(key) || present.has(key)) continue;
          merged.push(item);
          present.add(key);
        }
      }
      fourTotal = merged.length;
      merged.sort((left, right) => left.date.localeCompare(right.date) || left.code.localeCompare(right.code));
    }
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  });
  if (recentDays) {
    console.log(`增量重算完成：最近 ${recentDays} 天里四连板及以上 ${allOutputs[3][1].length} 条，daily-review/四连板及以上.json 共 ${fourTotal} 条，未匹配 ${missing} 条`);
    if (missing) console.error(`!!! 四连板：${missing} 条行情没查到，原来在文件里的已保留，明天会再查`);
  } else {
    console.log(`全量重算完成：大于30元 ${allOutputs[0][1].length} 条，小于3元 ${allOutputs[1][1].length} 条，三连板及以上 ${allOutputs[2][1].length} 条，四连板及以上 ${allOutputs[3][1].length} 条，五连板及以上 ${allOutputs[4][1].length} 条，未匹配 ${missing} 条`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
