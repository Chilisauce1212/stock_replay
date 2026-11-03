#!/usr/bin/env node
'use strict';

// 新闻日历数据：按日期汇总当天所有涨停股（首板和连板）、涨停时间、涨停原因和新闻，页面 news-calendar.html 用。
// 按月写 reports/新闻日历/YYYY-MM.json，加 index.json（月份列表）。不含北交所和当时是 ST 的票（口径同 limit-up-cycle.js）。
// 新闻和判断来自 reports/news-cache.json、news-llm.json，只有跑过新闻判断的首板才有（键是 代码|首板日）；连板股用它首板日的那份。
// 没跑过的票：页面展开时现查标题（/api/news），没有重要性判断。
// 题材：涨停原因按 + 拆开后每个概念都算，一只票可以属于多个题材；文字里含 theme-synonyms.json 大题材名的并进大题材（机械匹配）。
// 只用在这个页面，选股和回测的「第一概念」口径不变。
// 涨停时间：同花顺涨停池的首次涨停时间，大约只能查一年；更早的用 --fill-ticks 从通达信逐笔找第一笔涨停价成交，
// 记为 ~HH:MM（是首次触板，不一定封住）。都缓存在 reports/涨停时间.json。
//
// 用法: npm run news-calendar -- [--upload] [--fill-ticks] [--max-ticks 2000] [--workers 6]
//   --upload：同时写到 R2 的 news-calendar/，只传内容有变化的月份
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { RULES, makeTagger, buildDays } = require('./stock-pick');
const { fetchPool, updateLimitUpList } = require('./limit-up-list');
const { Worker, healthyHosts } = require('./tdx_tick');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUTPUT_DIR = path.join(REPORTS_DIR, '新闻日历');
const TIME_FILE = path.join(REPORTS_DIR, '涨停时间.json');
const R2_PREFIX = 'news-calendar/';
const FIRST_DAY = '2024-01-01'; // 名单从 2023-12-18 开始，头几天的连板数不完整，不展示
const ST_MAX_PCT = 6;
const TREND_DAYS = 10;
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const isBeijingExchange = code => /^[489]/.test(code);
const newsIdOf = item => `${item.time}|${item.title}`;
const BEIJING_DAY = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

