#!/usr/bin/env node
'use strict';

// 新闻事件归题材：按 prompts/theme-events.md，每个交易日调用一次大模型，把当天首板按各自新闻里的催化事件归成题材。
// 题材名沿用近 30 个交易日的词表，跨天才能连成走势，所以按日期从前往后一天一天跑。
// 输入：全市场涨停名单、reports/news-cache.json（首板日和前四个交易日的新闻标题，含其间节假日；多只票共有的标题只列一次，缺的先补）。
// 不给模型涨停原因（2026-11-06 用户决定）。没有事件新闻的票不归类。
// 连板票沿用首板那天的题材（新闻日历里算）。不含北交所和 ST。
// 第二遍「复看」：当天没归进任何题材的首板再调用一次，只能归进当天已有的题材（存在 review 里，页面标「复看补」）。
// 输出：reports/theme-events.json，键是日期；prompt、模型、思考开关和当天输入都没变的不重新调用（词表变了不算）。
//
// 用法: npm run theme-events -- --start 2026-01-01 [--end 2026-12-31] [--thinking] [--out 文件名] [--yes] [--news-only]
//   --news-only：只补新闻缓存，不调用模型
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { readLimitUpMonths } = require('./limit-up-list');
const { makeTagger, buildDays } = require('./stock-pick');
const { callModel, parseReply, hashOf, OFF_PEAK_PRICE, PEAK_PRICE } = require('./news-llm');
const { isCurrentCacheEntry, fetchNews } = require('./news-theme-table');

const BASE_URL = process.env.REPLAY_BASE_URL || 'http://127.0.0.1:3000';
const NEWS_CACHE_FILE = path.join(__dirname, 'reports', 'news-cache.json');

// 缺新闻的首板先用 /api/news 补到 news-cache.json（不花钱，要先开网站服务），每 500 只存一次
async function fillNews(boards, cache) {
  const lacking = boards.filter(board => !isCurrentCacheEntry(cache[board.key]));
  if (!lacking.length) return;
  console.log(`补新闻 ${lacking.length} 只`);
  const fresh = {};
  const save = () => {
    const latest = readJson(NEWS_CACHE_FILE, {});
    Object.assign(latest, fresh);
    fs.writeFileSync(`${NEWS_CACHE_FILE}.tmp`, JSON.stringify(latest));
    fs.renameSync(`${NEWS_CACHE_FILE}.tmp`, NEWS_CACHE_FILE);
    Object.assign(cache, fresh);
  };
  let next = 0;
  let done = 0;
  let failed = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < lacking.length) {
      const board = lacking[next++];
      try { fresh[board.key] = await fetchNews(BASE_URL, board.code, board.key.split('|')[1]); } catch (error) {
        failed++;
        console.log(`新闻获取失败 ${board.key}：${error.message}`);
      }
      if (++done % 500 === 0) {
        save();
        console.log(`  已补 ${done}/${lacking.length}，失败 ${failed}，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
      }
    }
  }));
  save();
  console.log(`补新闻完成 ${done} 只，失败 ${failed}`);
}

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const PROMPT_FILE = path.join(ROOT, 'prompts', 'theme-events.md');
// 复看：第一遍没归类的首板再看一遍，只能归进当天已有的题材
const REVIEW_PROMPT_FILE = path.join(ROOT, 'prompts', 'theme-events-review.md');
const VOCABULARY_DAYS = 30;
const VOCABULARY_MAX = 120;
const CONFIRM_ABOVE = 20; // 超过这么多天要 --yes

function parseArgs(argv) {
  const options = { start: '', end: '9999-12-31', thinking: false, out: 'theme-events.json', yes: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--start') options.start = String(argv[++index] || '');
    else if (argument === '--end') options.end = String(argv[++index] || '');
    else if (argument === '--thinking') options.thinking = true;
    else if (argument === '--out') options.out = path.basename(String(argv[++index] || ''));
    else if (argument === '--yes' || argument === '-y') options.yes = true;
    else if (argument === '--news-only') options.newsOnly = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数 ${argument}`);
  }
  if (!options.help && !options.start) throw new Error('需要 --start 日期');
  return options;
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

function readSystemPrompt(file = PROMPT_FILE) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('## Prompt 正文');
  if (start < 0) throw new Error(`${file} 里找不到「## Prompt 正文」`);
  return text.slice(start + '## Prompt 正文'.length).trim();
}

