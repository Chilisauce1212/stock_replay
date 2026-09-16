require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { r2Client, R2_BUCKET, writeJson } = require('./r2-storage');

function assertConfigured() {
  if (!r2Client) throw new Error('R2 未配置，请设置 R2_ENDPOINT、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY 和 R2_BUCKET');
}

function collectJsonFiles(relativeDirectory) {
  const directory = path.join(__dirname, relativeDirectory);
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return collectJsonFiles(relativePath);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.json') ? [relativePath] : [];
  });
}

function getUploadFiles() {
  const files = [
    ...collectJsonFiles('test-cases'),
    ...collectJsonFiles('daily-review'),
  ];
  const favoritesPath = path.join(__dirname, 'favorites.json');
  if (fs.existsSync(favoritesPath)) files.push('favorites.json');
  return files;
}

async function uploadAll() {
  assertConfigured();
  const files = getUploadFiles();
  if (!files.length) {
    console.log('没有找到可上传的 JSON 文件。');
    return;
  }

  for (const relativePath of files) {
    const localPath = path.join(__dirname, relativePath);
    const value = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const objectKey = relativePath.split(path.sep).join('/');
    await writeJson(objectKey, value);
    console.log(`已上传: ${objectKey}`);
  }

  console.log(`完成，共上传 ${files.length} 个对象到 R2 Bucket ${R2_BUCKET}。`);
}

uploadAll().catch(error => {
  console.error(`上传失败: ${error.message}`);
  process.exitCode = 1;
});
