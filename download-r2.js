require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { r2Client, R2_BUCKET } = require('./r2-storage');

function assertConfigured() {
  if (!r2Client) throw new Error('R2 未配置，请设置 R2_ENDPOINT、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY 和 R2_BUCKET');
}

async function downloadAll() {
  assertConfigured();
  let continuationToken;
  let count = 0;

  do {
    const response = await r2Client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      ContinuationToken: continuationToken,
    }));

    for (const item of response.Contents || []) {
      if (!item.Key || item.Key.endsWith('/')) continue;
      const relativePath = item.Key.replace(/^[/\\]+/, '').split('/').join(path.sep);
      const localPath = path.join(__dirname, relativePath);
      if (!localPath.startsWith(`${__dirname}${path.sep}`)) {
        throw new Error(`R2 对象路径不安全: ${item.Key}`);
      }

      const object = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: item.Key }));
      const bytes = await object.Body.transformToByteArray();
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, Buffer.from(bytes));
      count += 1;
      console.log(`已下载: ${item.Key}`);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`完成，共恢复 ${count} 个 R2 对象。`);
}

downloadAll().catch(error => {
  console.error(`下载失败: ${error.message}`);
  process.exitCode = 1;
});
