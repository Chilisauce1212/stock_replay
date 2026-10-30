#!/usr/bin/env node
'use strict';

// 用四连板用例检验「新闻/题材判断」程序化之后准不准，生成「题材演绎」表格（Excel + 甘特图页面，可编辑）：
// 股票取自用例 JSON，新闻实时调用网站服务的 /api/news，只取首板日和前一个交易日（按交易日历，中间的周末/假期新闻也算），按新闻判断规则锚定重要新闻，
// 再用 K 线计算首板到见顶、到断板的天数。
// 不使用 daily-review/连板股票.json 的涨停原因：那是同花顺事后整理的，不是首板时能看到的新闻。
// 用法: npm run news-theme -- [--input test-cases/四连板及以上.json] [--start YYYYMMDD] [--end YYYYMMDD]
//                             [--out reports/四连板题材演绎.xlsx] [--window 20] [--refresh-news] [--base-url http://localhost:3000]

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { normalizeDate, isLimitUpBar } = require('./public/volume-pile');

const DEFAULT_INPUT = path.join(__dirname, 'test-cases', '四连板及以上.json');
const DEFAULT_OUTPUT = path.join(__dirname, 'reports', '四连板题材演绎.xlsx');
// 新闻按「代码|首板日」缓存，重跑时不重复请求；--refresh-news 重新获取。
const NEWS_CACHE_FILE = path.join(__dirname, 'reports', 'news-cache.json');
const IMPORTANT_SCORE = 2;
// 新闻范围：首板日和前一个交易日，共 2 个连续交易日（按同花顺交易日历，不按个股 K 线，停牌不影响），
// 两个交易日之间的周末/假期新闻也包含在内；前一个交易日没有新闻时就只有首板日的新闻。
const NEWS_TRADING_DAYS = 2;
const MAX_WINDOW = 22;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MANUAL_COLUMNS = ['人工锚定新闻', '人工类别', '人工题材', '备注'];
const NO_NEWS = '无重要新闻';

// 用户的五类重要新闻。命中任一类即有实质语料；同一条命中多类会加分。
// 完整的判断依据写在 prompts/news-classification.md（给大模型用），改标准时两边一起改。
const CATEGORIES = [
  {
    name: '政策规范',
    pattern: /国务院|国常会|政治局|中办|国办|发改委|工信部|商务部|财政部|科技部|住建部|交通运输部|农业农村部|卫健委|网信办|证监会|央行|人民银行|国资委|海关总署|市场监管总局|国家[一-龥]{1,6}局|部委|印发|出台|指导意见|实施方案|行动方案|行动计划|规划|管理办法|新规|政策|免签|补贴|试点|降准|降息|以旧换新|会议提出|官宣/,
  },
  {
    name: '新叙事',
    pattern: /首个|首次|首款|首台|首家|首发|首批|首条|首座|首架|第一次|全球首|国内首|全国首|首飞|首秀|首例|新一代|全新|新品|新纪录|里程碑|填补.{0,4}空白|重大突破|技术突破|首次突破/,
  },
  {
    name: '行业利好',
    pattern: /(行业|产业).{0,6}(利好|春天|拐点|复苏|回暖|迎来|风口|爆发)|迎来.{0,4}利好|多重利好|重磅利好|万亿.{0,6}利好|开工|获批|批复|需求|订单|涨价|提价|价格.{0,6}(上涨|大涨|上调|新高)|供不应求|景气|产能|出货|销量|市场规模|招标|中标|签约|量产|投产|扩产|缺货|紧缺|大单/,
  },
  {
    name: '海外/明星公司',
    pattern: /特斯拉|英伟达|苹果|微软|谷歌|OpenAI|ChatGPT|Sora|Meta|亚马逊|马斯克|黄仁勋|SpaceX|星舰|Optimus|华为|鸿蒙|DeepSeek|深度求索|小米|宇树|字节|豆包|阿里|腾讯|比亚迪|Kimi|月之暗面|智谱|寒武纪|台积电|三星|AMD|博通|高通|智元|Neuralink|FDA|Anthropic|Claude|Gemini/i,
  },
  {
    name: '资本运作转型',
    pattern: /设立.{0,8}(子公司|公司)|成立.{0,8}(子公司|公司)|参设|投资设立|新设|收购|并购|重组|转型|入股|入主|易主|控制权|实控人|实际控制人|股权转让|协议转让|受让|增资|合资|战略合作|注入|划转|定增|资产注入/,
  },
];

