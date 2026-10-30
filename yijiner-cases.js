#!/usr/bin/env node
'use strict';

// 生成一进二回测用例：首板日 D 收盘涨停（D-1 未涨停）、主板；二板日 T（D 的下一个交易日）
// 10:30 前（含 10:30 那一分钟）在涨停价买得到，且不是一字板。买入时点：
//   - 竞价没有涨停开盘：第一次在涨停价成交时；
//   - 竞价涨停开盘：不买，等开盘后跌破涨停价、再回到涨停价（二次回封）时才买。
//
// 为什么不用问财：问句「T日10点30前达到过T日涨停价」被问财解析成「10:30 那一分钟的最高价」，
// 早盘触板后又开板的票会被漏掉；「首次涨停时间早于10点30分」又只算封住（卖一为 0）的，只在涨停价成交过的不算。
// 回测收益按二板日涨停价成本计算，只要在涨停价成交过就能买到，所以这里用逐笔成交判断。
//
// 数据：首板名单来自 reports/全市场涨停原因.json（见 limit-up-list.js，脚本开始时自动用同花顺涨停池接口补齐到 --end）；
//       通达信逐笔成交：首板日最后一笔是原始收盘价，算出二板日涨停价，再找二板日首次在涨停价成交的时间。不需要网站服务。
//
// 用法: npm run yijiner-cases -- --start 20260106 --end 20261231 [--workers 6]
//   --start/--end 是二板日（买入日）范围，与 npm run turnover 的参数一致；输出 test-cases/一进二回测_<start>_<end>.json
//   已有同名文件时：保留已有记录（含 id），从最后一个首板日之后接着查、只追加新找到的；加 --replace 则整段重查并重写
//   首次触板时间（累积保留）和本次运行的失败明细写入同名 .detail.json
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Worker, healthyHosts } = require('./tdx_tick');
const { updateLimitUpList } = require('./limit-up-list');

const TEST_CASE_DIR = path.join(__dirname, 'test-cases');
const LATEST_TOUCH = '10:30';
const LIMIT_RATIO = 0.1; // 主板非 ST

