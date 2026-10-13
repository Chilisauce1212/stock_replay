// Fetch TDX tick-by-tick trades: multi-worker, load-balanced, health-checked.
// Zero dependencies; implements the TDX hq protocol directly (port of pytdx).
//
// Usage:
//   node tdx_tick.js "600519,000530" 2026-10-08 2026-10-13 [--workers 4] [--delay 0.2] [--out-dir .]
// Output: one CSV per stock: <code>_<start>_<end>.csv

const net = require("net");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const HOSTS = [
  ["119.147.212.81", 7709], ["115.238.56.198", 7709], ["115.238.90.165", 7709],
  ["218.75.126.9", 7709], ["124.160.88.183", 7709], ["60.12.136.250", 7709],
  ["218.108.98.244", 7709], ["218.108.47.69", 7709], ["180.153.39.51", 7709],
  ["180.153.18.170", 7709], ["180.153.18.171", 7709], ["202.108.253.130", 7709],
  ["202.108.253.131", 7709], ["123.125.108.14", 7709],
];
const PAGE = 2000;
const MAX_ATTEMPTS = 4;
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const SETUP = [
  "0c02189300010300030 00d0001",
  "0c02189400010300030 00d0002",
  "0c031899000120002000db0fd5d0c9ccd6a4a8af0000008fc22540130000d500c9ccbdf0d7ea00000002",
].map((h) => Buffer.from(h.replace(/\s/g, ""), "hex"));

const marketOf = (code) => (/^[695]/.test(code) ? 1 : 0); // 0 = SZ, 1 = SH

class Conn {
  constructor() {
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.err = null;
  }

