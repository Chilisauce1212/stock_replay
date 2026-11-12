#!/usr/bin/env node
'use strict';

// 生成「二进三、最终至少 5 连板」样本（2026-11-11 用户要求）：
//   - 首板日 F、二板日 D 收盘封死涨停（F 的前一交易日没有涨停）、主板；
//   - 二板日 D 必须是一字板：全天每笔成交都在涨停价（最低价 = 最高价 = 涨停价，用户 2026-11-11 要求）；
//   - 三板日 T（D 的下一个交易日）10:30 前（含 10:30 那一分钟）在涨停价买得到，且不是一字板，买点规则与一进二相同
//     （竞价没有涨停开盘：第一次在涨停价成交时买；竞价涨停开盘：等开盘后跌破再回到涨停价时买）；
//   - 从 F 起连续封死涨停天数 ≥ --min-boards（默认 5，即 T 之后至少还有 T+1、T+2 两个板）。
//     这是事后条件（用了买入之后的信息），和「四连板及以上」一样只用来研究，不能当选股条件。
// 记录的 date = 二板日 D（买入日的前一交易日），盈亏直接用 pnl.js（买入日 = date 的下一个交易日，成本为涨停价，卖点规则同一进二）。
// 涨停名单来自 reports/全市场涨停原因.json（封死口径，脚本开始时自动补到 --end）；逐笔来自通达信。不需要网站服务和问财。
//
// 用法: node erjinsan-cases.js --start 20240104 --end 20261231 [--min-boards 5] [--workers 6]
//   --start/--end 是三板日（买入日）范围；输出 daily-review/二进三五连板及以上.json（已有记录的 pnl、judge、freeFloatCap 保留），明细写 reports/二进三五连板及以上.detail.json
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { Worker, healthyHosts } = require('./tdx_tick');
const { updateLimitUpList } = require('./limit-up-list');

const OUT_FILE = path.join(__dirname, 'daily-review', '二进三五连板及以上.json');
const DETAIL_FILE = path.join(__dirname, 'reports', '二进三五连板及以上.detail.json');
const LATEST_TOUCH = '10:30';
const LIMIT_RATIO = 0.1; // 主板非 ST

