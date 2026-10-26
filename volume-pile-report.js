#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, healthyHosts } = require('./tdx_tick');
const { computeReviewPnl } = require('./server');

const REVIEW_DIR = path.join(__dirname, 'daily-review');
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  showGlobalBaseline: true,
  baselineQuantile: 45,
  volumeMultiple: 2.0,
  medianMultiple: 2,
  minimumPeakShare: 27,
  contrastThresholdMultiple: 1.5,
  mergeGap: 7,
  minimumWidth: 3,
  strongPeakMultiple: 3.5,
  profitThresholdPct: 20,
});

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
    '量堆检测使用本脚本内固定配置；个股收益每次通过逐笔成交规则实时重算，不读取 pnl 缓存。',
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

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function quantile(values, fraction) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarizeTopHalfVolume(points) {
  const volumes = points
    .map(point => point.volume)
    .filter(volume => Number.isFinite(volume) && volume > 0)
    .sort((left, right) => right - left);
  const topCount = Math.ceil(volumes.length / 2);
  return {
    average: topCount
      ? volumes.slice(0, topCount).reduce((sum, volume) => sum + volume, 0) / topCount
      : NaN,
    validDays: volumes.length,
    topDays: topCount,
  };
}

function roundPrice(price) {
  return Math.round((price + Number.EPSILON) * 100) / 100;
}

const LIMIT_UP_PERCENTS = [5, 10, 20, 30];

function isLimitUpBar(points, index) {
  if (index <= 0) return false;
  const point = points[index];
  const previous = points[index - 1];
  if (!Number.isFinite(point.close) || !Number.isFinite(point.high)
    || !Number.isFinite(previous.close) || previous.close <= 0) return false;
  // 涨停板必须收在最高价；盘中触板但回落的 K 线不算。
  if (Math.abs(point.close - point.high) >= 0.000001) return false;
  if (point.limitStatus === 'limit-up') return true;
  return LIMIT_UP_PERCENTS.some(percent => {
    const limitPrice = roundPrice(previous.close * (1 + percent / 100));
    const diff = point.close - limitPrice;
    // 允许复权造成的轻微低估，但不接受明显高于理论涨停价的收盘，避免把 +5.48% 这类高收盘误判为 5% 涨停。
    return diff >= -0.011 && diff <= 0.002;
  });
}

