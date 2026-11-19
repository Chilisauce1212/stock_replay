#!/usr/bin/env node
'use strict';

// 同花顺扫码登录（2026-11-19）：在软路由上跑，不用电脑。同花顺网页登录只有 7 天免登录，盯盘读自选要这个登录。
// 流程（同 upass 登录页自己的 qrcode.js，普通请求，不带任何签名）：
//   GET /scan/creatCode → qrid；二维码图片 /scan/creatImg?qrid=…（用 Bark 的 image 推到手机，点开能看大图）
//   POST /scan/getInfoNew 每秒问一次：status 1 等扫码、2 已扫待确认（再用 state=2 问）、3 登录成功（响应里下发登录 cookie）、0 二维码过期（换新码再推，最多 3 次）
// 登录成功后把 cookie 写到 reports/ths-state.json（盯盘 watch-alerts.js 读它），并试读一次自选。
// 用法: node ths-qr-login.js [--if-needed（登录还有 2 天以上且能读到自选就什么都不做）] [--wait-minutes 15]
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const BASE = 'https://upass.10jqka.com.cn';
const STATE_FILE = process.env.THS_STATE_FILE || path.join(__dirname, 'reports', 'ths-state.json');
const options = { ifNeeded: process.argv.includes('--if-needed'), waitMinutes: 15, maxCodes: 3 };
const waitIndex = process.argv.indexOf('--wait-minutes');
if (waitIndex > 0) options.waitMinutes = Number(process.argv[waitIndex + 1]);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const log = message => console.log(`[${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19)}] ${message}`);

async function bark(title, body, extra = {}) {
  const base = String(process.env.BARK_URL || '').replace(/\/+$/, '');
  if (!base) return log('没配 BARK_URL，不推送');
  const query = new URLSearchParams({ group: '盯盘', level: 'timeSensitive', ...extra });
  try {
    const response = await fetch(`${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${query}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) log(`Bark 推送失败：HTTP ${response.status}`);
  } catch (error) {
    log(`Bark 推送失败：${error.message}`);
  }
}

// 简单的 cookie 罐：记下 upass 下发的 cookie（名字、值、域、过期时间），后续请求带上
const jar = new Map();
function remember(response) {
  for (const line of response.headers.getSetCookie?.() || []) {
    const [pair, ...attributes] = line.split(';').map(part => part.trim());
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const attribute = key => attributes.find(item => item.toLowerCase().startsWith(`${key}=`))?.split('=').slice(1).join('=');
    const maxAge = Number(attribute('max-age'));
    const expires = Number.isFinite(maxAge) && attribute('max-age') ? Date.now() / 1000 + maxAge : attribute('expires') ? Date.parse(attribute('expires')) / 1000 : -1;
    if (!value || value === 'deleted' || (expires > 0 && expires * 1000 < Date.now())) jar.delete(name);
    else jar.set(name, { name, value, domain: attribute('domain') || 'upass.10jqka.com.cn', path: attribute('path') || '/', expires });
  }
}
const cookieHeader = () => [...jar.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

async function request(pathname, { method = 'GET', form } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Referer: `${BASE}/login?redir=https%3A%2F%2Ft.10jqka.com.cn%2F`,
      'X-Requested-With': 'XMLHttpRequest',
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  remember(response);
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}：${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${pathname} 返回的不是 JSON：${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

function currentLogin() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const login = state.cookies.filter(cookie => ['userid', 'ticket'].includes(cookie.name));
    if (login.length < 2) return 0;
    return Math.min(...login.map(cookie => (cookie.expires > 0 ? cookie.expires * 1000 : Infinity)));
  } catch {
    return 0;
  }
}

async function login() {
  const deadline = Date.now() + options.waitMinutes * 60e3;
  for (let attempt = 1; attempt <= options.maxCodes && Date.now() < deadline; attempt++) {
    const { qrid, errorCode } = await request('/scan/creatCode');
    if (errorCode !== 0 || !qrid) throw new Error(`拿不到二维码：errorCode ${errorCode}`);
    const image = `${BASE}/scan/creatImg?qrid=${encodeURIComponent(qrid)}`;
    log(`二维码 ${attempt}/${options.maxCodes} 已生成，推送到手机`);
    await bark('同花顺要扫码登录', `盯盘读自选要用同花顺网页登录（7 天有效）。点开通知看二维码，长按存到相册，用同花顺 App 扫一扫里「相册」识别（第 ${attempt} 张，过期会自动再发）`, { image, url: image });
    let state = 1;
    while (Date.now() < deadline) {
      const result = await request('/scan/getInfoNew', { method: 'POST', form: { qrid, state, source: 'pc_web', page_source: 'web_screen', request_type: 'login' } });
      const status = Number(result.status);
      if (status === 3) return;
      if (status === 2 && state !== 2) { log('已扫码，等手机上确认'); state = 2; }
      if (status === 0) { log('二维码过期'); break; }
      if (![1, 2].includes(status)) throw new Error(`扫码状态异常：${JSON.stringify(result).slice(0, 200)}`);
      await sleep(1500);
    }
  }
  throw new Error(`${options.waitMinutes} 分钟内没有扫码登录`);
}

async function main() {
  const expiry = currentLogin();
  const { fetchWatchlist } = require('./watch-alerts');
  if (options.ifNeeded && expiry - Date.now() > 2 * 86400e3) {
    try {
      const list = await fetchWatchlist();
      return log(`同花顺登录还有 ${((expiry - Date.now()) / 86400e3).toFixed(1)} 天，自选 A 股 ${list.length} 只，不用重新登录`);
    } catch (error) {
      log(`登录没过期但读不到自选（${error.message}），重新扫码登录`);
    }
  }
  await login();
  const cookies = [...jar.values()].map(cookie => ({ ...cookie, domain: cookie.domain.startsWith('.') || cookie.domain.includes('upass') ? cookie.domain : `.${cookie.domain}` }));
  const names = cookies.map(cookie => cookie.name);
  if (!['userid', 'ticket'].every(name => names.includes(name))) throw new Error(`登录成功但没拿到登录 cookie（拿到：${names.join(',')}）`);
  const previous = (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).cookies || []; } catch { return []; } })();
  const merged = [...previous.filter(cookie => !names.includes(cookie.name)), ...cookies];
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ exportedAt: new Date().toISOString(), via: 'qr', cookies: merged }, null, 1), { mode: 0o600 });
  const newExpiry = currentLogin();
  const list = await fetchWatchlist();
  const until = Number.isFinite(newExpiry) ? new Date(newExpiry + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') : '会话结束';
  log(`登录成功，有效到 ${until}，自选 A 股 ${list.length} 只`);
  await bark('同花顺登录成功', `有效到 ${until}，读到自选 A 股 ${list.length} 只`);
}

main().catch(async error => {
  log(`!!! 同花顺扫码登录失败：${error.message}`);
  await bark('同花顺扫码登录失败', error.message.slice(0, 300));
  process.exit(1);
});