function writeJson(file, data) {
  const text = `${JSON.stringify(data)}\n`;
  fs.writeFileSync(`${file}.tmp`, text, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

function parseArgs(argv) {
  const options = { upload: false, fillTicks: false, maxTicks: Infinity, workers: 6 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--upload') options.upload = true;
    else if (argument === '--fill-ticks') options.fillTicks = true;
    else if (argument === '--max-ticks') options.maxTicks = Number(argv[++index]);
    else if (argument === '--workers') options.workers = Number(argv[++index]);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数: ${argument}`);
  }
  return options;
}

// 涨停池能查到的日期一次补齐；从最近往前，接口开始报错（超过大约一年）就停
async function fillPoolTimes(days, stocksOf, times) {
  let filled = 0;
  for (const date of [...days].reverse()) {
    if (date < FIRST_DAY) break;
    if (stocksOf(date).every(item => `${item.code}|${date}` in times)) continue;
    let rows;
    try {
      rows = await fetchPool(date);
    } catch {
      console.log(`涨停池查不到 ${date}，更早的日期要用 --fill-ticks`);
      break;
    }
    for (const row of rows) {
      if (row.firstLimitTime) times[`${row.code}|${date}`] = row.firstLimitTime;
    }
    filled++;
  }
  console.log(`涨停池补了 ${filled} 天的涨停时间`);
}

async function fillTickTimes(rows, times, options) {
  const tasks = rows.filter(({ code, date }) => !(`${code}|${date}` in times)).reverse().slice(0, options.maxTicks);
  console.log(`逐笔补涨停时间：待查 ${tasks.length} 只`);
  if (!tasks.length) return;
  const hosts = await healthyHosts();
  const workers = Array.from({ length: options.workers }, (_, index) => new Worker(hosts, index, 0.02));
  let next = 0;
  let done = 0;
  let failed = 0;
  await Promise.all(workers.map(async worker => {
    while (next < tasks.length) {
      const { code, date } = tasks[next++];
      try {
        const ticks = (await worker.run(code, date.replaceAll('-', ''))).filter(tick => tick.vol > 0 && tick.time >= '09:25');
        const close = ticks.at(-1)?.price;
        const touch = ticks.find(tick => tick.price >= close - 0.005);
        if (touch) times[`${code}|${date}`] = `~${touch.time}`;
      } catch {
        failed++;
      }
      if (++done % 500 === 0) {
        writeJson(TIME_FILE, times);
        console.log(`  已查 ${done}/${tasks.length}，失败 ${failed}`);
      }
    }
  }));
  workers.forEach(worker => worker.close());
  writeJson(TIME_FILE, times);
  console.log(`逐笔查完 ${done} 只，失败 ${failed}`);
}

// 把缓存的新闻和大模型判断合成一份，查不到的返回 null（没跑过新闻判断）
function buildNews(key, newsCache, llm) {
  const cached = newsCache[key];
  if (!cached) return null;
  const entry = llm[key];
  const judged = new Map((entry?.result?.news || []).map(item => [entry.newsIds[Number(String(item.id).slice(1)) - 1], item]));
  const news = (cached.news || []).map(item => {
    const judge = judged.get(newsIdOf(item));
    return {
      t: item.title,
      tm: item.time,
      u: item.url,
      ...(judge?.important ? { i: 1, cats: judge.categories || [], nt: judge.newThing || '', why: judge.reason || '' } : {}),
    };
  });
  const categories = [...new Set(news.flatMap(item => item.cats || []))];
  const verdict = !entry?.result ? null
    : categories.some(category => RULES.strongCategories.includes(category)) ? '强类'
      : entry.result.hasImportantNews ? '仅弱类' : '无';
  return { news, verdict, categories };
}

// 机器人轴承 → 机器人；AI算力PCB → 算力、PCB，一个概念含几个大题材名就都算
function makeThemeMatcher() {
  const groups = Object.keys(readJson(path.join(ROOT, 'theme-synonyms.json'), { groups: {} }).groups);
  return tags => [...new Set(tags.flatMap(tag => {
    const matched = groups.filter(group => tag.includes(group));
    return matched.length ? matched : [tag];
  }))];
}

function buildMonths(byDay, days, stocksOf, times, newsCache, llm) {
  const themesOf = makeThemeMatcher();
  const months = new Map();
  const newsCacheByKey = new Map();
  const newsOf = key => {
    if (!newsCacheByKey.has(key)) newsCacheByKey.set(key, buildNews(key, newsCache, llm));
    return newsCacheByKey.get(key);
  };
  const themeCounts = days.map(date => {
    const counts = new Map();
    for (const item of stocksOf(date)) {
      for (const theme of themesOf(item.tags)) counts.set(theme, (counts.get(theme) || 0) + 1);
    }
    return counts;
  });
  days.forEach((date, dayIndex) => {
    if (date < FIRST_DAY) return;
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, { days: [], news: {} });
    const target = months.get(month);
    const stocks = stocksOf(date).map(item => {
      const firstDate = days[dayIndex - item.streak + 1];
      const key = `${item.code}|${firstDate}`;
      const news = newsOf(key);
      if (news && !target.news[key]) target.news[key] = news.news;
      const row = {
        c: item.code,
        n: item.name,
        s: item.streak,
        tm: times[`${item.code}|${date}`] || '',
        r: item.reason,
        ths: themesOf(item.tags),
        v: news ? news.verdict : null,
        nc: news ? news.news.length : null,
      };
      if (news?.categories.length) row.cats = news.categories;
      if (item.streak > 1) {
        row.fd = firstDate;
        row.fr = byDay.get(firstDate)?.get(item.code)?.reason || '';
      }
      return row;
    }).sort((left, right) => right.s - left.s || left.tm.replace('~', '').localeCompare(right.tm.replace('~', '')));
    const themes = [...themeCounts[dayIndex].entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([name, count]) => {
        const trend = themeCounts.slice(Math.max(0, dayIndex - TREND_DAYS), dayIndex).map(counts => counts.get(name) || 0);
        return { n: name, c: count, l: stocks.filter(stock => stock.ths.includes(name) && stock.s >= 2).length, tr: trend };
      });
    target.days.push({
      d: date,
      t: stocks.length,
      top: stocks.reduce((max, stock) => Math.max(max, stock.s), 1),
      first: stocks.filter(stock => stock.s === 1).length,
      imp: stocks.filter(stock => stock.v === '强类' || stock.v === '仅弱类').length,
      themes,
      stocks,
    });
  });
  return months;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 13).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const r2 = options.upload ? require('./r2-storage') : null;
  if (r2 && !r2.r2Client) throw new Error('R2 未配置，不能 --upload');

  const { byDay, days } = buildDays(await updateLimitUpList(BEIJING_DAY()), makeTagger());
  const bars = readJson(path.join(REPORTS_DIR, '连板一字板.json'), {});
  const isSt = (item, date) => {
    const pct = bars[`${item.code}|${date}`]?.pct;
    return Number.isFinite(pct) ? pct < ST_MAX_PCT : /ST/i.test(item.name);
  };
  const stocksOf = date => [...byDay.get(date).values()].filter(item => !isBeijingExchange(item.code) && !isSt(item, date));
  const times = readJson(TIME_FILE, {});
  await fillPoolTimes(days, stocksOf, times);
  writeJson(TIME_FILE, times);
  if (options.fillTicks) {
    const rows = days.filter(date => date >= FIRST_DAY).flatMap(date => stocksOf(date).map(item => ({ code: item.code, date })));
    await fillTickTimes(rows, times, options);
  }

  const months = buildMonths(byDay, days, stocksOf, times, readJson(path.join(REPORTS_DIR, 'news-cache.json'), {}), readJson(path.join(REPORTS_DIR, 'news-llm.json'), {}));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  let changed = 0;
  for (const [month, data] of months) {
    const file = path.join(OUTPUT_DIR, `${month}.json`);
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (previous === `${JSON.stringify(data)}\n` && !r2) continue;
    if (previous !== `${JSON.stringify(data)}\n`) writeJson(file, data);
    if (r2) {
      const remote = await r2.readJson(`${R2_PREFIX}${month}.json`).catch(error => (r2.isMissing(error) ? null : Promise.reject(error)));
      if (JSON.stringify(remote) === JSON.stringify(data)) continue;
      await r2.writeJson(`${R2_PREFIX}${month}.json`, data);
    }
    changed++;
  }
  const index = { months: [...months.keys()].sort() };
  writeJson(path.join(OUTPUT_DIR, 'index.json'), index);
  if (r2) await r2.writeJson(`${R2_PREFIX}index.json`, index);
  const all = [...months.values()].flatMap(month => month.days.flatMap(day => day.stocks));
  console.log(`共 ${months.size} 个月，更新 ${changed} 个；${all.length} 条涨停，有涨停时间 ${all.filter(stock => stock.tm).length} 条，有新闻 ${all.filter(stock => stock.nc !== null).length} 条`);
}

main().catch(error => {
  console.error(`新闻日历生成失败: ${error.message}`);
  process.exitCode = 1;
});
