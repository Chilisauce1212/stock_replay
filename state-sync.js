'use strict';

// 主备两台机器之间按内容增量同步本地状态（reports/、daily-review/、test-cases/），经 R2 state/v2/（2026-11-19）。
// 以前整包 tar.gz（约 151 MB）每次全传，家宽 5 分多钟、阿里云 7 分钟；其实每天只变一小部分：
//   - 普通文件：按 sha256 比，没变不传
//   - 大的 JSON 对象缓存（news-body-cache / news-cache / news-llm 等 >8 MB 的）：按键的顺序每 2000 条切一块，每块单独 sha256；
//     这些缓存只追加、改的多是最近的条目，每天一般只变最后一两块
// R2 上：state/v2/manifest.json 记每个文件（整文件哈希或分块哈希列表）；state/v2/blobs/<sha256>.gz 按内容存（相同内容只存一份），
// 上传后删掉 manifest 不再引用的块。本机 reports/.state-manifest.json 记上次同步时每个文件的大小、修改时间和哈希，没变的不重算。
// 内容不常驻内存（阿里云堆只有 1.1 GB）：上传、下载时一次读一个文件。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { r2Client, R2_BUCKET } = require('./r2-storage');

const PREFIX = 'state/v2/';
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const BLOB_PREFIX = `${PREFIX}blobs/`;
const DIRS = ['reports', 'daily-review', 'test-cases'];
// 日志、问财登录状态（各机器自己的凭证）、同步自己的记录、临时文件不同步
const EXCLUDE = [/^reports\/daily-update-.*\.log$/, /^reports\/wencai-state\.json$/, /^reports\/\.state-(sync|manifest)\.json$/, /\.tmp$/, /\.sync-tmp$/];
const CHUNK_MIN_BYTES = 8 * 1048576;
const CHUNK_ENTRIES = 2000;
const CONCURRENCY = 6;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const isMissing = error => error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;
const blobKey = hash => `${BLOB_PREFIX}${hash}.gz`;
const hashesOf = entry => (entry.chunks ? entry.chunks : [entry.hash]);
const sameContent = (left, right) => Boolean(left && right) && JSON.stringify(hashesOf(left)) === JSON.stringify(hashesOf(right));

function listFiles(root) {
  const files = [];
  const walk = relative => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && !EXCLUDE.some(pattern => pattern.test(child))) files.push(child);
    }
  };
  DIRS.forEach(walk);
  return files.sort();
}

// 大 JSON 对象切块：返回 [{ hash, text }]；不是对象（数组、解析失败）返回 null，按整文件处理
function chunkJson(buffer) {
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  const chunks = [];
  for (let start = 0; start < entries.length; start += CHUNK_ENTRIES) {
    const text = JSON.stringify(Object.fromEntries(entries.slice(start, start + CHUNK_ENTRIES)));
    chunks.push({ hash: sha256(text), text });
  }
  return chunks;
}

// 读一个文件：返回描述 { size, mtimeMs, hash | chunks } 和 哈希 → 内容
function readEntry(root, file) {
  const absolute = path.join(root, file);
  const stat = fs.statSync(absolute);
  const buffer = fs.readFileSync(absolute);
  const chunks = stat.size >= CHUNK_MIN_BYTES && file.endsWith('.json') ? chunkJson(buffer) : null;
  if (chunks) {
    return {
      entry: { size: stat.size, mtimeMs: stat.mtimeMs, chunks: chunks.map(chunk => chunk.hash) },
      contents: new Map(chunks.map(chunk => [chunk.hash, chunk.text])),
    };
  }
  const hash = sha256(buffer);
  return { entry: { size: stat.size, mtimeMs: stat.mtimeMs, hash }, contents: new Map([[hash, buffer]]) };
}

// 本机所有文件的描述；大小和修改时间同上次的直接用上次的哈希
function describeLocal(root, previous = {}) {
  const described = {};
  for (const file of listFiles(root)) {
    const stat = fs.statSync(path.join(root, file));
    const last = previous[file];
    described[file] = last && last.size === stat.size && last.mtimeMs === stat.mtimeMs ? last : readEntry(root, file).entry;
  }
  return described;
}

async function getJson(key) {
  try {
    const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function pool(items, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

async function listBlobKeys() {
  const keys = [];
  let token;
  do {
    const response = await r2Client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: BLOB_PREFIX, ContinuationToken: token }));
    for (const item of response.Contents || []) keys.push(item.Key);
    token = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

const localManifestFile = root => path.join(root, 'reports', '.state-manifest.json');

function readLocalManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(localManifestFile(root), 'utf8'));
  } catch {
    return { files: {} };
  }
}

function writeLocalManifest(root, value) {
  fs.mkdirSync(path.dirname(localManifestFile(root)), { recursive: true });
  fs.writeFileSync(localManifestFile(root), JSON.stringify(value));
}

