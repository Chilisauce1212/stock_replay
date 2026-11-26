require('dotenv').config({ quiet: true });

const { S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, CopyObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { HttpsProxyAgent } = require('https-proxy-agent');

const R2_BUCKET = process.env.R2_BUCKET || 'favorites';
const R2_ENDPOINT = process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID
  ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : '');
// FORCE_LOCAL=true（npm run daily-update -- --local 会设置）时当作没配 R2：所有脚本只读写本地文件。
const FORCE_LOCAL = process.env.FORCE_LOCAL === 'true';
// 覆盖 R2 对象前先复制一份到 backups/<时间>/<原路径>，误写时可以找回；daily-update 会删掉 30 天前的备份。
const BACKUP_PREFIX = 'backups/';
// R2 专用代理 R2_PROXY（2026-11-23 加，软路由 .env 设为 OpenClash 的 http://192.168.101.1:7890）：软路由直连 R2 下载 5 MB 要 34–197 秒、
// 上传 72 秒，走代理 7–16 秒、4 秒。只影响 R2，抓新闻、通达信、问财不走它。没设 R2_PROXY 时沿用 HTTPS_PROXY 等通用变量
const R2_PROXY = process.env.R2_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
const makeClient = proxy => new S3Client({
  endpoint: R2_ENDPOINT,
  region: 'auto',
  maxAttempts: 4, // 超时、断线、5xx 由 SDK 重试，共 4 次
  // 超时（2026-11-16）：经代理的请求偶尔挂住不返回，news-calendar --upload 卡了半小时。
  // 2026-11-23 发现：只设 requestTimeout 时 SDK 只打一行 WARN、不断开（软路由一次下载挂了 781 秒），
  // 必须加 throwOnRequestTimeout 才会报错、由 SDK 重试（默认共 3 次）。requestTimeout 是连接多久没有数据算卡住，30 秒足够
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    throwOnRequestTimeout: true,
    ...(proxy ? { httpsAgent: new HttpsProxyAgent(proxy) } : {}),
  }),
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const r2Client = !FORCE_LOCAL && R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY ? makeClient(R2_PROXY) : null;
// 代理本身连不上（OpenClash 停了、端口变了）时退回直连，本进程之后都直连；R2 自己报的错照常抛出
if (r2Client && R2_PROXY) {
  const viaProxy = r2Client.send.bind(r2Client);
  let direct = null;
  // 2026-11-26 加超时：当晚 21:22–21:35 走代理的 R2 请求 4 次都 30 秒没响应（代理节点卡住），三步失败；直连当时是好的。
  // 所以 SDK 自己重试完仍超时的，也换直连再试（本进程之后都直连）
  const proxyDown = error => /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|ETIMEDOUT|socket hang up|Proxy|407|requestTimeout|TimeoutError/i.test(`${error.code || ''} ${error.name || ''} ${error.message || ''}`) && !error.$metadata?.httpStatusCode;
  r2Client.send = async (command, ...rest) => {
    if (direct) return direct.send(command, ...rest);
    try {
      return await viaProxy(command, ...rest);
    } catch (error) {
      if (!proxyDown(error)) throw error;
      console.error(`!!! R2 代理 ${R2_PROXY} 连不上或没响应（${(error.code || error.message || '').slice(0, 60)}），改为直连`);
      direct = makeClient('');
      return direct.send(command, ...rest);
    }
  };
}

function assertConfigured() {
  if (!r2Client) throw new Error('R2 未配置，请设置 R2_ENDPOINT、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY 和 R2_BUCKET');
}

// 读写的本地缓存（2026-11-23 加）：软路由到 R2 下载约 1 MB/s，一次每日更新里同一个回测文件（约 5 MB）要下载七八次。
// 读之前先 HEAD 取 ETag（0.4 秒），和 .r2-cache/ 里存的一样就直接用本地这份；自己写进去的内容也存一份。
// 缓存放在项目根目录 .r2-cache/（不在 reports/ 里，主备同步不会传它；git 也忽略）。删掉整个目录也没关系，只是下次重新下载
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CACHE_DIR = path.join(__dirname, '.r2-cache');
const cacheFile = key => path.join(CACHE_DIR, encodeURIComponent(key));
const cleanEtag = etag => String(etag || '').replace(/"/g, '');
const md5Of = text => crypto.createHash('md5').update(text).digest('hex');
const bodyOf = value => `${JSON.stringify(value, null, 2)}\n`;

function readCache(key, etag) {
  try {
    const meta = JSON.parse(fs.readFileSync(`${cacheFile(key)}.meta`, 'utf8'));
    if (!etag || meta.etag !== etag) return null;
    return fs.readFileSync(cacheFile(key), 'utf8');
  } catch {
    return null;
  }
}

function writeCache(key, etag, text) {
  if (!etag) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(`${cacheFile(key)}.tmp`, text, 'utf8');
    fs.renameSync(`${cacheFile(key)}.tmp`, cacheFile(key));
    fs.writeFileSync(`${cacheFile(key)}.meta`, JSON.stringify({ etag, savedAt: new Date().toISOString() }));
  } catch {
    // 缓存写不进去不影响读写本身
  }
}

