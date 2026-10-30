#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, healthyHosts } = require('./tdx_tick');
const { computeReviewPnl } = require('./server');
const {
  DEFAULT_SETTINGS,
  barsBeforeSignal,
  computeVolumePiles,
  isLimitUpBar,
  normalizeDate,
  summarizeTopHalfVolume,
} = require('./public/volume-pile');

const REVIEW_DIR = path.join(__dirname, 'daily-review');

function parseArgs(argv) {
  const options = {
    files: [],
    output: '',
    baseUrl: 'http://localhost:3000',
    workers: 3,
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--out') {
      options.output = argv[++index] || '';
      if (!options.output) throw new Error('--out 需要一个 CSV 文件路径');
    } else if (argument === '--base-url') {
      options.baseUrl = argv[++index] || '';
      if (!options.baseUrl) throw new Error('--base-url 需要网站服务地址');
    } else if (argument === '--workers') {
      const value = argv[++index];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 16) {
        throw new Error('--workers 必须是 1 到 16 之间的整数');
      }
      options.workers = Number(value);
    } else if (argument.startsWith('--')) {
      throw new Error(`未知选项: ${argument}`);
    } else {
      options.files.push(argument);
    }
  }

  if (!options.files.length && !options.help) {
    throw new Error('请至少指定一个每日复盘 JSON 文件');
  }

  return options;
}

function helpText() {
  return [
    '用法: npm run volume-pile-report -- <JSON文件...> [--out report.csv] [--base-url http://localhost:3000] [--workers 3]',
    '文件参数可为路径，或 daily-review/ 下的 JSON 文件名。',
    '量堆检测使用 public/volume-pile.js 的默认参数（与图表一致），首板当天不参与识别；个股收益每次通过逐笔成交规则实时重算，不读取 pnl 缓存。',
    'CSV 不带双引号：字段内逗号、换行和双引号会分别改写为全角逗号、空格和单引号。',
  ].join('\n');
}

function resolveInputFile(input) {
  const candidates = [
    path.resolve(input),
    path.join(REVIEW_DIR, path.basename(input)),
  ];
  const filePath = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!filePath) throw new Error(`找不到 JSON 文件: ${input}`);
  if (path.extname(filePath).toLowerCase() !== '.json') {
    throw new Error(`输入文件必须是 .json: ${input}`);
  }
  return filePath;
}

function normalizeStockCode(record) {
  if (!record || typeof record !== 'object') return '';
  const value = String(record.code || record.marketCode || '').trim();
  const match = value.match(/\d{6}/);
  return match ? match[0] : '';
}

// CSV 不使用双引号包裹字段：逗号改成全角逗号、换行改成空格、双引号改成单引号，
// 保证每行都能用简单的 split(',') 解析。
function plainCsv(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/,/g, '，');
}

function serializeSettings(settings) {
  return plainCsv(Object.entries(settings)
    .map(([key, value]) => `${key}=${value}`)
    .join(';'));
}

