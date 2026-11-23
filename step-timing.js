'use strict';

// 每日更新的分步计时（2026-11-23 加：那天首板 102 只，平时 20 只左右，跑了一个多小时，日志里看不出慢在哪一步）。
// daily-update.js 设好 STEP_TIMING_FILE（reports/timing/每日更新-YYYYMMDD.jsonl）和 STEP_TIMING_RUN（本次运行的开始时间）；
// 子进程继承环境变量，往同一个文件追加，一行一条记录：{ run, path, start, ms, ok, items?, unit? }。
// STEP_TIMING_PATH 是当前所在的步骤（如「今日首板 › 新闻判断」）：timeStep 执行期间设好，子进程的记录挂在它下面。
// 步骤是一步一步跑的，不支持并行的 timeStep。没设 STEP_TIMING_FILE 时只打印、不记录（单独跑脚本时）。
const fs = require('fs');
const path = require('path');

const SEP = ' › ';
const clock = (date = new Date()) => date.toTimeString().slice(0, 8);

function formatMs(ms) {
  if (ms < 10e3) return `${(ms / 1000).toFixed(1)} 秒`;
  if (ms < 60e3) return `${Math.round(ms / 1000)} 秒`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

function record(entry) {
  const file = process.env.STEP_TIMING_FILE;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ run: process.env.STEP_TIMING_RUN || '', ...entry })}\n`);
  } catch (error) {
    console.error(`计时记录写入失败（不影响更新）：${error.message}`);
  }
}

// 计时执行 fn（同步或异步都行，返回 fn 的结果；出错照样记下用时再抛出）。
// options.items / options.unit：处理了多少个什么（如 102 只），汇总里算每个多少秒；也可以在 fn 里返回后用 recordPhase 补
function timeStep(label, fn, options = {}) {
  const parent = process.env.STEP_TIMING_PATH || '';
  const full = parent ? `${parent}${SEP}${label}` : label;
  const startedAt = new Date();
  process.env.STEP_TIMING_PATH = full;
  const finish = ok => {
    if (parent) process.env.STEP_TIMING_PATH = parent;
    else delete process.env.STEP_TIMING_PATH;
    const ms = Date.now() - startedAt.getTime();
    console.log(`[${clock()}] ${ok ? '■' : '✗'} ${full} 用时 ${formatMs(ms)}（${clock(startedAt)} 开始）`);
    record({ path: full, start: startedAt.toISOString(), ms, ok, ...(options.items != null && { items: options.items, unit: options.unit || '个' }) });
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    finish(false);
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then(value => { finish(true); return value; }, error => { finish(false); throw error; });
  }
  finish(true);
  return result;
}

// 进程内某一段的用时（不包函数时用，如 news-llm 的抓正文、调用模型）
function recordPhase(label, ms, { items, unit = '个', startedAt } = {}) {
  const parent = process.env.STEP_TIMING_PATH || '';
  const full = parent ? `${parent}${SEP}${label}` : label;
  console.log(`[${clock()}] ■ ${full} 用时 ${formatMs(ms)}${items != null ? `（${items} ${unit}）` : ''}`);
  record({ path: full, start: (startedAt || new Date(Date.now() - ms)).toISOString(), ms, ok: true, ...(items != null && { items, unit }) });
}

function readRuns(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// 同目录里比 file 早的最近一次完整运行（取那个文件最后一个 run），给汇总的「上次」列
function previousRun(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  if (!fs.existsSync(dir)) return [];
  const older = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl') && name < base).sort();
  for (const name of older.reverse()) {
    const rows = readRuns(path.join(dir, name));
    const last = rows.at(-1)?.run;
    if (last) return rows.filter(row => row.run === last);
  }
  return [];
}

// 打印本次运行的分步用时（按开始时间、缩进表示层级），最后一行「耗时最多：…」给 run-coordinator 的推送摘要用
function printSummary(file = process.env.STEP_TIMING_FILE, run = process.env.STEP_TIMING_RUN) {
  if (!file) return;
  const rows = readRuns(file).filter(row => row.run === run).sort((a, b) => a.start.localeCompare(b.start) || a.path.split(SEP).length - b.path.split(SEP).length);
  if (!rows.length) return;
  const before = new Map(previousRun(file).map(row => [row.path, row.ms]));
  const total = rows.filter(row => !row.path.includes(SEP)).reduce((sum, row) => sum + row.ms, 0);
  console.log(`\n========== 分步用时（合计 ${formatMs(total)}，记录在 ${path.relative(process.cwd(), file)}）==========`);
  // 按层级排：每一层按开始时间，子步骤紧跟在父步骤下面
  const parentOf = row => row.path.split(SEP).slice(0, -1).join(SEP);
  const ordered = [];
  const visit = parent => rows.filter(row => parentOf(row) === parent).forEach(row => { ordered.push(row); visit(row.path); });
  visit('');
  // 父步骤没记录的（如单独跑 turnover_json.js 时）也要列出来
  for (const row of rows) if (!ordered.includes(row)) ordered.push(row);
  for (const row of ordered) {
    const depth = row.path.split(SEP).length - 1;
    const name = row.path.split(SEP).at(-1);
    const share = total ? `${Math.round((row.ms / total) * 100)}%` : '';
    const rate = row.items ? `，${row.items} ${row.unit}，每${row.unit} ${(row.ms / 1000 / row.items).toFixed(1)} 秒` : '';
    const last = before.has(row.path) ? `，上次 ${formatMs(before.get(row.path))}` : '';
    console.log(`  ${'  '.repeat(depth)}${row.ok ? '' : '✗ '}${name}：${formatMs(row.ms)}（${share}${rate}${last}）`);
  }
  // 最慢的「叶子」步骤（下面没有子步骤的），才是真正花时间的地方
  const leaves = rows.filter(row => !rows.some(other => other.path.startsWith(row.path + SEP)));
  const slowest = leaves.reduce((a, b) => (b.ms > a.ms ? b : a));
  console.log(`耗时最多：${slowest.path} ${formatMs(slowest.ms)}${slowest.items ? `（${slowest.items} ${slowest.unit}）` : ''}`);
}

module.exports = { timeStep, recordPhase, printSummary, formatMs };