function parseArgs(argv) {
  const options = { start: '', end: '', workers: 6, minBoards: 5 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--start') options.start = String(argv[++index] || '');
    else if (argument === '--end') options.end = String(argv[++index] || '');
    else if (argument === '--workers') options.workers = Math.min(12, Math.max(1, Number(argv[++index]) || 6));
    else if (argument === '--min-boards') options.minBoards = Math.max(3, Number(argv[++index]) || 5);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数: ${argument}`);
  }
  if (!options.help && (!/^\d{8}$/.test(options.start) || !/^\d{8}$/.test(options.end))) throw new Error('--start / --end 需要 YYYYMMDD');
  return options;
}

const dash = text => `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
const round2 = value => Math.round(value * 100 + 1e-6) / 100;
const marketCode = code => `${code}.${code.startsWith('6') ? 'SH' : 'SZ'}`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 16).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');
  const start = dash(options.start);
  const end = dash(options.end);

  const months = await updateLimitUpList(end);
  const byDay = new Map();
  for (const list of Object.values(months)) {
    for (const item of list) {
      if (!byDay.has(item.date)) byDay.set(item.date, new Map());
      byDay.get(item.date).set(item.code, item);
    }
  }
  const days = [...byDay.keys()].sort();
  const sealed = (dayIndex, code) => dayIndex < days.length && byDay.get(days[dayIndex]).has(code);

  // 候选：F、D 封死，F-1 没封；T 及之后连续封死，使从 F 起的连板数 ≥ minBoards（T 本身也要封死，否则不可能 ≥ 3）
  const tasks = [];
  for (let index = 3; index < days.length; index++) {
    const tradeDay = days[index];
    if (tradeDay < start || tradeDay > end) continue;
    for (const [code, item] of byDay.get(days[index - 1])) {
      if (!/^(60|00)/.test(code) || !sealed(index - 2, code) || sealed(index - 3, code)) continue;
      let boards = 2;
      while (sealed(index - 2 + boards, code)) boards++;
      if (boards < options.minBoards) continue;
      // 连板一直延续到名单最新一天的，最终板数还不确定，但已经满足 ≥ minBoards
      tasks.push({ code, name: item.name, first: days[index - 2], signal: days[index - 1], tradeDay, boards });
    }
  }
  console.log(`三板日 ${start} ~ ${end}（涨停名单最新到 ${days.at(-1)}）：二板后最终 ≥ ${options.minBoards} 连板的主板股票 ${tasks.length} 只，逐笔判断三板日买点…`);

  const hosts = await healthyHosts();
  const workers = Array.from({ length: options.workers }, (_, index) => new Worker(hosts, index, 0.02));
  const results = [];
  const rejected = [];
  const failures = [];
  let next = 0;
  await Promise.all(workers.map(async worker => {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        if (!worker.conn) await worker._connect();
        const trades = async day => (await worker.fetchDay(task.code, day.replaceAll('-', ''))).filter(tick => tick.vol > 0 && tick.time >= '09:25');
        const firstTicks = await trades(task.first);
        if (!firstTicks.length) throw new Error('首板日没有逐笔成交');
        const secondLimit = round2(firstTicks.at(-1).price * (1 + LIMIT_RATIO));
        const signalTicks = await trades(task.signal);
        if (!signalTicks.length) throw new Error('二板日没有逐笔成交');
        if (!signalTicks.every(tick => Math.abs(tick.price - secondLimit) < 0.005)) {
          rejected.push({ ...task, reason: '二板不是一字板' });
          continue;
        }
        const limit = round2(signalTicks.at(-1).price * (1 + LIMIT_RATIO));
        const ticks = await trades(task.tradeDay);
        if (!ticks.length) throw new Error('三板日没有逐笔成交（可能停牌）');
        const atLimit = tick => tick.price >= limit - 0.005;
        const oneWord = ticks.every(atLimit);
        const openAtLimit = ticks[0].time === '09:25' && atLimit(ticks[0]);
        let buy = null;
        if (!openAtLimit) buy = ticks.find(atLimit);
        else if (!oneWord) buy = ticks.slice(ticks.findIndex(tick => !atLimit(tick)) + 1).find(atLimit) || null;
        if (buy && !oneWord && buy.time <= LATEST_TOUCH) results.push({ ...task, firstTouch: buy.time, openAtLimit });
        else rejected.push({ ...task, reason: oneWord ? '一字板' : !buy ? '没在涨停价买到' : `${buy.time} 才买到` });
      } catch (error) {
        failures.push({ ...task, error: error.message });
        if (/no server|ECONN|socket|timeout/i.test(error.message)) {
          worker.close();
          worker.conn = null;
        }
      }
    }
  }));
  workers.forEach(worker => worker.close());

  const old = fs.existsSync(OUT_FILE) ? new Map(JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).map(item => [`${item.code}|${item.date}`, item])) : new Map();
  results.sort((left, right) => left.signal.localeCompare(right.signal) || left.code.localeCompare(right.code));
  const records = results.map((item, index) => ({
    ...old.get(`${item.code}|${item.signal}`),
    id: `${index}-${item.signal.replaceAll('-', '')}-${marketCode(item.code)}`,
    date: item.signal, code: item.code, marketCode: marketCode(item.code), stockName: item.name,
    firstBoardDate: item.first, boardCount: item.boards,
  }));
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  fs.writeFileSync(DETAIL_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString(), results, rejected, failures }, null, 1)}\n`, 'utf8');
  const count = reason => rejected.filter(item => item.reason.includes(reason)).length;
  console.log(`符合条件 ${records.length} 只 → ${path.relative(__dirname, OUT_FILE)}；排除：二板不是一字板 ${count('二板不是')}、三板一字板 ${rejected.filter(item => item.reason === '一字板').length}、没买到 ${count('没在涨停价')}、10:30 后才买到 ${count('才买到')}；失败 ${failures.length}`);
  failures.slice(0, 8).forEach(item => console.log(`  失败 ${item.signal} ${item.code} ${item.name}: ${item.error}`));
}

main().catch(error => {
  console.error(`生成二进三样本失败: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
