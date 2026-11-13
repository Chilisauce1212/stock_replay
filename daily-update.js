#!/usr/bin/env node
'use strict';

// 每日复盘全自动更新。从交易日 T(X) 15:00 到 T(X+1) 15:00 之前（含周末、节假日）运行，都更新到 T(X)：
//   1. 今日首板（turnover_json.js --today，含连板股票、自由流通市值、新闻判断）
//   2. T(X) 所在年份的一进二回测：追加 → 每日复盘 / 连板股票同步 → 小于 30 元 → 盈亏 → 新闻判断 → 写入每日复盘
//      （turnover_json.js 起始 结束，见 review-pipeline.js）；1 月份同时处理上一年的文件（12 月末的票要到 1 月才算得出盈亏）
//   3. T(X) 所在年份的二进三回测（erjinsan-cases.js --min-boards 2 → pnl.js → 上传；二板一字、三板 10:30 前打板，暂不做新闻判断）；1 月同时处理上一年
//   4. 连板情绪周期（limit-up-cycle.js，配了 R2 时 --upload）
//   5. 新闻事件归题材（theme-events.js，关思考，T(X) 当天的首板调用一次，缺的新闻先补）
//   6. 新闻日历（news-calendar.js，配了 R2 时 --upload）；中间让模型判断当天的题材分化（theme-divergence-llm.js，几分钱）
//   7. 删除 R2 上 30 天前的覆盖备份（backups/）
//   自由流通市值在 1、2 两步里各跑一次（free-float.js，问财 WENCAI_DEBUG_PORT=9223）；失败不会让汇总变 ✗，要看日志里的 !!! 和
//   「后续步骤有 N 项失败」，补跑 npm run free-float -- --today --upload 和 npm run free-float -- --upload
//   涨停原因佐证（theme-evidence.js）2026-11-06 起不再每天跑，要看可以手动跑
// 默认读写 R2（本地 daily-review/ 同步一份）；--local 强制只用本地文件，不读写 R2。
// 新闻判断要调用大模型超过 100 只时会先询问，--yes 不询问直接调用。
//
// 用法: npm run daily-update -- [--local] [--yes]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const options = { local: false, yes: false };
for (const argument of process.argv.slice(2)) {
  if (argument === '--local') options.local = true;
  else if (argument === '--yes' || argument === '-y') options.yes = true;
  else if (argument === '--help' || argument === '-h') options.help = true;
  else throw new Error(`未知参数: ${argument}`);
}
// 必须在加载 r2-storage 之前设置，子进程也会继承
if (options.local) process.env.FORCE_LOCAL = 'true';

require('dotenv').config({ quiet: true });
const { r2Client, listJsonKeys, pruneBackups, writeJson } = require('./r2-storage');
const { latestClosedTradeDay } = require('./limit-up-list');

const ROOT = __dirname;
const CASE_FILE = /^一进二回测_(\d{8})_(\d{8})\.json$/;

