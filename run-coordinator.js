#!/usr/bin/env node
'use strict';

// 主备两台机器跑每日更新（2026-11-19 起：家里软路由做主 21:00，阿里云兜底 22:30），保证同一个交易日只有一台在跑，
// 并通过 R2 同步两边的本地缓存（新闻、正文、新闻判断、涨停名单等都存在本机 reports/ 等目录，新闻日历是用本地缓存生成的）。
//
// 运行标记 R2 run-status/<交易日>.json：{ host, role, state: running|done, startedAt, heartbeatAt, finishedAt, exitCode }
//   - 抢标记用 R2 条件写入（不存在才创建 / ETag 没变才覆盖），同一时刻只有一台能拿到
//   - 跑的时候每 2 分钟更新 heartbeatAt；超过 15 分钟没更新算对方挂了（断电、断网、卡死），可以接手
//   - 主（primary）：标记已 done 且成功、或别人正在跑（心跳新鲜）就不跑
//   - 备（fallback）：标记 done 且成功就不跑；对方正在跑就每 5 分钟看一次，最多等 4 小时；没有标记、心跳过期、或对方跑完但失败了就接手
// 本地缓存经 R2 state/v2/ 增量同步（state-sync.js，按内容哈希、大缓存分块，只传变了的）：拿到标记后，如果 R2 上的状态是另一台更新的、
// 比本机上次同步新，先下载变了的部分；跑完（成功或失败）都上传本机变了的部分，再把标记改成 done。
//
// 用法: node run-coordinator.js --role primary|fallback [--host 名字] [--stale-minutes 15] [--max-wait-hours 4]
//   检查：--watchdog 只看今天的运行标记，没人在跑（没有标记或心跳停了）就推 Bark，不接手（阿里云 21:15 用）
//   维护：--sync-up 只把本机状态传到 R2；--sync-down 只从 R2 拉共享状态（另一台更新时才拉，--force 强制拉）
//   测试：--test-command "sleep 30" 用这条命令代替 daily-update，配 --status-prefix run-status-test/ 不影响正式标记
require('dotenv').config({ quiet: true });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { r2Client, R2_BUCKET } = require('./r2-storage');
const { latestClosedTradeDay } = require('./limit-up-list');
const stateSync = require('./state-sync');

const ROOT = __dirname;
const options = { role: '', host: process.env.STOCK_REPLAY_HOST || os.hostname(), staleMinutes: 15, maxWaitHours: 4, syncUp: false, syncDown: false, watchdog: false, force: false, testCommand: '', statusPrefix: 'run-status/', heartbeatSeconds: 120, pollSeconds: 300 };
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--role') options.role = process.argv[++index];
  else if (argument === '--host') options.host = process.argv[++index];
  else if (argument === '--stale-minutes') options.staleMinutes = Number(process.argv[++index]);
  else if (argument === '--max-wait-hours') options.maxWaitHours = Number(process.argv[++index]);
  else if (argument === '--sync-up') options.syncUp = true;
  else if (argument === '--sync-down') options.syncDown = true;
  else if (argument === '--force') options.force = true;
  else if (argument === '--watchdog') options.watchdog = true;
  else if (argument === '--test-command') options.testCommand = process.argv[++index];
  else if (argument === '--status-prefix') options.statusPrefix = process.argv[++index];
  else if (argument === '--heartbeat-seconds') options.heartbeatSeconds = Number(process.argv[++index]);
  else if (argument === '--poll-seconds') options.pollSeconds = Number(process.argv[++index]);
  else throw new Error(`未知参数: ${argument}`);
}
if (!options.syncUp && !options.syncDown && !options.watchdog && !['primary', 'fallback'].includes(options.role)) throw new Error('--role 必须是 primary 或 fallback');
if (!r2Client) throw new Error('R2 未配置，主备协调要用 R2');


const now = () => new Date().toISOString();
const log = message => console.log(`[协调 ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19)}] ${message}`);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const isPrecondition = error => error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412;
const isMissing = error => error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;