  connect(host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      this.sock = sock;
      const timer = setTimeout(() => sock.destroy(new Error("connect timeout")), timeoutMs);
      sock.setNoDelay(true);
      sock.on("data", (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        this._wake();
      });
      sock.on("error", (e) => {
        this.err = e;
        clearTimeout(timer);
        this._wake();
        reject(e);
      });
      sock.on("close", () => {
        this.err = this.err || new Error("connection closed");
        this._wake();
      });
      sock.once("connect", async () => {
        clearTimeout(timer);
        try {
          for (const pkg of SETUP) await this.request(pkg);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  _wake() {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  async _read(n, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (this.err) throw this.err;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("read timeout");
      await new Promise((r) => {
        const t = setTimeout(r, left);
        this.waiter = () => { clearTimeout(t); r(); };
      });
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async request(pkg, timeoutMs = 8000) {
    this.sock.write(pkg);
    const head = await this._read(16, timeoutMs);
    const zipSize = head.readUInt16LE(12);
    const rawSize = head.readUInt16LE(14);
    let body = await this._read(zipSize, timeoutMs);
    if (zipSize !== rawSize) body = zlib.inflateSync(body);
    return body;
  }

  close() {
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }
}

function getPrice(data, pos) {
  let b = data[pos];
  let val = b & 0x3f;
  const neg = (b & 0x40) !== 0;
  if (b & 0x80) {
    let shift = 6;
    for (;;) {
      pos++;
      b = data[pos];
      val += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
  }
  return [neg ? -val : val, pos + 1];
}

function histTransactionPkg(market, code, start, count, date) {
  const head = Buffer.from("0c013001000112001200b50f", "hex");
  const body = Buffer.alloc(14);
  body.writeUInt32LE(date, 0);
  body.writeUInt16LE(market, 4);
  body.write(code, 6, 6, "ascii");
  body.writeUInt16LE(start, 12);
  const cnt = Buffer.alloc(2);
  cnt.writeUInt16LE(count);
  return Buffer.concat([head, body, cnt]);
}

function parseTicks(body) {
  let pos = 0;
  const num = body.readUInt16LE(0);
  pos += 2 + 4;
  const ticks = [];
  let last = 0;
  for (let i = 0; i < num; i++) {
    const tm = body.readUInt16LE(pos);
    pos += 2;
    let d;
    [d, pos] = getPrice(body, pos);
    let vol, bs;
    [vol, pos] = getPrice(body, pos);
    [bs, pos] = getPrice(body, pos);
    [, pos] = getPrice(body, pos);
    last += d;
    const hh = String(Math.floor(tm / 60)).padStart(2, "0");
    const mm = String(tm % 60).padStart(2, "0");
    ticks.push({ time: `${hh}:${mm}`, price: last / 100, vol, buyorsell: bs });
  }
  return ticks;
}

async function probe(host) {
  const c = new Conn();
  const t0 = Date.now();
  try {
    await c.connect(host[0], host[1], 4000);
    const body = await c.request(Buffer.from("0c0c186c0001080008004e0400007 5c73301".replace(/\s/g, ""), "hex"), 4000);
    if (!body.readUInt16LE(0)) return null;
    return { lat: Date.now() - t0, host };
  } catch {
    return null;
  } finally {
    c.close();
  }
}

async function healthyHosts() {
  const res = (await Promise.all(HOSTS.map(probe))).filter(Boolean).sort((a, b) => a.lat - b.lat);
  console.log(`server check: ${res.length}/${HOSTS.length} reachable`);
  const ok = new Set(res.map((r) => r.host.join(":")));
  for (const r of res) console.log(`  OK   ${r.host.join(":")}  ${r.lat} ms`);
  for (const h of HOSTS) if (!ok.has(h.join(":"))) console.log(`  FAIL ${h.join(":")}`);
  if (!res.length) throw new Error("no TDX server reachable");
  return res.map((r) => r.host);
}

class Worker {
  constructor(hosts, offset, delay) {
    this.hosts = hosts;
    this.idx = offset;
    this.delay = delay;
    this.conn = null;
    this.host = null;
  }

  async _connect() {
    for (let i = 0; i < this.hosts.length; i++) {
      const host = this.hosts[this.idx % this.hosts.length];
      const c = new Conn();
      try {
        await c.connect(host[0], host[1], 5000);
        this.conn = c;
        this.host = host;
        return;
      } catch {
        c.close();
        this.idx++;
      }
    }
    throw new Error("no server available");
  }

  close() {
    if (this.conn) this.conn.close();
    this.conn = null;
  }

  async fetchDay(code, ymd) {
    const market = marketOf(code);
    const pages = [];
    let start = 0;
    for (;;) {
      const body = await this.conn.request(histTransactionPkg(market, code, start, PAGE, ymd));
      const rows = parseTicks(body);
      if (!rows.length) break;
      pages.push(rows);
      if (rows.length < PAGE) break;
      start += rows.length;
      await sleep(this.delay);
    }
    return pages.reverse().flat(); // pages arrive newest-first
  }

  async run(code, ymd) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        if (!this.conn) await this._connect();
        const rows = await this.fetchDay(code, ymd);
        await sleep(this.delay);
        return rows;
      } catch (e) {
        console.log(`  retry ${code} ${ymd} via ${this.host}: ${e.message}`);
        this.close();
        this.idx++; // switch to next server
        await sleep(Math.min(2 ** attempt, 8));
      }
    }
    throw new Error(`failed ${code} ${ymd}`);
  }
}

function businessDays(start, end) {
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  for (; d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function parseArgs(argv) {
  const pos = [];
  const opt = { workers: 4, delay: 0.2, outDir: "." };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workers") opt.workers = parseInt(argv[++i], 10);
    else if (argv[i] === "--delay") opt.delay = parseFloat(argv[++i]);
    else if (argv[i] === "--out-dir") opt.outDir = argv[++i];
    else pos.push(argv[i]);
  }
  if (pos.length < 3) {
    console.error('usage: node tdx_tick.js "600519,000530" 2026-10-08 2026-10-13 [--workers 4] [--delay 0.2] [--out-dir .]');
    process.exit(2);
  }
  return { codes: pos[0].split(",").map((s) => s.trim()).filter(Boolean), start: pos[1], end: pos[2], ...opt };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = businessDays(args.start, args.end);
  const hosts = await healthyHosts();

  const tasks = [];
  for (const code of args.codes) for (const day of days) tasks.push([code, day]);
  const results = new Map();
  const failed = [];
  const n = Math.max(1, Math.min(args.workers, tasks.length));

  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const w = new Worker(hosts, i, args.delay); // worker i starts on server i -> round-robin balance
      try {
        for (let t = tasks.shift(); t; t = tasks.shift()) {
          const [code, day] = t;
          try {
            const rows = await w.run(code, parseInt(day.replace(/-/g, ""), 10));
            console.log(`${code} ${day}: ${rows.length} ticks  [${w.host[0]}]`);
            results.set(`${code}|${day}`, rows);
          } catch (e) {
            failed.push([code, day, e.message]);
          }
        }
      } finally {
        w.close();
      }
    })
  );

  fs.mkdirSync(args.outDir, { recursive: true });
  for (const code of args.codes) {
    const lines = ["date,time,price,vol,buyorsell"];
    let count = 0;
    for (const day of days) {
      for (const r of results.get(`${code}|${day}`) || []) {
        lines.push(`${day},${r.time},${r.price},${r.vol},${r.buyorsell}`);
        count++;
      }
    }
    if (count) {
      const file = path.join(args.outDir, `${code}_${args.start}_${args.end}.js.csv`);
      fs.writeFileSync(file, "\ufeff" + lines.join("\n") + "\n", "utf8");
      console.log(`saved ${count} rows -> ${file}`);
    } else {
      console.log(`${code}: no data`);
    }
  }
  if (failed.length) console.log("FAILED:", failed);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { Worker, HOSTS };