function runTurnover(args) {
  console.log(`\n========== node turnover_json.js ${args.join(' ')} ==========`);
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'turnover_json.js'), ...args], { stdio: 'inherit', cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

// 某一年的回测文件名区间：本地或 R2 已有就沿用（如 20260106_20261231），没有就新建 当年0101_当年1231
async function rangeOfYear(year) {
  const names = fs.readdirSync(path.join(ROOT, 'test-cases'));
  if (r2Client) names.push(...(await listJsonKeys('test-cases/')).map(key => key.slice('test-cases/'.length)));
  const match = names.map(name => CASE_FILE.exec(name)).find(item => item && item[1].startsWith(year) && item[2].startsWith(year));
  return match ? [match[1], match[2]] : [`${year}0101`, `${year}1231`];
}

// 某一年的二进三回测文件名：本地已有就沿用（如 二进三回测_20260105_20261231），没有就新建 二进三回测_当年0101_当年1231
function erjinsanFileOfYear(year) {
  const match = fs.readdirSync(path.join(ROOT, 'daily-review'))
    .map(name => /^(二进三回测_(\d{8})_(\d{8}))\.json$/.exec(name))
    .find(item => item && item[2].startsWith(year) && item[3].startsWith(year));
  return match ? match[1] : `二进三回测_${year}0101_${year}1231`;
}

async function main() {
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 15).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const { date } = await latestClosedTradeDay();
  console.log(`更新到交易日 ${date}，${r2Client ? '读写 R2（本地同步一份）' : '只用本地文件'}`);

  const results = [];
  results.push(['今日首板', runTurnover(['--today', ...(options.yes ? ['--yes'] : [])])]);
  const year = Number(date.slice(0, 4));
  const years = date.slice(5, 7) === '01' ? [year - 1, year] : [year];
  for (const item of years) {
    const [start, end] = await rangeOfYear(String(item));
    results.push([`一进二回测_${start}_${end}`, runTurnover([start, end, ...(options.yes ? ['--yes'] : [])])]);
  }
  // 二进三回测（2026-11-13 用户要求加入流程）：重新生成当年样本（已有记录的 pnl 保留）→ 补算盈亏 → 上传；1 月同时处理上一年
  for (const item of years) {
    const file = erjinsanFileOfYear(String(item));
    try {
      console.log(`\n========== node erjinsan-cases.js ${item}（${file}）==========`);
      execFileSync(process.execPath, [path.join(ROOT, 'erjinsan-cases.js'), '--start', `${item}0101`, '--end', `${item}1231`, '--min-boards', '2', '--out', file], { stdio: 'inherit', cwd: ROOT });
      execFileSync(process.execPath, [path.join(ROOT, 'pnl.js'), file], { stdio: 'inherit', cwd: ROOT });
      if (r2Client) {
        const records = JSON.parse(fs.readFileSync(path.join(ROOT, 'daily-review', `${file}.json`), 'utf8'));
        await writeJson(`daily-review/${file}.json`, records);
        console.log(`  已更新 R2 daily-review/${file}.json（${records.length} 条）`);
      }
      results.push([file, true]);
    } catch (error) {
      console.error(`!!! ${file} 失败: ${error.message}`);
      results.push([file, false]);
    }
  }
  try {
    console.log('\n========== node limit-up-cycle.js ==========');
    execFileSync(process.execPath, [path.join(ROOT, 'limit-up-cycle.js'), ...(r2Client ? ['--upload'] : [])], { stdio: 'inherit', cwd: ROOT });
    results.push(['连板情绪周期', true]);
  } catch {
    results.push(['连板情绪周期', false]);
  }
  // 涨停原因佐证（theme-evidence.js）2026-11-06 起不再每天跑：题材改为只按新闻归，不参考涨停原因
  try {
    // 先补当天首板的 5 个交易日新闻再调用模型；题材名沿用前面几天的词表
    console.log('\n========== node theme-events.js ==========');
    execFileSync(process.execPath, [path.join(ROOT, 'theme-events.js'), '--start', date, '--end', date], { stdio: 'inherit', cwd: ROOT });
    results.push(['新闻事件归题材', true]);
  } catch {
    results.push(['新闻事件归题材', false]);
  }
  try {
    // 先生成一次日历（分化判断的输入来自日历月份文件），再让模型判断当天的题材分化，最后重新生成并上传
    console.log('\n========== node news-calendar.js ==========');
    execFileSync(process.execPath, [path.join(ROOT, 'news-calendar.js'), '--fill-ticks'], { stdio: 'inherit', cwd: ROOT });
    try {
      console.log('\n========== node theme-divergence-llm.js ==========');
      execFileSync(process.execPath, [path.join(ROOT, 'theme-divergence-llm.js'), '--start', date, '--end', date], { stdio: 'inherit', cwd: ROOT });
      results.push(['题材分化判断', true]);
    } catch {
      results.push(['题材分化判断', false]);
    }
    execFileSync(process.execPath, [path.join(ROOT, 'news-calendar.js'), ...(r2Client ? ['--upload'] : [])], { stdio: 'inherit', cwd: ROOT });
    results.push(['新闻日历', true]);
  } catch {
    results.push(['新闻日历', false]);
  }
  if (r2Client) {
    try {
      results.push([`清理 30 天前的 R2 备份（${await pruneBackups(30)} 个）`, true]);
    } catch (error) {
      console.error(`清理 R2 备份失败: ${error.message}`);
      results.push(['清理 R2 备份', false]);
    }
  }

  console.log(`\n========== 每日更新完成（${date}）==========`);
  for (const [label, ok] of results) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (results.some(([, ok]) => !ok)) {
    console.log('有步骤失败，往上翻看 !!! 开头的错误；修好后重跑同一命令即可，已完成的会跳过');
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`每日更新失败: ${error.message}`);
  process.exitCode = 1;
});
