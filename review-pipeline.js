'use strict';

// 一进二回测文件追加之后的后续步骤，turnover_json.js 跑完回测追加后调用（daily-update.js 也经由 turnover 调用）：
//   1. 小于 30 元版本（filter-under30.js，只处理这一年，收盘价有缓存，每天只查新增的）
//   2. 预计算盈亏（pnl.js，写本地 daily-review/ 的 pnl 字段，配了 R2 时合并上传）
//   3. 新闻判断：首板涨停原因（涨停池）→ 新闻和 K 线（news-theme-table.js，需要本地服务，没开会自动临时启动）
//      → 大模型（news-llm.js，要调用超过 100 只时先询问，--yes 跳过询问）
//   4. 把判断结果写进每日复盘（review-judge.js，配了 R2 时 --upload）
// 某一步失败只记下来，继续后面的步骤，最后汇总；FORCE_LOCAL=true 时全部只读写本地。
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { r2Client, isMissing, readJson, writeJson } = require('./r2-storage');

const ROOT = __dirname;
const REVIEW_DIR = path.join(ROOT, 'daily-review');
const REPORTS_DIR = path.join(ROOT, 'reports');
const NEWS_REPORT = '每日更新新闻';
// 最近几个首板日的记录每天都重新送一遍新闻判断：新闻、涨停原因有变化时重新调用，没变化走缓存不花钱
const RECENT_SIGNAL_DAYS = 3;

const recordKey = item => `${item.code}|${item.date}`;
const readLocal = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

function writeLocal(file, data) {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

function runNode(script, args) {
  console.log(`\n>>> node ${script} ${args.join(' ')}`);
  execFileSync(process.execPath, [path.join(ROOT, script), ...args], { stdio: 'inherit', cwd: ROOT });
}

async function readRemote(key) {
  try {
    return await readJson(key);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

// 以 R2 为准更新本地 daily-review 文件；R2 上没有、本地有的 pnl / judge 保留（之前算了还没上传的）
async function pullReviewFile(name) {
  const remote = await readRemote(`daily-review/${name}`);
  if (!Array.isArray(remote)) return;
  const local = new Map((readLocal(path.join(REVIEW_DIR, name)) || []).map(item => [recordKey(item), item]));
  for (const item of remote) {
    const own = local.get(recordKey(item));
    if (!own) continue;
    if (!item.pnl && own.pnl) item.pnl = own.pnl;
    if (!item.judge && own.judge) item.judge = own.judge;
  }
  writeLocal(path.join(REVIEW_DIR, name), remote);
}

// 把本地算好的 pnl 合并进 R2 的同名文件（只改 pnl 字段，不动 R2 上的其他内容）
async function pushPnl(name) {
  const remote = await readRemote(`daily-review/${name}`);
  if (!Array.isArray(remote)) throw new Error(`R2 上没有 daily-review/${name}`);
  const local = new Map((readLocal(path.join(REVIEW_DIR, name)) || []).map(item => [recordKey(item), item]));
  let changed = 0;
  for (const item of remote) {
    const pnl = local.get(recordKey(item))?.pnl;
    if (pnl && JSON.stringify(pnl) !== JSON.stringify(item.pnl)) {
      item.pnl = pnl;
      changed++;
    }
  }
  if (changed) await writeJson(`daily-review/${name}`, remote);
  console.log(`R2 daily-review/${name}：更新盈亏 ${changed} 条`);
}

// 新闻和 K 线从本地网站服务取；没开就临时启动一个，结束时关掉
async function ensureServer(baseUrl) {
  const reachable = () => fetch(baseUrl, { signal: AbortSignal.timeout(3000) }).then(response => response.ok, () => false);
  if (await reachable()) return () => {};
  console.log(`>>> ${baseUrl} 没有运行，临时启动网站服务`);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: 'ignore', env: process.env });
  for (let waited = 0; waited < 30_000; waited += 500) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (await reachable()) return () => child.kill();
  }
  child.kill();
  throw new Error('网站服务 30 秒内没有启动');
}

function newsCandidates(records) {
  const llm = readLocal(path.join(REPORTS_DIR, 'news-llm.json')) || {};
  const recentDates = [...new Set(records.map(item => item.date))].sort().slice(-RECENT_SIGNAL_DAYS);
  return records
    .filter(item => !llm[recordKey(item)] || recentDates.includes(item.date))
    .map(({ id, date, code, marketCode, stockName }) => ({ id, date, code, marketCode, stockName }));
}

async function runNews(name, { yes }) {
  const records = readLocal(path.join(REVIEW_DIR, name)) || [];
  const candidates = newsCandidates(records);
  if (!candidates.length) {
    console.log('没有需要新闻判断的记录');
    return;
  }
  const input = path.join(REPORTS_DIR, `${NEWS_REPORT}.input.json`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  writeLocal(input, candidates);
  console.log(`新闻判断 ${candidates.length} 只（没有判断过的，加最近 ${RECENT_SIGNAL_DAYS} 个首板日的）`);

  const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
  const stopServer = await ensureServer(baseUrl);
  try {
    runNode('first-board-reason.js', [input, '--max-queries', '0']);
    try {
      runNode('news-theme-table.js', ['--input', input, '--out', path.join(REPORTS_DIR, `${NEWS_REPORT}.xlsx`), '--base-url', baseUrl, '--workers', '4']);
    } catch {
      // 个别股票新闻或 K 线失败时退出码为 1，已拿到的照样往下用
      console.log('部分股票新闻或 K 线获取失败，继续用已拿到的');
    }
  } finally {
    stopServer();
  }
  runNode('news-llm.js', ['--report', NEWS_REPORT, '--workers', '4', ...(yes ? ['--yes'] : [])]);
}

async function finishReviewFile(start, end, { yes = false } = {}) {
  const name = `一进二回测_${start}_${end}.json`;
  const failures = [];
  const step = async (label, action) => {
    try {
      await action();
    } catch (error) {
      failures.push(`${label}：${error.message}`);
      console.error(`\n!!! ${label}失败：${error.message}`);
    }
  };

  await step('小于 30 元版本', () => runNode('filter-under30.js', [`${start}_${end}`]));
  await step('预计算盈亏', async () => {
    if (r2Client) await pullReviewFile(name);
    runNode('pnl.js', [`一进二回测_${start}_${end}`]);
    if (r2Client) await pushPnl(name);
  });
  await step('新闻判断', () => runNews(name, { yes }));
  await step('写入判断结果', () => runNode('review-judge.js', [`一进二回测_${start}_${end}`, ...(r2Client ? ['--upload'] : [])]));

  console.log(failures.length ? `\n后续步骤有 ${failures.length} 项失败：\n  ${failures.join('\n  ')}` : '\n后续步骤全部完成');
  return failures;
}

module.exports = { finishReviewFile };