const isMissing = error => error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404;

// 对象的 ETag 和自定义元数据；不存在返回 null
async function headObject(key) {
  try {
    const head = await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return { etag: cleanEtag(head.ETag), metadata: head.Metadata || {} };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readObjectText(key) {
  assertConfigured();
  const head = await headObject(key);
  if (!head) throw Object.assign(new Error(`R2 没有 ${key}`), { name: 'NoSuchKey' });
  const cached = readCache(key, head.etag);
  if (cached !== null) return cached;
  // SDK 的重试只管到拿到响应头；正文读到一半卡住（超时断开）不会重试，这里自己再重试，共 3 次
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      const text = Buffer.from(await response.Body.transformToByteArray()).toString('utf8');
      writeCache(key, cleanEtag(response.ETag), text);
      return text;
    } catch (error) {
      if (isMissing(error) || attempt >= 3) throw error;
      console.error(`R2 读 ${key} 失败（${error.name || error.code}: ${String(error.message).slice(0, 60)}），${attempt * 3} 秒后重试`);
      await new Promise(resolve => setTimeout(resolve, attempt * 3000));
    }
  }
}

async function readJson(key) {
  return JSON.parse(await readObjectText(key));
}

function backupStamp(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

// 写 JSON 到 R2。原对象存在时先备份；原对象和新值都是数组、且新数组更短时拒绝写入（防止拿不完整的本地文件覆盖），
// 确实要删记录时传 allowShrink（如每天整体替换的今日首板）。
// 2026-11-23 起：内容和 R2 上完全一样就不写（不备份、不上传）；数组条数写进对象元数据 count，检查「变短」只要 HEAD，
// 没有 count 的旧对象才下载下来数（经缓存）。返回 true 表示写了
async function writeJson(key, value, { allowShrink = false } = {}) {
  assertConfigured();
  if (key.startsWith(BACKUP_PREFIX)) throw new Error(`不能直接写备份目录: ${key}`);
  const body = bodyOf(value);
  const head = await headObject(key);
  if (head && head.etag === md5Of(body)) {
    writeCache(key, head.etag, body);
    return false;
  }
  if (head) {
    if (!allowShrink && Array.isArray(value)) {
      const counted = head.metadata.count !== undefined ? Number(head.metadata.count) : NaN;
      const length = Number.isFinite(counted) ? counted : await readJson(key).then(existing => (Array.isArray(existing) ? existing.length : -1));
      if (value.length < length) {
        throw new Error(`R2 ${key} 现有 ${length} 条，新内容只有 ${value.length} 条，已拒绝写入（确认要删记录时用 allowShrink）`);
      }
    }
    await r2Client.send(new CopyObjectCommand({
      Bucket: R2_BUCKET,
      CopySource: `${R2_BUCKET}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
      Key: `${BACKUP_PREFIX}${backupStamp()}/${key}`,
    }));
  }
  const response = await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/json; charset=utf-8',
    ...(Array.isArray(value) && { Metadata: { count: String(value.length) } }),
  }));
  writeCache(key, cleanEtag(response.ETag), body);
  return true;
}

// R2 上的对象和 writeJson(key, value) 要写的内容是否完全一样：只发 HEAD 取 ETag（单次上传的 ETag 是内容的 MD5），不下载正文。
// 2026-11-23 加：news-calendar --upload 以前把 35 个月（82 MB）全部下载下来比较，软路由上要 27 分钟
async function sameAsRemote(key, value) {
  assertConfigured();
  const head = await headObject(key);
  return Boolean(head && head.etag === md5Of(bodyOf(value)));
}

async function listObjects(prefix) {
  assertConfigured();
  const objects = [];
  let continuationToken;
  do {
    const response = await r2Client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: continuationToken }));
    objects.push(...(response.Contents || []));
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

// 删除 days 天前的备份，返回删除个数
async function pruneBackups(days = 30) {
  const cutoff = backupStamp(new Date(Date.now() - days * 86400_000));
  const stale = (await listObjects(BACKUP_PREFIX))
    .map(item => item.Key)
    .filter(key => key && key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + cutoff.length) < cutoff);
  for (let index = 0; index < stale.length; index += 1000) {
    await r2Client.send(new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: { Objects: stale.slice(index, index + 1000).map(Key => ({ Key })), Quiet: true },
    }));
  }
  return stale.length;
}

async function listJsonKeys(prefix) {
  assertConfigured();
  const keys = [];
  let continuationToken;
  do {
    const response = await r2Client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const item of response.Contents || []) {
      if (item.Key && item.Key.toLowerCase().endsWith('.json')) keys.push(item.Key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

module.exports = { sameAsRemote,
  R2_BUCKET, FORCE_LOCAL, BACKUP_PREFIX, r2Client, isMissing, readJson, writeJson, listJsonKeys, pruneBackups };
