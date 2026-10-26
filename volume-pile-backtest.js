#!/usr/bin/env node
'use strict';

// 将 volume-pile-report.js 导出的 CSV 汇总转换成可直接载入回测页面的 JSON 用例。
// 用法: npm run volume-pile-backtest -- <CSV文件...> [--out JSON路径] [--latest-type 类型] [--min-piles 数量] [--strict] [--force]

const fs = require('fs');
const path = require('path');

const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'test-cases');

const LATEST_TYPE_LABELS = Object.freeze({
  'accumulation-candidate': '吸筹/承接倾向候选',
  'profit-taking': '获利兑现倾向',
});

const FILTER_TYPE_ALIASES = new Map([
  ['accumulation', 'accumulation-candidate'],
  ['accumulation-candidate', 'accumulation-candidate'],
  ['吸筹', 'accumulation-candidate'],
  ['吸筹/承接倾向候选', 'accumulation-candidate'],
  ['profit', 'profit-taking'],
  ['profit-taking', 'profit-taking'],
  ['获利', 'profit-taking'],
  ['获利兑现', 'profit-taking'],
  ['获利兑现倾向', 'profit-taking'],
  ['none', 'none'],
  ['no-pile', 'none'],
  ['无量堆', 'none'],
  ['无', 'none'],
]);

function parseArgs(argv) {
  const options = {
    files: [],
    output: '',
    latestType: '',
    minPiles: 0,
    strict: false,
    force: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--out') {
      options.output = argv[++index] || '';
      if (!options.output) throw new Error('--out 需要一个 JSON 文件路径');
    } else if (argument === '--latest-type') {
      const value = String(argv[++index] || '').trim();
      const normalized = FILTER_TYPE_ALIASES.get(value.toLowerCase());
      if (!normalized) {
        throw new Error('--latest-type 只能是 吸筹、获利兑现、无量堆（或 accumulation/profit-taking/none）');
      }
      options.latestType = normalized;
    } else if (argument === '--min-piles') {
      const value = argv[++index];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error('--min-piles 需要一个大于或等于 0 的整数');
      }
      options.minPiles = Number(value);
    } else if (argument === '--strict') {
      options.strict = true;
    } else if (argument === '--force') {
      options.force = true;
    } else if (argument.startsWith('--')) {
      throw new Error(`未知选项: ${argument}`);
    } else {
      options.files.push(argument);
    }
  }

  if (!options.files.length && !options.help) {
    throw new Error('请至少指定一个量堆 CSV 文件');
  }

  return options;
}

function helpText() {
  return [
    '用法: npm run volume-pile-backtest -- <CSV文件...> [选项]',
    '',
    '把 npm run volume-pile-report 导出的 CSV 转换成回测页面可直接加载的 JSON 数组。',
    '兼容旧版带引号 CSV、Excel 另存格式和新版不带引号 CSV。',
    '默认写入 test-cases/<第一个CSV文件名>.json；输出文件已存在时需要 --force。',
    '',
    '选项:',
    '  --out <路径>            指定输出 JSON 路径',
    '  --latest-type <类型>    只导出最近量堆类型为 吸筹、获利兑现 或 无量堆 的记录',
    '  --min-piles <数量>      只导出量堆总数不少于该值的记录',
    '  --strict                只导出量堆检测成功且收益计算成功的记录',
    '  --force                 覆盖已存在的输出文件',
    '  --help                  显示本说明',
  ].join('\n');
}

// 旧版量堆报告每列都带双引号，按 RFC 4180 规则解析。
function parseQuotedCsv(source) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];

    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }

  if (quoted) throw new Error('CSV 内容不完整：存在未闭合的双引号');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// 新版量堆报告不写双引号，字段内的逗号已经改写为全角逗号，直接按行和英文逗号切分。
function parsePlainCsv(source) {
  return source
    .split(/\r\n|\n|\r/)
    .filter(line => line !== '')
    .map(line => line.split(','));
}

// 兼容三种格式：
// 1. 旧版报告：全字段带双引号；
// 2. Excel 另存：表头不带引号，但含逗号的字段仍带双引号；
// 3. 新版报告：完全不带双引号，字段内逗号已改写为全角逗号。
// 因此只要出现双引号就按带引号规则解析，否则按简单逗号切分。
function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  return source.includes('"') ? parseQuotedCsv(source) : parsePlainCsv(source);
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+.*)?$/.exec(text);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return '';
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeDateOrRaw(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return null;
  return normalizeDate(text) || text;
}

function numberOrNull(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.round(number);
}

function inferMarketSuffix(code) {
  if (/^6/.test(code)) return 'SH';
  if (/^[03]/.test(code)) return 'SZ';
  if (/^[48]/.test(code)) return 'BJ';
  return '';
}