function computeVolumePiles(data, settings = DEFAULT_SETTINGS) {
  const points = data.map((item, index) => {
    const volume = Number(item.volume);
    const open = Number(item.open);
    const high = Number(item.high);
    const low = Number(item.low);
    const close = Number(item.close);
    const amount = item.amount === null || item.amount === undefined || item.amount === ''
      ? NaN
      : Number(item.amount);
    return {
      index,
      date: normalizeDate(item.date),
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
      amount,
      open,
      high,
      low,
      close,
      limitStatus: item.limitStatus || '',
      typicalPrice: (high + low + close) / 3,
      globalBaseline: NaN,
      globalMedian: NaN,
      excess: 0,
      ratio: NaN,
      medianRatio: NaN,
    };
  });

  const allVolumes = points.map(point => point.volume).filter(volume => volume > 0);
  const globalBaseline = quantile(allVolumes, settings.baselineQuantile / 100);
  const globalMedian = quantile(allVolumes, 0.5);
  if (globalBaseline > 0 && globalMedian > 0) {
    for (const point of points) {
      point.globalBaseline = globalBaseline;
      point.globalMedian = globalMedian;
      point.excess = Math.max(point.volume - globalBaseline, 0);
      point.ratio = point.volume / globalBaseline;
      point.medianRatio = point.volume / globalMedian;
    }
  }

  const candidateIndices = points
    .filter(point => (
      point.ratio >= settings.volumeMultiple
      && point.medianRatio >= settings.medianMultiple
    ))
    .map(point => point.index);
  const candidateIndexSet = new Set(candidateIndices);
  const timeGroups = [];
  for (const index of candidateIndices) {
    const group = timeGroups[timeGroups.length - 1];
    if (group && index - group.endIndex <= settings.mergeGap + 1) {
      group.endIndex = index;
      group.candidateIndices.push(index);
    } else {
      timeGroups.push({ startIndex: index, endIndex: index, candidateIndices: [index] });
    }
  }

  const groups = [];
  for (const timeGroup of timeGroups) {
    const peakExcess = Math.max(...timeGroup.candidateIndices.map(index => points[index].excess));
    const significantIndices = timeGroup.candidateIndices.filter(index => (
      points[index].excess >= peakExcess * settings.minimumPeakShare / 100
    ));
    let group = null;
    for (const index of significantIndices) {
      if (group && index - group.endIndex > settings.mergeGap + 1) {
        groups.push(group);
        group = null;
      }
      if (!group) group = { startIndex: index, endIndex: index, candidateIndices: [] };
      group.endIndex = index;
      group.candidateIndices.push(index);
    }
    if (group) groups.push(group);
  }

  const piles = [];
  const volumePileByDate = new Map();
  let previousPileEndIndex = -1;
  for (const group of groups) {
    const candidates = group.candidateIndices.map(index => points[index]);
    const peakExcess = Math.max(...candidates.map(point => point.excess));
    const members = candidates.filter(point => (
      point.excess >= peakExcess * settings.minimumPeakShare / 100
    ));
    if (!members.length) continue;

    const peak = members.reduce((highest, point) => point.volume > highest.volume ? point : highest);
    const shortCluster = members.length < settings.minimumWidth;
    if (shortCluster && peak.ratio < settings.strongPeakMultiple) continue;

    const firstVolumeMember = members[0];
    const lastVolumeMember = members[members.length - 1];
    const pileVolumeSummary = summarizeTopHalfVolume(
      points.slice(firstVolumeMember.index, lastVolumeMember.index + 1),
    );
    const contractionPoints = points.slice(previousPileEndIndex + 1, firstVolumeMember.index);
    const contractionVolumeSummary = summarizeTopHalfVolume(contractionPoints);
    const contrastRatio = Number.isFinite(pileVolumeSummary.average)
      && Number.isFinite(contractionVolumeSummary.average)
      && contractionVolumeSummary.average > 0
      ? pileVolumeSummary.average / contractionVolumeSummary.average
      : NaN;
    if (Number.isFinite(contrastRatio) && contrastRatio < settings.contrastThresholdMultiple) continue;

    const centerVolume = members.reduce((sum, point) => sum + point.excess, 0);
    const centerPrice = centerVolume > 0
      ? members.reduce((sum, point) => sum + point.typicalPrice * point.excess, 0) / centerVolume
      : NaN;
    const priceAnchors = [];
    let rangeFirst = firstVolumeMember;
    while (rangeFirst.index > 0) {
      const previous = points[rangeFirst.index - 1];
      if (volumePileByDate.has(previous.date)
        || !isLimitUpBar(points, previous.index)) break;
      rangeFirst = previous;
      priceAnchors.push(previous);
    }
    const firstRangeMid = (rangeFirst.high + rangeFirst.low) / 2;
    const peakMid = (peak.high + peak.low) / 2;
    const rangeBars = points.slice(rangeFirst.index, lastVolumeMember.index + 1);
    const lowestCloseBar = rangeBars.reduce((lowest, point) => (
      Number.isFinite(point.close) && (!lowest || point.close < lowest.close) ? point : lowest
    ), null);
    const lowestCloseMid = lowestCloseBar
      ? (lowestCloseBar.high + lowestCloseBar.low) / 2
      : NaN;
    const lowestToCenterPct = Number.isFinite(lowestCloseMid) && lowestCloseMid > 0
      ? (centerPrice / lowestCloseMid - 1) * 100
      : NaN;
    const lastVolumeBarMid = (lastVolumeMember.high + lastVolumeMember.low) / 2;
    const lastBarToCenterPct = Number.isFinite(centerPrice) && centerPrice > 0
      ? (lastVolumeBarMid / centerPrice - 1) * 100
      : NaN;
    const profitRisePct = Number.isFinite(firstRangeMid) && firstRangeMid > 0
      ? (peakMid / firstRangeMid - 1) * 100
      : NaN;
    const profitTaking = (Number.isFinite(lowestToCenterPct)
      && lowestToCenterPct >= settings.profitThresholdPct)
      || (Number.isFinite(lastBarToCenterPct)
        && lastBarToCenterPct >= settings.profitThresholdPct);

    piles.push({
      startDate: rangeFirst.date,
      firstVolumeDate: firstVolumeMember.date,
      endDate: lastVolumeMember.date,
      peakDate: peak.date,
      kind: profitTaking ? 'profit-taking' : 'accumulation-candidate',
      effectiveDays: members.length,
      priceCenter: centerPrice,
      topHalfAverage: pileVolumeSummary.average,
      topHalfDays: pileVolumeSummary.topDays,
      volumeDays: pileVolumeSummary.validDays,
      priorTopHalfAverage: contractionVolumeSummary.average,
      priorTopHalfDays: contractionVolumeSummary.topDays,
      priorVolumeDays: contractionVolumeSummary.validDays,
      contrastRatio,
      contrastReferenceStartDate: contractionPoints[0]?.date || '',
      contrastReferenceEndDate: contractionPoints.at(-1)?.date || '',
      profitRisePct,
      firstRangeMidPrice: firstRangeMid,
      peakMidPrice: peakMid,
      lowestCloseDate: lowestCloseBar?.date || '',
      lowestCloseMidPrice: lowestCloseMid,
      lowestCloseToCenterPct: lowestToCenterPct,
      lastBarDate: lastVolumeMember.date,
      lastBarMidPrice: lastVolumeBarMid,
      lastBarToCenterPct,
      profitRuleMet: profitTaking,
      anchorDates: [...priceAnchors].reverse().map(point => point.date),
      settings,
    });
    previousPileEndIndex = lastVolumeMember.index;
    for (const member of members) volumePileByDate.set(member.date, true);
    for (const anchor of priceAnchors) volumePileByDate.set(anchor.date, true);
  }

  return {
    piles,
    globalBaseline,
    globalMedian,
    barCount: points.length,
    startDate: points[0]?.date || '',
    endDate: points.at(-1)?.date || '',
  };
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
    '检测起始日期', '检测截止日期', '全局Q基线', '全局中位量',
    '吸筹承接量堆数', '获利兑现量堆数', '量堆总数', '最近量堆类型',
    '最近量堆开始日期', '最近量堆结束日期', '最近量堆峰值日期',
    '最近量堆放缩量Top50均值比', '个股收益率百分比', '买入日期', '买入价',
    '卖出日期', '卖出价', '收益计算状态', '收益计算错误', '量堆检测状态', '量堆检测错误',
  ];
  const lines = [columns.map(plainCsv).join(',')];
  for (const row of rows) lines.push(columns.map(column => plainCsv(row[column])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
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
          analysis = computeVolumePiles(bars, DEFAULT_SETTINGS);
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
