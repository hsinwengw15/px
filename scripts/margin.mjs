// 計算台股上市融資維持率，寫入 idx/data/margin.csv
//   維持率 = Σ(各股融資餘額張數 × 1000 × 收盤價) ÷ 融資金額 × 100%
// 資料來源：證交所「融資融券彙總」(MI_MARGN) 與「每日收盤行情」(MI_INDEX)
//
// 用法：node scripts/margin.mjs
//   環境變數 BACKFILL_DAYS=370 → 回補過去 370 天裡缺的交易日；預設只檢查最近 7 天

import fs from "node:fs";

const CSV = "idx/data/margin.csv";
const HEADER = "date,ratio,margin_market_value,margin_loan_amount";
const DAYS = Math.max(7, parseInt(process.env.BACKFILL_DAYS || "0", 10) || 0);
const GAP_MS = 2500; // 每次請求間隔，避免被證交所限流
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => parseFloat(String(s).replace(/,/g, "")) || 0;

// ---- 讀現有 CSV ----
const rows = new Map();
if (fs.existsSync(CSV)) {
  for (const line of fs.readFileSync(CSV, "utf8").trim().split("\n").slice(1)) {
    const [date, ...rest] = line.split(",");
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) rows.set(date, rest);
  }
}
const before = rows.size;

function writeCsv() {
  fs.mkdirSync("idx/data", { recursive: true });
  const lines = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([d, r]) => [d, ...r].join(","));
  fs.writeFileSync(CSV, [HEADER, ...lines].join("\n") + "\n");
}

let lastRequest = 0;
async function twse(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = lastRequest + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json", "Referer": "https://www.twse.com.tw/" } });
      const text = await res.text();
      return JSON.parse(text);
    } catch (e) {
      console.warn(`  第 ${attempt} 次失敗：${e.message}`);
      await sleep(10000 * attempt);
    }
  }
  throw new Error("證交所連續失敗，可能被暫時封鎖");
}

async function compute(ymd) {
  const m = await twse(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?selectType=ALL&response=json&date=${ymd}`);
  if (m.stat !== "OK" || !m.tables?.[1]?.data?.length) return null; // 休市或尚未公布
  if (m.date && m.date !== ymd) return null; // 保險：回傳的不是要求的那一天
  const p = await twse(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd}&type=ALLBUT0999&response=json`);
  const tbl = (p.tables || []).find((t) => t.fields?.includes("收盤價") && t.fields?.includes("證券代號"));
  if (!tbl) return null;
  const ci = tbl.fields.indexOf("收盤價"), ki = tbl.fields.indexOf("證券代號");
  const price = new Map(tbl.data.map((r) => [String(r[ki]).trim(), num(r[ci])]));
  let mv = 0;
  for (const r of m.tables[1].data) {
    const px = price.get(String(r[0]).trim());
    if (px) mv += num(r[6]) * 1000 * px; // r[6] = 融資今日餘額（張）
  }
  const amt = num(m.tables[0].data.find((r) => String(r[0]).startsWith("融資金額"))[5]) * 1000; // 仟元 → 元
  if (!amt) return null;
  return [(mv / amt * 100).toFixed(2), Math.round(mv), Math.round(amt)];
}

// ---- 決定要抓哪些日期（台灣時間）----
const today = new Date(Date.now() + 8 * 3600 * 1000);
const targets = [];
for (let i = 0; i < DAYS; i++) {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - i);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const iso = d.toISOString().slice(0, 10);
  if (!rows.has(iso)) targets.push(iso);
}
console.log(`現有 ${before} 筆，檢查最近 ${DAYS} 天，需要抓 ${targets.length} 天`);

let added = 0;
try {
  for (const iso of targets) {
    const r = await compute(iso.replace(/-/g, ""));
    if (r) {
      rows.set(iso, r);
      added++;
      console.log(`${iso}  ${r[0]}%`);
      if (added % 20 === 0) writeCsv(); // 中途存檔，失敗也不會全部白做
    } else {
      console.log(`${iso}  無資料（休市或尚未公布）`);
    }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  writeCsv();
  console.log(`新增 ${added} 筆，共 ${rows.size} 筆`);
}
