require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { r2Client, readJson, writeJson } = require('./r2-storage');
const { latestClosedTradeDay, updateLimitUpList } = require('./limit-up-list');
const { finishReviewFile } = require('./review-pipeline');

const DAILY_REVIEW_DIR = path.join(__dirname, 'daily-review');
const TEST_CASE_DIR = path.join(__dirname, 'test-cases');

function parseDate(dateString) {
  const value = String(dateString).trim();
  if (!/^\d{8}$/.test(value)) throw new Error(`日期必须是 YYYYMMDD: ${dateString}`);
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
  if (Number.isNaN(date.getTime())) throw new Error(`无效日期: ${dateString}`);
  return date;
}

function formatDate(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

// 北京时间的今天（UTC 零点表示）
function today() {
  const beijing = new Date(Date.now() + 8 * 3600_000);
  return new Date(Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate()));
}

async function loadJson(filename) {
  const isDailyReview = path.basename(filename) === '今日首板.json';
  const prefix = isDailyReview ? 'daily-review' : 'test-cases';
  let data;
  if (r2Client) {
    try {
      data = await readJson(`${prefix}/${path.basename(filename)}`);
    } catch (error) {
      if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
      return [];
    }
  } else {
    if (!fs.existsSync(filename)) return [];
    data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  }
  if (!Array.isArray(data)) throw new Error('JSON 根节点必须是数组');
  return data;
}

function saveLocalJson(records, filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filename);
}

async function saveJson(records, filename, { alsoLocal = false, allowShrink = false } = {}) {
  if (r2Client) {
    const prefix = path.basename(filename) === '今日首板.json' ? 'daily-review' : 'test-cases';
    await writeJson(`${prefix}/${path.basename(filename)}`, records, { allowShrink });
    if (alsoLocal) saveLocalJson(records, filename);
    return;
  }
  saveLocalJson(records, filename);
}

// 每日复盘页面读 daily-review/ 下的同名文件（带 npm run pnl 预计算的 pnl 字段），回测数据写在 test-cases/。
// 追加完回测数据后，把新记录合并进 daily-review/ 的同名文件：原有记录和 pnl 不动，只追加没有的。
// 配了 R2 时更新 R2，本地 daily-review/ 已有该文件时一并更新（npm run pnl 读本地）；没配 R2 时只写本地。
async function syncDailyReviewCopy(records, filename) {
  const name = path.basename(filename);
  const merge = existing => {
    const known = new Set(existing.map(item => `${item.marketCode}|${item.date}`));
    const added = records.filter(item => !known.has(`${item.marketCode}|${item.date}`));
    return { merged: existing.concat(added), added: added.length };
  };
  if (r2Client) {
    let existing = [];
    try {
      existing = await readJson(`daily-review/${name}`);
    } catch (error) {
      if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
    }
    if (!Array.isArray(existing)) throw new Error(`R2 daily-review/${name} 根节点不是数组，未同步`);
    const { merged, added } = merge(existing);
    if (added) await writeJson(`daily-review/${name}`, merged);
    console.log(`每日复盘 R2 daily-review/${name}：追加 ${added} 条，共 ${merged.length} 条`);
  }
  const localPath = path.join(DAILY_REVIEW_DIR, name);
  if (!r2Client || fs.existsSync(localPath)) {
    const existing = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : [];
    const { merged, added } = merge(existing);
    if (added) saveLocalJson(merged, localPath);
    console.log(`每日复盘本地 daily-review/${name}：追加 ${added} 条，共 ${merged.length} 条`);
  }
}

// 每日复盘页面的「连板股票」按回测日读 daily-review/连板股票.json：补上这些回测日（从全市场涨停名单生成），再更新 R2
async function syncChainStocks(records) {
  const dates = [...new Set(records.map(item => item.date).filter(Boolean))].sort();
  if (!dates.length) return;
  execFileSync(process.execPath, [path.join(__dirname, 'chain-stocks.js'), ...dates], { stdio: 'inherit' });
  const localPath = path.join(DAILY_REVIEW_DIR, '连板股票.json');
  if (r2Client && fs.existsSync(localPath)) {
    await writeJson('daily-review/连板股票.json', JSON.parse(fs.readFileSync(localPath, 'utf8')));
    console.log('连板股票已更新到 R2 daily-review/连板股票.json');
  }
}