// 只描述行情、资金、榜单或例行公告的标题，没有实质语料，直接排除。
const NOISE_PATTERN = /涨停分析|异动解析|龙虎榜|成交明细|主力资金|资金.{0,4}(净流入|净流出|流入|流出)|主力.{0,4}(流入|流出)|游资追踪|股东人数|股东追踪|热榜|早盘回顾|复盘|行业周报|周报|封单|融资融券|北上资金|董事会经营评述|权益分配|股东大会|减持|问询函|异动公告|个股预警|避雷|诉讼|传闻不实|不实|澄清|暂无|未涉及|不涉及|回购.{0,6}进展|大宗交易|概念动态|解构|股票异动|行业追踪|智研咨询|被执行人|刑事|被诉|串通|立案|处罚|终止|聘任|辞职|问董秘|技术分析|财报洞察|融资买入/;
// 只描述板块拉升暴涨的词。标题里只有这些、没有命中任何一类时，判为行情描述。
const MARKET_PATTERN = /涨停|拉升|大涨|暴涨|领涨|走强|活跃|爆发|涨超|连板|封板|飙升|异动|翻倍|狂飙|大幅上涨|涨幅居前/;

function parseArgs(argv) {
  const options = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    start: '',
    end: '',
    window: 20,
    baseUrl: 'http://localhost:3000',
    workers: 3,
    refreshNews: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${argument} 缺少参数值`);
      return next;
    };
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--input') options.input = path.resolve(value());
    else if (argument === '--out') options.output = path.resolve(value());
    else if (argument === '--start') options.start = normalizeDate(value());
    else if (argument === '--end') options.end = normalizeDate(value());
    else if (argument === '--window') options.window = Number(value());
    else if (argument === '--base-url') options.baseUrl = value();
    else if (argument === '--workers') options.workers = Number(value());
    else if (argument === '--refresh-news') options.refreshNews = true;
    else throw new Error(`未知选项: ${argument}`);
  }
  // K 线接口只返回到首板后一个月（约 23 根，含首板日），窗口再大也取不到。
  if (!Number.isInteger(options.window) || options.window < 1 || options.window > MAX_WINDOW) {
    throw new Error(`--window 必须是 1～${MAX_WINDOW} 的整数（K 线接口只返回到首板后一个月）`);
  }
  return options;
}

function helpText() {
  return [
    '用法: npm run news-theme -- [选项]',
    '',
    '  --input <JSON>     用例文件（code、date、stockName），默认 test-cases/四连板及以上.json',
    '  --start <日期>     只统计首板日不早于该日期的股票（YYYYMMDD 或 YYYY-MM-DD）',
    '  --end <日期>       只统计首板日不晚于该日期的股票',
    '  --out <xlsx>       输出路径，默认 reports/四连板题材演绎.xlsx',
    '  --window <天数>    首板日起找最高点的交易日窗口，默认 20（最大 22）',
    '  --base-url <地址>  网站服务地址，默认 http://localhost:3000（需先 npm start，新闻和 K 线都从这里取）',
    '  --refresh-news     忽略 reports/news-cache.json 的缓存，重新获取新闻',
    '  --workers <数量>   并发请求数，默认 3',
    '',
    '重新生成时会保留旧表中「人工锚定新闻、人工类别、人工题材、备注」四列（按代码+首板日匹配）。',
  ].join('\n');
}

function classifyNews(item, stockName) {
  const title = String(item.title || '').trim();
  const result = { title, time: String(item.time || ''), url: item.url || '', categories: [], keywords: [], score: 0, verdict: '' };
  if (!title) return { ...result, verdict: '空标题' };
  if (NOISE_PATTERN.test(title)) return { ...result, verdict: '行情/例行信息' };
  for (const category of CATEGORIES) {
    const match = title.match(category.pattern);
    if (match) {
      result.categories.push(category.name);
      result.keywords.push(match[0]);
    }
  }
  if (!result.categories.length) {
    return { ...result, verdict: MARKET_PATTERN.test(title) ? '仅板块拉升描述' : '无实质语料' };
  }
  result.score = result.categories.length + 1;
  // 标题直接点名个股，说明是公司层面的新闻。
  if (stockName && title.includes(stockName)) result.score += 1;
  result.verdict = '实质语料';
  return result;
}

function pickAnchor(record) {
  const classified = (record.news || []).map(item => classifyNews(item, record.stockName));
  const candidates = classified
    .filter(item => item.score > 0)
    // 分数相同取更早的一条：越早越接近催化的源头。
    .sort((left, right) => right.score - left.score || left.time.localeCompare(right.time));
  return {
    anchor: candidates[0] || null,
    candidates,
    newsCount: classified.length,
    marketOnlyCount: classified.filter(item => item.verdict === '仅板块拉升描述').length,
  };
}

function formatBeijingTime(milliseconds) {
  return new Date(milliseconds + BEIJING_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

// 首板日和前一个交易日的个股新闻（含临时置顶），与回放页面的新闻面板同源。
async function fetchNews(baseUrl, code, signalDate) {
  const url = new URL('/api/news', baseUrl);
  url.searchParams.set('code', code);
  url.searchParams.set('date', signalDate);
  url.searchParams.set('days', String(NEWS_TRADING_DAYS));
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const payload = await response.json();
      if (!response.ok || payload.status_code !== 0 || !Array.isArray(payload.data)) {
        throw new Error(payload.msg || `新闻接口返回错误 (HTTP ${response.status})`);
      }
      return {
        days: NEWS_TRADING_DAYS,
        startDate: payload.startDate,
        endDate: payload.endDate,
        news: payload.data.map(item => ({
          title: String(item.title || '').trim(),
          time: formatBeijingTime(Number(item.publishTime)),
          url: item.jumpUrl || '',
          pinned: Boolean(item.isPinned),
        })),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

// 缓存条目：{ days, startDate, endDate, news }；旧格式（数组，5 个交易日）或天数不同的条目视为没有缓存。
function isCurrentCacheEntry(entry) {
  return Boolean(entry && !Array.isArray(entry) && entry.days === NEWS_TRADING_DAYS && Array.isArray(entry.news));
}

function cachedNews(entry) {
  return isCurrentCacheEntry(entry) ? entry.news : [];
}

function readNewsCache() {
  try {
    return JSON.parse(fs.readFileSync(NEWS_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function fetchKline(baseUrl, code, signalDate) {
  const url = new URL('/api/kline', baseUrl);
  url.searchParams.set('code', code);
  url.searchParams.set('cutoffDate', signalDate);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const payload = await response.json();
      if (!response.ok || payload.status_code !== 0 || !Array.isArray(payload.data)) {
        throw new Error(payload.msg || `K线接口返回错误 (HTTP ${response.status})`);
      }
      return payload.data
        .map(bar => ({ ...bar, date: normalizeDate(bar.date) }))
        .sort((left, right) => left.date.localeCompare(right.date));
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

// 首板日算第 1 天，在窗口内找最高价所在的 K 线。
function findPeak(bars, signalDate, windowDays) {
  const signalIndex = bars.findIndex(bar => bar.date === signalDate);
  if (signalIndex < 0) throw new Error(`K 线中找不到首板日 ${signalDate}`);
  const windowBars = bars.slice(signalIndex, signalIndex + windowDays);
  const peakOffset = windowBars.reduce((best, bar, offset) => (
    Number(bar.high) > Number(windowBars[best].high) ? offset : best
  ), 0);
  const peak = windowBars[peakOffset];
  const signalClose = Number(bars[signalIndex].close);
  return {
    peakDate: peak.date,
    peakHigh: Number(peak.high),
    daysToPeak: peakOffset + 1,
    gainPct: signalClose > 0 ? (Number(peak.high) / signalClose - 1) * 100 : NaN,
    windowBars: windowBars.length,
    // 最高点落在窗口内最后一根 K 线（窗口取满，或数据截至今天/假期导致不满）时，可能还没见顶。
    peakUncertain: peakOffset === windowBars.length - 1,
  };
}

// 断板日：首板之后第一根收盘不是涨停的 K 线，首板日算第 1 天。
// 涨停按 5%/10%/20%/30% 涨停价识别，与量堆的涨停锚点规则一致。
function findBreak(bars, signalDate) {
  const points = bars.map(bar => ({
    ...bar, open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close),
  }));
  const signalIndex = points.findIndex(bar => bar.date === signalDate);
  if (signalIndex < 0) throw new Error(`K 线中找不到首板日 ${signalDate}`);
  let index = signalIndex + 1;
  while (index < points.length && isLimitUpBar(points, index)) index++;
  // 数据里一直涨停到最后一根：断板还没出现，暂用最后一根作为结束日。
  const found = index < points.length;
  const endIndex = found ? index : points.length - 1;
  return {
    breakDate: points[endIndex].date,
    daysToBreak: endIndex - signalIndex + 1,
    limitUpDays: index - signalIndex,
    breakMissing: !found,
  };
}

function readXlsxManual(outputPath) {
  const manual = new Map();
  if (!fs.existsSync(outputPath)) return manual;
  const workbook = XLSX.readFile(outputPath);
  const sheet = workbook.Sheets['题材演绎'];
  if (!sheet) return manual;
  for (const row of XLSX.utils.sheet_to_json(sheet, { defval: '' })) {
    const values = Object.fromEntries(MANUAL_COLUMNS.map(column => [column, String(row[column] ?? '')]));
    manual.set(`${row['代码']}|${normalizeDate(row['首板日期'])}`, values);
  }
  return manual;
}

function readJsonManual(manualPath) {
  try {
    return JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  } catch {
    return {};
  }
}

// 人工列有两个来源：Excel 的人工列和甘特图页面写入的 .manual.json。
// 上次运行会把两边写成一致，所以两边不同说明有一边改过：页面编辑时间晚于 Excel 修改时间就用页面的，否则用 Excel 的。
function readManual(outputPath, manualPath) {
  const xlsxManual = readXlsxManual(outputPath);
  const xlsxTime = fs.existsSync(outputPath) ? fs.statSync(outputPath).mtimeMs : 0;
  const jsonManual = readJsonManual(manualPath);
  const merged = new Map();
  const sameValues = (left, right) => MANUAL_COLUMNS.every(column => String(left?.[column] ?? '') === String(right?.[column] ?? ''));
  for (const key of new Set([...xlsxManual.keys(), ...Object.keys(jsonManual)])) {
    const fromXlsx = xlsxManual.get(key);
    const fromJson = jsonManual[key];
    let values = fromXlsx;
    if (fromJson && (!fromXlsx || (!sameValues(fromXlsx, fromJson) && Date.parse(fromJson.updatedAt || 0) > xlsxTime))) {
      values = fromJson;
    }
    if (values && MANUAL_COLUMNS.some(column => String(values[column] ?? '').trim())) {
      merged.set(key, Object.fromEntries(MANUAL_COLUMNS.map(column => [column, String(values[column] ?? '')])));
    }
  }
  return merged;
}

function writeManualJson(manualPath, rows) {
  const now = new Date().toISOString();
  const manual = {};
  for (const row of rows) {
    if (MANUAL_COLUMNS.some(column => String(row[column] ?? '').trim())) {
      manual[row.key] = { ...Object.fromEntries(MANUAL_COLUMNS.map(column => [column, row[column]])), updatedAt: now };
    }
  }
  fs.writeFileSync(manualPath, `${JSON.stringify(manual, null, 2)}\n`, 'utf8');
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : '';
}

function summarizeGroup(name, list) {
  const sorted = [...list].sort((left, right) => left['首板日期'].localeCompare(right['首板日期']));
  const mean = values => (values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 1) : '');
  return {
    名称: name,
    首次出现: sorted[0]['首板日期'],
    最后出现: sorted.at(-1)['首板日期'],
    股票数: sorted.length,
    平均到最高点天数: mean(sorted.map(row => Number(row['到最高点天数'])).filter(Number.isFinite)),
    平均到断板天数: mean(sorted.map(row => Number(row['到断板天数'])).filter(Number.isFinite)),
    平均涨幅: mean(sorted.map(row => Number(row['首板收盘→最高涨幅%'])).filter(Number.isFinite)),
    股票: sorted.map(row => `${row['名称']}(${row['首板日期'].slice(5)})`).join('、'),
    代表新闻: sorted.map(row => row['人工锚定新闻'] || row['锚定新闻']).find(Boolean) || '',
  };
}

// 题材只来自人工题材（按「+」拆分）；没填的股票不进题材汇总。
function buildThemeSummary(rows) {
  const themes = new Map();
  for (const row of rows) {
    for (const tag of String(row['人工题材'] || '').split('+').map(item => item.trim()).filter(Boolean)) {
      if (!themes.has(tag)) themes.set(tag, []);
      themes.get(tag).push(row);
    }
  }
  return [...themes.entries()]
    .map(([theme, list]) => summarizeGroup(theme, list))
    .sort((left, right) => left['首次出现'].localeCompare(right['首次出现']) || right['股票数'] - left['股票数']);
}

// 按新闻类别汇总（有人工类别时用人工类别），一只股票命中多类时每类各算一次。
function buildCategorySummary(rows) {
  const groups = new Map([...CATEGORIES.map(category => [category.name, []]), [NO_NEWS, []]]);
  for (const row of rows) {
    const categories = row['人工类别']
      ? [row['人工类别']]
      : row['有重要新闻'] === '是' ? row['新闻类别'].split('、') : [NO_NEWS];
    for (const category of categories) {
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(row);
    }
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length)
    .map(([category, list]) => summarizeGroup(category, list));
}

const COLUMN_WIDTHS = {
  锚定新闻: 60, 其他候选新闻: 60, 新闻链接: 24, 新闻时间: 17, 新闻类别: 18, 命中关键词: 18,
  人工锚定新闻: 30, 人工类别: 12, 人工题材: 16, 备注: 30, 新闻错误: 20, K线错误: 20,
  首板日期: 10, 新闻起始日期: 11, 最高点日期: 11, 断板日期: 11, 名称: 10, 股票: 60, 代表新闻: 60,
};

// Excel 单元格最多 32767 字，超长的（新闻很多时的「其他候选新闻」）截断；页面读的 JSON 不截断。
const EXCEL_CELL_LIMIT = 32000;

// 空表（如还没有人工题材）不能加筛选。
function appendSheet(workbook, name, rows) {
  const clipped = rows.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => [
    column, typeof value === 'string' && value.length > EXCEL_CELL_LIMIT ? `${value.slice(0, EXCEL_CELL_LIMIT)}…（已截断）` : value,
  ])));
  const sheet = XLSX.utils.json_to_sheet(clipped);
  if (rows.length) {
    sheet['!cols'] = Object.keys(rows[0]).map(column => ({ wch: COLUMN_WIDTHS[column] || Math.max(6, column.length * 2) }));
    sheet['!autofilter'] = { ref: sheet['!ref'] };
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function writeWorkbook(outputPath, rows, themeSummary, categorySummary, options) {
  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, '题材演绎', rows);
  appendSheet(workbook, '题材汇总', themeSummary);
  appendSheet(workbook, '类别汇总', categorySummary);

  const notes = [
    ['生成时间', new Date().toLocaleString('zh-CN', { hour12: false })],
    ['输入文件', path.relative(__dirname, options.input)],
    ['首板日期范围', `${options.start || '不限'} ～ ${options.end || '不限'}`],
    ['新闻范围', '调用网站服务 /api/news：只用首板日和前一个交易日（按交易日历的连续交易日，两日之间的周末/假期新闻也算，起始日见「新闻起始日期」列）的同花顺个股时间线标题和临时置顶新闻，缓存在 reports/news-cache.json'],
    ['重要新闻五类', CATEGORIES.map(category => category.name).join('、')],
    ['排除', '龙虎榜、资金流向、涨停分析、例行公告等行情/例行信息；只描述板块拉升暴涨、没有命中五类的标题'],
    ['评分', `命中类别数 + 1，标题点名个股再 +1；分数 ≥ ${IMPORTANT_SCORE} 记为有重要新闻；同分取更早的一条`],
    ['到最高点天数', `首板日算第 1 天，在首板日起 ${options.window} 个交易日内找最高价；「可能未见顶」表示最高点落在窗口内最后一根 K 线（窗口取满，或近期首板、长假导致数据不足一个窗口）`],
    ['题材汇总', '只用人工题材（按「+」拆成标签），按首次出现日期排序；不使用连板股票.json 的涨停原因（同花顺事后整理，不是首板时的新闻）'],
    ['类别汇总', '按新闻类别（有人工类别时用人工类别）汇总股票数、平均到见顶/断板天数和涨幅'],
    ['断板日期', '首板之后第一根收盘不是涨停的 K 线（首板日算第 1 天）；「断板未出现」表示数据内一直涨停，暂用最后一根 K 线'],
    ['连板高度', '首板起连续收盘涨停的天数（含首板），按 K 线计算，涨停按 5%/10%/20%/30% 涨停价识别'],
    ['人工列', `${MANUAL_COLUMNS.join('、')}：可在 Excel 或甘特图页面修改，重新运行脚本会按代码+首板日保留`],
  ];
  const notesSheet = XLSX.utils.aoa_to_sheet([['项目', '说明'], ...notes]);
  notesSheet['!cols'] = [{ wch: 16 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(workbook, notesSheet, '说明');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(workbook, outputPath);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const records = JSON.parse(fs.readFileSync(options.input, 'utf8'))
    .map(record => ({ ...record, date: normalizeDate(record.date), code: String(record.code || '').match(/\d{6}/)?.[0] || '' }))
    .filter(record => record.code && record.date)
    .filter(record => (!options.start || record.date >= options.start) && (!options.end || record.date <= options.end))
    .sort((left, right) => left.date.localeCompare(right.date) || left.code.localeCompare(right.code));
  if (!records.length) throw new Error('日期范围内没有记录');

  const newsCache = options.refreshNews ? {} : readNewsCache();
  const dataPath = options.output.replace(/\.xlsx$/i, '') + '.json';
  const manualPath = options.output.replace(/\.xlsx$/i, '') + '.manual.json';
  const manual = readManual(options.output, manualPath);
  const rows = new Array(records.length);
  let nextIndex = 0;
  let completed = 0;
  let failed = 0;
  let newsFailed = 0;

  async function worker() {
    while (nextIndex < records.length) {
      const index = nextIndex++;
      const record = records[index];
      const key = `${record.code}|${record.date}`;
      let newsError = '';
      if (!isCurrentCacheEntry(newsCache[key])) {
        try {
          newsCache[key] = await fetchNews(options.baseUrl, record.code, record.date);
        } catch (error) {
          newsError = error instanceof Error ? error.message : String(error);
          newsFailed++;
        }
      }
      let peak = null;
      let brk = null;
      let peakError = '';
      try {
        const bars = await fetchKline(options.baseUrl, record.code, record.date);
        peak = findPeak(bars, record.date, options.window);
        brk = findBreak(bars, record.date);
      } catch (error) {
        peakError = error instanceof Error ? error.message : String(error);
        failed++;
      }
      const { anchor, candidates, newsCount, marketOnlyCount } = pickAnchor({ ...record, news: cachedNews(newsCache[key]) });
      const important = Boolean(anchor && anchor.score >= IMPORTANT_SCORE);
      const saved = manual.get(key) || {};
      rows[index] = {
        key,
        首板日期: record.date,
        代码: record.code,
        名称: record.stockName || record.name || '',
        连板高度: brk?.limitUpDays ?? '',
        锚定新闻: anchor?.title || '',
        新闻时间: anchor?.time || '',
        新闻链接: anchor?.url || '',
        新闻类别: anchor ? anchor.categories.join('、') : '',
        命中关键词: anchor ? anchor.keywords.join('、') : '',
        有重要新闻: important ? '是' : '否',
        其他候选新闻: candidates.slice(1, 4).map(item => `[${item.categories.join('/')}] ${item.time.slice(0, 16)} ${item.title}`).join('\n'),
        新闻起始日期: newsCache[key]?.startDate || '',
        新闻条数: newsCount,
        仅拉升描述条数: marketOnlyCount,
        最高点日期: peak?.peakDate || '',
        到最高点天数: peak?.daysToPeak ?? '',
        '首板收盘→最高涨幅%': peak ? round(peak.gainPct, 1) : '',
        可能未见顶: peak ? (peak.peakUncertain ? '是' : '') : '',
        断板日期: brk?.breakDate || '',
        到断板天数: brk?.daysToBreak ?? '',
        断板未出现: brk ? (brk.breakMissing ? '是' : '') : '',
        新闻错误: newsError,
        K线错误: peakError,
        ...Object.fromEntries(MANUAL_COLUMNS.map(column => [column, saved[column] ?? ''])),
      };
      completed++;
      if (completed % 25 === 0 || completed === records.length) {
        process.stdout.write(`\r处理进度 ${completed}/${records.length}`);
      }
      // 样本多时跑很久，每 200 只存一次新闻缓存，中途出错重跑可以接着用。
      if (completed % 200 === 0) {
        fs.mkdirSync(path.dirname(NEWS_CACHE_FILE), { recursive: true });
        fs.writeFileSync(NEWS_CACHE_FILE, `${JSON.stringify(newsCache)}\n`, 'utf8');
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.workers, records.length) }, worker));
  process.stdout.write('\n');

  fs.mkdirSync(path.dirname(NEWS_CACHE_FILE), { recursive: true });
  fs.writeFileSync(NEWS_CACHE_FILE, `${JSON.stringify(newsCache)}\n`, 'utf8');
  const summary = buildThemeSummary(rows);
  writeWorkbook(options.output, rows.map(({ key: _key, ...row }) => row), summary, buildCategorySummary(rows), options);
  // 甘特图页面（public/theme-gantt.html）读取的数据，以及页面与 Excel 共用的人工列。
  fs.writeFileSync(dataPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    input: path.relative(__dirname, options.input),
    start: options.start,
    end: options.end,
    window: options.window,
    categories: CATEGORIES.map(category => category.name),
    manualColumns: MANUAL_COLUMNS,
    rows,
  })}\n`, 'utf8');
  writeManualJson(manualPath, rows);
  const important = rows.filter(row => row['有重要新闻'] === '是').length;
  console.log(`已写入 ${options.output}`);
  console.log(`甘特图数据 ${dataPath}，打开 ${options.baseUrl.replace(/\/$/, '')}/theme-gantt.html?file=${encodeURIComponent(path.basename(dataPath, '.json'))} 查看`);
  console.log(`股票 ${rows.length} 只，有重要新闻 ${important} 只（${round(important / rows.length * 100, 1)}%），新闻失败 ${newsFailed} 只，K 线失败 ${failed} 只；人工题材 ${summary.length} 个；保留人工列 ${manual.size} 行。`);
  if (failed || newsFailed) process.exitCode = 1;
}

module.exports = { classifyNews, pickAnchor, cachedNews, findPeak, findBreak, CATEGORIES, IMPORTANT_SCORE, NEWS_CACHE_FILE };

if (require.main === module) {
  main().catch(error => {
    console.error(`生成题材演绎表失败: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
