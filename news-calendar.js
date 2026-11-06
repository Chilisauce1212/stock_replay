#!/usr/bin/env node
'use strict';

// 新闻日历数据：按日期汇总当天所有涨停股（首板和连板）、涨停时间、涨停原因和新闻，页面 news-calendar.html 用。
// 按月写 reports/新闻日历/YYYY-MM.json，加 index.json（月份列表）。不含北交所和当时是 ST 的票（口径同 limit-up-cycle.js）。
// 新闻和判断来自 reports/news-cache.json、news-llm.json，只有跑过新闻判断的首板才有（键是 代码|首板日）；连板股用它首板日的那份。
// 没跑过的票：页面展开时现查标题（/api/news），没有重要性判断。
// 题材：涨停原因按 + 拆开后每个概念都算，一只票可以属于多个题材；文字里含 theme-synonyms.json 大题材名的并进大题材（机械匹配）。
// 只用在这个页面，选股和回测的「第一概念」口径不变。
// 涨停原因佐证（theme-evidence.js 写入 reports/theme-evidence.json，键 代码|首板日）：首板涨停原因的每个概念有没有这只票自己三天新闻的佐证。
// 有佐证的概念归到的题材记在 ev，连板票沿用首板的结论；当天涨停原因里有、首板时没有佐证的题材算跟风。没跑过的票没有 ev。
// 新闻事件题材（theme-events.js 写入 reports/theme-events.json，键是日期）：首板按自己新闻里的催化事件归的题材，记在 et，
// 连板票沿用首板那天的；跑过的日期 ed=1，页面默认用事件题材，没跑过的日期退回涨停原因概念。
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
const { makeThemeMerger } = require('./theme-events');

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

