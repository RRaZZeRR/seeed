// Cloudflare Worker для бота Seed.
//  POST /        — мини-приложение присылает новый кошелёк, бот пишет его вам в ЛС.
//  POST /watch   — мини-приложение присылает адреса кошельков и настройку уведомлений.
//  Каждую минуту (Cron Trigger) сервер проверяет адреса и пишет о поступлениях:
//    BTC — при 0 подтверждений и при 1-м подтверждении.
//    Последний созданный кошелёк каждого пользователя проверяется часто (BTC ~каждые 6 секунд),
//    старые — по очереди, по несколько штук в минуту, чтобы не тратить лишние запросы.
//    USDT TRC20 и TRX, SOL, а также ETH/BNB/POL и USDT/USDC в сетях
//    Ethereum, BNB Chain, Polygon, Arbitrum, Base — как только баланс вырос.
// Нужно: секрет BOT_TOKEN и KV-хранилище, подключённое под именем KV.

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const RE = {
  // любой формат BTC: bc1q… (Native SegWit), bc1p… (Taproot), 3… (Nested SegWit), 1… (Legacy)
  btc: /^(bc1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}|bc1p[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  trx: new RegExp(`^T${B58}{33}$`),
  sol: new RegExp(`^${B58}{32,44}$`),
  evm: /^0x[0-9a-fA-F]{40}$/,
};
// Бесплатный тариф Cloudflare: 50 внешних запросов за один запуск (запуск раз в минуту).
const SUB_LIMIT = 46;      // запас под отправку сообщений
const MAX_ROUNDS = 10;     // последний кошелёк: до 10 проверок BTC в минуту — примерно каждые 6 секунд
const OLD_PER_RUN = 3;     // старые кошельки: сколько проверять за минуту (по очереди); 0 — не проверять совсем

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
    if (req.method !== "POST") {
      const url = new URL(req.url);
      // диагностика: что сервер видит и какие сервисы ему отвечают (без адресов и ключей)
      if (url.pathname === "/diag") {
        if (!env.KV) return json({ ok: false, kv: false });
        if (url.searchParams.get("run") === "1") return json(await checkAll(env, { single: true }));
        return json({ ok: true, last: await env.KV.get("diag", "json") });
      }
      return json({ ok: true, info: "Seed bot server работает", kv: !!env.KV });
    }
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
        const item = { label: String(x.label || "Кошелёк").slice(0, 60), t: Number(x.t) || 0 };
        for (const k of ["btc", "trx", "sol", "evm"]) if (RE[k].test(String(x[k] || ""))) item[k] = String(x[k]);
        if (!item.btc && !item.trx && !item.sol && !item.evm) continue;
        w.push(item);
        // кошелёк создан только что — у него нет истории, первое же поступление считаем новым
        if (Date.now() - Number(x.t || 0) < 10 * 60000) for (const k of ["btc", "trx", "sol", "evm"]) if (item[k]) fresh.push(item[k].toLowerCase());
      }
      const data = (await env.KV.get("watch", "json")) || { users: {} };
      const nb = b.notifyBtc !== undefined ? b.notifyBtc !== false : b.notify !== false;
      const no = b.notifyOther !== undefined ? b.notifyOther !== false : b.notify !== false;
      data.users[String(user.id)] = { w, nb, no };
      await env.KV.put("watch", JSON.stringify(data));
      if (fresh.length) {
        const seen = (await env.KV.get("seen", "json")) || { tx: {}, addr: {} };
        let ch = false;
        for (const a of fresh) if (!seen.addr[a]) { seen.addr[a] = 1; ch = true; }
        if (ch) await env.KV.put("seen", JSON.stringify(seen));
      }
      return json({ ok: true, watching: w.length, notifyBtc: nb, notifyOther: no });
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
    await checkAll(withKV(env));
  },
};

