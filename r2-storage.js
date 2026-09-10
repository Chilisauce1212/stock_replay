require('dotenv').config();

const { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');

const R2_BUCKET = process.env.R2_BUCKET || 'favorites';
const R2_ENDPOINT = process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID
  ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : '');
const r2Client = R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  ? new S3Client({
    endpoint: R2_ENDPOINT,
    region: 'auto',
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

async function writeJson(key, value) {
  assertConfigured();
  await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: JSON.stringify(value, null, 2) + '\n',
    ContentType: 'application/json; charset=utf-8',
  }));
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

module.exports = { R2_BUCKET, r2Client, readJson, writeJson, listJsonKeys };
