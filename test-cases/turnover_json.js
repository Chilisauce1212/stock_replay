const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { chromium } = require('playwright');

const TEST_CASE_DIR = __dirname;
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

async function ensureChromeDebugging() {
  const debugUrl = 'http://127.0.0.1:9222/json/version';
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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

function loadJson(filename) {
  if (!fs.existsSync(filename)) return [];
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(data)) throw new Error('JSON 根节点必须是数组');
  return data;
}

function saveJson(records, filename) {
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
  let records = loadJson(filename);
  if (records.length) {
    const dates = records.filter(item => item.date).map(item => new Date(`${item.date}T00:00:00Z`));
    const lastDate = new Date(Math.max(...dates));
    startDate = new Date(Math.max(startDate.getTime(), addDays(lastDate, 1).getTime()));
    console.log(`检测到已有文件，最后日期为 ${lastDate.toISOString().slice(0, 10)}，将从 ${formatDate(startDate)} 继续。`);
  } else console.log(`未检测到同名 JSON，将创建新文件: ${filename}`);
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
      const question = `${year}${calendar.tMinus1Chs}收盘涨停,${year}${calendar.tMinus2Chs}收盘未涨停,${year}${calendar.tChs}10点30前达到过涨停价,${year}${calendar.tChs}涨幅>9%,${year}${calendar.tChs}最低价<${year}${calendar.tChs}涨停价,主板`;
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
      saveJson(records, filename);
      console.log(`成功获取 ${newRecords.length} 条，已保存 JSON`);
      await sleep(3000 + Math.floor(Math.random() * 3001));
    }
  } finally { await page.close(); }
  console.log(`\n>>> 全部完成！请查看文件: ${filename}`);
}

const [, , start, end] = process.argv;
if (!start || !end) {
  console.error('用法: node test-cases/turnover_json.js YYYYMMDD YYYYMMDD');
  process.exitCode = 1;
} else run(start, end).catch(error => { console.error(`输入或执行失败: ${error.message}`); process.exitCode = 1; });
