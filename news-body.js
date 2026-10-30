#!/usr/bin/env node
'use strict';

// 抓新闻链接的原文正文，给大模型判断新闻用：股票名称、事件原因经常只出现在正文里。
// 同花顺新闻页（news./t./mp.10jqka.com.cn）和微信文章要执行脚本才有正文，所以用无头 Chrome 渲染后取文字。
// 正文按链接缓存在 reports/news-body-cache.json，抓过的不再抓（失败的也记下，--retry-failed 重抓）。
// 用法: npm run news-body -- [--report 四连板题材演绎] [--workers 6] [--retry-failed]

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { cachedNews } = require('./news-theme-table');

const REPORTS_DIR = path.join(__dirname, 'reports');
const BODY_CACHE_FILE = path.join(REPORTS_DIR, 'news-body-cache.json');
const NEWS_CACHE_FILE = path.join(REPORTS_DIR, 'news-cache.json');
// 缓存里多存一些，给模型时再截取。
const STORED_LENGTH = 3000;
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

function readBodyCache() {
  try {
    return JSON.parse(fs.readFileSync(BODY_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeBodyCache(cache) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const temporary = `${BODY_CACHE_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cache)}\n`, 'utf8');
  fs.renameSync(temporary, BODY_CACHE_FILE);
}

// 在页面里取正文：优先从标题出现的位置往后截（避开导航栏），找不到标题就取链接文字最少的大块。
async function extractText(page, title) {
  return page.evaluate(({ title }) => {
    const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
    const full = clean(document.body?.innerText);
    const probe = clean(title).slice(0, 12);
    const index = probe ? full.indexOf(probe) : -1;
    if (index >= 0 && full.length - index > 60) return full.slice(index);
    const blocks = [...document.querySelectorAll('article, main, section, div')]
      .map(element => ({ element, text: clean(element.innerText) }))
      .filter(item => item.text.length > 80);
    const score = item => item.text.length
      - [...item.element.querySelectorAll('a')].reduce((sum, link) => sum + clean(link.innerText).length, 0) * 2;
    blocks.sort((left, right) => score(right) - score(left));
    return blocks[0]?.text || full;
  }, { title });
}

// 同花顺页面偶尔超时或中途跳转，失败重试一次。
async function fetchOne(context, url, title) {
  try {
    return await fetchOnce(context, url, title);
  } catch {
    return fetchOnce(context, url, title);
  }
}

async function fetchOnce(context, url, title) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    const text = await extractText(page, title);
    if (/doesn't work properly without JavaScript/.test(text) || text.length < 30) throw new Error('页面没有正文');
    return text.slice(0, STORED_LENGTH);
  } finally {
    await page.close().catch(() => {});
  }
}

// items: [{ url, title }]。抓缓存里没有的链接，返回更新后的缓存。
async function fetchBodies(items, { workers = 6, retryFailed = false, onProgress } = {}) {
  const cache = readBodyCache();
  const seen = new Set();
  const todo = items.filter(item => {
    if (!/^https?:\/\//.test(item.url) || seen.has(item.url)) return false;
    seen.add(item.url);
    const saved = cache[item.url];
    return !saved || (retryFailed && saved.error);
  });
  if (!todo.length) return cache;
  // 新闻站点都在国内，走系统代理（如 7897）经常超时，直连约 0.5 秒。
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const context = await browser.newContext({ userAgent: MOBILE_UA, viewport: { width: 390, height: 844 } });
  // 图片、字体、媒体不影响正文，拦掉加快速度。
  await context.route('**/*', route => (
    ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()
  ));
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < todo.length) {
      const item = todo[next++];
      try {
        cache[item.url] = { text: await fetchOne(context, item.url, item.title), fetchedAt: new Date().toISOString() };
      } catch (error) {
        cache[item.url] = { text: '', error: String(error.message || error).slice(0, 200), fetchedAt: new Date().toISOString() };
      }
      done++;
      if (done % 20 === 0 || done === todo.length) {
        writeBodyCache(cache);
        onProgress?.(done, todo.length);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(workers, todo.length) }, worker));
  } finally {
    writeBodyCache(cache);
    await browser.close().catch(() => {});
  }
  return cache;
}

function parseArgs(argv) {
  const options = { report: '四连板题材演绎', workers: 6, retryFailed: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--report') options.report = String(argv[++index] || '');
    else if (argument === '--workers') options.workers = Number(argv[++index]);
    else if (argument === '--retry-failed') options.retryFailed = true;
    else throw new Error(`未知参数 ${argument}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('用法: npm run news-body -- [--report 四连板题材演绎] [--workers 6] [--retry-failed]');
    return;
  }
  const report = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, `${options.report}.json`), 'utf8'));
  const newsCache = JSON.parse(fs.readFileSync(NEWS_CACHE_FILE, 'utf8'));
  const items = report.rows.flatMap(row => cachedNews(newsCache[row.key]).map(item => ({ url: item.url, title: item.title })));
  const started = Date.now();
  const cache = await fetchBodies(items, {
    workers: options.workers,
    retryFailed: options.retryFailed,
    onProgress: (done, total) => process.stdout.write(`\r已抓 ${done}/${total}，用时 ${Math.round((Date.now() - started) / 1000)} 秒`),
  });
  const urls = [...new Set(items.map(item => item.url).filter(url => /^https?:\/\//.test(url)))];
  const ok = urls.filter(url => cache[url]?.text).length;
  console.log(`\n新闻链接 ${urls.length} 个，有正文 ${ok} 个，失败 ${urls.length - ok} 个。缓存 ${path.relative(__dirname, BODY_CACHE_FILE)}`);
}

module.exports = { fetchBodies, readBodyCache, BODY_CACHE_FILE };

if (require.main === module) {
  main().catch(error => {
    console.error(`抓取新闻原文失败: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
