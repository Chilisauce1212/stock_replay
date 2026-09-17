const fs = require('fs');
const path = require('path');
const axios = require('axios');

const KLINE_URL = 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1/single_kline';
const testCaseDir = path.join(__dirname, 'test-cases');
const sourceFiles = [
  '一进二回测_20240104_20241231.json',
  '一进二回测_20250104_20251231.json',
  '一进二回测_20260106_20261231.json',
];
const requestConcurrency = 5;

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
  console.log(`本地源数据共 ${allCases.length} 条，开始全量查询`);

  const prices = new Array(allCases.length);
  const boardCounts = new Array(allCases.length);
  let nextIndex = 0;
  let completed = 0;
  let missing = 0;
  async function worker() {
    while (nextIndex < allCases.length) {
      const index = nextIndex++;
      let caseData;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          caseData = await getCaseData(allCases[index]);
          break;
        } catch (error) {
          if (attempt === 3) console.error(`${allCases[index].code} ${allCases[index].date}: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, attempt * 300));
        }
      }
      if (!caseData || !Number.isFinite(caseData.price)) missing += 1;
      prices[index] = caseData?.price;
      boardCounts[index] = caseData?.boardCount;
      completed += 1;
      if (completed % 50 === 0 || completed === allCases.length) {
        const percentage = ((completed / allCases.length) * 100).toFixed(1);
        console.log(`处理进度: ${completed}/${allCases.length} (${percentage}%)`);
      }
    }
  }
  await Promise.all(Array.from({ length: requestConcurrency }, worker));

  const outputs = [
    ['大于30元.json', allCases.filter((_, index) => prices[index] > 30)],
    ['小于3元.json', allCases.filter((_, index) => prices[index] < 3)],
    ['三连板及以上.json', allCases.filter((_, index) => boardCounts[index] >= 3)],
    ['五连板及以上.json', allCases.filter((_, index) => boardCounts[index] >= 5)],
  ];
  outputs.forEach(([fileName, cases]) => fs.writeFileSync(
    path.join(testCaseDir, fileName),
    `${JSON.stringify(cases, null, 2)}\n`,
    'utf8'
  ));
  console.log(`全量重算完成：大于30元 ${outputs[0][1].length} 条，小于3元 ${outputs[1][1].length} 条，三连板及以上 ${outputs[2][1].length} 条，五连板及以上 ${outputs[3][1].length} 条，未匹配 ${missing} 条`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