function parseArgs(argv) {
  const options = { start: '', end: '', workers: 6, replace: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--start') options.start = String(argv[++index] || '');
    else if (argument === '--end') options.end = String(argv[++index] || '');
    else if (argument === '--workers') options.workers = Math.min(12, Math.max(1, Number(argv[++index]) || 6));
    else if (argument === '--replace') options.replace = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数: ${argument}`);
  }
  if (!options.help && (!/^\d{8}$/.test(options.start) || !/^\d{8}$/.test(options.end))) throw new Error('--start / --end 需要 YYYYMMDD');
  return options;
}

const dash = text => `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
const round2 = value => Math.round(value * 100 + 1e-6) / 100;
const marketCode = code => `${code}.${code.startsWith('6') ? 'SH' : 'SZ'}`;

function indexLimitUps(months) {
  const byDay = new Map();
  for (const list of Object.values(months)) {
    for (const item of list) {
      if (!byDay.has(item.date)) byDay.set(item.date, new Map());
      byDay.get(item.date).set(item.code, item);
    }
  }
  return { byDay, days: [...byDay.keys()].sort() };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 18).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');

  const end = dash(options.end);
  const outFile = path.join(TEST_CASE_DIR, `一进二回测_${options.start}_${options.end}.json`);
  const existing = !options.replace && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : [];
  // 已有文件时从最后一个首板日的次日（即它的二板日）接着查，重复的会跳过
  const lastSignal = existing.map(item => item.date).sort().at(-1);
  const start = lastSignal && lastSignal >= dash(options.start)
    ? new Date(new Date(`${lastSignal}T00:00:00Z`).getTime() + 86400_000).toISOString().slice(0, 10)
    : dash(options.start);
  if (lastSignal) console.log(`已有 ${existing.length} 条，最后首板日 ${lastSignal}，从二板日 ${start} 接着查`);
  const { byDay, days } = indexLimitUps(await updateLimitUpList(end));
  // 二板日 T 在范围内，且 T 的前两个交易日都有涨停数据
  const pairs = [];
  for (let index = 2; index < days.length; index++) {
    const tradeDay = days[index];
    if (tradeDay < start || tradeDay > end) continue;
    pairs.push({ prior: days[index - 2], signal: days[index - 1], tradeDay });
  }
  if (!pairs.length && existing.length) {
    console.log('涨停名单里还没有更新的二板日，无需追加。');
    return;
  }
  if (!pairs.length) throw new Error(`全市场涨停原因.json 里没有 ${start} ~ ${end} 的二板日，超过一年的日期需要先用问财补齐涨停名单`);
  const lastKnown = days.at(-1);
  console.log(`二板日 ${pairs[0].tradeDay} ~ ${pairs.at(-1).tradeDay}（涨停名单最新到 ${lastKnown}，二板日需要再晚一天才能判断）`);

  const tasks = [];
  for (const { prior, signal, tradeDay } of pairs) {
    for (const [code, item] of byDay.get(signal)) {
      // 不按名称排除 ST：问财区间结果里的简称是现在的名称；当时是 ST 的票涨跌幅 5%，二板日到不了 +10%，逐笔判断自然排除
      if (!/^(60|00)/.test(code) || byDay.get(prior).has(code)) continue;
      tasks.push({ code, name: item.name, signal, tradeDay });
    }
  }
  console.log(`主板首板 ${tasks.length} 只，逐笔判断中…`);

  const hosts = await healthyHosts();
  const workers = Array.from({ length: options.workers }, (_, index) => new Worker(hosts, index, 0.02));
  const results = [];
  const failures = [];
  let next = 0;
  let done = 0;
  let touched = 0;
  await Promise.all(workers.map(async worker => {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        if (!worker.conn) await worker._connect();
        const trades = async day => (await worker.fetchDay(task.code, day.replaceAll('-', ''))).filter(tick => tick.vol > 0 && tick.time >= '09:25');
        const signalTicks = await trades(task.signal);
        if (!signalTicks.length) throw new Error('首板日没有逐笔成交');
        // 逐笔是原始价：首板日最后一笔就是收盘价，二板日涨停价 = 收盘价 × 1.1
        const limit = round2(signalTicks.at(-1).price * (1 + LIMIT_RATIO));
        const ticks = await trades(task.tradeDay);
        if (!ticks.length) throw new Error('二板日没有逐笔成交（可能停牌）');
        const atLimit = tick => tick.price >= limit - 0.005;
        const oneWord = ticks.every(atLimit);
        const openAtLimit = ticks[0].time === '09:25' && atLimit(ticks[0]);
        // 竞价涨停开盘不买：要等开盘后跌破涨停价、再回到涨停价（二次回封）时才买
        let buy = null;
        if (!openAtLimit) {
          buy = ticks.find(atLimit);
        } else if (!oneWord) {
          const broken = ticks.findIndex(tick => !atLimit(tick));
          buy = ticks.slice(broken + 1).find(atLimit) || null;
        }
        if (buy && !oneWord) {
          touched++;
          if (buy.time <= LATEST_TOUCH) results.push({ ...task, firstTouch: buy.time, openAtLimit });
        }
      } catch (error) {
        failures.push({ ...task, error: error.message });
        if (/no server|ECONN|socket|timeout/i.test(error.message)) {
          worker.close();
          worker.conn = null;
        }
      }
      done++;
      if (done % 200 === 0 || done === tasks.length) {
        process.stdout.write(`\r进度 ${done}/${tasks.length}，二板日触及涨停（非一字）${touched}，10:30 前 ${results.length}，失败 ${failures.length}`);
      }
    }
  }));
  workers.forEach(worker => worker.close());
  console.log();

  const known = new Set(existing.map(item => `${item.code}|${item.date}`));
  results.sort((left, right) => left.signal.localeCompare(right.signal) || left.code.localeCompare(right.code));
  const added = results.filter(item => !known.has(`${item.code}|${item.signal}`)).map((item, index) => ({
    id: `${existing.length + index}-${item.signal.replaceAll('-', '')}-${marketCode(item.code)}`,
    date: item.signal, code: item.code, marketCode: marketCode(item.code), stockName: item.name,
  }));
  const records = existing.concat(added).sort((left, right) => left.date.localeCompare(right.date));
  fs.mkdirSync(TEST_CASE_DIR, { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  const detailFile = path.join(TEST_CASE_DIR, `一进二回测_${options.start}_${options.end}.detail.json`);
  // 接着查时保留之前的触板明细，stock-pick 靠它判断是否竞价涨停开盘
  const previous = !options.replace && fs.existsSync(detailFile) ? JSON.parse(fs.readFileSync(detailFile, 'utf8')).results || [] : [];
  const fresh = new Set(results.map(item => `${item.code}|${item.signal}`));
  const allResults = previous.filter(item => !fresh.has(`${item.code}|${item.signal}`)).concat(results)
    .sort((left, right) => left.signal.localeCompare(right.signal) || left.code.localeCompare(right.code));
  fs.writeFileSync(detailFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), results: allResults, failures }, null, 1)}\n`, 'utf8');
  console.log(`符合条件 ${results.length} 只；原有 ${existing.length} 条，追加 ${added.length} 条，共 ${records.length} 条 → ${path.relative(__dirname, outFile)}`);
  console.log(`首次触板时间和失败明细 → ${path.relative(__dirname, detailFile)}`);
  if (failures.length) {
    console.log(`失败 ${failures.length} 只（停牌、行情缺失或网络），前几条：`);
    failures.slice(0, 8).forEach(item => console.log(`  ${item.signal} ${item.code} ${item.name}: ${item.error}`));
  }
}

main().catch(error => {
  console.error(`生成一进二用例失败: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