// 网络重试（2026-11-19）：那天 21:00 软路由连 R2 时网络抖了一下（TLS 断开），协调直接退出、整晚没跑，Bark 也没发出去。
// 连接类错误（断网、DNS、TLS、超时、5xx）每 30 秒重试一次，最多 10 次（约 5 分钟）；R2 的条件写冲突、不存在这类正常结果不重试。
const RETRY_TIMES = Number(process.env.COORDINATOR_RETRY_TIMES || 10);
const RETRY_SECONDS = Number(process.env.COORDINATOR_RETRY_SECONDS || 30);
function isNetworkError(error) {
  if (isPrecondition(error) || isMissing(error)) return false;
  const status = error?.$metadata?.httpStatusCode;
  if (status) return status >= 500 || status === 429;
  // 没有 HTTP 状态码：只认连接类错误（连不上、TLS 断开、DNS、超时），代码 bug 之类不重试
  const text = [error?.name, error?.code, error?.cause?.code, error?.message, error?.cause?.message].filter(Boolean).join(' ');
  return /fetch failed|socket|TLS|ECONN|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|UND_ERR|Timeout|AbortError|network|timed out/i.test(text);
}
async function withRetry(label, task) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      if (!isNetworkError(error) || attempt >= RETRY_TIMES) throw error;
      const reason = error.cause?.code || error.code || error.message;
      log(`${label}失败（${String(reason).slice(0, 100)}），${RETRY_SECONDS} 秒后重试（${attempt}/${RETRY_TIMES - 1}）`);
      await sleep(RETRY_SECONDS * 1000);
    }
  }
}

