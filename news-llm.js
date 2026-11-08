#!/usr/bin/env node
'use strict';

// 用大模型（DeepSeek flash，Anthropic 兼容接口）按 prompts/news-classification.md 逐条判断新闻，
// 结果缓存到 reports/news-llm.json，并和人工核对（reports/<表>.review.json）、关键词规则对比准确率。
// 输入：题材演绎表的股票（reports/四连板题材演绎.json）、新闻缓存（reports/news-cache.json）、
//      新闻原文正文（news-body.js 抓取，缓存 reports/news-body-cache.json）、
//      首板涨停原因（reports/首板涨停原因.json，只用来判断关联）。
// 回测默认不联网：联网搜索拿到的是现在的网页，会混进首板之后的报道（未来信息）。--search 只用于每天实盘。
// 用法: npm run news-llm -- [--limit 20] [--keys 600593|2024-01-03,...] [--only-reviewed]
//                          [--workers 4] [--no-thinking] [--search] [--no-body] [--refresh] [--report 四连板题材演绎]

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classifyNews, cachedNews, NEWS_V2_FROM } = require('./news-theme-table');
const { fetchBodies } = require('./news-body');

const REPORTS_DIR = path.join(__dirname, 'reports');
const PROMPT_FILE = path.join(__dirname, 'prompts', 'news-classification.md');
// 2025-06-01 起（NEWS_V2_FROM）的首板：5 个交易日新闻，不给模型涨停原因（2026-11-06 用户决定）；更早的仍用旧 prompt 和 3 个交易日
const PROMPT_FILE_V2 = path.join(__dirname, 'prompts', 'news-classification-v2.md');
const isV2 = row => String(row['首板日期']) >= NEWS_V2_FROM;
// 2025-06-01 起不参考涨停原因：「【异动解读】××涨停：A+B+C」「××涨停分析」这类标题就是同花顺的涨停原因，不给模型
const REASON_TITLE = /异动解读|涨停分析|涨停原因/;
const newsOf = (newsCache, row) => cachedNews(newsCache[row.key]).filter(item => !isV2(row) || !REASON_TITLE.test(item.title));
const NEWS_CACHE_FILE = path.join(REPORTS_DIR, 'news-cache.json');
const REASON_FILE = path.join(REPORTS_DIR, '首板涨停原因.json');
const OUTPUT_FILE = path.join(REPORTS_DIR, 'news-llm.json');
const FAST_FILE = path.join(REPORTS_DIR, 'news-llm-fast.json');
// DeepSeek 官方 deepseek-flash 价格（元/百万 token，2026-10-29）；高峰为工作日 9–12、14–18 点。
const OFF_PEAK_PRICE = { cached: 0.02, input: 1, output: 4 };
const PEAK_PRICE = { cached: 0.04, input: 2, output: 8 };
const CATEGORY_NAMES = ['政策规范', '新叙事', '行业利好', '海外/明星公司', '资本运作转型', '企业荣誉/重要会议'];
const MAX_SEARCHES = 3;
// 每条新闻给模型的正文片段：最多 2 段，每段取关键词前后各 60 字。
const BODY_SNIPPETS = 2;
const BODY_SNIPPET_RADIUS = 60;

function parseArgs(argv) {
  const options = { report: '四连板题材演绎', limit: 0, keys: [], onlyReviewed: false, workers: 4, search: false, thinking: true, body: true, refresh: false, out: '', cascade: false, yes: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--limit') options.limit = Number(argv[++index]);
    else if (argument === '--keys') options.keys = String(argv[++index] || '').split(',').map(item => item.trim()).filter(Boolean);
    else if (argument === '--only-reviewed') options.onlyReviewed = true;
    else if (argument === '--workers') options.workers = Number(argv[++index]);
    else if (argument === '--search') options.search = true;
    else if (argument === '--no-thinking') options.thinking = false;
    else if (argument === '--no-body') options.body = false;
    else if (argument === '--refresh') options.refresh = true;
    else if (argument === '--report') options.report = String(argv[++index] || '');
    else if (argument === '--out') options.out = String(argv[++index] || '');
    else if (argument === '--cascade') options.cascade = true;
    else if (argument === '--incremental') options.incremental = true;
    else if (argument === '--yes' || argument === '-y') options.yes = true;
    else throw new Error(`未知参数 ${argument}`);
  }
  if (options.incremental && (options.refresh || options.cascade)) throw new Error('--incremental 不能和 --refresh、--cascade 一起用');
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error('--limit 必须是非负整数');
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 16) throw new Error('--workers 必须在 1～16 之间');
  return options;
}

