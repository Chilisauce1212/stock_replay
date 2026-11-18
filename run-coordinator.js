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
// 本地缓存同步 R2 state/stock-replay-state.tar.gz（+ state/meta.json）：拿到标记后，如果 R2 上的状态是另一台更新的、比本机上次同步新，
// 先下载解压覆盖到本机；跑完（成功或失败）都把本机状态打包上传，再把标记改成 done。
//
// 用法: node run-coordinator.js --role primary|fallback [--host 名字] [--stale-minutes 15] [--max-wait-hours 4]
//   维护：--sync-up 只把本机状态传到 R2；--sync-down 只从 R2 拉共享状态（另一台更新时才拉，--force 强制拉）
//   测试：--test-command "sleep 30" 用这条命令代替 daily-update，配 --status-prefix run-status-test/ 不影响正式标记
require('dotenv').config({ quiet: true });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { r2Client, R2_BUCKET } = require('./r2-storage');
const { latestClosedTradeDay } = require('./limit-up-list');

const ROOT = __dirname;
const options = { role: '', host: process.env.STOCK_REPLAY_HOST || os.hostname(), staleMinutes: 15, maxWaitHours: 4, syncUp: false, syncDown: false, force: false, testCommand: '', statusPrefix: 'run-status/', heartbeatSeconds: 120, pollSeconds: 300 };
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--role') options.role = process.argv[++index];
  else if (argument === '--host') options.host = process.argv[++index];
  else if (argument === '--stale-minutes') options.staleMinutes = Number(process.argv[++index]);
  else if (argument === '--max-wait-hours') options.maxWaitHours = Number(process.argv[++index]);
  else if (argument === '--sync-up') options.syncUp = true;
  else if (argument === '--sync-down') options.syncDown = true;
  else if (argument === '--force') options.force = true;
  else if (argument === '--test-command') options.testCommand = process.argv[++index];
  else if (argument === '--status-prefix') options.statusPrefix = process.argv[++index];
  else if (argument === '--heartbeat-seconds') options.heartbeatSeconds = Number(process.argv[++index]);
  else if (argument === '--poll-seconds') options.pollSeconds = Number(process.argv[++index]);
  else throw new Error(`未知参数: ${argument}`);
}
if (!options.syncUp && !options.syncDown && !['primary', 'fallback'].includes(options.role)) throw new Error('--role 必须是 primary 或 fallback');
if (!r2Client) throw new Error('R2 未配置，主备协调要用 R2');

const STATE_KEY = 'state/stock-replay-state.tar.gz';
const META_KEY = 'state/meta.json';
const LOCAL_SYNC_FILE = path.join(ROOT, 'reports', '.state-sync.json');
// 同步的目录；日志、问财登录状态（凭证，各机器自己的）、临时文件不同步
const STATE_DIRS = ['reports', 'daily-review', 'test-cases'];
const STATE_EXCLUDES = ['reports/daily-update-*.log', 'reports/wencai-state.json', 'reports/.state-sync.json', '*.tmp'];

const now = () => new Date().toISOString();
const log = message => console.log(`[协调 ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19)}] ${message}`);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const isPrecondition = error => error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412;
const isMissing = error => error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;

async function getStatus(key) {
  try {
    const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return { etag: response.ETag, value: JSON.parse(await response.Body.transformToString()) };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

// 条件写：etag 为 null 表示只在不存在时创建；返回新 ETag，被别人抢先返回 null
async function putStatus(key, value, etag) {
  try {
    const response = await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, Body: JSON.stringify(value, null, 1), ContentType: 'application/json',
      ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
    }));
    return response.ETag;
  } catch (error) {
    if (isPrecondition(error)) return null;
    throw error;
  }
}

const fresh = status => status && Date.now() - Date.parse(status.value.heartbeatAt || status.value.startedAt) < options.staleMinutes * 60e3;

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
      return { etag, record };
    }
    log('标记被别人抢先改了，重新看');
    await sleep(3000);
  }
}

