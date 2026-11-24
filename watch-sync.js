#!/usr/bin/env node
'use strict';

// 把同花顺自选同步给 ai-bark（2026-11-24）：盯盘和推送改由阿里云上的 ai-bark 做，这里只负责读自选。
// 之所以还要在软路由上跑：机房的 IP 连同花顺会被拒绝，读自选只能在家里做。
//   - 软路由 cron 交易日 9:14 启动（deploy/run-watch-sync.sh），15:01 自己退出
//   - 每分钟读一次自选（用 watch-alerts.js 的 fetchWatchlist，只留 A 股），POST 到 ai-bark 的 /watchsync
//   - 同花顺登录失效、快过期：照旧经 Bark 提醒一次；读不到名单时不同步，ai-bark 那边按上次的名单继续盯
//   - ai-bark 连续 5 次收不到：经 Bark 提醒一次
// .env 里要有 WATCH_SYNC_URL（https://ai.onecontext.cloud/watchsync）和 WATCH_SYNC_TOKEN（和 ai-bark 的 .env 里同一个值）。
// 想退回原来的做法（软路由自己盯、自己推送）：把 cron 里的 run-watch-sync.sh 换回 run-watch.sh。
// 用法: node watch-sync.js [--once（同步一次就退出）] [--until 15:01]
require('dotenv').config({ quiet: true });
const { fetchWatchlist, notify } = require('./watch-alerts');

const options = { once: false, until: '15:01', minutes: 1 };
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--once') options.once = true;
  else if (arg === '--until') options.until = process.argv[++index];
  else throw new Error(`不认识的参数 ${arg}`);
}

const SYNC_URL = process.env.WATCH_SYNC_URL;
const SYNC_TOKEN = process.env.WATCH_SYNC_TOKEN;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const beijing = () => new Date(Date.now() + 8 * 3600e3);
const clock = () => beijing().toISOString().slice(11, 16);
const log = message => console.log(`[${beijing().toISOString().slice(11, 19)}] ${message}`);

async function push(symbols) {
  const response = await fetch(SYNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_TOKEN}` },
    body: JSON.stringify({ symbols }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  if (!SYNC_URL || !SYNC_TOKEN) throw new Error('.env 里没有 WATCH_SYNC_URL 或 WATCH_SYNC_TOKEN');
  log(`自选同步开始：每 ${options.minutes} 分钟一次，${options.until} 结束`);
  let last = null;
  let listWarned = false;
  let pushErrors = 0;
  do {
    let symbols = null;
    try {
      symbols = await fetchWatchlist();
    } catch (error) {
      log(`!!! 读同花顺自选失败：${error.message}`);
      if (!listWarned) {
        listWarned = true;
        await notify('盯盘拿不到同花顺自选', `${error.message}。ai-bark 按上次的名单继续盯，需要重新导出登录状态`);
      }
    }
    if (symbols) {
      try {
        const result = await push(symbols);
        pushErrors = 0;
        if (symbols.join() !== last) log(`自选 A 股 ${symbols.length} 只已同步：${symbols.join(',') || '（空）'}${result.changed ? '' : '（那边没有变化）'}`);
        last = symbols.join();
      } catch (error) {
        pushErrors++;
        log(`同步到 ai-bark 失败（连续 ${pushErrors} 次）：${error.message}`);
        if (pushErrors === 5) await notify('自选同步不到智能助理', `连续 ${pushErrors} 次失败：${error.message}`);
      }
    }
    if (options.once) return;
    await sleep(options.minutes * 60e3);
  } while (clock() < options.until);
  log('收盘，自选同步结束');
}

main().catch(async error => {
  log(`!!! 自选同步崩溃：${error.stack || error.message}`);
  await notify('自选同步程序崩溃', error.message);
  process.exit(1);
});