function helpText() {
  return [
    '用法: npm run news-llm -- [--limit 20] [--keys 代码|首板日,...] [--only-reviewed] [--workers 4] [--no-thinking] [--search] [--no-body] [--refresh] [--out 文件名] [--cascade]',
    '',
    '--limit N         只处理前 N 只（按首板日期），0 表示全部',
    '--keys            只处理指定的股票，逗号分隔，格式 代码|首板日',
    '--only-reviewed   只处理已经人工核对过的股票',
    '--workers N       并发请求数，默认 4',
    '--search          给模型联网搜索工具（只支持 Anthropic 格式；会拿到首板之后的报道，只用于实盘，回测不要用）',
    '--no-thinking     关闭模型的思考：输出少约 70%，但 2026-10-29 试跑精确率低 8 个点',
    '--no-body         不抓、不提供新闻原文正文',
    '--refresh         忽略缓存重新调用（prompt、输入改了会自动重新调用，不需要这个参数）',
    '--out 文件名      结果另存到 reports/<文件名>，不覆盖页面读取的 news-llm.json（如关思考对照：--no-thinking --out news-llm-fast.json）',
    '--cascade         分层：先全部关思考跑（存 news-llm-fast.json），关思考结论和关键词规则不一致的再开思考重跑，合并写入 news-llm.json；四连板实测比全开思考省约 35% 费用',
    '--incremental     只判断旧结果里没有的新闻并合并，旧判断原样保留（只改了新闻窗口时用；改了判断标准要用全量重跑）',
    '--report 名称     题材演绎表名称，默认 四连板题材演绎（读取 reports/<名称>.json 和 .review.json）',
    `--yes             需要调用超过 ${CONFIRM_ABOVE} 只时不再询问，直接调用`,
  ].join('\n');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// system 消息：prompt 文件里「## Prompt 正文」之后的全部内容。
function readSystemPrompt(file = PROMPT_FILE) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('## Prompt 正文');
  if (start < 0) throw new Error(`${file} 里找不到「## Prompt 正文」`);
  return text.slice(start + '## Prompt 正文'.length).trim();
}

function newsId(item) {
  return `${item.time}|${item.title}`;
}

// 正文只用来判断关联，所以只给提到本股（名称或代码）的片段；正文没提到本股时，给提到涨停原因关键词的片段。
// 标题已经点名本股的不需要正文。这样每条新闻的输入从 1200 字降到一两百字。
function bodySnippets(text, stockName, code, reasonWords) {
  const find = words => {
    const snippets = [];
    for (const word of words) {
      let index = text.indexOf(word);
      while (index >= 0 && snippets.length < BODY_SNIPPETS) {
        const start = Math.max(0, index - BODY_SNIPPET_RADIUS);
        if (!snippets.some(item => Math.abs(item.start - start) < BODY_SNIPPET_RADIUS)) {
          snippets.push({ start, text: text.slice(start, index + word.length + BODY_SNIPPET_RADIUS) });
        }
        index = text.indexOf(word, index + word.length);
      }
      if (snippets.length >= BODY_SNIPPETS) break;
    }
    return snippets.map(item => item.text.replace(/\s+/g, ' ').trim());
  };
  const stockHits = find([stockName, code].filter(Boolean));
  if (stockHits.length) return { bodyMentions: '本股', body: stockHits.join(' … ') };
  const reasonHits = find(reasonWords);
  if (reasonHits.length) return { bodyMentions: '涨停原因', body: reasonHits.join(' … ') };
  return null;
}

// 2025-06-01 起的首板不给涨停原因：输入里没有 limitUpReason，正文片段也只截点名本股的
function buildInput(row, news, limitUpReason, bodies) {
  const stockName = row['名称'];
  const v2 = isV2(row);
  const reasonWords = v2 ? [] : String(limitUpReason || '').split(/[+＋、,，]/).map(word => word.trim()).filter(word => word.length >= 2);
  return {
    key: row.key,
    stockName,
    code: row['代码'],
    date: row['首板日期'],
    ...(v2 ? {} : { limitUpReason }),
    news: news.map((item, index) => {
      const text = String(bodies?.[item.url]?.text || '');
      const snippet = text && !item.title.includes(stockName) ? bodySnippets(text, stockName, row['代码'], reasonWords) : null;
      return { id: `n${index + 1}`, time: item.time, title: item.title, ...(snippet || {}) };
    }),
  };
}