// 明显不是事件的标题不交给模型，省 token：龙虎榜、资金流、融资融券、大宗交易。
// 「【异动解读】××11月5日涨停：端侧AI+无线芯片+AIoT」「××涨停分析」其实就是同花顺的涨停原因，也去掉（不参考涨停原因）
const NOISE = /龙虎榜|成交明细|主力资金|资金流|融资融券|融资余额|融券|大宗交易|高频透视|北向资金|异动解读|涨停分析|涨停原因/;

// 每天的首板（不含北交所、ST）
function firstBoardsByDay() {
  const { byDay, days } = buildDays(readLimitUpMonths(), makeTagger());
  return days.map(date => ({
    date,
    boards: [...byDay.get(date).values()]
      .filter(item => item.streak === 1 && !/^[489]/.test(item.code) && !/ST/i.test(item.name || ''))
      .map(item => ({ key: `${item.code}|${date}`, code: item.code, name: item.name, reason: item.reason || '' }))
      .sort((left, right) => left.code.localeCompare(right.code)),
  }));
}

// 标题去重后编号 n1、n2…，每只票列它自己的新闻编号；lookup：s1 → 代码|首板日，n1 → 标题
function buildInput(date, boards, cache) {
  const news = [];
  const titleIds = new Map();
  const stocks = [];
  const lookup = new Map();
  let missing = 0;
  for (const board of boards) {
    const cached = cache[board.key];
    if (!isCurrentCacheEntry(cached)) {
      missing++;
      continue;
    }
    const ids = [...new Set(cached.news.map(item => String(item.title || '').trim()).filter(title => title && !NOISE.test(title)))].map(title => {
      if (!titleIds.has(title)) {
        const id = `n${news.length + 1}`;
        titleIds.set(title, id);
        lookup.set(id, title);
        news.push({ id, title });
      }
      return titleIds.get(title);
    });
    if (!ids.length) continue;
    const id = `s${stocks.length + 1}`;
    lookup.set(id, board.key);
    // 不给涨停原因（2026-11-06 用户决定），只按新闻归
    stocks.push({ id, name: board.name, news: ids });
  }
  return { input: { date, news, stocks }, lookup, missing };
}

// 合并表 theme-event-merge.json：别名 → 合并后的题材名（新闻日历也用）
function makeThemeMerger() {
  const groups = readJson(path.join(ROOT, 'theme-event-merge.json'), { groups: {} }).groups || {};
  const canonical = new Map();
  for (const [name, aliases] of Object.entries(groups)) for (const alias of aliases) canonical.set(alias, name);
  return theme => canonical.get(theme) || theme;
}

// 词表：date 之前近 VOCABULARY_DAYS 个交易日用过的题材（按合并表换成合并后的名字），最近的在前
function vocabularyBefore(date, tradingDays, saved, merge) {
  const index = tradingDays.indexOf(date);
  const recent = tradingDays.slice(Math.max(0, index - VOCABULARY_DAYS), index).reverse();
  const seen = new Map();
  for (const day of recent) {
    for (const item of saved[day]?.themes || []) {
      const theme = merge(item.theme);
      if (!seen.has(theme)) seen.set(theme, { theme, event: item.event, lastDate: day });
    }
  }
  return [...seen.values()].slice(0, VOCABULARY_MAX);
}

