const fs = require('fs');
const path = require('path');
const axios = require('axios');

const testCaseDir = path.join(__dirname, 'test-cases');
const outputNames = new Set(['大于30元.json', '小于3元.json']);
const sourceFiles = fs.readdirSync(testCaseDir)
  .filter(fileName => fileName.endsWith('.json') && !outputNames.has(fileName));
const allCases = sourceFiles.flatMap(fileName => JSON.parse(
  fs.readFileSync(path.join(testCaseDir, fileName), 'utf8')
));
const requestConcurrency = 5;

async function getCasePrice(item) {
  const response = await axios.get('http://localhost:3000/api/kline', {
    params: { code: item.code, cutoffDate: item.date },
    timeout: 30000,
  });
  const target = response.data?.data?.find(row => row.date === item.date);
  return target && Number(target.close);
}

async function main() {
  const prices = new Array(allCases.length);
  let nextIndex = 0;
  let completed = 0;
  let missing = 0;
  async function worker() {
    while (nextIndex < allCases.length) {
      const index = nextIndex++;
      let price;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          price = await getCasePrice(allCases[index]);
          break;
        } catch (error) {
          if (attempt === 3) console.error(`${allCases[index].code} ${allCases[index].date}: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, attempt * 300));
        }
      }
      if (!Number.isFinite(price)) missing += 1;
      prices[index] = price;
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
  allCases.forEach((item, index) => {
    if (prices[index] > 30) above30.push(item);
    if (prices[index] < 3) below3.push(item);
  });
  fs.writeFileSync(path.join(testCaseDir, '大于30元.json'), JSON.stringify(above30, null, 2), {
    encoding: 'utf8',
    flag: 'w',
  });
  fs.writeFileSync(path.join(testCaseDir, '小于3元.json'), JSON.stringify(below3, null, 2), {
    encoding: 'utf8',
    flag: 'w',
  });
  console.log(`总记录: ${allCases.length}，大于30元: ${above30.length}，小于3元: ${below3.length}，未匹配: ${missing}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
