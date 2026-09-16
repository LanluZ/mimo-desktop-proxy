#!/usr/bin/env node
/**
 * Local OpenAI-compatible proxy in front of Xiaomi MiMo Desktop's free-quota upstream.
 *
 * Upstream:  https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions
 * Auth:      Xiaomi passport cookies (extracted from the desktop app's persist:xiaomi-account partition)
 * Header:    X-Mimo-Source: mimocode-cli-free  (what the desktop app itself sends)
 *
 * Zero dependencies (Node >= 18). Binds to 127.0.0.1 only.
 *
 *   node proxy.mjs
 *   curl http://127.0.0.1:8800/v1/chat/completions -d '{"model":"mimo-auto","messages":[{"role":"user","content":"hi"}]}'
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
  host: process.env.MIMO_PROXY_HOST || "127.0.0.1",
  port: Number(process.env.MIMO_PROXY_PORT || 8800),
  cookiesFile: process.env.MIMO_COOKIES_FILE || path.join(HERE, "cookies.json"),
  base: (process.env.MIMO_UPSTREAM_BASE || "https://mimo-server-cn.xiaomimimo.com/api").replace(/\/+$/, ""),
  mePath: "/user/xiaomi/me",
  chatPath: "/route/chat/completions",
  source: "mimocode-cli-free",
  reloadMs: 30_000,
  // Clients like Codex hardcode their own model ids in the request body
  // (gpt-5.6-luna, ...). The upstream only serves its own catalogue and answers
  // 400 chat_model_not_public otherwise, so anything unknown falls back to this.
  defaultModel: process.env.MIMO_DEFAULT_MODEL || "mimo-pro",
};

// Models the upstream understands. mimo-auto is the desktop app's own alias and is
// rewritten to mimo-pro exactly like the app does (bb()/wR() in app.asar).
const MODEL_ALIASES = { "mimo-auto": "mimo-pro", "mimo-flash": "mimo-flash", "mimo-pro": "mimo-pro" };
const MODELS = ["mimo-auto", "mimo-pro", "mimo-flash"];
let cookies = [];
let cookieHeader = "";
let cookieMeta = {};
let loadedAt = 0;

function loadCookies(force = false) {
  if (!force && Date.now() - loadedAt < CFG.reloadMs) return;
  try {
    const raw = JSON.parse(fs.readFileSync(CFG.cookiesFile, "utf8"));
    cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
    cookieMeta = { extracted_at: raw.extracted_at, kept: raw.kept, key_id: raw.key_id };
    // prefer the more specific host when the same cookie name appears twice
    const byName = new Map();
    for (const c of [...cookies].sort((a, b) => a.host.length - b.host.length)) byName.set(c.name, c.value);
    cookieHeader = [...byName].map(([k, v]) => `${k}=${v}`).join("; ");
    loadedAt = Date.now();
  } catch (err) {
    cookieHeader = "";
    console.error(`[proxy] cannot read ${CFG.cookiesFile}: ${err.message}`);
    console.error("[proxy] run refresh-cookies.cmd to (re)extract them");
  }
}

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

// Map whatever the client asked for onto a model the upstream actually serves.
function resolveModel(requested) {
  const name = typeof requested === "string" && requested ? requested : "mimo-auto";
  if (MODEL_ALIASES[name]) return MODEL_ALIASES[name];
  log(`unknown model "${name}" -> ${CFG.defaultModel} (override with MIMO_DEFAULT_MODEL)`);
  return CFG.defaultModel;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function upstreamFetch(urlPath, init) {
  loadCookies();
  if (!cookieHeader) throw new Error("no cookies loaded");
  return fetch(CFG.base + urlPath, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Cookie: cookieHeader,
    },
  });
}

// serviceToken / mimopc_* are runtime session cookies in the desktop app: they vanish
// whenever the app restarts and can expire on their own. Re-pull them when auth fails.
let refreshing = null;
function refreshCookies() {
  if (refreshing) return refreshing;
  refreshing = new Promise((resolve) => {
    execFile(process.execPath, [path.join(HERE, "pull_cookies.mjs")], { cwd: HERE }, (err, stdout, stderr) => {
      if (err) console.error(`[proxy] cookie refresh failed: ${String(stderr || err.message).slice(0, 300)}`);
      else log("cookies refreshed from the desktop app");
      loadCookies(true);
      refreshing = null;
      resolve(!err);
    });
  });
  return refreshing;
}

// One transparent retry: if the upstream rejects our cookies, re-pull them from the app first.
async function callUpstream(urlPath, init) {
  let res = await upstreamFetch(urlPath, init);
  if (res.status === 401 || res.status === 403) {
    await res.text().catch(() => {});
    log(`upstream ${res.status} — re-pulling cookies from the desktop app`);
    if (await refreshCookies()) res = await upstreamFetch(urlPath, init);
  }
  return res;
}

async function probeLogin() {
  if (!cookieHeader) await refreshCookies();
  if (!cookieHeader) return { logged_in: false, reason: "no-cookies" };
  try {
    const r = await callUpstream(CFG.mePath, { method: "GET", headers: { Accept: "application/json" } });
    const text = await r.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const userId = parsed?.data?.userId;
    return {
      logged_in: r.status === 200 && parsed?.code === 0 && userId != null,
      status: r.status,
      userId: userId != null ? String(userId) : undefined,
      region: parsed?.data?.region,
      server_code: parsed?.code,
      raw: r.status === 200 ? undefined : text.slice(0, 300),
    };
  } catch (err) {
    return { logged_in: false, reason: String(err.message || err) };
  }
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  let buf = Buffer.concat(chunks);
  // Some clients (reqwest-based ones behind a proxy/compressor) send a compressed body.
  const enc = String(req.headers["content-encoding"] || "").toLowerCase().trim();
  if (enc && enc !== "identity") {
    const before = buf.length;
    try {
      if (enc === "gzip" || enc === "x-gzip") buf = zlib.gunzipSync(buf);
      else if (enc === "deflate") buf = zlib.inflateSync(buf);
      else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
      else if (enc === "zstd" && zlib.zstdDecompressSync) buf = zlib.zstdDecompressSync(buf);
      else throw new Error(`unsupported content-encoding ${enc}`);
      log(`body inflate ${enc}: ${before}B -> ${buf.length}B`);
    } catch (err) {
      log(`body inflate FAILED enc=${enc} bytes=${before}: ${err.message}`);
      throw new Error(`cannot decode request body (content-encoding: ${enc})`);
    }
  }
  const raw = buf.toString("utf8");
  if (process.env.MIMO_DEBUG_BODY) {
    log(
      `body: ${req.method} ${req.url} ct=${req.headers["content-type"] || "-"} bytes=${buf.length} ` +
        `head=${JSON.stringify(raw.slice(0, 200))}`
    );
  }
  return raw;
}

function badJson(res, req, raw, where) {
  log(
    `400 ${where}: body is not JSON — ct=${req.headers["content-type"] || "-"} ` +
      `enc=${req.headers["content-encoding"] || "-"} bytes=${raw.length} ` +
      `head=${JSON.stringify(raw.slice(0, 160))}`
  );
  return send(res, 400, { error: { message: "body must be JSON", type: "invalid_request_error" } });
}

async function handleChat(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return badJson(res, req, raw, "chat/completions");
  }
  const requested = typeof body.model === "string" && body.model ? body.model : "mimo-auto";
  body.model = resolveModel(requested);

  const started = Date.now();
  let upstream;
  try {
    upstream = await callUpstream(CFG.chatPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        "X-Mimo-Source": CFG.source,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log(`chat upstream error: ${err.message}`);
    return send(res, 502, { error: { message: `upstream request failed: ${err.message}`, type: "upstream_error" } });
  }

  const headers = { "Cache-Control": "no-store" };
  const ctype = upstream.headers.get("content-type");
  if (ctype) headers["Content-Type"] = ctype;

  if (upstream.status >= 400) {
    const text = await upstream.text();
    log(`chat ${body.model} -> upstream ${upstream.status}: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
    const hint =
      upstream.status === 401 || upstream.status === 403
        ? " (login cookie stale — run refresh-cookies.cmd)"
        : "";
    return send(res, upstream.status, {
      error: { message: `upstream ${upstream.status}${hint}: ${text.slice(0, 500)}`, type: "upstream_error" },
    });
  }

  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  let bytes = 0;
  try {
    for await (const chunk of upstream.body) {
      bytes += chunk.length;
      if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
    }
  } catch (err) {
    log(`chat stream aborted after ${bytes}B: ${err.message}`);
  }
  res.end();
  log(`chat model=${requested}->${body.model} stream=${!!body.stream} ${bytes}B ${Date.now() - started}ms`);
}

// ---------------------------------------------------------------------------
// /v1/responses  (shape adapter — the upstream only speaks chat/completions)
//
// The upstream has no Responses semantics at all: no server-side state, no
// previous_response_id, no built-in tools. We translate the request, call
// chat/completions, and re-shape the answer into Responses objects/events so
// clients that only speak the Responses API can use it.
// ---------------------------------------------------------------------------

const hex = () => globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24);

function contentPartsToChat(content, forInput) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  let onlyText = true;
  for (const p of content) {
    if (typeof p === "string") {
      parts.push({ type: "text", text: p });
      continue;
    }
    const t = p?.type;
    if (t === "input_text" || t === "output_text" || t === "text" || t === "summary_text") {
      parts.push({ type: "text", text: p.text ?? "" });
    } else if (t === "input_image" || t === "image_url") {
      onlyText = false;
      parts.push({ type: "image_url", image_url: { url: p.image_url || p.url } });
    } else if (t === "refusal") {
      parts.push({ type: "text", text: p.refusal ?? "" });
    }
  }
  if (onlyText) return parts.map((p) => p.text).join("");
  return parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : p));
}

function responsesToChat(body, model) {
  const messages = [];
  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions });
  }

  const items = Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input ?? "" }];
  for (const item of items) {
    if (item == null) continue;
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    const t = item.type;
    if (t === "function_call") {
      const call = {
        id: item.call_id || item.id || `call_${hex()}`,
        type: "function",
        function: { name: item.name || "", arguments: item.arguments || "" },
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
      continue;
    }
    if (t === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }
    // reasoning / item_reference / anything else without a role: nothing useful upstream
    if (!item.role) continue;
    const role = item.role === "developer" ? "system" : item.role;
    const msg = { role, content: contentPartsToChat(item.content, true) };
    if (Array.isArray(item.tool_calls) && item.tool_calls.length) {
      msg.tool_calls = item.tool_calls.map((tc) => ({
        id: tc.id || tc.call_id || `call_${hex()}`,
        type: "function",
        function: { name: tc.function?.name || tc.name || "", arguments: tc.function?.arguments || tc.arguments || "" },
      }));
    }
    messages.push(msg);
  }

  const chat = { model, messages, stream: !!body.stream };
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (typeof body.parallel_tool_calls === "boolean") chat.parallel_tool_calls = body.parallel_tool_calls;

  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((t) => t?.type === "function")
        .map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters ?? { type: "object", properties: {} },
          },
        }))
    : [];
  if (tools.length) chat.tools = tools;

  const choice = body.tool_choice;
  if (choice === "auto" || choice === "none" || choice === "required") chat.tool_choice = choice;
  else if (choice?.type === "function" && choice.name) chat.tool_choice = { type: "function", function: { name: choice.name } };

  const fmt = body.text?.format;
  if (fmt?.type === "json_schema" && fmt.schema) {
    chat.response_format = { type: "json_schema", json_schema: { name: fmt.name || "response", schema: fmt.schema, strict: fmt.strict ?? null } };
  } else if (fmt?.type === "json_object") {
    chat.response_format = { type: "json_object" };
  }

  // reasoning / store / include / previous_response_id / metadata are silently dropped:
  // the upstream ignores effort and never returns encrypted reasoning.
  return chat;
}

function chatToResponse(cc, requestedModel) {
  const choice = cc.choices?.[0] || {};
  const msg = choice.message || {};
  const output = [];
  if (msg.reasoning_content) {
    output.push({ type: "reasoning", id: `rs_${hex()}`, summary: [{ type: "summary_text", text: msg.reasoning_content }] });
  }
  if (typeof msg.content === "string" && msg.content.length) {
    output.push({
      type: "message",
      id: `msg_${hex()}`,
      status: choice.finish_reason === "length" ? "incomplete" : "completed",
      role: "assistant",
      content: [{ type: "output_text", text: msg.content, annotations: [] }],
    });
  }
  for (const tc of msg.tool_calls || []) {
    output.push({
      type: "function_call",
      id: `fc_${hex()}`,
      call_id: tc.id || `call_${hex()}`,
      name: tc.function?.name || "",
      arguments: tc.function?.arguments ?? "",
      status: "completed",
    });
  }
  const u = cc.usage || {};
  return {
    id: `resp_${hex()}`,
    object: "response",
    created_at: cc.created ?? Math.floor(Date.now() / 1000),
    status: choice.finish_reason === "length" ? "incomplete" : "completed",
    model: requestedModel || cc.model,
    output,
    output_text: typeof msg.content === "string" ? msg.content : "",
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    error: null,
    incomplete_details: choice.finish_reason === "length" ? { reason: "max_output_tokens" } : null,
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens: u.completion_tokens ?? 0,
      output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
      total_tokens: u.total_tokens ?? 0,
    },
  };
}

async function streamResponses(upstream, res, requestedModel) {
  let seq = 0;
  let debugCount = 0;
  const sse = (type, payload) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  };
  const shell = (status, output = [], extra = {}) => ({
    id: respId,
    object: "response",
    created_at: createdAt,
    status,
    model: requestedModel,
    output,
    output_text: "",
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    error: null,
    incomplete_details: null,
    usage: null,
    ...extra,
  });

  const respId = `resp_${hex()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const outputIndexes = { reasoning: 0, message: -1, tool: -1 };
  let reasoningId = null;
  let messageId = null;
  let reasoningClosed = false;
  let messageClosed = false;
  let reasoningText = "";
  let messageText = "";
  const toolCalls = new Map(); // upstream index -> { itemId, callId, name, args, outputIndex }
  let nextIndex = 0;
  let usage = null;
  let finish = null;

  sse("response.created", { response: shell("in_progress") });
  sse("response.in_progress", { response: shell("in_progress") });

  const openReasoning = () => {
    if (reasoningId) return;
    reasoningId = `rs_${hex()}`;
    outputIndexes.reasoning = nextIndex++;
    sse("response.output_item.added", {
      output_index: outputIndexes.reasoning,
      item: { type: "reasoning", id: reasoningId, summary: [] },
    });
  };
  const closeReasoning = () => {
    if (!reasoningId || reasoningClosed) return;
    reasoningClosed = true;
    const idx = outputIndexes.reasoning;
    sse("response.reasoning_summary_text.done", {
      item_id: reasoningId, output_index: idx, summary_index: 0, text: reasoningText,
    });
    sse("response.output_item.done", {
      output_index: idx,
      item: { type: "reasoning", id: reasoningId, summary: [{ type: "summary_text", text: reasoningText }] },
    });
  };
  const openMessage = () => {
    if (messageId) return;
    messageId = `msg_${hex()}`;
    outputIndexes.message = nextIndex++;
    sse("response.output_item.added", {
      output_index: outputIndexes.message,
      item: { type: "message", id: messageId, status: "in_progress", role: "assistant", content: [] },
    });
  };
  const closeMessage = () => {
    if (!messageId || messageClosed) return;
    messageClosed = true;
    const idx = outputIndexes.message;
    sse("response.output_text.done", { item_id: messageId, output_index: idx, content_index: 0, text: messageText });
    sse("response.output_item.done", {
      output_index: idx,
      item: {
        type: "message", id: messageId, status: "completed", role: "assistant",
        content: [{ type: "output_text", text: messageText, annotations: [] }],
      },
    });
  };

  let buf = "";
  let rawLogged = false;
  // `upstream.body` yields Uint8Array, whose toString() gives comma-joined byte values —
  // TextDecoder is both correct and multi-byte safe across chunk boundaries.
  const decoder = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      if (process.env.MIMO_DEBUG_STREAM && !rawLogged) {
        rawLogged = true;
        log(`[responses-debug] first chunk len=${chunk.length} raw=${JSON.stringify(buf.slice(0, 220))}`);
      }
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (process.env.MIMO_DEBUG_STREAM && debugCount < 6) {
          debugCount++;
          log(`[responses-debug] chunk ${debugCount}: ${data.slice(0, 260)}`);
        }
        if (ev.usage) usage = ev.usage;
        const ch = ev.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta;
        if (!d) continue;

        if (typeof d.reasoning_content === "string" && d.reasoning_content) {
          openReasoning();
          reasoningText += d.reasoning_content;
          sse("response.reasoning_summary_text.delta", {
            item_id: reasoningId, output_index: outputIndexes.reasoning, summary_index: 0, delta: d.reasoning_content,
          });
        }
        if (typeof d.content === "string" && d.content) {
          closeReasoning();
          openMessage();
          messageText += d.content;
          sse("response.output_text.delta", {
            item_id: messageId, output_index: outputIndexes.message, content_index: 0, delta: d.content,
          });
        }
        for (const tc of d.tool_calls || []) {
          const key = tc.index ?? 0;
          if (!toolCalls.has(key)) {
            closeReasoning();
            closeMessage();
            const itemId = `fc_${hex()}`;
            const entry = {
              itemId,
              callId: tc.id || `call_${hex()}`,
              name: tc.function?.name || "",
              args: "",
              outputIndex: nextIndex++,
            };
            toolCalls.set(key, entry);
            sse("response.output_item.added", {
              output_index: entry.outputIndex,
              item: { type: "function_call", id: itemId, call_id: entry.callId, name: entry.name, arguments: "", status: "in_progress" },
            });
          }
          const entry = toolCalls.get(key);
          if (tc.id) entry.callId = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) {
            entry.args += tc.function.arguments;
            sse("response.function_call_arguments.delta", {
              item_id: entry.itemId, output_index: entry.outputIndex, delta: tc.function.arguments,
            });
          }
        }
      }
    }
  } catch (err) {
    log(`responses stream aborted: ${err.message}`);
  }

  closeReasoning();
  closeMessage();
  for (const entry of toolCalls.values()) {
    sse("response.function_call_arguments.done", { item_id: entry.itemId, output_index: entry.outputIndex, arguments: entry.args });
    sse("response.output_item.done", {
      output_index: entry.outputIndex,
      item: {
        type: "function_call", id: entry.itemId, call_id: entry.callId,
        name: entry.name, arguments: entry.args, status: "completed",
      },
    });
  }

  const output = [];
  if (reasoningId) output.push({ type: "reasoning", id: reasoningId, summary: [{ type: "summary_text", text: reasoningText }] });
  if (messageId) {
    output.push({
      type: "message", id: messageId, status: "completed", role: "assistant",
      content: [{ type: "output_text", text: messageText, annotations: [] }],
    });
  }
  for (const entry of toolCalls.values()) {
    output.push({
      type: "function_call", id: entry.itemId, call_id: entry.callId,
      name: entry.name, arguments: entry.args, status: "completed",
    });
  }

  const u = usage || {};
  const done = {
    ...shell(finish === "length" ? "incomplete" : "completed", output, {
      incomplete_details: finish === "length" ? { reason: "max_output_tokens" } : null,
      usage: {
        input_tokens: u.prompt_tokens ?? 0,
        input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
        output_tokens: u.completion_tokens ?? 0,
        output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
        total_tokens: u.total_tokens ?? 0,
      },
    }),
    output_text: messageText,
  };
  sse("response.completed", { response: done });
  res.write("data: [DONE]\n\n");
  res.end();
  return done;
}

async function handleResponses(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return badJson(res, req, raw, "responses");
  }
  const requested = typeof body.model === "string" && body.model ? body.model : "mimo-auto";
  const chatBody = responsesToChat(body, resolveModel(requested));
  const started = Date.now();

  let upstream;
  try {
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        "X-Mimo-Source": CFG.source,
      },
      body: JSON.stringify(body.stream ? { ...chatBody, stream_options: { include_usage: true } } : chatBody),
    };
    upstream = await callUpstream(CFG.chatPath, init);
    // Not every compatible upstream accepts stream_options — retry once without it.
    if (upstream.status === 400 && body.stream) {
      await upstream.text().catch(() => {});
      upstream = await callUpstream(CFG.chatPath, { ...init, body: JSON.stringify(chatBody) });
    }
  } catch (err) {
    log(`responses upstream error: ${err.message}`);
    return send(res, 502, { error: { message: `upstream request failed: ${err.message}`, type: "upstream_error" } });
  }

  if (upstream.status >= 400) {
    const text = await upstream.text();
    log(`responses ${requested} -> upstream ${upstream.status}: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
    const hint =
      upstream.status === 401 || upstream.status === 403 ? " (login cookie stale — run refresh-cookies.cmd)" : "";
    return send(res, upstream.status, {
      error: { message: `upstream ${upstream.status}${hint}: ${text.slice(0, 500)}`, type: "upstream_error" },
    });
  }

  if (!body.stream) {
    let cc;
    try {
      cc = await upstream.json();
    } catch (err) {
      return send(res, 502, { error: { message: `upstream returned non-JSON: ${err.message}`, type: "upstream_error" } });
    }
    if (cc.error) return send(res, 502, { error: cc.error });
    log(`responses(non-stream) model=${requested} ${Date.now() - started}ms`);
    return send(res, 200, chatToResponse(cc, requested));
  }

  if (process.env.MIMO_DEBUG_STREAM) {
    log(
      `[responses-debug] status=${upstream.status} ctype=${upstream.headers.get("content-type")} ` +
        `sent=${JSON.stringify(chatBody).slice(0, 300)}`
    );
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const done = await streamResponses(upstream, res, requested);
  log(
    `responses(stream) model=${requested} out=${done.output_text.length}c reasoning=${done.usage.output_tokens_details.reasoning_tokens}tok ${Date.now() - started}ms`
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  try {
    if (p === "/health" || p === "/v1/health") {
      loadCookies(true);
      const login = await probeLogin();
      return send(res, login.logged_in ? 200 : 503, {
        ok: login.logged_in,
        upstream: CFG.base,
        cookies: { ...cookieMeta, loaded: cookies.length },
        login,
      });
    }
    if (p === "/v1/models" || p === "/models") {
      loadCookies();
      return send(
        res,
        200,
        {
          object: "list",
          data: MODELS.map((id) => ({
            id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "xiaomi-mimo-desktop-proxy",
          })),
        },
        { "Cache-Control": "no-store" }
      );
    }
    if (p === "/v1/chat/completions" || p === "/chat/completions") {
      if (req.method !== "POST") return send(res, 405, { error: { message: "POST only" } });
      return await handleChat(req, res);
    }
    if (p === "/v1/responses" || p === "/responses") {
      if (req.method !== "POST") return send(res, 405, { error: { message: "POST only" } });
      return await handleResponses(req, res);
    }
    return send(res, 404, { error: { message: `no such route: ${p}`, type: "invalid_request_error" } });
  } catch (err) {
    log(`handler error: ${err.stack || err}`);
    if (!res.headersSent) send(res, 500, { error: { message: String(err.message || err), type: "proxy_error" } });
    else res.end();
  }
});

server.listen(CFG.port, CFG.host, () => {
  loadCookies(true);
  log(`mimo-desktop-proxy listening on http://${CFG.host}:${CFG.port}/v1`);
  log(`upstream ${CFG.base} | cookies ${cookies.length} from ${CFG.cookiesFile}`);
  if (!cookieHeader) log("WARNING: no cookies loaded — run refresh-cookies.cmd");
});
