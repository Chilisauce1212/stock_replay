#!/usr/bin/env node
'use strict';

// 生成一进二回测用例：首板日 D 收盘涨停（D-1 未涨停）、主板；二板日 T（D 的下一个交易日，按个股交易日算、停牌跳过）
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
  // 首板、二板按个股自己的交易日算（和 K 线图、pnl.js 一致，停牌日跳过；2026-11-15 用户要求，同二进三）：
  //   - 首板日 D 的前一个「个股交易日」没有涨停：D-1 停牌的，往前找到停牌前最后一个交易日再看
  //     （以前按全市场交易日，停牌前已涨停、复牌又涨停的被当成首板，如 2026-01-12 嘉美包装）；
  //   - 二板日 T = D 之后个股第一个交易日：首板后停牌的顺延到复牌日（以前记成失败「可能停牌」，样本里漏掉）。
  // 二板日 T 在 start ~ end 内。T 可能因停牌比 D 晚很多，所以 D 往前多看 40 个交易日；这些早的 D 先问一次 D+1 有没有成交，
  // 有成交就说明 T = D+1 早于 start，直接跳过。停牌用 hasTrades（只取 1 笔成交）判断。
  const startIndex = days.findIndex(day => day >= start);
  if (startIndex < 1 || days[startIndex] > end) {
    if (existing.length) {
      console.log('涨停名单里还没有更新的二板日，无需追加。');
      return;
    }
    throw new Error(`全市场涨停原因.json 里没有 ${start} ~ ${end} 的二板日，超过一年的日期需要先用问财补齐涨停名单`);
  }
  const sealed = (dayIndex, code) => dayIndex >= 0 && dayIndex < days.length && byDay.get(days[dayIndex]).has(code);
  const firstSeal = new Map(); // code → 第一次出现在涨停名单的下标
  days.forEach((day, dayIndex) => {
    for (const code of byDay.get(day).keys()) if (!firstSeal.has(code)) firstSeal.set(code, dayIndex);
  });
  const known = new Set(existing.map(item => `${item.code}|${item.date}`));
  const lastKnown = days.at(-1);
  console.log(`二板日 ${days[startIndex]} ~ ${end < lastKnown ? end : lastKnown}（涨停名单最新到 ${lastKnown}，二板日需要再晚一天才能判断）`);

  const tasks = [];
  for (let index = Math.max(1, startIndex - 41); index < days.length - 1 && days[index] <= end; index++) {
    for (const [code, item] of byDay.get(days[index])) {
      // 不按名称排除 ST：问财区间结果里的简称是现在的名称；当时是 ST 的票涨跌幅 5%，二板日到不了 +10%，逐笔判断自然排除
      if (!/^(60|00)/.test(code) || sealed(index - 1, code) || known.has(`${code}|${days[index]}`)) continue;
      if (index + 1 < startIndex && sealed(index + 1, code)) continue; // 二板日 D+1 早于 start
      tasks.push({ code, name: item.name, signalIndex: index });
    }
  }
  console.log(`待判断的主板涨停 ${tasks.length} 条（含 start 前 40 个交易日、可能停牌顺延的），逐笔判断中…`);
  const tradedCache = new Map();
  let suspendChecks = 0;
  let suspendedCases = 0;

  const hosts = await healthyHosts();
  const workers = Array.from({ length: options.workers }, (_, index) => new Worker(hosts, index, 0.02));
  const results = [];
  const failures = [];
  const notFirst = [];
  let next = 0;
  let done = 0;
  let touched = 0;
  await Promise.all(workers.map(async worker => {
    while (next < tasks.length) {
      const raw = tasks[next++];
      const { code, signalIndex: D } = raw;
      const task = { code, name: raw.name, signal: days[D] };
      // 网络错误（超时、断线）换下一台服务器重试，最多 4 次（2026-11-23 加：以前一次超时就算失败；这里只往后追加，失败的票以后不会再查，等于永久漏掉）。
      // 结果都在最后一个网络请求之后才记，重来一遍是安全的
      const judge = async () => {
        delete task.tradeDay;
        delete task.suspended;
        if (!worker.conn) await worker._connect();
        const trades = async day => (await worker.fetchDay(task.code, day.replaceAll('-', ''))).filter(tick => tick.vol > 0 && tick.time >= '09:25');
        // 个股这一天有没有成交：在涨停名单里的肯定有；否则问一次通达信
        const traded = async dayIndex => {
          if (sealed(dayIndex, code)) return true;
          const key = `${code}|${dayIndex}`;
          if (!tradedCache.has(key)) {
            suspendChecks++;
            tradedCache.set(key, await worker.hasTrades(code, days[dayIndex].replaceAll('-', '')));
          }
          return tradedCache.get(key);
        };
        // 二板日：D 之后个股第一个交易日。范围内的 D 直接取 D+1 的逐笔（没有成交就是停牌，往后找）
        let T = D + 1;
        let ticks = null;
        if (T >= startIndex) {
          ticks = await trades(days[T]);
          if (!ticks.length) { ticks = null; T++; }
        }
        if (!ticks) while (T < days.length && !(await traded(T))) T++;
        if (T >= days.length || days[T] < start || days[T] > end) return; // 还在停牌，或二板日不在范围内
        task.tradeDay = days[T];
        if (T > D + 1) task.suspended = true;
        if (!ticks) ticks = await trades(task.tradeDay);
        if (!ticks.length) throw new Error('二板日没有逐笔成交');
        const signalTicks = await trades(task.signal);
        if (!signalTicks.length) throw new Error('首板日没有逐笔成交');
        // 逐笔是原始价：首板日最后一笔就是收盘价，二板日涨停价 = 收盘价 × 1.1
        const limit = round2(signalTicks.at(-1).price * (1 + LIMIT_RATIO));
        // 首板：D 的上一个个股交易日不能涨停（D-1 没封已经筛过；之前涨停过的才可能是停牌跨过 D-1，放到买得到之后再查）
        const notFirstBoard = async () => {
          if (!((firstSeal.get(code) ?? Infinity) < D - 1)) return false;
          let j = D - 1;
          while (j >= 0 && j >= D - 250 && !(await traded(j))) j--;
          return j >= 0 && j < D - 1 && sealed(j, code);
        };
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
          const early = buy.time <= LATEST_TOUCH;
          const notFirstBoardCase = early && await notFirstBoard(); // 最后一个网络请求，下面只记结果
          touched++;
          if (early) {
            if (notFirstBoardCase) notFirst.push(task);
            else {
              if (task.suspended) suspendedCases++;
              results.push({ ...task, firstTouch: buy.time, openAtLimit });
            }
          }
        }
      };
      for (let attempt = 1; ; attempt++) {
        try {
          await judge();
          break;
        } catch (error) {
          const network = /no server|ECONN|socket|timeout|closed/i.test(error.message);
          if (network) {
            worker.close();
            worker.conn = null;
            worker.idx++;
          }
          if (network && attempt < 4) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            continue;
          }
          failures.push({ ...task, network, error: error.message });
          break;
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
  console.log(`按个股交易日判断停牌，问了通达信 ${suspendChecks} 次；首板后停牌、复牌日买入的 ${suspendedCases} 条；停牌前已涨停、不算首板的 ${notFirst.length} 条`);
  notFirst.slice(0, 8).forEach(item => console.log(`  不算首板 ${item.signal} ${item.code} ${item.name}`));

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
  const networkFailures = failures.filter(item => item.network);
  // 这里只往后追加，网络失败的票以后不会自动再查：要提醒人工用 --replace 重查这段日期
  if (networkFailures.length) console.log(`!!! 一进二逐笔判断有 ${networkFailures.length} 只重试 4 次仍是网络错误（${networkFailures.slice(0, 3).map(item => `${item.signal} ${item.name}`).join('、')}），可能漏样本，用 --replace 重查`);
}

main().catch(error => {
  console.error(`生成一进二用例失败: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
