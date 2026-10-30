#!/usr/bin/env node
'use strict';

// 每日复盘全自动更新。从交易日 T(X) 15:00 到 T(X+1) 15:00 之前（含周末、节假日）运行，都更新到 T(X)：
//   1. 今日首板（turnover_json.js --today）
//   2. T(X) 所在年份的一进二回测：追加 → 每日复盘 / 连板股票同步 → 小于 30 元 → 盈亏 → 新闻判断 → 写入每日复盘
//      （turnover_json.js 起始 结束，见 review-pipeline.js）；1 月份同时处理上一年的文件（12 月末的票要到 1 月才算得出盈亏）
//   3. 删除 R2 上 30 天前的覆盖备份（backups/）
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
const { r2Client, listJsonKeys, pruneBackups } = require('./r2-storage');
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

async function main() {
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 13).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const { date } = await latestClosedTradeDay();
  console.log(`更新到交易日 ${date}，${r2Client ? '读写 R2（本地同步一份）' : '只用本地文件'}`);

  const results = [];
  results.push(['今日首板', runTurnover(['--today'])]);
  const year = Number(date.slice(0, 4));
  const years = date.slice(5, 7) === '01' ? [year - 1, year] : [year];
  for (const item of years) {
    const [start, end] = await rangeOfYear(String(item));
    results.push([`一进二回测_${start}_${end}`, runTurnover([start, end, ...(options.yes ? ['--yes'] : [])])]);
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