function hashOf(value) {
  return crypto.createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 12);
}

// 回复里取最后一个 JSON 对象（可能包在 ```json 代码块里）。
function parseReply(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1]);
  const candidates = fenced.length ? fenced.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch { /* 试下一个 */ }
  }
  throw new Error(`回复里没有可解析的 JSON：${text.slice(0, 200)}`);
}

function normalizeResult(parsed, input) {
  const ids = new Set(input.news.map(item => item.id));
  const byId = new Map((Array.isArray(parsed.news) ? parsed.news : []).map(item => [String(item.id), item]));
  const missing = [...ids].filter(id => !byId.has(id));
  if (missing.length) throw new Error(`模型漏判了 ${missing.length} 条新闻：${missing.slice(0, 5).join(',')}`);
  const news = input.news.map(item => {
    const judged = byId.get(item.id);
    const categories = (Array.isArray(judged.categories) ? judged.categories : []).filter(name => CATEGORY_NAMES.includes(name));
    return {
      id: item.id,
      relevant: judged.relevant === true,
      polarity: String(judged.polarity || ''),
      newThing: String(judged.newThing || ''),
      categories,
      important: judged.important === true,
      reason: String(judged.reason || ''),
    };
  });
  const anchorId = ids.has(String(parsed.anchorId)) ? String(parsed.anchorId) : '';
  return {
    news,
    hasImportantNews: news.some(item => item.important),
    anchorId,
    newThing: String(parsed.newThing || ''),
    theme: String(parsed.theme || ''),
    reason: String(parsed.reason || ''),
  };
}

// BASEURL 含 /anthropic 时走 Anthropic 格式（DeepSeek 官方，支持联网搜索），否则走 OpenAI 格式（如阿里百炼）。
function apiFormat() {
  return /\/anthropic\/?$/.test(process.env.BASEURL) ? 'anthropic' : 'openai';
}

// 统一用量字段：input 是没命中缓存的输入，cached 是命中缓存的输入，output 含思考。
function normalizeUsage(usage, format) {
  if (format === 'anthropic') {
    return {
      input: Number(usage.input_tokens || 0),
      cached: Number(usage.cache_read_input_tokens || 0),
      output: Number(usage.output_tokens || 0),
      searches: Number(usage.server_tool_use?.web_search_requests || 0),
    };
  }
  const cached = Number(usage.prompt_tokens_details?.cached_tokens || 0);
  return {
    input: Number(usage.prompt_tokens || 0) - cached,
    cached,
    output: Number(usage.completion_tokens || 0),
    searches: 0,
  };
}

