// Cloudflare Worker：幫看盤頁轉接資料
//   K 線（Yahoo）：     /?symbol=^N225&interval=5m&range=5d
//   恐懼貪婪指數（CNN）：/?src=fng
//   上市融資維持率：     /?src=margin            （最新一個交易日）
//                       /?src=margin&date=20261124（指定日期；休市日回 ok:false）

// 只允許你自己的網站來呼叫，避免被別人拿去用掉免費額度
const ALLOWED_ORIGINS = [
  /^https:\/\/([a-z0-9-]+\.)*pickyabit\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
];
const INTERVALS = ["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo", "3mo"];
const RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    // "null" = 在電腦上直接雙擊打開 html 檔（file://），方便本機測試
    const allowed = origin === "null" || ALLOWED_ORIGINS.some((re) => re.test(origin));
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : "https://px.pickyabit.com",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (origin && !allowed) return json({ error: "origin not allowed" }, 403, cors);

    const url = new URL(request.url);
    const src = url.searchParams.get("src");
    try {
      if (src === "fng") return await fearGreed(cors);
      if (src === "margin") return await margin(url.searchParams.get("date"), cors, ctx);
      return await yahoo(url, cors);
    } catch (e) {
      return json({ error: "upstream failed", detail: String(e) }, 502, cors);
    }
  },
};

// ---------- Yahoo K 線 ----------
async function yahoo(url, cors) {
  const symbol = url.searchParams.get("symbol") || "";
  const interval = url.searchParams.get("interval") || "5m";
  const range = url.searchParams.get("range") || "1d";
  if (!/^[\^A-Za-z0-9.=\-]{1,20}$/.test(symbol)) return json({ error: "bad symbol" }, 400, cors);
  if (!INTERVALS.includes(interval) || !RANGES.includes(range)) return json({ error: "bad interval/range" }, 400, cors);
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=false`, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
    cf: { cacheTtl: 30, cacheEverything: true }, // 同一筆資料 30 秒內共用
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=30" },
  });
}

// ---------- CNN 恐懼貪婪指數 ----------
async function fearGreed(cors) {
  const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
    headers: { "User-Agent": UA, "Accept": "application/json", "Referer": "https://edition.cnn.com/", "Origin": "https://edition.cnn.com" },
    cf: { cacheTtl: 600, cacheEverything: true }, // 10 分鐘
  });
  if (!res.ok) return json({ error: `CNN HTTP ${res.status}` }, 502, cors);
  const j = await res.json();
  // 只回傳需要的部分，減少傳輸量
  const f = j.fear_and_greed || {};
  return json({
    score: f.score, rating: f.rating, timestamp: f.timestamp,
    previous_close: f.previous_close, previous_1_week: f.previous_1_week,
    previous_1_month: f.previous_1_month, previous_1_year: f.previous_1_year,
    history: (j.fear_and_greed_historical?.data || []).map((d) => [d.x, Math.round(d.y * 10) / 10]),
  }, 200, { ...cors, "Cache-Control": "public, max-age=600" });
}

// ---------- 上市融資維持率 ----------
// 維持率 = Σ(各股融資餘額張數 × 1000 × 收盤價) ÷ 融資金額 × 100%
async function margin(date, cors, ctx) {
  if (date && !/^\d{8}$/.test(date)) return json({ error: "bad date" }, 400, cors);
  // 過去的日期結果不會變，存 30 天；最新的存 30 分鐘
  const cache = caches.default;
  const key = new Request(`https://cache.internal/margin/${date || "latest"}`);
  const hit = await cache.match(key);
  if (hit) return withCors(hit, cors);

  const q = date ? `&date=${date}` : "";
  const m = await twse(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?selectType=ALL&response=json${q}`);
  let body;
  if (m.stat !== "OK" || !m.tables?.[1]?.data?.length) {
    body = { ok: false, date: date || null, reason: m.stat || "no data" };
  } else {
    const d = m.date;
    const p = await twse(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d}&type=ALLBUT0999&response=json`);
    const tbl = (p.tables || []).find((t) => t.fields?.includes("收盤價") && t.fields?.includes("證券代號"));
    if (!tbl) {
      body = { ok: false, date: d, reason: "no price table" };
    } else {
      const ci = tbl.fields.indexOf("收盤價"), ki = tbl.fields.indexOf("證券代號");
      const price = new Map(tbl.data.map((r) => [String(r[ki]).trim(), num(r[ci])]));
      let mv = 0, missLots = 0, totalLots = 0;
      for (const r of m.tables[1].data) {
        const lots = num(r[6]); // 融資今日餘額（張）
        totalLots += lots;
        const px = price.get(String(r[0]).trim());
        if (!px) { missLots += lots; continue; }
        mv += lots * 1000 * px;
      }
      const amtRow = m.tables[0].data.find((r) => String(r[0]).startsWith("融資金額"));
      const amt = num(amtRow[5]) * 1000; // 仟元 → 元
      body = { ok: true, date: d, ratio: Math.round(mv / amt * 10000) / 100,
               marketValue: Math.round(mv), loanAmount: amt, coverage: totalLots ? 1 - missLots / totalLots : 1 };
    }
  }
  const ttl = date ? 30 * 86400 : 1800;
  const res = json(body, 200, { "Cache-Control": `public, max-age=${ttl}` });
  ctx.waitUntil(cache.put(key, res.clone()));
  return withCors(res, cors);
}

async function twse(u) {
  const res = await fetch(u, { headers: { "User-Agent": UA, "Accept": "application/json", "Referer": "https://www.twse.com.tw/" } });
  const t = await res.text();
  try { return JSON.parse(t); } catch { throw new Error(`TWSE 回應不是 JSON（HTTP ${res.status}），可能被暫時封鎖`); }
}

const num = (s) => parseFloat(String(s).replace(/,/g, "")) || 0;

function withCors(res, cors) {
  const r = new Response(res.body, res);
  Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
  return r;
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}
