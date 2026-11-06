#!/usr/bin/env node
'use strict';

// 涨停原因佐证：按 prompts/theme-evidence.md，让大模型判断每只首板的涨停原因概念有没有它自己三天新闻的佐证。
// 只用首板的涨停原因（一进二在首板当晚决定），连板票后面几天沿用首板的结论。
// 输入：全市场涨停名单（limit-up-list）、reports/news-cache.json（三天新闻，没有的先用 /api/news 补）。
// 输出：reports/theme-evidence.json，键 代码|首板日；prompt、模型、思考开关和输入都没变的不重新调用。
// 不含北交所和 ST。只看新闻标题，不用正文。
//
// 用法: npm run theme-evidence -- --start 2026-01-01 [--end 2026-12-31] [--keys 代码|首板日,...] [--sample 50]
//                                [--workers 6] [--thinking] [--out 文件名] [--yes]
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { readLimitUpMonths } = require('./limit-up-list');
const { makeTagger, buildDays } = require('./stock-pick');
const { callModel, parseReply, hashOf, OFF_PEAK_PRICE, PEAK_PRICE } = require('./news-llm');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const PROMPT_FILE = path.join(ROOT, 'prompts', 'theme-evidence.md');
const NEWS_CACHE_FILE = path.join(REPORTS_DIR, 'news-cache.json');
const CONFIRM_ABOVE = 100;
const BASE_URL = process.env.REPLAY_BASE_URL || 'http://127.0.0.1:3000';

