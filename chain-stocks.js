require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { chromium } = require('playwright');

const DAILY_REVIEW_DIR = path.join(__dirname, 'daily-review');
const OUTPUT_FILE = path.join(DAILY_REVIEW_DIR, '连板股票.json');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return '';
}

function compactDate(value) {
  return normalizeDate(value).replaceAll('-', '');
}

function dateLabel(value) {
  const date = normalizeDate(value);
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

function isMainBoard(code) {
  return /^(000|001|002|003|600|601|603|605|606)/.test(String(code));
}

function extractRobotRows(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.datas)) return value.datas;
  if (Array.isArray(value)) return value.flatMap(extractRobotRows);
  return Object.values(value).flatMap(extractRobotRows);
}

function collectFieldValues(value, names, results = []) {
  if (Array.isArray(value)) {
    value.forEach(child => collectFieldValues(child, names, results));
    return results;
  }
  if (!value || typeof value !== 'object') return results;
  Object.entries(value).forEach(([key, child]) => {
    const normalizedKey = String(key).replace(/\s+/g, '');
    const matchesName = names.some(name => normalizedKey === name.replace(/\s+/g, '')
      || normalizedKey.startsWith(name.replace(/\s+/g, '')));
    if (matchesName) {
      if (child && typeof child === 'object') {
        ['value', 'content', 'text', 'name'].forEach(field => {
          if (child[field] !== undefined && child[field] !== null) results.push(String(child[field]).trim());
        });
      } else if (child !== undefined && child !== null) {
        results.push(String(child).trim());
      }
    }
    collectFieldValues(child, names, results);
  });
  return results;
}

function firstFieldValue(row, names) {
  return collectFieldValues(row, names).find(value => value && !['nan', 'None', '--'].includes(value)) || '';
}

function parseCount(value) {
  const match = String(value || '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function normalizeRecord(row, date) {
  const codeValue = firstFieldValue(row, ['股票代码', '代码', '证券代码', 'code']).toUpperCase();
  const stockName = firstFieldValue(row, ['股票简称', '股票名称', '证券简称', '名称', 'name']);
  const code = (codeValue.match(/\d{6}/) || [])[0] || '';
  const consecutiveBoards = parseCount(firstFieldValue(row, [
    '连续涨停天数(天)', '连续涨停天数', '连板数', '连板个数', '连续板数', '连涨天数',
  ]));
  const limitUpReason = firstFieldValue(row, [
    '涨停原因', '涨停原因类别', '涨停原因说明', '涨停原因（个股）', '涨停原因(个股)',
  ]);
  if (!code || !stockName || consecutiveBoards < 2 || !isMainBoard(code)) return null;
  return {
    date,
    code,
    marketCode: `${code}.${code.startsWith('6') ? 'SH' : 'SZ'}`,
    stockName,
    consecutiveBoards,
    limitUpReason: limitUpReason || '暂无',
  };
}

async function ensureChromeDebugging() {
  const debugUrl = 'http://127.0.0.1:9222/json/version';
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const userDataDir = 'C:\\chrome_temp';
  try {
    const response = await axios.get(debugUrl, { timeout: 1000 });
    if (response.status >= 200 && response.status < 300) return;
  } catch { /* Chrome 尚未启动 */ }
  if (!fs.existsSync(chromePath)) throw new Error(`找不到 Chrome: ${chromePath}`);
  const chrome = spawn(chromePath, ['--remote-debugging-port=9222', `--user-data-dir=${userDataDir}`], {
    detached: true,
    stdio: 'ignore',
  });
  chrome.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await axios.get(debugUrl, { timeout: 1000 });
      if (response.status >= 200 && response.status < 300) return;
    } catch { /* 继续等待 */ }
    await sleep(500);
  }
  throw new Error('Chrome 启动超时，未能打开 9222 调试端口');
}

async function waitForManualLogin(page) {
  if (!page.url().includes('upass.10jqka.com.cn') && !page.url().includes('/login')) return;
  console.log('>>> 检测到同花顺登录/验证页面，请在当前 Chrome 窗口完成验证。');
  await page.waitForURL(url => url.includes('iwencai.com') && !url.includes('upass.10jqka.com.cn') && !url.includes('/login'), {
    timeout: 600000,
  });
}

async function extractTableRows(page) {
  return page.locator('.iwc-table-body tbody tr').evaluateAll(rows => {
    const headerSelectors = [
      '.iwc-table-header .td-cell-box', '.iwc-table-header th',
      '.iwc-table-head .td-cell-box', '.iwc-table-head th',
    ];
    const headers = headerSelectors.flatMap(selector => Array.from(document.querySelectorAll(selector)))
      .map(cell => cell.textContent.trim())
      .filter(Boolean);
    return rows.map(row => {
      const boxCells = Array.from(row.querySelectorAll('td .td-cell-box'));
      const cells = (boxCells.length ? boxCells : Array.from(row.querySelectorAll('td')))
        .map(cell => cell.textContent.trim());
      const record = Object.fromEntries(cells.map((value, index) => [headers[index] || `列${index}`, value]));
      if (!Object.keys(record).some(key => key.includes('股票代码'))) {
        Object.assign(record, {
          股票代码: cells[2] || '',
          股票简称: cells[3] || '',
          '连续涨停天数(天)': cells[6] || '',
          涨停原因: cells[7] || '',
        });
      }
      return record;
    });
  }).catch(() => []);
}

