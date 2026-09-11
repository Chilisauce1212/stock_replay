require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { chromium } = require('playwright');
const { r2Client, readJson, writeJson } = require('./r2-storage');

const DAILY_REVIEW_DIR = path.join(__dirname, 'daily-review');
const TEST_CASE_DIR = path.join(__dirname, 'test-cases');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function parseDate(dateString) {
  const value = String(dateString).trim();
  if (!/^\d{8}$/.test(value)) throw new Error(`日期必须是 YYYYMMDD: ${dateString}`);
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
  if (Number.isNaN(date.getTime())) throw new Error(`无效日期: ${dateString}`);
  return date;
}

function formatDate(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateToChinese(dateString) {
  const date = parseDate(dateString);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

function today() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function beijingNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function beijingDateString() {
  const now = beijingNow();
  return `${now.year}${now.month}${now.day}`;
}

function isTodayGenerationWindow() {
  const hour = Number(beijingNow().hour);
  return hour >= 15 && hour < 24;
}

async function ensureChromeDebugging() {
  const debugUrl = 'http://127.0.0.1:9222/json/version';
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const userDataDir = 'C:\\chrome_temp';
  try {
    const response = await axios.get(debugUrl, { timeout: 1000 });
    if (response.status >= 200 && response.status < 300) {
      console.log('>>> 检测到 Chrome 调试端口已启动，直接复用。');
      return;
    }
  } catch { /* Chrome 尚未启动 */ }
  if (!fs.existsSync(chromePath)) throw new Error(`找不到 Chrome: ${chromePath}`);
  console.log('>>> 未检测到 Chrome 调试端口，正在自动启动 Chrome...');
  const chrome = spawn(chromePath, ['--remote-debugging-port=9222', `--user-data-dir=${userDataDir}`], { detached: true, stdio: 'ignore' });
  chrome.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await axios.get(debugUrl, { timeout: 1000 });
      if (response.status >= 200 && response.status < 300) {
        console.log('>>> Chrome 调试端口启动成功。');
        return;
      }
    } catch { /* 继续等待 */ }
    await sleep(500);
  }
  throw new Error('Chrome 启动超时，未能打开 9222 调试端口');
}

async function getMarketCalendar(dateString) {
  const url = 'https://data.10jqka.com.cn/dataapi/limit_up/trade_day';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await axios.get(url, {
        params: { date: dateString, stock: 'stock', next: 1, prev: 5 },
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000,
      });
      const data = response.data;
      const marketData = data?.status_code === 0 ? data.data : null;
      if (marketData?.trade_day && marketData.prev_dates?.length >= 5 && marketData.next_dates?.length) {
        const previous = marketData.prev_dates;
        return {
          isTrade: true, tPlus1Chs: dateToChinese(marketData.next_dates[0]), tChs: dateToChinese(dateString),
          tMinus1Chs: dateToChinese(previous[4]), tMinus2Chs: dateToChinese(previous[3]),
          tPlus1Raw: String(marketData.next_dates[0]), tRaw: dateString,
          tMinus1Raw: String(previous[4]), tMinus2Raw: String(previous[3]),
        };
      }
      return { isTrade: false };
    } catch (error) {
      if (attempt < 3) {
        console.log(`交易日历获取失败，第 ${attempt} 次重试: ${error.message}`);
        await sleep(attempt * 1000);
      } else console.log(`交易日历获取失败，已重试 3 次: ${error.message}`);
    }
  }
  return { isTrade: false };
}

function normalizeData(rows, calendar) {
  const replacements = [[calendar.tRaw, 'T'], [calendar.tMinus1Raw, 'T-1'], [calendar.tMinus2Raw, 'T-2'], [calendar.tPlus1Raw, 'T+1']];
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    let newKey = String(key);
    replacements.forEach(([oldValue, newValue]) => { newKey = newKey.split(oldValue).join(newValue); });
    return [newKey, value];
  })));
}

function firstValue(row, names) {
  for (const name of names) {
    const value = row[name];
    if (value != null && !['', 'nan', 'None'].includes(String(value).trim())) return String(value).trim();
  }
  return '';
}

