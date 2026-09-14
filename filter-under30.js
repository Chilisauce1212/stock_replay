require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { r2Client, writeJson } = require('./r2-storage');

const TEST_CASE_DIR = path.join(__dirname, 'test-cases');
const API_URL = process.env.KLINE_API_URL || 'http://localhost:3000/api/kline';
const REQUEST_CONCURRENCY = 5;
const SOURCE_RANGES = [
  ['20240104', '20241231'],
  ['20250104', '20251231'],
  ['20260106', '20261231'],
];

function sourceFile(start, end) {
  return path.join(TEST_CASE_DIR, `一进二回测_${start}_${end}.json`);
}

function outputFile(start, end) {
  return path.join(TEST_CASE_DIR, `一进二回测_小于30元_${start}_${end}.json`);
}

function outputKey(start, end) {
  return `test-cases/一进二回测_小于30元_${start}_${end}.json`;
}

async function getClosePrice(item) {
  const response = await axios.get(API_URL, {
    params: { code: item.code, cutoffDate: item.date },
    timeout: 30000,
  });
  const rows = response.data?.data || [];
  const target = rows.find(row => row.date === item.date);
  const price = Number(target?.close);
  return Number.isFinite(price) ? price : null;
}

async function filterFile(start, end) {
  const inputPath = sourceFile(start, end);
  const outputPath = outputFile(start, end);
  if (!fs.existsSync(inputPath)) throw new Error(`找不到源文件: ${inputPath}`);

  const cases = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const prices = new Array(cases.length);
  let nextIndex = 0;
  let completed = 0;
  let missing = 0;

  async function worker() {
    while (nextIndex < cases.length) {
      const index = nextIndex;
      nextIndex += 1;
      let price = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          price = await getClosePrice(cases[index]);
          break;
        } catch (error) {
          if (attempt === 3) {
            console.error(`查询失败 ${cases[index].code} ${cases[index].date}: ${error.message}`);
          } else {
            await new Promise(resolve => setTimeout(resolve, attempt * 300));
          }
        }
      }
      prices[index] = price;
      if (price === null) missing += 1;
      completed += 1;
      if (completed % 50 === 0 || completed === cases.length) {
        console.log(`${start}-${end} 处理进度: ${completed}/${cases.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: REQUEST_CONCURRENCY }, worker));
  const filtered = cases.filter((_, index) => prices[index] < 30);
  fs.writeFileSync(outputPath, `${JSON.stringify(filtered, null, 2)}\n`, 'utf8');

  if (r2Client) {
    await writeJson(outputKey(start, end), filtered);
  }
  console.log(`${path.basename(outputPath)}: ${filtered.length}/${cases.length} 条，未匹配 ${missing} 条${r2Client ? '，已写入 R2' : ''}`);
}

async function main() {
  for (const [start, end] of SOURCE_RANGES) {
    await filterFile(start, end);
  }
}

main().catch(error => {
  console.error(`低价回测筛选失败: ${error.message}`);
  process.exitCode = 1;
});