function buildMonths(byDay, days, stocksOf, times, newsCache, llm, evidence, events) {
  const themesOf = makeThemeMatcher();
  // 首板 → 它归到的事件题材 [{ t 题材, e 当天催化, n 依据新闻标题 }]
  // 题材名按合并表 theme-event-merge.json 合并（人形机器人、物理AI → 机器人），同一只票合并后重复的只留第一条
  const merge = makeThemeMerger();
  const eventsByKey = new Map();
  for (const [date, entry] of Object.entries(events)) {
    for (const item of entry.themes || []) {
      const theme = merge(item.theme);
      for (const stock of item.stocks) {
        if (!eventsByKey.has(stock.key)) eventsByKey.set(stock.key, []);
        const list = eventsByKey.get(stock.key);
        if (list.some(event => event.t === theme)) continue;
        list.push({ t: theme, e: item.event, ...(stock.newsIds[0] ? { n: stock.newsIds[0] } : {}) });
      }
    }
    if (!entry.themes) console.log(`事件题材 ${date} 没有结果`);
  }
  // 同标题补：模型偶尔漏掉一只（一天上百只首板时更常见，如 2026-11-02 的浙文影业）。没归到任何题材的首板，
  // 如果它的新闻里有某题材成员当天被引作依据的同一条标题，就补进那个题材，记 via=1（页面标「同标题补」）。
  // 复盘、梳理、行情描述类标题不用来补，太泛。
  const SHARED_SKIP = /龙虎榜|成交明细|主力资金|资金流|融资融券|融资余额|融券|大宗交易|高频透视|北向资金|异动解读|涨停分析|涨停原因|复盘|涨停|梳理|一表|一图|一览|汇总|名单|盘初|盘中|早盘|午后|尾盘|异动|拉升|走强|走高|大涨|活跃|概念股|板块|个股|多股|只股票|热点|主线/;
  let sharedAdded = 0;
  for (const [date, entry] of Object.entries(events)) {
    const evidence = new Map(); // 标题 → [{ t, e }]
    for (const item of entry.themes || []) {
      for (const stock of item.stocks) {
        for (const title of stock.newsIds) {
          if (SHARED_SKIP.test(title)) continue;
          if (!evidence.has(title)) evidence.set(title, []);
          if (!evidence.get(title).some(event => event.t === merge(item.theme))) evidence.get(title).push({ t: merge(item.theme), e: item.event });
        }
      }
    }
    if (!evidence.size || !byDay.has(date)) continue;
    for (const item of stocksOf(date)) {
      if (item.streak !== 1) continue;
      const key = `${item.code}|${date}`;
      if (eventsByKey.get(key)?.length) continue;
      const found = [];
      for (const news of newsCache[key]?.news || []) {
        for (const event of evidence.get(news.title) || []) {
          if (!found.some(other => other.t === event.t)) found.push({ ...event, n: news.title, via: 1 });
        }
      }
      if (found.length) {
        eventsByKey.set(key, found);
        sharedAdded++;
      }
    }
  }
  console.log(`事件题材：同标题补了 ${sharedAdded} 只首板`);
  const eventThemesOf = (item, dayIndex) => {
    const firstDate = days[dayIndex - item.streak + 1];
    if (!events[firstDate]) return null;
    return [...new Set((eventsByKey.get(`${item.code}|${firstDate}`) || []).map(event => event.t))];
  };
  const tagger = makeTagger();
  const months = new Map();
  // 首板的佐证结果：每个概念归到的题材，和有佐证的题材合集
  const evidenceCache = new Map();
  const evidenceOf = key => {
    if (evidenceCache.has(key)) return evidenceCache.get(key);
    const entry = evidence[key];
    let result = null;
    if (entry) {
      const titleOf = id => String(entry.newsIds[Number(String(id).slice(1)) - 1] || '').split('|').slice(1).join('|');
      const concepts = entry.concepts.map(item => ({
        c: item.concept,
        e: item.evidenced ? 1 : 0,
        r: item.reason,
        ...(item.evidenced && item.newsIds[0] ? { n: titleOf(item.newsIds[0]) } : {}),
        ths: themesOf(tagger(item.concept)),
      }));
      result = { concepts, themes: [...new Set(concepts.filter(item => item.e).flatMap(item => item.ths))] };
    }
    evidenceCache.set(key, result);
    return result;
  };
  const firstKey = (item, dayIndex) => `${item.code}|${days[dayIndex - item.streak + 1]}`;
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
  const eventCounts = days.map((date, dayIndex) => {
    const counts = new Map();
    for (const item of stocksOf(date)) for (const theme of eventThemesOf(item, dayIndex) || []) counts.set(theme, (counts.get(theme) || 0) + 1);
    return counts;
  });
  // 每天每个题材有佐证的家数（只数当天涨停原因里有、且首板佐证到这个题材的票）
  const evidenceCounts = days.map((date, dayIndex) => {
    const counts = new Map();
    for (const item of stocksOf(date)) {
      const found = evidenceOf(firstKey(item, dayIndex));
      if (!found) continue;
      for (const theme of themesOf(item.tags)) if (found.themes.includes(theme)) counts.set(theme, (counts.get(theme) || 0) + 1);
    }
    return counts;
  });
  days.forEach((date, dayIndex) => {
    if (date < FIRST_DAY) return;
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, { days: [], news: {}, evidence: {}, events: {} });
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
      const found = evidenceOf(key);
      if (found) {
        row.ev = found.themes;
        if (!target.evidence[key]) target.evidence[key] = found.concepts.map(({ ths, ...rest }) => rest);
      }
      const eventThemes = eventThemesOf(item, dayIndex);
      if (eventThemes) {
        row.et = eventThemes;
        if (eventThemes.length && !target.events[key]) target.events[key] = eventsByKey.get(key);
      }
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
        const evidenceTrend = evidenceCounts.slice(Math.max(0, dayIndex - TREND_DAYS), dayIndex).map(counts => counts.get(name) || 0);
        return { n: name, c: count, l: stocks.filter(stock => stock.ths.includes(name) && stock.s >= 2).length, tr: trend, e: evidenceCounts[dayIndex].get(name) || 0, te: evidenceTrend };
      });
    // 事件题材：今天涨停里属于这个题材的家数、其中连板家数、最高板
    const eventThemes = [...eventCounts[dayIndex].entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([name, count]) => {
        const members = stocks.filter(stock => stock.et?.includes(name));
        return {
          n: name,
          c: count,
          l: members.filter(stock => stock.s >= 2).length,
          top: members.reduce((max, stock) => Math.max(max, stock.s), 0),
          tr: eventCounts.slice(Math.max(0, dayIndex - TREND_DAYS), dayIndex).map(counts => counts.get(name) || 0),
        };
      });
    target.days.push({
      d: date,
      ...(events[date] ? { ed: 1 } : {}),
      ets: eventThemes,
      t: stocks.length,
      top: stocks.reduce((max, stock) => Math.max(max, stock.s), 1),
      first: stocks.filter(stock => stock.s === 1).length,
      imp: stocks.filter(stock => stock.v === '强类' || stock.v === '仅弱类').length,
      evd: stocks.filter(stock => stock.ev).length,
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

  const months = buildMonths(byDay, days, stocksOf, times, readJson(path.join(REPORTS_DIR, 'news-cache.json'), {}), readJson(path.join(REPORTS_DIR, 'news-llm.json'), {}), readJson(path.join(REPORTS_DIR, 'theme-evidence.json'), {}), readJson(path.join(REPORTS_DIR, 'theme-events.json'), {}));
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
  // 事件题材索引（页面搜题材、看全部历史用）：从第一天有事件归类起的全部交易日，每个题材每天的家数、首板/2板/≥3板家数、最高板和最高板的票
  const allDays = [...months.values()].flatMap(month => month.days);
  const firstEventDay = allDays.findIndex(day => day.ed);
  const themeIndex = { days: [], ed: [], themes: {} };
  if (firstEventDay >= 0) {
    allDays.slice(firstEventDay).forEach((day, index) => {
      themeIndex.days.push(day.d);
      themeIndex.ed.push(day.ed ? 1 : 0);
      for (const theme of day.ets) {
        const members = day.stocks.filter(stock => stock.et?.includes(theme.n));
        const top = members.reduce((best, stock) => (stock.s > (best?.s || 0) ? stock : best), null);
        if (!themeIndex.themes[theme.n]) themeIndex.themes[theme.n] = [];
        themeIndex.themes[theme.n].push([index, members.length, top?.s || 0,
          members.filter(stock => stock.s === 1).length, members.filter(stock => stock.s === 2).length, members.filter(stock => stock.s >= 3).length, top?.n || '']);
      }
    });
  }
  writeJson(path.join(OUTPUT_DIR, 'themes.json'), themeIndex);
  if (r2) await r2.writeJson(`${R2_PREFIX}themes.json`, themeIndex);
  console.log(`事件题材索引：${Object.keys(themeIndex.themes).length} 个题材，${themeIndex.days.length} 个交易日`);

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
