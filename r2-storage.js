require('dotenv').config();

const { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, CopyObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
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
const r2Client = !FORCE_LOCAL && R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  ? new S3Client({
    endpoint: R2_ENDPOINT,
    region: 'auto',
    requestHandler: (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
      ? new NodeHttpHandler({
        httpsAgent: new HttpsProxyAgent(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy),
      })
      : undefined,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })
  : null;

function assertConfigured() {
  if (!r2Client) throw new Error('R2 未配置，请设置 R2_ENDPOINT、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY 和 R2_BUCKET');
}

async function readObjectText(key) {
  assertConfigured();
  const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes).toString('utf8');
}

async function readJson(key) {
  return JSON.parse(await readObjectText(key));
}

const isMissing = error => error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;

function backupStamp(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

// 写 JSON 到 R2。原对象存在时先备份；原对象和新值都是数组、且新数组更短时拒绝写入（防止拿不完整的本地文件覆盖），
// 确实要删记录时传 allowShrink（如每天整体替换的今日首板）。
async function writeJson(key, value, { allowShrink = false } = {}) {
  assertConfigured();
  if (key.startsWith(BACKUP_PREFIX)) throw new Error(`不能直接写备份目录: ${key}`);
  let existing;
  try {
    existing = await readJson(key);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing !== undefined) {
    if (!allowShrink && Array.isArray(existing) && Array.isArray(value) && value.length < existing.length) {
      throw new Error(`R2 ${key} 现有 ${existing.length} 条，新内容只有 ${value.length} 条，已拒绝写入（确认要删记录时用 allowShrink）`);
    }
    await r2Client.send(new CopyObjectCommand({
      Bucket: R2_BUCKET,
      CopySource: `${R2_BUCKET}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
      Key: `${BACKUP_PREFIX}${backupStamp()}/${key}`,
    }));
  }
  await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: JSON.stringify(value, null, 2) + '\n',
    ContentType: 'application/json; charset=utf-8',
  }));
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

module.exports = { R2_BUCKET, FORCE_LOCAL, BACKUP_PREFIX, r2Client, isMissing, readJson, writeJson, listJsonKeys, pruneBackups };
