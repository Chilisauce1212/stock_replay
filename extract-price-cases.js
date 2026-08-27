const fs = require('fs');
const path = require('path');
const axios = require('axios');

const testCaseDir = path.join(__dirname, 'test-cases');
const outputNames = new Set([
  '大于30元.json',
  '小于3元.json',
  '三连板及以上.json',
  '五连板及以上.json',
]);
const sourceFiles = fs.readdirSync(testCaseDir)
  .filter(fileName => fileName.endsWith('.json') && !outputNames.has(fileName));
const allCases = sourceFiles.flatMap(fileName => JSON.parse(
  fs.readFileSync(path.join(testCaseDir, fileName), 'utf8')
));
const requestConcurrency = 5;

async function getCaseData(item) {
  const response = await axios.get('http://localhost:3000/api/kline', {
    params: { code: item.code, cutoffDate: item.date },
    timeout: 30000,
  });
  const data = response.data?.data || [];
  const targetIndex = data.findIndex(row => row.date === item.date);
  if (targetIndex < 0) return null;

  const target = data[targetIndex];
  let boardCount = 0;
  for (let index = targetIndex; index < data.length; index += 1) {
    if (data[index].limitStatus !== 'limit-up') break;
    boardCount += 1;
  }
  return { price: Number(target.close), boardCount };
}

async function main() {
  const prices = new Array(allCases.length);
  const boardCounts = new Array(allCases.length);
  let nextIndex = 0;
  let completed = 0;
  let missing = 0;
  async function worker() {
    while (nextIndex < allCases.length) {
      const index = nextIndex++;
      let caseData;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          caseData = await getCaseData(allCases[index]);
          break;
        } catch (error) {
          if (attempt === 3) console.error(`${allCases[index].code} ${allCases[index].date}: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, attempt * 300));
        }
      }
      if (!caseData || !Number.isFinite(caseData.price)) missing += 1;
      prices[index] = caseData?.price;
      boardCounts[index] = caseData?.boardCount;
      completed += 1;
      if (completed % 50 === 0 || completed === allCases.length) {
        const percentage = ((completed / allCases.length) * 100).toFixed(1);
        console.log(`处理进度: ${completed}/${allCases.length} (${percentage}%)`);
      }
    }
  }
  await Promise.all(Array.from({ length: requestConcurrency }, worker));

  const above30 = [];
  const below3 = [];
  const threeBoard = [];
  const fiveBoard = [];
  allCases.forEach((item, index) => {
    if (prices[index] > 30) above30.push(item);
    if (prices[index] < 3) below3.push(item);
    if (boardCounts[index] >= 3) threeBoard.push(item);
    if (boardCounts[index] >= 5) fiveBoard.push(item);
  });
  const outputs = [
    ['大于30元.json', above30],
    ['小于3元.json', below3],
    ['三连板及以上.json', threeBoard],
    ['五连板及以上.json', fiveBoard],
  ];
  outputs.forEach(([fileName, cases]) => fs.writeFileSync(
    path.join(testCaseDir, fileName),
    JSON.stringify(cases, null, 2),
    { encoding: 'utf8', flag: 'w' }
  ));
  console.log(`总记录: ${allCases.length}，大于30元: ${above30.length}，小于3元: ${below3.length}，三连板及以上: ${threeBoard.length}，五连板及以上: ${fiveBoard.length}，未匹配: ${missing}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