// system 消息每次都一样，放在最前面，后面的请求能命中前缀缓存。
async function callModel(system, input, { useSearch, thinking, maxTokens = 16000 }) {
  const format = apiFormat();
  const base = process.env.BASEURL.replace(/\/$/, '');
  const userContent = JSON.stringify(input);
  let response;
  if (format === 'anthropic') {
    const body = { model: process.env.MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] };
    if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }];
    if (!thinking) body.thinking = { type: 'disabled' };
    response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.APIKEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  } else {
    if (useSearch) throw new Error('OpenAI 格式接口不支持 --search');
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.APIKEY}` },
      body: JSON.stringify({
        model: process.env.MODEL,
        max_tokens: maxTokens,
        enable_thinking: Boolean(thinking),
        messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
      }),
      signal: AbortSignal.timeout(300_000),
    });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || payload.message || `HTTP ${response.status}`);
  if (format === 'openai') {
    return { text: payload.choices?.[0]?.message?.content || '', searches: [], sources: [], usage: normalizeUsage(payload.usage || {}, format) };
  }
  const text = (payload.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const searches = (payload.content || []).filter(block => block.type === 'server_tool_use').map(block => block.input?.query || '');
  const sources = (payload.content || [])
    .filter(block => block.type === 'web_search_tool_result' && Array.isArray(block.content))
    .flatMap(block => block.content.filter(item => item.type === 'web_search_result').map(item => ({ title: item.title, url: item.url })));
  return { text, searches, sources, usage: normalizeUsage(payload.usage || {}, format) };
}

// limitUpReason 单独传进来只为存档（页面显示用），2026 年起不在 input 里，不给模型
async function judgeStock(system, promptHash, input, news, { useSearch, thinking, limitUpReason }) {
  const base = {
    key: input.key, promptHash, inputHash: hashOf(input), model: process.env.MODEL, search: useSearch, thinking,
    limitUpReason, newsIds: news.map(newsId), bodies: input.news.filter(item => item.body).length,
    fetchedAt: new Date().toISOString(),
  };
  // 没有新闻：不用调用模型。
  if (!news.length) return { ...base, result: normalizeResult({ news: [] }, input), searches: [], sources: [], usage: {} };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await callModel(system, input, { useSearch, thinking });
      return { ...base, result: normalizeResult(parseReply(reply.text), input), searches: reply.searches, sources: reply.sources, usage: reply.usage };
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

// 增量判断：旧判断里已有的新闻（按 时间|标题 对应）原样保留，只把新增的新闻送模型，再按当前新闻顺序合并。
// 判断重要与否只看单条标题，所以逐条结果可以合并；已不在当前新闻里的旧判断丢弃。
// 锚定新闻：旧锚定还在就保留，否则取模型对新增新闻选的锚定，都没有时取最早一条重要新闻。
async function judgeStockIncremental(system, promptHash, input, news, old, { useSearch, thinking, limitUpReason }) {
  const ids = news.map(newsId);
  const oldItem = item => old.newsIds[Number(item.id.slice(1)) - 1];
  const kept = new Map(old.result.news.map(item => [oldItem(item), item]));
  const freshIndexes = ids.flatMap((id, index) => (kept.has(id) ? [] : [index]));
  let fresh = null;
  if (freshIndexes.length) {
    const subInput = { ...input, news: freshIndexes.map((index, position) => ({ ...input.news[index], id: `n${position + 1}` })) };
    fresh = await judgeStock(system, promptHash, subInput, freshIndexes.map(index => news[index]), { useSearch, thinking, limitUpReason });
  }
  const freshAt = new Map(freshIndexes.map((index, position) => [index, fresh.result.news[position]]));
  const merged = ids.map((id, index) => ({ ...(kept.get(id) || freshAt.get(index)), id: `n${index + 1}` }));

  const importantAt = id => {
    const index = ids.indexOf(id);
    return index >= 0 && merged[index].important ? merged[index] : null;
  };
  const oldAnchor = old.result.anchorId ? importantAt(old.newsIds[Number(old.result.anchorId.slice(1)) - 1]) : null;
  const freshAnchorIndex = fresh?.result.anchorId ? freshIndexes[Number(fresh.result.anchorId.slice(1)) - 1] : -1;
  const earliest = merged.filter(item => item.important)
    .sort((left, right) => news[Number(left.id.slice(1)) - 1].time.localeCompare(news[Number(right.id.slice(1)) - 1].time))[0];
  const anchor = oldAnchor || (freshAnchorIndex >= 0 && merged[freshAnchorIndex].important ? merged[freshAnchorIndex] : earliest) || null;
  // 整只票的说明跟着锚定来源走：旧锚定用旧说明，否则用新增部分的说明；都没有重要新闻时保留旧说明。
  const summary = oldAnchor || !fresh?.result.hasImportantNews ? old.result : fresh.result;
  const hasImportantNews = merged.some(item => item.important);
  return {
    key: input.key,
    promptHash,
    inputHash: hashOf(input),
    model: process.env.MODEL,
    search: useSearch,
    thinking,
    limitUpReason,
    newsIds: ids,
    bodies: input.news.filter(item => item.body).length,
    fetchedAt: new Date().toISOString(),
    result: {
      news: merged,
      hasImportantNews,
      anchorId: anchor ? anchor.id : '',
      newThing: hasImportantNews ? (summary.newThing || anchor.newThing) : '',
      theme: summary.theme || '',
      reason: hasImportantNews ? (summary.reason || anchor.reason) : (summary.reason || ''),
    },
    searches: fresh?.searches || [],
    sources: fresh?.sources || [],
    usage: fresh?.usage || {},
    incremental: { fromPrompt: old.promptHash, fromInputHash: old.inputHash, kept: ids.length - freshIndexes.length, judged: freshIndexes.length, dropped: old.newsIds.filter(id => !ids.includes(id)).length },
  };
}

function percent(part, total) {
  return total ? `${(part / total * 100).toFixed(1)}%` : '--';
}

// 和人工核对比：有无重要新闻一致率、锚定命中、逐条精确率/召回率；同时算关键词规则做对照。
function compare(rows, saved, reviews, newsCache) {
  const stats = {
    llm: { stocks: 0, agree: 0, anchorCases: 0, anchorHits: 0, both: 0, userOnly: 0, autoOnly: 0 },
    rule: { stocks: 0, agree: 0, anchorCases: 0, anchorHits: 0, both: 0, userOnly: 0, autoOnly: 0 },
  };
  const disagreements = [];
  for (const row of rows) {
    const entry = saved[row.key];
    const review = reviews[row.key];
    if (!entry || !review) continue;
    const news = newsOf(newsCache, row);
    const ids = news.map(newsId);
    if (ids.join('\n') !== entry.newsIds.join('\n')) continue;
    const selected = new Set(review.noImportant ? [] : review.selected.filter(id => ids.includes(id)));
    const llmPicked = new Set(entry.result.news.filter(item => item.important).map(item => ids[Number(item.id.slice(1)) - 1]));
    const llmAnchor = entry.result.anchorId ? ids[Number(entry.result.anchorId.slice(1)) - 1] : '';
    const rulePicked = new Set(news.filter(item => classifyNews(item, row['名称']).score > 0).map(newsId));
    for (const [name, picked, anchor] of [['llm', llmPicked, llmAnchor], ['rule', rulePicked, '']]) {
      const stat = stats[name];
      stat.stocks++;
      if ((selected.size > 0) === (picked.size > 0)) stat.agree++;
      if (anchor && selected.size) {
        stat.anchorCases++;
        if (selected.has(anchor)) stat.anchorHits++;
      }
      for (const id of ids) {
        if (selected.has(id) && picked.has(id)) stat.both++;
        else if (selected.has(id)) stat.userOnly++;
        else if (picked.has(id)) stat.autoOnly++;
      }
    }
    if ((selected.size > 0) !== (llmPicked.size > 0)) {
      disagreements.push(`${row['首板日期']} ${row['名称']}：你${selected.size ? '有' : '无'}，模型${llmPicked.size ? '有' : '无'}。${entry.result.reason}`);
    }
  }
  return { stats, disagreements };
}

function printStats({ stats, disagreements }) {
  const line = (label, stat) => `${label}：核对 ${stat.stocks} 只，有无重要新闻一致 ${percent(stat.agree, stat.stocks)}`
    + `，逐条精确率 ${percent(stat.both, stat.both + stat.autoOnly)}，召回率 ${percent(stat.both, stat.both + stat.userOnly)}`
    + (stat.anchorCases ? `，锚定命中 ${percent(stat.anchorHits, stat.anchorCases)}` : '');
  console.log(line('大模型  ', stats.llm));
  console.log(line('关键词规则', stats.rule));
  if (disagreements.length) {
    console.log(`\n有无重要新闻不一致的 ${disagreements.length} 只（最多列 15 只）：`);
    disagreements.slice(0, 15).forEach(item => console.log(`- ${item}`));
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  for (const name of ['BASEURL', 'APIKEY', 'MODEL']) {
    if (!process.env[name]) throw new Error(`.env 里缺少 ${name}`);
  }
  // 两版 prompt：按首板日选，缓存也按各自的 prompt hash 判断
  const prompts = Object.fromEntries([['v1', PROMPT_FILE], ['v2', PROMPT_FILE_V2]].map(([name, file]) => {
    const system = readSystemPrompt(file);
    return [name, { system, promptHash: hashOf(system) }];
  }));
  const promptOf = row => prompts[isV2(row) ? 'v2' : 'v1'];
  const report = readJson(path.join(REPORTS_DIR, `${options.report}.json`), null);
  if (!report) throw new Error(`找不到 reports/${options.report}.json，请先运行 npm run news-theme`);
  const reviews = readJson(path.join(REPORTS_DIR, `${options.report}.review.json`), {});
  const newsCache = readJson(NEWS_CACHE_FILE, {});
  const reasons = readJson(REASON_FILE, {});
  // --out 另存一份（如关思考的对照结果），不覆盖页面读取的 news-llm.json。
  const outputFile = options.out ? path.join(REPORTS_DIR, path.basename(options.out)) : OUTPUT_FILE;
  const saved = readJson(outputFile, {});

  let rows = [...report.rows].sort((left, right) => left['首板日期'].localeCompare(right['首板日期']) || left['代码'].localeCompare(right['代码']));
  if (options.keys.length) rows = rows.filter(row => options.keys.includes(row.key));
  if (options.onlyReviewed) rows = rows.filter(row => reviews[row.key]);
  if (options.limit) rows = rows.slice(0, options.limit);
  // 新闻没获取到（接口超时等）的不送模型：空列表会被判成「没有重要新闻」并缓存下来，下次重跑 news-theme 再补
  const unfetched = rows.filter(row => !newsCache[row.key]);
  if (unfetched.length) {
    console.log(`新闻没获取到 ${unfetched.length} 只，跳过：${unfetched.map(row => `${row.key} ${row['名称']}`).join('、')}`);
    rows = rows.filter(row => newsCache[row.key]);
  }

  // 先抓这些股票的新闻原文（有缓存，抓过的跳过）。
  let bodies = {};
  if (options.body) {
    const items = rows.flatMap(row => newsOf(newsCache, row).map(item => ({ url: item.url, title: item.title })));
    const started = Date.now();
    bodies = await fetchBodies(items, {
      workers: 6,
      onProgress: (done, total) => process.stdout.write(`\r抓新闻原文 ${done}/${total}，用时 ${Math.round((Date.now() - started) / 1000)} 秒`),
    });
    process.stdout.write('\n');
  }
  const inputs = new Map(rows.map(row => [row.key, buildInput(row, newsOf(newsCache, row), reasons[row.key]?.reason || '', bodies)]));

  const newsCount = [...inputs.values()].reduce((sum, input) => sum + input.news.length, 0);
  const bodyCount = [...inputs.values()].reduce((sum, input) => sum + input.news.filter(item => item.body).length, 0);
  console.log(`股票 ${rows.length} 只（新闻 ${newsCount} 条，有正文 ${bodyCount} 条），${process.env.MODEL}，`
    + `${apiFormat() === 'anthropic' ? 'Anthropic' : 'OpenAI'} 格式，prompt ${prompts.v1.promptHash}（${NEWS_V2_FROM} 前）/ ${prompts.v2.promptHash}（${NEWS_V2_FROM} 起，不给涨停原因），${options.search ? '联网搜索' : '不联网'}`);
  const context = { promptOf, inputs, newsCache, reasons, options };
  let failed = 0;
  if (options.cascade) {
    // 分层：先全部关思考跑，关思考结论和关键词规则不一致的再开思考重跑。
    const fastSaved = readJson(FAST_FILE, {});
    failed += await runCalls(rows, false, fastSaved, FAST_FILE, context, '第一轮 关思考');
    const ruleHas = row => newsOf(newsCache, row).some(item => classifyNews(item, row['名称']).score > 0);
    const escalate = rows.filter(row => !fastSaved[row.key] || fastSaved[row.key].result.hasImportantNews !== ruleHas(row));
    console.log(`关思考结论和关键词规则不一致 ${escalate.length} 只（${percent(escalate.length, rows.length)}），开思考重跑`);
    failed += await runCalls(escalate, true, saved, outputFile, context, '第二轮 开思考');
    const escalated = new Set(escalate.map(row => row.key));
    for (const row of rows) {
      if (escalated.has(row.key)) {
        if (saved[row.key]) saved[row.key].cascade = '开思考重跑';
      } else if (fastSaved[row.key]) {
        saved[row.key] = { ...fastSaved[row.key], cascade: '关思考' };
      }
    }
    fs.writeFileSync(outputFile, `${JSON.stringify(saved, null, 1)}
