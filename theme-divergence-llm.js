#!/usr/bin/env node
'use strict';

// 题材内部分化：让模型判断（prompts/theme-divergence.md，2026-11-12 用户要求）。
// 题材日历里，同一事件题材当天首板 ≥ 3 只、又有二板及以上的票时，把首板和高位票各自的催化 event、依据标题交给模型，
// 问首板是不是同题材下的一次新发酵，给出区分关键词。结果写 reports/theme-divergence.json，news-calendar.js 读它标「分化?」。
// 每个交易日调用一次（只送当天的候选题材），关思考。输入来自新闻日历月份文件（reports/新闻日历/）和 reports/theme-events.json，
// 所以要在 news-calendar.js 生成过之后跑；跑完再跑一次 news-calendar.js 才会显示。
//
// 用法: node theme-divergence-llm.js --start 2025-06-01 [--end 2026-12-31] [--workers 4] [--yes]
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { callModel, parseReply, hashOf, OFF_PEAK_PRICE, PEAK_PRICE } = require('./news-llm');
const { makeThemeMerger } = require('./theme-events');
const { GENERIC_THEMES } = require('./theme-divergence');

const ROOT = __dirname;
const PROMPT_FILE = path.join(ROOT, 'prompts', 'theme-divergence.md');
const OUT_FILE = path.join(ROOT, 'reports', 'theme-divergence.json');
const CALENDAR_DIR = path.join(ROOT, 'reports', '新闻日历');
const MIN_FIRST = 3;
const MAX_FIRST_LISTED = 12; // 首板太多时只列前 12 只，够看出共同催化
const MAX_TITLES = 3;
const CONFIRM_ABOVE = 30;

