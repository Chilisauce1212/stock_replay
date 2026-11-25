#!/usr/bin/env node
'use strict';

// 每日复盘全自动更新。从交易日 T(X) 15:00 到 T(X+1) 15:00 之前（含周末、节假日）运行，都更新到 T(X)：
//   1. 今日首板（turnover_json.js --today，含连板股票、自由流通市值、新闻判断）
//   2. T(X) 所在年份的一进二回测：追加 → 每日复盘 / 连板股票同步 → 小于 30 元 → 盈亏 → 新闻判断 → 写入每日复盘
//      （turnover_json.js 起始 结束，见 review-pipeline.js）；1 月份同时处理上一年的文件（12 月末的票要到 1 月才算得出盈亏）
//   2b. 四连板及以上（extract-price-cases.js --recent-days 40 → pnl.js → review-judge.js → 上传，只重查最近 40 天的首板）
//   3. T(X) 所在年份的二进三回测（erjinsan-cases.js --min-boards 2 → pnl.js → 上传；二板一字、三板 10:30 前打板，暂不做新闻判断）；1 月同时处理上一年
//   3b. 二进三五连板及以上：从各年二进三回测里筛 ≥5 板（不再查逐笔）→ 上传
//   4. 可转债名单（convertible-bonds.js，复盘页「有转债只能空仓」用）→ 连板情绪周期（limit-up-cycle.js，配了 R2 时 --upload）
//   5. 新闻事件归题材（theme-events.js，关思考，T(X) 当天的首板调用一次，缺的新闻先补）
//   6. 新闻日历（news-calendar.js，配了 R2 时 --upload）；中间让模型判断当天的题材分化（theme-divergence-llm.js，几分钱）
//   7. 删除 R2 上 30 天前的覆盖备份（backups/）
//   自由流通市值在 1、2 两步里各跑一次（free-float.js，问财默认 headless + reports/wencai-state.json 登录状态，过期用 npm run wencai-login 重新导出）；失败不会让汇总变 ✗，要看日志里的 !!! 和
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
const { timeStep, printSummary } = require('./step-timing');

const ROOT = __dirname;
const CASE_FILE = /^一进二回测_(\d{8})_(\d{8})\.json$/;

// 每一大步：带时间的标题 + 计时（见 step-timing.js），子进程里的分步记录挂在 label 下面
function runNode(label, script, args) {
  console.log(`\n========== [${new Date().toTimeString().slice(0, 8)}] node ${script} ${args.join(' ')} ==========`);
  timeStep(label, () => execFileSync(process.execPath, [path.join(ROOT, script), ...args], { stdio: 'inherit', cwd: ROOT }));
}