`, 'utf8');
  } else {
    failed += await runCalls(rows, options.thinking, saved, outputFile, context, options.thinking ? '开思考' : '关思考');
  }
  console.log('');
  printStats(compare(rows, saved, reviews, newsCache));
  if (failed) process.exitCode = 1;
}

// 一次要调用的股票超过这个数先确认，免得误跑全样本花太多 token
const CONFIRM_ABOVE = 100;
// 2026-10 实测开思考每只约 0.01 元（空闲时段），高峰翻倍
const YUAN_PER_STOCK = 0.01;

async function confirmLargeRun(count, options) {
  if (count <= CONFIRM_ABOVE || options.yes) return;
  const message = `需要调用大模型 ${count} 只，超过 ${CONFIRM_ABOVE} 只，按实测约 ${(count * YUAN_PER_STOCK).toFixed(1)} 元（空闲）/ ${(count * YUAN_PER_STOCK * 2).toFixed(1)} 元（高峰）`;
  if (!process.stdin.isTTY) throw new Error(`${message}。确认后加 --yes 重跑`);
  const readline = require('readline/promises');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${message}，继续吗？(y/N) `);
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error('已取消，没有调用大模型');
}

// 缓存有效：prompt、搜索开关、思考开关、模型和输入（新闻、正文、涨停原因）都没变。返回失败只数。
async function runCalls(rows, thinking, saved, file, { promptOf, inputs, newsCache, reasons, options }, label) {
  const isFresh = row => {
    const entry = saved[row.key];
    return entry && !options.refresh && entry.promptHash === promptOf(row).promptHash && entry.search === options.search
      && Boolean(entry.thinking) === thinking && entry.model === process.env.MODEL
      && entry.inputHash === hashOf(inputs.get(row.key));
  };
  const todo = rows.filter(row => !isFresh(row));
  // 增量时没有新增新闻的票只合并旧判断，不调用模型，不计入需要确认的只数
  const calls = options.incremental
    ? todo.filter(row => !saved[row.key] || newsOf(newsCache, row).some(item => !saved[row.key].newsIds.includes(newsId(item)))).length
    : todo.length;
  console.log(`${label}：${rows.length} 只，缓存可用 ${rows.length - todo.length} 只，需要处理 ${todo.length} 只，其中调用模型 ${calls} 只`);
  await confirmLargeRun(calls, options);
  let next = 0;
  let done = 0;
  let failed = 0;
  const usage = { input: 0, cached: 0, output: 0, searches: 0 };
  const started = Date.now();
  async function worker() {
    while (next < todo.length) {
      const row = todo[next++];
      try {
        const news = newsOf(newsCache, row);
        const settings = { useSearch: options.search, thinking, limitUpReason: reasons[row.key]?.reason || '' };
        const { system, promptHash } = promptOf(row);
        const old = options.incremental ? saved[row.key] : null;
        const entry = old
          ? await judgeStockIncremental(system, promptHash, inputs.get(row.key), news, old, settings)
          : await judgeStock(system, promptHash, inputs.get(row.key), news, settings);
        saved[row.key] = entry;
        for (const field of Object.keys(usage)) usage[field] += Number(entry.usage[field] || 0);
      } catch (error) {
        failed++;
        console.error(`
${row.key} ${row['名称']} 失败：${error.message}`);
      }
      done++;
      if (done % 5 === 0 || done === todo.length) {
        fs.writeFileSync(file, `${JSON.stringify(saved, null, 1)}
`, 'utf8');
        process.stdout.write(`已完成 ${done}/${todo.length}，失败 ${failed}，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.workers, todo.length) }, worker));
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(saved, null, 1)}
`, 'utf8');
  if (todo.length) {
    const totalInput = usage.input + usage.cached;
    const cacheRate = totalInput ? Math.round(usage.cached / totalInput * 100) : 0;
    const cost = price => (usage.cached * price.cached + usage.input * price.input + usage.output * price.output) / 1e6;
    console.log(`
输入 ${totalInput} token（命中缓存 ${usage.cached}，${cacheRate}%），输出 ${usage.output} token，`
      + `搜索 ${usage.searches} 次；按 DeepSeek 官方价约 ${cost(OFF_PEAK_PRICE).toFixed(2)} 元（空闲）/ ${cost(PEAK_PRICE).toFixed(2)} 元（高峰）。`
      + `已写入 ${path.relative(__dirname, file)}`);
  }
  return failed;
}

module.exports = { OUTPUT_FILE, readSystemPrompt, callModel, parseReply, hashOf, apiFormat, OFF_PEAK_PRICE, PEAK_PRICE };

if (require.main === module) {
  main().catch(error => {
    console.error(`大模型新闻判断失败: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
