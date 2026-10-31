#!/usr/bin/env node
'use strict';

// 获取用例 JSON 中每只股票「首板当天」的同花顺涨停原因，保存到 reports/首板涨停原因.json，供新闻判断等后续读取。
// 涨停原因是同花顺在当天收盘后给出的，首板晚上复盘时能看到，只用来判断新闻和个股的关联，不当作新闻本身。
// 两个来源：
//   1. 同花顺涨停池接口（data.10jqka.com.cn，不用登录、不限次数），只能查到大约一年内的日期；
//   2. 更早的日期用问财（Chrome 9222 调试端口，需要登录，账号每天约 100 次查询限额）：
//      按月分组，问句里列出当月要查的股票代码（每问最多 9 个），一次拿到区间内每天的涨停原因。
// 已获取的记录会跳过，次数用完可以换账号后重跑，接着查剩下的。
// 用法: npm run first-board-reason -- [用例JSON ...] [--max-queries 90] [--refresh]

// 系统代理会把 127.0.0.1 也转发出去，连接 Chrome 调试端口前要排除本机地址。
for (const name of ['NO_PROXY', 'no_proxy']) {
  process.env[name] = [process.env[name], '127.0.0.1', 'localhost'].filter(Boolean).join(',');
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const DEFAULT_INPUT = path.join(__dirname, 'test-cases', '四连板及以上.json');
const OUTPUT_FILE = path.join(__dirname, 'reports', '首板涨停原因.json');
const POOL_URL = 'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool';
const DEBUG_URL = 'http://127.0.0.1:9222';
const DEFAULT_MAX_QUERIES = 90;
// 免费账号一个问句最多 10 个条件，每个股票代码算一个条件，加上日期区间，最多放 9 个代码。
const MAX_CODES_PER_QUESTION = 9;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return '';
}

