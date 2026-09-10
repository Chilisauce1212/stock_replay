require('dotenv').config();

const { CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { r2Client, R2_BUCKET } = require('./r2-storage');

const keepInDailyReview = '今日首板.json';

async function copyAndDelete(sourceKey, targetKey) {
  await r2Client.send(new CopyObjectCommand({
    Bucket: R2_BUCKET,
    CopySource: `${R2_BUCKET}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
    Key: targetKey,
  }));
  await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: sourceKey }));
  console.log(`已恢复: ${sourceKey} -> ${targetKey}`);
}

const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

(async () => {
  if (!r2Client) throw new Error('R2 未配置');
  let continuationToken;
  let count = 0;
  do {
    const result = await r2Client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: 'daily-review/',
      ContinuationToken: continuationToken,
    }));
    const files = (result.Contents || []).filter(item => item.Key && !item.Key.endsWith('/') && !item.Key.endsWith(keepInDailyReview));
    for (const item of files) {
      const fileName = item.Key.slice('daily-review/'.length);
      await copyAndDelete(item.Key, `test-cases/${fileName}`);
      count += 1;
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  console.log(`完成：保留 daily-review/${keepInDailyReview}，恢复 ${count} 个回测文件到 test-cases/。`);
})().catch(error => {
  console.error(`恢复失败: ${error.message}`);
  process.exitCode = 1;
});
