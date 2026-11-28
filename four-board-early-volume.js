#!/usr/bin/env node
'use strict';

// 四连板及以上里「一二板放量」的子集（2026-11-28 用户要求）：首板或二板的成交量 ≥ 首板前最大量 × 0.8 的票，
// 单独存成 daily-review/四连板及以上_一二板放量.json，给复盘页按这类票单独练「什么时候兑现」。
// 首板前最大量＝复盘页图表上首板之前已加载的全部日 K（同花顺接口一次最多约 350 根，和 /api/kline 同一个来源）里的最大成交量，
// 和复盘页「量能提示」用的口径一致。记录原样复制四连板及以上的字段，另加 earlyVolume（一二板较大量、首板前最大量及日期、倍数）。
// 用法: npm run four-board-early-volume -- [--min-share 0.8] [--no-upload] [--source 四连板及以上.json 的路径]

const fs = require('fs');
const path = require('path');
const { fetchThsKlineData, processThsValues } = require('./server');
const { r2Client, writeJson } = require('./r2-storage');

const REVIEW_DIR = path.join(__dirname, 'daily-review');
const SOURCE_FILE = path.join(REVIEW_DIR, '四连板及以上.json');
const OUTPUT_NAME = '四连板及以上_一二板放量.json';

function parseArgs(argv) {
  const options = { minShare: 0.8, upload: true, workers: 4, source: SOURCE_FILE };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--min-share') options.minShare = Number(argv[++index]);
    else if (argument === '--no-upload') options.upload = false;
    else if (argument === '--source') options.source = path.resolve(argv[++index] || '');
    else if (argument === '--workers') options.workers = Number(argv[++index]);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数 ${argument}`);
  }
  if (!(options.minShare > 0)) throw new Error('--min-share 要是正数');
  return options;
}

async function earlyVolumeOf(item) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bars = processThsValues(await fetchThsKlineData(item.code, item.date));
      const index = bars.findIndex(bar => bar.date === item.date);
      if (index < 1 || index + 1 >= bars.length) throw new Error('K 线里没有首板或二板');
      let preMax = 0;
      let preMaxDate = '';
      for (let k = 0; k < index; k++) {
        if (bars[k].volume > preMax) {
          preMax = bars[k].volume;
          preMaxDate = bars[k].date;
        }
      }
      const early = Math.max(bars[index].volume, bars[index + 1].volume);
      return {
        earlyMax: early,
        earlyMaxDate: bars[index].volume >= bars[index + 1].volume ? bars[index].date : bars[index + 1].date,
        preSignalMax: preMax,
        preSignalMaxDate: preMaxDate,
        share: preMax > 0 ? Number((early / preMax).toFixed(3)) : null,
        barsBefore: index,
      };
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('用法: npm run four-board-early-volume -- [--min-share 0.8] [--no-upload] [--source 四连板及以上.json 的路径]');
    return;
  }
  const source = JSON.parse(fs.readFileSync(options.source, 'utf8'));
  const results = new Map();
  const failed = [];
  let next = 0;
  await Promise.all(Array.from({ length: options.workers }, async () => {
    while (next < source.length) {
      const item = source[next++];
      try {
        results.set(item.id, await earlyVolumeOf(item));
      } catch (error) {
        failed.push(`${item.stockName}(${item.date}): ${error.message}`);
      }
    }
  }));
  const picked = source
    .filter(item => results.get(item.id)?.share >= options.minShare)
    .map(item => ({ ...item, earlyVolume: results.get(item.id) }));
  console.log(`四连板及以上 ${source.length} 条，一二板较大量 ≥ 首板前最大量 × ${options.minShare} 的 ${picked.length} 条`);
  if (failed.length) console.log(`!!! ${failed.length} 条 K 线没取到：${failed.join('；')}`);
  if (failed.length > source.length * 0.05) throw new Error('K 线失败超过 5%，没写入');
  fs.writeFileSync(path.join(REVIEW_DIR, OUTPUT_NAME), `${JSON.stringify(picked, null, 2)}\n`, 'utf8');
  console.log(`已写入 daily-review/${OUTPUT_NAME}`);
  if (options.upload && r2Client) {
    await writeJson(`daily-review/${OUTPUT_NAME}`, picked, { allowShrink: true });
    console.log(`已上传 R2 daily-review/${OUTPUT_NAME}`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(error => {
    console.error(`!!! ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
