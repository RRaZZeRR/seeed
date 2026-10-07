// Cloudflare Worker для бота Seed.
//  POST /        — мини-приложение присылает новый кошелёк, бот пишет его вам в ЛС.
//  POST /watch   — мини-приложение присылает адреса кошельков и настройку уведомлений.
//  Каждую минуту (Cron Trigger) сервер проверяет адреса и пишет о поступлениях:
//    BTC — сразу, как транзакция появилась в сети (0 подтверждений);
//    USDT TRC20 и TRX, SOL, а также ETH/BNB/POL и USDT/USDC в сетях
//    Ethereum, BNB Chain, Polygon, Arbitrum, Base — как только баланс вырос.
// Нужно: секрет BOT_TOKEN и KV-хранилище, подключённое под именем KV.

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const RE = {
  btc: /^bc1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/,
  trx: new RegExp(`^T${B58}{33}$`),
  sol: new RegExp(`^${B58}{32,44}$`),
  evm: /^0x[0-9a-fA-F]{40}$/,
};
const PER_RUN = 15; // кошельков за один запуск: бесплатный тариф даёт 50 внешних запросов

const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const CHAINS = [
  { id: "eth", name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", native: { sym: "ETH", dec: 18, cg: "ethereum" },
    tokens: [{ sym: "USDT", a: "0xdAC17F958D2ee523a2206206994597C13D831ec7", dec: 6 }, { sym: "USDC", a: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", dec: 6 }] },
  { id: "bsc", name: "BNB Chain", rpc: "https://bsc-rpc.publicnode.com", native: { sym: "BNB", dec: 18, cg: "binancecoin" },
    tokens: [{ sym: "USDT", a: "0x55d398326f99059fF775485246999027B3197955", dec: 18 }, { sym: "USDC", a: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", dec: 18 }] },
  { id: "pol", name: "Polygon", rpc: "https://polygon-bor-rpc.publicnode.com", native: { sym: "POL", dec: 18, cg: "polygon-ecosystem-token" },
    tokens: [{ sym: "USDT", a: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", dec: 6 }, { sym: "USDC", a: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", dec: 6 }] },
  { id: "arb", name: "Arbitrum", rpc: "https://arbitrum-one-rpc.publicnode.com", native: { sym: "ETH", dec: 18, cg: "ethereum" },
    tokens: [{ sym: "USDT", a: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", dec: 6 }, { sym: "USDC", a: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", dec: 6 }] },
  { id: "base", name: "Base", rpc: "https://base-rpc.publicnode.com", native: { sym: "ETH", dec: 18, cg: "ethereum" },
    tokens: [{ sym: "USDC", a: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", dec: 6 }] },
];

export default {
  async fetch(req, env) {
    env = withKV(env);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: true, info: "Seed bot server работает", kv: !!env.KV });
    if (!env.BOT_TOKEN) return json({ ok: false, error: "на сервере не задан BOT_TOKEN" }, 500);

    let b;
    try { b = await req.json(); } catch { return json({ ok: false, error: "неверный запрос" }, 400); }
    const user = await checkInitData(String(b.initData || ""), env.BOT_TOKEN);
    if (!user) return json({ ok: false, error: "запрос не из Telegram" }, 403);

    const path = new URL(req.url).pathname;

    // ---- адреса для слежения + настройка уведомлений ----
    if (path === "/watch") {
      if (!env.KV) return json({ ok: false, error: "не подключено хранилище KV" }, 500);
      const list = Array.isArray(b.wallets) ? b.wallets.slice(0, 200) : [];
      const w = [], fresh = [];
      for (const x of list) {
        const item = { label: String(x.label || "Кошелёк").slice(0, 60) };
        for (const k of ["btc", "trx", "sol", "evm"]) if (RE[k].test(String(x[k] || ""))) item[k] = String(x[k]);
        if (!item.btc && !item.trx && !item.sol && !item.evm) continue;
        w.push(item);
        // кошелёк создан только что — у него нет истории, первое же поступление считаем новым
        if (Date.now() - Number(x.t || 0) < 10 * 60000) for (const k of ["btc", "trx", "sol", "evm"]) if (item[k]) fresh.push(item[k].toLowerCase());
      }
      const data = (await env.KV.get("watch", "json")) || { users: {} };
      data.users[String(user.id)] = { w, n: b.notify !== false };
      await env.KV.put("watch", JSON.stringify(data));
      if (fresh.length) {
        const seen = (await env.KV.get("seen", "json")) || { tx: {}, addr: {} };
        let ch = false;
        for (const a of fresh) if (!seen.addr[a]) { seen.addr[a] = 1; ch = true; }
        if (ch) await env.KV.put("seen", JSON.stringify(seen));
      }
      return json({ ok: true, watching: w.length, notify: b.notify !== false });
    }

    // ---- новый кошелёк: сообщение в ЛС ----
    for (const k of ["trx", "btc", "sol"]) if (!RE[k].test(String(b[k] || ""))) return json({ ok: false, error: "неверное поле " + k }, 400);
    if (b.evm && !RE.evm.test(String(b.evm))) return json({ ok: false, error: "неверное поле evm" }, 400);
    if (!/^SP1:[A-Za-z0-9_-]{40,600}$/.test(String(b.cipher || ""))) return json({ ok: false, error: "неверное поле cipher" }, 400);

    const label = esc(String(b.label || "Кошелёк").slice(0, 60));
    const text =
      `🔐 <b>${label}</b> · ${msk(new Date())}\n\n` +
      `USDT TRC20: <code>${b.trx}</code>\n` +
      `BTC: <code>${b.btc}</code>\n` +
      `SOL: <code>${b.sol}</code>\n` +
      `\nСид (зашифрован):\n<code>${b.cipher}</code>`;
    const rj = await send(env, user.id, text);
    if (!rj.ok) return json({ ok: false, error: rj.description || "Telegram не принял сообщение" }, 502);
    return json({ ok: true });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAll(withKV(env)));
  },
};

// ---------- проверка поступлений ----------
async function checkAll(env) {
  if (!env.KV || !env.BOT_TOKEN) return;
  const data = await env.KV.get("watch", "json");
  if (!data || !data.users) return;

  const all = [];
  for (const [uid, u] of Object.entries(data.users)) for (const w of u.w || []) all.push({ uid, n: u.n !== false, ...w });
  if (!all.length) return;
  const chunks = Math.ceil(all.length / PER_RUN);
  const part = Math.floor(Date.now() / 60000) % chunks;
  const batch = all.slice(part * PER_RUN, part * PER_RUN + PER_RUN);

  const seen = (await env.KV.get("seen", "json")) || { tx: {}, addr: {} };
  const bal = (await env.KV.get("bal", "json")) || {};
  let seenCh = false, balCh = false;
  const found = []; // {uid, label, amount(BigInt), dec, sym, net, cg, extra}

  // сравнение баланса с прошлым: сообщаем только о росте
  function diff(w, addr, asset, val, dec, sym, net, cg, minUnits) {
    const key = addr.toLowerCase() + "|" + asset;
    const prevS = bal[key];
    const cur = BigInt(val);
    if (prevS === undefined) {
      bal[key] = cur.toString(); balCh = true;
      if (!seen.addr[addr.toLowerCase()]) return;    // первый раз видим адрес — просто запоминаем
      if (cur >= minUnits && w.n) found.push({ uid: w.uid, label: w.label, amount: cur, dec, sym, net, cg });
      return;
    }
    const prev = BigInt(prevS);
    if (cur !== prev) { bal[key] = cur.toString(); balCh = true; }
    if (cur - prev >= minUnits && w.n) found.push({ uid: w.uid, label: w.label, amount: cur - prev, dec, sym, net, cg });
  }

  const jobs = [];

  // BTC — по транзакциям, сразу из мемпула
  for (const w of batch) if (w.btc) jobs.push((async () => {
    let txs;
    try { const r = await fetch(`https://mempool.space/api/address/${w.btc}/txs`); if (!r.ok) return; txs = await r.json(); } catch { return; }
    const first = !seen.addr[w.btc.toLowerCase()];
    if (first) { seen.addr[w.btc.toLowerCase()] = 1; seenCh = true; }
    for (const tx of txs) {
      const key = w.btc + ":" + tx.txid;
      if (seen.tx[key]) continue;
      seen.tx[key] = Date.now(); seenCh = true;
      if (first || !w.n) continue;
      let inSat = 0, outSat = 0;
      for (const o of tx.vout || []) if (o.scriptpubkey_address === w.btc) inSat += o.value;
      for (const i of tx.vin || []) if (i.prevout && i.prevout.scriptpubkey_address === w.btc) outSat += i.prevout.value;
      if (inSat - outSat > 0) found.push({ uid: w.uid, label: w.label, amount: BigInt(inSat - outSat), dec: 8, sym: "BTC", net: "Bitcoin", cg: "bitcoin",
        extra: (tx.status && tx.status.confirmed ? "подтверждена" : "в мемпуле, 0 подтверждений") + ` · <a href="https://mempool.space/tx/${tx.txid}">tx</a>` });
    }
  })());

  // TRON — TRX и USDT TRC20 одним запросом на адрес
  for (const w of batch) if (w.trx) jobs.push((async () => {
    let j;
    try { const r = await fetch(`https://api.trongrid.io/v1/accounts/${w.trx}`); if (!r.ok) return; j = await r.json(); } catch { return; }
    if (!j || j.success === false) return;
    let trx = 0n, usdt = 0n;
    const d = j.data && j.data[0];
    if (d) {
      trx = BigInt(d.balance || 0);
      for (const o of d.trc20 || []) if (o[USDT_TRC20] != null) usdt = BigInt(o[USDT_TRC20]);
    }
    diff(w, w.trx, "usdt", usdt, 6, "USDT", "TRC20", "tether", 10000n);
    diff(w, w.trx, "trx", trx, 6, "TRX", "TRON", "tron", 100000n);
  })());

  // SOL — все адреса пачки одним запросом
  const solW = batch.filter((w) => w.sol);
  if (solW.length) jobs.push((async () => {
    let j;
    try {
      const r = await fetch("https://solana-rpc.publicnode.com", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [solW.map((w) => w.sol), { encoding: "base64", commitment: "processed" }] }) });
      if (!r.ok) return; j = await r.json();
    } catch { return; }
    if (!j.result || !Array.isArray(j.result.value)) return;
    solW.forEach((w, i) => { const acc = j.result.value[i]; diff(w, w.sol, "sol", acc ? acc.lamports : 0, 9, "SOL", "Solana", "solana", 100000n); });
  })());

  // EVM — по одному пакетному запросу на сеть: баланс монеты + USDT/USDC
  const evmW = batch.filter((w) => w.evm);
  if (evmW.length) for (const c of CHAINS) jobs.push((async () => {
    const calls = [], meta = [];
    for (const w of evmW) {
      calls.push({ jsonrpc: "2.0", id: calls.length, method: "eth_getBalance", params: [w.evm, "latest"] });
      meta.push({ w, asset: c.id + ":" + c.native.sym, dec: c.native.dec, sym: c.native.sym, cg: c.native.cg, min: 10n ** BigInt(c.native.dec - 6) });
      for (const t of c.tokens) {
        calls.push({ jsonrpc: "2.0", id: calls.length, method: "eth_call",
          params: [{ to: t.a, data: "0x70a08231" + w.evm.slice(2).toLowerCase().padStart(64, "0") }, "latest"] });
        meta.push({ w, asset: c.id + ":" + t.sym, dec: t.dec, sym: t.sym, cg: "tether", min: 10n ** BigInt(t.dec - 2) });
      }
    }
    let res;
    try {
      const r = await fetch(c.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(calls) });
      if (!r.ok) return; res = await r.json();
    } catch { return; }
    if (!Array.isArray(res)) return;
    for (const x of res) {
      const m = meta[x.id];
      if (!m || typeof x.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(x.result)) continue;
      diff(m.w, m.w.evm, m.asset, x.result === "0x" ? 0n : BigInt(x.result), m.dec, m.sym, c.name, m.cg, m.min);
    }
  })());

  await Promise.all(jobs);

  if (found.length) {
    const ids = [...new Set(found.map((f) => f.cg))].join(",");
    let px = {};
    try { px = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)).json(); } catch {}
    const byUser = {};
    for (const f of found) (byUser[f.uid] = byUser[f.uid] || []).push(f);
    for (const [uid, list] of Object.entries(byUser)) {
      const lines = list.map((f) => {
        const amt = fmtUnits(f.amount, f.dec);
        const usd = px[f.cg] && px[f.cg].usd ? Number(amt) * px[f.cg].usd : null;
        return `«${esc(f.label)}»: <b>+${amt} ${f.sym}</b> (${f.net})` + (usd != null ? ` ≈ $${usd.toFixed(2)}` : "") + (f.extra ? `\n   ${f.extra}` : "");
      });
      await send(env, Number(uid), `💰 <b>Поступление</b>\n\n` + lines.join("\n"), true);
    }
  }

  if (seenCh) {
    const lim = Date.now() - 30 * 864e5;
    for (const k in seen.tx) if (seen.tx[k] < lim) delete seen.tx[k];
    await env.KV.put("seen", JSON.stringify(seen));
  }
  if (balCh) await env.KV.put("bal", JSON.stringify(bal));
}

// ---------- общее ----------
// хранилище может быть подключено под именем KV или seed-kv
function withKV(env) { return env.KV ? env : Object.assign({}, env, { KV: env["seed-kv"] }); }
function fmtUnits(v, dec) {
  const s = v.toString().padStart(dec + 1, "0");
  let int = s.slice(0, s.length - dec), frac = s.slice(s.length - dec).replace(/0+$/, "");
  if (frac.length > 8) frac = frac.slice(0, 8).replace(/0+$/, "");
  return frac ? int + "." + frac : int;
}
function esc(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function msk(d) {
  return d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
async function send(env, chatId, text, noPreview) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: !!noPreview }),
  });
  return r.json().catch(() => ({}));
}

// Проверка подписи initData по документации Telegram Mini Apps.
async function checkInitData(initData, token) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const te = new TextEncoder();
  const hmac = async (keyBytes, data) => {
    const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(data)));
  };
  const secret = await hmac(te.encode("WebAppData"), token);
  const calc = [...(await hmac(secret, dcs))].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (calc !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (!(age < 86400)) return null;
  try { const u = JSON.parse(p.get("user")); return u && u.id ? u : null; } catch { return null; }
}