async function hasExplicitEmptyResult(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  return /选出\s*A股\s*0/.test(text) || /选出\s*股票\s*0/.test(text);
}

async function queryDate(page, date) {
  const year = `${date.slice(0, 4)}年`;
  const question = `${year}${dateLabel(date)}连续涨停天数>=2,涨停原因,主板,${year}${dateLabel(date)}涨幅>9`;
  const targetUrl = `https://www.iwencai.com/unifiedwap/result?w=${encodeURIComponent(question)}`;
  const batch = [];
  const responseTasks = [];
  const handleResponse = response => {
    if ((!response.url().includes('robotdata') && !response.url().includes('get-robot-data')) || response.status() !== 200) return;
    responseTasks.push((async () => {
      try {
        batch.push(...extractRobotRows(await response.json()));
      } catch { /* 忽略非目标响应 */ }
    })());
  };

  page.on('response', handleResponse);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForManualLogin(page);
    try {
      await page.waitForSelector('.iwc-table-body', { timeout: 15000 });
      await sleep(3000);
    } catch { /* 继续使用已捕获的接口响应 */ }
    await Promise.all(responseTasks);
    if (!batch.length) batch.push(...await extractTableRows(page));
    const uniqueRows = Array.from(new Map(batch.map(row => [JSON.stringify(row), row])).values());
    if (!uniqueRows.length && !(await hasExplicitEmptyResult(page))) {
      throw new Error('问财未返回可解析结果，已停止写入以避免覆盖已有数据');
    }
    return uniqueRows.map(row => normalizeRecord(row, date)).filter(Boolean);
  } finally {
    page.off('response', handleResponse);
  }
}

function loadLocalJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function collectDates(argumentsList) {
  if (!argumentsList.length) {
    const dates = new Set();
    fs.readdirSync(DAILY_REVIEW_DIR, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json') && entry.name !== path.basename(OUTPUT_FILE))
      .forEach(entry => loadLocalJson(path.join(DAILY_REVIEW_DIR, entry.name)).forEach(item => {
        const date = normalizeDate(item.date);
        if (date) dates.add(date);
      }));
    return [...dates].sort();
  }

  const dates = new Set();
  argumentsList.forEach(argument => {
    const directDate = normalizeDate(argument);
    if (directDate) {
      dates.add(directDate);
      return;
    }
    const files = fs.readdirSync(DAILY_REVIEW_DIR)
      .filter(file => file.toLowerCase().endsWith('.json') && file.includes(path.basename(argument)));
    files.forEach(file => loadLocalJson(path.join(DAILY_REVIEW_DIR, file)).forEach(item => {
      const date = normalizeDate(item.date);
      if (date) dates.add(date);
    }));
  });
  return [...dates].sort();
}

function saveRecords(records) {
  const temporary = `${OUTPUT_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, OUTPUT_FILE);
}

async function main() {
  const argumentsList = process.argv.slice(2).filter(argument => argument !== '--overwrite');
  const overwrite = process.argv.includes('--overwrite');
  fs.mkdirSync(DAILY_REVIEW_DIR, { recursive: true });
  const dates = collectDates(argumentsList);
  if (!dates.length) throw new Error('没有从 daily-review JSON 中找到回测日期');

  const oldRecords = loadLocalJson(OUTPUT_FILE);
  const existingDates = new Set(oldRecords.map(item => normalizeDate(item.date)).filter(Boolean));
  const recordsByDate = new Map();
  oldRecords.forEach(item => {
    const date = normalizeDate(item.date);
    if (date) {
      if (!recordsByDate.has(date)) recordsByDate.set(date, []);
      recordsByDate.get(date).push(item);
    }
  });

  await ensureChromeDebugging();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    for (const [index, date] of dates.entries()) {
      if (!overwrite && existingDates.has(date)) {
        console.log(`[${index + 1}/${dates.length}] 跳过已有日期 ${date}`);
        continue;
      }
      process.stdout.write(`[${index + 1}/${dates.length}] 正在查询 ${date} ... `);
      const records = await queryDate(page, date);
      recordsByDate.set(date, records);
      const merged = [...recordsByDate.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, items]) => items.sort((left, right) => (
          Number(right.consecutiveBoards) - Number(left.consecutiveBoards)
          || String(left.stockName).localeCompare(String(right.stockName), 'zh-CN')
        )));
      saveRecords(merged);
      console.log(`获取 ${records.length} 条，已写入 ${OUTPUT_FILE}`);
      await sleep(2000);
    }
  } finally {
    await page.close();
  }
  console.log(`完成：共处理 ${dates.length} 个回测日。上传时运行 npm run upload。`);
}

main().catch(error => {
  console.error(`\n连板股票抓取失败: ${error.message}`);
  process.exitCode = 1;
});