function runTurnover(label, args) {
  try {
    runNode(label, 'turnover_json.js', args);
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
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 17).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const { date } = await latestClosedTradeDay();
  // 分步计时记录：reports/timing/每日更新-YYYYMMDD.jsonl，同一天重跑追加，按 STEP_TIMING_RUN 区分
  process.env.STEP_TIMING_FILE = path.join(ROOT, 'reports', 'timing', `每日更新-${date.replace(/-/g, '')}.jsonl`);
  process.env.STEP_TIMING_RUN = new Date().toISOString();
  console.log(`更新到交易日 ${date}，${r2Client ? '读写 R2（本地同步一份）' : '只用本地文件'}`);

  const results = [];
  results.push(['今日首板', runTurnover('今日首板', ['--today', ...(options.yes ? ['--yes'] : [])])]);
  const year = Number(date.slice(0, 4));
  const years = date.slice(5, 7) === '01' ? [year - 1, year] : [year];
  for (const item of years) {
    const [start, end] = await rangeOfYear(String(item));
    results.push([`一进二回测_${start}_${end}`, runTurnover(`一进二回测 ${item}`, [start, end, ...(options.yes ? ['--yes'] : [])])]);
  }
  // 四连板及以上（2026-11-25 用户要求加入流程）：只重查最近 40 天首板的连板数（更早的不会再变）→ 新记录补盈亏 → 新闻判断 → 上传。
  // 新进来的记录从一进二样本带来新闻判断和自由流通市值；连板数重算后不到 4 板的会移出，所以上传允许变少，但一次少超过 10 条就当异常不传
  try {
    const fourFile = path.join(ROOT, 'daily-review', '四连板及以上.json');
    const keysOf = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []).map(item => `${item.code}|${item.date}`);
    const before = new Set(keysOf(fourFile));
    runNode('四连板及以上', 'extract-price-cases.js', ['--recent-days', '40']);
    runNode('四连板盈亏', 'pnl.js', ['四连板及以上']);
    runNode('四连板新闻判断', 'review-judge.js', ['四连板及以上']);
    try {
      // 新记录一般已从一进二带来自由流通市值，这里只补缺的（通常 0 次问财）；问财失败只记警告
      runNode('四连板自由流通市值', 'free-float.js', r2Client ? ['--upload'] : []);
    } catch {
      console.error('!!! 四连板自由流通市值没补全，运行 npm run free-float -- --upload');
    }
    const records = JSON.parse(fs.readFileSync(fourFile, 'utf8'));
    const after = new Set(records.map(item => `${item.code}|${item.date}`));
    const added = records.filter(item => !before.has(`${item.code}|${item.date}`));
    const removed = [...before].filter(key => !after.has(key));
    console.log(`四连板及以上 ${records.length} 条；新增 ${added.length}：${added.map(item => `${item.stockName}(${item.date})`).join('、') || '无'}；移出 ${removed.length}：${removed.join('、') || '无'}`);
    if (removed.length > 10) throw new Error(`一次移出 ${removed.length} 条，可能是行情接口出错，没上传；确认无误后运行 npm run upload`);
    if (r2Client) {
      await writeJson('daily-review/四连板及以上.json', records, { allowShrink: removed.length > 0 });
      console.log(`  已更新 R2 daily-review/四连板及以上.json（${records.length} 条）`);
    }
    results.push(['四连板及以上', true]);
  } catch (error) {
    console.error(`!!! 四连板及以上失败: ${error.message}`);
    results.push(['四连板及以上', false]);
  }
  // 二进三回测（2026-11-13 用户要求加入流程）：重新生成当年样本（已有记录的 pnl 保留）→ 补算盈亏 → 上传；1 月同时处理上一年
  for (const item of years) {
    const file = erjinsanFileOfYear(String(item));
    try {
      runNode(`二进三回测 ${item}`, 'erjinsan-cases.js', ['--start', `${item}0101`, '--end', `${item}1231`, '--min-boards', '2', '--out', file]);
      runNode(`二进三盈亏 ${item}`, 'pnl.js', [file]);
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
  // 二进三五连板及以上（2026-11-25 用户要求加入流程）：规则和二进三回测相同、只多了「最终 ≥5 板」，
  // 所以直接从各年 二进三回测_*.json 里筛 boardCount ≥ 5（2026-11-25 核对过和 erjinsan-cases.js --min-boards 5 的 57 条完全一致），不再查逐笔；
  // 已有记录的其他字段（judge 等）保留。一次移出超过 3 条当成异常不写（板数只会变多，正常不会移出）
  try {
    const reviewDir = path.join(ROOT, 'daily-review');
    const sources = fs.readdirSync(reviewDir).filter(name => /^二进三回测_\d{8}_\d{8}\.json$/.test(name));
    if (sources.length < 3) throw new Error(`本地只有 ${sources.length} 个二进三回测文件（应有 2024 起每年一个），没更新`);
    const fiveFile = path.join(reviewDir, '二进三五连板及以上.json');
    const oldFive = fs.existsSync(fiveFile) ? JSON.parse(fs.readFileSync(fiveFile, 'utf8')) : [];
    const keyOf = item => `${item.code}|${item.date}`;
    const oldByKey = new Map(oldFive.map(item => [keyOf(item), item]));
    const five = sources.flatMap(name => JSON.parse(fs.readFileSync(path.join(reviewDir, name), 'utf8')))
      .filter(item => item.boardCount >= 5)
      .map(item => ({ ...oldByKey.get(keyOf(item)), ...item }))
      .sort((left, right) => left.date.localeCompare(right.date) || left.code.localeCompare(right.code))
      // id 前缀是文件里的序号（同 erjinsan-cases.js），按新顺序重编
      .map((item, index) => ({ ...item, id: item.id.replace(/^\d+-/, `${index}-`) }));
    const fiveKeys = new Set(five.map(keyOf));
    const added = five.filter(item => !oldByKey.has(keyOf(item)));
    const removed = oldFive.filter(item => !fiveKeys.has(keyOf(item)));
    console.log(`\n二进三五连板及以上 ${five.length} 条；新增 ${added.length}：${added.map(item => `${item.stockName}(${item.date}，${item.boardCount} 板)`).join('、') || '无'}；移出 ${removed.length}：${removed.map(keyOf).join('、') || '无'}`);
    if (removed.length > 3) throw new Error(`一次移出 ${removed.length} 条，没写入；确认无误后手动更新`);
    fs.writeFileSync(fiveFile, `${JSON.stringify(five, null, 2)}\n`, 'utf8');
    if (r2Client) {
      await writeJson('daily-review/二进三五连板及以上.json', five, { allowShrink: removed.length > 0 });
      console.log('  已更新 R2 daily-review/二进三五连板及以上.json');
    }
    results.push(['二进三五连板及以上', true]);
  } catch (error) {
    console.error(`!!! 二进三五连板及以上失败: ${error.message}`);
    results.push(['二进三五连板及以上', false]);
  }
  try {
    // 可转债名单（复盘页「有转债只能空仓」用），全量重取，3 次请求
    runNode('可转债名单', 'convertible-bonds.js', r2Client ? ['--upload'] : []);
    results.push(['可转债名单', true]);
  } catch {
    results.push(['可转债名单', false]);
  }
  try {
    runNode('连板情绪周期', 'limit-up-cycle.js', r2Client ? ['--upload'] : []);
    results.push(['连板情绪周期', true]);
  } catch {
    results.push(['连板情绪周期', false]);
  }
  // 涨停原因佐证（theme-evidence.js）2026-11-06 起不再每天跑：题材改为只按新闻归，不参考涨停原因
  try {
    // 先补当天首板的 5 个交易日新闻再调用模型；题材名沿用前面几天的词表
    runNode('新闻事件归题材', 'theme-events.js', ['--start', date, '--end', date]);
    results.push(['新闻事件归题材', true]);
  } catch {
    results.push(['新闻事件归题材', false]);
  }
  try {
    // 先生成一次日历（分化判断的输入来自日历月份文件），再让模型判断当天的题材分化，最后重新生成并上传
    runNode('新闻日历（补分笔）', 'news-calendar.js', ['--fill-ticks']);
    try {
      runNode('题材分化判断', 'theme-divergence-llm.js', ['--start', date, '--end', date]);
      results.push(['题材分化判断', true]);
    } catch {
      results.push(['题材分化判断', false]);
    }
    runNode('新闻日历（生成上传）', 'news-calendar.js', r2Client ? ['--upload'] : []);
    results.push(['新闻日历', true]);
  } catch {
    results.push(['新闻日历', false]);
  }
  if (r2Client) {
    try {
      results.push([`清理 30 天前的 R2 备份（${await timeStep('清理 R2 备份', () => pruneBackups(30))} 个）`, true]);
    } catch (error) {
      console.error(`清理 R2 备份失败: ${error.message}`);
      results.push(['清理 R2 备份', false]);
    }
  }

  console.log(`\n========== 每日更新完成（${date}）==========`);
  for (const [label, ok] of results) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  printSummary();
  if (results.some(([, ok]) => !ok)) {
    console.log('有步骤失败，往上翻看 !!! 开头的错误；修好后重跑同一命令即可，已完成的会跳过');
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`每日更新失败: ${error.message}`);
  process.exitCode = 1;
});
