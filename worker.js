// Cloudflare Worker для бота Seed.
// Принимает от мини-приложения адреса и зашифрованный сид, проверяет,
// что запрос пришёл от настоящего пользователя Telegram, и отправляет
// ему сообщение от имени бота. Сид в открытом виде сюда не попадает.
// Токен бота хранится в секрете BOT_TOKEN (Settings → Variables and Secrets).

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: true, info: "Seed bot server работает" });
    if (!env.BOT_TOKEN) return json({ ok: false, error: "на сервере не задан BOT_TOKEN" }, 500);

    let b;
    try { b = await req.json(); } catch { return json({ ok: false, error: "неверный запрос" }, 400); }

    const user = await checkInitData(String(b.initData || ""), env.BOT_TOKEN);
    if (!user) return json({ ok: false, error: "запрос не из Telegram" }, 403);

    const B58 = "[1-9A-HJ-NP-Za-km-z]";
    const rules = {
      trx: new RegExp(`^T${B58}{33}$`),
      btc: /^bc1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/,
      sol: new RegExp(`^${B58}{32,44}$`),
      cipher: /^SP1:[A-Za-z0-9_-]{40,600}$/,
    };
    for (const k in rules) if (!rules[k].test(String(b[k] || ""))) return json({ ok: false, error: "неверное поле " + k }, 400);

    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const label = esc(String(b.label || "Кошелёк").slice(0, 60));
    const date = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
    const text =
      `🔐 <b>${label}</b> · ${date}\n\n` +
      `USDT TRC20: <code>${b.trx}</code>\n` +
      `BTC: <code>${b.btc}</code>\n` +
      `SOL: <code>${b.sol}</code>\n\n` +
      `Сид (зашифрован):\n<code>${b.cipher}</code>`;

    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: user.id, text, parse_mode: "HTML" }),
    });
    const rj = await r.json().catch(() => ({}));
    if (!rj.ok) return json({ ok: false, error: rj.description || "Telegram не принял сообщение" }, 502);
    return json({ ok: true });
  },
};

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
