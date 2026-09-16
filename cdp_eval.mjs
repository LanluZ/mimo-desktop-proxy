#!/usr/bin/env node
/**
 * Minimal CDP eval helper — used to poke the MiMo Desktop *main process*
 * (start it with --inspect=<port>) or any Chromium target.
 *
 *   node cdp_eval.mjs http://127.0.0.1:9229/json/list "1+1"
 */

const endpoint = process.argv[2];
const expression = process.argv[3] || "1+1";

let wsUrl = endpoint;
if (!endpoint.startsWith("ws://")) {
  const list = await (await fetch(endpoint)).json();
  const target = Array.isArray(list) ? list[0] : null;
  if (!target?.webSocketDebuggerUrl) {
    console.error("no debuggable target at", endpoint, JSON.stringify(list).slice(0, 300));
    process.exit(1);
  }
  wsUrl = target.webSocketDebuggerUrl;
}

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = (e) => reject(new Error(`connect failed: ${e.message || "error"}`));
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
const res = await send("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
  allowUnsafeEvalBlockedByCSP: true,
});
ws.close();

if (res.exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(res.exceptionDetails).slice(0, 1500));
  process.exit(2);
}
const value = res.result?.value;
console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