async function getStatus(key) {
  return withRetry('读运行标记', async () => {
    try {
      const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      return { etag: response.ETag, value: JSON.parse(await response.Body.transformToString()) };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  });
}

// 条件写：etag 为 null 表示只在不存在时创建；返回新 ETag，被别人抢先返回 null。
// 网络错误会重试。条件不满足时读回来看：标记仍是本机这一轮的（同一 host、同一 startedAt），说明是上一次写进去了但回应丢了，
// ETag 已经变了；换成现在的 ETag 再写一次，免得把自己当成「被别人接手」
async function putStatus(key, value, etag, { retry = true } = {}) {
  const body = JSON.stringify(value, null, 1);
  let expected = etag;
  const write = async () => {
    for (let round = 0; round < 3; round++) {
      try {
        const response = await r2Client.send(new PutObjectCommand({
          Bucket: R2_BUCKET, Key: key, Body: body, ContentType: 'application/json',
          ...(expected ? { IfMatch: expected } : { IfNoneMatch: '*' }),
        }));
        return response.ETag;
      } catch (error) {
        if (!isPrecondition(error)) throw error;
        const current = await getStatus(key);
        const ours = current && current.value.host === value.host && current.value.startedAt === value.startedAt;
        if (!ours) return null;
        if (JSON.stringify(current.value, null, 1) === body) return current.etag;
        expected = current.etag;
      }
    }
    return null;
  };
  return retry ? withRetry('写运行标记', write) : write();
}

const fresh = status => status && Date.now() - Date.parse(status.value.heartbeatAt || status.value.startedAt) < options.staleMinutes * 60e3;

// Bark 推送到用户 iPhone（2026-11-19）：.env 的 BARK_URL=https://api.day.app/<密钥>；没配就不发，发送失败只记日志。
// 用户靠 AirPods 听（2026-11-19 改短）：标题只有「🟢每日更新」「🔴每日更新」，正文一句话，例如「软路由跑完，用时 35 分钟」「软路由未开始」；
// 长了 Siri 会先问要不要朗读。细节（失败的步骤、警告、费用、原因）只写日志。
// 出问题（🔴）用 timeSensitive（专注模式下也提醒），成功（🟢）用普通通知；「开始跑」是中性的（neutral），标题不带状态、不带跳转；
// 测试命令（--test-command）不发
async function notify(body, { ok = false, neutral = false, detail = '' } = {}) {
  const mark = neutral ? '' : ok ? '🟢' : '🔴';
  log(`推送 ${mark}${body}${detail ? `｜${detail}` : ''}`);
  const base = String(process.env.BARK_URL || '').replace(/\/+$/, '');
  if (!base || options.testCommand) return;
  const title = `${mark}每日更新`;
  const query = new URLSearchParams({ group: '每日更新', level: ok || neutral ? 'active' : 'timeSensitive' });
  if (ok) query.set('url', 'https://stock-replay.onrender.com/'); // 跑完的通知点开直接看复盘页面
  // 网络不通时同样每 30 秒重试，最多约 5 分钟：Bark 一恢复就把问题推出去
  try {
    await withRetry('Bark 通知', async () => {
      const response = await fetch(`${base}/${encodeURIComponent(title)}/${encodeURIComponent(body.slice(0, 200))}?${query}`, { signal: AbortSignal.timeout(15_000) });
      if (response.status >= 500 || response.status === 429) throw Object.assign(new Error(`HTTP ${response.status}`), { $metadata: { httpStatusCode: response.status } });
      if (!response.ok) log(`Bark 通知失败：HTTP ${response.status}`);
    });
  } catch (error) {
    log(`Bark 通知失败：${error.message}`);
  }
}

const HOST_NAMES = { router: '软路由', aliyun: '阿里云' };
const hostName = host => HOST_NAMES[host] || host;

// 从每日更新的输出里摘要：各步 ✓/✗、今日首板只数、大模型费用、!!! 警告
function summarize(output) {
  const tail = output.slice(output.lastIndexOf('========== 每日更新完成'));
  const steps = tail.includes('每日更新完成') ? tail.split('\n').filter(line => /^\s+[✓✗]/.test(line)).map(line => line.trim()) : [];
  const failed = steps.filter(line => line.startsWith('✗')).map(line => line.slice(1).trim());
  const firstBoards = output.match(/今日首板（[^）]*）：(\d+) 只/)?.[1];
  let low = 0;
  let high = 0;
  for (const match of output.matchAll(/约 ([\d.]+) 元（空闲）\s*\/\s*([\d.]+) 元（高峰）/g)) {
    low += Number(match[1]);
    high += Number(match[2]);
  }
  const warnings = [...new Set(output.split('\n').filter(line => line.includes('!!!') && !line.includes('往上翻看')).map(line => line.replace(/^.*?!!!\s*/, '').slice(0, 80)))];
  return { steps, failed, firstBoards, cost: high ? `${low.toFixed(2)}–${high.toFixed(2)} 元` : '0 元', warnings };
}

// 返回 { etag } 表示拿到了标记；返回 null 表示不用跑
async function claim(key, tradeDate) {
  const deadline = Date.now() + options.maxWaitHours * 3600e3;
  for (;;) {
    const status = await getStatus(key);
    const value = status?.value;
    if (value?.state === 'done' && value.exitCode === 0) {
      log(`${tradeDate} 已由 ${value.host} 在 ${value.finishedAt} 跑完，不用跑`);
      return null;
    }
    if (value?.state === 'running' && fresh(status)) {
      if (value.host === options.host) {
        log(`!!! 标记显示本机（${value.host}）正在跑 ${tradeDate}（心跳 ${value.heartbeatAt}），可能有另一个进程，不重复跑`);
        return null;
      }
      if (options.role === 'primary') {
        log(`${value.host} 正在跑 ${tradeDate}（心跳 ${value.heartbeatAt}），主机不抢`);
        return null;
      }
      if (Date.now() > deadline) {
        log(`!!! 等了 ${options.maxWaitHours} 小时 ${value.host} 还在跑，备机放弃`);
        await notify(`${hostName(value.host)}${options.maxWaitHours}小时没跑完`, { detail: `心跳 ${value.heartbeatAt}，${hostName(options.host)}放弃等待` });
        return null;
      }
      log(`${value.host} 正在跑 ${tradeDate}（心跳 ${value.heartbeatAt}），${options.pollSeconds} 秒后再看`);
      await sleep(options.pollSeconds * 1000);
      continue;
    }
    const reason = !value ? '还没有人跑'
      : value.state === 'done' ? `${value.host} 跑完但退出码 ${value.exitCode}，重跑`
        : `${value.host} 的心跳停在 ${value.heartbeatAt}，超过 ${options.staleMinutes} 分钟，接手`;
    const record = { host: options.host, role: options.role, state: 'running', startedAt: now(), heartbeatAt: now(), tradeDate, previous: value || null };
    const etag = await putStatus(key, record, status?.etag || null);
    if (etag) {
      log(`拿到 ${tradeDate} 的运行标记（${reason}）`);
      if (options.role === 'fallback') {
        const why = !value ? `${hostName('router')}今天没有开始跑（可能断电、断网或没开机）`
          : value.state === 'done' ? `${hostName(value.host)}跑完但有步骤失败（退出码 ${value.exitCode}）`
            : `${hostName(value.host)}的心跳停在 ${new Date(Date.parse(value.heartbeatAt) + 8 * 3600e3).toISOString().slice(11, 16)}（可能断电、断网或卡死）`;
        await notify(`${hostName(options.host)}接手`, { detail: why });
      }
      return { etag, record };
    }
    log('标记被别人抢先改了，重新看');
    await sleep(3000);
  }
}

// 21:15 进度检查（阿里云 2026-11-19）：软路由 21:00 开跑，到这时应该已经拿到标记、在跑或跑完了。
// 没有标记、心跳停了才推送（时效性）；正在跑、已跑完都只记日志。跑完但失败的，软路由自己会推「✗」，这里不重复。
async function watchdog(key, tradeDate) {
  const status = await getStatus(key);
  const value = status?.value;
  const at = iso => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(11, 16);
  const day = tradeDate.slice(5);
  if (!value) {
    log(`!!! ${tradeDate} 还没有运行标记，推送提醒`);
    await notify('软路由未开始', { detail: `${day} 到 21:15 还没有运行标记（可能断电、断网或没开机），阿里云 22:30 会兜底` });
    return 1;
  }
  if (value.state === 'done') {
    log(`${tradeDate} 已由 ${value.host} 在 ${value.finishedAt} 跑完，退出码 ${value.exitCode}`);
    return 0;
  }
  if (fresh(status)) {
    log(`${value.host} 正在跑 ${tradeDate}（${at(value.startedAt)} 开始，心跳 ${at(value.heartbeatAt)}）`);
    return 0;
  }
  log(`!!! ${value.host} 的心跳停在 ${value.heartbeatAt}，推送提醒`);
  await notify(`${hostName(value.host)}卡住了`, { detail: `${at(value.startedAt)} 开始，心跳停在 ${at(value.heartbeatAt)}，阿里云 22:30 会接手` });
  return 1;
}

// 共享状态增量同步（state-sync.js）：R2 上的是另一台更新的、且比本机上次同步新，才下载变了的部分
async function syncDown() {
  const started = Date.now();
  await withRetry('下载共享状态', () => stateSync.download(ROOT, options.host, { force: options.force, log }));
  log(`同步检查用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
}

async function syncUp() {
  const started = Date.now();
  await withRetry('上传共享状态', () => stateSync.upload(ROOT, options.host, log));
  log(`上传用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
}

async function main() {
  if (options.syncUp || options.syncDown) {
    if (options.syncDown) await syncDown();
    if (options.syncUp) await syncUp();
    return 0;
  }
  const { date: tradeDate } = await withRetry('查最近交易日', () => latestClosedTradeDay());
  const key = `${options.statusPrefix}${tradeDate}.json`;
  if (options.watchdog) return watchdog(key, tradeDate);
  log(`${options.host}（${options.role === 'primary' ? '主' : '备'}）检查 ${tradeDate}`);
  const claimed = await claim(key, tradeDate);
  if (!claimed) return 0;
  if (options.role === 'primary') await notify(`${hostName(options.host)}开始跑`, { neutral: true }); // 备机接手时已推「阿里云接手」
  let { etag, record } = claimed;
  let lost = false;
  let child;
  let beating = Promise.resolve();
  // 心跳：ETag 对不上说明被别人接手了，停掉自己的任务
  const beat = setInterval(() => { beating = beating.then(async () => {
    if (lost) return;
    try {
      const next = await putStatus(key, { ...record, heartbeatAt: now() }, etag, { retry: false }); // 心跳每 2 分钟一次，失败等下一次
      if (next) etag = next;
      else {
        lost = true;
        log('!!! 运行标记被别人接手了，停止本机任务');
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child?.kill('SIGTERM'); } // 连 daily-update 的子进程一起停
      }
    } catch (error) {
      log(`心跳写入失败（网络？）：${error.message}`);
    }
  }); }, options.heartbeatSeconds * 1000);

  let exitCode = 1;
  let output = ''; // 每日更新的输出，照常写日志，同时留一份给通知摘要（最多 8 MB）
  const started = Date.now();
  try {
    try {
      if (!options.testCommand) await syncDown();
    } catch (error) {
      log(`!!! 下载共享状态失败，用本机的继续：${error.message}`);
    }
    exitCode = await new Promise(resolve => {
      const [command, ...args] = options.testCommand ? ['sh', '-c', options.testCommand] : [process.execPath, path.join(ROOT, 'daily-update.js'), '--yes'];
      child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      const keep = (stream, target) => stream.on('data', chunk => {
        target.write(chunk);
        if (output.length < 8 * 1048576) output += chunk.toString();
      });
      keep(child.stdout, process.stdout);
      keep(child.stderr, process.stderr);
      child.on('close', code => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });
    if (lost) return 1;
    try {
      if (!options.testCommand) await syncUp();
    } catch (error) {
      log(`!!! 上传本机状态失败：${error.message}`);
    }
  } finally {
    clearInterval(beat);
    await beating; // 等最后一次心跳写完，免得 done 用旧 ETag
  }
  if (lost) {
    await notify(`${hostName(options.host)}被接手，已停止`, { detail: '跑到一半运行标记被另一台接手' });
    return 1;
  }
  const done = await putStatus(key, { ...record, state: 'done', heartbeatAt: now(), finishedAt: now(), exitCode }, etag);
  log(done ? `${tradeDate} 跑完，退出码 ${exitCode}，标记已改为 done` : '!!! 写 done 时标记已被别人改了');
  const summary = summarize(output);
  const minutes = Math.round((Date.now() - started) / 60e3);
  const detail = [summary.firstBoards && `今日首板 ${summary.firstBoards} 只`, `大模型约 ${summary.cost}`, summary.failed.length && `失败：${summary.failed.join('、')}`, ...summary.warnings.slice(0, 4).map(line => `!!! ${line}`)].filter(Boolean).join('；');
  if (exitCode === 0 && !summary.failed.length) {
    await notify(`${hostName(options.host)}跑完，用时 ${minutes} 分钟`, { ok: true, detail });
  } else {
    const what = summary.failed.length ? `${summary.failed.length} 步失败` : `退出码 ${exitCode}`;
    await notify(`${hostName(options.host)}跑完，${what}`, { detail: `${detail}${options.role === 'primary' ? '；阿里云 22:30 会重跑' : ''}` });
  }
  return exitCode;
}

main().then(code => process.exit(code), async error => {
  console.error(`!!! 协调失败: ${error.stack || error.message}`);
  await notify(`${hostName(options.host)}出错`, { detail: `${error.message.slice(0, 200)}${options.role === 'primary' ? '；阿里云 22:30 会兜底' : ''}` });
  process.exit(1);
});
