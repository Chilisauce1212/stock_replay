#!/usr/bin/env node
'use strict';

// 一进二选股：按 STOCK_PICK_METHOD.md 的四个条件，从首板股里选出次日（二板日）要盯的票。
// 便宜的条件先筛（主板非 ST 首板、股价、活跃度、同题材热度），最后只对剩下的票跑新闻大模型。
//
// 用法: npm run stock-pick -- --start 20260901 --end 20261030 [--name 选股候选] [--base-url http://localhost:3000]
//
// 流程（脚本会提示下一步）：
//   1. 本脚本：补齐 reports/全市场涨停原因.json（同花顺涨停池接口，近一年免费），筛出候选，写 test-cases/<name>.json
//   2. npm run first-board-reason -- test-cases/<name>.json --max-queries 0
//   3. npm run news-theme -- --input test-cases/<name>.json --out reports/<name>.xlsx
//   4. npm run news-llm -- --report <name>
//   5. 再跑一次本脚本：读入新闻结论，输出 reports/<name>.结果.json，并打印每天的选股
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { computeActivity } = require('./public/volume-pile');
const { updateLimitUpList } = require('./limit-up-list');

const REPORTS_DIR = path.join(__dirname, 'reports');
const SYNONYM_FILE = path.join(__dirname, 'theme-synonyms.json');

// 方法论里的参数，改这里即可
const RULES = {
  maxPrice: 30, // 首板收盘价上限（元）
  minVol20VsNormal: 1.27, // 近 20 日均量 / 常态量（120 日中位量）
  minSpikeDays60: 7, // 近 60 日放量（≥2 倍常态量）天数
  minPeers: 1, // 当天同题材其他涨停家数下限（排除独苗）
  maxPeers: 10, // 上限（排除挤成一窝蜂的题材）
  // 重要新闻至少有一条属于这几类；只有「政策规范」「行业利好」的不算（回测里比没新闻还差）
  strongCategories: ['新叙事', '海外/明星公司', '企业荣誉/重要会议', '资本运作转型'],
  maxPicksPerDay: 2, // 每天最多盯几只，按近 60 日放量天数从高到低取
};

