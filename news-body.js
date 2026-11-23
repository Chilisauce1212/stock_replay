#!/usr/bin/env node
'use strict';

// 抓新闻链接的原文正文，给大模型判断新闻用：股票名称、事件原因经常只出现在正文里。
// 同花顺新闻页（news./t./mp.10jqka.com.cn）和微信文章要执行脚本才有正文，所以用无头 Chrome 渲染后取文字；
// 其中同花顺号文章（mp.10jqka.com.cn）先直接取页面调用的正文接口，失败再用浏览器。
// 正文按链接缓存在 reports/news-body-cache.json，抓过的不再抓（失败的也记下：3 天内、累计失败不满 3 次的自动重抓，--retry-failed 全部重抓）。
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

// 同花顺号文章（mp.10jqka.com.cn/...?contentId=xxx）的正文直接取页面自己调用的公开接口，不开浏览器（2026-11-18 起）：
// 服务器只有 2 核，浏览器渲染一篇要 2 秒多，接口 0.1 秒。不是这类链接返回 null；接口失败抛错，由调用方退回浏览器。
// news.10jqka.com.cn 的接口地址要用页面脚本里的混淆算法编码文章号，不去还原，仍用浏览器。
const MP_API = 'https://mp.10jqka.com.cn/lgt/article_query/open/api/article/v1/detail?content_id=';
const ENTITIES = { nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', hellip: '…', middot: '·' };

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

async function fetchViaApi(url, title) {
  let contentId;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'mp.10jqka.com.cn') return null;
    contentId = parsed.searchParams.get('contentId');
  } catch {
    return null;
  }
  if (!contentId) return null;
  const response = await fetch(`${MP_API}${encodeURIComponent(contentId)}`, { headers: { 'user-agent': MOBILE_UA }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`正文接口 HTTP ${response.status}`);
  const json = await response.json();
  if (json.status_code !== 0 || !json.data?.content) throw new Error(`正文接口: ${json.status_msg || '没有正文'}`);
  const text = `${json.data.title || title || ''} ${htmlToText(json.data.content)}`.replace(/\s+/g, ' ').trim();
  if (text.length < 30) throw new Error('正文接口: 正文太短');
  return text.slice(0, STORED_LENGTH);
}

// 同花顺页面偶尔超时或中途跳转，失败隔 2 秒重试一次。
async function fetchOne(context, url, title) {
  try {
    return await fetchOnce(context, url, title);
  } catch {
    await new Promise(resolve => setTimeout(resolve, 2000));
    return fetchOnce(context, url, title);
  }
}

// 没渲染完的同花顺页面只有外壳文字（「Fix Bug of Android render…」几十个字）或「服务器太忙啦」，不能当正文存
// （2026-11-18 服务器 CPU 紧时 18% 的同花顺正文是这种外壳，以前超过 30 字就当正文存了）
const looksLikeShell = text => text.length < 200 && /Fix Bug of Android render|服务器太忙/.test(text);

async function fetchOnce(context, url, title) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    let text = await extractText(page, title);
    if (looksLikeShell(text)) {
      // 还在渲染：再等正文出来（最多 8 秒）
      await page.waitForFunction(() => String(document.body?.innerText || '').length > 300, null, { timeout: 8_000, polling: 300 }).catch(() => {});
      text = await extractText(page, title);
    }
    if (/doesn't work properly without JavaScript/.test(text) || text.length < 30) throw new Error('页面没有正文');
    if (looksLikeShell(text)) throw new Error('页面没渲染完（只有外壳）');
    return text.slice(0, STORED_LENGTH);
  } finally {
    await page.close().catch(() => {});
  }
}

// 失败的链接自动重抓（2026-11-23 加）：以前失败一次就记进缓存、以后再也不抓，网络抖一下那篇正文就永远缺了。
// 现在最近 3 天内失败、累计不满 3 次的，下次遇到会再抓；本身就没有正文的页面最多也只多试 2 次。
const AUTO_RETRY_TIMES = 3;
const AUTO_RETRY_DAYS = 3;
const shouldAutoRetry = saved => saved.error && (saved.attempts || 1) < AUTO_RETRY_TIMES
  && Date.now() - Date.parse(saved.fetchedAt || 0) < AUTO_RETRY_DAYS * 86400e3;

// items: [{ url, title }]。抓缓存里没有的链接，返回更新后的缓存。
async function fetchBodies(items, { workers = 6, retryFailed = false, onProgress } = {}) {
  const cache = readBodyCache();
  const seen = new Set();
  let retrying = 0;
  const todo = items.filter(item => {
    if (!/^https?:\/\//.test(item.url) || seen.has(item.url)) return false;
    seen.add(item.url);
    const saved = cache[item.url];
    if (saved?.error && (retryFailed || shouldAutoRetry(saved))) {
      retrying++;
      return true;
    }
    return !saved || (saved.text && looksLikeShell(saved.text)); // 以前存下的外壳也重抓
  });
  if (!todo.length) return cache;
  if (retrying) console.log(`重抓上次失败的正文 ${retrying} 篇`);
  // 新闻站点都在国内，走系统代理（如 7897）经常超时，直连约 0.5 秒。
  // 本机用系统装的 Chrome；服务器上没有 Chrome，退回 Playwright 自带的 Chromium（npx playwright install chromium）
  // 浏览器用到时才启动（全是接口能取的链接时不启动）
  let browserPromise;
  const getContext = () => {
    browserPromise ||= (async () => {
      const launchOptions = { headless: true, args: ['--no-proxy-server'] };
      const browser = await chromium.launch({ ...launchOptions, channel: 'chrome' })
        .catch(() => chromium.launch(launchOptions));
      const context = await browser.newContext({ userAgent: MOBILE_UA, viewport: { width: 390, height: 844 } });
      // 图片、字体、媒体不影响正文，拦掉加快速度。
      await context.route('**/*', route => (
        ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()
      ));
      return { browser, context };
    })();
    return browserPromise.then(({ context }) => context);
  };
  const viaApi = { ok: 0, fallback: 0 };
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < todo.length) {
      const item = todo[next++];
      try {
        let text = null;
        try {
          text = await fetchViaApi(item.url, item.title);
          if (text) viaApi.ok++;
        } catch {
          viaApi.fallback++; // 接口失败，退回浏览器
        }
        text ||= await fetchOne(await getContext(), item.url, item.title);
        cache[item.url] = { text, fetchedAt: new Date().toISOString() };
      } catch (error) {
        const attempts = (cache[item.url]?.error ? cache[item.url].attempts || 1 : 0) + 1; // 累计失败次数，给自动重抓判断
        cache[item.url] = { text: '', error: String(error.message || error).slice(0, 200), attempts, fetchedAt: new Date().toISOString() };
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
    if (browserPromise) await browserPromise.then(({ browser }) => browser.close()).catch(() => {});
  }
  if (viaApi.ok || viaApi.fallback) console.log(`\n同花顺号正文接口取到 ${viaApi.ok} 篇，接口失败退回浏览器 ${viaApi.fallback} 篇`);
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

module.exports = { fetchBodies, readBodyCache, fetchViaApi, BODY_CACHE_FILE };

if (require.main === module) {
  main().catch(error => {
    console.error(`抓取新闻原文失败: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