function parseArgs(argv) {
  const options = { start: '', end: '9999-12-31', keys: [], sample: 0, workers: 6, thinking: false, out: 'theme-evidence.json', yes: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--start') options.start = String(argv[++index] || '');
    else if (argument === '--end') options.end = String(argv[++index] || '');
    else if (argument === '--keys') options.keys = String(argv[++index] || '').split(',').map(item => item.trim()).filter(Boolean);
    else if (argument === '--sample') options.sample = Number(argv[++index]);
    else if (argument === '--workers') options.workers = Number(argv[++index]);
    else if (argument === '--thinking') options.thinking = true;
    else if (argument === '--out') options.out = path.basename(String(argv[++index] || ''));
    else if (argument === '--yes' || argument === '-y') options.yes = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数 ${argument}`);
  }
  if (!options.help && !options.start && !options.keys.length) throw new Error('需要 --start 日期 或 --keys');
  return options;
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

function readSystemPrompt() {
  const text = fs.readFileSync(PROMPT_FILE, 'utf8');
  const start = text.indexOf('## Prompt 正文');
  if (start < 0) throw new Error(`${PROMPT_FILE} 里找不到「## Prompt 正文」`);
  return text.slice(start + '## Prompt 正文'.length).trim();
}

// 涨停原因按 + 拆开，保留原词（不并大题材），去掉空的和重复的
// 去掉零宽字符：同花顺的原因里偶尔夹着 U+200B，模型回答时会丢掉，概念名就对不上了
const cleanConcept = word => String(word || '').replace(/[​-‍﻿]/g, '').trim().replace(/^“|”$/g, '');
const conceptsOf = reason => [...new Set(String(reason || '').split(/[+＋]/).map(cleanConcept).filter(Boolean))];

// 范围内所有涨停（不含北交所、ST）对应的首板：键 代码|首板日
function firstBoards(options) {
  const { byDay, days } = buildDays(readLimitUpMonths(), makeTagger());
  const boards = new Map();
  days.forEach((date, index) => {
    if (date < options.start || date > options.end) return;
    for (const item of byDay.get(date).values()) {
      if (/^[489]/.test(item.code) || /ST/i.test(item.name || '')) continue;
      const first = days[index - item.streak + 1];
      const key = `${item.code}|${first}`;
      if (boards.has(key)) continue;
      const firstItem = byDay.get(first)?.get(item.code) || item;
      boards.set(key, { key, code: item.code, name: firstItem.name || item.name, date: first, reason: firstItem.reason || '' });
    }
  });
  return [...boards.values()].sort((left, right) => left.date.localeCompare(right.date) || left.code.localeCompare(right.code));
}

async function fetchNews(code, date) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/api/news?code=${code}&date=${date}&days=3`, { signal: AbortSignal.timeout(60_000) });
      const payload = await response.json();
      if (!response.ok || payload.status_code !== 0 || !Array.isArray(payload.data)) throw new Error(payload.msg || `HTTP ${response.status}`);
      const time = ms => new Date(Number(ms) + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
      return { days: 3, startDate: payload.startDate, endDate: payload.endDate, news: payload.data.map(item => ({ title: String(item.title || '').trim(), time: time(item.publishTime), url: item.jumpUrl || '', pinned: Boolean(item.isPinned) })) };
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

function buildInput(board, news) {
  return {
    key: board.key,
    stockName: board.name,
    date: board.date,
    concepts: conceptsOf(board.reason),
    news: news.map((item, index) => ({ id: `n${index + 1}`, time: item.time, title: item.title })),
  };
}

function normalize(parsed, input) {
  const byConcept = new Map((Array.isArray(parsed.concepts) ? parsed.concepts : []).map(item => [cleanConcept(item.concept), item]));
  const ids = new Set(input.news.map(item => item.id));
  const missing = input.concepts.filter(concept => !byConcept.has(concept));
  if (missing.length) throw new Error(`模型漏判了概念：${missing.join('、')}`);
  return input.concepts.map(concept => {
    const item = byConcept.get(concept);
    const newsIds = (Array.isArray(item.newsIds) ? item.newsIds : []).map(String).filter(id => ids.has(id)).slice(0, 3);
    const evidenced = item.evidenced === true && newsIds.length > 0;
    return { concept, evidenced, newsIds: evidenced ? newsIds : [], reason: String(item.reason || '') };
  });
}

async function confirm(count, options) {
  if (count <= CONFIRM_ABOVE || options.yes) return;
  throw new Error(`需要调用大模型 ${count} 只，超过 ${CONFIRM_ABOVE} 只。确认后加 --yes 重跑`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 12).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  for (const name of ['BASEURL', 'APIKEY', 'MODEL']) if (!process.env[name]) throw new Error(`.env 里缺少 ${name}`);
  const system = readSystemPrompt();
  const promptHash = hashOf(system);
  const outFile = path.join(REPORTS_DIR, options.out);
  const saved = readJson(outFile, {});

  let boards = options.keys.length
    ? firstBoards({ start: '0000-00-00', end: '9999-12-31' }).filter(board => options.keys.includes(board.key))
    : firstBoards(options);
  if (options.sample) {
    // 固定种子的抽样，重跑抽到的是同一批
    let seed = 20261103;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    boards = boards.map(board => [random(), board]).sort((left, right) => left[0] - right[0]).slice(0, options.sample).map(([, board]) => board);
  }
  boards = boards.filter(board => conceptsOf(board.reason).length);

  // 先补新闻缓存（不花钱）
  const cache = readJson(NEWS_CACHE_FILE, {});
  const lacking = boards.filter(board => !(cache[board.key]?.days >= 3));
  if (lacking.length) {
    console.log(`补三天新闻 ${lacking.length} 只`);
    let next = 0;
    const fresh = {};
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < lacking.length) {
        const board = lacking[next++];
        try { fresh[board.key] = await fetchNews(board.code, board.date); } catch (error) { console.log(`新闻获取失败 ${board.key}：${error.message}`); }
      }
    }));
    const latest = readJson(NEWS_CACHE_FILE, {});
    Object.assign(latest, fresh);
    fs.writeFileSync(`${NEWS_CACHE_FILE}.tmp`, JSON.stringify(latest));
    fs.renameSync(`${NEWS_CACHE_FILE}.tmp`, NEWS_CACHE_FILE);
    Object.assign(cache, fresh);
  }

  const inputs = new Map(boards.filter(board => cache[board.key]?.days >= 3).map(board => [board.key, buildInput(board, cache[board.key].news)]));
  const isFresh = key => {
    const entry = saved[key];
    return entry && entry.promptHash === promptHash && entry.model === process.env.MODEL && Boolean(entry.thinking) === options.thinking && entry.inputHash === hashOf(inputs.get(key));
  };
  const todo = [...inputs.keys()].filter(key => !isFresh(key));
  const calls = todo.filter(key => inputs.get(key).news.length).length;
  console.log(`首板 ${boards.length} 只，有新闻缓存 ${inputs.size} 只，缓存可用 ${inputs.size - todo.length} 只，需要处理 ${todo.length} 只（调用模型 ${calls} 只），${process.env.MODEL}，${options.thinking ? '开思考' : '关思考'}，prompt ${promptHash}`);
  await confirm(calls, options);

  const usage = { input: 0, cached: 0, output: 0 };
  let next = 0;
  let done = 0;
  let failed = 0;
  const started = Date.now();
  const save = () => fs.writeFileSync(outFile, `${JSON.stringify(saved)}\n`, 'utf8');
  await Promise.all(Array.from({ length: Math.min(options.workers, todo.length) }, async () => {
    while (next < todo.length) {
      const key = todo[next++];
      const input = inputs.get(key);
      const base = { key, promptHash, inputHash: hashOf(input), model: process.env.MODEL, thinking: options.thinking, reason: input.concepts.join('+'), newsIds: cache[key].news.map(item => `${item.time}|${item.title}`), fetchedAt: new Date().toISOString() };
      try {
        if (!input.news.length) {
          saved[key] = { ...base, concepts: input.concepts.map(concept => ({ concept, evidenced: false, newsIds: [], reason: '没有新闻' })), usage: {} };
        } else {
          let lastError;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const reply = await callModel(system, input, { useSearch: false, thinking: options.thinking });
              saved[key] = { ...base, concepts: normalize(parseReply(reply.text), input), usage: reply.usage };
              for (const field of Object.keys(usage)) usage[field] += Number(reply.usage[field] || 0);
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
            }
          }
          if (lastError) throw lastError;
        }
      } catch (error) {
        failed++;
        console.error(`\n${key} ${input.stockName} 失败：${error.message}`);
      }
      done++;
      if (done % 20 === 0 || done === todo.length) {
        save();
        process.stdout.write(`已完成 ${done}/${todo.length}，失败 ${failed}，用时 ${Math.round((Date.now() - started) / 1000)} 秒\n`);
      }
    }
  }));
  save();
  const cost = price => (usage.cached * price.cached + usage.input * price.input + usage.output * price.output) / 1e6;
  const totalInput = usage.input + usage.cached;
  console.log(`输入 ${totalInput} token（命中缓存 ${usage.cached}，${totalInput ? Math.round(usage.cached / totalInput * 100) : 0}%），输出 ${usage.output} token；`
    + `约 ${cost(OFF_PEAK_PRICE).toFixed(2)} 元（空闲）/ ${cost(PEAK_PRICE).toFixed(2)} 元（高峰）。已写入 ${path.relative(ROOT, outFile)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(`涨停原因佐证失败: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
