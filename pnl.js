// 本地预计算 daily-review 每只股票买入后的盈亏，结果直接写入每条记录的 pnl 字段，再用 npm run upload 上传 R2。
// 用法: npm run pnl -- [文件名...] [--force] [--workers 6] [--delay 0.1]
//   不带文件名则处理 daily-review/ 下全部 JSON；文件名可只写关键字，如 2025 或 2025.json
//   默认跳过已有且规则版本一致的记录；--force 强制全部重算（规则变更时使用）
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Worker, healthyHosts } = require('./tdx_tick');
const { RULES_VERSION } = require('./review-pnl');

const pnlKey = (code, date) => `${code}|${date}`;

const REVIEW_DIR = path.join(__dirname, 'daily-review');

function parseArgs(argv) {
  const opt = { workers: 6, delay: 0.1, force: false, names: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') opt.force = true;
    else if (argv[i] === '--workers') opt.workers = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (argv[i] === '--delay') opt.delay = Math.max(0, parseFloat(argv[++i]) || 0);
    else opt.names.push(argv[i]);
  }
  return opt;
}

function resolveFiles(names) {
  if (!fs.existsSync(REVIEW_DIR)) throw new Error('daily-review/ 不存在，请先 npm run download:r2');
  const all = fs.readdirSync(REVIEW_DIR).filter(name => name.toLowerCase().endsWith('.json'));
  if (!names.length) return all;
  const picked = new Set();
  for (const name of names) {
    const keyword = path.basename(name, '.json');
    const hits = all.filter(file => file === name || file.includes(keyword));
    if (!hits.length) throw new Error(`daily-review/ 中找不到匹配 "${name}" 的文件`);
    hits.forEach(file => picked.add(file));
  }
  return [...picked];
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
}

function loadData(file) {
  const data = JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, file), 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${file} 格式错误`);
  return data;
}

function toCases(data) {
  return data
    .map(raw => ({ raw, code: String(raw.code || '').trim(), date: normalizeDate(raw.date), name: String(raw.stockName || raw.name || '') }))
    .filter(item => /^\d{6}$/.test(item.code) && /^\d{4}-\d{2}-\d{2}$/.test(item.date));
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const files = resolveFiles(opt.names);
  const { computeReviewPnl } = require('./server');

  const stores = files.map(file => {
    const data = loadData(file);
    return { file, data, cases: toCases(data), done: 0, failed: 0, cached: 0, dirty: false };
  });

  // 同一只股票同一天出现在多个文件时只算一次
  const tasks = new Map();
  for (const store of stores) {
    for (const item of store.cases) {
      const key = pnlKey(item.code, item.date);
      const entry = item.raw.pnl;
      if (!opt.force && entry && entry.rulesVersion === RULES_VERSION) {
        store.cached++;
        continue;
      }
      if (!tasks.has(key)) tasks.set(key, { ...item, key, stores: [], raws: [] });
      tasks.get(key).stores.push(store);
      tasks.get(key).raws.push(item.raw);
    }
  }

  const total = [...tasks.values()].reduce((sum, task) => sum + task.stores.length, 0);
  console.log(`规则版本 ${RULES_VERSION}${opt.force ? '（强制重算）' : ''}`);
  for (const store of stores) {
    console.log(`  ${store.file}: 共 ${store.cases.length} 条，已有 ${store.cached} 条，待计算 ${store.cases.length - store.cached} 条`);
  }
  if (!tasks.size) {
    console.log('没有需要计算的记录。');
    return;
  }

  const hosts = await healthyHosts();
  const queue = [...tasks.values()];
  const failures = [];
  let finished = 0;
  const startedAt = Date.now();

  const save = () => {
    for (const store of stores) {
      if (!store.dirty) continue;
      const filePath = path.join(REVIEW_DIR, store.file);
      fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(store.data, null, 2) + '\n');
      fs.renameSync(`${filePath}.tmp`, filePath);
      store.dirty = false;
    }
  };
  const render = () => {
    const parts = stores.map(store => `${store.file.slice(0, 14)} ${store.done + store.failed}/${store.cases.length - store.cached}`);
    const pct = ((finished / total) * 100).toFixed(1);
    const sec = (Date.now() - startedAt) / 1000;
    const eta = finished ? Math.round((sec / finished) * (total - finished)) : 0;
    process.stdout.write(`\r[${pct}%] ${finished}/${total} 失败 ${failures.length} 剩余约 ${eta}s | ${parts.join(' | ')}   `);
  };
  process.on('SIGINT', () => {
    save();
    console.log('\n已保存当前进度，重新运行同一命令即可继续。');
    process.exit(130);
  });

  const runWorker = async (index) => {
    // 每个线程从不同的通达信服务器开始，分散连接
    const worker = new Worker(hosts, index, opt.delay);
    try {
      for (let task = queue.shift(); task; task = queue.shift()) {
        try {
          let result;
          for (let attempt = 0; ; attempt++) {
            try {
              result = await computeReviewPnl(task.code, task.date, task.name, worker);
              break;
            } catch (error) {
              if (attempt >= 2) throw error;
              await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
          }
          for (const [i, store] of task.stores.entries()) {
            task.raws[i].pnl = result;
            store.done++;
            store.dirty = true;
          }
        } catch (error) {
          failures.push(`${task.code} ${task.name} ${task.date}: ${error.message}`);
          task.stores.forEach(store => { store.failed++; });
        }
        finished += task.stores.length;
        if (finished % 20 < task.stores.length) save();
        render();
      }
    } finally {
      worker.close();
    }
  };

  render();
  await Promise.all(Array.from({ length: Math.min(opt.workers, queue.length) }, (_, i) => runWorker(i)));
  save();
  process.stdout.write('\n');

  console.log(`完成，用时 ${Math.round((Date.now() - startedAt) / 1000)}s，失败 ${failures.length} 条`);
  failures.forEach(line => console.log(`  失败 ${line}`));
  console.log('结果已写入 daily-review/ 的原 JSON（pnl 字段），上传请运行 npm run upload');
}

main().catch(error => {
  console.error(`\n计算失败: ${error.message}`);
  process.exitCode = 1;
});
