#!/usr/bin/env node
'use strict';

// 连板情绪周期数据：每天的涨停家数和各连板高度，写 reports/连板情绪周期.json，页面 limit-up-cycle.html 用。
// 连板数用全市场涨停名单连续上榜的天数算（stock-pick.js 的 buildDays），不含北交所（涨停池接口查不到，历史口径才一致）。
// 没有换手的连板买不到、不反映情绪，整段不计入高度：二板到倒数第二板之间至少有一个换手板（非一字），这段连板才按完整天数算；
// 第一板不看；只有最后一板换手也不算（如上纬新材 2025 年 7 月那段）。两连板一共就两个板，都算。整段一起判断，还在走的连板按目前的板数判断。
// 当时是 ST 的涨停（涨幅 5% 左右）不算进涨停家数和连板；当时还不是 ST 的（涨幅 10% 左右）照算，哪怕现在名称带 ST。
// 涨停名单里每只股票只有一个名称（当前名称），看不出当时的状态，所以按当天涨幅判断：涨幅不到 6% 就涨停的算 ST；查不到 K 线的（多是退市股）才看名称。
// 一字板（开高低收相同）和涨幅都要看日 K，每只涨停都要查，结果缓存到 reports/连板一字板.json，每天只查新增的。K 线从本地网站服务取，没开会临时启动。
//
// 用法: npm run limit-up-cycle -- [--upload]
//   --upload：同时写到 R2 的 limit-up-cycle/连板情绪周期.json，线上页面读这份
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { makeTagger, buildDays } = require('./stock-pick');
const { updateLimitUpList } = require('./limit-up-list');
const { ensureServer } = require('./review-pipeline');

const ROOT = __dirname;
const OUTPUT_FILE = path.join(ROOT, 'reports', '连板情绪周期.json');
const ONE_WORD_FILE = path.join(ROOT, 'reports', '连板一字板.json');
const R2_KEY = 'limit-up-cycle/连板情绪周期.json';
const WORKERS = 10;
const FIRST_DAY = '2024-01-01'; // 名单从 2023-12-18 开始，头几天的连板数不完整，不展示
const BEIJING_DAY = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const FLAG_ONE_WORD = 2;
const ST_MAX_PCT = 6;
const isBeijingExchange = code => /^[489]/.test(code);

function writeJson(file, data) {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data)}\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

// /api/kline 按 cutoffDate 返回之前约 240 根：从最晚的日期往前，一次覆盖尽量多的日期
async function fetchOneWord(baseUrl, code, dates, cache) {
  const left = new Set(dates);
  while (left.size) {
    const cutoff = [...left].sort().at(-1);
    const url = `${baseUrl}/api/kline?code=${code}&cutoffDate=${cutoff}`;
    let bars = [];
    for (let attempt = 0; ; attempt++) {
      try {
        const payload = await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).json();
        if (payload.status_code !== 0 || !Array.isArray(payload.data)) throw new Error(payload.msg || 'K 线接口返回错误');
        bars = payload.data;
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    bars.forEach((bar, index) => {
      if (!left.has(bar.date)) return;
      const previous = bars[index - 1];
      cache[`${code}|${bar.date}`] = {
        oneWord: bar.open === bar.close && bar.high === bar.low && bar.open === bar.high,
        pct: previous ? Number(((bar.close / previous.close - 1) * 100).toFixed(2)) : null,
      };
      left.delete(bar.date);
    });
    // 这一天接口没返回（停牌、退市后查不到）就不再问，当作不是一字板
    left.delete(cutoff);
  }
}

async function fillOneWord(baseUrl, rows, cache) {
  const byCode = new Map();
  for (const { code, date } of rows) {
    if (`${code}|${date}` in cache) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(date);
  }
  const queue = [...byCode.entries()];
  console.log(`一字板待查 ${queue.reduce((sum, [, dates]) => sum + dates.length, 0)} 条，${queue.length} 只股票`);
  let done = 0;
  const failed = [];
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (queue.length) {
      const [code, dates] = queue.pop();
      await fetchOneWord(baseUrl, code, dates, cache).catch(error => failed.push(`${code}: ${error.message}`));
      if (++done % 200 === 0) {
        writeJson(ONE_WORD_FILE, cache);
        console.log(`  已查 ${done} 只`);
      }
    }
  }));
  writeJson(ONE_WORD_FILE, cache);
  return failed;
}