function readLocalSync() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_SYNC_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeLocalSync(value) {
  fs.mkdirSync(path.dirname(LOCAL_SYNC_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_SYNC_FILE, JSON.stringify(value, null, 1));
}

// R2 上的状态是另一台上传的、且比本机上次上传/下载都新，就下载解压覆盖
async function syncDown() {
  const meta = await getStatus(META_KEY);
  if (!meta) return log('R2 上还没有共享状态，用本机的');
  const local = readLocalSync();
  const last = Math.max(Date.parse(local.uploadedAt || 0) || 0, Date.parse(local.downloadedAt || 0) || 0);
  if (!options.force && meta.value.host === options.host) return log(`R2 上的共享状态是本机 ${meta.value.uploadedAt} 传的，不用下载`);
  if (!options.force && Date.parse(meta.value.uploadedAt) <= last) return log(`R2 上的共享状态（${meta.value.host} ${meta.value.uploadedAt}）不比本机新，不用下载`);
  log(`下载 ${meta.value.host} ${meta.value.uploadedAt} 上传的共享状态（${(meta.value.bytes / 1048576).toFixed(0)} MB）…`);
  const started = Date.now();
  const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: STATE_KEY }));
  const temporary = path.join(os.tmpdir(), `stock-replay-state-${process.pid}.tar.gz`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(temporary);
    response.Body.pipe(out).on('finish', resolve).on('error', reject);
    response.Body.on('error', reject);
  });
  execFileSync('tar', ['-xzf', temporary, '-C', ROOT], { stdio: 'inherit' });
  fs.unlinkSync(temporary);
  writeLocalSync({ ...local, downloadedAt: meta.value.uploadedAt, downloadedFrom: meta.value.host });
  log(`共享状态已覆盖到本机，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
}

async function syncUp() {
  const started = Date.now();
  const temporary = path.join(os.tmpdir(), `stock-replay-state-${process.pid}.tar.gz`);
  const dirs = STATE_DIRS.filter(dir => fs.existsSync(path.join(ROOT, dir)));
  execFileSync('tar', ['-czf', temporary, ...STATE_EXCLUDES.map(pattern => `--exclude=${pattern}`), '-C', ROOT, ...dirs], { stdio: 'inherit' });
  const bytes = fs.statSync(temporary).size;
  await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: STATE_KEY, Body: fs.createReadStream(temporary), ContentLength: bytes, ContentType: 'application/gzip' }));
  fs.unlinkSync(temporary);
  const uploadedAt = now();
  await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: META_KEY, Body: JSON.stringify({ host: options.host, uploadedAt, bytes }), ContentType: 'application/json' }));
  writeLocalSync({ ...readLocalSync(), uploadedAt });
  log(`本机状态已上传 R2（${(bytes / 1048576).toFixed(0)} MB，用时 ${Math.round((Date.now() - started) / 1000)} 秒）`);
}

async function main() {
  if (options.syncUp || options.syncDown) {
    if (options.syncDown) await syncDown();
    if (options.syncUp) await syncUp();
    return 0;
  }
  const { date: tradeDate } = await latestClosedTradeDay();
  const key = `${options.statusPrefix}${tradeDate}.json`;
  log(`${options.host}（${options.role === 'primary' ? '主' : '备'}）检查 ${tradeDate}`);
  const claimed = await claim(key, tradeDate);
  if (!claimed) return 0;
  let { etag, record } = claimed;
  let lost = false;
  let child;
  let beating = Promise.resolve();
  // 心跳：ETag 对不上说明被别人接手了，停掉自己的任务
  const beat = setInterval(() => { beating = beating.then(async () => {
    if (lost) return;
    try {
      const next = await putStatus(key, { ...record, heartbeatAt: now() }, etag);
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
  try {
    try {
      if (!options.testCommand) await syncDown();
    } catch (error) {
      log(`!!! 下载共享状态失败，用本机的继续：${error.message}`);
    }
    exitCode = await new Promise(resolve => {
      const [command, ...args] = options.testCommand ? ['sh', '-c', options.testCommand] : [process.execPath, path.join(ROOT, 'daily-update.js'), '--yes'];
      child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', detached: process.platform !== 'win32' });
      child.on('exit', code => resolve(code ?? 1));
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
  if (lost) return 1;
  const done = await putStatus(key, { ...record, state: 'done', heartbeatAt: now(), finishedAt: now(), exitCode }, etag);
  log(done ? `${tradeDate} 跑完，退出码 ${exitCode}，标记已改为 done` : '!!! 写 done 时标记已被别人改了');
  return exitCode;
}

main().then(code => process.exit(code), error => {
  console.error(`!!! 协调失败: ${error.stack || error.message}`);
  process.exit(1);
});