function toCsv(rows) {
  const columns = rows.length ? Object.keys(rows[0]) : [
    '文件', '量堆检测参数', '用例ID', '股票代码', '市场代码', '股票名称', '信号日期', '检测K线数量',
    '检测起始日期', '检测截止日期', '全局Q基线', '全局中位量', '近20日量能倍数', '近60日放量天数',
    '吸筹承接量堆数', '获利兑现量堆数', '量堆总数', '最近量堆类型',
    '最近量堆开始日期', '最近量堆结束日期', '最近量堆峰值日期',
    '最近量堆放缩量Top50均值比', '最近量堆中枢', '最近量堆高点日期', '最近量堆高点左侧最低收盘日期',
    '最近量堆最低收盘K到中枢涨幅', '最近量堆末根K对中枢涨幅', '首板量/最近量堆Top50均量',
    '个股收益率百分比', '买入日期', '买入价',
    '卖出日期', '卖出价', '收益计算状态', '收益计算错误', '量堆检测状态', '量堆检测错误',
  ];
  const lines = [columns.map(plainCsv).join(',')];
  for (const row of rows) lines.push(columns.map(column => plainCsv(row[column])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function roundedOrBlank(value, digits) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : '';
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function resultRow(record, file, analysis, calculatedPnl, detectionError = '', pnlError = '') {
  record = record && typeof record === 'object' ? record : {};
  const piles = analysis?.piles || [];
  const latest = piles.reduce((current, pile) => (
    !current || pile.endDate > current.endDate ? pile : current
  ), null);
  const computedPrice = value => (
    value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : ''
  );
  return {
    文件: file,
    量堆检测参数: serializeSettings(DEFAULT_SETTINGS),
    用例ID: record.id || '',
    股票代码: normalizeStockCode(record),
    市场代码: record.marketCode || '',
    股票名称: record.stockName || record.name || '',
    信号日期: normalizeDate(record.date),
    检测K线数量: analysis?.barCount ?? '',
    检测起始日期: analysis?.startDate || '',
    检测截止日期: analysis?.endDate || '',
    全局Q基线: Number.isFinite(analysis?.globalBaseline) ? analysis.globalBaseline : '',
    全局中位量: Number.isFinite(analysis?.globalMedian) ? analysis.globalMedian : '',
    近20日量能倍数: roundedOrBlank(analysis?.activity?.vol20VsNormal, 4),
    近60日放量天数: Number.isFinite(analysis?.activity?.spikeDays60) ? analysis.activity.spikeDays60 : '',
    吸筹承接量堆数: piles.filter(pile => pile.kind === 'accumulation-candidate').length,
    获利兑现量堆数: piles.filter(pile => pile.kind === 'profit-taking').length,
    量堆总数: piles.length,
    最近量堆类型: latest
      ? latest.kind === 'profit-taking' ? '获利兑现倾向' : '吸筹/承接倾向候选'
      : '无量堆',
    最近量堆开始日期: latest?.startDate || '',
    最近量堆结束日期: latest?.endDate || '',
    最近量堆峰值日期: latest?.peakDate || '',
    最近量堆放缩量Top50均值比: Number.isFinite(latest?.contrastRatio)
      ? Number(latest.contrastRatio.toFixed(4))
      : '',
    最近量堆中枢: roundedOrBlank(latest?.centerPrice, 2),
    最近量堆高点日期: latest?.highestCloseDate || '',
    最近量堆高点左侧最低收盘日期: latest?.lowestCloseDate || '',
    最近量堆最低收盘K到中枢涨幅: roundedOrBlank(latest?.lowestCloseToCenterPct, 2),
    最近量堆末根K对中枢涨幅: roundedOrBlank(latest?.lastBarToCenterPct, 2),
    '首板量/最近量堆Top50均量': latest?.pileTopHalfAverageVolume > 0
      ? roundedOrBlank(analysis.signalVolume / latest.pileTopHalfAverageVolume, 4)
      : '',
    个股收益率百分比: calculatedPnl ? calculatedPnl.pnlPct : '',
    买入日期: calculatedPnl?.buyDate || '',
    买入价: computedPrice(calculatedPnl?.buyPrice),
    卖出日期: calculatedPnl?.sellDate || '',
    卖出价: computedPrice(calculatedPnl?.sellPrice),
    收益计算状态: pnlError ? '实时计算失败' : calculatedPnl ? '实时计算成功' : '未计算',
    收益计算错误: pnlError,
    量堆检测状态: detectionError ? '失败' : '成功',
    量堆检测错误: detectionError,
  };
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
      const bars = payload.data
        .filter(bar => normalizeDate(bar.date) && normalizeDate(bar.date) <= signalDate)
        .sort((left, right) => normalizeDate(left.date).localeCompare(normalizeDate(right.date)));
      if (!bars.length || !bars.some(bar => normalizeDate(bar.date) === signalDate)) {
        throw new Error(`接口未返回信号日 ${signalDate} 的日线数据`);
      }
      return bars;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  throw lastError || new Error('K线请求失败');
}

async function computePnlWithRetry(code, date, name, worker) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await computeReviewPnl(code, date, name, worker);
      if (!result || !Number.isFinite(Number(result.pnlPct))) {
        throw new Error('逐笔行情计算未返回有效收益率');
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError || new Error('实时收益计算失败');
}

function readRecords(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const records = JSON.parse(text);
  if (!Array.isArray(records)) throw new Error(`${filePath} 顶层数据必须是 JSON 数组`);
  return records;
}

function timestampForFileName() {
  const now = new Date();
  const part = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}_${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  const baseUrl = new URL(options.baseUrl).toString();
  const files = [...new Set(options.files.map(resolveInputFile))];
  const rows = [];
  const tasks = new Map();
  let invalidRecords = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    for (const rawRecord of readRecords(filePath)) {
      const record = rawRecord && typeof rawRecord === 'object' ? rawRecord : {};
      const code = normalizeStockCode(record);
      const date = normalizeDate(record.date);
      const valid = /^\d{6}$/.test(code) && Boolean(date);
      const row = {
        record,
        fileName,
        code,
        date,
        valid,
        analysis: null,
        calculatedPnl: null,
        detectionError: '',
        pnlError: '',
      };
      rows.push(row);
      if (!valid) {
        const error = '记录缺少有效的六位股票代码或 YYYY-MM-DD 信号日期';
        row.detectionError = error;
        row.pnlError = error;
        invalidRecords++;
        continue;
      }
      const key = `${code}|${date}`;
      if (!tasks.has(key)) tasks.set(key, { key, code, date, rows: [] });
      tasks.get(key).rows.push(row);
    }
  }

  const queue = [...tasks.values()];
  let nextTask = 0;
  let completed = 0;
  const hosts = queue.length ? await healthyHosts() : [];
  const workerCount = Math.min(options.workers, queue.length);
  const workers = Array.from({ length: workerCount }, async (_, workerIndex) => {
    const worker = hosts.length ? new Worker(hosts, workerIndex, 0.1) : null;
    try {
      while (nextTask < queue.length) {
        const task = queue[nextTask++];
        let analysis = null;
        let detectionError = '';
        let calculatedPnl = null;
        let pnlError = '';

        try {
          const bars = await fetchKline(baseUrl, task.code, task.date);
          // 首板当天不参与量堆识别，只单独记录首板量，和最近量堆对比。
          analysis = computeVolumePiles(barsBeforeSignal(bars, task.date), DEFAULT_SETTINGS);
          analysis.signalVolume = Number(bars.at(-1).volume);
        } catch (error) {
          detectionError = formatError(error);
        }

        if (!worker) {
          pnlError = '没有可用的通达信逐笔行情服务器';
        } else {
          try {
            calculatedPnl = await computePnlWithRetry(
              task.code,
              task.date,
              task.rows[0].record.stockName || task.rows[0].record.name || '',
              worker,
            );
          } catch (error) {
            pnlError = formatError(error);
          }
        }

        task.rows.forEach(row => {
          row.analysis = analysis;
          row.detectionError = detectionError;
          row.calculatedPnl = calculatedPnl;
          row.pnlError = pnlError;
        });
        completed++;
        if (completed % 25 === 0 || completed === queue.length) {
          process.stdout.write(`\r实时检测 ${completed}/${queue.length}`);
        }
      }
    } finally {
      worker?.close();
    }
  });
  await Promise.all(workers);
  if (queue.length) process.stdout.write('\n');

  const outputRows = rows.map(item => {
    const output = resultRow(
      item.record,
      item.fileName,
      item.analysis,
      item.calculatedPnl,
      item.detectionError,
      item.pnlError,
    );
    if (!item.valid) {
      output.量堆检测状态 = '记录无效';
      output.收益计算状态 = '记录无效';
    }
    return output;
  });
  const outputPath = path.resolve(options.output || `volume-pile-report-${timestampForFileName()}.csv`);
  if (files.some(filePath => path.resolve(filePath) === outputPath)) {
    throw new Error('CSV 输出路径不能与输入 JSON 文件相同');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, toCsv(outputRows), 'utf8');

  const failedRows = rows.filter(row => row.detectionError || row.pnlError).length;
  console.log(`已读取 ${files.length} 个 JSON，共 ${rows.length} 条股票记录；唯一股票/信号组合 ${queue.length} 个。`);
  console.log(`失败或无效记录 ${failedRows} 条（无效输入 ${invalidRecords} 条）。`);
  console.log(`CSV 已写入: ${outputPath}`);
  console.log(`量堆规则配置: ${JSON.stringify(DEFAULT_SETTINGS)}`);
  if (failedRows) process.exitCode = 1;
}

module.exports = {
  DEFAULT_SETTINGS,
  computeVolumePiles,
  fetchKline,
  computePnlWithRetry,
  helpText,
  isLimitUpBar,
  main,
  parseArgs,
  plainCsv,
  resultRow,
  serializeSettings,
  summarizeTopHalfVolume,
  toCsv,
};

if (require.main === module) {
  main().catch(error => {
    console.error(`量堆汇总失败: ${formatError(error)}`);
    process.exitCode = 1;
  });
}