// 每段连板从二板起各板是否一字，key 是 代码|首板日
function chainKey(date, item, days) {
  return `${item.code}|${days[days.indexOf(date) - item.streak + 1]}`;
}

function hasTurnover(oneWords) {
  return oneWords.length === 1 || oneWords.slice(0, -1).some(oneWord => !oneWord);
}

// [{ d: 日期, t: 涨停家数, b: [[名称, 连板数, 标记], ...] }]，b 只放 2 板及以上，高的在前
function buildCycle(byDay, days, cache) {
  const stocksOf = date => [...byDay.get(date).values()].filter(item => !isBeijingExchange(item.code));
  const chains = new Map();
  for (const date of days) {
    for (const item of stocksOf(date)) {
      if (item.streak < 2) continue;
      const key = chainKey(date, item, days);
      if (!chains.has(key)) chains.set(key, []);
      chains.get(key).push(cache[`${item.code}|${date}`]?.oneWord === true);
    }
  }
  return days.flatMap(date => {
    if (date < FIRST_DAY) return [];
    const isSt = item => {
      const pct = cache[`${item.code}|${date}`]?.pct;
      return Number.isFinite(pct) ? pct < ST_MAX_PCT : /ST/i.test(item.name);
    };
    const stocks = stocksOf(date).filter(item => !isSt(item));
    const boards = stocks.filter(item => item.streak >= 2).map(item => {
      const noTurnover = !hasTurnover(chains.get(chainKey(date, item, days)));
      return [item.name, item.streak, noTurnover ? FLAG_ONE_WORD : 0];
    });
    boards.sort((left, right) => right[1] - left[1]);
    return [{ d: date, t: stocks.length, b: boards }];
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 12).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const unknown = argv.find(argument => argument !== '--upload');
  if (unknown) throw new Error(`未知参数: ${unknown}`);
  const r2 = argv.includes('--upload') ? require('./r2-storage') : null;
  if (r2 && !r2.r2Client) throw new Error('R2 未配置，不能 --upload');

  const { byDay, days } = buildDays(await updateLimitUpList(BEIJING_DAY()), makeTagger());
  const rows = days.flatMap(date => [...byDay.get(date).values()].filter(item => !isBeijingExchange(item.code)));
  const cache = fs.existsSync(ONE_WORD_FILE) ? JSON.parse(fs.readFileSync(ONE_WORD_FILE, 'utf8')) : {};
  if (rows.some(({ code, date }) => !(`${code}|${date}` in cache))) {
    const baseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`;
    const stopServer = await ensureServer(baseUrl);
    try {
      const failed = await fillOneWord(baseUrl, rows, cache);
      if (failed.length) throw new Error(`${failed.length} 只股票 K 线获取失败（已查到的已缓存，重跑会接着查）：${failed.slice(0, 3).join('；')}`);
    } finally {
      stopServer();
    }
  }
  const missing = rows.filter(({ code, date }) => !(`${code}|${date}` in cache)).length;
  const cycle = buildCycle(byDay, days, cache);
  writeJson(OUTPUT_FILE, cycle);
  console.log(`写入 ${path.relative(ROOT, OUTPUT_FILE)}：${cycle.length} 天，${cycle[0].d} ~ ${cycle.at(-1).d}；查不到 K 线 ${missing} 条（按非一字、看名称判断 ST）`);
  if (r2) {
    await r2.writeJson(R2_KEY, cycle);
    console.log(`已更新 R2 ${R2_KEY}`);
  }
}

main().catch(error => {
  console.error(`连板情绪周期生成失败: ${error.message}`);
  process.exitCode = 1;
});
