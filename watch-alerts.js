#!/usr/bin/env node
'use strict';

// 盘中盯自选（2026-11-19）：在软路由上交易日 9:14 启动，15:01 自己退出（cron 见 deploy/router-setup.sh）。
//   - 名单：同花顺自选（t.10jqka.com.cn 的 getSelfStockWithMarket，登录 cookie 在 reports/ths-state.json），每分钟刷新（用户盘中会改自选），只留 A 股
//   - 行情：新浪 hq.sinajs.cn，一次请求查完整个名单，每 3 秒一次（免费行情本身就是 3 秒一跳）
//   - 提醒（Bark，分组「盯盘」），每只股票都发：
//       冲高：涨幅 ≥ --rise（默认 6%），一天一次；回落到 --rise - 2 以下后再冲上去会再提醒
//       封板：涨停价上卖一挂单为 0；封单 = 买一量
//       封单减少：封住后封单降到峰值的 --seal-drop（默认 50%）以下，每次封板只提醒一次（时效性通知）
//       炸板：封住过、现价离开涨停价或卖一出现挂单（时效性通知）
//   - 同花顺登录失效：用上次的名单继续盯，并提醒一次重新导出；登录 2 天内过期也提醒
//   - 不是交易日（新浪行情日期不是今天）：直接退出，不提醒
// 用法: node watch-alerts.js [--rise 6] [--seal-drop 0.5] [--poll 3] [--until 15:01] [--extra sz002418,...] [--dry-run（只打日志不推送）]
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const options = { rise: 6, sealDrop: 0.5, poll: 3, listMinutes: 1, until: '15:01', dryRun: false, extra: [] };
for (let index = 2; require.main === module && index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--dry-run') options.dryRun = true;
  else if (arg === '--rise') options.rise = Number(process.argv[++index]);
  else if (arg === '--seal-drop') options.sealDrop = Number(process.argv[++index]);
  else if (arg === '--poll') options.poll = Number(process.argv[++index]);
  else if (arg === '--until') options.until = process.argv[++index];
  else if (arg === '--extra') options.extra = process.argv[++index].split(',').filter(Boolean); // 测试用：自选之外再加几只，如 sz002418,sz000838
  else throw new Error(`不认识的参数 ${arg}`);
}

const STATE_FILE = process.env.THS_STATE_FILE || path.join(__dirname, 'reports', 'ths-state.json');
const SELF_STOCK_URL = 'https://t.10jqka.com.cn/newcircle/group/getSelfStockWithMarket/';
const NOT_A_SHARE_MARKETS = new Set(['16', '32', '48']); // 沪深指数、同花顺板块
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const beijing = () => new Date(Date.now() + 8 * 3600e3);
const today = () => beijing().toISOString().slice(0, 10);
const clock = () => beijing().toISOString().slice(11, 16);
const log = message => console.log(`[${beijing().toISOString().slice(11, 19)}] ${message}`);