async function run(startArgument, endArgument, { followUp = true, yes = false } = {}) {
  const startText = String(startArgument).trim();
  const endText = String(endArgument).trim();
  let startDate = parseDate(startText);
  let endDate = parseDate(endText);
  const currentDate = today();
  if (endDate > currentDate) {
    console.log(`指定结束日期 ${endText} 晚于今天，实际查询截止日期调整为 ${formatDate(currentDate)}。`);
    endDate = currentDate;
  }
  const filename = path.join(TEST_CASE_DIR, `一进二回测_${startText}_${endText}.json`);
  const storageTarget = r2Client
    ? `R2 对象 test-cases/${path.basename(filename)}`
    : `本地文件 ${filename}`;
  console.log(`>>> 数据存储位置: ${storageTarget}`);
  let records = await loadJson(filename);
  if (records.length) {
    const dates = records.filter(item => item.date).map(item => new Date(`${item.date}T00:00:00Z`));
    const lastDate = new Date(Math.max(...dates));
    startDate = new Date(Math.max(startDate.getTime(), addDays(lastDate, 1).getTime()));
    console.log(`检测到已有文件，最后日期为 ${lastDate.toISOString().slice(0, 10)}，将从 ${formatDate(startDate)} 继续。`);
  } else if (r2Client) {
    console.log(`R2 中未检测到对象 test-cases/${path.basename(filename)}，将创建该对象。`);
  } else {
    console.log(`本地未检测到同名 JSON，将创建文件: ${filename}`);
  }
  if (startDate > endDate) {
    console.log('已有数据已经覆盖指定日期范围，无需追加。');
    if (records.length) {
      await syncDailyReviewCopy(records, filename);
      await syncChainStocks(records);
      if (followUp) return finishReviewFile(startText, endText, { yes });
    }
    return [];
  }

  // 不再用问财问句：「T日10点30前达到过T日涨停价」被问财解析成 10:30 那一分钟的最高价，早盘触板后开板的票会漏掉。
  // 改由 yijiner-cases.js 用全市场涨停名单 + 逐笔成交判断，它在本地文件上追加，所以先把已有记录写到本地。
  if (records.length) saveLocalJson(records, filename);
  console.log('\n>>> 任务开始：yijiner-cases.js 按逐笔成交判断二板日 10:30 前是否在涨停价成交过');
  execFileSync(process.execPath, [path.join(__dirname, 'yijiner-cases.js'), '--start', startText, '--end', endText], { stdio: 'inherit' });
  records = JSON.parse(fs.readFileSync(filename, 'utf8'));
  await saveJson(records, filename);
  console.log(`\n>>> 回测追加完成: ${filename}`);
  await syncDailyReviewCopy(records, filename);
  await syncChainStocks(records);
  return followUp ? finishReviewFile(startText, endText, { yes }) : [];
}

// 今日首板：最近一个已收盘交易日 T(X) 收盘封死涨停、前一交易日没有封死涨停、主板、非 ST（和问财「涨停」同口径）。
// 从 T(X) 15:00 到 T(X+1) 15:00 之前运行（含周末、节假日）都生成 T(X) 的首板；数据来自全市场涨停名单（同花顺涨停池）。
async function runTodayFirstBoard() {
  const { date } = await latestClosedTradeDay();
  const months = await updateLimitUpList(date);
  const byDay = new Map();
  for (const item of Object.values(months).flat()) {
    if (!byDay.has(item.date)) byDay.set(item.date, new Map());
    byDay.get(item.date).set(item.code, item);
  }
  const days = [...byDay.keys()].sort();
  const index = days.indexOf(date);
  if (index < 1) throw new Error(`涨停名单里没有 ${date} 或它的前一交易日`);
  const previous = byDay.get(days[index - 1]);
  const dateString = date.replaceAll('-', '');
  const records = [...byDay.get(date).values()]
    .filter(item => /^(60|00)/.test(item.code) && !/ST/i.test(item.name) && !previous.has(item.code))
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((item, position) => {
      const marketCode = `${item.code}.${item.code.startsWith('6') ? 'SH' : 'SZ'}`;
      return { id: `${position}-${dateString}-${marketCode}`, date, code: item.code, marketCode, stockName: item.name };
    });
  const filename = path.join(DAILY_REVIEW_DIR, '今日首板.json');
  await saveJson(records, filename, { alsoLocal: true, allowShrink: true });
  console.log(`>>> 今日首板（${date}）：${records.length} 只，已覆盖 ${r2Client ? 'R2 daily-review/今日首板.json 和本地' : '本地'} ${path.relative(__dirname, filename)}`);
}

// 用法: node turnover_json.js 起始 结束 [--only-cases] [--yes]
//   追加回测后接着跑小于 30 元、盈亏、新闻判断、写入每日复盘（见 review-pipeline.js）；--only-cases 只追加回测和同步
//   --yes：新闻判断要调用大模型超过 100 只时不询问
// 今日首板: node turnover_json.js --today
const flags = process.argv.slice(2).filter(argument => argument.startsWith('--'));
const [start, end] = process.argv.slice(2).filter(argument => !argument.startsWith('--'));
if (flags.includes('--today')) {
  runTodayFirstBoard().catch(error => {
    console.error(`今日首板生成失败: ${error.message}`);
    process.exitCode = 1;
  });
} else if (!start || !end) {
  console.error('用法: node turnover_json.js YYYYMMDD YYYYMMDD [--only-cases] [--yes]');
  console.error('今日首板: node turnover_json.js --today');
  process.exitCode = 1;
} else {
  run(start, end, { followUp: !flags.includes('--only-cases'), yes: flags.includes('--yes') })
    .then(failures => { if (failures.length) process.exitCode = 1; })
    .catch(error => { console.error(`输入或执行失败: ${error.message}`); process.exitCode = 1; });
}