function chineseDate(date) {
  return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

function parseArgs(argv) {
  const options = { inputs: [], maxQueries: DEFAULT_MAX_QUERIES, refresh: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--refresh') options.refresh = true;
    else if (argument === '--max-queries') options.maxQueries = Number(argv[++index]);
    else options.inputs.push(path.resolve(argument));
  }
  if (!options.inputs.length) options.inputs.push(DEFAULT_INPUT);
  if (!Number.isInteger(options.maxQueries) || options.maxQueries < 0) throw new Error('--max-queries 必须是非负整数');
  return options;
}

function helpText() {
  return [
    '用法: npm run first-board-reason -- [用例JSON ...] [--max-queries 90] [--refresh]',
    '',
    `默认输入 ${path.relative(__dirname, DEFAULT_INPUT)}，输出 ${path.relative(__dirname, OUTPUT_FILE)}（按「代码|首板日」保存）。`,
    '--max-queries  本次最多使用的问财查询次数，默认 90（账号每天约 100 次）',
    '--refresh      忽略已保存的记录，全部重新获取',
  ].join('\n');
}

function readRecords(inputs) {
  const records = new Map();
  for (const input of inputs) {
    const list = JSON.parse(fs.readFileSync(input, 'utf8'));
    if (!Array.isArray(list)) throw new Error(`${input} 不是数组`);
    for (const item of list) {
      const code = String(item.code || '').match(/\d{6}/)?.[0];
      const date = normalizeDate(item.date);
      if (code && date) records.set(`${code}|${date}`, { code, date, stockName: item.stockName || item.name || '' });
    }
  }
  return [...records.values()].sort((left, right) => left.date.localeCompare(right.date) || left.code.localeCompare(right.code));
}

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSaved(saved) {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(saved).sort(([left], [right]) => {
    const [leftCode, leftDate] = left.split('|');
    const [rightCode, rightDate] = right.split('|');
    return leftDate.localeCompare(rightDate) || leftCode.localeCompare(rightCode);
  }));
  const temporary = `${OUTPUT_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, OUTPUT_FILE);
}

function makeEntry(record, reason, source) {
  return {
    code: record.code,
    date: record.date,
    stockName: record.stockName,
    reason,
    // 当天的涨停股里找不到这只股票（数据源缺失或当天不算涨停），reason 为空，以后不再重复查询。
    found: Boolean(reason),
    source,
    fetchedAt: new Date().toISOString(),
  };
}

// 涨停池接口：返回当天全部涨停股（含 reason_type），超过约一年的日期返回「date参数不合法」。
async function fetchPool(date) {
  const reasons = new Map();
  for (let page = 1; page <= 20; page++) {
    const url = new URL(POOL_URL);
    url.search = new URLSearchParams({
      page: String(page), limit: '200', field: '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004',
      filter: 'HS,GEM2STAR', order_field: '330324', order_type: '0', date: date.replaceAll('-', ''),
    }).toString();
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html' },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json();
    if (payload.status_code !== 0) return null;
    for (const item of payload.data?.info || []) reasons.set(String(item.code), String(item.reason_type || '').trim());
    const total = Number(payload.data?.page?.total || 0);
    if (page * 200 >= total) break;
  }
  return reasons;
}

async function ensureChrome() {
  try {
    await fetch(`${DEBUG_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
    return;
  } catch { /* Chrome 尚未启动 */ }
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (!fs.existsSync(chromePath)) throw new Error(`找不到 Chrome: ${chromePath}`);
  spawn(chromePath, ['--remote-debugging-port=9222', '--user-data-dir=C:\\chrome_temp'], { detached: true, stdio: 'ignore' }).unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fetch(`${DEBUG_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('Chrome 启动超时，未能打开 9222 调试端口');
}

// stream-query 是 SSE：每行 data:{...}，行情表在 section.result_page.components[].data.datas 里。
function parseStreamRows(text) {
  const rows = [];
  const collect = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(collect);
    if (Array.isArray(value.datas)) rows.push(...value.datas);
    Object.values(value).forEach(collect);
  };
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      collect(JSON.parse(line.slice(5)));
    } catch { /* 忽略非 JSON 行 */ }
  }
  return rows;
}

// 问句：代码列表 + 日期区间 + 涨停原因，返回每只股票区间内每天一列「涨停原因[YYYYMMDD]」。
// 偶尔页面在读完数据流前跳转，响应体就拿不到了；这类临时错误重试一次，次数用完和要求登录直接抛出。
async function queryWencai(page, records) {
  try {
    return await queryWencaiOnce(page, records);
  } catch (error) {
    if (/次数已用完|要求登录/.test(error.message)) throw error;
    console.log(`（${error.message.split('\n')[0].slice(0, 60)}，重试一次）`);
    await sleep(3000);
    return queryWencaiOnce(page, records);
  }
}

async function queryWencaiOnce(page, records) {
  const codes = [...new Set(records.map(record => record.code))];
  const dates = records.map(record => record.date).sort();
  const range = dates[0] === dates.at(-1)
    ? chineseDate(dates[0])
    : `${chineseDate(dates[0])}至${chineseDate(dates.at(-1))}`;
  return runWencaiQuestion(page, `${codes.join(',')} ${range}每日涨停原因`);
}

// 在问财页面发一个问句，返回 { question, rows, byCode, notice }；自由流通市值（free-float.js）也用这个
async function runWencaiQuestion(page, question) {
  const streamPromise = page.waitForResponse(response => response.url().includes('/aime/stream-query'), { timeout: 90_000 });
  await page.goto(`https://www.iwencai.com/unifiedwap/result?w=${encodeURIComponent(question)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (/upass\.10jqka\.com\.cn|\/login/.test(page.url())) {
    throw new Error('问财要求登录，请在 Chrome 窗口登录后重跑');
  }
  // 免费次数用完时不会发数据请求，只在页面上提示，所以同时盯着页面文字。
  const quotaPromise = page.waitForFunction(() => /使用次数已超/.test(document.body?.innerText || ''), null, { timeout: 90_000, polling: 1000 })
    .then(() => 'quota');
  streamPromise.catch(() => {});
  quotaPromise.catch(() => {});
  const response = await Promise.race([streamPromise, quotaPromise]);
  if (response === 'quota') throw new Error('问财免费次数已用完（每日约 100 次），请在 Chrome 里换账号后重跑，已获取的会跳过');
  const text = await response.text();
  const allRows = parseStreamRows(text);
  const rows = allRows.filter(row => /\d{6}/.test(String(row.code || row['股票代码'] || '')));
  // 条件数超限、次数用完等提示也放在 datas 里，是带 content 的一行。
  const notice = allRows.map(row => row.content).filter(Boolean).join(' ');
  const byCode = new Map(rows.map(row => [String(row.code || row['股票代码']).match(/\d{6}/)[0], row]));
  return { question, rows, byCode, notice };
}