function convertToRecords(rows, dateString, startIndex) {
  const records = [];
  rows.forEach(row => {
    const codeValue = firstValue(row, ['股票代码', '代码', '证券代码']);
    const stockName = firstValue(row, ['股票简称', '股票名称', '证券简称', '名称']);
    if (!codeValue || !stockName) return;
    const code = codeValue.toUpperCase();
    const [plainCodePart, suffixPart] = code.includes('.') ? code.split('.', 2) : [code.padStart(6, '0'), null];
    const plainCode = plainCodePart;
    const suffix = suffixPart || (/^[569]/.test(plainCode) ? 'SH' : 'SZ');
    const marketCode = `${plainCode}.${suffix}`;
    records.push({ id: `${startIndex + records.length}-${dateString}-${marketCode}`, date: `${dateString.slice(0, 4)}-${dateString.slice(4, 6)}-${dateString.slice(6, 8)}`, code: plainCode, marketCode, stockName });
  });
  return records;
}

async function loadJson(filename) {
  const isDailyReview = path.basename(filename) === '今日首板.json';
  const prefix = isDailyReview ? 'daily-review' : 'test-cases';
  let data;
  if (r2Client) {
    try {
      data = await readJson(`${prefix}/${path.basename(filename)}`);
    } catch (error) {
      if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
      return [];
    }
  } else {
    if (!fs.existsSync(filename)) return [];
    data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  }
  if (!Array.isArray(data)) throw new Error('JSON 根节点必须是数组');
  return data;
}

async function saveJson(records, filename) {
  if (r2Client) {
    const prefix = path.basename(filename) === '今日首板.json' ? 'daily-review' : 'test-cases';
    await writeJson(`${prefix}/${path.basename(filename)}`, records);
    return;
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filename);
}

async function run(startArgument, endArgument) {
  const startText = String(startArgument).trim();
  const endText = String(endArgument).trim();
  let startDate = parseDate(startText);
  let endDate = parseDate(endText);
  const currentDate = today();
  if (endDate > currentDate) {
    console.log(`指定结束日期 ${endText} 晚于今天，实际查询截止日期调整为 ${formatDate(currentDate)}。`);
    endDate = currentDate;
  }
  const filename = path.join(TEST_CASE_DIR, `一进二回测_${startText}_${endText}.json`);
  const storageTarget = r2Client
    ? `R2 对象 test-cases/${path.basename(filename)}`
    : `本地文件 ${filename}`;
  console.log(`>>> 数据存储位置: ${storageTarget}`);
  let records = await loadJson(filename);
  if (records.length) {
    const dates = records.filter(item => item.date).map(item => new Date(`${item.date}T00:00:00Z`));
    const lastDate = new Date(Math.max(...dates));
    startDate = new Date(Math.max(startDate.getTime(), addDays(lastDate, 1).getTime()));
    console.log(`检测到已有文件，最后日期为 ${lastDate.toISOString().slice(0, 10)}，将从 ${formatDate(startDate)} 继续。`);
  } else if (r2Client) {
    console.log(`R2 中未检测到对象 test-cases/${path.basename(filename)}，将创建该对象。`);
  } else {
    console.log(`本地未检测到同名 JSON，将创建文件: ${filename}`);
  }
  if (startDate > endDate) return console.log('已有数据已经覆盖指定日期范围，无需追加。');

  console.log('\n>>> 任务开始！输出格式为 JSON');
  await ensureChromeDebugging();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    for (let current = new Date(startDate); current <= endDate; current = addDays(current, 1)) {
      const dateString = formatDate(current);
      const calendar = await getMarketCalendar(dateString);
      if (!calendar.isTrade) { console.log(`跳过: ${dateString} (非交易日)`); continue; }
      const year = `${dateString.slice(0, 4)}年`;
      const question = `${year}${calendar.tMinus1Chs}收盘涨停,${year}${calendar.tMinus2Chs}收盘未涨停,${year}${calendar.tChs}10点30前达到过涨停价,${year}${calendar.tChs}涨幅>9%,${year}${calendar.tChs}最低价<${year}${calendar.tChs}涨停价,主板,非st`;
      const targetUrl = `https://www.iwencai.com/unifiedwap/result?w=${encodeURIComponent(question)}`;
      process.stdout.write(`正在查询: ${dateString} ... `);
      const batch = [];
      const responseTasks = [];
      const handleResponse = response => {
        if (!response.url().includes('get-robot-data') || response.status() !== 200) return;
        responseTasks.push((async () => {
          try {
            const body = await response.json();
            const data = body?.data?.answer?.[0]?.txt?.[0]?.content?.components?.[0]?.data;
            if (data?.datas) batch.push(...data.datas);
          } catch { /* 忽略非目标响应 */ }
        })());
      };
      page.on('response', handleResponse);
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try { await page.waitForSelector('.iwc-table-body', { timeout: 15000 }); await sleep(3000); } catch { process.stdout.write(' [页面加载完成，但未检测到表格] '); }
        await Promise.all(responseTasks);
      } catch (error) { process.stdout.write(` [错误: ${error.message}] `); }
      page.off('response', handleResponse);
      const newRecords = convertToRecords(normalizeData(batch, calendar), calendar.tMinus1Raw, records.length)
        .filter(item => !records.some(existing => existing.date === item.date && existing.marketCode === item.marketCode));
      records.push(...newRecords);
      await saveJson(records, filename);
      console.log(`成功获取 ${newRecords.length} 条，已保存 JSON`);
      await sleep(3000 + Math.floor(Math.random() * 3001));
    }
  } finally { await page.close(); }
  console.log(`\n>>> 全部完成！请查看文件: ${filename}`);
}