function normalize(parsed, lookup, rejected) {
  const themes = [];
  const byName = new Map();
  for (const item of Array.isArray(parsed.themes) ? parsed.themes : []) {
    const theme = String(item.theme || '').trim();
    if (!theme) continue;
    const raw = Array.isArray(item.stocks) ? item.stocks : [];
    // 模型偶尔只写编号字符串 "s1"，或者把对象写成 {id:"s1"} 以外的形状
    const members = raw.map(stock => {
      const id = String(typeof stock === 'string' ? stock : stock?.id || '').trim();
      const news = typeof stock === 'object' && Array.isArray(stock?.news) ? stock.news : [];
      return { key: lookup.get(id), newsIds: news.map(newsId => lookup.get(String(newsId))).filter(Boolean).slice(0, 3) };
    }).filter(stock => /^\d{6}\|/.test(stock.key || ''));
    if (members.length < raw.length) rejected.push({ theme, stocks: raw.slice(0, 10) });
    if (!members.length) continue;
    // 模型偶尔把同名题材拆成两条，合并
    if (byName.has(theme)) {
      const target = byName.get(theme);
      for (const member of members) if (!target.stocks.some(stock => stock.key === member.key)) target.stocks.push(member);
      continue;
    }
    const entry = { theme, event: String(item.event || '').trim(), stocks: members };
    byName.set(theme, entry);
    themes.push(entry);
  }
  return themes;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 13).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  for (const name of ['BASEURL', 'APIKEY', 'MODEL']) if (!process.env[name]) throw new Error(`.env 里缺少 ${name}`);
  const system = readSystemPrompt();
  const promptHash = hashOf(system);
  const outFile = path.join(REPORTS_DIR, options.out);
  const saved = readJson(outFile, {});
  const cache = readJson(path.join(REPORTS_DIR, 'news-cache.json'), {});
  const merge = makeThemeMerger();

  const allDays = firstBoardsByDay();
  const tradingDays = allDays.map(day => day.date);
  const inRange = allDays.filter(day => day.date >= options.start && day.date <= options.end);
  await fillNews(inRange.flatMap(day => day.boards), cache);
  if (options.newsOnly) return;
  const plans = inRange.map(day => {
    const { input, lookup, missing } = buildInput(day.date, day.boards, cache);
    return { ...day, input, lookup, missing, inputHash: hashOf(input) };
  });
  const isFresh = plan => {
    const entry = saved[plan.date];
    return entry && entry.promptHash === promptHash && entry.model === process.env.MODEL && Boolean(entry.thinking) === options.thinking && entry.inputHash === plan.inputHash;
  };
  const todo = plans.filter(plan => !isFresh(plan));
  const stockCount = todo.reduce((sum, plan) => sum + plan.input.stocks.length, 0);
  const missing = todo.reduce((sum, plan) => sum + plan.missing, 0);
  const chars = todo.reduce((sum, plan) => sum + JSON.stringify(plan.input).length, 0);
  console.log(`${inRange.length} 个交易日，需要处理 ${todo.length} 天，有新闻的首板 ${stockCount} 只（缺新闻缓存 ${missing} 只），输入约 ${chars} 字，${process.env.MODEL}，${options.thinking ? '开思考' : '关思考'}，prompt ${promptHash}`);
  if (todo.length > CONFIRM_ABOVE && !options.yes) throw new Error(`要调用大模型 ${todo.length} 次，超过 ${CONFIRM_ABOVE} 次。确认后加 --yes 重跑`);

  const usage = { input: 0, cached: 0, output: 0 };
  const started = Date.now();
  let failed = 0;
  const save = () => {
    fs.writeFileSync(`${outFile}.tmp`, `${JSON.stringify(saved)}\n`, 'utf8');
    fs.renameSync(`${outFile}.tmp`, outFile);
  };
  for (const [index, plan] of todo.entries()) {
    const base = { date: plan.date, promptHash, inputHash: plan.inputHash, model: process.env.MODEL, thinking: options.thinking, fetchedAt: new Date().toISOString() };
    if (!plan.input.stocks.length) {
      saved[plan.date] = { ...base, themes: [], usage: {} };
      continue;
    }
    // 词表在调用前现算，用的是前面几天刚跑出的结果
    const input = { ...plan.input, vocabulary: vocabularyBefore(plan.date, tradingDays, saved, merge) };
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const reply = await callModel(system, input, { useSearch: false, thinking: options.thinking, maxTokens: 48000 });
        if (!reply.text.trim()) throw new Error(`回复为空（输出 ${reply.usage.output} token，可能是思考用完了输出上限）`);
        const rejected = [];
        saved[plan.date] = { ...base, vocabulary: input.vocabulary.length, themes: normalize(parseReply(reply.text), plan.lookup, rejected), usage: reply.usage };
        if (rejected.length) {
          saved[plan.date].rejected = rejected;
          console.log(`${plan.date} 有 ${rejected.length} 个题材的成员编号对不上，已记在 rejected`);
        }
        for (const field of Object.keys(usage)) usage[field] += Number(reply.usage[field] || 0);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
      }
    }
    if (lastError) {
      failed++;
      console.error(`${plan.date} 失败：${lastError.message}`);
    } else {
      const result = saved[plan.date];
      const grouped = new Set(result.themes.flatMap(item => item.stocks.map(stock => stock.key))).size;
      console.log(`${plan.date}（${index + 1}/${todo.length}）：${plan.input.stocks.length} 只归了 ${grouped} 只，${result.themes.length} 个题材，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
    }
    save();
  }
  save();

  // 复看：每天第一遍没归进任何题材的首板，再交给模型看能不能归进当天已有的题材（prompts/theme-events-review.md），
  // 结果存在 saved[日期].review，不改第一遍的 themes；各天互不依赖，并发跑
  const reviewSystem = readSystemPrompt(REVIEW_PROMPT_FILE);
  const reviewHash = hashOf(reviewSystem);
  const reviews = plans.map(plan => {
    const entry = saved[plan.date];
    if (!entry?.themes?.length) return null;
    const grouped = new Set(entry.themes.flatMap(item => item.stocks.map(stock => stock.key)));
    const stocks = plan.input.stocks.filter(stock => !grouped.has(plan.lookup.get(stock.id)));
    const used = new Set(stocks.flatMap(stock => stock.news));
    const themes = [...new Map(entry.themes.map(item => [merge(item.theme), { theme: merge(item.theme), event: item.event }])).values()];
    // 近期用过的题材名（今天已有的不重复列），当天没有对应题材时优先沿用
    const vocabulary = vocabularyBefore(plan.date, tradingDays, saved, merge).map(item => item.theme).filter(name => !themes.some(item => item.theme === name));
    const input = { date: plan.date, themes, vocabulary, news: plan.input.news.filter(item => used.has(item.id)), stocks };
    return { plan, entry, input, inputHash: hashOf(input) };
  }).filter(Boolean);
  const reviewTodo = reviews.filter(({ entry, inputHash }) => !(entry.review && entry.review.promptHash === reviewHash && entry.review.model === process.env.MODEL && entry.review.inputHash === inputHash));
  console.log(`复看：${reviews.length} 天里需要处理 ${reviewTodo.length} 天，没归类的首板 ${reviewTodo.reduce((sum, item) => sum + item.input.stocks.length, 0)} 只，prompt ${reviewHash}`);
  if (reviewTodo.length > CONFIRM_ABOVE && !options.yes) throw new Error(`复看要调用大模型 ${reviewTodo.length} 次，超过 ${CONFIRM_ABOVE} 次。确认后加 --yes 重跑`);
  let nextReview = 0;
  let reviewAssigned = 0;
  await Promise.all(Array.from({ length: Math.min(4, reviewTodo.length) }, async () => {
    while (nextReview < reviewTodo.length) {
      const { plan, entry, input, inputHash } = reviewTodo[nextReview++];
      const base = { promptHash: reviewHash, inputHash, model: process.env.MODEL, fetchedAt: new Date().toISOString() };
      if (!input.stocks.length) {
        entry.review = { ...base, assign: [], usage: {} };
        continue;
      }
      const themeEvents = new Map(input.themes.map(item => [item.theme, item.event]));
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const reply = await callModel(reviewSystem, input, { useSearch: false, thinking: false, maxTokens: 8000 });
          const parsed = parseReply(reply.text);
          const assign = [];
          for (const item of Array.isArray(parsed.assign) ? parsed.assign : []) {
            const key = plan.lookup.get(String(item.id || '').trim());
            const theme = merge(String(item.theme || '').trim());
            const newsIds = (Array.isArray(item.news) ? item.news : []).map(id => plan.lookup.get(String(id))).filter(title => title && !/^\d{6}\|/.test(title)).slice(0, 3);
            // 编号对得上、有依据新闻；当天已有的题材用当天的催化，新题材用模型给的 event（没给就用依据标题）；一只最多 2 个
            if (!/^\d{6}\|/.test(key || '') || !theme || !newsIds.length) continue;
            if (assign.filter(other => other.key === key).length >= 2 || assign.some(other => other.key === key && other.theme === theme)) continue;
            const event = themeEvents.get(theme) || String(item.event || '').trim() || newsIds[0].slice(0, 30);
            assign.push({ key, theme, event, newsIds, ...(themeEvents.has(theme) ? {} : { fresh: 1 }) });
          }
          entry.review = { ...base, assign, usage: reply.usage };
          for (const field of Object.keys(usage)) usage[field] += Number(reply.usage[field] || 0);
          reviewAssigned += new Set(assign.map(item => item.key)).size;
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
        }
      }
      if (lastError) {
        failed++;
        console.error(`${plan.date} 复看失败：${lastError.message}`);
      } else console.log(`${plan.date} 复看：${input.stocks.length} 只没归类的补进 ${new Set(entry.review.assign.map(item => item.key)).size} 只`);
      save();
    }
  }));
  if (reviewTodo.length) console.log(`复看共补进 ${reviewAssigned} 只`);
  save();
  const cost = price => (usage.cached * price.cached + usage.input * price.input + usage.output * price.output) / 1e6;
  const totalInput = usage.input + usage.cached;
  console.log(`输入 ${totalInput} token（命中缓存 ${usage.cached}），输出 ${usage.output} token；`
    + `约 ${cost(OFF_PEAK_PRICE).toFixed(2)} 元（空闲）/ ${cost(PEAK_PRICE).toFixed(2)} 元（高峰）。已写入 ${path.relative(ROOT, outFile)}`);
  if (failed) process.exitCode = 1;
}

module.exports = { makeThemeMerger };

if (require.main === module) main().catch(error => {
  console.error(`新闻事件归题材失败: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