// 用户主要用 AirPods 听（Siri 朗读通知），所以推送只有一句短话、不带标题，如「康盛股份 冲高6.5%」；
// 太长 Siri 会先问要不要朗读、读得也慢。细节只写日志。全部用时效性（专注模式下也响）
async function notify(spoken, detail = '') {
  log(`${options.dryRun ? '（不推送）' : '推送'}${spoken}${detail ? `｜${detail}` : ''}`);
  const base = String(process.env.BARK_URL || '').replace(/\/+$/, '');
  if (!base || options.dryRun) return;
  // 点通知打开同花顺 App（amihexin:// 实测能拉起 App；跳到个股的格式还没找到，网页个股页只会开浏览器）
  const query = new URLSearchParams({ group: '盯盘', level: 'timeSensitive', url: 'amihexin://' });
  try {
    const response = await fetch(`${base}/${encodeURIComponent(spoken)}?${query}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) log(`Bark 推送失败：HTTP ${response.status}`);
  } catch (error) {
    log(`Bark 推送失败：${error.message}`);
  }
}

// ---------- 名单：同花顺自选 ----------
const warnedToday = new Set();
async function warnOnce(key, title, body) {
  if (warnedToday.has(key)) return;
  warnedToday.add(key);
  await notify(title, body);
}

function readCookies() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const login = state.cookies.filter(cookie => ['userid', 'ticket'].includes(cookie.name));
  const expiry = Math.min(...login.map(cookie => (cookie.expires > 0 ? cookie.expires * 1000 : Infinity)));
  return { header: state.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), expiry };
}

function exchangeOf(code) {
  if (/^(60|68|90)/.test(code)) return 'sh';
  if (/^(00|30|20)/.test(code)) return 'sz';
  if (/^(4|8|92)/.test(code)) return 'bj';
  return null;
}

async function fetchWatchlist() {
  const { header, expiry } = readCookies();
  const daysLeft = (expiry - Date.now()) / 86400e3;
  if (daysLeft < 2) await warnOnce('expiry', '同花顺登录快过期', `还剩 ${Math.max(0, daysLeft).toFixed(1)} 天，到期后盯盘拿不到自选，记得重新导出登录状态`);
  const response = await fetch(SELF_STOCK_URL, {
    headers: { Cookie: header, Referer: 'https://t.10jqka.com.cn/newcircle/user/userPersonal/?from=finance&tab=zx' },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = JSON.parse(text.replace(/^[^(]*\(|\);?\s*$/g, ''));
  if (data.errorCode !== 0 || !Array.isArray(data.result)) throw new Error(`errorCode ${data.errorCode} ${data.errorMsg || ''}`.trim());
  return data.result
    .filter(item => /^\d{6}$/.test(item.code) && !NOT_A_SHARE_MARKETS.has(String(item.marketid)) && exchangeOf(item.code))
    .map(item => `${exchangeOf(item.code)}${item.code}`);
}

// ---------- 行情：新浪 ----------
const gbk = new TextDecoder('gbk');
async function fetchQuotes(symbols) {
  const response = await fetch(`https://hq.sinajs.cn/list=${symbols.join(',')}`, {
    headers: { Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`新浪行情 HTTP ${response.status}`);
  const text = gbk.decode(await response.arrayBuffer());
  const quotes = [];
  for (const match of text.matchAll(/hq_str_(\w+)="([^"]*)"/g)) {
    const fields = match[2].split(',');
    if (fields.length < 32) continue;
    const number = index => Number(fields[index]);
    quotes.push({
      symbol: match[1], name: fields[0], prevClose: number(2), price: number(3),
      bid1: { volume: number(10), price: number(11) }, ask1: { volume: number(20), price: number(21) },
      date: fields[30], time: fields[31],
    });
  }
  return quotes;
}

// 涨停价（四舍五入到分）：创业板/科创板 20%，北交所 30%，主板 10%。
// 主板 ST 的比例按名字推不准（2026-11-19 实测 *ST发展涨 10.09% 封板，不是 5%），所以主板 5%、10% 两档都算，
// 现价正好等于其中一档就当在涨停价上；不在涨停价上时显示按 10% 算的
const round2 = value => Math.round(value * 100 + 1e-6) / 100;
function limitUpCandidates(symbol, prevClose) {
  const ratios = symbol.startsWith('bj') ? [0.3] : /^(30|68)/.test(symbol.slice(2)) ? [0.2] : [0.1, 0.05];
  return ratios.map(ratio => round2(prevClose * (1 + ratio)));
}
function limitUpPrice(symbol, prevClose, price = 0) {
  const candidates = limitUpCandidates(symbol, prevClose);
  return candidates.find(limit => Math.abs(limit - price) < 0.005) ?? candidates[0];
}

const hands = volume => `${Math.round(volume / 100).toLocaleString('zh-CN')} 手`;
const wan = (volume, price) => `${Math.round((volume * price) / 1e4).toLocaleString('zh-CN')} 万`;
// 朗读用的金额：1 亿以上「2.1亿」，以下按百万取整「5700万」
const money = (volume, price) => {
  const yuan = volume * price;
  return yuan >= 1e8 ? `${(yuan / 1e8).toFixed(1).replace(/\.0$/, '')}亿` : `${Math.max(100, Math.round(yuan / 1e6) * 100)}万`;
};

// ---------- 规则 ----------
const states = new Map();
async function check(quote) {
  if (!(quote.prevClose > 0) || !(quote.price > 0)) return; // 停牌或竞价还没价
  // 14:57 起是收盘集合竞价，新浪的买一/卖一变成撮合信息，不再是涨停价上的挂单，按挂单判断会误报炸板
  // （2026-11-23 长华集团 14:57:02 现价仍是涨停价、卖一 0 手，却报了炸板）。竞价期间不判断，状态原样保留
  if (quote.time >= '14:57:00') return;
  const state = states.get(quote.symbol) || { riseAlerted: false, sealed: false, peak: 0, dropAlerted: false };
  states.set(quote.symbol, state);
  const pct = (quote.price / quote.prevClose - 1) * 100;
  const limit = limitUpPrice(quote.symbol, quote.prevClose, quote.price);
  const name = quote.name.replace(/\s+/g, '');
  const code = quote.symbol.slice(2);

  const sealedNow = Math.abs(quote.price - limit) < 0.005 && Math.abs(quote.bid1.price - limit) < 0.005 && quote.ask1.volume === 0;
  // 直接封板的只报封板，不再先报一句冲高
  if (!state.riseAlerted && pct >= options.rise && sealedNow) state.riseAlerted = true;
  else if (!state.riseAlerted && pct >= options.rise) {
    state.riseAlerted = true;
    await notify(`${name} 冲高${pct.toFixed(1).replace(/\.0$/, '')}%`, `${code} 现价 ${quote.price.toFixed(2)}，涨停价 ${limit.toFixed(2)}（${quote.time}）`);
  } else if (state.riseAlerted && pct < options.rise - 2) state.riseAlerted = false;

  if (sealedNow) {
    const seal = quote.bid1.volume;
    if (!state.sealed) {
      Object.assign(state, { sealed: true, peak: seal, dropAlerted: false });
      await notify(`${name} 封板${money(seal, limit)}`, `${code} 封单 ${hands(seal)}（${wan(seal, limit)}）（${quote.time}）`);
    } else if (seal > state.peak) state.peak = seal;
    else if (!state.dropAlerted && seal < state.peak * options.sealDrop) {
      state.dropAlerted = true;
      await notify(`${name} 封单降到${Math.round((seal / state.peak) * 100)}%`, `${code} 剩 ${hands(seal)}（${wan(seal, limit)}），最多时 ${hands(state.peak)}（${quote.time}）`);
    }
  } else if (state.sealed) {
    state.sealed = false;
    await notify(`${name} 炸板`, `${code} 现价 ${quote.price.toFixed(2)}，涨 ${pct.toFixed(2)}%，卖一 ${hands(quote.ask1.volume)}（${quote.time}）`);
  }
}

// ---------- 主循环 ----------
async function main() {
  log(`盯盘开始：冲高 ≥${options.rise}%，封单降到峰值 ${options.sealDrop * 100}% 以下提醒，每 ${options.poll} 秒查一次，${options.until} 结束${options.dryRun ? '（不推送）' : ''}`);
  let symbols = [];
  let listAt = 0;
  let tradingDayChecked = false;
  let quoteErrors = 0;
  while (clock() < options.until) {
    const now = clock();
    if (now >= '11:31' && now < '12:59') { await sleep(30_000); continue; } // 午休
    if (Date.now() - listAt > options.listMinutes * 60e3) {
      listAt = Date.now();
      try {
        const next = [...new Set([...(await fetchWatchlist()), ...options.extra])];
        if (next.join() !== symbols.join()) log(`自选 A 股 ${next.length} 只：${next.join(',') || '（空）'}`);
        symbols = next;
      } catch (error) {
        log(`!!! 读同花顺自选失败：${error.message}`);
        await warnOnce('list', '盯盘拿不到同花顺自选', `${error.message}。${symbols.length ? `先按上次的 ${symbols.length} 只继续盯` : '现在没有名单'}，需要重新导出登录状态`);
      }
    }
    if (!symbols.length) { await sleep(options.poll * 1000); continue; }
    try {
      const quotes = await fetchQuotes(symbols);
      quoteErrors = 0;
      // 9:20 以后行情日期还不是今天 → 今天不开盘（节假日、调休）
      if (!tradingDayChecked && now >= '09:20') {
        if (!quotes.some(quote => quote.date === today())) {
          if (now >= '09:31') return log('行情日期不是今天，今天不是交易日，退出');
        } else tradingDayChecked = true;
      }
      if (tradingDayChecked && now >= '09:25') for (const quote of quotes) if (quote.date === today()) await check(quote);
    } catch (error) {
      quoteErrors++;
      log(`行情出错（连续 ${quoteErrors} 次）：${error.message}`);
      if (quoteErrors === 20) await warnOnce('quotes', '盯盘拿不到行情', `新浪行情连续 ${quoteErrors} 次失败：${error.message}`);
    }
    await sleep(options.poll * 1000);
  }
  log('收盘，盯盘结束');
}

if (require.main === module) {
  main().catch(async error => {
    log(`!!! 盯盘崩溃：${error.stack || error.message}`);
    await notify('盯盘程序崩溃', error.message);
    process.exit(1);
  });
}

module.exports = { limitUpPrice, fetchQuotes, fetchWatchlist, check, notify, options };