function groupForWencai(records) {
  const groups = [];
  const byMonth = new Map();
  for (const record of records) {
    const month = record.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(record);
  }
  for (const list of byMonth.values()) {
    for (let index = 0; index < list.length; index += MAX_CODES_PER_QUESTION) {
      groups.push(list.slice(index, index + MAX_CODES_PER_QUESTION));
    }
  }
  return groups;
}

// 已保存且不用再查的记录：找到了原因，或者问财单日补查过仍然没有。
function isSettled(entry) {
  return Boolean(entry && (entry.found || entry.retried));
}

// 发一个问句。返回 null 表示达到 --max-queries；
// 问财给出提示（次数用完、条件超限）时抛错，避免把空结果写进去；
// 没有提示、只是 0 行，说明问句没被拆开识别（通常是有一只退市股，问财股票池里没有），返回 unrecognized。
async function askWencai(page, records, queryState) {
  if (queryState.used >= queryState.max) return null;
  const result = await queryWencai(page, records);
  queryState.used++;
  await sleep(2500);
  if (result.rows.length) return result;
  if (result.notice) {
    throw new Error(`问财没有返回数据：${result.notice.slice(0, 100)}。`
      + `次数用完的话请在 Chrome 里换账号后重跑，已获取的会跳过。问句：${result.question}`);
  }
  return { ...result, unrecognized: true };
}

// 问句没被识别时对半拆开重问，找出识别不了的代码；单只也识别不了的记为 unrecognized。
// 返回 { results: [{ group, result }], unrecognized: [record] }，达到次数上限时 stopped 为 true。
async function askWithSplit(page, records, queryState) {
  const result = await askWencai(page, records, queryState);
  if (!result) return { results: [], unrecognized: [], stopped: true };
  if (!result.unrecognized) return { results: [{ group: records, result }], unrecognized: [], stopped: false };
  const codes = [...new Set(records.map(record => record.code))];
  if (codes.length === 1) return { results: [], unrecognized: records, stopped: false };
  const half = new Set(codes.slice(0, Math.ceil(codes.length / 2)));
  const left = await askWithSplit(page, records.filter(record => half.has(record.code)), queryState);
  if (left.stopped) return left;
  const right = await askWithSplit(page, records.filter(record => !half.has(record.code)), queryState);
  return {
    results: [...left.results, ...right.results],
    unrecognized: [...left.unrecognized, ...right.unrecognized],
    stopped: right.stopped,
  };
}

