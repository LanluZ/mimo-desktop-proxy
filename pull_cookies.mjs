#!/usr/bin/env node
/**
 * Pull the MiMo Desktop login cookies out of the running app's main process.
 *
 * The upstream only accepts the *runtime* session cookies (serviceToken,
 * mimopc_ph, mimopc_slh) which the app sets in its `persist:xiaomi-account`
 * Electron partition and never persists to disk — so the on-disk cookie DB is
 * useless and the app must be started with --inspect=<port>.
 *
 *   node pull_cookies.mjs [out.json] [inspectPort]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || path.join(HERE, "cookies.json"));
const PORT = process.argv[3] || process.env.MIMO_INSPECT_PORT || "9229";
const KEEP = ["xiaomimimo.com", "xiaomi.com", "mi.com", "miui.com"];

const EXPR = `(async () => {
  const req = globalThis.require || process.mainModule.require;
  const { session } = req("electron");
  const out = [];
  for (const part of ["persist:xiaomi-account"]) {
    const s = session.fromPartition(part);
    for (const c of await s.cookies.get({})) {
      out.push({ partition: part, host: c.domain, name: c.name, value: c.value,
                 path: c.path, session: !!c.session, secure: !!c.secure,
                 httpOnly: !!c.httpOnly, expirationDate: c.expirationDate ?? null });
    }
  }
  return JSON.stringify(out);
})()`;

function keep(domain) {
  const d = String(domain || "").replace(/^\./, "").toLowerCase();
  return KEEP.some((s) => d === s || d.endsWith("." + s));
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = Array.isArray(list) ? list.find((t) => t.webSocketDebuggerUrl) : null;
if (!target) {
  console.error(
    `[pull] no Node inspector target on :${PORT}. Start MiMo Desktop with --inspect=${PORT} ` +
      `(start-mimo-proxy.cmd does this).`
  );
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = (e) => reject(new Error(`inspector connect failed: ${e.message || "error"}`));
});

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
};
const send = (method, params = {}) => {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
};

await send("Runtime.enable").catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ATTEMPTS = Number(process.env.MIMO_PULL_ATTEMPTS || 20);
let all = null;
let lastErr = "unknown";

// The app may still be booting: `session.fromPartition` throws
// "Session can only be received when app is ready", and serviceToken only
// appears after the SSO exchange settles. Retry both.
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    const res = await send("Runtime.evaluate", {
      expression: EXPR,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails).slice(0, 200));
    }
    const parsed = JSON.parse(res.result.value || "[]");
    const kept = parsed.filter((c) => keep(c.host));
    if (!kept.some((c) => c.name === "serviceToken")) {
      throw new Error(`no serviceToken yet (${kept.length} cookies for our hosts) — still signing in?`);
    }
    all = parsed;
    break;
  } catch (err) {
    lastErr = err.message;
    if (attempt < ATTEMPTS) await sleep(2000);
  }
}
ws.close();

if (!all) {
  console.error(`[pull] gave up after ${ATTEMPTS} attempts: ${lastErr}`);
  process.exit(2);
}
const cookies = all.filter((c) => keep(c.host));

const payload = {
  extracted_at: new Date().toISOString(),
  source: `electron main process via :${PORT}`,
  kept: cookies.length,
  cookies,
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });

console.log(`kept ${cookies.length} cookies:`);
for (const c of cookies) {
  console.log(
    `  ${c.host.padEnd(32)} ${c.name.padEnd(16)} len=${String(c.value.length).padStart(4)} ${
      c.session ? "session" : "persistent"
    }`
  );
}
console.log(`written -> ${OUT}`);

if (!cookies.some((c) => c.name === "serviceToken")) {
  console.error(
    "[pull] WARNING: no serviceToken cookie — the app is probably not logged in yet. " +
      "Wait for it to finish signing in, then retry."
  );
  process.exit(3);
}
