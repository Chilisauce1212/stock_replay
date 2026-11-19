#!/usr/bin/env node
'use strict';

// Bark 调试页（2026-11-19，跑在阿里云，systemd stock-replay-bark-debug，端口 1212）：在手机或电脑上手动发 Bark，
// 试通知级别、分组、点开跳转、图片、标题/正文长短（AirPods 朗读效果），并显示服务器调用 Bark 的用时。
// 用户名 bark，密码在 /root/stock_replay/reports/bark-debug.pass（首次启动自动生成，不进 git、不同步）。走的是明文 http，只用来调试。
// Bark 地址用 .env 的 BARK_URL，页面上看不到。
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.BARK_DEBUG_PORT || 1212);
const PASS_FILE = path.join(__dirname, '..', 'reports', 'bark-debug.pass');
const BARK = String(process.env.BARK_URL || '').replace(/\/+$/, '');
const LEVELS = ['active', 'timeSensitive', 'passive', 'critical'];

function password() {
  try {
    const saved = fs.readFileSync(PASS_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {}
  const created = crypto.randomBytes(9).toString('base64url');
  fs.mkdirSync(path.dirname(PASS_FILE), { recursive: true });
  fs.writeFileSync(PASS_FILE, `${created}\n`, { mode: 0o600 });
  return created;
}
const EXPECTED = Buffer.from(`Basic ${Buffer.from(`bark:${password()}`).toString('base64')}`);
const authorized = request => {
  const given = Buffer.from(String(request.headers.authorization || ''));
  return given.length === EXPECTED.length && crypto.timingSafeEqual(given, EXPECTED);
};

const history = [];
let lastSend = 0;

async function send({ title = '', body = '', level = 'active', group = '调试', url = '', image = '', sound = '' }) {
  if (!BARK) throw new Error('服务器没配 BARK_URL');
  body = String(body).trim().slice(0, 1500);
  title = String(title).trim().slice(0, 200);
  if (!body) throw new Error('正文不能为空');
  if (!LEVELS.includes(level)) throw new Error('级别不对');
  const query = new URLSearchParams({ level, group: String(group).slice(0, 40) || '调试' });
  for (const [key, value] of Object.entries({ url, image, sound })) if (String(value).trim()) query.set(key, String(value).trim().slice(0, 500));
  const target = `${BARK}/${title ? `${encodeURIComponent(title)}/` : ''}${encodeURIComponent(body)}?${query}`;
  const started = performance.now();
  const response = await fetch(target, { signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  const ms = Math.round(performance.now() - started);
  let code;
  try { code = JSON.parse(text).code; } catch {}
  const record = { at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 23), title, body: body.slice(0, 60), level, ms, status: response.status, code };
  history.unshift(record);
  history.length = Math.min(history.length, 30);
  console.log(`[bark-debug] ${record.at} ${level} ${response.status}/${code} ${ms}ms ${title ? `${title}｜` : ''}${record.body}`);
  return record;
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bark 调试</title><style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1b1e23;--text:#e6e8eb;--muted:#9aa1ab;--line:#2c3138;--accent:#5b8cff;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}label:first-child{margin-top:0}
input,select,textarea{width:100%;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:9px 10px}
textarea{min-height:72px;resize:vertical}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{font:inherit;border:0;border-radius:10px;padding:11px 14px;cursor:pointer}
.send{width:100%;background:var(--accent);color:#fff;font-weight:600;margin-top:14px}.send:disabled{opacity:.6}
.presets{display:flex;flex-wrap:wrap;gap:8px}.presets button{background:transparent;border:1px solid var(--line);color:var(--text);padding:6px 10px;font-size:13px}
.hint{font-size:12px;color:var(--muted)}#result{margin-top:10px;min-height:1.5em;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:normal}.ok{color:var(--ok)}.bad{color:var(--bad)}td.msg{word-break:break-all}
</style></head><body><main>
<h1>Bark 调试</h1>
<div class="card"><div class="presets" id="presets"></div><p class="hint">点一下填入示例，再按发送。盯盘提醒只发正文、不带标题，这样 AirPods 会直接读，不会先问要不要朗读。</p></div>
<form class="card" id="form">
<label>标题（可空）</label><input name="title" placeholder="留空就只发正文">
<label>正文</label><textarea name="body" required placeholder="例如：中嘉博创 冲高6.6%"></textarea>
<div class="hint" id="len"></div>
<div class="row"><div><label>级别</label><select name="level">
<option value="timeSensitive">时效性 timeSensitive</option><option value="active">普通 active</option><option value="passive">静默 passive</option><option value="critical">重要警告 critical</option></select></div>
<div><label>分组</label><input name="group" value="调试"></div></div>
<label>点开跳转 url</label><input name="url" value="amihexin://" placeholder="amihexin:// 打开同花顺">
<div class="row"><div><label>图片 image</label><input name="image" placeholder="图片地址"></div><div><label>声音 sound</label><input name="sound" placeholder="如 minuet"></div></div>
<button class="send" id="send">发送</button><div id="result"></div>
</form>
<div class="card"><table><thead><tr><th>时间</th><th>级别</th><th>用时</th><th>内容</th></tr></thead><tbody id="history"></tbody></table>
<p class="hint">用时是服务器把请求交给 Bark、Bark 交给苹果推送后回应的时间；手机一般在回应前后就弹出来。</p></div>
</main><script>
const presets=[["冲高","","中嘉博创 冲高6.6%"],["封板","","华菱精工 封板2.1亿"],["封单","","武汉凡谷 封单降到40%"],["炸板","","中嘉博创 炸板"],
["每日更新 🟢","🟢每日更新","软路由跑完，用时 35 分钟"],
["软路由未开始","🔴每日更新","软路由未开始"],["阿里云接手","🔴每日更新","阿里云接手"],
["长消息","","这是一条比较长的消息，用来试 AirPods 朗读：超过一定长度时 Siri 会先问要不要朗读，而不是直接读出来，可以对比一下短消息的效果和等待时间。"]];
const form=document.getElementById('form'),result=document.getElementById('result'),len=document.getElementById('len');
const box=document.getElementById('presets');
for(const [name,title,body] of presets){const b=document.createElement('button');b.type='button';b.textContent=name;b.onclick=()=>{form.title.value=title;form.body.value=body;count();};box.append(b);}
function count(){const t=form.title.value.length,b=form.body.value.length;len.textContent='标题 '+t+' 字，正文 '+b+' 字，共 '+(t+b)+' 字';}
form.addEventListener('input',count);count();
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function render(rows){document.getElementById('history').innerHTML=rows.map(r=>'<tr><td>'+esc(r.at.slice(0,8))+'</td><td>'+esc(r.level)+'</td><td class="'+(r.status===200&&r.code===200?'ok':'bad')+'">'+r.ms+' ms</td><td class="msg">'+esc(r.title?r.title+'｜'+r.body:r.body)+'</td></tr>').join('');}
fetch('history').then(r=>r.json()).then(render).catch(()=>{});
form.addEventListener('submit',async e=>{e.preventDefault();const btn=document.getElementById('send');btn.disabled=true;result.className='';result.textContent='发送中…';
const t0=performance.now();
try{const r=await fetch('send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
const data=await r.json();if(!r.ok)throw new Error(data.error||r.status);
result.className=data.record.code===200?'ok':'bad';result.textContent='已发出：服务器→Bark '+data.record.ms+' ms，页面往返 '+Math.round(performance.now()-t0)+' ms';render(data.history);}
catch(err){result.className='bad';result.textContent='失败：'+err.message;}finally{btn.disabled=false;}});
</script></body></html>`;

const reply = (response, status, value, type = 'application/json; charset=utf-8') => {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(typeof value === 'string' ? value : JSON.stringify(value));
};

http.createServer(async (request, response) => {
  if (!authorized(request)) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="bark-debug", charset="UTF-8"' });
    return response.end('需要登录');
  }
  const { pathname } = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && pathname === '/') return reply(response, 200, PAGE, 'text/html; charset=utf-8');
  if (request.method === 'GET' && pathname === '/history') return reply(response, 200, history);
  if (request.method === 'POST' && pathname === '/send') {
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 8192) return reply(response, 413, { error: '内容太长' });
    }
    if (Date.now() - lastSend < 1000) return reply(response, 429, { error: '太快了，隔一秒再发' });
    lastSend = Date.now();
    try {
      const record = await send(JSON.parse(raw || '{}'));
      return reply(response, 200, { record, history });
    } catch (error) {
      return reply(response, 400, { error: error.message });
    }
  }
  reply(response, 404, { error: '没有这个页面' });
}).listen(PORT, () => console.log(`[bark-debug] 监听 ${PORT}`));
