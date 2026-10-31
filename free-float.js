#!/usr/bin/env node
'use strict';

// 获取每日复盘每条记录「首板当天」的自由流通市值（元），缓存到 reports/自由流通市值.json，
// 并写进 daily-review/ 下今日首板和一进二回测文件每条记录的 freeFloatCap 字段，页面显示在成交额右边。
// 通达信只有流通股本（含持股 5% 以上的大股东），没有自由流通股，所以用问财：
// 按月分组，问句里列出当月要查的股票代码（每问最多 9 个），一次拿到区间内每天的自由流通市值。
// 账号每天约 100 次查询限额，和涨停原因共用；从最近的日期往前查，已查过的跳过，每天跑一点就能慢慢补齐历史。
//
// 用法: npm run free-float -- [--max-queries 20] [--upload]
//   --upload：同时更新 R2 的 daily-review/ 同名文件（读 R2 上的版本、只改 freeFloatCap 字段再写回）
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { DEBUG_URL, MAX_CODES_PER_QUESTION, ensureChrome, runWencaiQuestion, chineseDate } = require('./first-board-reason');

const ROOT = __dirname;
const REVIEW_DIR = path.join(ROOT, 'daily-review');
const CACHE_FILE = path.join(ROOT, 'reports', '自由流通市值.json');
const DEFAULT_MAX_QUERIES = 20;
const REVIEW_FILE = /^(今日首板|一进二回测_\d{8}_\d{8})\.json$/;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const keyOf = record => `${record.code}|${record.date}`;
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

function writeJson(file, data, pretty) {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, pretty ? 2 : 0)}\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

function parseArgs(argv) {
  const options = { maxQueries: DEFAULT_MAX_QUERIES, upload: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--upload') options.upload = true;
    else if (argument === '--max-queries') options.maxQueries = Number(argv[++index]);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数: ${argument}`);
  }
  if (!Number.isInteger(options.maxQueries) || options.maxQueries < 0) throw new Error('--max-queries 必须是非负整数');
  return options;
}

// 从最近的月份往前，每组同一个月、最多 9 个代码
function groupByMonth(records) {
  const byMonth = new Map();
  for (const record of [...records].sort((left, right) => right.date.localeCompare(left.date))) {
    const month = record.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(record);
  }
  const groups = [];
  for (const list of byMonth.values()) {
    const codes = [...new Set(list.map(record => record.code))];
    for (let index = 0; index < codes.length; index += MAX_CODES_PER_QUESTION) {
      const part = new Set(codes.slice(index, index + MAX_CODES_PER_QUESTION));
      groups.push(list.filter(record => part.has(record.code)));
    }
  }
  return groups;
}

// 问一组；问财没认出问句（通常是组里有退市股）时对半拆开重问，单只也认不出就记为查不到。
// 返回 false 表示达到查询次数上限。
async function askGroup(page, group, cache, state) {
  if (state.used >= state.max) return false;
  const dates = group.map(record => record.date).sort();
  const codes = [...new Set(group.map(record => record.code))];
  const range = dates[0] === dates.at(-1) ? chineseDate(dates[0]) : `${chineseDate(dates[0])}至${chineseDate(dates.at(-1))}`;
  const result = await runWencaiQuestion(page, `${codes.join(',')} ${range}每日自由流通市值`);
  state.used++;
  await sleep(2500);
  if (!result.rows.length) {
    if (result.notice) throw new Error(`问财没有返回数据：${result.notice.slice(0, 100)}。问句：${result.question}`);
    if (codes.length === 1) {
      for (const record of group) cache[keyOf(record)] = null;
      return true;
    }
    const half = new Set(codes.slice(0, Math.ceil(codes.length / 2)));
    return await askGroup(page, group.filter(record => half.has(record.code)), cache, state)
      && askGroup(page, group.filter(record => !half.has(record.code)), cache, state);
  }
  const missing = [];
  for (const record of group) {
    const value = Number(result.byCode.get(record.code)?.[`自由流通市值[${record.date.replaceAll('-', '')}]`]);
    if (Number.isFinite(value) && value > 0) cache[keyOf(record)] = Math.round(value);
    else missing.push(record);
  }
  // 区间结果偶尔漏掉某天的列：漏掉的按「同一天的代码 + 单个日期」补查一次，仍然没有才记为查不到
  if (dates[0] === dates.at(-1)) {
    for (const record of missing) cache[keyOf(record)] = null;
    return true;
  }
  for (const date of [...new Set(missing.map(record => record.date))]) {
    if (!(await askGroup(page, missing.filter(record => record.date === date), cache, state))) return false;
  }
  return true;
}

// 把缓存里的值写进记录的 freeFloatCap，返回改动的条数
function applyCaps(records, cache) {
  let changed = 0;
  for (const record of records) {
    const value = cache[keyOf(record)];
    if (Number.isFinite(value) && record.freeFloatCap !== value) {
      record.freeFloatCap = value;
      changed++;
    }
  }
  return changed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 12).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const r2 = options.upload ? require('./r2-storage') : null;
  if (r2 && !r2.r2Client) throw new Error('R2 未配置，不能 --upload');

  const files = fs.readdirSync(REVIEW_DIR).filter(file => REVIEW_FILE.test(file));
  const records = files.flatMap(file => readJson(path.join(REVIEW_DIR, file), []));
  const cache = readJson(CACHE_FILE, {});
  // 换了机器、本地没有缓存时，记录里已有的值（从 R2 同步下来的）直接用，不再问
  for (const record of records) if (Number.isFinite(record.freeFloatCap) && !(keyOf(record) in cache)) cache[keyOf(record)] = record.freeFloatCap;
  const pending = [...new Map(records.filter(record => !(keyOf(record) in cache)).map(record => [keyOf(record), record])).values()];
  console.log(`记录 ${records.length} 条，待查自由流通市值 ${pending.length} 条，本次最多问 ${options.maxQueries} 次`);

  if (pending.length && options.maxQueries) {
    await ensureChrome();
    const browser = await chromium.connectOverCDP(DEBUG_URL);
    const page = await browser.contexts()[0].newPage();
    const state = { used: 0, max: options.maxQueries };
    try {
      for (const group of groupByMonth(pending)) {
        if (!(await askGroup(page, group, cache, state))) break;
        writeJson(CACHE_FILE, cache);
      }
    } finally {
      writeJson(CACHE_FILE, cache);
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    }
    const left = records.filter(record => !(keyOf(record) in cache)).length;
    console.log(`问财用了 ${state.used} 次，还剩 ${left} 条没查${left ? '（明天继续，或换账号后加大 --max-queries）' : ''}`);
  }

  for (const file of files) {
    const localFile = path.join(REVIEW_DIR, file);
    const local = readJson(localFile, []);
    const changed = applyCaps(local, cache);
    if (changed) writeJson(localFile, local, true);
    console.log(`${file}: 写入 ${changed} 条`);
    if (r2) {
      const remote = await r2.readJson(`daily-review/${file}`).catch(error => (r2.isMissing(error) ? null : Promise.reject(error)));
      if (!Array.isArray(remote)) continue;
      const remoteChanged = applyCaps(remote, cache);
      if (remoteChanged) {
        await r2.writeJson(`daily-review/${file}`, remote);
        console.log(`  已更新 R2 daily-review/${file}（${remoteChanged} 条）`);
      }
    }
  }
}

main().catch(error => {
  console.error(`自由流通市值获取失败: ${error.message}`);
  process.exitCode = 1;
});