function reasonOf(result, record) {
  const reason = String(result.byCode.get(record.code)?.[`涨停原因[${record.date.replaceAll('-', '')}]`] || '').trim();
  return reason && reason !== '--' ? reason : '';
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const records = readRecords(options.inputs);
  const saved = options.refresh ? {} : readSaved();
  const keyOf = record => `${record.code}|${record.date}`;
  let pending = records.filter(record => !isSettled(saved[keyOf(record)]));
  console.log(`股票 ${records.length} 只，已完成 ${records.length - pending.length} 只，待获取 ${pending.length} 只`);

  // 1. 涨停池接口：按日期查（只查还没有记录的），接口不支持的日期和接口里没有的股票留给问财。
  const poolDates = [...new Set(pending.filter(record => !saved[keyOf(record)]).map(record => record.date))].sort().reverse();
  let poolCount = 0;
  for (const date of poolDates) {
    const reasons = await fetchPool(date).catch(() => null);
    // 日期从新到旧，第一个不支持的日期之前的都更早，也不支持。
    if (!reasons) break;
    for (const record of pending.filter(item => item.date === date)) {
      const reason = reasons.get(record.code) || '';
      saved[keyOf(record)] = makeEntry(record, reason, 'limit_up_pool');
      if (reason) poolCount++;
    }
    writeSaved(saved);
    await sleep(300);
  }
  pending = records.filter(record => !isSettled(saved[keyOf(record)]));
  console.log(`涨停池接口获取 ${poolCount} 只，剩 ${pending.length} 只需要问财`);
  if (!pending.length) return;
  if (!options.maxQueries) {
    console.log('--max-queries 为 0，跳过问财');
    return;
  }

  // 2. 问财：先按月分组查区间（每问最多 9 个代码）；区间结果偶尔漏掉某天的数据，
  //    漏掉的再按「同一天的代码 + 单个日期」补查一次，仍然没有才记为找不到（retried）。
  await ensureChrome();
  const browser = await chromium.connectOverCDP(DEBUG_URL);
  const page = await browser.contexts()[0].newPage();
  const queryState = { used: 0, max: options.maxQueries };
  const rangeGroups = groupForWencai(pending.filter(record => !saved[keyOf(record)] || saved[keyOf(record)].source === 'limit_up_pool'));
  let wencaiFound = 0;
  try {
    for (const [index, group] of rangeGroups.entries()) {
      process.stdout.write(`[区间 ${index + 1}/${rangeGroups.length}] ${group[0].date.slice(0, 7)} ${group.length} 只 ... `);
      const { results, unrecognized, stopped } = await askWithSplit(page, group, queryState);
      let found = 0;
      for (const { group: part, result } of results) {
        for (const record of part) {
          const reason = reasonOf(result, record);
          saved[keyOf(record)] = makeEntry(record, reason, 'iwencai');
          if (reason) found++;
        }
      }
      for (const record of unrecognized) {
        saved[keyOf(record)] = { ...makeEntry(record, '', 'iwencai'), retried: true, unrecognized: true };
      }
      wencaiFound += found;
      writeSaved(saved);
      console.log(`找到 ${found}/${group.length}${unrecognized.length ? `，问财识别不了：${[...new Set(unrecognized.map(record => record.stockName || record.code))].join('、')}` : ''}`);
      if (stopped) break;
    }

    const missing = records.filter(record => saved[keyOf(record)]?.source === 'iwencai' && !isSettled(saved[keyOf(record)]));
    const byDate = new Map();
    for (const record of missing) {
      if (!byDate.has(record.date)) byDate.set(record.date, []);
      byDate.get(record.date).push(record);
    }
    const retryGroups = [...byDate.values()].flatMap(list => groupForWencai(list));
    for (const [index, group] of retryGroups.entries()) {
      process.stdout.write(`[单日补查 ${index + 1}/${retryGroups.length}] ${group[0].date} ${group.length} 只 ... `);
      const { results, unrecognized, stopped } = await askWithSplit(page, group, queryState);
      let found = 0;
      for (const { group: part, result } of results) {
        for (const record of part) {
          const reason = reasonOf(result, record);
          saved[keyOf(record)] = { ...makeEntry(record, reason, 'iwencai'), retried: true };
          if (reason) found++;
        }
      }
      for (const record of unrecognized) {
        saved[keyOf(record)] = { ...makeEntry(record, '', 'iwencai'), retried: true, unrecognized: true };
      }
      wencaiFound += found;
      writeSaved(saved);
      console.log(`找到 ${found}/${group.length}`);
      if (stopped) break;
    }
    if (queryState.used >= queryState.max) {
      console.log(`已用 ${queryState.used} 次问财查询，达到 --max-queries 上限，剩下的换账号或明天重跑`);
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  const all = records.map(record => saved[keyOf(record)]).filter(Boolean);
  const left = records.filter(record => !isSettled(saved[keyOf(record)])).length;
  console.log(`问财用了 ${queryState.used} 次，找到 ${wencaiFound} 只。已写入 ${path.relative(__dirname, OUTPUT_FILE)}：`
    + `已找到 ${all.filter(item => item.found).length}/${records.length} 只，`
    + `确认找不到 ${all.filter(item => !item.found && item.retried).length} 只，还没查完 ${left} 只`);
}

module.exports = { OUTPUT_FILE, DEBUG_URL, MAX_CODES_PER_QUESTION, ensureChrome, runWencaiQuestion, chineseDate };

if (require.main === module) {
  main().catch(error => {
    console.error(`\n首板涨停原因获取失败: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