// ---------- проверка поступлений ----------
async function checkAll(env, opt = {}) {
  const diag = { t: new Date().toISOString(), users: 0, wallets: 0, rounds: 0, sub: 0, api: {}, found: 0, sent: [] };
  if (!env.KV || !env.BOT_TOKEN) return { ...diag, error: "нет KV или BOT_TOKEN" };
  const data = await env.KV.get("watch", "json");
  if (!data || !data.users) return { ...diag, error: "сервер ещё не получил адреса (откройте мини-приложение)" };

  const all = [];
  for (const [uid, u] of Object.entries(data.users)) for (const w of u.w || []) all.push({ uid, ...w,
    nb: u.nb !== undefined ? u.nb : u.n !== false,     // уведомления о BTC
    no: u.no !== undefined ? u.no : u.n !== false });   // уведомления об остальных монетах
  diag.users = Object.keys(data.users).length; diag.wallets = all.length;
  diag.perUser = Object.values(data.users).map((u) => ({ wallets: (u.w || []).length, notifyBtc: u.nb, notifyOther: u.no }));
  if (!all.length) return { ...diag, error: "список кошельков пуст" };
  const minute = Math.floor(Date.now() / 60000);
  const pick = (list, per) => { if (!list.length) return []; const ch = Math.ceil(list.length / per), p = minute % ch; return list.slice(p * per, p * per + per); };

  // последний созданный кошелёк каждого пользователя — главный, его проверяем часто
  const newest = {};
  for (const w of all) if (!newest[w.uid] || (w.t || 0) > (newest[w.uid].t || 0)) newest[w.uid] = w;
  const hot = Object.values(newest);
  const cold = OLD_PER_RUN > 0 ? pick(all.filter((w) => !hot.includes(w)), OLD_PER_RUN) : [];

  const btcFast = hot.filter((w) => w.btc && w.nb).slice(0, 10);                          // BTC несколько раз в минуту
  const btcSlow = [...hot.filter((w) => w.btc && !w.nb), ...cold.filter((w) => w.btc)];   // раз в минуту
  const others = [...hot, ...cold].filter((w) => w.trx || w.sol || w.evm);
  // сколько запросов уйдёт на первый раунд — остаток делим на быстрые проверки BTC
  const cost0 = btcFast.length + btcSlow.length + others.filter((w) => w.trx).length
    + (others.some((w) => w.sol) ? 1 : 0) + (others.some((w) => w.evm) ? CHAINS.length : 0) + 3;
  let rounds = btcFast.length ? 1 + Math.max(0, Math.min(MAX_ROUNDS - 1, Math.floor((SUB_LIMIT - cost0) / (btcFast.length + 1)))) : 1;

  if (opt.single) rounds = 1;
  diag.rounds = rounds; diag.hot = hot.map((w) => ({ btc: !!w.btc, trx: !!w.trx, sol: !!w.sol, created: w.t ? new Date(w.t).toISOString() : null }));
  const seen = (await env.KV.get("seen", "json")) || { tx: {}, addr: {} };
  const bal = (await env.KV.get("bal", "json")) || {};
  let seenCh = false, balCh = false, sub = 0;
  let found = [];
  const get = async (url, o) => {
    sub++;
    const host = new URL(url).hostname;
    const s = (diag.api[host] = diag.api[host] || { ok: 0, err: [] });
    try {
      const r = await fetch(url, o);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); s.ok++; return j;
    } catch (e) { if (s.err.length < 3) s.err.push(String(e.message || e).slice(0, 80)); throw e; }
  };

  // ---- BTC ----
  function btcTx(w, tx, first) {
    const key = w.btc + ":" + tx.txid;
    const rec = seen.tx[key];
    const conf = !!(tx.status && tx.status.confirmed);
    if (typeof rec === "number" || (rec && rec.c === 1)) return;
    if (rec && rec.c === 0 && !conf) return;
    let inSat = 0, outSat = 0;
    for (const o of tx.vout || []) if (o.scriptpubkey_address === w.btc) inSat += o.value;
    for (const i of tx.vin || []) if (i.prevout && i.prevout.scriptpubkey_address === w.btc) outSat += i.prevout.value;
    const net = inSat - outSat;
    seenCh = true;
    if (first || net <= 0) { seen.tx[key] = { t: Date.now(), c: 1 }; return; }
    if (!conf) { seen.tx[key] = { t: Date.now(), c: 0, n: net }; btcFound(w, net, 0, tx.txid); }
    else { seen.tx[key] = { t: rec ? rec.t : Date.now(), c: 1 }; btcFound(w, net, 1, tx.txid); }
  }
  function btcFound(w, net, stage, txid) {
    if (!w.nb) return;
    const link = ` · <a href="https://mempool.space/tx/${txid}">tx</a>`;
    found.push({ uid: w.uid, label: w.label, amount: BigInt(net), dec: 8, sym: "BTC", net: "Bitcoin", cg: "bitcoin", stage,
      extra: stage === 0 ? "⏳ в мемпуле, 0 подтверждений" + link : "✅ 1 подтверждение" + link });
  }
  // полная проверка адреса: все последние транзакции
  async function btcFull(w) {
    let txs; try { txs = await get(`https://mempool.space/api/address/${w.btc}/txs`); } catch { return; }
    const a = w.btc.toLowerCase(), first = !seen.addr[a];
    if (first) { seen.addr[a] = 1; seenCh = true; }
    for (const tx of txs) btcTx(w, tx, first);
  }
  // быстрая проверка: новые транзакции в мемпуле + подтверждение уже замеченных
  async function btcQuick(w) {
    const pend = Object.keys(seen.tx).filter((k) => k.startsWith(w.btc + ":") && seen.tx[k] && seen.tx[k].c === 0);
    const tasks = [(async () => {
      let txs; try { txs = await get(`https://mempool.space/api/address/${w.btc}/txs/mempool`); } catch { return; }
      for (const tx of txs) btcTx(w, tx, false);
    })()];
    for (const k of pend) tasks.push((async () => {
      const txid = k.split(":")[1];
      let st; try { st = await get(`https://mempool.space/api/tx/${txid}/status`); } catch { return; }
      const rec = seen.tx[k];
      if (st.confirmed && rec && rec.c === 0) { seen.tx[k] = { t: rec.t, c: 1 }; seenCh = true; btcFound(w, rec.n || 0, 1, txid); }
    })());
    await Promise.all(tasks);
  }

  // ---- остальные монеты: сравнение баланса, сообщаем только о росте ----
  function diff(w, addr, asset, val, dec, sym, net, cg, minUnits) {
    const key = addr.toLowerCase() + "|" + asset;
    const prevS = bal[key];
    const cur = BigInt(val);
    if (prevS === undefined) {
      bal[key] = cur.toString(); balCh = true;
      if (!seen.addr[addr.toLowerCase()]) return;    // первый раз видим адрес — просто запоминаем
      if (cur >= minUnits && w.no) found.push({ uid: w.uid, label: w.label, amount: cur, dec, sym, net, cg });
      return;
    }
    const prev = BigInt(prevS);
    if (cur !== prev) { bal[key] = cur.toString(); balCh = true; }
    if (cur - prev >= minUnits && w.no) found.push({ uid: w.uid, label: w.label, amount: cur - prev, dec, sym, net, cg });
  }
  async function othersCheck() {
    const jobs = [];
    for (const w of others) if (w.trx) jobs.push((async () => {
      let j; try { j = await get(`https://api.trongrid.io/v1/accounts/${w.trx}`); } catch { return; }
      if (!j || j.success === false) return;
      let trx = 0n, usdt = 0n;
      const d = j.data && j.data[0];
      if (d) { trx = BigInt(d.balance || 0); for (const o of d.trc20 || []) if (o[USDT_TRC20] != null) usdt = BigInt(o[USDT_TRC20]); }
      diff(w, w.trx, "usdt", usdt, 6, "USDT", "TRC20", "tether", 10000n);
      diff(w, w.trx, "trx", trx, 6, "TRX", "TRON", "tron", 100000n);
    })());
    const solW = others.filter((w) => w.sol);
    if (solW.length) jobs.push((async () => {
      let j; try { j = await get("https://solana-rpc.publicnode.com", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [solW.map((w) => w.sol), { encoding: "base64", commitment: "processed" }] }) }); } catch { return; }
      if (!j.result || !Array.isArray(j.result.value)) return;
      solW.forEach((w, i) => { const acc = j.result.value[i]; diff(w, w.sol, "sol", acc ? acc.lamports : 0, 9, "SOL", "Solana", "solana", 100000n); });
    })());
    const evmW = others.filter((w) => w.evm);
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
      let res; try { res = await get(c.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(calls) }); } catch { return; }
      if (!Array.isArray(res)) return;
      for (const x of res) {
        const m = meta[x.id];
        if (!m || typeof x.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(x.result)) continue;
        diff(m.w, m.w.evm, m.asset, x.result === "0x" ? 0n : BigInt(x.result), m.dec, m.sym, c.name, m.cg, m.min);
      }
    })());
    await Promise.all(jobs);
  }

  // ---- отправка и сохранение ----
  let px = null;
  async function flush() {
    if (found.length) {
      const list0 = found; found = [];
      if (!px) { try { px = await get(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether,tron,solana,ethereum,binancecoin,polygon-ecosystem-token&vs_currencies=usd`); } catch { px = {}; } }
      const byUser = {};
      for (const f of list0) (byUser[f.uid] = byUser[f.uid] || []).push(f);
      for (const [uid, list] of Object.entries(byUser)) {
        const lines = list.map((f) => {
          const amt = fmtUnits(f.amount, f.dec);
          const usd = px[f.cg] && px[f.cg].usd ? Number(amt) * px[f.cg].usd : null;
          return `«${esc(f.label)}»: <b>+${amt} ${f.sym}</b> (${f.net})` + (usd != null ? ` ≈ $${usd.toFixed(2)}` : "") + (f.extra ? `\n   ${f.extra}` : "");
        });
        const head = list.every((f) => f.stage === 1) ? "✅ <b>Подтверждено</b>" : "💰 <b>Поступление</b>";
        sub++; diag.found += list.length;
        const rs = await send(env, Number(uid), head + `\n\n` + lines.join("\n"), true);
        diag.sent.push(rs.ok ? "ok" : String(rs.description || "ошибка").slice(0, 80));
      }
    }
    if (seenCh) {
      const lim = Date.now() - 30 * 864e5;
      for (const k in seen.tx) { const v = seen.tx[k]; if ((typeof v === "number" ? v : v.t) < lim) delete seen.tx[k]; }
      await env.KV.put("seen", JSON.stringify(seen)); seenCh = false;
    }
    if (balCh) { await env.KV.put("bal", JSON.stringify(bal)); balCh = false; }
  }

  // раунд 0: полная проверка BTC и остальные монеты
  const start = Date.now();
  await Promise.all([...btcFast.map(btcFull), ...btcSlow.map(btcFull), othersCheck()]);
  await flush();
  // следующие раунды: только BTC, каждые ~10 секунд, пока хватает лимита запросов
  const step = Math.floor(58000 / rounds);
  for (let r = 1; r < rounds; r++) {
    const wait = start + r * step - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    if (sub + btcFast.length + 1 > SUB_LIMIT) break;
    await Promise.all(btcFast.map(btcQuick));
    await flush();
  }
  diag.sub = sub; diag.seenAddr = Object.keys(seen.addr).length; diag.balKeys = Object.keys(bal).length;
  // сохраняем диагностику не каждый раз — у бесплатного KV лимит 1000 записей в день
  if (!opt.single && (minute % 10 === 0 || diag.sent.length || Object.values(diag.api).some((a) => a.err.length && minute % 2 === 0)))
    await env.KV.put("diag", JSON.stringify(diag));
  return diag;
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