function parseArgs(argv) {
  const options = { start: '', end: '9999-12-31', workers: 4, yes: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--start') options.start = String(argv[++index] || '');
    else if (argument === '--end') options.end = String(argv[++index] || '');
    else if (argument === '--workers') options.workers = Math.max(1, Number(argv[++index]) || 4);
    else if (argument === '--yes' || argument === '-y') options.yes = true;
    else throw new Error(`未知参数: ${argument}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.start)) throw new Error('--start 需要 YYYY-MM-DD');
  return options;
}

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

function readPrompt() {
  const text = fs.readFileSync(PROMPT_FILE, 'utf8');
  return text.slice(text.indexOf('## Prompt 正文') + '## Prompt 正文'.length).trim();
}

// 首板|题材 → 模型归题材时引用的依据标题
function evidenceIndex() {
  const merge = makeThemeMerger();
  const evidence = new Map();
  const add = (key, theme, titles) => {
    const id = `${key}|${merge(theme)}`;
    evidence.set(id, [...new Set([...(evidence.get(id) || []), ...titles])]);
  };
  for (const entry of Object.values(readJson(path.join(ROOT, 'reports', 'theme-events.json'), {}))) {
    for (const item of entry.themes || []) for (const stock of item.stocks) add(stock.key, item.theme, stock.newsIds);
    for (const item of entry.review?.assign || []) add(item.key, item.theme, item.newsIds);
  }
  return evidence;
}

// 每个交易日的候选题材：首板 ≥ 3 只且有二板及以上，不含按公司事项归的通用题材
function buildPlans(options) {
  const evidence = evidenceIndex();
  const plans = [];
  const months = fs.readdirSync(CALENDAR_DIR).filter(file => /^\d{4}-\d{2}\.json$/.test(file)).sort();
  for (const file of months) {
    if (file.slice(0, 7) < options.start.slice(0, 7) || file.slice(0, 7) > options.end.slice(0, 7)) continue;
    const month = readJson(path.join(CALENDAR_DIR, file), { days: [] });
    for (const day of month.days) {
      if (day.d < options.start || day.d > options.end) continue;
      const themes = [];
      for (const theme of day.ets || []) {
        if (GENERIC_THEMES.has(theme.n) || !theme.l) continue;
        const members = day.stocks.filter(stock => stock.et?.includes(theme.n));
        const first = members.filter(stock => stock.s === 1);
        const high = members.filter(stock => stock.s >= 2);
        if (first.length < MIN_FIRST || !high.length) continue;
        const describe = stock => {
          const key = `${stock.c}|${stock.fd || day.d}`;
          const event = (month.events[key] || []).find(item => item.t === theme.n);
          const titles = (evidence.get(`${key}|${theme.n}`) || (event?.n ? [event.n] : [])).slice(0, MAX_TITLES);
          return { name: stock.n, ...(stock.s > 1 ? { streak: stock.s, firstDate: stock.fd } : {}), event: event?.e || '', titles };
        };
        themes.push({ theme: theme.n, first: first.slice(0, MAX_FIRST_LISTED).map(describe), firstCount: first.length, high: high.map(describe) });
      }
      if (themes.length) plans.push({ date: day.d, input: { date: day.d, themes } });
    }
  }
  return plans;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const system = readPrompt();
  const promptHash = hashOf(system);
  const saved = readJson(OUT_FILE, {});
  const plans = buildPlans(options).map(plan => ({ ...plan, inputHash: hashOf(JSON.stringify(plan.input)) }));
  const todo = plans.filter(plan => !(saved[plan.date]?.promptHash === promptHash && saved[plan.date]?.inputHash === plan.inputHash && saved[plan.date]?.model === process.env.MODEL));
  const themeCount = todo.reduce((sum, plan) => sum + plan.input.themes.length, 0);
  console.log(`${plans.length} 个交易日有候选题材，需要处理 ${todo.length} 天、${themeCount} 个题材，${process.env.MODEL}，关思考，prompt ${promptHash}`);
  if (todo.length > CONFIRM_ABOVE && !options.yes) throw new Error(`要调用大模型 ${todo.length} 次，超过 ${CONFIRM_ABOVE} 次。确认后加 --yes 重跑`);

  const usage = { input: 0, cached: 0, output: 0 };
  const save = () => {
    fs.writeFileSync(`${OUT_FILE}.tmp`, `${JSON.stringify(saved)}\n`, 'utf8');
    fs.renameSync(`${OUT_FILE}.tmp`, OUT_FILE);
  };
  let next = 0;
  let failed = 0;
  let split = 0;
  await Promise.all(Array.from({ length: options.workers }, async () => {
    while (next < todo.length) {
      const plan = todo[next++];
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const reply = await callModel(system, plan.input, { useSearch: false, thinking: false, maxTokens: 8000 });
          const parsed = parseReply(reply.text);
          const wanted = new Set(plan.input.themes.map(item => item.theme));
          const themes = {};
          for (const item of parsed.themes || []) {
            if (!wanted.has(item.theme)) continue;
            // 关键词必须原样出现在首板的 event 或标题里，否则丢掉（防止模型自己编）
            const source = plan.input.themes.find(theme => theme.theme === item.theme).first.map(stock => [stock.event, ...stock.titles].join(' ')).join(' ');
            const keywords = (Array.isArray(item.keywords) ? item.keywords : []).map(word => String(word).trim()).filter(word => word.length >= 2 && source.includes(word)).slice(0, 5);
            themes[item.theme] = item.split && keywords.length ? { split: 1, keywords, note: String(item.note || '').slice(0, 60) } : { split: 0 };
          }
          saved[plan.date] = { promptHash, inputHash: plan.inputHash, model: process.env.MODEL, fetchedAt: new Date().toISOString(), themes, usage: reply.usage };
          for (const field of Object.keys(usage)) usage[field] += Number(reply.usage[field] || 0);
          split += Object.values(themes).filter(item => item.split).length;
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
      }
      if ((next % 20 === 0) || next === todo.length) {
        console.log(`进度 ${Math.min(next, todo.length)}/${todo.length}，判为分化 ${split} 个`);
        save();
      }
    }
  }));
  save();
  const cost = price => (usage.cached * price.cached + usage.input * price.input + usage.output * price.output) / 1e6;
  console.log(`判为分化 ${split} 个题材；输入 ${usage.input + usage.cached} token（命中缓存 ${usage.cached}），输出 ${usage.output} token；`
    + `约 ${cost(OFF_PEAK_PRICE).toFixed(2)} 元（空闲）/ ${cost(PEAK_PRICE).toFixed(2)} 元（高峰）。已写入 ${path.relative(ROOT, OUT_FILE)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(`题材分化判断失败: ${error.message}`);
  process.exit(1);
});
