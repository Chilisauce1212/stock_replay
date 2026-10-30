#!/usr/bin/env node
'use strict';

// 把选股判断结果写进 daily-review JSON 每条记录的 judge 字段，供每日复盘页面的新闻面板显示：
//   - 首板涨停原因、归并后的题材
//   - 首板当天同题材的其他涨停（含连板数）、同题材当天刚断板的 2 板以上高标
//   - 大模型新闻判断（reports/news-llm.json）：强类 / 仅弱类 / 无，以及每条重要新闻的类别和依据
//   - 二板日首次在涨停价成交的时间、是否竞价涨停开盘（来自 test-cases/*.detail.json，页面在买入或空仓后才显示）
// 活跃度、量堆由页面按 K 线实时计算，这里不写。
//
// 用法: npm run review-judge -- [文件名关键字...] [--upload]
//   不带关键字则处理 daily-review/ 下全部「一进二回测_*.json」；--upload 同时更新 R2 的 daily-review/ 同名文件
//   （读 R2 上的版本、只改 judge 字段再写回，不覆盖 R2 上的其他改动）
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { RULES, makeTagger, buildDays } = require('./stock-pick');
const { readLimitUpMonths } = require('./limit-up-list');

const ROOT = __dirname;
const REVIEW_DIR = path.join(ROOT, 'daily-review');
const TEST_CASE_DIR = path.join(ROOT, 'test-cases');
const MAX_PEERS_LISTED = 12;

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

function parseArgs(argv) {
  const options = { keywords: [], upload: false };
  for (const argument of argv) {
    if (argument === '--upload') options.upload = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('--')) throw new Error(`未知参数: ${argument}`);
    else options.keywords.push(argument);
  }
  return options;
}

function buildJudges() {
  const tagger = makeTagger();
  const { byDay, days } = buildDays(readLimitUpMonths(), tagger);
  const reasons = readJson(path.join(ROOT, 'reports', '首板涨停原因.json'), {});
  const llm = readJson(path.join(ROOT, 'reports', 'news-llm.json'), {});
  const touches = new Map(fs.readdirSync(TEST_CASE_DIR)
    .filter(file => /^一进二回测_\d{8}_\d{8}\.detail\.json$/.test(file))
    .flatMap(file => readJson(path.join(TEST_CASE_DIR, file), { results: [] }).results.map(item => [`${item.code}|${item.signal}`, item])));

  return item => {
    const key = `${item.code}|${item.date}`;
    const index = days.indexOf(item.date);
    const today = index >= 0 ? byDay.get(item.date) : null;
    const reason = reasons[key]?.reason || today?.get(item.code)?.reason || '';
    const themes = tagger(reason);
    const judge = { reason, themes };

    if (today && themes.length) {
      const sameTheme = other => other.tags.some(tag => themes.includes(tag));
      const peers = [...today.values()]
        .filter(other => other.code !== item.code && sameTheme(other))
        .sort((left, right) => right.streak - left.streak);
      judge.peerCount = peers.length;
      judge.peers = peers.slice(0, MAX_PEERS_LISTED).map(other => ({ name: other.name, streak: other.streak }));
      const yesterday = index > 0 ? byDay.get(days[index - 1]) : null;
      judge.broken = yesterday
        ? [...yesterday.values()]
          .filter(other => other.code !== item.code && other.streak >= 2 && !today.has(other.code) && sameTheme(other))
          .sort((left, right) => right.streak - left.streak)
          .map(other => ({ name: other.name, streak: other.streak }))
        : [];
    }

    const entry = llm[key];
    if (entry) {
      const important = entry.result.news.filter(news => news.important);
      const categories = [...new Set(important.flatMap(news => news.categories || []))];
      judge.news = {
        verdict: categories.some(category => RULES.strongCategories.includes(category)) ? '强类'
          : entry.result.hasImportantNews ? '仅弱类' : '无',
        categories,
        items: important.map(news => {
          const [time, ...title] = String(entry.newsIds[Number(news.id.slice(1)) - 1] || '').split('|');
          return { time, title: title.join('|'), categories: news.categories || [], newThing: news.newThing || '', reason: news.reason || '' };
        }).filter(news => news.title),
      };
    }

    const touch = touches.get(key);
    if (touch) {
      judge.firstTouch = touch.firstTouch;
      judge.openAtLimit = touch.openAtLimit;
    }
    return judge;
  };
}

function applyJudges(records, judgeOf) {
  let withNews = 0;
  for (const record of records) {
    record.judge = judgeOf(record);
    if (record.judge.news) withNews++;
  }
  return withNews;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 14).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const files = fs.readdirSync(REVIEW_DIR)
    .filter(file => /^一进二回测_.*\.json$/.test(file))
    .filter(file => !options.keywords.length || options.keywords.some(keyword => file.includes(keyword)));
  if (!files.length) throw new Error('daily-review/ 下没有匹配的一进二回测 JSON');

  const judgeOf = buildJudges();
  const r2 = options.upload ? require('./r2-storage') : null;
  if (r2 && !r2.r2Client) throw new Error('R2 未配置，不能 --upload');

  for (const file of files) {
    const localFile = path.join(REVIEW_DIR, file);
    const records = readJson(localFile, []);
    const withNews = applyJudges(records, judgeOf);
    fs.writeFileSync(localFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    console.log(`${file}: ${records.length} 条，有新闻判断 ${withNews} 条`);
    if (r2) {
      const remote = await r2.readJson(`daily-review/${file}`);
      if (!Array.isArray(remote)) {
        console.log(`  R2 上没有 daily-review/${file}，跳过上传`);
        continue;
      }
      applyJudges(remote, judgeOf);
      await r2.writeJson(`daily-review/${file}`, remote);
      console.log(`  已更新 R2 daily-review/${file}（${remote.length} 条）`);
    }
  }
}

main().catch(error => {
  console.error(`写入判断结果失败: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