async function runTodayFirstBoard() {
  if (!isTodayGenerationWindow()) {
    console.log('北京时间 15:00 前不生成今日首板.json。');
    return;
  }

  const dateString = beijingDateString();
  const filename = path.join(DAILY_REVIEW_DIR, '今日首板.json');
  const storageTarget = r2Client
    ? 'R2 对象 daily-review/今日首板.json'
    : `本地文件 ${filename}`;
  console.log(`>>> 每日复盘将强制覆盖: ${storageTarget}`);

  const calendar = await getMarketCalendar(dateString);
  if (!calendar.isTrade) {
    console.log(`${dateString} 不是交易日，不生成今日首板.json。`);
    return;
  }

  const year = `${dateString.slice(0, 4)}年`;
  const question = `${year}${calendar.tChs}收盘涨停,${year}${calendar.tMinus1Chs}收盘未涨停,${year}${calendar.tChs}涨幅>9%,主板,非st`;
  const targetUrl = `https://www.iwencai.com/unifiedwap/result?w=${encodeURIComponent(question)}`;
  console.log(`>>> 正在生成今日首板: ${question}`);

  // 使用本机原生 Chrome，并通过调试端口连接，不启动 Playwright 自带 Chromium。
  await ensureChromeDebugging();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const batch = [];
  const responseTasks = [];
  const handleResponse = response => {
    if (!response.url().includes('get-robot-data') || response.status() !== 200) return;
    responseTasks.push((async () => {
      try {
        const body = await response.json();
        const data = body?.data?.answer?.[0]?.txt?.[0]?.content?.components?.[0]?.data;
        if (data?.datas) batch.push(...data.datas);
      } catch { /* 忽略非目标响应 */ }
    })());
  };

  page.on('response', handleResponse);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await page.waitForSelector('.iwc-table-body', { timeout: 15000 }); } catch { /* 继续等待接口响应 */ }
    await sleep(3000);
    await Promise.all(responseTasks);
  } finally {
    page.off('response', handleResponse);
    await page.close();
  }

  const records = convertToRecords(normalizeData(batch, calendar), dateString, 0);
  await saveJson(records, filename);
  console.log(`>>> 今日首板生成完成：${records.length} 条，已覆盖 ${storageTarget}`);
}

const [, , start, end] = process.argv;
if (process.argv.includes('--today')) {
  runTodayFirstBoard().catch(error => {
    console.error(`今日首板生成失败: ${error.message}`);
    process.exitCode = 1;
  });
} else if (!start || !end) {
  console.error('用法: node turnover_json.js YYYYMMDD YYYYMMDD');
  console.error('今日首板: node turnover_json.js --today');
  process.exitCode = 1;
} else run(start, end).catch(error => { console.error(`输入或执行失败: ${error.message}`); process.exitCode = 1; });