function parseArgs(argv) {
  const options = { start: '', end: '', name: '选股候选', baseUrl: 'http://localhost:3000', workers: 4 };
  const toDate = value => {
    const text = String(value || '').replace(/-/g, '');
    if (!/^\d{8}$/.test(text)) throw new Error(`日期格式应为 YYYYMMDD: ${value}`);
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--start') options.start = toDate(argv[++index]);
    else if (argument === '--end') options.end = toDate(argv[++index]);
    else if (argument === '--name') options.name = String(argv[++index] || '').trim();
    else if (argument === '--base-url') options.baseUrl = argv[++index];
    else if (argument === '--workers') options.workers = Math.max(1, Number(argv[++index]) || 4);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数: ${argument}`);
  }
  if (!options.help && (!options.start || !options.end)) throw new Error('需要 --start 和 --end');
  if (!/^[^\\/:*?"<>|]+$/.test(options.name)) throw new Error('--name 不能包含路径字符');
  return options;
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function writeJson(file, data, pretty = false) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, pretty ? 2 : 0)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

// 涨停原因按「+」拆成标签，去掉泛标签，近义的归到同一题材（theme-synonyms.json）
function makeTagger() {
  const synonyms = readJson(SYNONYM_FILE, { groups: {}, ignore: [], ignorePatterns: [] });
  const toGroup = new Map();
  for (const [group, list] of Object.entries(synonyms.groups)) for (const tag of list) toGroup.set(tag, group);
  const ignore = new Set(synonyms.ignore);
  const ignorePattern = synonyms.ignorePatterns.length ? new RegExp(synonyms.ignorePatterns.join('|')) : null;
  return reason => [...new Set(String(reason || '').split(/[+＋、]/)
    .map(tag => tag.trim().replace(/概念股?$|板块$/, '').replace(/^“|”$/g, ''))
    .filter(tag => tag && !ignore.has(tag) && !(ignorePattern && ignorePattern.test(tag)))
    .map(tag => toGroup.get(tag) || tag))];
}

function buildDays(months, tagger) {
  const byDay = new Map();
  for (const list of Object.values(months)) {
    for (const item of list) {
      if (!byDay.has(item.date)) byDay.set(item.date, new Map());
      byDay.get(item.date).set(item.code, { ...item, tags: tagger(item.reason) });
    }
  }
  const days = [...byDay.keys()].sort();
  // 连板数用每天的涨停名单自己算
  days.forEach((day, index) => {
    for (const [code, item] of byDay.get(day)) {
      const previous = index > 0 && byDay.get(days[index - 1]).get(code);
      item.streak = previous ? previous.streak + 1 : 1;
    }
  });
  return { byDay, days };
}

async function fetchBars(baseUrl, code, date) {
  const url = new URL('/api/kline', baseUrl);
  url.searchParams.set('code', code);
  url.searchParams.set('cutoffDate', date);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const payload = await response.json();
      if (payload.status_code !== 0 || !Array.isArray(payload.data)) throw new Error(payload.msg || 'K 线接口返回错误');
      return payload.data.filter(bar => bar.date <= date).sort((left, right) => left.date.localeCompare(right.date));
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return [];
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

function marketCode(code) {
  return `${code}.${code.startsWith('6') ? 'SH' : 'SZ'}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 14).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');

  const months = await updateLimitUpList(options.end);
  const tagger = makeTagger();
  const { byDay, days } = buildDays(months, tagger);
  const targetDays = days.filter(day => day >= options.start && day <= options.end);
  if (!targetDays.length) throw new Error('这段日期没有涨停数据');

  // 条件 0：主板、非 ST、当天是首板
  const firstBoards = [];
  for (const day of targetDays) {
    for (const [code, item] of byDay.get(day)) {
      if (!/^(60|00)/.test(code) || /ST/i.test(item.name) || item.streak !== 1) continue;
      firstBoards.push({ day, code, item });
    }
  }
  console.log(`首板日 ${targetDays[0]} ~ ${targetDays.at(-1)}，主板非 ST 首板 ${firstBoards.length} 只，取 K 线中…`);

  // 条件 1、2：股价、活跃度（K 线）；条件 3：同题材热度（涨停名单）
  const evaluated = await mapLimit(firstBoards, options.workers, async ({ day, code, item }) => {
    const row = { key: `${code}|${day}`, date: day, code, name: item.name, reason: item.reason, tags: item.tags };
    try {
      const bars = await fetchBars(options.baseUrl, code, day);
      if (bars.at(-1)?.date !== day) throw new Error('K 线里没有首板日');
      const activity = computeActivity(bars.slice(0, -1));
      row.close = Number(bars.at(-1).close);
      row.vol20 = Number(activity.vol20VsNormal.toFixed(2));
      row.spike60 = activity.spikeDays60;
    } catch (error) {
      row.error = error.message;
    }
    const peers = [...byDay.get(day)].filter(([other, value]) => other !== code && value.tags.some(tag => item.tags.includes(tag)));
    row.peers = peers.length;
    row.peerNames = peers.slice(0, 12).map(([, value]) => `${value.name}${value.streak > 1 ? `(${value.streak}板)` : ''}`);
    row.passPrice = row.close < RULES.maxPrice;
    row.passActive = row.vol20 >= RULES.minVol20VsNormal && row.spike60 >= RULES.minSpikeDays60;
    row.passTheme = row.peers >= RULES.minPeers && row.peers <= RULES.maxPeers;
    return row;
  });
  const failed = evaluated.filter(row => row.error);
  const candidates = evaluated.filter(row => row.passPrice && row.passActive && row.passTheme);
  console.log(`股价<${RULES.maxPrice}: ${evaluated.filter(row => row.passPrice).length}，再加活跃: ${evaluated.filter(row => row.passPrice && row.passActive).length}，再加同题材 ${RULES.minPeers}-${RULES.maxPeers} 家: ${candidates.length}；K 线失败 ${failed.length}`);

  // 候选写成用例 JSON，供新闻流程使用
  const caseFile = path.join(__dirname, 'test-cases', `${options.name}.json`);
  fs.mkdirSync(path.dirname(caseFile), { recursive: true });
  writeJson(caseFile, candidates.map((row, index) => ({
    id: `${index}-${row.date.replaceAll('-', '')}-${marketCode(row.code)}`, date: row.date, code: row.code, marketCode: marketCode(row.code), stockName: row.name,
  })), true);

  // 条件 4：新闻（大模型结论）
  const llm = readJson(path.join(REPORTS_DIR, 'news-llm.json'), {});
  const missing = candidates.filter(row => !llm[row.key]);
  for (const row of candidates) {
    const entry = llm[row.key];
    if (!entry) continue;
    const important = entry.result.news.filter(news => news.important);
    row.hasNews = entry.result.hasImportantNews;
    row.newsCount = important.length;
    row.newsCategories = [...new Set(important.flatMap(news => news.categories || []))];
    row.newsTitles = important.slice(0, 3).map(news => (entry.newsIds[Number(news.id.slice(1)) - 1] || '').split('|').slice(1).join('|'));
  }
  for (const row of candidates) row.hasStrongNews = Boolean(row.hasNews && row.newsCategories.some(category => RULES.strongCategories.includes(category)));
  // 回看历史时标出次日买点：一进二回测用例里有、且竞价没有涨停开盘的才算触发（竞价涨停开盘、开板后回封的回测较差，不买）
  const testCaseDir = path.join(__dirname, 'test-cases');
  const touches = new Map(fs.readdirSync(testCaseDir)
    .filter(file => /^一进二回测_\d{8}_\d{8}\.detail\.json$/.test(file))
    .flatMap(file => readJson(path.join(testCaseDir, file), { results: [] }).results.map(item => [`${item.code}|${item.signal}`, item])));
  const reviewDir = path.join(__dirname, 'daily-review');
  const pnls = new Map((fs.existsSync(reviewDir) ? fs.readdirSync(reviewDir) : [])
    .filter(file => /^一进二回测_\d{8}_\d{8}\.json$/.test(file))
    .flatMap(file => readJson(path.join(reviewDir, file), []).filter(item => item.pnl?.pnlPct != null).map(item => [`${item.code}|${item.date}`, Number(item.pnl.pnlPct)])));
  for (const row of candidates) {
    const touch = touches.get(row.key);
    row.firstTouch = touch?.firstTouch || null;
    row.openAtLimit = touch ? touch.openAtLimit : null;
    row.triggered = Boolean(touch && !touch.openAtLimit);
    row.pnlPct = row.triggered && pnls.has(row.key) ? pnls.get(row.key) : null;
  }
  const picks = targetDays.flatMap(day => candidates
    .filter(row => row.date === day && row.hasStrongNews)
    .sort((left, right) => right.spike60 - left.spike60)
    .slice(0, RULES.maxPicksPerDay));
  writeJson(path.join(REPORTS_DIR, `${options.name}.结果.json`), { generatedAt: new Date().toISOString(), rules: RULES, start: options.start, end: options.end, picks, candidates, failed }, true);

  if (missing.length) {
    console.log(`\n还有 ${missing.length} 只候选没有新闻结论，依次运行：`);
    console.log(`  npm run first-board-reason -- test-cases/${options.name}.json --max-queries 0`);
    console.log(`  npm run news-theme -- --input test-cases/${options.name}.json --out reports/${options.name}.xlsx`);
    console.log(`  npm run news-llm -- --report ${options.name}`);
    console.log('然后再运行一次本命令。');
    return;
  }
  console.log(`\n选出 ${picks.length} 只（候选 ${candidates.length} 只中有强类重要新闻的，每天最多 ${RULES.maxPicksPerDay} 只）：`);
  for (const day of targetDays) {
    const list = picks.filter(row => row.date === day);
    if (!list.length) continue;
    console.log(`${day} 首板 → 次日盯：${list.map(row => `${row.name}(${row.code}) 同题材${row.peers}家${row.triggered ? ` [次日 ${row.firstTouch} 触发${row.pnlPct == null ? '' : ` ${row.pnlPct.toFixed(2)}%`}]` : row.openAtLimit ? ' [竞价涨停开盘，不买]' : ''}`).join('，')}`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`选股失败: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}

module.exports = { RULES, makeTagger, buildDays };