// 上传：只传 R2 上还没有的块，再写 manifest、清理不再引用的块
async function upload(root, host, log = console.log) {
  const local = readLocalManifest(root);
  const remote = await getJson(MANIFEST_KEY);
  const described = describeLocal(root, local.files);
  const existing = new Set(Object.values(remote?.files || {}).flatMap(hashesOf));
  const sent = new Set();
  let bytes = 0;
  for (const [file, entry] of Object.entries(described)) {
    const missing = [...new Set(hashesOf(entry))].filter(hash => !existing.has(hash) && !sent.has(hash));
    if (!missing.length) continue;
    const { contents } = readEntry(root, file);
    await pool(missing, async hash => {
      const content = contents.get(hash);
      if (content === undefined) throw new Error(`${file} 在上传过程中被改了`);
      const body = zlib.gzipSync(content);
      await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: blobKey(hash), Body: body, ContentType: 'application/gzip' }));
      bytes += body.length;
      sent.add(hash);
    });
  }
  const uploadedAt = new Date().toISOString();
  const files = Object.fromEntries(Object.entries(described).map(([file, entry]) => [file, entry.chunks ? { size: entry.size, chunks: entry.chunks } : { size: entry.size, hash: entry.hash }]));
  await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: MANIFEST_KEY, Body: JSON.stringify({ host, uploadedAt, files }), ContentType: 'application/json' }));
  writeLocalManifest(root, { host, uploadedAt, syncedAt: uploadedAt, direction: 'up', files: described });
  const referenced = new Set(Object.values(files).flatMap(hashesOf).map(blobKey));
  const stale = (await listBlobKeys()).filter(key => !referenced.has(key));
  for (let index = 0; index < stale.length; index += 1000) {
    await r2Client.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: stale.slice(index, index + 1000).map(Key => ({ Key })), Quiet: true } }));
  }
  log(`共享状态已增量上传：${Object.keys(files).length} 个文件，新传 ${sent.size} 块（压缩后 ${(bytes / 1048576).toFixed(1)} MB），清理旧块 ${stale.length} 个`);
  return { uploadedAt, blocks: sent.size, bytes };
}

async function getBlob(hash) {
  const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: blobKey(hash) }));
  const body = zlib.gunzipSync(Buffer.from(await response.Body.transformToByteArray()));
  if (sha256(body) !== hash) throw new Error(`块 ${hash} 校验失败`);
  return body;
}

// 下载：R2 上的状态是另一台传的、且比本机上次同步新才下载；只下本机没有的块（force 不看这些条件）
async function download(root, host, { force = false, log = console.log } = {}) {
  const remote = await getJson(MANIFEST_KEY);
  if (!remote) return log('R2 上还没有共享状态（v2），用本机的');
  const local = readLocalManifest(root);
  if (!force && remote.host === host) return log(`R2 上的共享状态是本机 ${remote.uploadedAt} 传的，不用下载`);
  if (!force && local.syncedAt && Date.parse(remote.uploadedAt) <= Date.parse(local.syncedAt)) return log(`R2 上的共享状态（${remote.host} ${remote.uploadedAt}）不比本机新，不用下载`);
  const described = describeLocal(root, local.files);
  const changed = Object.entries(remote.files).filter(([file, entry]) => !sameContent(described[file], entry));
  let fetched = 0;
  let bytes = 0;
  const after = { ...described };
  for (const [file, entry] of changed) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 本机这个文件现有的块直接用，只下载缺的
    const contents = fs.existsSync(target) ? readEntry(root, file).contents : new Map();
    let output;
    if (entry.chunks) {
      const texts = [];
      await pool(entry.chunks.map((hash, index) => ({ hash, index })), async ({ hash, index }) => {
        let text = contents.get(hash);
        if (typeof text !== 'string') {
          const body = await getBlob(hash);
          fetched++;
          bytes += body.length;
          text = body.toString('utf8');
        }
        texts[index] = text;
      });
      const merged = {};
      for (const text of texts) Object.assign(merged, JSON.parse(text));
      output = `${JSON.stringify(merged)}\n`;
    } else {
      output = contents.get(entry.hash);
      if (!Buffer.isBuffer(output)) {
        output = await getBlob(entry.hash);
        fetched++;
        bytes += output.length;
      }
    }
    fs.writeFileSync(`${target}.sync-tmp`, output);
    fs.renameSync(`${target}.sync-tmp`, target);
    const stat = fs.statSync(target);
    after[file] = { ...entry, size: stat.size, mtimeMs: stat.mtimeMs };
  }
  writeLocalManifest(root, { host: remote.host, uploadedAt: remote.uploadedAt, syncedAt: remote.uploadedAt, direction: 'down', files: after });
  log(`已从 ${remote.host}（${remote.uploadedAt}）增量下载共享状态：${changed.length} 个文件有变化，下载 ${fetched} 块（${(bytes / 1048576).toFixed(1)} MB）`);
}

module.exports = { upload, download, listFiles, chunkJson };