function normalizeMarketCode(value, code, id) {
  const text = String(value || '').trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(text)) return text;

  const idMatch = /(\d{6}\.(?:SH|SZ|BJ))$/i.exec(String(id || '').trim());
  if (idMatch) return idMatch[1].toUpperCase();

  const suffix = inferMarketSuffix(code);
  return suffix ? `${code}.${suffix}` : '';
}

function latestTypeFromLabel(label) {
  if (label.includes('获利兑现')) return 'profit-taking';
  if (label.includes('吸筹') || label.includes('承接')) return 'accumulation-candidate';
  return null;
}

function normalizeLatestTypeLabel(label) {
  if (label === '无量堆') return '无量堆';
  if (latestTypeFromLabel(label)) return LATEST_TYPE_LABELS[latestTypeFromLabel(label)];
  if (!label) return '无量堆';
  return label;
}

function buildRecord(row, columns) {
  const raw = name => String(row[columns.get(name)] ?? '').trim();

  const rawCode = raw('股票代码');
  const code = (/^\d{6}$/.test(rawCode) ? rawCode : (/^\d{6}/.exec(rawCode) || [''])[0]);
  const date = normalizeDate(raw('信号日期'));
  const id = raw('用例ID');
  const marketCode = normalizeMarketCode(raw('市场代码'), code, id);

  if (!code || !date || !marketCode) {
    return {
      ok: false,
      error: `缺少有效的股票代码、市场代码或信号日期（代码=${rawCode || '-'}，日期=${raw('信号日期') || '-'}）`,
    };
  }

  const detectionStatus = raw('量堆检测状态');
  const detectionError = raw('量堆检测错误');
  const pnlStatus = raw('收益计算状态');
  const pnlError = raw('收益计算错误');
  const latestLabel = raw('最近量堆类型');
  const latestType = latestTypeFromLabel(latestLabel);
  const latestTypeLabel = detectionStatus && detectionStatus !== '成功'
    ? '未检测'
    : normalizeLatestTypeLabel(latestLabel);

  const record = {
    id: id || `${date}-${marketCode}`,
    date,
    code,
    marketCode,
    stockName: raw('股票名称'),
    source: raw('文件'),
    volumePile: {
      detectionStatus: detectionStatus || null,
      detectionError: detectionError || null,
      barCount: integerOrNull(raw('检测K线数量')),
      startDate: normalizeDateOrRaw(raw('检测起始日期')),
      endDate: normalizeDateOrRaw(raw('检测截止日期')),
      globalBaseline: numberOrNull(raw('全局Q基线')),
      globalMedian: numberOrNull(raw('全局中位量')),
      accumulationCount: integerOrNull(raw('吸筹承接量堆数')),
      profitTakingCount: integerOrNull(raw('获利兑现量堆数')),
      totalCount: integerOrNull(raw('量堆总数')),
      latestType,
      latestTypeLabel,
      latestStartDate: normalizeDateOrRaw(raw('最近量堆开始日期')),
      latestEndDate: normalizeDateOrRaw(raw('最近量堆结束日期')),
      latestPeakDate: normalizeDateOrRaw(raw('最近量堆峰值日期')),
      latestContrastRatio: numberOrNull(raw('最近量堆放缩量Top50均值比')),
    },
    pnl: {
      pnlPct: numberOrNull(raw('个股收益率百分比')),
      buyDate: normalizeDateOrRaw(raw('买入日期')),
      buyPrice: numberOrNull(raw('买入价')),
      sellDate: normalizeDateOrRaw(raw('卖出日期')),
      sellPrice: numberOrNull(raw('卖出价')),
      status: pnlStatus || null,
      error: pnlError || null,
    },
  };

  return { ok: true, record };
}

function readCsvFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`找不到 CSV 文件: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(text);
  if (!rows.length) throw new Error(`${filePath} 是空文件`);

  const header = rows[0].map(name => name.trim());
  const columns = new Map(header.map((name, index) => [name, index]));
  if (!columns.has('股票代码') || !columns.has('信号日期')) {
    throw new Error(`${filePath} 不是量堆汇总 CSV：缺少“股票代码”或“信号日期”列`);
  }

  const records = [];
  let invalid = 0;
  let firstError = '';
  for (const row of rows.slice(1)) {
    if (!row.some(value => String(value).trim() !== '')) continue;
    const built = buildRecord(row, columns);
    if (!built.ok) {
      invalid++;
      if (!firstError) firstError = built.error;
      continue;
    }
    records.push(built.record);
  }

  return { records, invalid, firstError };
}

function matchesLatestType(record, latestType) {
  if (latestType === 'none') {
    return record.volumePile.detectionStatus === '成功' && !record.volumePile.latestType;
  }
  return record.volumePile.latestType === latestType;
}

function convert(options) {
  const seen = new Map();
  const cases = [];
  const stats = {
    files: 0,
    rows: 0,
    invalid: 0,
    duplicates: 0,
    filtered: 0,
    strict: 0,
    invalidExamples: [],
  };

  for (const input of options.files) {
    const filePath = path.resolve(input);
    const { records, invalid, firstError } = readCsvFile(filePath);
    stats.files++;
    stats.rows += records.length + invalid;
    stats.invalid += invalid;
    if (firstError && stats.invalidExamples.length < 5) stats.invalidExamples.push(firstError);

    for (const record of records) {
      const key = `${record.marketCode}|${record.date}`;
      if (seen.has(key)) {
        stats.duplicates++;
        continue;
      }
      seen.set(key, true);

      if (options.strict) {
        const detectionOk = record.volumePile.detectionStatus === '成功';
        const pnlOk = record.pnl.status === '实时计算成功' && typeof record.pnl.pnlPct === 'number';
        if (!detectionOk || !pnlOk) {
          stats.strict++;
          continue;
        }
      }

      if (options.latestType && !matchesLatestType(record, options.latestType)) {
        stats.filtered++;
        continue;
      }

      if ((record.volumePile.totalCount || 0) < options.minPiles) {
        stats.filtered++;
        continue;
      }

      cases.push(record);
    }
  }

  return { cases, stats };
}

function ensureUniqueIds(cases) {
  const used = new Map();
  for (const item of cases) {
    const base = item.id;
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    if (count) item.id = `${base}-${count + 1}`;
  }
}

function defaultOutputPath(input) {
  const baseName = path.basename(input, path.extname(input));
  return path.join(DEFAULT_OUTPUT_DIR, `${baseName}.json`);
}

function summarizeTypes(cases) {
  const counts = { '吸筹/承接倾向候选': 0, '获利兑现倾向': 0, '无量堆': 0, 其他: 0 };
  for (const item of cases) {
    const label = item.volumePile.latestTypeLabel;
    if (Object.prototype.hasOwnProperty.call(counts, label)) counts[label]++;
    else counts.其他++;
  }
  return counts;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  const requestedOutput = options.output
    ? path.resolve(options.output)
    : defaultOutputPath(options.files[0]);
  if (fs.existsSync(requestedOutput) && fs.statSync(requestedOutput).isDirectory()) {
    throw new Error(`--out 需要 JSON 文件路径，不能是目录: ${requestedOutput}`);
  }
  const outputPath = path.extname(requestedOutput).toLowerCase() === '.json'
    ? requestedOutput
    : `${requestedOutput}.json`;

  if (fs.existsSync(outputPath) && !options.force) {
    throw new Error(`输出文件已存在: ${outputPath}；使用 --force 覆盖，或用 --out 指定其他路径`);
  }

  const { cases, stats } = convert(options);
  ensureUniqueIds(cases);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');

  const typeCounts = summarizeTypes(cases);
  const filters = [];
  if (options.latestType) filters.push(`最近量堆类型=${options.latestType}`);
  if (options.minPiles) filters.push(`量堆总数>=${options.minPiles}`);
  if (options.strict) filters.push('仅检测与收益计算成功');

  console.log(`读取 CSV ${stats.files} 个，共 ${stats.rows} 行`);
  console.log(`跳过无效记录 ${stats.invalid} 行，重复记录 ${stats.duplicates} 行`);
  if (stats.strict) console.log(`严格模式排除 ${stats.strict} 行`);
  if (stats.filtered) console.log(`筛选排除 ${stats.filtered} 行`);
  if (filters.length) console.log(`筛选条件: ${filters.join('，')}`);
  stats.invalidExamples.forEach(example => console.log(`  无效示例: ${example}`));
  console.log(`导出回测用例 ${cases.length} 条（吸筹/承接 ${typeCounts['吸筹/承接倾向候选']}，获利兑现 ${typeCounts['获利兑现倾向']}，无量堆 ${typeCounts['无量堆']}${typeCounts.其他 ? `，未检测 ${typeCounts.其他}` : ''}）`);
  console.log(`JSON 已写入: ${outputPath}`);
  console.log('检测参数保留在源 CSV 的“量堆检测参数”列（key=value 格式），本脚本不重复写入 JSON。');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`量堆 CSV 转换失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  convert,
  buildRecord,
  defaultOutputPath,
  helpText,
  main,
  normalizeDate,
  parseArgs,
  parseCsv,
};