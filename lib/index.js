// src/cookies.ts
function readCookieExpiry(raw) {
  if (!raw || typeof raw !== "object") return { session: true };
  if (raw.session === true) return { session: true };
  const seconds = Number(raw.expires ?? raw.expirationDate);
  if (!Number.isFinite(seconds) || seconds <= 0) return { session: true };
  return { session: false, expiresAt: Math.round(seconds * 1e3) };
}
function pickCookieMeta(cookies, filter) {
  const out = [];
  for (const raw of cookies ?? []) {
    const name2 = typeof raw?.name === "string" ? raw.name : "";
    if (!name2) continue;
    const domain = String(raw?.domain ?? "");
    if (!filter(domain)) continue;
    const { session, expiresAt } = readCookieExpiry(raw);
    out.push({ name: name2, domain, session, ...expiresAt !== void 0 ? { expiresAt } : {} });
  }
  return out;
}
function normalizeCookieMetaList(raw) {
  if (!Array.isArray(raw)) return void 0;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name2 = typeof item.name === "string" ? item.name : "";
    if (!name2) continue;
    const expiresRaw = Number(item.expiresAt);
    const hasExpiry = Number.isFinite(expiresRaw) && expiresRaw > 0;
    const session = item.session === true || !hasExpiry;
    out.push({
      name: name2,
      domain: typeof item.domain === "string" ? item.domain : "",
      session,
      ...session ? {} : { expiresAt: Math.round(expiresRaw) }
    });
  }
  return out.length > 0 ? out : void 0;
}
function summarizeCookieLife(metas, now = Date.now()) {
  const list = metas ?? [];
  if (list.length === 0) return void 0;
  const persistent = list.filter((item) => !item.session && Number.isFinite(item.expiresAt));
  let latest;
  for (const item of persistent) {
    const expiresAt = item.expiresAt;
    if (!latest || expiresAt > latest.expiresAt) {
      latest = { name: item.name, expiresAt, daysLeft: (expiresAt - now) / 864e5 };
    }
  }
  return {
    total: list.length,
    sessionCount: list.length - persistent.length,
    persistentCount: persistent.length,
    ...latest ? { latest } : {}
  };
}

// src/accounts.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join as join2 } from "node:path";
import { randomUUID } from "node:crypto";

// src/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}
function webLoginDir() {
  return join(resolveDshHome(), "web-login");
}
function legacyAuthFilePath() {
  return join(webLoginDir(), "deepseek-auth.json");
}

// src/accounts.ts
var INDEX_VERSION = 1;
function identifierKindOf(user) {
  const text = (v) => typeof v === "string" ? v.trim() : "";
  if (text(user?.email)) return "email";
  if (text(user?.mobile_number) || text(user?.mobile)) return "mobile";
  const display = text(user?.display);
  if (!display) return "unknown";
  if (display.includes("@")) return "email";
  const digits = display.replace(/[^0-9]/g, "");
  const masked = display.includes("*");
  if (digits.length >= 5 && (masked || digits.length >= 7)) return "mobile";
  return "unknown";
}
function accountsDir() {
  return join2(webLoginDir(), "accounts");
}
function accountsIndexPath() {
  return join2(webLoginDir(), "accounts.json");
}
var MAX_IMPORT_ACCOUNTS = 500;
function assertSafeAccountId(id) {
  const text = String(id ?? "");
  if (!text || text.includes("\0") || text === "." || text === ".." || /[/\\]/.test(text)) {
    throw new Error(`\u8D26\u53F7 id \u4E0D\u5408\u6CD5\uFF08\u542B\u8DEF\u5F84\u5206\u9694\u7B26\u6216\u76F8\u5BF9\u8DEF\u5F84\u6BB5\uFF09\uFF1A${JSON.stringify(text)}`);
  }
  return text;
}
function accountFilePath(id) {
  return join2(accountsDir(), `${assertSafeAccountId(id)}.json`);
}
function newAccountId() {
  return `acc_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
function writeJsonAtomic(file, value) {
  mkdirSync(join2(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 384 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    throw error;
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(file, 384);
    } catch {
    }
  }
}
function readJson(file) {
  try {
    if (!existsSync(file)) return void 0;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return void 0;
  }
}
function readIndex() {
  const parsed = readJson(accountsIndexPath());
  return {
    version: INDEX_VERSION,
    ...typeof parsed?.activeId === "string" && parsed.activeId ? { activeId: parsed.activeId } : {}
  };
}
function writeIndex(index) {
  writeJsonAtomic(accountsIndexPath(), { version: INDEX_VERSION, ...index.activeId ? { activeId: index.activeId } : {} });
}
function migrateFailMarkers(raw) {
  const marker = (value) => value && typeof value.at === "string" ? { at: value.at, message: String(value.message ?? "") } : void 0;
  const verify = marker(raw?.lastVerifyError);
  const check = marker(raw?.lastCheckError);
  const verifyIsAuth = verify ? isAuthFailureMessage(verify.message) : false;
  const out = {};
  if (verify && verifyIsAuth) out.lastVerifyError = verify;
  if (check) out.lastCheckError = check;
  else if (verify && !verifyIsAuth) out.lastCheckError = verify;
  return out;
}
function normalizeRecord(raw, fallbackId) {
  if (!raw || typeof raw !== "object") return void 0;
  const token = typeof raw.token === "string" ? raw.token : "";
  if (!token) return void 0;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : fallbackId ?? newAccountId(),
    token,
    cookie: typeof raw.cookie === "string" ? raw.cookie : "",
    hifDliq: typeof raw.hifDliq === "string" ? raw.hifDliq : "",
    hifLeim: typeof raw.hifLeim === "string" ? raw.hifLeim : "",
    wasmUrl: typeof raw.wasmUrl === "string" ? raw.wasmUrl : "",
    userAgent: typeof raw.userAgent === "string" ? raw.userAgent : "",
    ...raw.extraHeaders && typeof raw.extraHeaders === "object" ? { extraHeaders: raw.extraHeaders } : {},
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : "",
    ...raw.unverified === true ? { unverified: true } : {},
    ...raw.user && typeof raw.user === "object" ? { user: raw.user } : {},
    // cookie 过期构成：形状不对的条目在 cookies.ts 里被丢掉，不会让整条记录读不出来
    ...(() => {
      const meta = normalizeCookieMetaList(raw.cookieMeta);
      return meta ? { cookieMeta: meta } : {};
    })(),
    ...typeof raw.label === "string" && raw.label ? { label: raw.label } : {},
    ...typeof raw.groupId === "string" && raw.groupId ? { groupId: raw.groupId } : {},
    ...typeof raw.serverId === "string" && raw.serverId ? { serverId: raw.serverId } : {},
    ...typeof raw.lastVerifiedAt === "string" ? { lastVerifiedAt: raw.lastVerifiedAt } : {},
    // 两个失败标记：授权类留在 lastVerifyError，非授权类迁到 lastCheckError（见上面的迁移说明）
    ...migrateFailMarkers(raw),
    ...raw.limit && Number.isFinite(raw.limit?.untilMs) ? { limit: { untilMs: Number(raw.limit.untilMs), observedAt: String(raw.limit.observedAt ?? "") } } : {}
  };
}
function listAccounts() {
  let names = [];
  try {
    names = readdirSync(accountsDir()).filter((name2) => name2.endsWith(".json") && !name2.includes(".tmp-"));
  } catch {
    return [];
  }
  const records = [];
  for (const name2 of names) {
    const id = name2.replace(/\.json$/, "");
    let record;
    try {
      record = normalizeRecord(readJson(accountFilePath(id)), id);
    } catch {
      continue;
    }
    if (record) records.push(record);
  }
  records.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
  return records;
}
function readAccount(id) {
  if (!id) return void 0;
  return normalizeRecord(readJson(accountFilePath(id)), id);
}
function saveAccount(record) {
  writeJsonAtomic(accountFilePath(record.id), record);
}
function activeAccountId() {
  const { activeId } = readIndex();
  if (!activeId) return void 0;
  try {
    return existsSync(accountFilePath(activeId)) ? activeId : void 0;
  } catch {
    return void 0;
  }
}
function activeAccount() {
  const id = activeAccountId();
  return id ? readAccount(id) : void 0;
}
function setActiveAccount(id) {
  if (!existsSync(accountFilePath(id))) return false;
  writeIndex({ activeId: id });
  return true;
}
function clearActiveAccount() {
  writeIndex({});
}
function updateAccount(id, patch) {
  const current = readAccount(id);
  if (!current) return void 0;
  const next = normalizeRecord({ ...current, ...patch, id }, id);
  if (!next) return void 0;
  saveAccount(next);
  return next;
}
function removeAccount(id) {
  const file = accountFilePath(id);
  if (!existsSync(file)) return false;
  try {
    rmSync(file, { force: true });
  } catch {
    return false;
  }
  if (readIndex().activeId === id) clearActiveAccount();
  return true;
}
function upsertAccount(auth, patch = {}) {
  const incoming = auth;
  const serverId = patch.serverId ?? incoming.serverId;
  const all = listAccounts();
  const existing = (patch.id ? all.find((item) => item.id === patch.id) : void 0) ?? (serverId ? all.find((item) => item.serverId && item.serverId === serverId) : void 0) ?? // 兼容旧记录（审计 F04）：`serverId` 是后加的字段，老库里可能只存了 `user.id`。
  // 只认**没有 serverId** 的记录，免得跟上面那条抢匹配（那条才是权威身份键）。
  (serverId ? all.find((item) => !item.serverId && item.user?.id === serverId) : void 0) ?? all.find((item) => item.token === auth.token);
  const id = patch.id ?? existing?.id ?? newAccountId();
  const carried = {};
  for (const key of [
    "label",
    "groupId",
    "serverId",
    "lastVerifiedAt",
    "lastVerifyError",
    "lastCheckError",
    "limit"
  ]) {
    const value = patch[key] ?? incoming[key] ?? existing?.[key];
    if (value !== void 0) carried[key] = value;
  }
  const userFromPatch = patch?.user;
  const userFromIncoming = incoming?.user;
  const mergedUser = {
    ...existing?.user ?? {},
    ...userFromIncoming && typeof userFromIncoming === "object" ? userFromIncoming : {},
    ...userFromPatch && typeof userFromPatch === "object" ? userFromPatch : {}
  };
  if (Object.keys(mergedUser).length > 0) carried.user = mergedUser;
  const record = normalizeRecord({ ...auth, ...carried, id }, id);
  saveAccount(record);
  return record;
}
function exportAccounts() {
  return {
    version: INDEX_VERSION,
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    warning: "\u6B64\u6587\u4EF6\u542B\u53EF\u5B8C\u6574\u767B\u5F55\u7684\u51ED\u8BC1\uFF08token + cookie\uFF09\uFF0C\u7B49\u540C\u4E8E\u8D26\u53F7\u672C\u8EAB\uFF0C\u8BF7\u52FF\u5206\u4EAB\u6216\u63D0\u4EA4\u5230\u4ED3\u5E93",
    accounts: listAccounts()
  };
}
function exportAccountsToFile() {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const file = join2(webLoginDir(), "exports", `accounts-${stamp}.json`);
  writeJsonAtomic(file, exportAccounts());
  return { path: file, count: listAccounts().length };
}
function importAccounts(payload) {
  const list = Array.isArray(payload) ? payload : payload?.accounts;
  if (!Array.isArray(list)) return { imported: 0, updated: 0, skipped: 0 };
  if (list.length > MAX_IMPORT_ACCOUNTS) throw new RangeError(`\u6BCF\u6279\u6700\u591A\u5BFC\u5165 ${MAX_IMPORT_ACCOUNTS} \u4E2A\u8D26\u53F7`);
  const records = listAccounts();
  const ids = new Set(records.map((r) => r.id));
  const tokens = new Map(records.map((r) => [r.token, r]));
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of list) {
    const candidate = normalizeRecord(raw);
    if (!candidate) {
      skipped += 1;
      continue;
    }
    const matched = tokens.get(candidate.token);
    let record;
    if (matched) {
      record = { ...matched, ...candidate, id: matched.id, label: candidate.label ?? matched.label };
      updated += 1;
    } else {
      let id;
      do {
        id = newAccountId();
      } while (ids.has(id));
      ids.add(id);
      record = { ...candidate, id };
      imported += 1;
    }
    saveAccount(record);
    tokens.set(record.token, record);
  }
  if (!activeAccountId()) {
    const first = listAccounts()[0];
    if (first) setActiveAccount(first.id);
  }
  return { imported, updated, skipped };
}
var lastMigrationError;
function legacyMigrationError() {
  return lastMigrationError;
}
function migrateLegacyAuth() {
  const legacy = legacyAuthFilePath();
  const record = normalizeRecord(readJson(legacy));
  if (!record) return void 0;
  const existing = listAccounts().find((item) => item.token === record.token);
  const saved = existing ?? { ...record, id: newAccountId() };
  if (!existing) saveAccount(saved);
  const verified = readAccount(saved.id);
  if (!verified || verified.token !== record.token) {
    throw new Error("\u8FC1\u79FB\u5199\u5165\u9A8C\u8BC1\u5931\u8D25\uFF1A\u8D26\u53F7\u5E93\u91CC\u7684\u8BB0\u5F55\u4E0E\u65E7\u51ED\u8BC1\u4E0D\u4E00\u81F4");
  }
  rmSync(legacy);
  lastMigrationError = void 0;
  if (!activeAccountId()) setActiveAccount(saved.id);
  return saved;
}
function migrateLegacyAuthIfNeeded() {
  try {
    if (listAccounts().length > 0) return void 0;
    if (!existsSync(legacyAuthFilePath())) return void 0;
    return migrateLegacyAuth();
  } catch (error) {
    lastMigrationError = `\u65E7\u51ED\u8BC1\u672A\u6E05\u9664\uFF0C\u8FC1\u79FB\u672A\u5B8C\u6574\u5B8C\u6210\uFF1A${error?.message ?? error}`;
    return void 0;
  }
}
function accountTitle(record, mask) {
  if (record.label) return record.label;
  const display = record.user?.display || record.user?.id || "";
  if (!display) return `\u672A\u8BC6\u522B\u8D26\u53F7\uFF08${record.id.replace(/^acc_/, "").slice(0, 8)}\uFF09`;
  return mask(display);
}
function accountsFootprint() {
  let bytes = 0;
  let count = 0;
  try {
    for (const name2 of readdirSync(accountsDir())) {
      if (!name2.endsWith(".json") || name2.includes(".tmp-")) continue;
      count += 1;
      try {
        bytes += statSync(join2(accountsDir(), name2)).size;
      } catch {
      }
    }
  } catch {
  }
  return { count, bytes };
}

// src/auth.ts
function captureDefect(auth) {
  if (!String(auth.token ?? "").trim()) return void 0;
  const hasCookie = !!String(auth.cookie ?? "").trim();
  const headers = auth.extraHeaders ?? {};
  const hasHeaders = Object.keys(headers).length > 0;
  if (!hasCookie && !hasHeaders) {
    return "\u672C\u6B21\u6355\u83B7\u53EA\u62FF\u5230 token\uFF08cookie \u4E0E\u8BF7\u6C42\u5934\u90FD\u4E3A\u7A7A\uFF09\u2014\u2014 \u82E5\u4E4B\u540E\u51FA\u73B0\u56FE\u7247\u5F15\u7528\u88AB\u62D2\uFF08code 9\uFF09\u4E4B\u7C7B\u7684\u5F02\u5E38\uFF0C\u4F18\u5148\u6000\u7591\u8FD9\u4EFD\u51ED\u8BC1";
  }
  if (hasHeaders && !String(headers["x-device-id"] ?? "").trim()) {
    return '\u672C\u6B21\u6355\u83B7\u7684\u8BF7\u6C42\u5934\u91CC\u6CA1\u6709 x-device-id\uFF08\u6570\u7F8E\u8BBE\u5907\u6307\u7EB9\uFF09\u2014\u2014 \u4E0A\u6E38\u5BF9"\u7F3A\u5C11\u6D4F\u89C8\u5668\u8BBE\u5907\u6307\u7EB9"\u4F1A\u76F4\u63A5\u5224 RISK_DEVICE_DETECTED\uFF08biz_code=11\uFF09\uFF0C\u5EFA\u8BAE\u91CD\u65B0\u767B\u5F55\u4E00\u6B21\u628A\u8FD9\u4EFD\u51ED\u8BC1\u8865\u5168';
  }
  return void 0;
}
function readAuth() {
  return activeAccount();
}
function writeAuth(auth) {
  const record = upsertAccount(auth);
  setActiveAccount(record.id);
}
function withVerifiedIdentity(auth, user) {
  const display = typeof user?.display === "string" && user.display ? user.display : void 0;
  const serverId = typeof user?.id === "string" && user.id ? user.id : void 0;
  return {
    ...auth,
    unverified: void 0,
    ...display || serverId ? { user: { ...auth.user, ...display ? { display } : {}, ...serverId ? { id: serverId } : {} } } : {},
    ...serverId ? { serverId } : {}
  };
}
function refreshVerifiedIdentity(id, token, user) {
  const record = readAccount(id);
  if (!record || record.token !== token) return false;
  const display = typeof user?.display === "string" && user.display ? user.display : void 0;
  const serverId = typeof user?.id === "string" && user.id ? user.id : void 0;
  updateAccount(id, {
    ...display || serverId ? { user: { ...record.user, ...display ? { display } : {}, ...serverId ? { id: serverId } : {} } } : {},
    ...serverId ? { serverId } : {},
    unverified: void 0,
    lastVerifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
    lastVerifyError: void 0
  });
  return true;
}
function clearAuth() {
  const active = activeAccount();
  if (active) removeAccount(active.id);
  clearActiveAccount();
}
function hasUsableAuth(auth) {
  return !!auth && typeof auth.token === "string" && auth.token.length > 8;
}
function isAuthFailureMessage(message) {
  const text = String(message ?? "");
  if (!text) return false;
  if (/authorization failed|invalid token|unauthori[sz]ed/i.test(text)) return true;
  if (/授权失败/.test(text)) return true;
  if (/登录(态|状态)?[^。；;]{0,8}(过期|失效|无效)/.test(text)) return true;
  return /HTTP\s*40[13]\b/i.test(text);
}
function describeError(error) {
  const parts = [];
  const seen = /* @__PURE__ */ new Set();
  let current = error;
  for (let depth = 0; depth < 4 && current !== void 0 && current !== null; depth += 1) {
    const message = typeof current === "object" && typeof current.message === "string" ? current.message : String(current);
    const code = typeof current === "object" && typeof current.code === "string" ? String(current.code) : "";
    const text = [message, code && !message.includes(code) ? code : ""].filter(Boolean).join(" ");
    if (text && !seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
    current = typeof current === "object" ? current.cause : void 0;
  }
  return parts.join(" \u2190 ") || "\u672A\u77E5\u9519\u8BEF";
}
function staleAuthRecord(record) {
  const failure = record?.lastVerifyError;
  if (!failure) return void 0;
  if (!(String(failure.at ?? "") > String(record?.lastVerifiedAt ?? ""))) return void 0;
  if (!isAuthFailureMessage(failure.message)) return void 0;
  const message = String(failure.message ?? "").trim();
  return message || "\u767B\u5F55\u6001\u5DF2\u5931\u6548";
}
function unwrapStoredToken(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed?.value === "string" ? parsed.value.trim() : "";
    } catch {
      return "";
    }
  }
  return text === "null" || text === "undefined" ? "" : text;
}
function maskIdentifier(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.includes("***")) return value;
  const at = value.indexOf("@");
  if (at > 0) {
    const local = value.slice(0, at);
    const keep = Math.min(3, Math.max(1, local.length - 1));
    return `${local.slice(0, keep)}***${value.slice(at)}`;
  }
  if (/^\d{6,}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`;
  if (value.length <= 4) return `${value[0]}***`;
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}
var AdapterLlmError = class extends Error {
  failure;
  code;
  /**
   * 账号级限制的**解除时间**（毫秒时间戳），仅在 `user is muted` 时有值。
   *
   * 为什么要单独带一个字段：`providerRetryAfterMs` 是相对值（给重试策略用的），
   * 而"记下这个账号被限到什么时候"需要绝对值。让调用方去解析错误文案里的时间是不可靠的。
   */
  mutedUntilMs;
  constructor(message, code, options = {}) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    if (options.mutedUntilMs !== void 0) this.mutedUntilMs = options.mutedUntilMs;
    this.failure = {
      message,
      code,
      ...options.status !== void 0 ? { status: options.status } : {},
      ...options.providerRetryAfterMs !== void 0 ? { providerRetryAfterMs: options.providerRetryAfterMs } : {}
    };
    if (options.cause !== void 0) this.cause = options.cause;
  }
};
function httpErrorCode(status) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 402) return "QUOTA";
  if (status >= 500) return "SERVER";
  return "PROVIDER_ERROR";
}
function parseRetryAfterMs(raw) {
  if (!raw) return void 0;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Math.max(1e3, Number(text) * 1e3);
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return Math.max(1e3, parsed - Date.now());
  return void 0;
}

// src/index.ts
import { createRequire as createRequire3 } from "node:module";
import { readFileSync as readFileSync15, statSync as statSync6 } from "node:fs";

// src/adapter.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync7, statSync as statSync3 } from "node:fs";
import { createHash } from "node:crypto";
import { join as joinPath } from "node:path";

// src/webapi.ts
import { appendFileSync, mkdirSync as mkdirSync6, readFileSync as readFileSync6, renameSync as renameSync2, statSync as statSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join7 } from "node:path";

// src/gate.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
var DEFAULT_MIN_REQUEST_INTERVAL_MS = 2e3;
var DEFAULT_MAX_REQUEST_INTERVAL_MS = 4e3;
var DEFAULT_LONG_RUN_THRESHOLD = 15;
var DEFAULT_LEASE_WATCHDOG_MS = 15 * 6e4;
var DEFAULT_LONG_RUN_BREAK_MS = { min: 6e4, max: 18e4 };
var LONG_RUN_BREAK_BOUNDS_MS = { min: 3e4, max: 6e5 };
var LONG_RUN_THRESHOLD_BOUNDS = { min: 0, max: 100 };
var MAX_PROMPT_CHARS_BOUNDS = { min: 12e4, max: 15e5 };
var DEFAULT_MAX_PROMPT_CHARS = 4e5;
function clampMaxPromptChars(value) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_PROMPT_CHARS;
  return Math.max(MAX_PROMPT_CHARS_BOUNDS.min, Math.min(MAX_PROMPT_CHARS_BOUNDS.max, Math.round(value)));
}
var MAX_REF_IMAGES_BOUNDS = { min: 0, max: 100 };
var DEFAULT_MAX_REF_IMAGES = 24;
function clampMaxRefImages(value) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_REF_IMAGES;
  return Math.max(MAX_REF_IMAGES_BOUNDS.min, Math.min(MAX_REF_IMAGES_BOUNDS.max, Math.round(value)));
}
var CONTEXT_WINDOW_BOUNDS = { min: 32768, max: 1048576 };
var DEFAULT_CONTEXT_WINDOW = 1048576;
var CONTEXT_WINDOW_OPTIONS = [32768, 65536, 131072, 262144, 524288, 1048576];
function clampContextWindow(value) {
  if (!Number.isFinite(value)) return DEFAULT_CONTEXT_WINDOW;
  return Math.max(CONTEXT_WINDOW_BOUNDS.min, Math.min(CONTEXT_WINDOW_BOUNDS.max, Math.round(value)));
}
var AUTO_SWITCH_BOUNDS = { min: 0, max: 120 };
var DEFAULT_AUTO_SWITCH_MINUTES = 0;
function clampAutoSwitchMinutes(value) {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_SWITCH_MINUTES;
  return Math.max(AUTO_SWITCH_BOUNDS.min, Math.min(AUTO_SWITCH_BOUNDS.max, Math.round(value)));
}
var LONG_RUN_IDLE_RESET_MS = 12e4;
var INTERVAL_PRESETS = [
  [1500, 2500],
  [2e3, 4e3],
  [5e3, 9e3]
];
var MAX_INTERVAL_MS = 3e4;
var DEFAULT_CLEANUP_BATCH = { min: 6, max: 10 };
var DEFAULT_CLEANUP_DELAY_MS = { min: 6e4, max: 12e4 };
var DEFAULT_CLEANUP_GAP_MS = { min: 800, max: 2500 };
var CLEANUP_BATCH_BOUNDS = { min: 1, max: 50 };
var CLEANUP_DELAY_BOUNDS_MS = { min: 5e3, max: 6e5 };
var CLEANUP_GAP_BOUNDS_MS = { min: 0, max: 6e4 };
function normalizeCleanupRange(value, bounds) {
  if (!value || typeof value !== "object") return void 0;
  const raw = value;
  const lo = Number(raw.min);
  const hi = Number(raw.max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return void 0;
  const clamp = (n) => Math.min(bounds.max, Math.max(bounds.min, Math.floor(n)));
  return { min: clamp(Math.min(lo, hi)), max: clamp(Math.max(lo, hi)) };
}
function gateSettingsPath() {
  const home = process.env.DSH_HOME || join3(homedir2(), ".dsh");
  return join3(home, "web-login", "gate.json");
}
function readGateSettings() {
  try {
    const file = gateSettingsPath();
    if (!existsSync2(file)) return void 0;
    const parsed = JSON.parse(readFileSync2(file, "utf8"));
    const out = {};
    if (typeof parsed?.allowConcurrent === "boolean") out.allowConcurrent = parsed.allowConcurrent;
    if (Number.isFinite(parsed?.minRequestIntervalMs)) {
      out.minRequestIntervalMs = clampInterval(Number(parsed.minRequestIntervalMs));
    }
    if (Number.isFinite(parsed?.maxRequestIntervalMs)) {
      out.maxRequestIntervalMs = clampInterval(Number(parsed.maxRequestIntervalMs));
    }
    if (out.minRequestIntervalMs !== void 0 && out.maxRequestIntervalMs === void 0) {
      out.maxRequestIntervalMs = out.minRequestIntervalMs;
    }
    const cleanup2 = parsed?.sessionCleanup;
    if (cleanup2 === "immediate" || cleanup2 === "deferred" || cleanup2 === "keep") {
      out.sessionCleanup = cleanup2;
    }
    const batch = normalizeCleanupRange(parsed?.cleanupBatch, CLEANUP_BATCH_BOUNDS);
    if (batch) out.cleanupBatch = batch;
    const delay = normalizeCleanupRange(parsed?.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS);
    if (delay) out.cleanupDelayMs = delay;
    const gap = normalizeCleanupRange(parsed?.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS);
    if (gap) out.cleanupGapMs = gap;
    if (Number.isFinite(parsed?.longRunThreshold)) {
      const n = Math.round(Number(parsed.longRunThreshold));
      out.longRunThreshold = Math.max(
        LONG_RUN_THRESHOLD_BOUNDS.min,
        Math.min(LONG_RUN_THRESHOLD_BOUNDS.max, n)
      );
    }
    const lrb = normalizeCleanupRange(parsed?.longRunBreakMs, LONG_RUN_BREAK_BOUNDS_MS);
    if (lrb) out.longRunBreakMs = lrb;
    if (Number.isFinite(parsed?.maxPromptChars)) {
      out.maxPromptChars = clampMaxPromptChars(Number(parsed.maxPromptChars));
    }
    if (Number.isFinite(parsed?.maxRefImages)) {
      out.maxRefImages = clampMaxRefImages(Number(parsed.maxRefImages));
    }
    if (Number.isFinite(parsed?.contextWindow)) {
      out.contextWindow = clampContextWindow(Number(parsed.contextWindow));
    }
    if (Number.isFinite(parsed?.autoSwitchMinutes)) {
      out.autoSwitchMinutes = clampAutoSwitchMinutes(Number(parsed.autoSwitchMinutes));
    }
    if (typeof parsed?.serialToolCalls === "boolean") out.serialToolCalls = parsed.serialToolCalls;
    if (typeof parsed?.autoRelogin === "boolean") out.autoRelogin = parsed.autoRelogin;
    if (typeof parsed?.freshSessionOnRestart === "boolean") {
      out.freshSessionOnRestart = parsed.freshSessionOnRestart;
    }
    return Object.keys(out).length > 0 ? out : void 0;
  } catch {
    return void 0;
  }
}
function writeGateSettings(settings) {
  const file = gateSettingsPath();
  mkdirSync2(join3(file, ".."), { recursive: true });
  writeFileSync2(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
function clampInterval(value) {
  if (!Number.isFinite(value)) return DEFAULT_MIN_REQUEST_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(0, Math.floor(value)));
}
function createRequestGate(options = {}) {
  let allowConcurrent = options.allowConcurrent === true;
  let longRunThreshold = options.longRunThreshold ?? DEFAULT_LONG_RUN_THRESHOLD;
  let longRunBreakMs = options.longRunBreakMs;
  let consecutive = 0;
  let minIntervalMs = clampInterval(
    options.minIntervalMs ?? (options.maxIntervalMs !== void 0 ? options.maxIntervalMs : DEFAULT_MIN_REQUEST_INTERVAL_MS)
  );
  let maxIntervalMs = clampInterval(
    options.maxIntervalMs ?? (options.minIntervalMs !== void 0 ? options.minIntervalMs : DEFAULT_MAX_REQUEST_INTERVAL_MS)
  );
  if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());
  const leaseWatchdogMs = options.leaseWatchdogMs ?? DEFAULT_LEASE_WATCHDOG_MS;
  let leasedAt = 0;
  let activeRelease;
  const sleep2 = options.sleep ?? ((ms) => {
    let timer;
    const promise = new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    promise.timer = timer;
    return promise;
  });
  const logger = options.logger;
  let tail = Promise.resolve();
  let running = 0;
  let waiting = 0;
  let lastFinishedAt = 0;
  let hasFinished = false;
  async function acquire(label = "call", signal) {
    let releaseMine;
    const mine = new Promise((resolve) => {
      releaseMine = resolve;
    });
    const prev = tail;
    tail = prev.then(() => mine);
    const aborted = () => {
      const error = new Error(`\u300C${label}\u300D\u5728\u95F8\u95E8\u7B49\u5F85\u4E2D\u88AB\u53D6\u6D88`);
      error.name = "AbortError";
      return error;
    };
    const waitOrAbort = (inner) => {
      const clearInnerTimer = () => {
        const timer = inner?.timer;
        if (timer) clearTimeout(timer);
      };
      if (!signal) return inner.then(() => void 0);
      if (signal.aborted) {
        clearInnerTimer();
        return Promise.reject(aborted());
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          clearInnerTimer();
          reject(aborted());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        inner.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            clearInnerTimer();
            resolve();
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          }
        );
      });
    };
    if (!allowConcurrent && running > 0 && activeRelease && now() - leasedAt > leaseWatchdogMs) {
      const heldMin = Math.round((now() - leasedAt) / 6e4);
      logger?.warn?.(
        `deepseek-web: \u95F8\u95E8\u8BB8\u53EF\u5DF2\u6301\u6709 ${heldMin} \u5206\u949F\u672A\u91CA\u653E \u2014\u2014 \u901A\u5E38\u662F\u5BBF\u4E3B\u4E22\u5F03\u4E86\u8FDB\u884C\u4E2D\u7684\u6D41\u3002\u5F3A\u5236\u91CA\u653E\uFF0C\u4EE5\u514D\u540E\u7EED\u8BF7\u6C42\u6C38\u4E45\u6392\u961F\u3002`
      );
      activeRelease();
    }
    waiting += 1;
    try {
      if (signal?.aborted) throw aborted();
      if (!allowConcurrent) {
        if (running > 0 || waiting > 1) {
          logger?.debug?.(`deepseek-web: \u300C${label}\u300D\u6392\u961F\u7B49\u5F85\uFF08\u524D\u9762\u8FD8\u6709 ${running} \u4E2A\u5728\u8DD1 / ${waiting - 1} \u4E2A\u5728\u7B49\uFF09`);
        }
        await waitOrAbort(prev);
      }
      if (hasFinished && now() - lastFinishedAt > LONG_RUN_IDLE_RESET_MS) consecutive = 0;
      const breakRange = longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS;
      const needsBreak = longRunThreshold > 0 && consecutive > 0 && consecutive >= longRunThreshold;
      const gap = needsBreak ? Math.round(breakRange.min + random() * Math.max(0, breakRange.max - breakRange.min)) : nextGap();
      if (hasFinished && (needsBreak || maxIntervalMs > 0)) {
        const waitMs = lastFinishedAt + gap - now();
        if (needsBreak) {
          logger?.info?.(
            `deepseek-web: \u5DF2\u8FDE\u7EED ${longRunThreshold} \u6B21\u8BF7\u6C42 \u2014\u2014 \u957F\u4F11 ${Math.round(gap / 1e3)}s \u518D\u7EE7\u7EED\uFF08\u957F\u4EFB\u52A1\u4FDD\u62A4\uFF1A\u8FDE\u7EED\u8DD1\u6BD4\u95F4\u9694\u5C0F\u66F4\u50CF\u811A\u672C\uFF09`
          );
        }
        if (waitMs > 0) {
          if (!needsBreak) {
            logger?.info?.(
              `deepseek-web: \u8DDD\u4E0A\u6B21\u8BF7\u6C42\u4E0D\u8DB3 ${gap}ms\uFF08\u533A\u95F4 ${minIntervalMs}~${maxIntervalMs}\uFF09\uFF0C\u7B49 ${Math.round(waitMs)}ms \u518D\u53D1\u300C${label}\u300D\uFF08\u9632\u8D26\u53F7\u7EA7\u9650\u6D41\uFF09`
            );
          }
          await waitOrAbort(sleep2(waitMs));
        }
      }
      if (signal?.aborted) throw aborted();
      if (needsBreak) consecutive = 0;
    } catch (error) {
      releaseMine();
      throw error;
    } finally {
      waiting -= 1;
    }
    running += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      leasedAt = 0;
      activeRelease = void 0;
      running -= 1;
      lastFinishedAt = now();
      hasFinished = true;
      consecutive += 1;
      releaseMine();
    };
    leasedAt = now();
    activeRelease = release;
    return release;
  }
  function nextGap() {
    if (maxIntervalMs <= minIntervalMs) return minIntervalMs;
    return Math.round(minIntervalMs + random() * (maxIntervalMs - minIntervalMs));
  }
  let maxPromptChars = clampMaxPromptChars(options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS);
  let maxRefImages = clampMaxRefImages(options.maxRefImages ?? DEFAULT_MAX_REF_IMAGES);
  let contextWindow = clampContextWindow(options.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
  let autoSwitchMinutes = clampAutoSwitchMinutes(options.autoSwitchMinutes ?? DEFAULT_AUTO_SWITCH_MINUTES);
  let serialToolCalls = options.serialToolCalls !== false;
  let autoRelogin = readGateSettings()?.autoRelogin === true;
  let freshSessionOnRestart2 = options.freshSessionOnRestart === true;
  let cleanupMode = options.sessionCleanup;
  let cleanupBatch = normalizeCleanupRange(options.cleanupBatch, CLEANUP_BATCH_BOUNDS);
  let cleanupDelayMs = normalizeCleanupRange(options.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS);
  let cleanupGapMs = normalizeCleanupRange(options.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS);
  function settings() {
    return {
      allowConcurrent,
      minRequestIntervalMs: minIntervalMs,
      maxRequestIntervalMs: maxIntervalMs,
      ...cleanupMode ? { sessionCleanup: cleanupMode } : {},
      ...cleanupBatch ? { cleanupBatch } : {},
      ...cleanupDelayMs ? { cleanupDelayMs } : {},
      ...cleanupGapMs ? { cleanupGapMs } : {},
      longRunThreshold,
      ...longRunBreakMs ? { longRunBreakMs } : {},
      maxPromptChars,
      maxRefImages,
      contextWindow,
      autoSwitchMinutes,
      serialToolCalls,
      freshSessionOnRestart: freshSessionOnRestart2,
      // 🔴 2026-10-10 外部审查 P1：漏了它 ⇒ `writeGateSettings(applied)` 用整对象覆盖写盘时
      // 把它丢掉 ⇒ 面板开关弹回关闭、定时检查永不触发（同 2026-09-14 那批字段的老问题）。
      //
      // ⚠️ **必须真的返回一个字段**（不能只靠 `readGateSettings()` 现读）：
      // 保存链是 `configure(patch)` → `applied = settings()` → `writeGateSettings(applied)`，
      // 而后者是**整对象覆盖写** ⇒ 这里少一个键，磁盘上那个就被抹掉。
      autoRelogin
    };
  }
  function configure(next) {
    if (typeof next.allowConcurrent === "boolean") allowConcurrent = next.allowConcurrent;
    if (next.minRequestIntervalMs !== void 0) minIntervalMs = clampInterval(Number(next.minRequestIntervalMs));
    if (next.maxRequestIntervalMs !== void 0) maxIntervalMs = clampInterval(Number(next.maxRequestIntervalMs));
    if (next.sessionCleanup !== void 0) cleanupMode = next.sessionCleanup;
    if (next.maxPromptChars !== void 0) maxPromptChars = clampMaxPromptChars(Number(next.maxPromptChars));
    if (next.maxRefImages !== void 0) maxRefImages = clampMaxRefImages(Number(next.maxRefImages));
    if (next.contextWindow !== void 0) contextWindow = clampContextWindow(Number(next.contextWindow));
    if (next.autoSwitchMinutes !== void 0) autoSwitchMinutes = clampAutoSwitchMinutes(Number(next.autoSwitchMinutes));
    if (typeof next.serialToolCalls === "boolean") serialToolCalls = next.serialToolCalls;
    if (typeof next.freshSessionOnRestart === "boolean") {
      freshSessionOnRestart2 = next.freshSessionOnRestart;
    }
    if (typeof next.autoRelogin === "boolean") {
      autoRelogin = next.autoRelogin;
    }
    if (next.cleanupBatch !== void 0) {
      const value = normalizeCleanupRange(next.cleanupBatch, CLEANUP_BATCH_BOUNDS);
      if (value) cleanupBatch = value;
    }
    if (next.cleanupDelayMs !== void 0) {
      const value = normalizeCleanupRange(next.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS);
      if (value) cleanupDelayMs = value;
    }
    if (next.cleanupGapMs !== void 0) {
      const value = normalizeCleanupRange(next.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS);
      if (value) cleanupGapMs = value;
    }
    if (next.longRunThreshold !== void 0 && Number.isFinite(next.longRunThreshold)) {
      longRunThreshold = Math.max(
        LONG_RUN_THRESHOLD_BOUNDS.min,
        Math.min(LONG_RUN_THRESHOLD_BOUNDS.max, Math.round(next.longRunThreshold))
      );
    }
    if (next.longRunBreakMs !== void 0) {
      const value = normalizeCleanupRange(next.longRunBreakMs, LONG_RUN_BREAK_BOUNDS_MS);
      if (value) longRunBreakMs = value;
    }
    if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs;
    logger?.info?.(
      `deepseek-web: \u8BF7\u6C42\u8282\u6D41\u8BBE\u7F6E\u5DF2\u66F4\u65B0 \u2014\u2014 ${allowConcurrent ? "\u5141\u8BB8\u5E76\u53D1\uFF08\u4E0D\u63A8\u8350\uFF09" : "\u4E32\u884C"} \xB7 \u95F4\u9694 ${minIntervalMs}~${maxIntervalMs}ms\uFF08\u968F\u673A\uFF09` + (cleanupBatch ? ` \xB7 \u6E05\u7406\u9608\u503C ${cleanupBatch.min}~${cleanupBatch.max} \u4E2A` : "") + (cleanupDelayMs ? ` \xB7 \u6700\u957F\u7B49\u5F85 ${Math.round(cleanupDelayMs.min / 1e3)}~${Math.round(cleanupDelayMs.max / 1e3)}s` : "") + (cleanupGapMs ? ` \xB7 \u5220\u9664\u95F4\u9694 ${cleanupGapMs.min}~${cleanupGapMs.max}ms` : "") + ` \xB7 \u957F\u4EFB\u52A1\u4FDD\u62A4 ${longRunThreshold > 0 ? `\u6BCF ${longRunThreshold} \u6B21\u957F\u4F11 ${Math.round((longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS).min / 1e3)}~${Math.round((longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS).max / 1e3)}s` : "\u5173\u95ED"}`
    );
    return settings();
  }
  return {
    acquire,
    stats: () => ({ running, waiting, lastFinishedAt }),
    settings,
    configure
  };
}

// src/context-feed.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join4 } from "node:path";

// src/protocol.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var MAX_DESCRIPTION_CHARS = 3200;
var CORE_TOOLS = /* @__PURE__ */ new Set([
  "pwsh",
  "bash",
  "run_code",
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "ls",
  "todo_write",
  "skill",
  "present",
  "ask_user_question"
]);
var MAX_TAIL_DESCRIPTION_CHARS = 160;
function isCoreTool(name2) {
  return CORE_TOOLS.has(String(name2 ?? ""));
}
function tailSentence(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  const stop = flat.search(/\.(\s|$)/);
  return truncate(stop >= 0 ? flat.slice(0, stop + 1) : flat, MAX_TAIL_DESCRIPTION_CHARS);
}
function formatTailTool(tool) {
  const sentence = tailSentence(String(tool.description ?? ""));
  const signature = buildToolSignature(tool, false);
  if (signature === null) return `\`${tool.name}\` \u2014 ${sentence}`;
  return `\`${signature.replace(/\s+/g, " ").trim()}\` \u2014 ${sentence}`;
}
var MAX_TOOLS_SECTION_CHARS = 56e3;
var HOLD_BACK_CHARS = 24;
var MAX_CAPTURE_CHARS = 256 * 1024;
var HEAD_RATIO = 0.62;
var PROTOCOL_SLACK_CHARS = 96;
var TOOL_PROTOCOL_INSTRUCTIONS = `# Tool Calling Protocol

You can call tools to complete the user's task. When you need a tool, output a single JSON object inside a fenced code block, with no other text before or after it:

\`\`\`dsh-tool
{"tool_calls":[{"name":"<tool-name>","arguments":{<json-arguments>}}]}
\`\`\`

Rules:
1. Put every tool you want to run in the "tool_calls" array (usually exactly one; a batch is allowed).
2. Stop immediately after the closing fence. The runner executes the call(s) and returns the results to you as the next message.
3. Never fabricate, guess, or simulate tool output \u2014 always wait for the real result.
4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable. Close every brace: the call object and its "arguments" object each need their OWN closing "}" \u2014 one missing "}" makes the whole batch unparsable and the call will be discarded.
5b. Two things break the JSON most often \u2014 check them before you emit:
   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. Get-ChildItem "$env:USERPROFILE\\.dsh". Every such inner double quote MUST be escaped as \\" inside the JSON string. An unescaped one ends the string early and discards the whole call.
   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. When a command needs several statements, join them with ";" on ONE line, or use \\n escapes \u2014 do not paste them as actual newlines. Prefer single quotes inside commands to reduce escaping.
6. Always wrap the JSON in a \`\`\`dsh-tool fence (see the example above). Do NOT use XML/HTML-like markup instead: no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>), nor the private delimiter-prefixed variants some DeepSeek surfaces use. An unfenced object or any such markup leaks into the visible transcript and into the web conversation.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result \u2026]" blocks, tool output, or the current prompt. Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry.
9. Keep each batch SMALL \u2014 at most 3 calls, and prefer exactly 1. If you need more, send them in successive steps. Long payloads are the ones that most often come out malformed.
10. Each call must be able to run on its own: no shared shell variables across calls, no dependence on another call in the same batch.`;
var SERIAL_TOOL_PROTOCOL_INSTRUCTIONS = `# Tool Calling Protocol

You can call tools to complete the user's task. When you need a tool, output a single JSON object inside a fenced code block, with no other text before or after it:

\`\`\`dsh-tool
{"tool_calls":[{"name":"<tool-name>","arguments":{<json-arguments>}}]}
\`\`\`

Rules:
1. Put exactly ONE tool in the "tool_calls" array \u2014 one call per message, never a batch.
2. Stop immediately after the closing fence. The runner executes the call and returns the result to you as the next message.
3. Never fabricate, guess, or simulate tool output \u2014 always wait for the real result.
4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable. Close every brace: the call object and its "arguments" object each need their OWN closing "}" \u2014 one missing "}" makes the whole batch unparsable and the call will be discarded.
5b. Two things break the JSON most often \u2014 check them before you emit:
   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. Get-ChildItem "$env:USERPROFILE\\.dsh". Every such inner double quote MUST be escaped as \\" inside the JSON string. An unescaped one ends the string early and discards the whole call.
   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. When a command needs several statements, join them with ";" on ONE line, or use \\n escapes \u2014 do not paste them as actual newlines. Prefer single quotes inside commands to reduce escaping.
6. Always wrap the JSON in a \`\`\`dsh-tool fence (see the example above). Do NOT use XML/HTML-like markup instead: no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>), nor the private delimiter-prefixed variants some DeepSeek surfaces use. An unfenced object or any such markup leaks into the visible transcript and into the web conversation.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result \u2026]" blocks, tool output, or the current prompt. Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry.
9. Do NOT batch. Emit one call, stop, and wait for its real result before you decide the next step. Needing several tools means several successive messages, one call each \u2014 the user has turned batching off for this session, so a multi-call array works against them.
10. Unlike a batch, a call here MAY build on the previous step's result \u2014 read what came back and use it. That is the point of one-at-a-time. But never invent a result you have not received.`;
function toolProtocolInstructions(serial) {
  return serial === true ? SERIAL_TOOL_PROTOCOL_INSTRUCTIONS : TOOL_PROTOCOL_INSTRUCTIONS;
}
var MIN_TOOL_PROGRAM_CHARS = 80;
function looksLikeUnexecutedToolProgram(text) {
  const source = String(text ?? "");
  if (!source) return false;
  const blocks = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(source)) !== null) blocks.push(match[1]);
  if (blocks.length === 0) {
    return /await\s+tools\.[A-Za-z_$][\w$]*\s*\(/.test(source);
  }
  return blocks.some(
    (block) => block.length >= MIN_TOOL_PROGRAM_CHARS && /tools\.[A-Za-z_$][\w$]*\s*\(/.test(block)
  );
}
function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
var MAX_PARAM_DESC_CHARS = 160;
var MAX_SIGNATURE_DEPTH = 4;
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
var SCHEMA_TOP_KEYS = /* @__PURE__ */ new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "description",
  "title",
  "default",
  "examples",
  "$schema",
  "definitions",
  "$defs"
]);
function isWrappedSchema(node) {
  const properties = asRecord(node.properties);
  if (!properties || Object.keys(properties).length === 0) return false;
  if (!Object.values(properties).every((value) => asRecord(value) !== null)) return false;
  return Object.keys(node).every((key) => SCHEMA_TOP_KEYS.has(key));
}
function isRequiredParam(def) {
  return asRecord(def)?.required === true;
}
function paramDescription(schema) {
  const description = asRecord(schema)?.description;
  return typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
}
function renderParamMap(map, requiredList, depth) {
  const fromList = new Set(requiredList);
  return Object.entries(map).map(([name2, def]) => {
    const required = fromList.has(name2) || isRequiredParam(def);
    return `${name2}${required ? "" : "?"}: ${renderParamType(def, depth)}`;
  });
}
function renderParamType(schema, depth) {
  const node = asRecord(schema);
  if (!node) return "any";
  if (depth > MAX_SIGNATURE_DEPTH) return "any";
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const variants = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
  if (variants && variants.length > 0) {
    const rendered = variants.map((item) => renderParamType(item, depth + 1));
    return [...new Set(rendered)].join(" | ");
  }
  const declared = typeof node.type === "string" ? node.type : "";
  if (declared === "array" || !declared && node.items !== void 0) {
    const item = renderParamType(node.items, depth + 1);
    return item.includes("|") ? `(${item})[]` : `${item}[]`;
  }
  const properties = asRecord(node.properties);
  if (declared === "object" || properties) {
    const inner = properties ? renderParamMap(properties, [], depth + 1) : [];
    const extra = asRecord(node.additionalProperties);
    if (extra) inner.push(`[key: string]: ${renderParamType(extra, depth + 1)}`);
    if (inner.length === 0) return "object";
    return `{${inner.join(", ")}}`;
  }
  return declared || "any";
}
function buildToolSignature(tool, withParamDocs = true) {
  try {
    const node = asRecord(tool.parameters);
    if (!node) return `${tool.name}()`;
    const wrapped = isWrappedSchema(node);
    const map = wrapped ? asRecord(node.properties) : node;
    const requiredList = wrapped && Array.isArray(node.required) ? node.required.filter((key) => typeof key === "string") : [];
    const args = renderParamMap(map, requiredList, 1);
    if (args.length === 0) {
      return Object.keys(node).length === 0 ? `${tool.name}()` : null;
    }
    const lines = [`${tool.name}(${args.join(", ")})`];
    if (withParamDocs) {
      for (const [name2, def] of Object.entries(map)) {
        const description = paramDescription(def);
        if (description) lines.push(`  ${name2}: ${truncate(description, MAX_PARAM_DESC_CHARS)}`);
      }
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}
function buildToolSection(tools, maxChars = MAX_TOOLS_SECTION_CHARS) {
  if (!tools || tools.length === 0) return "";
  const parts = ["", "## Available tools"];
  let budget = Math.max(0, Math.min(MAX_TOOLS_SECTION_CHARS, maxChars));
  const coreTools = tools.filter((tool) => isCoreTool(tool?.name));
  const tailTools = tools.filter((tool) => !isCoreTool(tool?.name));
  const omittedNotice = (rest) => {
    const names = rest.map((item) => String(item?.name ?? "")).filter(Boolean);
    return `
(\u26A0\uFE0F The following ${names.length} tools are NOT described above (omitted for length): ${names.join(", ")}. If you need one of them, ask the user for its exact parameters \u2014 do NOT guess them.)`;
  };
  for (let index = 0; index < coreTools.length; index += 1) {
    const tool = coreTools[index];
    const signature = buildToolSignature(tool, true);
    let parametersText = signature ?? "";
    if (signature === null) {
      let schemaText = "";
      try {
        schemaText = JSON.stringify(tool.parameters ?? {});
      } catch {
        schemaText = "{}";
      }
      parametersText = `Parameters (JSON Schema): ${schemaText}`;
    }
    const block = [
      "",
      `### ${tool.name}`,
      truncate(String(tool.description ?? "").replace(/\s+/g, " ").trim(), MAX_DESCRIPTION_CHARS),
      parametersText
    ].join("\n");
    if (budget - block.length < 0) {
      parts.push(omittedNotice([...coreTools.slice(index), ...tailTools]));
      return parts.join("\n");
    }
    budget -= block.length;
    parts.push(block);
  }
  if (tailTools.length > 0) {
    const header = [
      "",
      "## Other tools",
      "",
      "Call these the same way. Parameter names and types are in the parentheses."
    ].join("\n");
    if (budget - header.length < 0) {
      parts.push(omittedNotice(tailTools));
      return parts.join("\n");
    }
    budget -= header.length;
    parts.push(header);
    for (let index = 0; index < tailTools.length; index += 1) {
      const line = `- ${formatTailTool(tailTools[index])}`;
      if (budget - line.length < 0) {
        parts.push(omittedNotice(tailTools.slice(index)));
        break;
      }
      budget -= line.length;
      parts.push(line);
    }
  }
  return parts.join("\n");
}
function flattenText(blocks, out = []) {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") out.push(block.text);
    else if (block.type === "tool-result" && Array.isArray(block.content)) flattenText(block.content, out);
  }
  return out;
}
function blockImageMarks(blocks, kept) {
  const marks = [];
  const walk = (list) => {
    for (const block of list ?? []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "image") {
        const key = String(block.attachment?.attachmentId ?? "");
        marks.push(!kept || !key || kept.has(key) ? "[image attached]" : "[earlier image omitted]");
      } else if (block.type === "tool-result" && Array.isArray(block.content)) walk(block.content);
    }
  };
  walk(blocks);
  return marks;
}
function collectImageRefs(messages) {
  const refs = [];
  const walk = (blocks) => {
    for (const block of blocks ?? []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "image" && block.attachment) refs.push(block.attachment);
      else if (block.type === "tool-result" && Array.isArray(block.content)) walk(block.content);
    }
  };
  for (const message of messages ?? []) {
    if (!message || typeof message !== "object") continue;
    walk(Array.isArray(message.content) ? message.content : void 0);
  }
  return refs;
}
var IMAGE_EXT_BY_MEDIA_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};
var KNOWN_IMAGE_EXT = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "webp", "gif"]);
function imageUploadName(name2, mediaType) {
  const ext = IMAGE_EXT_BY_MEDIA_TYPE[String(mediaType ?? "").trim().toLowerCase()] ?? "png";
  const raw = typeof name2 === "string" ? name2.trim() : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  const matched = /\.([a-z0-9]{2,5})$/i.exec(base);
  if (matched && KNOWN_IMAGE_EXT.has(matched[1].toLowerCase())) return base;
  return `image.${ext}`;
}
function renderToolCalls(blocks) {
  const calls = (blocks ?? []).filter((block) => block?.type === "tool-call");
  if (calls.length === 0) return null;
  const payload = {
    tool_calls: calls.map((call) => {
      let args = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = { _raw: String(call.arguments ?? "") };
      }
      return { name: String(call.name ?? ""), arguments: args };
    })
  };
  return JSON.stringify(payload);
}
function truncateMiddle(text, maxChars, tailRatio = 0.7) {
  if (text.length <= maxChars) return text;
  const RESERVE = 64;
  const budget = Math.max(0, maxChars - RESERVE);
  const tail = Math.floor(budget * tailRatio);
  const head = Math.max(0, budget - tail);
  const dropped = text.length - head - tail;
  const marker = `

...[${dropped} chars omitted]...

`;
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}
function serializePromptParts(options) {
  const maxChars = options.maxChars ?? 12e4;
  if (!Number.isSafeInteger(maxChars) || maxChars < 128) {
    throw new RangeError("maxChars \u5FC5\u987B\u4E3A\u81F3\u5C11 128 \u7684\u6574\u6570");
  }
  const system = String(options.system ?? "").trim();
  const protocolText = toolProtocolInstructions(options.serialToolCalls);
  const toolBudget = Math.max(
    0,
    Math.floor(maxChars * HEAD_RATIO) - system.length - protocolText.length - PROTOCOL_SLACK_CHARS
  );
  const toolSection = buildToolSection(options.tools, toolBudget);
  const protocol = toolSection ? `

${protocolText}${toolSection}` : "";
  const lines = [];
  let pendingToolCallIds = [];
  for (const message of options.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (message.role === "system") {
      const text2 = flattenText(blocks).join("");
      if (text2.trim()) lines.push(`[System]
${text2}`);
      continue;
    }
    if (message.role === "assistant") {
      const text2 = flattenText(blocks).join("");
      const renderedCalls = renderToolCalls(blocks);
      pendingToolCallIds = renderedCalls ? blocks.filter((block) => block?.type === "tool-call").map((block) => String(block.toolCallId ?? block.id ?? "")) : [];
      if (renderedCalls) lines.push(`Assistant: ${renderedCalls}`);
      else if (text2.trim()) lines.push(`Assistant: ${text2}`);
      continue;
    }
    if (message.role === "tool") {
      const body = flattenText(blocks).join("") || "(no output)";
      const errorMark = message.isError === true ? " [ERROR]" : "";
      lines.push(`[Tool Result${errorMark} for ${String(message.toolCallId ?? "")}]
${body}`);
      pendingToolCallIds = [];
      continue;
    }
    const toolResults = blocks.filter((block) => block?.type === "tool-result");
    const text = flattenText(blocks.filter((block) => block?.type !== "tool-result")).join("");
    const imageMarks = blockImageMarks(blocks, options.keptImageKeys);
    const images = imageMarks.length;
    if (toolResults.length === 0 && pendingToolCallIds.length > 0 && images === 0 && text.trim()) {
      const textBlocks = blocks.filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim()).map((block) => block.text);
      const ids = pendingToolCallIds;
      pendingToolCallIds = [];
      if (textBlocks.length === ids.length && ids.length > 0) {
        for (let i = 0; i < ids.length; i += 1) lines.push(`[Tool Result for ${ids[i]}]
${textBlocks[i]}`);
      } else {
        lines.push(`[Tool Result for ${ids.filter(Boolean).join(", ")}]
${text}`);
      }
      continue;
    }
    pendingToolCallIds = [];
    if (text.trim() || toolResults.length === 0 && images === 0 || images > 0) {
      const imageNote = imageMarks.length > 0 ? `
${imageMarks.join(" ")}` : "";
      lines.push(`User: ${text}${imageNote}`);
    }
    for (const result of toolResults) {
      const body = flattenText(result.content).join("") || "(no output)";
      const errorMark = result.isError ? " [ERROR]" : "";
      lines.push(`[Tool Result${errorMark} for ${String(result.toolCallId ?? "")}]
${body}`);
    }
  }
  const transcript = lines.join("\n\n");
  const head = system ? `${system}${protocol}` : protocol.trim();
  const merged = transcript ? `${head}

---

${transcript}` : head;
  if (merged.length <= maxChars) return { head, entries: lines, full: merged, transcript };
  const separator = transcript ? "\n\n---\n\n" : "";
  const budget = maxChars - head.length - separator.length;
  if (budget < 128) {
    throw new AdapterLlmError(
      "\u7CFB\u7EDF/\u5DE5\u5177\u5B9A\u4E49\u8D85\u51FA prompt \u9884\u7B97\uFF0C\u8BF7\u51CF\u5C11\u56FA\u5B9A\u8F93\u5165\u6216\u6269\u5927\u4E0A\u9650",
      "CONTEXT_WINDOW_EXCEEDED"
    );
  }
  const sentTranscript = truncateMiddle(transcript, budget, 0.7);
  return { head, entries: lines, full: head + separator + sentTranscript, transcript: sentTranscript };
}
var MARKER_RE = /\{\s*(?:"(?:[^"\\]|\\.)*"\s*:[\s\S]{0,240}?)?\s*"tool_calls?"\s*:/;
var JSON_OBJECT_OPEN_RE = /\{\s*"(?:[^"\\]|\\.)*"\s*:/;
var WRAPPER_NAMES = "tool_calls|tool_call|function_calls|calls";
var DSML_PREFIX_BODY = "[|\uFF5C]+\\s*DSML\\s*[|\uFF5C]+\\s*|\\s*dsml-\\s*";
var DSML_PREFIX = `(?:${DSML_PREFIX_BODY})?`;
var DSML_PREFIX_ONLY = `(?:${DSML_PREFIX_BODY})`;
var XML_STARTER_RE = new RegExp(`<\\s*${DSML_PREFIX}(${WRAPPER_NAMES}|invoke)\\b`, "i");
var FENCE_HEAD_RE = /^[ \t]*\n?```[ \t]*\n?/;
var FENCE_ANY_HEAD_RE = /\n?[ \t]*```[ \t]*[a-zA-Z0-9_-]*[ \t]*\n?/;
var CALL_FENCE_NAME = "dsh-tool";
var CALL_FENCE_OPEN_RE = new RegExp(`\`\`\`[ \\t]*${CALL_FENCE_NAME}[ \\t]*\\n?`, "i");
var CALL_FENCE_TAIL_RE = /\n?[ \t]*```[ \t]*(?:[a-zA-Z0-9_-]*)[ \t]*\n?$/;
function stripCallFence(text) {
  return text.replace(/```[ \t]*[a-zA-Z0-9_-]*[ \t]*\n?/g, "");
}
var TAG_OPEN_PREFIX = `<\\s*${DSML_PREFIX}`;
var TAG_CLOSE_PREFIX = `<\\/\\s*${DSML_PREFIX}`;
var XML_CLOSE_NAMES = `parameter|invoke|${WRAPPER_NAMES}`;
function normalizeDsml(text) {
  return text.replace(new RegExp(`<(/?)${DSML_PREFIX}`, "gi"), "<$1").replace(/<\s*dsml-\s*/gi, "<").replace(/<\/\s*dsml-\s*/gi, "</");
}
var JSON_MARKER_STARTERS = ['{"tool_calls"', '{"tool_call"'];
var XML_MARKER_STARTERS = [
  "<tool_calls",
  "<tool_call",
  "<function_calls",
  "<calls",
  "<invoke",
  "<dsml-tool_calls",
  "<dsml-invoke",
  "<dsml- tool_calls",
  "<dsml- invoke",
  "<dsml- calls"
];
function partialMarkerSuffixLength(text) {
  const LIMIT = 32;
  const from = Math.max(0, text.length - LIMIT);
  const raw = text.slice(from);
  const braceAt = raw.lastIndexOf("{");
  const angleAt = raw.lastIndexOf("<");
  const startAt = Math.max(braceAt, angleAt);
  if (startAt === -1) return 0;
  const held = raw.length - startAt;
  const normalized = normalizeDsml(raw.slice(startAt));
  if (normalized.startsWith("{")) {
    if (MARKER_RE.test(normalized)) return 0;
    const body = normalized.replace(/^\{\s*/, "").replace(/\s+/g, "");
    const ok = JSON_MARKER_STARTERS.some((starter) => starter.startsWith(`{${body}`));
    if (ok) return held;
    if (!normalized.includes("}")) return held;
    return 0;
  }
  if (normalized.startsWith("<")) {
    if (XML_STARTER_RE.test(normalized)) return 0;
    const lower = normalized.toLowerCase().replace(/\s+/g, "");
    if (XML_MARKER_STARTERS.some((starter) => starter.startsWith(lower))) return held;
    const loose = lower.replace(/[|｜]|dsml/g, "");
    if (/^<\/?[a-z_]*$/.test(loose) && XML_MARKER_STARTERS.some((starter) => starter.startsWith(loose))) {
      return held;
    }
    return 0;
  }
  return 0;
}
function extractBalancedJson(text) {
  if (text[0] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { json: text.slice(0, i + 1), end: i + 1 };
    }
  }
  return null;
}
function readAttr(attrs, name2) {
  const re = new RegExp(`\\b${name2}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>/]+))`, "i");
  const match = re.exec(attrs);
  if (!match) return void 0;
  return match[1] ?? match[2] ?? match[3];
}
function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
  }
  for (const candidate of jsonRepairCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== void 0) return parsed;
    } catch {
    }
  }
  return void 0;
}
function escapeInnerQuotes(text) {
  let out = "";
  let inString = false;
  let keyPosition = false;
  let lastStructural = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') {
        inString = true;
        keyPosition = lastStructural === "{" || lastStructural === "," || lastStructural === "[";
        out += ch;
        continue;
      }
      if (!" 	\n\r".includes(ch)) lastStructural = ch;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      out += ch + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && " 	\n\r".includes(text[j])) j++;
      const next = text[j];
      const isStructural = next === "," || next === "}" || next === "]" || next === void 0 || next === ":" && keyPosition;
      if (isStructural) {
        inString = false;
        lastStructural = next === void 0 ? "" : next;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}
function* jsonRepairCandidates(text) {
  const pathTail = (value) => value.replace(/([A-Za-z]:[^"]*?)\\"(?=[,}\]\s])/g, '$1\\\\"');
  for (const base of [text, ...structuralRepairCandidates(text)]) {
    for (const variant of [base, escapeInnerQuotes(base)]) {
      yield repairJsonText(pathTail(variant), { mode: "smart" });
      yield repairJsonText(variant, { mode: "smart" });
      yield repairJsonText(pathTail(variant), { mode: "conservative" });
      yield repairJsonText(variant, { mode: "conservative" });
    }
  }
}
function* structuralRepairCandidates(text) {
  const marker = /^\s*\{\s*"tool_calls?"\s*:\s*\[/.exec(text);
  if (!marker) return;
  const rebuilt = rebuildToolCallJson(text);
  if (rebuilt && rebuilt !== text) yield rebuilt;
}
function rebuildToolCallJson(text) {
  if (!/^\s*\{\s*"tool_calls?"\s*:\s*\[/.test(text)) return null;
  let out = "";
  const stack = [];
  let inString = false;
  let escape = false;
  let insertions = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const want = ch === "}" ? "{" : "[";
      while (stack.length > 0 && stack[stack.length - 1] !== want) {
        if (insertions >= 8) return null;
        out += stack[stack.length - 1] === "{" ? "}" : "]";
        stack.pop();
        insertions += 1;
      }
      if (stack.length === 0) return null;
      stack.pop();
      out += ch;
      continue;
    }
    if (ch === ",") {
      const bracketIndex = stack.indexOf("[");
      if (bracketIndex === 1 && stack.length - bracketIndex - 1 === 1 && stack[stack.length - 1] === "{" && /^\s*\{\s*"name"\s*:/.test(text.slice(i + 1))) {
        out += "}";
        stack.pop();
        insertions += 1;
      }
      out += ch;
      continue;
    }
    out += ch;
  }
  if (inString) return null;
  if (insertions > 8) return null;
  while (stack.length > 0) {
    out += stack[stack.length - 1] === "{" ? "}" : "]";
    stack.pop();
  }
  return out;
}
function repairJsonText(text, options = {}) {
  const mode = options.mode ?? "smart";
  let out = "";
  let inString = false;
  let buf = "";
  const flushString = () => {
    const raw = buf;
    const body = mode === "smart" && hasInvalidEscape(raw) ? literalizeBackslashes(raw) : escapeInvalidEscapes(raw);
    out += `"${body}"`;
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') {
        inString = true;
        buf = "";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === void 0) {
        buf += "\\\\";
        continue;
      }
      buf += ch + next;
      i += 1;
      continue;
    }
    if (ch === '"') {
      flushString();
      inString = false;
      continue;
    }
    if (ch === "\n") {
      buf += "\\n";
      continue;
    }
    if (ch === "\r") {
      buf += "\\r";
      continue;
    }
    if (ch === "	") {
      buf += "\\t";
      continue;
    }
    buf += ch;
  }
  if (inString) flushString();
  return out.replace(/,(\s*[}\]])/g, "$1");
}
function hasInvalidEscape(body) {
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") continue;
    const next = body[i + 1];
    if (next === void 0) return true;
    if (!'"\\/bfnrtu'.includes(next)) return true;
    i += 1;
  }
  return false;
}
function literalizeBackslashes(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === "\\") {
      out += "\\\\";
      i += 1;
      continue;
    }
    if (next === '"') {
      out += '\\"';
      i += 1;
      continue;
    }
    out += "\\\\";
  }
  return out;
}
function escapeInvalidEscapes(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === void 0) {
      out += "\\\\";
      continue;
    }
    if ('"\\/bfnrtu'.includes(next)) {
      out += ch + next;
      i += 1;
      continue;
    }
    out += "\\\\";
  }
  return out;
}
function parseParameterValue(raw) {
  let text = raw.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(text);
  if (cdata) text = cdata[1];
  if (text === "") return "";
  const parsed = parseJsonLenient(text);
  return parsed === void 0 ? text : parsed;
}
function unwrapDsmlArguments(args) {
  const wrapped = args.arguments;
  if (wrapped === void 0) return args;
  if (typeof wrapped === "string") {
    const reparsed = parseJsonLenient(wrapped);
    if (reparsed && typeof reparsed === "object" && reparsed !== null && !Array.isArray(reparsed)) {
      if (Object.keys(args).length === 1) return reparsed;
    }
    return args;
  }
  if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
    if (Object.keys(args).length === 1) return wrapped;
  }
  return args;
}
function xmlToolCallTail(block) {
  const text = normalizeDsml(block).replace(FENCE_HEAD_RE, "").replace(/```\s*$/, "");
  const closeRe = new RegExp(`${TAG_CLOSE_PREFIX}invoke\\s*>`, "gi");
  let end = -1;
  let match;
  while ((match = closeRe.exec(text)) !== null) end = match.index + match[0].length;
  return end >= 0 ? text.slice(end) : "";
}
function parseXmlToolCalls(block) {
  const text = normalizeDsml(block).replace(FENCE_HEAD_RE, "").replace(/```\s*$/, "");
  const invokeRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>([\\s\\S]*?)${TAG_CLOSE_PREFIX}invoke\\s*>`, "gi");
  const calls = [];
  let invoke;
  while ((invoke = invokeRe.exec(text)) !== null) {
    const name2 = readAttr(invoke[1], "name");
    if (!name2) continue;
    const body = invoke[2];
    let args = {};
    let sawParam = false;
    const paramRe = new RegExp(`${TAG_OPEN_PREFIX}parameter\\b([^>]*)>([\\s\\S]*?)${TAG_CLOSE_PREFIX}parameter\\s*>`, "gi");
    let param;
    while ((param = paramRe.exec(body)) !== null) {
      const key = readAttr(param[1], "name");
      if (!key) continue;
      sawParam = true;
      args[key] = parseParameterValue(param[2]);
    }
    if (!sawParam) {
      const inner = body.trim();
      if (inner) {
        try {
          const parsed = JSON.parse(inner);
          if (parsed && typeof parsed === "object") Object.assign(args, parsed);
          else args._raw = parsed;
        } catch {
          args._raw = inner;
        }
      }
    }
    args = unwrapDsmlArguments(args);
    calls.push({
      id: `call_${randomUUID2().replace(/-/g, "").slice(0, 20)}`,
      name: name2,
      arguments: JSON.stringify(args)
    });
  }
  if (calls.length > 0) return calls;
  return salvageXmlToolCalls(text);
}
function salvageXmlToolCalls(text) {
  const invokeStartRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>`, "gi");
  const starts = [];
  let match;
  while ((match = invokeStartRe.exec(text)) !== null) {
    starts.push({ index: match.index, end: invokeStartRe.lastIndex, attrs: match[1] });
  }
  if (starts.length === 0) return null;
  const calls = [];
  for (let i = 0; i < starts.length; i++) {
    const name2 = readAttr(starts[i].attrs, "name");
    if (!name2) continue;
    const bodyStart = starts[i].end;
    const nextStart = starts[i + 1]?.index ?? text.length;
    const body = text.slice(bodyStart, nextStart);
    calls.push({
      id: `call_${randomUUID2().replace(/-/g, "").slice(0, 20)}`,
      name: name2,
      // 🔴 0.6.40：同样要剥包装层 —— salvage 是"收尾不全"的兜底路径，
      // 遇到坏形态的概率**更高**（实测 DSML 变体常缺闭栏）。两处必须一致，
      // 漏一处就等于给 salvage 留了个后门。
      arguments: JSON.stringify(unwrapDsmlArguments(salvageXmlParameters(body)))
    });
  }
  return calls.length > 0 ? calls : null;
}
function salvageXmlParameters(body) {
  const args = {};
  const paramStartRe = new RegExp(`${TAG_OPEN_PREFIX}parameter\\b([^>]*)>`, "gi");
  const found = [];
  let match;
  while ((match = paramStartRe.exec(body)) !== null) {
    const key = readAttr(match[1], "name");
    if (key) found.push({ start: match.index, end: paramStartRe.lastIndex, key });
  }
  for (let i = 0; i < found.length; i++) {
    const valueEnd = found[i + 1] ? found[i + 1].start : body.length;
    args[found[i].key] = parseParameterValue(stripXmlClosers(body.slice(found[i].end, valueEnd)));
  }
  if (found.length === 0) {
    const inner = stripXmlClosers(body).trim();
    if (inner) {
      const parsed = parseJsonLenient(inner);
      if (parsed && typeof parsed === "object") Object.assign(args, parsed);
      else args._raw = inner;
    }
  }
  return args;
}
function stripXmlClosers(value) {
  const re = new RegExp(`(?:\\s*${TAG_CLOSE_PREFIX}(?:${XML_CLOSE_NAMES})\\s*>)+\\s*$`, "i");
  return value.replace(re, "");
}
function looksLikeToolCallBlock(mode, raw) {
  if (mode === "json") return MARKER_RE.test(raw);
  const text = normalizeDsml(raw);
  return new RegExp(`${TAG_OPEN_PREFIX}invoke\\b[^>]*\\bname\\s*=`, "i").test(text) || new RegExp(`${TAG_OPEN_PREFIX}parameter\\b[^>]*\\bname\\s*=`, "i").test(text);
}
function classifyFailure(mode, raw) {
  if (/\[\s*Tool Result\b/i.test(raw)) return "echo";
  if (mode === "json") return extractBalancedJson(raw.replace(FENCE_HEAD_RE, "")) ? "unparsable" : "unbalanced";
  return findXmlToolCallEnd(raw) === -1 ? "unbalanced" : "unparsable";
}
function parseToolCallJson(json) {
  const parsed = parseJsonLenient(json);
  if (!parsed || typeof parsed !== "object") return null;
  const raw = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : parsed.tool_call && typeof parsed.tool_call === "object" ? [parsed.tool_call] : null;
  if (!raw) return null;
  const calls = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const name2 = typeof entry.name === "string" ? entry.name : typeof entry.tool === "string" ? entry.tool : "";
    if (!name2) continue;
    let args = entry.arguments ?? entry.parameters ?? entry.args ?? {};
    if (Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
      args = args[0];
    }
    if (typeof args === "string") {
      const reparsed = parseJsonLenient(args);
      if (reparsed === void 0) args = JSON.stringify({ _raw: args });
    } else {
      try {
        args = JSON.stringify(args ?? {});
      } catch {
        args = "{}";
      }
    }
    calls.push({ id: `call_${randomUUID2().replace(/-/g, "").slice(0, 20)}`, name: name2, arguments: String(args) });
  }
  return calls.length > 0 ? calls : null;
}
function parseSalvagedToolCallJson(buffer) {
  const text = buffer.replace(FENCE_ANY_HEAD_RE, "").replace(/^\s+/, "");
  const direct = parseToolCallJson(text);
  if (direct) return direct;
  const balanced = extractBalancedJson(text);
  if (balanced && balanced.end < text.length) return parseToolCallJson(balanced.json);
  return null;
}
function findXmlToolCallEnd(buffer) {
  const text = buffer;
  const wrapper = new RegExp(`<\\s*${DSML_PREFIX}(${WRAPPER_NAMES})\\b`, "i").exec(text);
  const startsWithWrapper = wrapper !== null && wrapper.index === 0;
  const isInvokeStart = (value) => new RegExp(`^\\s*<\\s*${DSML_PREFIX}invoke\\b`, "i").test(value);
  if (startsWithWrapper) {
    const tag = wrapper[1].toLowerCase();
    const closeRe = new RegExp(`<\\/\\s*${DSML_PREFIX}${tag}\\s*>`, "i");
    const match = closeRe.exec(text);
    return match ? match.index + match[0].length : -1;
  }
  if (!isInvokeStart(text)) {
    return -1;
  }
  let cursor = 0;
  for (; ; ) {
    const slice = text.slice(cursor);
    if (!isInvokeStart(slice)) return cursor > 0 ? cursor : -1;
    const closeRe = new RegExp(`<\\/\\s*${DSML_PREFIX}invoke\\s*>`, "i");
    const match = closeRe.exec(slice);
    if (!match) return -1;
    cursor += match.index + match[0].length;
    const rest = text.slice(cursor);
    if (isInvokeStart(rest)) continue;
    const strayClose = new RegExp(
      `^\\s*<\\/\\s*${DSML_PREFIX}(?:${WRAPPER_NAMES})\\s*>`,
      "i"
    );
    const stray = strayClose.exec(rest);
    if (stray) return cursor + stray[0].length;
    const tail = rest.trim();
    if (tail.startsWith("<") && /^<\/?\s*[|｜]?\s*[A-Za-z]{0,14}$/.test(tail)) return -1;
    return cursor;
  }
}
function stripStrayToolMarkup(text) {
  if (!text) return text;
  if (!/voke\s*>|calls?\s*>|tool_calls?\s*>|function_calls?\s*>|DSML/i.test(text)) return text;
  return text.replace(
    new RegExp(
      // 包裹标签：整组前缀**可选** ⇒ 写成 `(?:${DSML_PREFIX_ONLY})?`，
      // ⚠️ 不能用 `${DSML_PREFIX}`（它自带 `?`，再串一层会让"包裹标签组"整体可空，
      //    于是 `<invoke>` 那种无前缀写法也会被这个分支吃掉 —— 实测踩过）。
      `<\\/?\\s*(?:${DSML_PREFIX_ONLY})?(?:${WRAPPER_NAMES})\\s*>|<\\/?\\s*${DSML_PREFIX_ONLY}invoke\\s*>`,
      "gi"
    ),
    ""
  ).replace(new RegExp(`(^|\\n)[ \\t]*<\\/?[ \\t]+(?:${WRAPPER_NAMES})[ \\t]*>[ \\t]*(?=\\n|$)`, "gi"), "$1").replace(/(^|\n)[ \t]*(?:in)?voke\s*>\s*(?=\n|$)/gi, "$1");
}
var ToolCallStreamFilter = class {
  pending = "";
  capture = null;
  abandoned = null;
  knownTools;
  /**
   * 本次流里**我们剥掉过一个调用围栏的开栏**（0.6.38）。
   *
   * ⇒ 之后出现的闭栏必定是同一个调用块的收尾，可以安全剥掉。
   * ⚠️ 有了这个标记才敢剥闭栏：否则"正文里正常的代码块"会被误伤
   * （`check-auto-continue` N03 / `check-tools-section` 各有用例守着）。
   */
  sawCallFence = false;
  constructor(knownTools) {
    this.knownTools = knownTools;
  }
  push(text) {
    const out = { text: "", calls: [] };
    if (text) {
      if (this.capture) this.capture.buffer += text;
      else this.pending += text;
    }
    this.drain(out);
    return out;
  }
  flush() {
    const out = { text: "", calls: [] };
    if (this.capture) {
      const captured = this.capture;
      const calls = captured.mode === "xml" ? parseXmlToolCalls(captured.buffer) : parseSalvagedToolCallJson(captured.buffer);
      if (calls) {
        out.calls.push(...calls);
        if (captured.mode === "xml") out.text += stripStrayToolMarkup(xmlToolCallTail(captured.buffer));
      } else if (looksLikeToolCallBlock(captured.mode, captured.buffer))
        this.abandoned ??= { raw: captured.buffer, mode: captured.mode, reason: classifyFailure(captured.mode, captured.buffer) };
      else out.text += stripStrayToolMarkup(captured.buffer);
      this.capture = null;
    }
    const tailText = stripStrayToolMarkup(this.pending);
    if (this.sawCallFence) {
      out.text += tailText.replace(CALL_FENCE_TAIL_RE, "");
      this.sawCallFence = false;
    } else {
      out.text += tailText;
    }
    this.pending = "";
    if (this.abandoned) out.rejected = this.abandoned;
    return out;
  }
  drain(out) {
    for (; ; ) {
      if (this.capture) {
        const captured = this.capture;
        if (captured.mode === "xml") {
          const end = findXmlToolCallEnd(captured.buffer);
          if (end === -1) {
            if (captured.buffer.length > MAX_CAPTURE_CHARS) {
              if (looksLikeToolCallBlock("xml", captured.buffer))
                this.abandoned ??= { raw: captured.buffer, mode: "xml", reason: "oversize" };
              else out.text += stripStrayToolMarkup(captured.buffer);
              this.capture = null;
              continue;
            }
            return;
          }
          const block = captured.buffer.slice(0, end);
          const calls2 = parseXmlToolCalls(block);
          if (calls2) {
            out.calls.push(...calls2);
            if (this.sawCallFence) out.fenced = true;
          } else if (looksLikeToolCallBlock("xml", block)) this.abandoned ??= { raw: block, mode: "xml", reason: "unparsable" };
          else out.text += stripStrayToolMarkup(block);
          this.capture = null;
          this.pending = stripCallFence(captured.buffer.slice(end)) + this.pending;
          continue;
        }
        const balanced = extractBalancedJson(captured.buffer);
        if (!balanced) {
          if (captured.buffer.length > MAX_CAPTURE_CHARS) {
            this.abandoned ??= { raw: captured.buffer, mode: "json", reason: "oversize" };
            this.capture = null;
            continue;
          }
          return;
        }
        const calls = parseToolCallJson(balanced.json);
        if (calls) {
          out.calls.push(...calls);
          if (this.sawCallFence) out.fenced = true;
          this.capture = null;
          this.pending = stripCallFence(captured.buffer.slice(balanced.end)) + this.pending;
          continue;
        }
        const head = captured.buffer.slice(0, balanced.end);
        if (looksLikeToolCallBlock("json", head)) this.abandoned ??= { raw: head, mode: "json", reason: "unparsable" };
        else out.text += head;
        this.capture = null;
        this.pending = captured.buffer.slice(balanced.end) + this.pending;
        continue;
      }
      const jsonMarker = MARKER_RE.exec(this.pending);
      const xmlMarker = XML_STARTER_RE.exec(this.pending);
      const jsonIndex = jsonMarker?.index ?? -1;
      const xmlIndex = xmlMarker?.index ?? -1;
      const useXml = xmlIndex !== -1 && (jsonIndex === -1 || xmlIndex < jsonIndex);
      const index = useXml ? xmlIndex : jsonIndex;
      if (index !== -1) {
        const rawHead = this.pending.slice(0, index);
        const head = stripCallFence(rawHead);
        if (head !== rawHead) this.sawCallFence = true;
        out.text += head;
        this.capture = { mode: useXml ? "xml" : "json", buffer: this.pending.slice(index) };
        this.pending = "";
        continue;
      }
      this.pending = stripStrayToolMarkup(this.pending);
      const ownFence = CALL_FENCE_OPEN_RE.exec(this.pending);
      if (ownFence) {
        this.sawCallFence = true;
        out.text += this.pending.slice(0, ownFence.index);
        this.pending = this.pending.slice(ownFence.index);
        return;
      }
      if (this.pending.length <= HOLD_BACK_CHARS) return;
      const openObject = JSON_OBJECT_OPEN_RE.exec(this.pending);
      if (openObject && extractBalancedJson(this.pending.slice(openObject.index)) === null) {
        out.text += this.pending.slice(0, openObject.index);
        this.pending = this.pending.slice(openObject.index);
        return;
      }
      const hold = partialMarkerSuffixLength(this.pending);
      if (hold > 0) {
        out.text += this.pending.slice(0, this.pending.length - hold);
        this.pending = this.pending.slice(this.pending.length - hold);
        return;
      }
      if (this.sawCallFence) {
        const beforeTail = this.pending.replace(CALL_FENCE_TAIL_RE, "");
        const hasUserCodeBlock = /```[ \t]*(?!dsh-tool\b)[a-zA-Z0-9_-]+[ \t]*\n/.test(beforeTail);
        if (!hasUserCodeBlock) {
          out.text += this.pending.replace(CALL_FENCE_TAIL_RE, "");
          this.pending = "";
          this.sawCallFence = false;
          return;
        }
        this.sawCallFence = false;
      }
      out.text += this.pending;
      this.pending = "";
      return;
    }
  }
};
var ReasoningSanitizer = class {
  filter = new ToolCallStreamFilter();
  didStrip = false;
  /** 喂一段思考增量，返回**可以上屏**的部分（可能为空串）。 */
  push(text) {
    const out = this.filter.push(text);
    if (out.calls.length > 0) this.didStrip = true;
    const body = stripStrayToolMarkup(out.text);
    if (body !== out.text) this.didStrip = true;
    return body;
  }
  /** 流结束：把扣住没吐的尾巴交出来。 */
  flush() {
    const out = this.filter.flush();
    if (out.calls.length > 0 || out.rejected) this.didStrip = true;
    const body = stripStrayToolMarkup(out.text);
    if (body !== out.text) this.didStrip = true;
    return body;
  }
  /** 是否剥掉过东西（供日志与用例判定，不影响输出）。 */
  get stripped() {
    return this.didStrip;
  }
};
var IMITATED_MARKER_TAGS = ["ds_system", "system", "ide_result_status"];
var LONG_MARKER_TAGS = [{ tag: "tool_result", minBody: 120 }];
var LONG_MARKER_ALT = LONG_MARKER_TAGS.map((entry) => entry.tag).join("|");
var LONG_CLOSED_MARKER_RE = new RegExp(
  `<(${LONG_MARKER_ALT})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`,
  "g"
);
var LONG_OPEN_MARKER_RE = new RegExp(`<(${LONG_MARKER_ALT})\\b[^>]*>([\\s\\S]*)$`, "g");
function minBodyFor(tag) {
  return LONG_MARKER_TAGS.find((entry) => entry.tag === tag)?.minBody ?? 0;
}
function fencedRanges(text) {
  const marks = [];
  const re = /^[ \t]*(?:```|~~~)/gm;
  let match;
  while ((match = re.exec(text)) !== null) marks.push(match.index);
  const ranges = [];
  for (let i = 0; i + 1 < marks.length; i += 2) ranges.push([marks[i], marks[i + 1]]);
  return ranges;
}
function insideFence(index, ranges) {
  return ranges.some(([from, to]) => index >= from && index < to);
}
function hasImitatedMarker(text) {
  if (IMITATED_MARKER_TAGS.some((tag) => text.includes(`<${tag}`))) return true;
  return LONG_MARKER_TAGS.some((entry) => text.includes(`<${entry.tag}`));
}
var CLOSED_MARKER_RE = new RegExp(
  `<(${IMITATED_MARKER_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,
  "g"
);
var OPEN_MARKER_RE = new RegExp(`<(${IMITATED_MARKER_TAGS.join("|")})\\b[^>]*>[\\s\\S]*$`, "g");
var SystemMarkerStreamFilter = class {
  pending = "";
  captured = "";
  tag = "";
  fence = "";
  fenceSize = 0;
  limit = 1024 * 1024;
  push(text) {
    this.pending += text;
    return this.drain(false);
  }
  flush() {
    return this.drain(true);
  }
  drain(final) {
    let out = "", stripped = false;
    const names = [...IMITATED_MARKER_TAGS, ...LONG_MARKER_TAGS.map((x) => x.tag)];
    const opener = new RegExp("<(" + names.join("|") + ")\\b[^>]*>");
    while (this.pending.length) {
      const nl = this.pending.indexOf("\n");
      if (nl < 0 && !final) {
        if (this.fence === "" && !this.tag && !this.pending.includes("<") && !/^[ \t]{0,3}[`~]/.test(this.pending)) {
          out += this.pending;
          this.pending = "";
        }
        break;
      }
      let line = nl < 0 ? this.pending : this.pending.slice(0, nl + 1);
      this.pending = nl < 0 ? "" : this.pending.slice(nl + 1);
      if (!this.tag) {
        const mark = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
        if (this.fence) {
          out += line;
          if (mark && mark[1][0] === this.fence && mark[1].length >= this.fenceSize && !line.slice(mark[0].length).trim()) this.fence = "";
          continue;
        }
        if (mark) {
          this.fence = mark[1][0];
          this.fenceSize = mark[1].length;
          out += line;
          continue;
        }
      }
      while (line) {
        if (!this.tag) {
          const match = opener.exec(line);
          if (!match) {
            out += line;
            break;
          }
          out += line.slice(0, match.index);
          this.tag = match[1];
          this.captured = match[0];
          line = line.slice(match.index + match[0].length);
        }
        const close = "</" + this.tag + ">";
        const at = line.indexOf(close);
        if (at < 0) {
          this.captured += line;
          line = "";
          break;
        }
        this.captured += line.slice(0, at + close.length);
        line = line.slice(at + close.length);
        const openEnd = this.captured.indexOf(">") + 1;
        const bodySize = this.captured.length - openEnd - close.length;
        const long = LONG_MARKER_TAGS.find((x) => x.tag === this.tag);
        if (!long || bodySize >= long.minBody) stripped = true;
        else out += this.captured;
        this.captured = "";
        this.tag = "";
      }
    }
    if (this.pending.length + this.captured.length > this.limit) {
      throw new Error("\u7CFB\u7EDF\u6807\u8BB0\u7F13\u51B2\u8D85\u8FC7 1 MiB\uFF0C\u62D2\u7EDD\u9759\u9ED8\u622A\u65AD\u6B63\u6587");
    }
    if (final && this.tag) {
      const long = LONG_MARKER_TAGS.find((x) => x.tag === this.tag);
      const bodySize = this.captured.length - this.captured.indexOf(">") - 1;
      if (!long || bodySize >= long.minBody) stripped = true;
      else out += this.captured;
      this.captured = "";
      this.tag = "";
    }
    return { text: out, stripped };
  }
};
function stripSystemMarkers(text) {
  if (!hasImitatedMarker(text)) return { text, stripped: false };
  const ranges = fencedRanges(text);
  let strippedLong = false;
  let source = text.replace(LONG_CLOSED_MARKER_RE, (match, tag, body, offset) => {
    if (String(body).length < minBodyFor(String(tag))) return match;
    if (insideFence(offset, ranges)) return match;
    strippedLong = true;
    return "";
  }).replace(LONG_OPEN_MARKER_RE, (match, tag, body, offset) => {
    if (String(body).length < minBodyFor(String(tag))) return match;
    if (insideFence(offset, ranges)) return match;
    strippedLong = true;
    return "";
  });
  text = source;
  let out = "";
  let inFence = false;
  let stripped = strippedLong;
  let i = 0;
  while (i < text.length) {
    const lineEnd = text.indexOf("\n", i);
    const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd + 1);
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) inFence = !inFence;
    if (!inFence) {
      out += line.replace(CLOSED_MARKER_RE, () => {
        stripped = true;
        return "";
      }).replace(OPEN_MARKER_RE, () => {
        stripped = true;
        return "";
      });
    } else {
      out += line;
    }
    i = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  return { text: out, stripped };
}
var WEB_DISCLAIMER = "\u672C\u56DE\u7B54\u7531 AI \u751F\u6210\uFF0C\u5185\u5BB9\u4EC5\u4F9B\u53C2\u8003\uFF0C\u8BF7\u4ED4\u7EC6\u7504\u522B";
function stripWebDisclaimer(text) {
  if (!text.includes(WEB_DISCLAIMER)) return { text, stripped: false };
  return { text: text.split(WEB_DISCLAIMER).join(""), stripped: true };
}
function drainTextPipeline(filter, boilerplate, guard, cleanMarkers = true) {
  const tailGuarded = guard.flush();
  const tailBoiled = boilerplate.flush();
  const tail = filter.flush();
  const raw = tailGuarded.text + tailBoiled.text + tail.text;
  const dedisclaimered = stripWebDisclaimer(raw);
  const cleaned = cleanMarkers ? stripSystemMarkers(dedisclaimered.text) : { text: dedisclaimered.text, stripped: false };
  return {
    text: cleaned.text,
    echoed: tailGuarded.echoed,
    disclaimers: boilerplate.count + (dedisclaimered.stripped ? 1 : 0),
    calls: tail.calls,
    rejected: tail.rejected,
    fenced: tail.fenced
  };
}
var BoilerplateFilter = class {
  pending = "";
  hits = 0;
  stripped = false;
  holdChars = WEB_DISCLAIMER.length - 1;
  push(text) {
    this.pending += text;
    let out = "";
    for (; ; ) {
      const at = this.pending.indexOf(WEB_DISCLAIMER);
      if (at !== -1) {
        out += this.pending.slice(0, at);
        this.pending = this.pending.slice(at + WEB_DISCLAIMER.length);
        this.hits += 1;
        this.stripped = true;
        continue;
      }
      const hold = Math.min(this.pending.length, this.holdChars);
      out += this.pending.slice(0, this.pending.length - hold);
      this.pending = this.pending.slice(this.pending.length - hold);
      return { text: out, stripped: this.stripped };
    }
  }
  flush() {
    const rest = this.pending;
    this.pending = "";
    return { text: rest, stripped: this.stripped };
  }
  /** 本次流剥掉了几处声明（用于留痕）。 */
  get count() {
    return this.hits;
  }
};
var ECHO_SIGNATURES = [
  /^\[\s*Tool Result\b/i,
  /^\[\s*status\s*:\s*[a-z_]+\s*\]$/i,
  /^\[\s*(?:System|Assistant)\s*\]$/i
];
var ECHO_TURN_RE = /^(?:User|Assistant)\s*:/;
var ECHO_INLINE_WEAK_SIGNATURES = [
  /\[\s*Tool Result\b/i,
  /\[\s*status\s*:/i,
  /\[\s*(?:System|Assistant)\s*\]/i
];
var ECHO_INLINE_STRONG_SIGNATURES = [
  /\[\s*truncated\s*\]/i,
  /assistant\s+truncated/i,
  /\[\s*\d+\s*chars?\s+omitted\s*\]/i
];
var ECHO_INLINE_SIGNATURES = [
  ...ECHO_INLINE_WEAK_SIGNATURES,
  ...ECHO_INLINE_STRONG_SIGNATURES
];
var WEAK_HOLD_LINES = 2;
var MAX_HELD_TAIL = 6;
var ECHO_BARE_TURN_RE = /^(?:User|Assistant)\s*:\s*$/;
var ECHO_PREFIXES = ["[tool result", "[status:", "[system]", "[assistant]"];
function looksLikeEchoPrefix(line) {
  const t = line.trim().toLowerCase();
  return t.length > 0 && ECHO_PREFIXES.some((p) => p.startsWith(t));
}
var TranscriptEchoGuard = class {
  pending = "";
  inFence = false;
  /**
   * 已扣住、尚未判定的一行（等后文决定它是回声还是正文）。
   * 两种来源：转写轮次行（`User:` / `Assistant:` 后有内容）、行内弱特征行（正文里引用了一次 `[Tool Result …]`）。
   */
  heldLine = null;
  heldKind = null;
  /** 弱特征行之后已看到的**非空白**普通行数（够 `WEAK_HOLD_LINES` 行仍无回声 → 判为正文、放行）。 */
  heldSeen = 0;
  /**
   * 扣住期间**后续行也要缓冲**，否则它们会抢在被扣的那行之前上屏（顺序错乱）。
   * 放行时按原顺序一次性吐出；判回声时整段丢弃。
   */
  heldTail = [];
  fired = false;
  /**
   * @returns `text` = 可以安全上屏的部分；`echoed` = 本轮是否出现过回声（那部分已被丢弃）。
   */
  push(text) {
    if (this.fired) return { text: "", echoed: true };
    this.pending += text;
    let out = "";
    for (; ; ) {
      const nl = this.pending.indexOf("\n");
      if (nl === -1) break;
      const line = this.pending.slice(0, nl + 1);
      this.pending = this.pending.slice(nl + 1);
      const verdict = this.classify(line);
      if (verdict === "echo") {
        this.fired = true;
        this.pending = "";
        this.heldLine = null;
        this.heldKind = null;
        this.heldTail = [];
        return { text: out, echoed: true };
      }
      if (verdict === "turn" || verdict === "weak") {
        if (this.heldLine !== null) {
          this.fired = true;
          this.pending = "";
          this.heldLine = null;
          this.heldKind = null;
          this.heldTail = [];
          return { text: out, echoed: true };
        }
        this.heldLine = line;
        this.heldKind = verdict;
        this.heldSeen = 0;
        continue;
      }
      if (this.heldLine !== null) {
        this.heldTail.push(line);
        const blank = line.trim() === "";
        const release = (this.heldKind === "turn" ? !blank : !blank && ++this.heldSeen >= WEAK_HOLD_LINES) || // 兜底：一直只有空行时别无限扣（最多扣 `MAX_HELD_TAIL` 行就开始放行）
        this.heldTail.length >= MAX_HELD_TAIL;
        if (release) {
          out += this.heldLine;
          for (const held of this.heldTail) out += held;
          this.heldLine = null;
          this.heldKind = null;
          this.heldTail = [];
        }
        continue;
      }
      out += line;
    }
    return { text: out, echoed: false };
  }
  flush() {
    if (this.fired) return { text: "", echoed: true };
    let out = "";
    if (this.heldLine !== null) {
      out += this.heldLine;
      for (const held of this.heldTail) out += held;
      this.heldLine = null;
      this.heldKind = null;
      this.heldTail = [];
    }
    const rest = this.pending;
    this.pending = "";
    if (rest && (this.classify(rest) === "echo" || looksLikeEchoPrefix(rest))) {
      this.fired = true;
      return { text: out, echoed: true };
    }
    return { text: out + rest, echoed: false };
  }
  classify(line) {
    const t = line.trim();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      this.inFence = !this.inFence;
      return "fence";
    }
    if (this.inFence) return "plain";
    for (const re of ECHO_SIGNATURES) if (re.test(t)) return "echo";
    if (/^\]?\s*truncated\s*\]?\s*$/i.test(t)) return "echo";
    for (const re of ECHO_INLINE_STRONG_SIGNATURES) if (re.test(t)) return "echo";
    if (ECHO_BARE_TURN_RE.test(t)) return "echo";
    if (ECHO_TURN_RE.test(t)) {
      for (const re of ECHO_INLINE_WEAK_SIGNATURES) if (re.test(t)) return "echo";
      return "turn";
    }
    for (const re of ECHO_INLINE_WEAK_SIGNATURES) if (re.test(t)) return "weak";
    return "plain";
  }
};
var CONTINUE_INSTRUCTION = "\u7EE7\u7EED\uFF1A\u8BF7\u4ECE\u4F60\u4E0A\u4E00\u6761\u56DE\u590D\u7684\u7ED3\u5C3E\u5904\u65E0\u7F1D\u63A5\u7740\u5F80\u4E0B\u5199\u2014\u2014\u4E0D\u8981\u91CD\u590D\u4EFB\u4F55\u5DF2\u8F93\u51FA\u7684\u5185\u5BB9\uFF0C\u4E0D\u8981\u52A0\u300C\u597D\u7684\u300D\u300C\u4EE5\u4E0B\u662F\u300D\u4E4B\u7C7B\u7684\u5F00\u573A\u767D\uFF0C\u4E0D\u8981\u91CD\u65B0\u7EC4\u7EC7\u8BED\u8A00\uFF1B\u5982\u679C\u4E0A\u4E00\u6761\u56DE\u590D\u505C\u5728\u53E5\u5B50\u4E2D\u95F4\uFF0C\u5C31\u4ECE\u90A3\u4E2A\u65AD\u70B9\u76F4\u63A5\u628A\u53E5\u5B50\u5199\u5B8C\u5E76\u7EE7\u7EED\u3002";
var TOOL_CALL_RETRY_INSTRUCTION = '\u4F60\u521A\u624D\u628A\u8981\u6267\u884C\u7684\u7A0B\u5E8F\u5199\u8FDB\u4E86\u6B63\u6587\u6587\u672C\u3002\u5199\u5728\u6B63\u6587\u91CC\u7684\u4EE3\u7801\u4E0D\u4F1A\u88AB\u6267\u884C \u2014\u2014 \u8FD9\u4E00\u8F6E\u56E0\u6B64\u6CA1\u6709\u53D1\u751F\u4EFB\u4F55\u5DE5\u5177\u8C03\u7528\u3002\n\u8BF7\u628A\u540C\u4E00\u6BB5\u7A0B\u5E8F\u4F5C\u4E3A\u5DE5\u5177\u8C03\u7528\u91CD\u65B0\u53D1\u51FA\uFF1A\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u524D\u540E\u4E0D\u8981\u6709\u4EFB\u4F55\u5176\u5B83\u6587\u5B57\uFF1A\n{"tool_calls":[{"name":"<\u5DE5\u5177\u540D>","arguments":{...}}]}\n\u5373\u4F7F\u7CFB\u7EDF\u63D0\u793A\u8981\u6C42\u4F60\u5199 TypeScript \u7A0B\u5E8F\u6765\u5B8C\u6210\u52A8\u4F5C\uFF0C\u90A3\u4E2A\u7A0B\u5E8F\u4E5F\u5FC5\u987B\u653E\u8FDB\u5DE5\u5177\u8C03\u7528\u7684 arguments \u91CC\uFF0C\u4E0D\u80FD\u76F4\u63A5\u5199\u5728\u6B63\u6587\u4E2D \u2014\u2014 \u53EA\u6709\u4F5C\u4E3A\u5DE5\u5177\u8C03\u7528\u53D1\u51FA\uFF0C\u5B83\u624D\u4F1A\u771F\u7684\u88AB\u6267\u884C\u3002';

// src/context-feed.ts
var DEFAULT_CONTEXT_MODE = "full";
function normalizeContextMode(value) {
  return value === "full" || value === "chained" ? value : void 0;
}
var CONTEXT_MODE_HINT = "\u94FE\u5F0F\u6295\u5582\uFF1A\u4E4B\u540E\u6BCF\u8F6E\u53EA\u53D1\u65B0\u589E\u5185\u5BB9\uFF0C\u5E76\u628A\u4E0A\u4E00\u6761\u56DE\u7B54\u6302\u5230\u7236\u6D88\u606F\u4E0A\uFF0C\u8BA9\u670D\u52A1\u7AEF\u81EA\u5DF1\u7EF4\u62A4\u4E0A\u4E0B\u6587 \u2014\u2014 \u8BF7\u6C42\u4F53\u5C0F\u5F97\u591A\u3001\u4E5F\u66F4\u50CF\u771F\u4EBA\u8FDE\u7EED\u5BF9\u8BDD\u3002\u4EE3\u4EF7\u662F\u5DE5\u5177\u534F\u8BAE\u53EA\u5B58\u5728\u4E8E\u94FE\u9996\u90A3\u6761\u6D88\u606F\u91CC\uFF0C\u4E00\u65E6\u670D\u52A1\u7AEF\u628A\u65E9\u671F\u4E0A\u4E0B\u6587\u4E22\u6389\uFF0C\u6A21\u578B\u53EF\u80FD\u4E0D\u6309\u7EA6\u5B9A\u683C\u5F0F\u53D1\u5DE5\u5177\u8C03\u7528\uFF1B\u672C\u63D2\u4EF6\u9047\u5230\u4EFB\u4F55\u4E0D\u786E\u5B9A\u4F1A\u81EA\u52A8\u9000\u56DE\u5168\u91CF\u91CD\u53D1\u3002\u6BCF\u8F6E\u5168\u91CF\uFF1A\u6700\u7A33\uFF0C\u884C\u4E3A\u548C\u4EE5\u524D\u5B8C\u5168\u4E00\u81F4\uFF08\u7F51\u9875\u7AEF\u4F1A\u770B\u5230\u6BCF\u6761\u6D88\u606F\u90FD\u5E26\u7740\u5B8C\u6574\u63D0\u793A\u8BCD\uFF09\u3002";
function isContinuationCue(entry) {
  const text = String(entry ?? "").trim();
  return text === `User: ${CONTINUE_INSTRUCTION}` || text === `User: ${TOOL_CALL_RETRY_INSTRUCTION}`;
}
function isAssistantTranscriptEntry(entry) {
  return typeof entry === "string" && /^\s*Assistant:/.test(entry);
}
function firstDifference(prev, next) {
  const shared = Math.min(prev.length, next.length);
  for (let i = 0; i < shared; i += 1) if (prev[i] !== next[i]) return i;
  return shared;
}
function needsFreshSession(feed, reused, mode, hasPromptParts = true, allowRestartSwap = currentFreshSessionOnRestart()) {
  if (mode !== "chained") return false;
  if (!hasPromptParts) return false;
  if (!allowRestartSwap) return false;
  return feed.parentMessageId === null && reused;
}
var DEFAULT_FRESH_SESSION_ON_RESTART = false;
var freshSessionOnRestart = DEFAULT_FRESH_SESSION_ON_RESTART;
function currentFreshSessionOnRestart() {
  return freshSessionOnRestart;
}
function applyFreshSessionOnRestart(value) {
  freshSessionOnRestart = value === true;
  return freshSessionOnRestart;
}
function effectiveReuseLimit(maxTurns, mode) {
  if (!(maxTurns > 0)) return maxTurns;
  return mode === "chained" ? Number.POSITIVE_INFINITY : maxTurns;
}
function canExtendChain(prev, next) {
  if (next.length <= prev.length) return false;
  return next[prev.length - 1] === prev[prev.length - 1];
}
function decideFeed(input) {
  const full = input.full;
  if (input.mode !== "chained") return { prompt: full, parentMessageId: null, next: void 0, reason: "mode-full" };
  const head = input.head;
  const entries = input.entries;
  if (typeof head !== "string" || !Array.isArray(entries)) {
    return { prompt: full, parentMessageId: null, next: void 0, reason: "no-parts" };
  }
  const detach = (reason) => ({
    prompt: full,
    parentMessageId: null,
    next: { head, entries: entries.slice(), sessionId: input.sessionId, accountKey: input.accountKey },
    reason
  });
  const replay = (reason, options = {}) => {
    const prompt = replayPrompt(options);
    return {
      prompt,
      parentMessageId: chain.parentId,
      next: { head, entries: entries.slice(), sessionId: input.sessionId, accountKey: input.accountKey },
      reason
    };
  };
  const replayPrompt = ({ headUnchanged = false, from }) => {
    if (headUnchanged) {
      const budget = Number.isFinite(input.maxChars) ? input.maxChars : Number.POSITIVE_INFINITY;
      const usable = (text) => text.trim().length > 0 && text.length <= budget;
      if (from !== void 0 && from < entries.length) {
        const tail = entries.slice(from);
        const withoutEcho = tail.filter((line) => !isAssistantTranscriptEntry(line));
        const tailText = (withoutEcho.length > 0 ? withoutEcho : tail).join("\n\n");
        if (usable(tailText)) return tailText;
      }
      const noEcho = entries.filter((line) => !isAssistantTranscriptEntry(line)).join("\n\n");
      if (usable(noEcho)) return noEcho;
      if (typeof input.transcript === "string" && usable(input.transcript)) return input.transcript;
    }
    return full;
  };
  if (!input.reused) return detach("new-session");
  const chain = input.chain;
  if (!chain) return detach("no-chain");
  if (chain.sessionId !== input.sessionId) return detach("session-changed");
  if (chain.accountKey !== input.accountKey) return detach("account-changed");
  if (chain.head !== head) return replay("head-changed");
  if (!canExtendChain(chain.entries, entries)) {
    return replay("not-appended", { headUnchanged: true, from: firstDifference(chain.entries, entries) });
  }
  const appended = entries.slice(chain.entries.length);
  const continuation = appended.some((line) => isContinuationCue(line));
  const meaningful = continuation ? appended : appended.filter((line) => !isAssistantTranscriptEntry(line));
  const echoDropped = meaningful.length > 0 ? appended.length - meaningful.length : 0;
  const delta = (meaningful.length > 0 ? meaningful : appended).join("\n\n");
  if (delta.trim().length === 0) return replay("empty-delta");
  const cap = input.maxChars;
  if (typeof cap === "number" && Number.isFinite(cap) && cap > 0 && delta.length > cap) {
    return replay("delta-too-long");
  }
  return {
    prompt: delta,
    parentMessageId: chain.parentId,
    next: { head, entries: entries.slice(), sessionId: input.sessionId, accountKey: input.accountKey },
    reason: "chained",
    ...echoDropped > 0 ? { echoDropped } : {}
  };
}
var currentMode = DEFAULT_CONTEXT_MODE;
function currentContextMode() {
  return currentMode;
}
function applyContextMode(mode) {
  currentMode = mode;
  return currentMode;
}
function contextModeSettingsPath() {
  return join4(resolveDshHome(), "web-login", "context-feed.json");
}
function readContextModeSetting() {
  try {
    const file = contextModeSettingsPath();
    if (!existsSync3(file)) return void 0;
    const parsed = JSON.parse(readFileSync3(file, "utf8"));
    return normalizeContextMode(parsed?.contextMode);
  } catch {
    return void 0;
  }
}
function writeContextModeSetting(mode) {
  const file = contextModeSettingsPath();
  mkdirSync3(join4(file, ".."), { recursive: true });
  writeFileSync3(file, JSON.stringify({ contextMode: mode }, null, 2) + "\n", "utf8");
}

// src/browser-transport.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync5, rmSync as rmSync3 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join6 } from "node:path";

// src/browser-login.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync4, rmSync as rmSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
function findSystemBrowser() {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || join5(homedir3(), "AppData", "Local");
  const candidates = process.platform === "win32" ? [
    { name: "Microsoft Edge", path: join5(pf86, "Microsoft", "Edge", "Application", "msedge.exe") },
    { name: "Microsoft Edge", path: join5(pf, "Microsoft", "Edge", "Application", "msedge.exe") },
    { name: "Google Chrome", path: join5(pf, "Google", "Chrome", "Application", "chrome.exe") },
    { name: "Google Chrome", path: join5(pf86, "Google", "Chrome", "Application", "chrome.exe") },
    { name: "Google Chrome", path: join5(local, "Google", "Chrome", "Application", "chrome.exe") }
  ] : process.platform === "darwin" ? [
    { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }
  ] : [
    { name: "Google Chrome", path: "/usr/bin/google-chrome" },
    { name: "Chromium", path: "/usr/bin/chromium" },
    { name: "Chromium", path: "/usr/bin/chromium-browser" },
    { name: "Microsoft Edge", path: "/usr/bin/microsoft-edge" }
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync4(candidate.path)) return candidate;
    } catch {
    }
  }
  return null;
}
function buildBrowserArgs(profileDir, url) {
  return [
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    // 别把用户的默认浏览器设置/会话搅进来
    "--no-service-autorun",
    "--disable-background-mode",
    // ⚠️ 这里**故意不放** `--no-sandbox` —— 见 `transportExtraArgs()` 的说明。
    //   本函数被**登录窗口**（可见真实浏览器，用户在里面手动登录）与
    //   **请求代理**（headless 后台）共用；sandbox 只该关后者。
    url
  ];
}
function transportExtraArgs() {
  return ["--no-sandbox"];
}
function parseDevToolsActivePort(text) {
  const first = String(text ?? "").split(/\r?\n/)[0]?.trim();
  if (!first) return void 0;
  const port = Number(first);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : void 0;
}
function buildCookieHeader(cookies) {
  return (cookies ?? []).filter((cookie) => cookie && typeof cookie.name === "string" && String(cookie.domain ?? "").includes("deepseek")).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
var FINGERPRINT_HEADER_RE = /^(?:x-|sec-ch-ua|sec-fetch-)/;
var FINGERPRINT_HEADER_EXACT = /* @__PURE__ */ new Set(["priority", "accept", "accept-language"]);
var PER_REQUEST_HEADERS = /* @__PURE__ */ new Set([
  "x-ds-pow-response",
  "x-hif-dliq",
  "x-hif-leim",
  "authorization",
  "cookie",
  "content-type",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
  "accept-encoding",
  "origin",
  "referer",
  "user-agent"
  // 单独存 auth.userAgent（它要参与请求头，但需要单独的字段）
]);
function pickExtraHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase();
    if (PER_REQUEST_HEADERS.has(lower)) continue;
    if (!FINGERPRINT_HEADER_RE.test(lower) && !FINGERPRINT_HEADER_EXACT.has(lower)) continue;
    out[lower] = String(value);
  }
  return out;
}
var CdpClient = class {
  socket;
  nextId = 0;
  pending = /* @__PURE__ */ new Map();
  listeners = [];
  opened = false;
  url;
  // ⚠️ 不用 TS 的「参数属性」写法（constructor(private readonly url: string)）：
  // 那是需要**转换**的语法，Node 的 strip-only 类型剥离不支持（测试直接跑源码会报
  // "TypeScript parameter property is not supported in strip-only mode"）。
  constructor(url) {
    this.url = url;
  }
  /**
   * 建连（审计 F15）。
   *
   * 三处旧问题：① 只监听 open/error，**close 不结算** → 建连时对端关闭会一直等到超时；
   * ② 超时后 socket 仍可能在之后 open —— 成为一条**没人持有的孤立连接**；
   * ③ error/超时后没有主动释放 socket。现在统一走 `finish()`：只结算一次、清掉定时器与监听，
   * 失败时顺便 `this.close()` 把 socket 收掉。
   */
  async connect(timeoutMs = 1e4) {
    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== "function") throw new Error("\u5F53\u524D Node \u6CA1\u6709\u5168\u5C40 WebSocket\uFF0C\u65E0\u6CD5\u4F7F\u7528 CDP");
    const socket = new WebSocketCtor(this.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onFail);
        socket.removeEventListener("close", onClosed);
        if (error) {
          this.close();
          reject(error);
        } else {
          this.opened = true;
          resolve();
        }
      };
      const onOpen = () => finish();
      const onFail = () => finish(new Error("CDP \u8FDE\u63A5\u5931\u8D25"));
      const onClosed = () => finish(new Error("CDP \u5EFA\u8FDE\u65F6\u8FDE\u63A5\u88AB\u5173\u95ED"));
      const timer = setTimeout(() => finish(new Error("CDP \u8FDE\u63A5\u8D85\u65F6")), timeoutMs);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onFail);
      socket.addEventListener("close", onClosed);
    });
    socket.addEventListener("close", () => this.close());
    socket.addEventListener("error", () => this.close());
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) {
          item.reject(new Error(`CDP \u9519\u8BEF ${message.error.code ?? ""}: ${message.error.message ?? ""}`));
        } else {
          item.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        for (const listener of this.listeners) {
          try {
            listener(message.method, message.params);
          } catch {
          }
        }
      }
    });
  }
  onEvent(listener) {
    this.listeners.push(listener);
  }
  send(method, params = {}, timeoutMs = 15e3) {
    if (!this.opened) return Promise.reject(new Error("CDP \u672A\u8FDE\u63A5"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} \u8D85\u65F6`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  close() {
    this.opened = false;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("CDP \u5DF2\u5173\u95ED"));
    }
    this.pending.clear();
    this.listeners = [];
    const socket = this.socket;
    this.socket = void 0;
    try {
      if (socket && socket.readyState < 2) socket.close();
    } catch {
    }
  }
};
var DEFAULT_TIMEOUT_MS = 5 * 6e4;
var DEFAULT_PROFILE_DIR = join5(process.env.DSH_HOME || join5(homedir3(), ".dsh"), "web-login", "browser-profile");
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function cdpJson(port, endpoint, signal) {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(2e3)]) : AbortSignal.timeout(2e3);
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: bounded, redirect: "error" });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {
    });
    throw new Error("CDP HTTP \u8BF7\u6C42\u5931\u8D25");
  }
  return await res.json();
}
var lastSpawnedChild;
function isDeepSeekPage(target) {
  try {
    return target?.type === "page" && new URL(String(target.url)).origin === DS_BASE;
  } catch {
    return false;
  }
}
async function waitForDebugPort(profileDir, child, timeoutMs, signal) {
  const portFile = join5(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return void 0;
    if (child.exitCode !== null) return void 0;
    try {
      const port = parseDevToolsActivePort(readFileSync4(portFile, "utf8"));
      if (port) {
        try {
          await cdpJson(port, "/json/version", signal);
          return port;
        } catch {
        }
      }
    } catch {
    }
    await sleep(300);
  }
  return void 0;
}
async function findPageTarget(port, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    try {
      const targets = await cdpJson(port, "/json/list", signal);
      const page = Array.isArray(targets) ? targets.find((t) => isDeepSeekPage(t)) : void 0;
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
    }
    await sleep(400);
  }
  return null;
}
function buildAutoLoginExpression(email, password) {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let deviceId = null;
    try {
      if (window.SMSdk && window.SMSdk.ready) {
        deviceId = await Promise.race([
          new Promise((res) => window.SMSdk.ready(() => res(window.SMSdk.getDeviceId ? window.SMSdk.getDeviceId() : null))),
          wait(15000).then(() => null),
        ]);
      }
    } catch (e) { deviceId = null; }
    if (!deviceId) return { ok: false, stage: 'sdk', error: '\u6570\u7F8E\u8BBE\u5907\u6307\u7EB9 SDK \u6CA1\u5C31\u7EEA\uFF0C\u62FF\u4E0D\u5230 device_id' };
    let resp, text;
    try {
      resp = await fetch('/api/v0/users/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: ${JSON.stringify(email)},
          mobile: '',
          password: ${JSON.stringify(password)},
          area_code: '',
          device_id: deviceId,
          os: 'web',
        }),
      });
      text = await resp.text();
    } catch (e) {
      return { ok: false, stage: 'request', error: '\u767B\u5F55\u8BF7\u6C42\u53D1\u4E0D\u51FA\u53BB\uFF1A' + String(e) };
    }
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    const data = (json && json.data) || {};
    const user = (data.biz_data && data.biz_data.user) || null;
    if (!user || !user.token) {
      const code = data.biz_code;
      const msg = data.biz_msg || '';
      const why = code === 11 || msg === 'RISK_DEVICE_DETECTED' ? '\u88AB\u98CE\u63A7\u5224\u5B9A\u4E3A\u53EF\u7591\u8BBE\u5907' : msg || '\u670D\u52A1\u7AEF\u6CA1\u8FD4\u56DE token';
      return { ok: false, stage: 'login', bizCode: code, bizMsg: msg, error: '\u767B\u5F55\u6CA1\u6210\u529F\uFF1A' + why };
    }
    try {
      localStorage.setItem('userToken', JSON.stringify({ value: user.token, __version: '0' }));
    } catch (e) {}
    return { ok: true, stage: 'ok', bizCode: data.biz_code, bizMsg: data.biz_msg || '' };
  })()`;
}
async function tryAutoLogin(cdp, credentials) {
  try {
    const value = await cdp.send("Runtime.evaluate", {
      expression: buildAutoLoginExpression(credentials.email, credentials.password),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (value?.exceptionDetails) {
      return { ok: false, error: `\u9875\u9762\u91CC\u62A5\u9519\uFF1A${value.exceptionDetails.text ?? ""}` };
    }
    const result = value?.result?.value;
    if (!result) return { ok: false, error: "\u9875\u9762\u6CA1\u6709\u8FD4\u56DE\u7ED3\u679C" };
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "\u767B\u5F55\u6CA1\u6210\u529F" };
  } catch (error) {
    return { ok: false, error: `\u81EA\u52A8\u767B\u5F55\u8C03\u7528\u5931\u8D25\uFF1A${error?.message ?? error}` };
  }
}
async function browserLogin(options = {}) {
  const browser = findSystemBrowser();
  if (!browser) {
    return {
      ok: false,
      reason: "no-browser",
      message: "\u6CA1\u6709\u627E\u5230 Edge/Chrome\u3002\u8BF7\u6539\u7528\u300C\u7528\u6211\u7684\u9ED8\u8BA4\u6D4F\u89C8\u5668\u767B\u5F55\u300D+ \u624B\u52A8\u7C98\u8D34 Token\u3002"
    };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
  const pollIntervalMs = options.pollIntervalMs ?? 1200;
  const progress2 = options.onProgress ?? (() => {
  });
  try {
    mkdirSync4(profileDir, { recursive: true });
  } catch {
  }
  progress2(`\u6B63\u5728\u542F\u52A8 ${browser.name}\uFF08\u72EC\u7ACB profile\uFF0C\u4E0D\u4F1A\u5F71\u54CD\u4F60\u65E5\u5E38\u6D4F\u89C8\u5668\u7684\u767B\u5F55\u6001\uFF09\u2026\u2026`);
  let child;
  try {
    child = spawn(browser.path, buildBrowserArgs(profileDir, `${DS_BASE}/`), {
      stdio: "ignore",
      detached: false
    });
    lastSpawnedChild = child;
  } catch (error) {
    return { ok: false, reason: "spawn-failed", message: `\u542F\u52A8 ${browser.name} \u5931\u8D25\uFF1A${error?.message ?? error}` };
  }
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
    progress2(`${browser.name} \u542F\u52A8\u5931\u8D25\uFF08\u5F02\u6B65\u9519\u8BEF\uFF09\uFF1A${error?.message ?? error}`);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (spawnError) {
    try {
      child.kill();
    } catch {
    }
    return {
      ok: false,
      reason: "spawn-failed",
      message: `\u542F\u52A8 ${browser.name} \u5931\u8D25\uFF1A${spawnError.message}`
    };
  }
  const cleanupBrowser = () => {
    try {
      child.kill();
    } catch {
    }
  };
  const port = await waitForDebugPort(profileDir, child, 25e3, options.signal);
  if (!port) {
    cleanupBrowser();
    return {
      ok: false,
      reason: "no-debug-port",
      message: `${browser.name} \u8D77\u6765\u4E86\u4F46\u8C03\u8BD5\u7AEF\u53E3\u4E0D\u53EF\u7528\uFF08\u53EF\u80FD\u88AB\u5B89\u5168\u8F6F\u4EF6\u62E6\u622A\uFF09\u3002\u8BF7\u6539\u7528\u300C\u7528\u6211\u7684\u9ED8\u8BA4\u6D4F\u89C8\u5668\u767B\u5F55\u300D+ \u624B\u52A8\u7C98\u8D34 Token\u3002`
    };
  }
  const page = await findPageTarget(port, 2e4, options.signal);
  if (!page) {
    cleanupBrowser();
    return { ok: false, reason: "no-page", message: `${browser.name} \u91CC\u6CA1\u627E\u5230 chat.deepseek.com \u9875\u9762\u3002` };
  }
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  try {
    await cdp.connect();
  } catch (error) {
    cleanupBrowser();
    return { ok: false, reason: "cdp-failed", message: `\u8FDE\u63A5\u6D4F\u89C8\u5668\u8C03\u8BD5\u63A5\u53E3\u5931\u8D25\uFF1A${error?.message ?? error}` };
  }
  let extraHeaders = {};
  let apiUserAgent = "";
  cdp.onEvent((method, params) => {
    if (method !== "Network.requestWillBeSent" && method !== "Network.requestWillBeSentExtraInfo") return;
    const url = String(params?.request?.url ?? "");
    const headers = (method === "Network.requestWillBeSentExtraInfo" ? params?.headers : params?.request?.headers) ?? {};
    if (!url.includes("/api/")) return;
    const lower = {};
    for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = String(value);
    if (lower["user-agent"]) apiUserAgent = lower["user-agent"];
    if (Object.keys(extraHeaders).length === 0) extraHeaders = pickExtraHeaders(lower);
  });
  await cdp.send("Runtime.enable").catch(() => {
  });
  let autoLoginError;
  if (options.credentials) {
    progress2("\u6B63\u5728\u7528\u5DF2\u4FDD\u5B58\u7684\u90AE\u7BB1\u5BC6\u7801\u81EA\u52A8\u767B\u5F55\u2026");
    const auto = await tryAutoLogin(cdp, options.credentials);
    if (auto.ok) progress2("\u81EA\u52A8\u767B\u5F55\u6210\u529F\uFF0C\u6B63\u5728\u8BFB\u53D6 cookie \u4E0E\u6307\u7EB9\u5934\u2026\u2026");
    else {
      autoLoginError = auto.error;
      progress2(`\u81EA\u52A8\u767B\u5F55\u6CA1\u6210\u529F\uFF08${auto.error}\uFF09\uFF0C\u8BF7\u5728\u7A97\u53E3\u91CC\u624B\u52A8\u767B\u5F55\u2026`);
    }
  }
  await cdp.send("Network.enable").catch(() => {
  });
  progress2("\u6D4F\u89C8\u5668\u5DF2\u6253\u5F00\uFF1A\u8BF7\u5728\u5176\u4E2D\u767B\u5F55 DeepSeek\uFF08\u624B\u673A\u53F7/\u90AE\u7BB1/\u626B\u7801\u5747\u53EF\uFF09\u3002\u767B\u5F55\u6210\u529F\u540E\u4F1A\u81EA\u52A8\u6355\u83B7\uFF0C\u65E0\u9700\u590D\u5236\u7C98\u8D34\u3002");
  const deadline = Date.now() + timeoutMs;
  let lastNotice = 0;
  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        cdp.close();
        cleanupBrowser();
        return { ok: false, reason: "aborted", message: "\u5DF2\u53D6\u6D88\u767B\u5F55\u3002" };
      }
      if (child.exitCode !== null || child.killed) {
        cleanupBrowser();
        return { ok: false, reason: "browser-closed", message: "\u6D4F\u89C8\u5668\u5DF2\u5173\u95ED\uFF0C\u767B\u5F55\u5DF2\u53D6\u6D88\u3002\u9700\u8981\u7684\u8BDD\u518D\u70B9\u4E00\u6B21\u300C\u6D4F\u89C8\u5668\u7A97\u53E3\u767B\u5F55\u300D\u5373\u53EF\u3002" };
      }
      let token = "";
      let pageUserAgent = "";
      try {
        const value = await cdp.send("Runtime.evaluate", {
          expression: "String(localStorage.getItem('userToken') || '')",
          returnByValue: true
        });
        token = unwrapStoredToken(String(value?.result?.value ?? ""));
        const ua = await cdp.send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
        pageUserAgent = String(ua?.result?.value ?? "");
      } catch {
      }
      if (token) {
        progress2("\u5DF2\u6355\u83B7 token\uFF0C\u6B63\u5728\u8BFB\u53D6 cookie \u4E0E\u6307\u7EB9\u5934\u2026\u2026");
        let cookie = "";
        let cookieMeta = [];
        try {
          const cookies = await cdp.send("Storage.getCookies", {});
          const raw = cookies?.cookies ?? [];
          cookie = buildCookieHeader(raw);
          cookieMeta = pickCookieMeta(raw, (domain) => String(domain ?? "").includes("deepseek"));
        } catch {
        }
        const auth = {
          token,
          cookie,
          hifDliq: String(extraHeaders["x-hif-dliq"] ?? ""),
          hifLeim: String(extraHeaders["x-hif-leim"] ?? ""),
          wasmUrl: "",
          userAgent: apiUserAgent || pageUserAgent,
          ...Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {},
          ...cookieMeta.length > 0 ? { cookieMeta } : {},
          capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
          unverified: true
        };
        cdp.close();
        cleanupBrowser();
        return {
          ok: true,
          auth,
          message: `\u5DF2\u4ECE ${browser.name} \u6355\u83B7\u767B\u5F55\u6001\uFF08token + ${cookie ? "cookie + " : ""}\u6307\u7EB9\u5934\uFF09`,
          ...autoLoginError ? { autoLoginError } : {}
        };
      }
      if (Date.now() - lastNotice > 3e4) {
        lastNotice = Date.now();
        const left = Math.ceil((deadline - Date.now()) / 6e4);
        progress2(`\u7B49\u5F85\u767B\u5F55\u4E2D\u2026\u2026\uFF08\u8FD8\u5269\u7EA6 ${left} \u5206\u949F\uFF1B\u5DF2\u5728\u6D4F\u89C8\u5668\u91CC\u767B\u5F55\u7684\u8BDD\u4E0B\u4E00\u6B65\u5C31\u4F1A\u81EA\u52A8\u8BFB\u53D6\uFF09`);
      }
      await sleep(pollIntervalMs);
    }
    cdp.close();
    return {
      ok: false,
      reason: "timeout",
      browserLeftOpen: true,
      ...autoLoginError ? { autoLoginError } : {},
      message: `\u7B49\u4E86 ${Math.round(timeoutMs / 6e4)} \u5206\u949F\u6CA1\u8BFB\u5230\u767B\u5F55\u6001\u3002\u6D4F\u89C8\u5668\u7A97\u53E3\u4FDD\u7559\u7740\uFF0C\u767B\u5F55\u5B8C\u6210\u540E\u53EF\u4EE5\u518D\u70B9\u4E00\u6B21\u300C\u6D4F\u89C8\u5668\u7A97\u53E3\u767B\u5F55\u300D\uFF08profile \u590D\u7528\uFF0C\u4E0D\u7528\u91CD\u65B0\u767B\u5F55\uFF09\u3002`
    };
  } finally {
    cdp.close();
  }
}
function clearBrowserLoginProfile(profileDir = DEFAULT_PROFILE_DIR) {
  try {
    rmSync2(profileDir, { recursive: true, force: true });
    return true;
  } catch {
    try {
      lastSpawnedChild?.kill();
    } catch {
    }
    try {
      rmSync2(profileDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

// src/browser-transport.ts
var findSystemBrowser2 = findSystemBrowser;
var BINDING_NAME = "__dshBrowserTransportCallback";
var PROFILE_DIR = join6(process.env.DSH_HOME || join6(homedir4(), ".dsh"), "web-login", "transport-profile");
var activeSession;
var launchPromise;
var requests = /* @__PURE__ */ new Map();
function systemBrowserAvailable() {
  if (process.env.DSH_NO_BROWSER_TRANSPORT === "1") return false;
  return findSystemBrowser2() !== null;
}
async function waitForTransportDebugPort(profileDir, child, timeoutMs = 25e3) {
  const portFile = join6(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return void 0;
    try {
      const port = parseDevToolsActivePort(readFileSync5(portFile, "utf8"));
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(2e3),
            redirect: "error"
          });
          if (res.ok) return port;
        } catch {
        }
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return void 0;
}
async function findPageTarget2(port, timeoutMs = 2e4) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2e3)
      });
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
function handlePowBindingEvent(payload) {
  const sep = payload.indexOf(":");
  if (sep < 0) return;
  const requestId = payload.slice(0, sep);
  const rest = payload.slice(sep + 1);
  const state = powRequests.get(requestId);
  if (!state) return;
  const kindSep = rest.indexOf(":");
  const kind = kindSep < 0 ? rest : rest.slice(0, kindSep);
  const value = kindSep < 0 ? "" : rest.slice(kindSep + 1);
  if (kind === "ok") {
    state.onAnswer(Number(value));
  } else {
    state.onError(value || "unknown");
  }
}
function handleBindingEvent(payload) {
  let msg;
  try {
    msg = JSON.parse(payload);
  } catch {
    return;
  }
  const requestId = msg?.requestId;
  if (!requestId) return;
  const state = requests.get(requestId);
  if (!state) return;
  switch (msg.type) {
    case "headers": {
      if (state.streamStarted) return;
      state.streamStarted = true;
      state.resolveHeaders(msg.status ?? 200, msg.statusText ?? "", msg.headers ?? {});
      break;
    }
    case "chunk": {
      const arr = msg.chunk;
      if (Array.isArray(arr) && state.controller) {
        try {
          state.controller.enqueue(new Uint8Array(arr));
        } catch {
        }
      }
      break;
    }
    case "done": {
      if (state.controller) {
        try {
          state.controller.close();
        } catch {
        }
      }
      requests.delete(requestId);
      break;
    }
    case "error": {
      if (state.controller) {
        try {
          state.controller.error(new Error(String(msg.error ?? "\u6D4F\u89C8\u5668\u8BF7\u6C42\u5931\u8D25")));
        } catch {
        }
      }
      if (!state.streamStarted) {
        state.rejectHeaders(new Error(String(msg.error ?? "\u6D4F\u89C8\u5668\u8BF7\u6C42\u5931\u8D25")));
      }
      requests.delete(requestId);
      break;
    }
  }
}
async function launchBrowserTransport() {
  if (activeSession) return activeSession;
  if (launchPromise) return launchPromise;
  launchPromise = (async () => {
    const browser = findSystemBrowser2();
    if (!browser) throw new Error("\u672A\u627E\u5230 Edge/Chrome\uFF0C\u65E0\u6CD5\u542F\u52A8\u6D4F\u89C8\u5668\u4EE3\u7406\u4F20\u8F93\u5C42");
    try {
      if (existsSync5(PROFILE_DIR)) rmSync3(PROFILE_DIR, { recursive: true, force: true });
      mkdirSync5(PROFILE_DIR, { recursive: true });
    } catch (error) {
      throw new Error(`\u6E05\u7406 transport profile \u5931\u8D25\uFF1A${error?.message ?? error}`);
    }
    const child = spawn2(
      browser.path,
      [
        ...buildBrowserArgs(PROFILE_DIR, "about:blank"),
        // 🔴 2026-10-10：只给**这一处**（headless 请求代理）加 `--no-sandbox`。
        //   Linux 上 headless Chrome 要 sandbox，而 CI runner / 容器是 root ⇒ 起不来。
        //   ⚠️ **不能**加进 `buildBrowserArgs`：那个函数登录窗口也在用，
        //   而登录窗口要加载真实页面、用户在里面手动输密码 ⇒ 关它的 sandbox 才真的扩大攻击面。
        //   理由详见 `browser-login.ts: transportExtraArgs()` 的注释。
        ...transportExtraArgs(),
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--allow-insecure-localhost",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process"
      ],
      {
        stdio: "ignore",
        detached: false
      }
    );
    let spawnError;
    child.on("error", (err) => {
      spawnError = err;
    });
    await new Promise((r) => setTimeout(r, 300));
    if (spawnError) {
      try {
        child.kill();
      } catch {
      }
      throw new Error(`\u542F\u52A8\u6D4F\u89C8\u5668\u5931\u8D25\uFF1A${spawnError.message}`);
    }
    const port = await waitForTransportDebugPort(PROFILE_DIR, child);
    if (!port) {
      try {
        child.kill();
      } catch {
      }
      throw new Error("\u6D4F\u89C8\u5668\u8C03\u8BD5\u7AEF\u53E3\u672A\u5C31\u7EEA");
    }
    const page = await findPageTarget2(port);
    if (!page) {
      try {
        child.kill();
      } catch {
      }
      throw new Error("\u6D4F\u89C8\u5668\u91CC\u6CA1\u6709\u53EF\u7528\u9875\u9762");
    }
    const cdp = new CdpClient(page.webSocketDebuggerUrl);
    try {
      await cdp.connect();
    } catch (error) {
      try {
        child.kill();
      } catch {
      }
      throw new Error(`\u8FDE\u63A5 CDP \u5931\u8D25\uFF1A${error?.message ?? error}`);
    }
    await cdp.send("Runtime.enable").catch(() => {
    });
    await cdp.send("Runtime.addBinding", { name: BINDING_NAME }).catch((error) => {
      throw new Error(`addBinding \u5931\u8D25\uFF1A${error?.message ?? error}`);
    });
    await cdp.send("Runtime.addBinding", { name: POW_BINDING }).catch(() => {
    });
    cdp.onEvent((method, params) => {
      if (method === "Runtime.bindingCalled") {
        const name2 = String(params?.name ?? "");
        if (name2 === BINDING_NAME) {
          handleBindingEvent(String(params?.payload ?? ""));
        } else if (name2 === POW_BINDING) {
          handlePowBindingEvent(String(params?.payload ?? ""));
        }
      }
    });
    const cleanup2 = () => {
      try {
        cdp.close();
      } catch {
      }
      try {
        child.kill();
      } catch {
      }
      activeSession = void 0;
      launchPromise = void 0;
    };
    child.on("exit", cleanup2);
    return { browser, child, cdp, cleanup: cleanup2 };
  })();
  try {
    activeSession = await launchPromise;
  } catch (error) {
    launchPromise = void 0;
    throw error;
  }
  launchPromise = void 0;
  return activeSession;
}
async function shutdownBrowserTransport() {
  activeSession?.cleanup();
  activeSession = void 0;
  launchPromise = void 0;
}
var B64_HELPER = "__dshB64ToBytes";
var FORMDATA_HELPER = "__dshRebuildFormData";
var PAGE_HELPERS = `
  const ${B64_HELPER} = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  };
  const ${FORMDATA_HELPER} = (parts) => {
    const form = new FormData();
    for (const p of parts) {
      if (p.t === 'text') form.append(p.name, p.value);
      else form.append(p.name, new File([${B64_HELPER}(p.b64)], p.filename, { type: p.type }));
    }
    return form;
  };
`;
async function bodyToPageInit(body) {
  if (body === void 0 || body === null) {
    return "undefined";
  }
  if (typeof body === "string") {
    return JSON.stringify(body);
  }
  if (body instanceof Uint8Array) {
    return `${B64_HELPER}(${JSON.stringify(Buffer.from(body).toString("base64"))})`;
  }
  if (body instanceof ArrayBuffer) {
    return `${B64_HELPER}(${JSON.stringify(Buffer.from(new Uint8Array(body)).toString("base64"))})`;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const raw = [];
    body.forEach((value, name2) => {
      raw.push([name2, value]);
    });
    const parts = [];
    for (const [name2, value] of raw) {
      if (typeof value === "string") {
        parts.push({ t: "text", name: name2, value });
        continue;
      }
      const blob = value;
      const b64 = Buffer.from(new Uint8Array(await blob.arrayBuffer())).toString("base64");
      parts.push({
        t: "file",
        name: name2,
        filename: blob.name || name2 || "blob",
        type: blob.type || "application/octet-stream",
        b64
      });
    }
    return `${FORMDATA_HELPER}(${JSON.stringify(parts)})`;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    const b64 = Buffer.from(new Uint8Array(await body.arrayBuffer())).toString("base64");
    return `new Blob([${B64_HELPER}(${JSON.stringify(b64)})], { type: ${JSON.stringify(body.type || "application/octet-stream")} })`;
  }
  throw new Error(
    "\u6D4F\u89C8\u5668\u4EE3\u7406\u4F20\u8F93\u5C42\u4E0D\u652F\u6301\u7684\u8BF7\u6C42\u4F53\u7C7B\u578B\uFF08\u652F\u6301 string / Uint8Array / ArrayBuffer / FormData / Blob\uFF09"
  );
}
var POW_BINDING = "__dshPowSolveResult";
async function solvePowInPage(input) {
  const session = await launchBrowserTransport();
  const requestId = `pow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const answer = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      powRequests.delete(requestId);
      fn();
    };
    powRequests.set(requestId, {
      onAnswer: (value) => {
        if (!Number.isFinite(value) || value <= 0) {
          finish(() => reject(new Error(`\u9875\u9762\u5185 PoW \u8FD4\u56DE\u4E86\u975E\u6CD5\u7B54\u6848\uFF1A${String(value)}`)));
          return;
        }
        finish(() => resolve(Math.floor(value)));
      },
      onError: (message) => finish(() => reject(new Error(`\u9875\u9762\u5185 PoW \u5931\u8D25\uFF1A${message}`)))
    });
    const expression = `
      (async () => {
        const report = (v) => ${POW_BINDING}(${JSON.stringify(requestId)} + ':ok:' + String(v));
        const fail = (m) => ${POW_BINDING}(${JSON.stringify(requestId)} + ':err:' + String(m));
        try {
          const resp = await fetch(${JSON.stringify(input.wasmUrl)});
          if (!resp.ok) { fail('wasm HTTP ' + resp.status); return; }
          const bytes = await resp.arrayBuffer();
          const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
          const e = instance.exports;
          if (typeof e.wasm_solve !== 'function' || typeof e.__wbindgen_export_0 !== 'function' || !e.memory) {
            fail('PoW WASM exports missing'); return;
          }
          const enc = new TextEncoder();
          const cBytes = enc.encode(${JSON.stringify(input.challenge)});
          const pBytes = enc.encode(${JSON.stringify(String(input.salt) + "_" + String(input.expireAt) + "_")});
          const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
          const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
          new Uint8Array(e.memory.buffer).set(cBytes, cP);
          new Uint8Array(e.memory.buffer).set(pBytes, pP);
          const sp = e.__wbindgen_add_to_stack_pointer(-16);
          e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, Number(${JSON.stringify(String(input.difficulty))}));
          const dv = new DataView(e.memory.buffer);
          const code = dv.getInt32(sp, true);
          const answer = dv.getFloat64(sp + 8, true);
          e.__wbindgen_add_to_stack_pointer(16);
          if (code === 0 || !Number.isFinite(answer) || answer <= 0) { fail('solve code=' + code); return; }
          report(answer);
        } catch (err) { fail(err && err.message ? err.message : String(err)); }
      })()
    `;
    session.cdp.send("Runtime.evaluate", { expression, awaitPromise: false, userGesture: true }).catch((error) => {
      const state = powRequests.get(requestId);
      if (state) state.onError(error?.message ?? String(error));
    });
  });
  return answer;
}
var powRequests = /* @__PURE__ */ new Map();
function createBrowserFetch() {
  return async (input, init) => {
    const session = await launchBrowserTransport();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) headers[key] = value;
      } else {
        for (const [key, value] of Object.entries(init.headers)) headers[key] = String(value);
      }
    }
    const bodyExpr = await bodyToPageInit(init?.body);
    const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const headersPromise = new Promise((resolve, reject) => {
      const state = {
        resolveHeaders: (status, statusText, respHeaders) => {
          const stream = new ReadableStream({
            start: (controller) => {
              state.controller = controller;
            },
            cancel: () => {
              requests.delete(requestId);
            }
          });
          const resp = new Response(stream, {
            status,
            statusText,
            headers: respHeaders
          });
          resolve(resp);
        },
        rejectHeaders: reject,
        streamStarted: false
      };
      requests.set(requestId, state);
    });
    const expression = `
      (async () => {
        ${PAGE_HELPERS}
        const requestId = ${JSON.stringify(requestId)};
        try {
          const init = {
            method: ${JSON.stringify(method)},
            headers: ${JSON.stringify(headers)},
            body: ${bodyExpr},
          };
          const requestInit = init.body === undefined
            ? { method: init.method, headers: init.headers }
            : init;
          const resp = await fetch(${JSON.stringify(url)}, requestInit);
          ${BINDING_NAME}(JSON.stringify({
            requestId,
            type: 'headers',
            status: resp.status,
            statusText: resp.statusText,
            headers: Object.fromEntries(resp.headers.entries()),
          }));
          const reader = resp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              ${BINDING_NAME}(JSON.stringify({ requestId, type: 'done' }));
              break;
            }
            ${BINDING_NAME}(JSON.stringify({ requestId, type: 'chunk', chunk: Array.from(value) }));
          }
        } catch (error) {
          ${BINDING_NAME}(JSON.stringify({ requestId, type: 'error', error: String(error) }));
        }
      })()
    `;
    session.cdp.send("Runtime.evaluate", { expression, awaitPromise: false, userGesture: true }).catch((error) => {
      const state = requests.get(requestId);
      if (state && !state.streamStarted) {
        state.rejectHeaders(new Error(`evaluate \u5931\u8D25\uFF1A${error?.message ?? error}`));
        requests.delete(requestId);
      }
    });
    return await headersPromise;
  };
}

// src/webapi.ts
var DS_BASE = "https://chat.deepseek.com";
var DEFAULT_WASM_URL = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";
var FALLBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var FALLBACK_CLIENT_VERSION = "2.5.0";
function buildDsHeaders(auth, referer) {
  const headers = { ...auth.extraHeaders ?? {} };
  const defaults = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "x-client-platform": "web",
    // ⚠️ 只是**兜底**：抓取成功时用的一定是浏览器的真实值（实测 2026-10-02 是 `2.5.0`）。
    // 写死值必然随网页端发版而过时 —— 过时的后果是功能降级（"更新到最新版才能用专家/识图"），
    // 不是鉴权失败。
    "x-client-version": FALLBACK_CLIENT_VERSION,
    // ⚠️ 真实浏览器**不发**这个头（2026-10-02 核对真实捕获：7 个 `x-*` 里没有它）。
    // 保留是为了不改变既有行为；想更贴近浏览器，删掉下面这行即可。
    "x-app-version": FALLBACK_CLIENT_VERSION
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!headers[key]) headers[key] = value;
  }
  headers["user-agent"] = auth.userAgent || FALLBACK_UA;
  headers["content-type"] = "application/json";
  headers.origin = DS_BASE;
  headers.referer = referer || `${DS_BASE}/`;
  headers.authorization = `Bearer ${auth.token}`;
  headers["x-deepseek-harness"] = "deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness); provider=deepseek-web";
  delete headers["x-ds-pow-response"];
  if (auth.cookie) headers.cookie = auth.cookie;
  else delete headers.cookie;
  if (auth.hifDliq) headers["x-hif-dliq"] = auth.hifDliq;
  if (auth.hifLeim) headers["x-hif-leim"] = auth.hifLeim;
  return headers;
}
function envelopeError(json) {
  if (!json || typeof json !== "object") return void 0;
  const code = json.code;
  if (typeof code === "number" && code !== 0) {
    return { code, msg: String(json.msg ?? json.message ?? "unknown error") };
  }
  const bizCode = json.data?.biz_code;
  if (typeof bizCode === "number" && bizCode !== 0) {
    const bizMsg = json.data?.biz_msg;
    const text = bizMsg === void 0 || bizMsg === null || bizMsg === "" ? "unknown error" : String(bizMsg);
    return { code: bizCode, msg: text };
  }
  return void 0;
}
function isMutedError(biz) {
  return biz?.code === 5 || /user\s+is\s+muted|account\s+is\s+muted/i.test(String(biz?.msg ?? ""));
}
function muteUntilMs(json) {
  const raw = json?.data?.biz_data?.mute_until;
  const seconds = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return void 0;
  return Math.round(seconds * 1e3);
}
var FAILOVER_RETRY_MS = 2e3;
var THROTTLE_RETRY_MS = 2e4;
function mutedMessage(untilMs) {
  if (untilMs === void 0) {
    return "DeepSeek \u7F51\u9875\u7AEF\u5DF2\u5C01\u7981\u672C\u8D26\u53F7\uFF08\u672A\u7ED9\u51FA\u89E3\u9664\u65F6\u95F4\uFF09";
  }
  const when = new Date(untilMs).toLocaleString("zh-CN", { hour12: false });
  const minutes = Math.max(1, Math.round((untilMs - Date.now()) / 6e4));
  return `DeepSeek \u7F51\u9875\u7AEF\u5DF2\u5C01\u7981\u672C\u8D26\u53F7\uFF0C${when} \u89E3\u9664\uFF08\u7EA6 ${minutes} \u5206\u949F\uFF09`;
}
function isBusyGenerating(message) {
  return /being generated|请稍后再试|稍后再试|正在生成/i.test(String(message ?? ""));
}
var injectedFetch;
function activeFetch(input, init) {
  return (injectedFetch ?? fetch)(input, init);
}
function setFetchImpl(impl) {
  injectedFetch = impl;
}
function currentFetch(input, init) {
  return activeFetch(input, init);
}
function fetchImplKind() {
  return injectedFetch ? "injected" : "node";
}
var throttleStreak = 0;
var lastThrottleAt = 0;
var THROTTLE_BASE_MS = 2e4;
var THROTTLE_MAX_MS = 9e4;
var THROTTLE_JITTER_RATIO = 0.3;
var MAX_THROTTLE_RETRY_MS = Math.round(THROTTLE_MAX_MS * (1 + THROTTLE_JITTER_RATIO));
var AUTH_FAILOVER_RETRY_MS = 5e3;
var AUTH_GIVEUP_RETRY_MS = 6e5;
function throttleBackoffMs(now = Date.now()) {
  if (now - lastThrottleAt > 5 * 6e4) throttleStreak = 0;
  const base = Math.min(THROTTLE_BASE_MS * 2 ** throttleStreak, THROTTLE_MAX_MS);
  const jitter = Math.round(base * THROTTLE_JITTER_RATIO * Math.random());
  return base + jitter;
}
function noteThrottled(now = Date.now()) {
  if (now - lastThrottleAt > 5 * 6e4) throttleStreak = 0;
  throttleStreak += 1;
  lastThrottleAt = now;
  return throttleBackoffMs(now);
}
function throttleRetryAfterMs(canFailover) {
  try {
    if (canFailover?.("throttled") === true) return FAILOVER_RETRY_MS;
  } catch {
  }
  return noteThrottled();
}
function isThrottled(message) {
  return /过于频繁|太频繁|操作频繁|too\s+many\s+requests|rate\s*limit|稍后重试|限流/i.test(
    String(message ?? "")
  );
}
function isInvalidSessionError(biz) {
  return /invalid\s+chat\s+session|chat\s+session\s+(?:not\s+found|expired|invalid)|chat_session_id[^\p{L}]{0,4}(?:无效|不存在|已过期|非法)|会话.{0,8}(?:无效|不存在|已过期)/iu.test(
    String(biz?.msg ?? "")
  );
}
function bizErrorCode(code) {
  if (code === 40003 || code === 40001) return "AUTH";
  if (code === 429 || code === 40029) return "RATE_LIMIT";
  return "PROVIDER_ERROR";
}
function isInvalidRefFileError(biz) {
  return !!biz && biz.code === 9 && /ref\s*file/i.test(String(biz.msg ?? ""));
}
function bizErrorMessage(code, msg) {
  if (code === 40003 || code === 40001) {
    return `DeepSeek \u7F51\u9875\u6388\u6743\u5931\u8D25\uFF1A${msg} \u2014\u2014 \u767B\u5F55\u6001\u5DF2\u8FC7\u671F\u6216\u65E0\u6548\uFF0C\u8BF7\u5230\u300C\u8BBE\u7F6E \u2192 DeepSeek \u7F51\u9875\u767B\u5F55\u300D\u91CD\u65B0\u767B\u5F55`;
  }
  if (code === 40029) return "\u7F51\u9875\u7248\u9650\u6D41\uFF1A\u53D1\u5F97\u592A\u9891\u7E41\uFF0C\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5";
  return `DeepSeek \u7F51\u9875\u7AEF\u9519\u8BEF\uFF08code ${code}\uFF09\uFF1A${msg}`;
}
var resolvedWasmUrl = null;
async function readOfficialResource(url, max, outer) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443" || parsed.hostname !== "deepseek.com" && !parsed.hostname.endsWith(".deepseek.com")) throw new Error("\u975E\u5B98\u65B9\u8D44\u6E90\u5730\u5740");
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(15e3)]) : AbortSignal.timeout(15e3);
  const resp = await activeFetch(parsed.href, { signal, redirect: "error" });
  if (!resp.ok || !resp.body) {
    await resp.body?.cancel();
    throw new Error(`\u8D44\u6E90\u8BF7\u6C42\u5931\u8D25 HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (; ; ) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > max) throw new Error("\u8D44\u6E90\u8D85\u8FC7\u5B57\u8282\u4E0A\u9650");
      chunks.push(item.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
    ;
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function isReachable(url, outer) {
  if (!checkedWasmUrl(url)) return false;
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(1e4)]) : AbortSignal.timeout(1e4);
  let resp;
  try {
    resp = await activeFetch(url, { method: "GET", headers: { range: "bytes=0-0" }, signal, redirect: "error" });
    return resp.ok;
  } catch {
    if (outer?.aborted) outer.throwIfAborted();
    return false;
  } finally {
    try {
      await resp?.body?.cancel();
    } catch {
    }
  }
}
async function discoverWasmUrl(signal) {
  const decode = (bytes) => new TextDecoder().decode(bytes);
  const find = (text, base) => {
    for (const match of text.matchAll(/[^"'\s<>]*sha3[_a-z0-9.]*\.wasm/gi)) {
      try {
        const url = checkedWasmUrl(new URL(match[0], base).href);
        if (url) return url;
      } catch {
      }
    }
    return void 0;
  };
  try {
    signal?.throwIfAborted();
    const html = decode(await readOfficialResource(`${DS_BASE}/`, 2 * 1024 * 1024, signal));
    const direct = find(html, `${DS_BASE}/`);
    if (direct) return direct;
    const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].slice(0, 8);
    for (const match of scripts) {
      signal?.throwIfAborted();
      try {
        const url = new URL(match[1], `${DS_BASE}/`).href;
        const found = find(decode(await readOfficialResource(url, 8 * 1024 * 1024, signal)), url);
        if (found) return found;
      } catch {
        if (signal?.aborted) signal.throwIfAborted();
      }
    }
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
  }
  return void 0;
}
async function resolveWasmUrl(auth, signal) {
  const key = auth.wasmUrl || "";
  if (resolvedWasmUrl?.key === key) return resolvedWasmUrl.url;
  const fromAuth = checkedWasmUrl(auth.wasmUrl);
  if (auth.wasmUrl && !fromAuth) {
    lastWasmUrlRejection = auth.wasmUrl;
  }
  const candidates = [fromAuth, checkedWasmUrl(DEFAULT_WASM_URL)].filter((url) => !!url);
  for (const url of candidates) {
    if (await isReachable(url, signal)) {
      resolvedWasmUrl = { key, url };
      return url;
    }
  }
  const discovered = checkedWasmUrl(await discoverWasmUrl(signal));
  if (discovered) {
    resolvedWasmUrl = { key, url: discovered };
    return discovered;
  }
  return fromAuth ?? checkedWasmUrl(DEFAULT_WASM_URL) ?? DEFAULT_WASM_URL;
}
var MAX_WASM_BYTES = 8 * 1024 * 1024;
var lastWasmUrlRejection;
function checkedWasmUrl(raw) {
  if (typeof raw !== "string" || !raw) return void 0;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return void 0;
  }
  if (url.protocol !== "https:") return void 0;
  if (url.username || url.password) return void 0;
  if (url.port && url.port !== "443") return void 0;
  const host = url.hostname.toLowerCase();
  if (host !== "deepseek.com" && !host.endsWith(".deepseek.com")) return void 0;
  if (!url.pathname.toLowerCase().endsWith(".wasm")) return void 0;
  return url.href;
}
async function solvePow(challenge, wasmUrl) {
  if (systemBrowserAvailable()) {
    return await solvePowInPage({
      wasmUrl,
      challenge: challenge.challenge,
      salt: challenge.salt,
      difficulty: challenge.difficulty,
      expireAt: challenge.expire_at
    });
  }
  throw new AdapterLlmError(
    "PoW \u5FC5\u987B\u5728\u6D4F\u89C8\u5668\u9875\u9762\u5185\u6C42\u89E3\uFF08\u672A\u627E\u5230 Edge/Chrome\uFF09\u2014\u2014 \u4E0D\u518D\u9000\u56DE Node \u4FA7\u8BA1\u7B97\uFF0C\u56E0\u4E3A\u90A3\u662F\u4E3B\u8981\u7684\u5C01\u53F7\u7279\u5F81",
    "TRANSPORT"
  );
}
async function createPowHeader(auth, targetPath, signal) {
  let resp;
  try {
    resp = await activeFetch(`${DS_BASE}/api/v0/chat/create_pow_challenge`, {
      method: "POST",
      headers: buildDsHeaders(auth),
      body: JSON.stringify({ target_path: targetPath }),
      signal
    });
  } catch (error) {
    throw new AdapterLlmError(`DeepSeek PoW challenge request failed: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
  }
  const text = await resp.text();
  if (!resp.ok) {
    const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
    throw new AdapterLlmError(
      `DeepSeek PoW challenge failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ""}`,
      httpErrorCode(resp.status),
      { status: resp.status, ...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {} }
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AdapterLlmError("DeepSeek PoW challenge returned non-JSON", "MALFORMED_RESPONSE", { status: resp.status });
  }
  const biz = envelopeError(json);
  if (biz) {
    throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status });
  }
  const challenge = json?.data?.biz_data?.challenge;
  if (!challenge?.challenge || !challenge?.salt || !challenge?.signature) {
    throw new AdapterLlmError(
      "DeepSeek PoW challenge missing fields\uFF08\u767B\u5F55\u6001\u53EF\u80FD\u5DF2\u8FC7\u671F\uFF0C\u6216\u88AB\u8981\u6C42\u4EBA\u673A\u6821\u9A8C\uFF09",
      "MALFORMED_RESPONSE",
      { status: resp.status }
    );
  }
  const wasmUrl = await resolveWasmUrl(auth, signal);
  const answer = await solvePow(challenge, wasmUrl);
  const payload = JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath
  });
  return Buffer.from(payload).toString("base64");
}
async function uploadImageFile(auth, input, signal) {
  const targetPath = "/api/v0/file/upload_file";
  const powHeader = await createPowHeader(auth, targetPath, signal);
  const headers = { ...buildDsHeaders(auth) };
  delete headers["content-type"];
  headers["x-ds-pow-response"] = powHeader;
  const form = new FormData();
  const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
  form.append("file", new Blob([bytes], { type: input.mediaType || "image/png" }), input.name || "image.png");
  let resp;
  try {
    resp = await activeFetch(`${DS_BASE}${targetPath}`, { method: "POST", headers, body: form, signal });
  } catch (error) {
    throw new AdapterLlmError(`DeepSeek \u56FE\u7247\u4E0A\u4F20\u5931\u8D25\uFF1A${error?.message ?? error}`, "TRANSPORT", { cause: error });
  }
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = void 0;
  }
  if (!resp.ok) {
    throw new AdapterLlmError(
      `DeepSeek \u56FE\u7247\u4E0A\u4F20\u5931\u8D25 (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ""}`,
      httpErrorCode(resp.status),
      { status: resp.status }
    );
  }
  const biz = envelopeError(json);
  if (biz) throw new AdapterLlmError(`DeepSeek \u56FE\u7247\u4E0A\u4F20\u88AB\u62D2\uFF08code ${biz.code}\uFF09\uFF1A${biz.msg}`, bizErrorCode(biz.code), { status: resp.status });
  const fileId = json?.data?.biz_data?.id ?? json?.data?.id;
  if (typeof fileId !== "string" || !fileId) {
    throw new AdapterLlmError("DeepSeek \u56FE\u7247\u4E0A\u4F20\u672A\u8FD4\u56DE file_id", "MALFORMED_RESPONSE", { status: resp.status });
  }
  return { fileId, ...input.name ? { name: input.name } : {} };
}
async function createChatSession(auth, signal) {
  let resp;
  try {
    resp = await activeFetch(`${DS_BASE}/api/v0/chat_session/create`, {
      method: "POST",
      headers: buildDsHeaders(auth),
      body: "{}",
      signal
    });
  } catch (error) {
    throw new AdapterLlmError(`DeepSeek session create failed: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
  }
  const text = await resp.text();
  if (!resp.ok) {
    const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
    throw new AdapterLlmError(
      `DeepSeek session create failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ""}`,
      httpErrorCode(resp.status),
      { status: resp.status, ...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {} }
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AdapterLlmError("DeepSeek session create returned non-JSON", "MALFORMED_RESPONSE", { status: resp.status });
  }
  const biz = envelopeError(json);
  if (biz) {
    throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status });
  }
  const id = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id;
  if (typeof id !== "string" || !id) {
    throw new AdapterLlmError("DeepSeek session create missing id", "MALFORMED_RESPONSE", { status: resp.status });
  }
  return id;
}
var DEFAULT_SESSION_CLEANUP = {
  mode: "deferred",
  // 均值落在旧默认值上（90s / 8 个 / 1.5s），所以升级后行为没有突变，只是多了方差
  delayMs: Math.round((DEFAULT_CLEANUP_DELAY_MS.min + DEFAULT_CLEANUP_DELAY_MS.max) / 2),
  batchSize: Math.round((DEFAULT_CLEANUP_BATCH.min + DEFAULT_CLEANUP_BATCH.max) / 2),
  gapMs: Math.round((DEFAULT_CLEANUP_GAP_MS.min + DEFAULT_CLEANUP_GAP_MS.max) / 2),
  batchRange: DEFAULT_CLEANUP_BATCH,
  delayRange: DEFAULT_CLEANUP_DELAY_MS,
  gapRange: DEFAULT_CLEANUP_GAP_MS
};
var MAX_IDS_PER_REQUEST = 20;
var sessionLifecycleHook;
function setSessionLifecycleHook(hook) {
  sessionLifecycleHook = hook;
}
function emitSessionLifecycle(event) {
  try {
    sessionLifecycleHook?.(event);
  } catch {
  }
}
function createSessionCleaner(options = {}) {
  const policy = {
    mode: options.policy?.mode ?? DEFAULT_SESSION_CLEANUP.mode,
    delayMs: Math.max(0, Math.floor(options.policy?.delayMs ?? DEFAULT_SESSION_CLEANUP.delayMs)),
    batchSize: Math.max(1, Math.floor(options.policy?.batchSize ?? DEFAULT_SESSION_CLEANUP.batchSize)),
    // 没给区间（老调用方 / 老配置）→ 间隔为 0，也就是**不加额外间隔**，保持老行为。
    // 只有显式配了 gapRange 才启用"删一个歇一下"。
    gapMs: Math.max(
      0,
      Math.floor(options.policy?.gapMs ?? (options.policy?.gapRange ? DEFAULT_SESSION_CLEANUP.gapMs : 0))
    ),
    // 区间是**可选**的：老调用方只传死 batchSize / delayMs 时，这里保持"无区间"= 固定值语义
    // （否则它们传的 3 会被默认区间 6~10 顶掉，单测与旧行为全乱）。
    ...options.policy?.batchRange ? { batchRange: options.policy.batchRange } : {},
    ...options.policy?.delayRange ? { delayRange: options.policy.delayRange } : {},
    ...options.policy?.gapRange ? { gapRange: options.policy.gapRange } : {}
  };
  function applyModeDefaults() {
    if (policy.mode === "immediate") {
      policy.delayMs = 1500;
      policy.batchSize = 1;
    } else if (policy.mode === "deferred" && policy.batchSize <= 1) {
      policy.delayMs = policy.delayRange ? pickInt(policy.delayRange) : DEFAULT_SESSION_CLEANUP.delayMs;
      policy.batchSize = policy.batchRange ? pickInt(policy.batchRange) : DEFAULT_SESSION_CLEANUP.batchSize;
    }
  }
  const doFetch = options.fetchImpl ?? fetch;
  const setT = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = options.clearTimeoutImpl ?? ((t) => clearTimeout(t));
  const logger = options.logger;
  let queue = [];
  let timer;
  let manualOnly = options.manualOnly === true;
  let batchUnsupported = false;
  const random = options.randomImpl ?? Math.random;
  function pickInt(range) {
    const lo = Math.min(range.min, range.max);
    const hi = Math.max(range.min, range.max);
    if (hi <= lo) return lo;
    return Math.min(hi, lo + Math.floor(random() * (hi - lo + 1)));
  }
  function rollCycle() {
    if (policy.mode !== "deferred") return;
    if (policy.batchRange) policy.batchSize = Math.max(1, pickInt(policy.batchRange));
    if (policy.delayRange) policy.delayMs = Math.max(0, pickInt(policy.delayRange));
  }
  function rollGap() {
    policy.gapMs = policy.gapRange ? Math.max(0, pickInt(policy.gapRange)) : Math.max(0, policy.gapMs);
    return policy.gapMs;
  }
  function sleep2(ms) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const handle = setT(() => resolve(), ms);
      handle?.unref?.();
    });
  }
  function armTimer() {
    if (timer !== void 0) return;
    if (policy.mode === "keep") return;
    if (manualOnly) return;
    timer = setT(() => {
      void flush();
    }, Math.max(0, policy.delayMs));
    timer?.unref?.();
  }
  async function classifyDeleteResp(resp) {
    if (!resp.ok) return resp.status >= 500 || resp.status === 429 ? "transient" : "unsupported";
    const text = await resp.text().catch(() => "");
    try {
      const json = text ? JSON.parse(text) : void 0;
      if (json && envelopeError(json)) return "unsupported";
      return "ok";
    } catch {
      return "transient";
    }
  }
  async function respLooksOk(resp) {
    let ok = resp.ok;
    if (ok) {
      const text = await resp.text().catch(() => "");
      try {
        const json = text ? JSON.parse(text) : void 0;
        if (json && envelopeError(json)) ok = false;
      } catch {
        ok = false;
      }
    }
    return ok;
  }
  async function deleteOne(auth, sessionId) {
    try {
      const resp = await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
        method: "POST",
        headers: buildDsHeaders(auth),
        body: JSON.stringify({ chat_session_id: sessionId }),
        signal: AbortSignal.timeout(1e4)
      });
      return await respLooksOk(resp);
    } catch {
      return false;
    }
  }
  async function deleteChunk(batch) {
    if (batch.length === 0) return;
    const firstToken = batch[0].auth?.token;
    const sameAccount2 = batch.every((item) => item.auth?.token === firstToken);
    if (batch.length > 1 && !batchUnsupported && sameAccount2) {
      try {
        const resp = await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
          method: "POST",
          headers: buildDsHeaders(batch[0].auth),
          body: JSON.stringify({ chat_session_ids: batch.map((b) => b.sessionId) }),
          signal: AbortSignal.timeout(15e3)
        });
        const verdict = await classifyDeleteResp(resp);
        if (verdict === "ok") {
          for (const item of batch) emitSessionLifecycle({ kind: "deleted", sessionId: item.sessionId });
          logger?.debug?.(`deepseek-web: \u5DF2\u6279\u91CF\u6E05\u7406 ${batch.length} \u4E2A\u4E34\u65F6\u4F1A\u8BDD\uFF08\u53EA\u7528\u4E86 1 \u4E2A\u8BF7\u6C42\uFF09`);
          return;
        }
        if (verdict === "unsupported") {
          batchUnsupported = true;
          logger?.debug?.("deepseek-web: \u670D\u52A1\u7AEF\u4E0D\u63A5\u53D7\u6279\u91CF\u5220\u9664\u4F1A\u8BDD\uFF0C\u4E4B\u540E\u6539\u4E3A\u9010\u4E2A\u5220\u9664");
        } else {
          logger?.debug?.(`deepseek-web: \u6279\u91CF\u5220\u9664\u672C\u6B21\u5931\u8D25\uFF08HTTP ${resp.status}\uFF09\uFF0C\u6309\u77AC\u65F6\u95EE\u9898\u5904\u7406\uFF0C\u4E0B\u6B21\u4ECD\u8BD5\u6279\u91CF`);
        }
      } catch {
      }
    }
    for (let i = 0; i < batch.length; i += 1) {
      if (i > 0) await sleep2(rollGap());
      if (await deleteOne(batch[i].auth, batch[i].sessionId)) {
        emitSessionLifecycle({ kind: "deleted", sessionId: batch[i].sessionId });
      }
    }
    logger?.debug?.(`deepseek-web: \u5DF2\u6E05\u7406 ${batch.length} \u4E2A\u4E34\u65F6\u4F1A\u8BDD`);
  }
  async function doFlush() {
    if (timer !== void 0) {
      clearT(timer);
      timer = void 0;
    }
    const batch = queue;
    queue = [];
    try {
      if (batch.length === 0) return;
      for (let i = 0; i < batch.length; i += MAX_IDS_PER_REQUEST) {
        if (i > 0) await sleep2(rollGap());
        await deleteChunk(batch.slice(i, i + MAX_IDS_PER_REQUEST));
      }
    } catch (error) {
      logger?.debug?.(`deepseek-web: \u4F1A\u8BDD\u6E05\u7406\u51FA\u9519\uFF08\u5DF2\u5FFD\u7565\uFF09\uFF1A${error?.message ?? error}`);
    } finally {
      if (queue.length > 0) armTimer();
    }
  }
  let chain = Promise.resolve();
  function flush() {
    chain = chain.then(doFlush, doFlush);
    return chain;
  }
  function schedule(auth, sessionId) {
    if (policy.mode === "keep") return;
    if (queue.length === 0) rollCycle();
    queue.push({ auth, sessionId });
    emitSessionLifecycle({ kind: "queued", auth, sessionId });
    if (policy.mode === "deferred" && queue.length >= policy.batchSize) {
      void flush();
      return;
    }
    armTimer();
  }
  function abandonQueue() {
    if (timer !== void 0) {
      clearT(timer);
      timer = void 0;
    }
    const dropped = queue;
    queue = [];
    for (const item of dropped) emitSessionLifecycle({ kind: "abandoned", sessionId: item.sessionId });
  }
  function discard(auth, sessionId) {
    const p = deleteChunk([{ auth, sessionId }]);
    const trace = (outcome, detail) => {
      try {
        const dir = join7(webLoginDir(), "diagnostics");
        mkdirSync6(dir, { recursive: true, mode: 448 });
        const file = join7(dir, "scaffolding-discards.jsonl");
        const line = JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), session: sessionId.slice(0, 8), outcome, detail }) + "\n";
        let size = 0;
        try {
          size = statSync2(file).size;
        } catch {
        }
        if (size + Buffer.byteLength(line) > 4e6) return;
        appendFileSync(file, line, { encoding: "utf8", mode: 384 });
      } catch {
      }
    };
    return p.then(
      () => trace("sent"),
      (err) => trace("failed", String(err?.message ?? err).slice(0, 120))
    );
  }
  function configure(next) {
    const modeChanged = next.mode !== void 0 && next.mode !== policy.mode;
    if (next.mode !== void 0) policy.mode = next.mode;
    if (next.delayMs !== void 0) policy.delayMs = Math.max(0, Math.floor(next.delayMs));
    if (next.batchSize !== void 0) policy.batchSize = Math.max(1, Math.floor(next.batchSize));
    if (next.gapMs !== void 0) policy.gapMs = Math.max(0, Math.floor(next.gapMs));
    for (const key of ["batchRange", "delayRange", "gapRange"]) {
      const value = next[key];
      if (value && Number.isFinite(value.min) && Number.isFinite(value.max)) {
        policy[key] = { min: Math.floor(Math.min(value.min, value.max)), max: Math.floor(Math.max(value.min, value.max)) };
      }
    }
    if (modeChanged) applyModeDefaults();
    if (policy.mode === "keep") abandonQueue();
    logger?.info?.(
      `deepseek-web: \u4F1A\u8BDD\u6E05\u7406\u7B56\u7565\u5DF2\u66F4\u65B0 \u2014\u2014 ${policy.mode}` + (policy.mode === "deferred" ? `\uFF08\u6512 ${policy.batchSize} \u4E2A\u6216 ${Math.round(policy.delayMs / 1e3)}s \u540E\u6E05\u7406` + (policy.gapRange ? `\uFF1B\u6279\u91CF\u5220\u9664\u4E0D\u53D7\u652F\u6301\u65F6\u9010\u4E2A\u5220\uFF0C\u95F4\u9694 ${policy.gapMs}ms` : "") + "\uFF09" : "")
    );
    return { ...policy };
  }
  return {
    schedule,
    discard,
    flush,
    pendingCount: () => queue.length,
    policy: () => ({ ...policy }),
    configure,
    setManualOnly: (value) => {
      manualOnly = value === true;
      if (manualOnly && timer !== void 0) {
        clearT(timer);
        timer = void 0;
      }
      if (!manualOnly) armTimer();
    }
  };
}
var defaultCleaner = createSessionCleaner({
  policy: { mode: "immediate", delayMs: 1500, batchSize: 1 }
});
function scheduleDeleteSession(auth, sessionId) {
  defaultCleaner.schedule(auth, sessionId);
}
function discardSession(auth, sessionId) {
  void defaultCleaner.discard(auth, sessionId);
}
function clearLiveSession() {
  const ids = [...reuseSlots.values()].map((slot) => slot.sessionId);
  for (const id of ids) retireSession(id);
  return ids;
}
function pickUserDisplay(user) {
  const candidates = [
    user?.email,
    user?.mobile_number,
    user?.mobile,
    user?.phone,
    user?.username,
    user?.nickname,
    user?.name
  ];
  for (const value of candidates) {
    if (value === void 0 || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}
function classifyAuthEnvelope(json) {
  const fail = (error) => ({ ok: false, error });
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return fail("users/current \u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61\uFF08\u53EF\u80FD\u662F\u53CD\u722C\u9875\u9762\u6216\u7F51\u5173\u62E6\u622A\uFF09");
  }
  const obj = json;
  if (typeof obj.code !== "number") return fail("users/current \u7F3A\u5C11\u6570\u503C\u4E1A\u52A1\u7801\uFF08\u5F62\u72B6\u4E0D\u7B26\uFF09");
  const bizError = envelopeError(obj);
  if (bizError) return fail(bizError.msg);
  if (obj.code !== 0 || !obj.data || typeof obj.data !== "object" || Array.isArray(obj.data)) {
    return fail("users/current \u7F3A\u5C11\u7528\u6237\u6570\u636E\uFF08\u5F62\u72B6\u4E0D\u7B26\uFF09");
  }
  if (obj.data.biz_code !== void 0 && typeof obj.data.biz_code !== "number") {
    return fail("users/current \u5185\u5C42\u4E1A\u52A1\u7801\u65E0\u6548");
  }
  const payload = obj.data.biz_data ?? obj.data;
  const user = payload?.user ?? payload;
  if (!user || typeof user !== "object" || Array.isArray(user)) return fail("users/current \u7528\u6237\u5F62\u72B6\u65E0\u6548");
  const hasId = typeof user.id === "string" && user.id.trim().length > 0 || typeof user.id === "number" && Number.isFinite(user.id);
  const named = ["email", "mobile_number", "mobile", "phone", "username", "nickname", "name"].some(
    (k) => typeof user[k] === "string" && user[k].trim()
  );
  return hasId || named ? { ok: true } : fail("users/current \u7F3A\u5C11\u53EF\u8FA8\u8BA4\u7684\u7528\u6237\u8EAB\u4EFD");
}
async function validateAuth(auth, signal) {
  try {
    const resp = await activeFetch(`${DS_BASE}/api/v0/users/current`, { headers: buildDsHeaders(auth), signal });
    if (resp.ok) {
      let json;
      try {
        json = await resp.json();
      } catch {
        json = void 0;
      }
      const verdict = classifyAuthEnvelope(json);
      if (!verdict.ok) return verdict;
      const payload = json?.data?.biz_data ?? json?.data;
      const user = payload?.user ?? payload ?? {};
      const display = pickUserDisplay(user);
      const chat = payload?.chat;
      const untilRaw = chat?.mute_until ?? payload?.mute_until;
      const untilSec = typeof untilRaw === "number" ? untilRaw : Number(untilRaw);
      const untilMs = Number.isFinite(untilSec) && untilSec > 0 ? Math.round(untilSec * 1e3) : void 0;
      return {
        ok: true,
        ...chat && typeof chat.is_muted === "boolean" ? { limit: { muted: chat.is_muted === true, ...untilMs ? { untilMs } : {} } } : {},
        user: {
          ...user?.id !== void 0 ? { id: String(user.id) } : {},
          ...display ? { display } : {}
        }
      };
    }
    if (resp.status === 404) {
      await createPowHeader(auth, "/api/v0/chat/completion", signal);
      return { ok: true };
    }
    return { ok: false, error: `users/current HTTP ${resp.status}` };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
function isReasoningType(type) {
  const t = type.toUpperCase();
  return t === "THINK" || t === "REASONING" || t === "THINKING";
}
async function* iterateLines(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = function* () {
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
    }
  };
  if (typeof body?.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        yield* drain();
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
      }
    }
  } else if (body?.[Symbol.asyncIterator]) {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      yield* drain();
    }
  }
  if (buffer.length > 0) yield buffer.replace(/\r$/, "");
}
var THINKING_WRAPPER_RE = /<\s*\/?\s*(analysis|summary|thinking|scratchpad|thought)\b/i;
function dumpSinkPath() {
  if (process.env.DSH_WEB_LOGIN_DUMP_SSE !== "1") return null;
  try {
    const dir = join7(resolveDshHome(), "deepseek-web", "frames");
    mkdirSync6(dir, { recursive: true });
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    return join7(dir, `${stamp}-${Math.random().toString(36).slice(2, 8)}.sse`);
  } catch {
    return null;
  }
}
function createSseState(options = {}) {
  const fragments = [];
  let fragmentsText = "";
  let fragmentsThinking = "";
  let directText = "";
  let directThinking = "";
  let outText = "";
  let outThinking = "";
  let divergences = 0;
  let sink = null;
  let orphanBuffer = "";
  const thinkingEnabled = options.thinkingEnabled === true;
  let pendingFinish;
  let sawData = false;
  let totalTokens;
  const emit = (out, kind, delta) => {
    if (!delta) return;
    if (kind === "text") outText += delta;
    else outThinking += delta;
    out.push({ kind, text: delta });
  };
  const emitText = (out, delta) => emit(out, "text", delta);
  const emitThinking = (out, delta) => emit(out, "thinking", delta);
  const settleOrphans = (out, firstType) => {
    if (!orphanBuffer) return;
    const text = orphanBuffer;
    orphanBuffer = "";
    if (!isReasoningType(firstType)) {
    }
    directThinking += text;
    emitThinking(out, text);
  };
  const reconcile = (out, kind, candidate) => {
    const current = kind === "text" ? outText : outThinking;
    if (!candidate || candidate === current) return;
    if (candidate.startsWith(current)) {
      emit(out, kind, candidate.slice(current.length));
      return;
    }
    if (current.startsWith(candidate)) return;
    divergences += 1;
  };
  const rebuildFragmentText = () => {
    fragmentsText = "";
    fragmentsThinking = "";
    for (const fragment of fragments) {
      if (isReasoningType(fragment.type)) fragmentsThinking += fragment.content;
      else fragmentsText += fragment.content;
    }
  };
  const replaceFragments = (list, out) => {
    fragments.length = 0;
    for (const f of list) {
      if (f && typeof f === "object" && typeof f.content === "string") {
        fragments.push({ type: String(f.type ?? "RESPONSE"), content: f.content, emitted: 0 });
      }
    }
    rebuildFragmentText();
    sink = fragments.length > 0 ? "fragments" : null;
    if (fragments.length > 0) settleOrphans(out, fragments[0].type);
  };
  const appendFragments = (incoming, out) => {
    const list = Array.isArray(incoming) ? incoming : incoming !== void 0 ? [incoming] : [];
    let settled = false;
    for (const f of list) {
      if (!f || typeof f !== "object" || typeof f.content !== "string") continue;
      const fragment = { type: String(f.type ?? "RESPONSE"), content: f.content, emitted: 0 };
      if (!settled) {
        settled = true;
        settleOrphans(out, fragment.type);
      }
      fragments.push(fragment);
      if (isReasoningType(fragment.type)) {
        fragmentsThinking += fragment.content;
        emitThinking(out, fragment.content);
      } else {
        fragmentsText += fragment.content;
        emitText(out, fragment.content);
      }
    }
    const keepChannel = fragments.length === 0 && (sink === "thinking" || sink === "content");
    if (!keepChannel) sink = fragments.length > 0 ? "fragments" : null;
  };
  const appendToLastFragment = (text, out) => {
    const fragment = fragments[fragments.length - 1];
    if (!fragment) {
      if (sink === "thinking") {
        directThinking += text;
        emitThinking(out, text);
        return;
      }
      if (sink === "content") {
        directText += text;
        emitText(out, text);
        return;
      }
      if (thinkingEnabled) {
        orphanBuffer += text;
        return;
      }
      directText += text;
      emitText(out, text);
      return;
    }
    fragment.content += text;
    if (isReasoningType(fragment.type)) {
      fragmentsThinking += text;
      emitThinking(out, text);
    } else {
      fragmentsText += text;
      emitText(out, text);
    }
  };
  const appendSink = (text, out) => {
    if (sink === "thinking") {
      directThinking += text;
      emitThinking(out, text);
    } else if (sink === "content") {
      directText += text;
      emitText(out, text);
    } else if (sink === "fragments") {
      appendToLastFragment(text, out);
    } else {
      directText += text;
      emitText(out, text);
    }
  };
  return {
    /** 负载处理（增量直接发射；快照只对账）。 */
    handlePayload(d, eventName) {
      const out = [];
      sawData = true;
      if (d && typeof d === "object" && typeof d.response_message_id === "number") {
        options.onResponseMessageId?.(d.response_message_id);
      }
      if (d && typeof d === "object" && d.v && typeof d.v === "object" && d.v.response && typeof d.v.response === "object") {
        const response = d.v.response;
        if (Array.isArray(response.fragments)) {
          replaceFragments(response.fragments, out);
          if (fragments.length > 0) {
            reconcile(out, "thinking", fragmentsThinking);
            reconcile(out, "text", fragmentsText);
          }
        }
        if (typeof response.content === "string") {
          directText = response.content;
          sink = "content";
          if (fragments.length === 0) reconcile(out, "text", directText);
        }
        if (response.finish_reason !== void 0 && response.finish_reason !== null) {
          pendingFinish = String(response.finish_reason);
        }
        return out;
      }
      if (d && typeof d === "object" && d.type === "error") {
        const message = typeof d.content === "string" ? d.content : typeof d.message === "string" ? d.message : "model error";
        const event = {
          kind: "error",
          message,
          ...d.finish_reason !== void 0 ? { raw: String(d.finish_reason) } : {}
        };
        if (isBusyGenerating(message)) {
          event.code = "RATE_LIMIT";
          event.retryAfterMs = 5e3;
          event.rateLimitKind = "concurrent";
        } else if (isThrottled(message)) {
          event.code = "RATE_LIMIT";
          event.retryAfterMs = throttleRetryAfterMs(options.canFailover);
          event.rateLimitKind = "throttled";
        }
        out.push(event);
        return out;
      }
      if (eventName === "toast") {
        const message = d && typeof d === "object" ? d.content ?? d.message ?? JSON.stringify(d) : String(d);
        const full = `DeepSeek toast: ${String(message).slice(0, 200)}`;
        const event = { kind: "error", message: full };
        if (isBusyGenerating(full)) {
          event.code = "RATE_LIMIT";
          event.retryAfterMs = 5e3;
          event.rateLimitKind = "concurrent";
        } else if (isThrottled(full)) {
          event.code = "RATE_LIMIT";
          event.retryAfterMs = throttleRetryAfterMs(options.canFailover);
          event.rateLimitKind = "throttled";
        }
        out.push(event);
        return out;
      }
      if (eventName === "title") return out;
      if (d && typeof d === "object" && d.finish_reason !== void 0 && d.finish_reason !== null) {
        pendingFinish = String(d.finish_reason);
        return out;
      }
      const path = d?.p;
      const value = d?.v;
      if (typeof path === "string") {
        switch (path) {
          case "response/fragments":
            appendFragments(value, out);
            return out;
          case "response/fragments/-1/content": {
            if (typeof value === "string") {
              appendToLastFragment(value, out);
              const keepChannel = fragments.length === 0 && (sink === "thinking" || sink === "content");
              if (!keepChannel) sink = "fragments";
            }
            return out;
          }
          case "response/fragments/-1/elapsed_secs": {
            if (typeof value === "number" && value > 0) settleOrphans(out, "THINK");
            return out;
          }
          case "response/thinking_content":
            if (typeof value === "string") {
              directThinking += value;
              emitThinking(out, value);
              sink = "thinking";
            }
            return out;
          case "response/content":
            if (typeof value === "string") {
              directText += value;
              emitText(out, value);
              sink = "content";
            }
            return out;
          case "response/finish_reason":
            if (typeof value === "string") pendingFinish = value;
            return out;
          case "accumulated_token_usage":
            if (typeof value === "number" && Number.isFinite(value)) totalTokens = value;
            return out;
          case "response/status":
            if (typeof value === "string") {
              out.push({ kind: "status", value });
              if (value === "FINISHED") pendingFinish = pendingFinish ?? "FINISHED";
            }
            return out;
          case "response": {
            if (Array.isArray(value)) {
              for (const op of value) {
                if (op && typeof op === "object" && op.p === "fragments" && op.o === "APPEND" && op.v !== void 0) {
                  appendFragments(op.v, out);
                }
                if (op && typeof op === "object" && op.p === "accumulated_token_usage") {
                  if (typeof op.v === "number" && Number.isFinite(op.v)) totalTokens = op.v;
                }
              }
            }
            return out;
          }
          default:
            return out;
        }
      }
      if (typeof value === "string" && value.length > 0) appendSink(value, out);
      return out;
    },
    /** 对外入口（负载已直接发射增量，这里只做兜底对账）。 */
    handle(d, eventName) {
      return this.handlePayload(d, eventName);
    },
    /** 流结束：产出 finish（若确实收到过数据）。 */
    finish() {
      const out = [];
      if (sawData && orphanBuffer) {
        const text = orphanBuffer;
        orphanBuffer = "";
        if (thinkingEnabled && THINKING_WRAPPER_RE.test(text)) {
          directThinking += text;
          emitThinking(out, text);
        } else {
          directText += text;
          emitText(out, text);
        }
      }
      if (!sawData) return out;
      out.push({ kind: "finish", reason: pendingFinish, ...totalTokens !== void 0 ? { totalTokens } : {} });
      return out;
    },
    /** 诊断：已发射正文/思考长度与快照分歧次数（单测与排查用）。 */
    stats() {
      return {
        text: outText,
        thinking: outThinking,
        divergences,
        ...orphanBuffer ? { orphanLen: orphanBuffer.length } : {},
        ...totalTokens !== void 0 ? { totalTokens } : {}
      };
    }
  };
}
async function* parseWebSse(body, options) {
  const state = createSseState(options);
  let eventName = "";
  let dataLines = [];
  const flushData = () => {
    if (dataLines.length === 0) return { events: [], done: false };
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (data.length === 0) return { events: [], done: false };
    if (data === "[DONE]") return { events: Array.from(state.finish()), done: true };
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return { events: [], done: false };
    }
    return { events: Array.from(state.handle(parsed, eventName)), done: false };
  };
  const dumpPath = dumpSinkPath();
  for await (const line of iterateLines(body)) {
    if (dumpPath) {
      try {
        appendFileSync(dumpPath, line + "\n");
      } catch {
      }
    }
    if (line.length === 0) {
      const flushed = flushData();
      for (const event of flushed.events) yield event;
      if (flushed.done) return;
      eventName = "";
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      const flushed = flushData();
      for (const event of flushed.events) yield event;
      if (flushed.done) return;
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
      continue;
    }
  }
  const tail = flushData();
  for (const event of tail.events) yield event;
  if (tail.done) return;
  for (const event of state.finish()) yield event;
}
var DEFAULT_SESSION_REUSE_TURNS = 20;
var reuseSlots = /* @__PURE__ */ new Map();
var MAX_CONVERSATION_SLOTS = 6;
function slotKeyFor(auth, dshSessionId) {
  const sid = typeof dshSessionId === "string" && dshSessionId.trim() ? dshSessionId.trim() : "(unknown)";
  return `${accountKey(auth)}|${sid}`;
}
function requestSlotKey(auth, params) {
  return params.promptParts ? slotKeyFor(auth, params.dshSessionId) : `internal|${accountKey(auth)}`;
}
var contextChains = /* @__PURE__ */ new Map();
var lastChainKey;
var PERSIST_FILE = "resume-state.json";
var PERSIST_MAX_ENTRIES = 400;
var PERSIST_MAX_BYTES = 4 * 1024 * 1024;
function persistStatePath() {
  return join7(webLoginDir(), PERSIST_FILE);
}
function persistResumeState(opts) {
  if (opts?.persist === false) return;
  try {
    const chains = [...contextChains.entries()].map(([key, s]) => ({
      key,
      state: {
        head: s.head,
        entries: s.entries.length > PERSIST_MAX_ENTRIES ? s.entries.slice(-PERSIST_MAX_ENTRIES) : [...s.entries],
        parentId: s.parentId,
        sessionId: s.sessionId,
        accountKey: s.accountKey
      }
    })).filter(({ state }) => state.entries.length > 0);
    const payload = {
      version: 1,
      savedAt: Date.now(),
      slots: [...reuseSlots.values()].map((s) => ({ key: s.key, sessionId: s.sessionId, turns: s.turns, at: s.at })),
      chains
    };
    const text = JSON.stringify(payload);
    if (text.length > PERSIST_MAX_BYTES) return;
    const file = persistStatePath();
    mkdirSync6(join7(webLoginDir(), "diagnostics"), { recursive: true, mode: 448 });
    const tmp = `${file}.tmp`;
    writeFileSync4(tmp, text, { encoding: "utf8", mode: 384 });
    renameSync2(tmp, file);
  } catch {
  }
}
function restoreResumeState() {
  try {
    const raw = readFileSync6(persistStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return;
    for (const slot of parsed.slots ?? []) {
      if (!slot?.key || !slot.sessionId) continue;
      reuseSlots.set(slot.key, { key: slot.key, sessionId: slot.sessionId, turns: slot.turns, at: slot.at });
    }
    for (const rec of parsed.chains ?? []) {
      if (!rec?.key || !rec.state?.sessionId || !Array.isArray(rec.state.entries)) continue;
      if (rec.state.entries.length === 0) continue;
      contextChains.set(rec.key, { ...rec.state, entries: [...rec.state.entries] });
      lastChainKey = lastChainKey ?? rec.key;
    }
  } catch {
  }
}
restoreResumeState();
var lastRetireReason;
var sentRefIdsBySession = /* @__PURE__ */ new Map();
function dropSentRefIds(sessionId) {
  sentRefIdsBySession.delete(sessionId);
}
var lastFeedReason;
function feedDecisionLogPath() {
  return join7(webLoginDir(), "feed-decisions.jsonl");
}
var FEED_DECISION_KEEP = 300;
var FEED_DECISION_MAX_BYTES = 256 * 1024;
function noteFeedDecision(note) {
  try {
    const file = feedDecisionLogPath();
    mkdirSync6(join7(file, ".."), { recursive: true });
    appendFileSync(file, `${JSON.stringify(note)}
`, "utf8");
    if (statSync2(file).size > FEED_DECISION_MAX_BYTES) {
      const lines = readFileSync6(file, "utf8").split("\n").filter(Boolean);
      writeFileSync4(file, `${lines.slice(-FEED_DECISION_KEEP).join("\n")}
`, "utf8");
    }
  } catch {
  }
}
function resetContextChain() {
  contextChains.clear();
  lastChainKey = void 0;
  lastFeedReason = void 0;
  persistResumeState({ persist: false });
}
function contextChainInfo() {
  const chain = (lastChainKey !== void 0 ? contextChains.get(lastChainKey) : void 0) ?? [...contextChains.values()].pop();
  if (!chain) return void 0;
  return {
    sessionId: chain.sessionId,
    turns: chain.entries.length,
    parentId: chain.parentId,
    // 同时养着几条会话（＝几个 DSH 窗口各一条）
    slots: reuseSlots.size,
    // 上一次收尾为什么把会话退役了（`rotated` 是正常轮换；`not-finished` 是异常）。
    ...lastRetireReason ? { lastRetire: lastRetireReason } : {}
  };
}
function accountKey(auth) {
  const userId = auth?.user?.id;
  const raw = typeof userId === "string" && userId ? `uid:${userId}` : `${auth?.token ?? ""}|${auth?.cookie ?? ""}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
async function leaseSession(auth, signal, transport, maxTurns, cleanup2, forceNew = false, slotKey = "") {
  signal.throwIfAborted();
  const key = slotKey || accountKey(auth);
  const configured = Number.isFinite(maxTurns) ? Math.max(0, Math.floor(maxTurns)) : DEFAULT_SESSION_REUSE_TURNS;
  const limit = effectiveReuseLimit(configured, currentContextMode());
  if (limit === 0) return { sessionId: await transport.createSession(auth, signal), reused: false };
  const slot = reuseSlots.get(key);
  if (!forceNew && slot && slot.turns < limit) {
    slot.turns += 1;
    slot.at = Date.now();
    persistResumeState();
    return { sessionId: slot.sessionId, reused: true };
  }
  const previous = slot;
  const sessionId = await transport.createSession(auth, signal);
  if (signal.aborted) {
    try {
      cleanup2?.(sessionId);
    } catch {
    }
    signal.throwIfAborted();
  }
  reuseSlots.set(key, { key, sessionId, turns: 1, at: Date.now(), ...cleanup2 ? { cleanup: cleanup2 } : {} });
  persistResumeState();
  evictIdleSlots();
  emitSessionLifecycle({ kind: "leased", auth, sessionId });
  if (previous) {
    try {
      previous.cleanup?.(previous.sessionId);
    } catch {
    }
  }
  return { sessionId, reused: false };
}
function evictIdleSlots() {
  if (reuseSlots.size <= MAX_CONVERSATION_SLOTS) return;
  const idle = [...reuseSlots.values()].sort((a, b) => a.at - b.at);
  for (const slot of idle.slice(0, reuseSlots.size - MAX_CONVERSATION_SLOTS)) {
    reuseSlots.delete(slot.key);
    contextChains.delete(slot.key);
    dropSentRefIds(slot.sessionId);
    persistResumeState();
    if (lastChainKey === slot.key) lastChainKey = void 0;
  }
}
function retireSession(sessionId) {
  if (!sessionId) {
    reuseSlots.clear();
    contextChains.clear();
    sentRefIdsBySession.clear();
    persistResumeState();
    lastChainKey = void 0;
    return;
  }
  dropSentRefIds(sessionId);
  for (const [key, slot] of [...reuseSlots]) {
    if (slot.sessionId === sessionId) reuseSlots.delete(key);
  }
  for (const [key, chain] of [...contextChains]) {
    if (chain.sessionId === sessionId) contextChains.delete(key);
  }
  persistResumeState();
  if (lastChainKey !== void 0 && !contextChains.has(lastChainKey)) lastChainKey = void 0;
}
function disposeSessionReuse() {
  const slots = [...reuseSlots.values()];
  reuseSlots.clear();
  contextChains.clear();
  lastChainKey = void 0;
  persistResumeState({ persist: false });
  sentRefIdsBySession.clear();
  if (slots.length === 0) return void 0;
  for (const slot of slots) {
    try {
      slot.cleanup?.(slot.sessionId);
    } catch {
    }
  }
  return slots[slots.length - 1]?.sessionId;
}
var defaultTransport = { createSession: createChatSession, powHeader: createPowHeader };
function makeCanFailover(params) {
  return (kind) => {
    try {
      return params.canFailover?.(kind) === true;
    } catch {
      return false;
    }
  };
}
async function openCompletion(auth, params, signal, transport, keepIds) {
  let lastFailure;
  const canFailover = makeCanFailover(params);
  const slotKey = requestSlotKey(auth, params);
  for (let attempt = 0; attempt < 2; attempt++) {
    let lease = await leaseSession(
      auth,
      signal,
      transport,
      params.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS,
      params.onDeleteSession,
      false,
      slotKey
    );
    const planFeed = (sessionId2, reused) => decideFeed({
      mode: currentContextMode(),
      ...params.promptParts ? {
        head: params.promptParts.head,
        entries: params.promptParts.entries,
        // 重发时省掉固定头（约 6.35 万字符）—— 见 FeedInput.transcript
        ...typeof params.promptParts.transcript === "string" ? { transcript: params.promptParts.transcript } : {},
        ...params.promptParts.maxChars !== void 0 ? { maxChars: params.promptParts.maxChars } : {}
      } : {},
      full: params.prompt,
      sessionId: sessionId2,
      accountKey: accountKey(auth),
      reused,
      ...contextChains.get(slotKey) ? { chain: contextChains.get(slotKey) } : {}
    });
    let feed = planFeed(lease.sessionId, lease.reused);
    if (needsFreshSession(feed, lease.reused, currentContextMode(), params.promptParts !== void 0)) {
      const reason = feed.reason;
      lease = await leaseSession(
        auth,
        signal,
        transport,
        params.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS,
        params.onDeleteSession,
        true,
        slotKey
      );
      feed = { ...planFeed(lease.sessionId, lease.reused), reason };
    }
    const sessionId = lease.sessionId;
    {
      const chainForNote = contextChains.get(slotKey);
      const chainEntries = chainForNote?.entries;
      const currentEntries = params.promptParts?.entries;
      noteFeedDecision({
        at: Date.now(),
        reason: feed.reason,
        reused: lease.reused,
        session: String(sessionId).slice(0, 8),
        account: accountKey(auth),
        chainLen: chainEntries ? chainEntries.length : null,
        entriesLen: currentEntries ? currentEntries.length : null,
        // 体量：唯一权威来源（未截断的实际发送串）
        promptChars: feed.prompt.length,
        headChars: params.promptParts ? String(params.promptParts.head ?? "").length : null,
        firstDiff: !chainEntries || !currentEntries ? null : firstDifference(chainEntries, currentEntries),
        stats: {
          assistant: (feed.prompt.match(/^Assistant: /gm) ?? []).length,
          user: (feed.prompt.match(/^User: /gm) ?? []).length,
          toolResult: (feed.prompt.match(/^\[Tool Result/gm) ?? []).length,
          systemBlocks: (feed.prompt.match(/^\[System\]/gm) ?? []).length
        },
        tailSame: !chainEntries || !currentEntries ? null : currentEntries.length <= chainEntries.length ? false : currentEntries[chainEntries.length - 1] === chainEntries[chainEntries.length - 1]
      });
    }
    if (feed.reason !== lastFeedReason) {
      lastFeedReason = feed.reason;
      params.onContextFeed?.({
        reason: feed.reason,
        // 🔴 判据是 reason，**不是** `parentMessageId !== null`（0.6.23 修）。
        // 0.6.23 起"退回全量"也挂在链尾（parent != null），拿 parent 判会把
        // "这一轮其实重发了全量"报成 chained=true —— 日志会直接说谎。
        chained: feed.reason === "chained",
        promptChars: feed.prompt.length,
        echoDropped: feed.echoDropped ?? 0
      });
    }
    const sentRefIds = sentRefIdsBySession.get(sessionId) ?? /* @__PURE__ */ new Set();
    const askedRefItems = (params.refFileIds ?? []).map((id, index) => ({
      id,
      key: params.refKeys?.[index] ?? id
    }));
    const refItemsToSend = feed.parentMessageId !== null ? askedRefItems.filter((item) => !sentRefIds.has(item.key)) : askedRefItems;
    const refIdsToSend = refItemsToSend.map((item) => item.id);
    let resp;
    try {
      resp = await activeFetch(`${DS_BASE}/api/v0/chat/completion`, {
        method: "POST",
        headers: {
          ...buildDsHeaders(auth, `${DS_BASE}/a/chat/s/${sessionId}`),
          accept: "text/event-stream",
          "x-ds-pow-response": await transport.powHeader(auth, "/api/v0/chat/completion", signal)
        },
        body: JSON.stringify({
          chat_session_id: sessionId,
          // 链式投喂时是上一条 assistant 的 message_id；全量模式恒为 null（根消息、无父链）。
          parent_message_id: feed.parentMessageId,
          prompt: feed.prompt,
          ref_file_ids: refIdsToSend,
          thinking_enabled: params.thinkingEnabled,
          search_enabled: params.searchEnabled ?? false,
          model_type: params.modelType,
          action: null,
          preempt: false
        }),
        signal
      });
    } catch (error) {
      const rejected = error instanceof AdapterLlmError && (error.code === "AUTH" || error.code === "RATE_LIMIT");
      if (rejected) keepIds?.add(sessionId);
      else {
        retireSession(sessionId);
        params.onDeleteSession?.(sessionId);
      }
      if (error instanceof AdapterLlmError) throw error;
      if (params.signal?.aborted) throw new AdapterLlmError("DeepSeek web request aborted by caller", "ABORTED", { cause: error });
      throw new AdapterLlmError(`DeepSeek web request failed: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
    }
    if (!resp.ok) {
      const text2 = await resp.text().catch(() => "");
      const code = httpErrorCode(resp.status);
      const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
      const hint = code === "AUTH" ? " \u2014\u2014 \u7F51\u9875\u767B\u5F55\u6001\u53EF\u80FD\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u5230\u300C\u8BBE\u7F6E \u2192 DeepSeek \u7F51\u9875\u767B\u5F55\u300D\u91CD\u65B0\u767B\u5F55" : code === "RATE_LIMIT" ? " \u2014\u2014 \u7F51\u9875\u7248\u9650\u6D41" : "";
      if (code === "AUTH" || code === "RATE_LIMIT") keepIds?.add(sessionId);
      else {
        retireSession(sessionId);
        params.onDeleteSession?.(sessionId);
      }
      const authRetryAfterMs = code === "AUTH" ? canFailover("auth") ? AUTH_FAILOVER_RETRY_MS : AUTH_GIVEUP_RETRY_MS : void 0;
      throw new AdapterLlmError(
        `DeepSeek web completion failed (HTTP ${resp.status})${text2 ? `: ${text2.slice(0, 200)}` : ""}${hint}`,
        code,
        {
          status: resp.status,
          // 服务端给了 Retry-After 就以它为准（那是它自己说的解除时间）；没给才用我们的两档。
          ...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : authRetryAfterMs !== void 0 ? { providerRetryAfterMs: authRetryAfterMs } : {},
          cause: new Error(text2)
        }
      );
    }
    if (!resp.body) {
      retireSession(sessionId);
      params.onDeleteSession?.(sessionId);
      throw new AdapterLlmError("DeepSeek web completion returned no body", "EMPTY_RESPONSE");
    }
    const contentType = String(resp.headers.get("content-type") ?? "");
    if (contentType.includes("text/event-stream")) {
      for (const item of refItemsToSend) sentRefIds.add(item.key);
      sentRefIdsBySession.set(sessionId, sentRefIds);
      return { sessionId, resp, feed };
    }
    const text = await resp.text().catch(() => "");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
    }
    const biz = envelopeError(parsed);
    const muted = isMutedError(biz);
    const busy = !muted && !!biz && isBusyGenerating(biz.msg);
    const throttled = !muted && !busy && !!biz && (biz.code === 40029 || isThrottled(biz.msg));
    const untilMs = muteUntilMs(parsed);
    const failureCode = !biz ? "MALFORMED_RESPONSE" : muted || busy || throttled ? "RATE_LIMIT" : isInvalidSessionError(biz) ? "TRANSPORT" : isInvalidRefFileError(biz) ? "INVALID_REF_FILE" : bizErrorCode(biz.code);
    const failure = biz ? new AdapterLlmError(
      muted ? mutedMessage(untilMs) : busy ? "\u7F51\u9875\u7248\u9650\u6D41\uFF1A\u540C\u4E00\u8D26\u53F7\u540C\u65F6\u53EA\u80FD\u751F\u6210\u4E00\u6761\u6D88\u606F\uFF0C\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5" : throttled ? "\u7F51\u9875\u7248\u9650\u6D41\uFF1A\u53D1\u5F97\u592A\u9891\u7E41\uFF0C\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5" : bizErrorMessage(biz.code, biz.msg),
      failureCode,
      {
        status: resp.status,
        // 解除时间远大于重试策略的上限 → dsh-llm-retry 会直接放弃重试（而不是空转打请求）
        // ⚠️ 但如果**能换号**（宿主开了自动换号且还有可用候选），就不要放弃 —— 给短退避，
        // 让重试立刻发生；重发时自动换号的检查点会换上可用账号，整轮任务自己就能接下去。
        ...muted && untilMs !== void 0 ? {
          providerRetryAfterMs: canFailover("muted") ? FAILOVER_RETRY_MS : Math.max(0, untilMs - Date.now())
        } : {},
        // 绝对值单独带一份：宿主会把它记到账号上，在设置页显示倒计时
        ...muted && untilMs !== void 0 ? { mutedUntilMs: untilMs } : {},
        // 0.6.8 授权失效（信封里的 40003/40001）：与 HTTP 401 那条同样处理 ——
        // 能换号 ⇒ 5s 后重发（检查点换号接上）；不能 ⇒ 600s > maxDelayMs ⇒ 直接放弃重试。
        ...failureCode === "AUTH" ? { providerRetryAfterMs: canFailover("auth") ? AUTH_FAILOVER_RETRY_MS : AUTH_GIVEUP_RETRY_MS } : {},
        ...busy ? { providerRetryAfterMs: 5e3 } : {},
        // 节流：能换号给 2s（让重试立刻发生），否则 20s（HTTP 路径的定值；
        // SSE 路径走渐长的 throttleRetryAfterMs，首档 40s —— 两条路都受同一个
        // "能不能换号"支配，值不同只是因为 SSE 那边还有"越撞越长"的语义）
        ...throttled ? { rateLimitKind: "throttled", providerRetryAfterMs: canFailover("throttled") ? FAILOVER_RETRY_MS : THROTTLE_RETRY_MS } : {}
      }
    ) : new AdapterLlmError(
      `DeepSeek \u7F51\u9875\u7AEF\u8FD4\u56DE\u4E86\u975E\u6D41\u5F0F\u54CD\u5E94\uFF08content-type: ${contentType || "unknown"}\uFF09\uFF1A${text.slice(0, 200)}`,
      "MALFORMED_RESPONSE",
      { status: resp.status }
    );
    const accountLevel = !!biz && (muted || busy || throttled || failureCode === "AUTH");
    const ruined = !!biz && isInvalidSessionError(biz);
    if (accountLevel) {
      keepIds?.add(sessionId);
    } else {
      retireSession(sessionId);
      params.onDeleteSession?.(sessionId);
    }
    if (attempt === 0 && ruined) {
      lastFailure = failure;
      continue;
    }
    throw failure;
  }
  throw lastFailure ?? new AdapterLlmError("DeepSeek \u7F51\u9875\u7AEF\u65E0\u6CD5\u5EFA\u7ACB\u53EF\u7528\u4F1A\u8BDD", "PROVIDER_ERROR");
}
var reuseFlightTail = Promise.resolve();
async function* streamWebCompletion(auth, params, transport = defaultTransport) {
  const controller = new AbortController();
  const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;
  const slotKey = requestSlotKey(auth, params);
  let sentChainKey;
  const canFailover = makeCanFailover(params);
  const rawLimit = params.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS;
  const limit = effectiveReuseLimit(
    Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : DEFAULT_SESSION_REUSE_TURNS,
    currentContextMode()
  );
  let release;
  let sessionId;
  let iterator;
  let body;
  let complete = false;
  let sawTerminal = false;
  let poisoned = false;
  let timer;
  let sentFeed;
  let responseMessageId;
  const deleted = /* @__PURE__ */ new Set();
  const cleanup2 = (id) => {
    if (deleted.has(id)) return;
    deleted.add(id);
    try {
      params.onDeleteSession?.(id);
    } catch {
    }
  };
  const wait = (promise) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => {
      });
      reject(signal.reason);
      return;
    }
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
  const arm = (ms, message) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new AdapterLlmError(message, "TIMEOUT")), ms);
    timer.unref?.();
  };
  const owned = /* @__PURE__ */ new Set();
  const keepIds = /* @__PURE__ */ new Set();
  let finalized = false;
  const tracked = {
    ...transport,
    createSession: async (value, sig) => {
      const id = await transport.createSession(value, sig);
      if (finalized) {
        retireSession(id);
        cleanup2(id);
      } else {
        owned.add(id);
      }
      return id;
    }
  };
  try {
    signal.throwIfAborted();
    if (limit > 0) {
      const previous = reuseFlightTail;
      const mine = new Promise((resolve) => {
        release = resolve;
      });
      reuseFlightTail = previous.then(
        () => mine,
        () => mine
      );
      await wait(previous);
    }
    const connectMs = Number.isFinite(params.connectTimeoutMs) && params.connectTimeoutMs > 0 ? Math.min(params.connectTimeoutMs, 6e5) : 45e3;
    arm(connectMs, `DeepSeek \u5EFA\u7ACB\u6D41\u8D85\u65F6\uFF08${connectMs}ms\uFF09`);
    const opened = await wait(
      openCompletion(
        auth,
        { ...params, sessionReuseTurns: limit, onDeleteSession: cleanup2 },
        signal,
        tracked,
        keepIds
      )
    );
    sessionId = opened.sessionId;
    sentFeed = opened.feed;
    sentChainKey = slotKey;
    body = opened.resp.body;
    if (timer) clearTimeout(timer);
    iterator = parseWebSse(body, {
      thinkingEnabled: params.thinkingEnabled,
      // 🔴 必须传下去：SSE 节流的退避取决于"还能不能换号"。少了它，节流会抛 40~117s，
      // 超过 dsh-llm 策略上限 ⇒ 一次都不重试、整轮失败（实测 2026-09-27 14:35:32）。
      canFailover,
      onResponseMessageId: (id) => {
        responseMessageId = id;
      }
    });
    const idle = Number.isFinite(params.idleTimeoutMs) && params.idleTimeoutMs > 0 ? Math.min(params.idleTimeoutMs, 6e5) : 12e4;
    for (; ; ) {
      arm(idle, `DeepSeek \u6D41\u7B49\u5F85\u8D85\u65F6\uFF08${idle}ms\uFF09`);
      const item = await wait(iterator.next());
      if (timer) clearTimeout(timer);
      if (item.done) {
        complete = true;
        break;
      }
      if (item.value.kind === "error") poisoned = true;
      if (item.value.kind === "finish" || item.value.kind === "status" && item.value.value === "FINISHED") {
        sawTerminal = true;
      }
      yield item.value;
    }
  } catch (error) {
    if (params.signal?.aborted) throw new AdapterLlmError("\u8BF7\u6C42\u5DF2\u53D6\u6D88", "ABORTED", { cause: error });
    if (controller.signal.aborted && controller.signal.reason instanceof AdapterLlmError) throw controller.signal.reason;
    if (error instanceof AdapterLlmError) throw error;
    throw new AdapterLlmError("DeepSeek \u6D41\u8BF7\u6C42\u5931\u8D25", "TRANSPORT", { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    if (iterator) {
      void iterator.return(void 0).catch(() => {
      }).finally(() => {
        if (body && !body.locked) void body.cancel().catch(() => {
        });
      });
    }
    finalized = true;
    const roundOk = complete || sawTerminal;
    lastRetireReason = void 0;
    if (params.promptParts === void 0) {
      const scaffolding = new Set(owned);
      if (sessionId) scaffolding.add(sessionId);
      for (const id of scaffolding) {
        retireSession(id);
        params.onDiscardSession?.(id);
      }
    } else {
      for (const id of owned) {
        if (limit > 0 && keepIds.has(id) && !poisoned) continue;
        if (id === sessionId && roundOk && !poisoned && limit > 0) continue;
        lastRetireReason = id !== sessionId ? "extra-session" : poisoned ? "poisoned" : !roundOk ? "not-finished" : "rotated";
        retireSession(id);
        cleanup2(id);
      }
    }
    if (sentFeed?.next && roundOk && !poisoned && typeof responseMessageId === "number") {
      contextChains.set(slotKey, { ...sentFeed.next, parentId: responseMessageId });
      lastChainKey = slotKey;
      persistResumeState();
    } else if (sentChainKey !== void 0 && params.promptParts !== void 0) {
      contextChains.delete(sentChainKey);
      if (lastChainKey === sentChainKey) lastChainKey = void 0;
      persistResumeState();
    }
    release?.();
  }
}

// src/probe.ts
var SWITCH_PROBE_TIMEOUT_MS = 1e4;
async function probeOnce(auth, logger, options) {
  if (!hasUsableAuth(auth)) return void 0;
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const target = listAccounts().find((item) => item.token === auth.token);
  let outcome;
  try {
    const result = await validateAuth(auth, AbortSignal.timeout(options?.timeoutMs ?? 2e4));
    outcome = result.ok ? {
      ok: true,
      at,
      ...result.user ? { user: result.user } : {},
      ...result.limit ? { limit: result.limit } : {}
    } : {
      ok: false,
      at,
      error: result.error ?? "\u6821\u9A8C\u672A\u901A\u8FC7",
      errorKind: isAuthFailureMessage(result.error) ? "auth" : "transport"
    };
  } catch (error) {
    const message = describeError(error);
    outcome = { ok: false, at, error: message, errorKind: isAuthFailureMessage(message) ? "auth" : "transport" };
  }
  if (target) {
    if (outcome.ok) {
      const patch = {
        lastVerifiedAt: at,
        lastVerifyError: void 0,
        // 两个失败标记一起清：留着一个旧的「网络未能校验」会让人以为现在还连不上。
        lastCheckError: void 0,
        unverified: false
      };
      if (outcome.limit) {
        patch.limit = outcome.limit.muted && outcome.limit.untilMs ? { untilMs: outcome.limit.untilMs, observedAt: at } : void 0;
      }
      if (outcome.user) {
        patch.user = { ...target.user ?? {}, ...outcome.user };
        const verifiedId = outcome.user.id;
        if (typeof verifiedId === "string" && verifiedId) patch.serverId = verifiedId;
      }
      updateAccount(target.id, patch);
    } else {
      const failure = { at, message: String(outcome.error ?? "") };
      updateAccount(
        target.id,
        outcome.errorKind === "auth" ? { lastVerifyError: failure, lastCheckError: void 0 } : { lastCheckError: failure }
      );
    }
  }
  if (outcome.ok) {
    logger?.info?.(`deepseek-web: \u767B\u5F55\u6001\u63A2\u6D3B\u901A\u8FC7\uFF08${target?.id ?? "\u672A\u77E5\u8D26\u53F7"}\uFF09`);
  } else {
    const tail = outcome.errorKind === "auth" ? "\u6388\u6743\u5DF2\u5931\u6548\uFF0C\u5EFA\u8BAE\u91CD\u65B0\u767B\u5F55" : "\u7F51\u7EDC\u7C7B\u95EE\u9898\uFF08\u51ED\u8BC1\u672A\u5224\u5B9A\u5931\u6548\uFF0C\u7F51\u7EDC\u6062\u590D\u540E\u518D\u8BD5\uFF09";
    logger?.warn?.(`deepseek-web: \u767B\u5F55\u6001\u63A2\u6D3B\u5931\u8D25 \u2014\u2014 ${outcome.error}\uFF08${tail}\uFF09`);
  }
  return outcome;
}
function planRelogin(probe) {
  if (probe?.ok) return "already-valid";
  if (probe?.errorKind === "transport") return "network";
  return "fresh-login";
}
function switchGateFromProbe(probe) {
  if (!probe || probe.ok) return "ok";
  return probe.errorKind === "auth" ? "relogin" : "warn";
}
function startProbeLoop(options) {
  if (!(options.intervalMs > 0)) return () => {
  };
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    try {
      await probeOnce(options.getAuth(), options.logger);
    } catch {
    }
    if (stopped) return;
    timer = setTimeout(tick, options.intervalMs);
    timer?.unref?.();
  };
  timer = setTimeout(tick, options.initialDelayMs ?? 2e4);
  timer?.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
function staleAuthMessage(auth) {
  if (!auth) return void 0;
  const record = listAccounts().find((item) => item.token === auth.token);
  return staleAuthRecord(record);
}

// src/adapter.ts
function noteCallShape(shape, logger) {
  try {
    const dir = joinPath(webLoginDir(), "diagnostics");
    mkdirSync7(dir, { recursive: true, mode: 448 });
    const file = joinPath(dir, "call-shapes.jsonl");
    const line = JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), shape }) + "\n";
    let size = 0;
    try {
      size = statSync3(file).size;
    } catch {
    }
    if (size + Buffer.byteLength(line) > 4e6) return;
    appendFileSync2(file, line, { encoding: "utf8", mode: 384 });
  } catch {
    try {
      logger?.debug?.("deepseek-web: \u8C03\u7528\u5F62\u6001\u7559\u75D5\u5199\u5165\u5931\u8D25");
    } catch {
    }
  }
}
function dumpRejectedPayload(raw, mode, reason, logger) {
  try {
    const dir = joinPath(webLoginDir(), "diagnostics");
    mkdirSync7(dir, { recursive: true, mode: 448 });
    const file = joinPath(dir, "rejected-meta.jsonl");
    const knownMode = ["json", "xml", "dsml"].includes(mode) ? mode : "other";
    const knownReason = ["unbalanced", "unparsable", "oversize", "echo"].includes(reason ?? "") ? reason : "other";
    const line = JSON.stringify({
      at: (/* @__PURE__ */ new Date()).toISOString(),
      mode: knownMode,
      reason: knownReason,
      length: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex")
    }) + "\n";
    let size = 0;
    try {
      size = statSync3(file).size;
    } catch {
    }
    if (size + Buffer.byteLength(line) > 4e6) return;
    appendFileSync2(file, line, { encoding: "utf8", mode: 384 });
  } catch {
    try {
      logger?.debug?.("deepseek-web: \u8BCA\u65AD\u5143\u4FE1\u606F\u5199\u5165\u5931\u8D25");
    } catch {
    }
  }
}
var ImageUploadCache = class {
  scope = "";
  entries = /* @__PURE__ */ new Map();
  // ⚠️ 不要写成「constructor 的参数属性」（`constructor(private readonly ttlMs: number)`）：
  // 测试是 `node src/xxx.ts` 直接跑的，而 Node 的类型剥离只支持「擦除型」语法 ——
  // 参数属性需要生成赋值代码，会被判为不支持的语法（实测报 ERR_INVALID_TYPESCRIPT_SYNTAX）。
  ttlMs;
  maxEntries;
  constructor(ttlMs = 2 * 60 * 60 * 1e3, maxEntries = 256) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }
  /** 绑定当前账号：token 变了就整批清掉（上一个账号的 fileId 不能跨号复用）。 */
  useScope(token) {
    if (this.scope !== token) {
      this.entries.clear();
      this.scope = token;
    }
  }
  /** 当前作用域（`set` 前校验用：await 期间可能被别的账号切走）。 */
  currentScope() {
    return this.scope;
  }
  /** 清掉**所有**过期项，返回清掉的条数（不只清理"这次要查的那一个"）。 */
  prune(now = Date.now()) {
    let removed = 0;
    for (const [key, value] of this.entries) {
      if (now - value.at >= this.ttlMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
  /** 命中且未过期才返回；顺手清掉这一条过期项。 */
  get(key, now = Date.now(), expectScope) {
    const hit = this.entries.get(key);
    if (!hit) return void 0;
    if (expectScope !== void 0 && expectScope !== this.scope) return void 0;
    if (now - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return void 0;
    }
    return hit.fileId;
  }
  /**
   * 写入并封顶（超出时丢最早写入的项）。
   * `expectScope` 用于防"await 期间账号被切走"：作用域已变则拒绝写入。
   */
  set(key, fileId, now = Date.now(), expectScope) {
    if (expectScope !== void 0 && expectScope !== this.scope) return false;
    this.entries.delete(key);
    this.entries.set(key, { fileId, at: now });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0) break;
      this.entries.delete(oldest);
    }
    return true;
  }
  /** 当前条数（测试用）。 */
  get size() {
    return this.entries.size;
  }
  /**
   * 定点删除指定的若干条（用于「这批 file_id 被服务端拒了」时的清理）。
   *
   * 为什么不做成全清（`reset()`）：一次请求可能只用到历史里的一小部分图，
   * 全清会让下一次请求把**所有**历史图重新传一遍 —— 白白多几十次上传请求，
   * 而上传本身也是要被风控看的。知道是哪几条被拒，就只清那几条。
   * 返回真正删掉的条数（便于测试与日志）。
   */
  invalidate(keys) {
    let removed = 0;
    for (const key of keys) {
      if (this.entries.delete(key)) removed += 1;
    }
    return removed;
  }
  /** 清空（测试隔离用）。 */
  reset() {
    this.entries.clear();
    this.scope = "";
  }
};
function canRetryImageReject(error, yielded, attempt) {
  return error?.code === "INVALID_REF_FILE" && !yielded && attempt < 2;
}
var TRIM_NOTICE_FLOOR = 10;
function nextTrimNoticeThreshold(previous, keptCount) {
  if (!previous || previous.kept !== keptCount) return 1;
  return Math.max(TRIM_NOTICE_FLOOR, previous.dropped * 2);
}
var PROVIDER = "deepseek-web";
var MODEL_SPECS = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Web \xB7 Fast (no thinking)",
    description: "Same model, thinking off: direct answers, fastest, saves free quota. Good for tool calls / rewrite / retrieval",
    modelType: "default",
    thinking: false,
    configurableThinking: true,
    contextWindow: 1048576,
    maxOutputTokens: 16384
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Web \xB7 Fast (deep thinking)",
    description: "Same model, thinking on: reason then answer (reasoning stream as thinking blocks). Better for math / multi-step debug / planning; slower and uses more quota",
    modelType: "default",
    thinking: true,
    configurableThinking: true,
    contextWindow: 1048576,
    maxOutputTokens: 32768
  }
];
var LEGACY_ALIASES = {
  "deepseek-pro": "deepseek-reasoner",
  "deepseek-expert": "deepseek-reasoner",
  "deepseek-vision": "deepseek-chat"
};
var EFFORT_OFF = "off";
var EFFORT_LOW = "low";
var EFFORT_HIGH = "high";
var EFFORT_MAX = "max";
var REASONING_EFFORTS = [
  { id: EFFORT_OFF, name: "Off", description: "Thinking off (web fast mode)" },
  { id: EFFORT_LOW, name: "Low", description: "Thinking on (web only has on/off; same as High)" },
  { id: EFFORT_HIGH, name: "High", description: "Thinking on (default)" },
  { id: EFFORT_MAX, name: "Max", description: "Thinking on (web only has on/off; same as High)" }
];
var OFF_ONLY_EFFORTS = [{ id: EFFORT_OFF, name: "Off", description: "This model is fixed to non-thinking mode" }];
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 12288 && code <= 40959) cjk += 1;
  }
  const ascii = text.length - cjk;
  return Math.ceil(cjk / 1.5 + ascii / 4);
}
function isContextTooLong(message) {
  return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|too\s+many\s+tokens|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)|содержани|контекст/i.test(
    message
  );
}
function modelInfoFor(provider, spec, requestedId) {
  return {
    provider,
    id: requestedId ?? spec.id,
    name: spec.name,
    description: spec.description,
    // 图片输入走「上传成文件 + ref_file_ids」通道（网页端看图的实际机制），
    // 已实测：上传左红右蓝 PNG 后模型准确答出「左红色，右=蓝色」。
    inputModalities: ["text", "image"]
  };
}
function resolvedModelInfo(provider, spec, requestedId, contextWindowOverride) {
  return {
    ...modelInfoFor(provider, spec, requestedId),
    context: { contextWindow: contextWindowOverride ?? spec.contextWindow },
    defaultMaxTokens: spec.maxOutputTokens,
    reasoning: spec.configurableThinking ? { efforts: REASONING_EFFORTS, defaultEffort: spec.thinking ? EFFORT_HIGH : EFFORT_OFF } : { efforts: OFF_ONLY_EFFORTS, defaultEffort: EFFORT_OFF }
  };
}
function resolveSpec(model) {
  const requested = String(model ?? "");
  const direct = MODEL_SPECS.find((spec) => spec.id === requested);
  if (direct) return direct;
  const alias = LEGACY_ALIASES[requested];
  if (alias) {
    const mapped = MODEL_SPECS.find((spec) => spec.id === alias);
    if (mapped) return mapped;
  }
  return MODEL_SPECS[0];
}
function resolveThinking(options, spec) {
  if (options?.purpose === "session-title" || options?.purpose === "compaction") return { thinkingEnabled: false };
  if (!spec.configurableThinking) return { thinkingEnabled: spec.thinking };
  const effort = options?.reasoningEffort;
  if (effort === void 0) return { thinkingEnabled: spec.thinking };
  if (effort === EFFORT_OFF) return { thinkingEnabled: false };
  if (effort === EFFORT_LOW || effort === EFFORT_HIGH || effort === EFFORT_MAX) return { thinkingEnabled: true };
  throw new AdapterLlmError(`deepseek-web \u4E0D\u652F\u6301 reasoning effort "${String(effort)}"`, "UNSUPPORTED_REASONING_EFFORT");
}
var MID_SENTENCE_TAIL = /* @__PURE__ */ new Set(["\uFF0C", "\u3001", "\uFF1B", "\uFF1A", ",", ";", ":"]);
var COMPLETE_TAIL = /* @__PURE__ */ new Set(["\u3002", "\uFF01", "\uFF1F", "!", "?", "\u2026", "\uFF09", ")", "\u3011", "\u300B", "\u300D", "\u300F", '"', "\u201D", "\u2019"]);
function looksMidSentence(text) {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;
  if (trimmed.length < 40) return false;
  const last = trimmed[trimmed.length - 1];
  if (last === "*" || last === "_" || last === "#" || last === "~" || last === "`") {
    return trimmed.endsWith("**") || trimmed.endsWith("__");
  }
  if (MID_SENTENCE_TAIL.has(last)) return true;
  if (COMPLETE_TAIL.has(last)) return false;
  return /[a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff]/.test(last);
}
function allowsAutoContinue(purpose) {
  return purpose === void 0 || purpose === null || purpose === "" || purpose === "chat";
}
var RETRY_POLICY = Object.freeze({
  mode: "normal",
  maxRetries: 5,
  // ⚠️ 'AUTH' 是 0.6.8 加进来的，但它**不是**无条件可重试 —— 见下面两档 AUTH 退避：
  // 能换号（自动换号开着 + 账号库里还有可用候选）⇒ 5s 后重发，重发进入适配器时换号检查点
  // 会换上可用账号，整轮任务自己接下去；不能换号 ⇒ 600s > maxDelayMs ⇒ 重试策略直接放弃
  // （重试一个已失效的凭证只会白打请求）。所以"包不包含 AUTH"这个问题的答案由退避值决定，
  // 不由这个数组决定 —— 数组里没有 AUTH 的话，那条 5s 永远没机会被用上。
  retryableCodes: Object.freeze(["EMPTY_RESPONSE", "AUTH", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]),
  initialDelayMs: FAILOVER_RETRY_MS,
  maxDelayMs: MAX_THROTTLE_RETRY_MS,
  jitterRatio: 0.2
});
function createAdapter(deps) {
  const logger = deps.config.logger;
  const runStream = deps.streamCompletion ?? streamWebCompletion;
  const uploadImage = deps.uploadImage ?? uploadImageFile;
  const gate = deps.gate ?? createRequestGate({
    allowConcurrent: deps.config.allowConcurrent === true,
    minIntervalMs: deps.config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    logger
  });
  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: "DeepSeek Web (free)" };
    },
    /**
     * 重试策略：**必须显式给**（理由见 `RETRY_POLICY` 的注释）——
     * 返回 `undefined` 会落到 dsh-llm 的默认上限 10s，而我们的限流退避是 40~117s，
     * 于是"要等太久 ⇒ 放弃重试 ⇒ 用户手点继续"。
     */
    providerRetryPolicy(_provider) {
      return RETRY_POLICY;
    },
    /**
     * 图片请求计价：本路由不声明 → undefined（消费者回落到自己的中性估算）。
     *
     * ⚠️ 这个方法**必须有**，不是可选装饰：dsh-llm 的适配器注册表在计量/压缩路径上**无条件**转调
     * `adapter.imageRequestPricing(provider, model)`（见 app.asar 内 LlmAdapterRegistry.imageRequestPricing）。
     * 而本适配器是鸭子类型的**普通对象**、不继承 `LlmAdapter` 基类，基类里那个「默认返回 undefined」的实现
     * 我们拿不到 → 缺了它就抛 `... .imageRequestPricing is not a function`，
     * 于是 basic-compaction-engine 每一步压缩都失败（实测 2026-09-10：69 次，压缩**静默失效**，
     * 长会话不再自动压缩，且只留一条 warn）。
     *
     * 契约：必须**同步、无 I/O**（token meter 每次测量都会调）。
     */
    imageRequestPricing(_provider, _model) {
      return void 0;
    },
    listModels(provider) {
      return Promise.resolve(MODEL_SPECS.map((spec) => modelInfoFor(provider, spec)));
    },
    resolveModel(provider, model) {
      return Promise.resolve(
        resolvedModelInfo(provider, resolveSpec(model), String(model ?? ""), deps.config.contextWindow)
      );
    },
    /**
     * 运行时契约（dsh-llm 0.1.2-rc.1）：dispatch 前先取「精确模型元数据 + 该次调用的 stream」。
     * 返回的 stream 接收运行时补齐后的 options。
     */
    prepareCall(provider, model, _signal) {
      const spec = resolveSpec(model);
      return Promise.resolve({
        model: resolvedModelInfo(provider, spec, String(model ?? ""), deps.config.contextWindow),
        stream: (options) => gatedStream(options)
      });
    },
    stream(options) {
      return gatedStream(options);
    }
  };
  const uploadCache = new ImageUploadCache();
  let lastImageKeys = /* @__PURE__ */ new Set();
  let lastTrimNotice;
  async function uploadRequestImages(auth, messages, signal) {
    signal?.throwIfAborted();
    uploadCache.useScope(auth.token);
    const scope = uploadCache.currentScope();
    const refs = collectImageRefs(messages);
    if (refs.length === 0) return { ids: [], keys: [], keptKeys: /* @__PURE__ */ new Set() };
    const seen = /* @__PURE__ */ new Set();
    const unique = [];
    for (const ref of refs) {
      const key = String(ref?.attachmentId ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(ref);
    }
    if (unique.length === 0) return { ids: [], keys: [], keptKeys: /* @__PURE__ */ new Set() };
    if (!deps.readImage) {
      logger?.warn?.("deepseek-web: \u6536\u5230\u56FE\u7247\u4F46\u9644\u4EF6\u670D\u52A1\u4E0D\u53EF\u7528\uFF08ctx.attachments\uFF09\uFF0C\u56FE\u7247\u88AB\u5FFD\u7565");
      return {
        ids: [],
        keys: [],
        keptKeys: /* @__PURE__ */ new Set(),
        notice: imageNotice(unique.length, "\u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B\u9644\u4EF6\u8BFB\u53D6\u80FD\u529B\uFF08ctx.attachments\uFF09")
      };
    }
    const maxRefImages = deps.config.maxRefImages ?? DEFAULT_MAX_REF_IMAGES;
    const overLimit = maxRefImages > 0 && unique.length > maxRefImages;
    const kept = overLimit ? unique.slice(-maxRefImages) : unique;
    const dropped = unique.length - kept.length;
    const trimNotice = overLimit && dropped >= nextTrimNoticeThreshold(lastTrimNotice, kept.length) ? imageTrimNotice(unique.length, dropped, kept.length) : void 0;
    if (trimNotice) lastTrimNotice = { kept: kept.length, dropped };
    if (overLimit) {
      logger?.info?.(
        `deepseek-web: \u672C\u8BF7\u6C42\u7684\u56FE\u7247\u5171 ${unique.length} \u5F20\uFF0C\u8D85\u8FC7\u4E0A\u9650 ${maxRefImages} \u21D2 \u53EA\u53D1\u6700\u8FD1\u7684 ${kept.length} \u5F20\uFF08\u8F83\u65E9\u7684 ${unique.length - kept.length} \u5F20\u672C\u8F6E\u7565\u8FC7\uFF09`
      );
    }
    uploadCache.prune();
    const ids = [];
    const failures = [];
    let attempted = 0;
    let skippedByAuth = 0;
    const sentKeys = /* @__PURE__ */ new Set();
    const sentKeyList = [];
    for (const ref of kept) {
      signal?.throwIfAborted();
      const key = String(ref?.attachmentId ?? "");
      const cached2 = uploadCache.get(key, Date.now(), scope);
      if (cached2) {
        ids.push(cached2);
        sentKeys.add(key);
        sentKeyList.push(key);
        continue;
      }
      attempted += 1;
      try {
        const stored = await deps.readImage(ref, signal);
        const mediaType = stored.mediaType || String(ref.mediaType ?? "image/png");
        const uploadedFile = await uploadImage(
          auth,
          {
            data: stored.data,
            mediaType,
            // 名字必须声明一个服务端支持的图片类型：宿主给 tool/result 内嵌图片的
            // `name` 是**纯 sha256（无后缀）**，实测会被以 code 9 拒（见 imageUploadName）。
            name: imageUploadName(stored.name ?? ref.name, mediaType)
          },
          signal
        );
        uploadCache.set(key, uploadedFile.fileId, Date.now(), scope);
        ids.push(uploadedFile.fileId);
        sentKeys.add(key);
        sentKeyList.push(key);
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = String(error?.message ?? error);
        failures.push(message);
        logger?.warn?.(`deepseek-web: \u56FE\u7247\u4E0A\u4F20\u5931\u8D25\uFF08\u5DF2\u964D\u7EA7\u4E3A\u7EAF\u6587\u672C\uFF09\uFF1A${message}`);
        if (error?.code === "AUTH") {
          skippedByAuth = kept.length - attempted;
          logger?.warn?.(`deepseek-web: \u56FE\u7247\u4E0A\u4F20\u906D\u9047\u6388\u6743\u5931\u8D25\uFF0C\u5269\u4F59 ${skippedByAuth} \u5F20\u4E0D\u518D\u5C1D\u8BD5`);
          break;
        }
      }
    }
    const notices = [];
    if (trimNotice) notices.push(trimNotice);
    if (failures.length > 0) notices.push(imageNotice(failures.length, failures[0], skippedByAuth));
    return { ids, keys: sentKeyList, keptKeys: sentKeys, ...notices.length > 0 ? { notice: notices.join("") } : {} };
  }
  function imageNotice(count, reason, skipped = 0) {
    const brief = reason.length > 120 ? `${reason.slice(0, 120)}\u2026` : reason;
    const tail = skipped > 0 ? `\uFF1B\u7B2C\u4E00\u5F20\u88AB\u62D2\u540E\u5373\u4E2D\u6B62\uFF0C\u5269\u4F59 ${skipped} \u5F20\u672A\u518D\u5C1D\u8BD5\uFF08\u6388\u6743\u5931\u6548\u662F\u5168\u5C40\u7684\uFF0C\u7EE7\u7EED\u91CD\u8BD5\u53EA\u662F\u767D\u8DD1\u8BF7\u6C42\uFF09` : "";
    return `
\u26A0\uFE0F [deepseek-web] \u6709 ${count} \u5F20\u56FE\u7247\u6CA1\u80FD\u4F20\u7ED9\u6A21\u578B\uFF08${brief}\uFF09${tail}\uFF0C\u672C\u8F6E\u56DE\u7B54\u53EA\u57FA\u4E8E\u6587\u5B57\u5185\u5BB9\u3002
`;
  }
  function imageTrimNotice(total, dropped, kept) {
    return `
[deepseek-web] \u672C\u8F6E\u53EA\u5E26\u4E86\u6700\u8FD1 ${kept} \u4EFD\u56FE\u7247\u5185\u5BB9\uFF0C\u66F4\u65E9\u7684 ${dropped} \u4EFD\u672A\u968F\u8BF7\u6C42\u53D1\u9001\uFF08\u5386\u53F2\u7D2F\u8BA1 ${total} \u4EFD\uFF09\u3002\u8FD9\u91CC\u7684\u300C\u4EFD\u300D\u662F**\u56FE\u7247\u5185\u5BB9\u6761\u76EE**\u3001\u4E0D\u662F\u4F60\u8D34\u7684\u5F20\u6570 \u2014\u2014\u6A21\u578B\u6BCF\u8BFB\u4E00\u6B21\u56FE\u5C31\u4F1A\u591A\u7B97\u4E00\u6761\uFF0C\u6240\u4EE5\u5B83\u8FDC\u591A\u4E8E\u4F60\u4EB2\u624B\u8D34\u7684\u5F20\u6570\u3002\u7F51\u9875\u7AEF\u5BF9\u5355\u6B21\u8BF7\u6C42\u80FD\u5F15\u7528\u7684\u56FE\u7247\u6570\u6709\u4E0A\u9650\uFF0C\u8D85\u4E86\u6574\u8F6E\u90FD\u4F1A\u88AB\u62D2\uFF0C\u56E0\u6B64\u6309\u65F6\u95F4\u7559\u6700\u8FD1\u7684\u8FD9\u4E9B\u3002\u6B63\u5E38\u7684\u5185\u5BB9\u63A7\u5236\uFF0C\u4E0D\u662F\u9519\u8BEF\u3002
`;
  }
  async function* streamWithImageFallback(options) {
    let attempt = 0;
    let current = options;
    while (true) {
      let yielded = false;
      const inner = streamImpl(current);
      try {
        while (true) {
          const step = await inner.next();
          if (step.done === true) return;
          yielded = true;
          yield step.value;
        }
      } catch (error) {
        if (!canRetryImageReject(error, yielded, attempt)) throw error;
        attempt += 1;
        current = attempt === 1 ? { ...options, __retryImages: true } : { ...options, __skipImages: true };
        logger?.warn?.(
          attempt === 1 ? "deepseek-web: \u56FE\u7247\u5F15\u7528\u88AB\u670D\u52A1\u7AEF\u62D2\u7EDD\uFF08code 9\uFF09\u2014\u2014 \u4E22\u6389\u90A3\u51E0\u5F20\u7684\u4E0A\u4F20\u7F13\u5B58\uFF0C\u91CD\u65B0\u4E0A\u4F20\u540E\u91CD\u8BD5\u4E00\u6B21" : "deepseek-web: \u91CD\u65B0\u4E0A\u4F20\u540E\u56FE\u7247\u5F15\u7528\u4ECD\u88AB\u62D2\uFF08code 9\uFF09\u2014\u2014 \u672C\u8F6E\u6539\u4E3A\u4E0D\u5E26\u56FE\u7247\u91CD\u53D1"
        );
      }
    }
  }
  async function* gatedStream(options) {
    const purpose = typeof options?.purpose === "string" && options.purpose ? options.purpose : "chat";
    try {
      await deps.maybeAutoSwitch?.();
    } catch {
    }
    const release = await gate.acquire(purpose, options?.signal);
    const startedAt2 = Date.now();
    const accountIdAtStart = deps.currentAccountId?.();
    let reported = false;
    let capturedTokens;
    const report = (info) => {
      if (reported) return;
      reported = true;
      try {
        deps.noteCall?.({
          purpose,
          ms: Date.now() - startedAt2,
          accountId: accountIdAtStart,
          ...typeof options?.model === "string" && options.model ? { model: options.model } : {},
          ...capturedTokens ? { tokens: capturedTokens } : {},
          ...info
        });
      } catch {
      }
    };
    try {
      for await (const event of streamWithImageFallback(options)) {
        if (event?.type === "usage" && event.usage) {
          const input = Number(event.usage.inputTokens);
          const output = Number(event.usage.outputTokens);
          if (Number.isFinite(input) && Number.isFinite(output)) {
            capturedTokens = {
              inputTokens: input,
              outputTokens: output,
              serverTotal: event.usage.serverTotal === true,
              ...Number.isFinite(event.usage.reasoningTokens) ? { reasoningTokens: Number(event.usage.reasoningTokens) } : {}
            };
          }
        }
        yield event;
      }
      report({ ok: true });
    } catch (error) {
      report({
        ok: false,
        ...typeof error?.code === "string" ? { code: error.code } : {},
        ...typeof error?.message === "string" ? { message: error.message.slice(0, 300) } : {},
        ...Number.isFinite(error?.mutedUntilMs) ? { mutedUntilMs: error.mutedUntilMs } : {},
        ...error?.failure?.rateLimitKind === "throttled" || error?.rateLimitKind === "throttled" ? { throttled: true } : {}
      });
      throw error;
    } finally {
      release();
    }
  }
  async function* streamImpl(options) {
    const auth = deps.getAuth();
    if (!hasUsableAuth(auth)) {
      throw new AdapterLlmError(
        "\u5C1A\u672A\u767B\u5F55 DeepSeek \u7F51\u9875\u7248\uFF1A\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 DeepSeek \u7F51\u9875\u767B\u5F55\u300D\u91CC\u7528\u6D4F\u89C8\u5668\u7A97\u53E3\u767B\u5F55\uFF0C\u6216\u624B\u52A8\u7C98\u8D34 userToken\u3002",
        "MISSING_CREDENTIAL"
      );
    }
    const stale = staleAuthMessage(auth);
    if (stale) {
      const canSwap = deps.canFailover?.("auth") === true;
      logger?.warn?.(
        `deepseek-web: \u8DF3\u8FC7\u8BF7\u6C42 \u2014\u2014 \u8BE5\u8D26\u53F7\u767B\u5F55\u6001\u5DF2\u88AB\u5224\u5B9A\u5931\u6548\uFF08${stale}\uFF09` + (canSwap ? "\uFF1B\u5C06\u81EA\u52A8\u6362\u5230\u53E6\u4E00\u4E2A\u53EF\u7528\u8D26\u53F7\u91CD\u8BD5" : "\uFF1B\u6CA1\u6709\u53EF\u6362\u7684\u8D26\u53F7\uFF0C\u9700\u624B\u52A8\u5207\u6362\u6216\u91CD\u65B0\u767B\u5F55")
      );
      throw new AdapterLlmError(
        canSwap ? `\u8FD9\u4E2A\u8D26\u53F7\u7684\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF08${stale}\uFF09\uFF0C\u672C\u6B21\u8BF7\u6C42\u6CA1\u6709\u53D1\u51FA \u2014\u2014 \u6B63\u5728\u81EA\u52A8\u6362\u5230\u53E6\u4E00\u4E2A\u53EF\u7528\u8D26\u53F7\u91CD\u8BD5\u2026\u2026` : `\u8FD9\u4E2A\u8D26\u53F7\u7684\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF08${stale}\uFF09\uFF0C\u672C\u6B21\u8BF7\u6C42\u6CA1\u6709\u53D1\u51FA\u3002\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 DeepSeek \u7F51\u9875\u767B\u5F55\u300D\u7528\u6D4F\u89C8\u5668\u7A97\u53E3\u91CD\u65B0\u767B\u5F55\u8BE5\u8D26\u53F7\uFF0C\u6216\u70B9\u8BE5\u8D26\u53F7\u884C\u4E0A\u7684\u300C\u5207\u6362\u300D\u6362\u4E00\u4E2A\u80FD\u7528\u7684\u53F7\uFF1B\u82E5\u786E\u8BA4\u5B83\u5176\u5B9E\u8FD8\u80FD\u7528\uFF0C\u70B9\u300C\u6821\u9A8C\u5168\u90E8\u300D\u91CD\u65B0\u786E\u8BA4\u4E00\u6B21\u5373\u53EF\uFF08\u53EA\u8BFB\u63A2\u6D3B\uFF0C\u4E0D\u6D88\u8017\u989D\u5EA6\uFF09\u3002`,
        "AUTH",
        { providerRetryAfterMs: canSwap ? AUTH_FAILOVER_RETRY_MS : AUTH_GIVEUP_RETRY_MS }
      );
    }
    const spec = resolveSpec(String(options?.model ?? ""));
    const { thinkingEnabled } = resolveThinking(options, spec);
    if (options?.__retryImages === true && lastImageKeys.size > 0) {
      const removed = uploadCache.invalidate(lastImageKeys);
      lastImageKeys = /* @__PURE__ */ new Set();
      logger?.warn?.(`deepseek-web: \u5DF2\u4E22\u5F03 ${removed} \u6761\u4E0A\u4F20\u7F13\u5B58\uFF08\u5B83\u4EEC\u5BF9\u5E94\u7684 file_id \u88AB\u670D\u52A1\u7AEF\u62D2\u7EDD\u8FC7\uFF09`);
    }
    const uploaded = options?.__skipImages === true ? { ids: [], keys: void 0, keptKeys: void 0, notice: void 0 } : await uploadRequestImages(auth, options?.messages, options?.signal);
    if (uploaded.keptKeys) lastImageKeys = uploaded.keptKeys;
    const refFileIds = uploaded.ids;
    let promptParts = serializePromptParts({
      system: options?.system,
      messages: options?.messages ?? [],
      tools: options?.tools ?? [],
      maxChars: deps.config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
      // 「一次一个工具」开关：只换协议指令那一段，其余 prompt 结构不变（**缺省＝串行**）。
      serialToolCalls: deps.config.serialToolCalls !== false,
      // 只对**首轮**传：它才是真正带 ref_file_ids 的那一次（续写轮 refFileIds 传空）。
      // 传了之后，被长度控制略过的图会写成 `[earlier image omitted]` 而不是 `[image attached]`
      // —— 标记与实发必须一致，否则模型会对着没送出去的图瞎猜。
      keptImageKeys: uploaded.keptKeys
    });
    const prompt = promptParts.full;
    const knownNames = new Set((options?.tools ?? []).map((tool) => String(tool?.name ?? "")));
    let filter = new ToolCallStreamFilter(knownNames);
    let reasoningSanitizer = new ReasoningSanitizer();
    let echoGuard = new TranscriptEchoGuard();
    let systemMarkerFilter = new SystemMarkerStreamFilter();
    let boilerplate = new BoilerplateFilter();
    let nextIndex = 0;
    let textBlock = null;
    let textStarted = false;
    let reasoningBlock = null;
    let reasoningStarted = false;
    let toolCallCount = 0;
    let finishReason;
    const usageRounds = [];
    let rejectedProtocol = "";
    let rejectedReason;
    let callShape;
    let echoedTranscript = false;
    let echoNoticeChars = 0;
    let systemMarkersStripped = false;
    let disclaimerStripped = false;
    const openText = () => {
      if (!textBlock) textBlock = { index: nextIndex++, text: "" };
      return textBlock;
    };
    const openReasoning = () => {
      if (!reasoningBlock) reasoningBlock = { index: nextIndex++, text: "" };
      return reasoningBlock;
    };
    const emitCalls = function* (calls, fenced) {
      if (calls.length > 0) callShape = fenced ? "fenced" : "bare";
      for (const call of calls) {
        const index = nextIndex++;
        toolCallCount += 1;
        yield { type: "block-start", index, blockType: "tool-call" };
        yield { type: "tool-call-delta", index, id: call.id, name: call.name, argumentsDelta: call.arguments };
        yield {
          type: "block-end",
          index,
          block: { type: "tool-call", id: call.id, name: call.name, arguments: call.arguments }
        };
      }
    };
    try {
      if (uploaded.notice) {
        const noticeBlock = openText();
        textStarted = true;
        yield { type: "block-start", index: noticeBlock.index, blockType: "text" };
        noticeBlock.text += uploaded.notice;
        yield { type: "text-delta", index: noticeBlock.index, text: uploaded.notice };
      }
      let rounds = 0;
      let toolCallRetried = false;
      let currentPrompt = prompt;
      let textLenAtRoundStart = 0;
      let roundStartedAt = Date.now();
      for (; ; ) {
        let roundError;
        const roundUsage = { prompt: currentPrompt, outputChars: 0 };
        usageRounds.push(roundUsage);
        finishReason = void 0;
        textLenAtRoundStart = textBlock?.text?.length ?? 0;
        roundStartedAt = Date.now();
        const chatLike = allowsAutoContinue(options?.purpose);
        try {
          for await (const event of runStream(auth, {
            prompt: currentPrompt,
            // 当前账号被限时，由宿主回答"换个号还能不能接着干"。
            // 能 ⇒ webapi 给短退避（而不是解除时间）⇒ 重试策略立刻重发 ⇒
            // 重发时 maybeAutoSwitch 换上可用账号 ⇒ 整轮任务不用人插手就能接下去。
            canFailover: deps.canFailover,
            // 链式投喂用：把结构与 prompt 一起传下去，webapi 才能算出"这一轮新增了哪几条"。
            // 漏传 = 链式模式静默退化成全量（有产物断言守着）。
            // ⚠️ 只有用户可见的 chat 才走链：内部用途（session-title / compaction 等）
            // 也共享同一个 DSH sessionId，传 promptParts 会让它们的条目去撞 chat 的链，
            // 结果每条标题/压缩请求都触发「历史不是严格追加 → 重开链 → 强制换新会话」，
            // 把当前窗口的网页端会话活活冲掉（用户看到"其他窗口/上一句的会话又没了"）。
            ...chatLike ? {
              promptParts: {
                head: promptParts.head,
                entries: promptParts.entries,
                // 重发（replay）时用来省掉固定头 —— 它在会话首条消息里已经给过了。
                // 不传 ⇒ 退回旧行为（整份重发），所以漏传只是"少省一点"，不会错。
                transcript: promptParts.transcript,
                maxChars: deps.config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS
              }
            } : {},
            // 链式投喂的决策回执（0.1.63）→ 一行日志。webapi 只在「原因变化」时回调，
            // 所以不会每轮刷屏，但"哪一轮开始不再发增量、为什么"一定看得见。
            onContextFeed: (report) => {
              logger?.info?.(
                report.reason === "chained" ? `deepseek-web: \u4E0A\u4E0B\u6587\u6295\u5582=\u94FE\u5F0F\uFF1A\u672C\u8F6E\u53EA\u53D1\u589E\u91CF ${report.promptChars} \u5B57\uFF08\u5386\u53F2\u7531\u670D\u52A1\u7AEF\u7EF4\u62A4${report.echoDropped > 0 ? `\uFF0C\u53E6\u7565\u8FC7 ${report.echoDropped} \u6761\u6A21\u578B\u56DE\u58F0` : ""}\uFF09` : report.reason === "mode-full" ? "deepseek-web: \u4E0A\u4E0B\u6587\u6295\u5582=\u6BCF\u8F6E\u5168\u91CF\uFF1A\u91CD\u53D1\u5B8C\u6574 prompt" : `deepseek-web: \u94FE\u5F0F\u6295\u5582\u9000\u56DE\u5168\u91CF\u91CD\u53D1\uFF08\u539F\u56E0=${report.reason}\uFF09`
              );
            },
            thinkingEnabled,
            modelType: spec.modelType,
            refFileIds: rounds === 0 ? refFileIds : [],
            refKeys: rounds === 0 ? uploaded.keys : [],
            signal: options?.signal,
            idleTimeoutMs: deps.config.idleTimeoutMs ?? 12e4,
            // 会话复用：同一账号连续多个回合共用一个网页端会话（见 webapi.ts 的实测判定）
            ...deps.config.sessionReuseTurns !== void 0 ? { sessionReuseTurns: deps.config.sessionReuseTurns } : {},
            // 🔴 宿主给的 DSH 会话身份（`GenerateOptions.sessionId`，宿主内核类型定义原话是
            // "Session identity stamped by the loop for listener routing"，适配器本该忽略）。
            // 我们借它把"网页端会话 + 投喂链"**按窗口分开** —— 不然换窗口的请求会落进上一个
            // 窗口的会话里（用户报"换窗口就把上下文清一次、网页端还长出 n/n 分支"）。
            ...typeof options?.sessionId === "string" && options.sessionId ? { dshSessionId: String(options.sessionId) } : {},
            onDeleteSession: deps.config.deleteWebSessions === false ? void 0 : (sessionId) => {
              if (deps.sessionCleaner) deps.sessionCleaner.schedule(auth, sessionId);
              else scheduleDeleteSession(auth, sessionId);
            },
            // 🔴 内部请求（不带 promptParts 的 session-title / 压缩）的会话是**脚手架**：
            // `sessionCleanup: keep` 与 `manualOnly` 都拦不住它 —— 那两道只管用户的对话。
            // 不丢它 ⇒ 网页端会凭空多出一个会话（2026-10-02 用户报「就发了一句话、网页版俩窗口」）。
            // ⚠️ 仍然受 `deleteWebSessions === false` 约束：那个开关的语义是"一个都不许删"。
            onDiscardSession: deps.config.deleteWebSessions === false ? void 0 : (sessionId) => {
              if (deps.sessionCleaner) void deps.sessionCleaner.discard(auth, sessionId);
              else discardSession(auth, sessionId);
            }
          })) {
            if (event.kind === "thinking" || event.kind === "text") roundUsage.outputChars += event.text.length;
            if (event.kind === "thinking") {
              const clean = reasoningSanitizer.push(event.text);
              if (!clean) continue;
              const block = openReasoning();
              if (!reasoningStarted) {
                reasoningStarted = true;
                yield { type: "block-start", index: block.index, blockType: "reasoning" };
              }
              block.text += clean;
              yield { type: "reasoning-delta", index: block.index, text: clean };
              continue;
            }
            if (event.kind === "text") {
              const out = filter.push(event.text);
              const boiled = boilerplate.push(out.text);
              const guarded = echoGuard.push(boiled.text);
              if (guarded.echoed) echoedTranscript = true;
              const cleaned = systemMarkerFilter.push(guarded.text);
              if (cleaned.stripped) {
                systemMarkersStripped = true;
                logger?.debug?.("deepseek-web: \u5DF2\u5265\u79BB\u4F2A\u7CFB\u7EDF\u6807\u8BB0\uFF08<ds_system>/<system>\uFF09");
              }
              if (cleaned.text) {
                const block = openText();
                if (!textStarted) {
                  textStarted = true;
                  yield { type: "block-start", index: block.index, blockType: "text" };
                }
                block.text += cleaned.text;
                yield { type: "text-delta", index: block.index, text: cleaned.text };
              }
              if (out.calls.length > 0) yield* emitCalls(out.calls, out.fenced);
              continue;
            }
            if (event.kind === "status") {
              logger?.debug?.(`deepseek-web: status=${event.value}`);
              continue;
            }
            if (event.kind === "error") {
              if (isContextTooLong(event.message)) {
                throw new AdapterLlmError(`DeepSeek \u7F51\u9875\u7AEF\u4E0A\u4E0B\u6587\u8D85\u9650\uFF1A${event.message}`, "CONTEXT_WINDOW_EXCEEDED");
              }
              if (event.code === "RATE_LIMIT") {
                const throttled = event.rateLimitKind === "throttled";
                throw new AdapterLlmError(
                  throttled ? "\u7F51\u9875\u7248\u9650\u6D41\uFF1A\u53D1\u5F97\u592A\u9891\u7E41\uFF0C\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5" : "\u7F51\u9875\u7248\u9650\u6D41\uFF1A\u540C\u4E00\u8D26\u53F7\u540C\u65F6\u53EA\u80FD\u751F\u6210\u4E00\u6761\u6D88\u606F\uFF0C\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5",
                  "RATE_LIMIT",
                  {
                    ...event.retryAfterMs !== void 0 ? { providerRetryAfterMs: event.retryAfterMs } : {},
                    ...throttled ? { rateLimitKind: "throttled" } : {}
                  }
                );
              }
              throw new AdapterLlmError(`DeepSeek \u7F51\u9875\u7AEF\u8FD4\u56DE\u9519\u8BEF\uFF1A${event.message}`, "PROVIDER_ERROR");
            }
            if (event.kind === "finish") {
              finishReason = event.reason;
              if (typeof event.totalTokens === "number" && Number.isSafeInteger(event.totalTokens) && event.totalTokens >= 0) {
                roundUsage.total = event.totalTokens;
              }
            }
          }
        } catch (error) {
          if (rounds > 0) {
            if (options?.signal?.aborted) throw new AdapterLlmError("deepseek-web \u8BF7\u6C42\u88AB\u8C03\u7528\u65B9\u53D6\u6D88", "ABORTED", { cause: error });
            roundError = error instanceof AdapterLlmError ? error : new AdapterLlmError(`deepseek-web \u81EA\u52A8\u7EED\u5199\u5931\u8D25\uFF1A${error?.message ?? error}`, "TRANSPORT", { cause: error });
            logger?.warn?.(`deepseek-web: \u81EA\u52A8\u7EED\u5199\u7B2C ${rounds} \u8F6E\u5931\u8D25\uFF0C\u4FDD\u7559\u5DF2\u8F93\u51FA\u90E8\u5206\uFF1A${roundError.message}`);
          } else {
            throw error;
          }
        }
        const reasoningTail = reasoningSanitizer.flush();
        if (reasoningTail) {
          const block = openReasoning();
          if (!reasoningStarted) {
            reasoningStarted = true;
            yield { type: "block-start", index: block.index, blockType: "reasoning" };
          }
          block.text += reasoningTail;
          yield { type: "reasoning-delta", index: block.index, text: reasoningTail };
        }
        const drained = drainTextPipeline(filter, boilerplate, echoGuard, false);
        if (drained.echoed) echoedTranscript = true;
        if (drained.disclaimers > 0) disclaimerStripped = true;
        const markerPending = systemMarkerFilter.push(drained.text);
        const markerEnd = systemMarkerFilter.flush();
        const tailText = markerPending.text + markerEnd.text;
        if (markerPending.stripped || markerEnd.stripped) systemMarkersStripped = true;
        if (tailText) {
          const block = openText();
          if (!textStarted) {
            textStarted = true;
            yield { type: "block-start", index: block.index, blockType: "text" };
          }
          block.text += tailText;
          yield { type: "text-delta", index: block.index, text: tailText };
        }
        if (drained.calls.length > 0) yield* emitCalls(drained.calls, drained.fenced);
        if (drained.rejected) {
          dumpRejectedPayload(drained.rejected.raw, drained.rejected.mode, drained.rejected.reason ?? "unparsable", logger);
          logger?.warn?.(
            `deepseek-web: \u5DE5\u5177\u8C03\u7528${drained.rejected.mode === "xml" ? "\uFF08XML\uFF09" : ""}\u89E3\u6790\u5931\u8D25[${drained.rejected.reason ?? "unparsable"}]\uFF0C\u5DF2\u4E22\u5F03 ${drained.rejected.raw.length} \u5B57\u7B26\uFF08\u539F\u6587\u4E0D\u843D\u76D8\uFF1B\u4EE5\u4E0B\u7247\u6BB5\u4EC5\u5199\u5165\u5BBF\u4E3B\u65E5\u5FD7\uFF09\uFF1A` + drained.rejected.raw.slice(0, 2e3)
          );
          if (rounds === 0) {
            rejectedProtocol = drained.rejected.raw;
            rejectedReason = drained.rejected.reason ?? "unparsable";
          } else {
            const notice = `
[deepseek-web] \u672C\u6B21\u8F93\u51FA\u7684\u4E00\u4E2A\u5DE5\u5177\u8C03\u7528\u56E0\u683C\u5F0F\u65E0\u6CD5\u89E3\u6790\uFF08${drained.rejected.reason ?? "unparsable"}\uFF09\u88AB\u4E22\u5F03\uFF0C\u8BE5\u8C03\u7528\u672A\u6267\u884C\uFF1B\u8BF7\u6539\u7528\u7EA6\u5B9A\u7684 JSON \u683C\u5F0F\u91CD\u53D1\u3002
`;
            const noticeBlock = openText();
            if (!textStarted) {
              textStarted = true;
              yield { type: "block-start", index: noticeBlock.index, blockType: "text" };
            }
            noticeBlock.text += notice;
            yield { type: "text-delta", index: noticeBlock.index, text: notice };
          }
        }
        const partial = textBlock?.text ?? "";
        const roundChars = partial.length - textLenAtRoundStart;
        const maxRounds = deps.config.maxContinuations ?? 2;
        const cutByServer = finishReason === void 0;
        const midSentence = looksMidSentence(partial);
        logger?.info?.(
          `deepseek-web: \u7B2C ${rounds + 1} \u8F6E\u6D41\u7ED3\u675F\uFF1A[\u672C\u8F6E ${roundChars} \u5B57 / \u7D2F\u8BA1 ${partial.length} \u5B57 / \u8017\u65F6 ${Date.now() - roundStartedAt}ms] finish=${finishReason ?? "(\u65E0 FINISHED \u2192 \u670D\u52A1\u7AEF\u622A\u65AD)"}${midSentence ? "\uFF0C\u5C3E\u90E8\u662F\u53E5\u4E2D" : ""}${roundChars === 0 && rounds === 0 ? toolCallCount > 0 ? "\uFF08\u672C\u8F6E\u6B63\u6587 0 \u5B57\uFF0C\u4F46\u5DF2\u63D0\u53D6\u5230\u5DE5\u5177\u8C03\u7528 \u2014\u2014 \u6B63\u5E38\u5F62\u6001\uFF09" : "\uFF08\u672C\u8F6E\u6B63\u6587 0 \u5B57\u3001\u4E14\u65E0\u5DE5\u5177\u8C03\u7528 \u2014\u2014 \u5185\u5BB9\u53EF\u80FD\u5168\u5728\u601D\u8003\u901A\u9053\uFF09" : ""}`
        );
        const eligible = (
          // F26：只对用户可见的回答续写（见 allowsAutoContinue 的说明）。
          // 少了这一条，标题生成会被无尽续写、标题变成重复垃圾。
          allowsAutoContinue(options?.purpose) && roundError === void 0 && deps.config.autoContinue !== false && rounds < maxRounds && toolCallCount === 0 && !options?.signal?.aborted && partial.length > 0 && roundChars > 0 && (midSentence || cutByServer)
        );
        const unexecutedProgram = !eligible && allowsAutoContinue(options?.purpose) && roundError === void 0 && deps.config.autoContinue !== false && rounds < maxRounds && toolCallCount === 0 && !toolCallRetried && !options?.signal?.aborted && partial.length > 0 && looksLikeUnexecutedToolProgram(partial);
        if (!eligible && !unexecutedProgram) break;
        rounds += 1;
        if (unexecutedProgram) toolCallRetried = true;
        logger?.info?.(
          unexecutedProgram ? `deepseek-web: \u672C\u8F6E\u628A\u5DE5\u5177\u7A0B\u5E8F\u5199\u8FDB\u4E86\u6B63\u6587\uFF08\u96F6\u5DE5\u5177\u8C03\u7528\uFF09\uFF0C\u5DF2\u8981\u6C42\u5B83\u6539\u53D1\u5DE5\u5177\u8C03\u7528\uFF08\u7B2C ${rounds}/${maxRounds} \u8F6E\uFF09\u2026\u2026` : `deepseek-web: \u56DE\u7B54\u7591\u4F3C\u5728\u53E5\u4E2D\u88AB\u622A\uFF0C\u81EA\u52A8\u7EED\u5199\uFF08\u7B2C ${rounds}/${maxRounds} \u8F6E\uFF09\u2026\u2026`
        );
        promptParts = serializePromptParts({
          system: options?.system,
          messages: [
            ...options?.messages ?? [],
            { role: "assistant", content: [{ type: "text", text: partial }] },
            {
              role: "user",
              content: [{ type: "text", text: unexecutedProgram ? TOOL_CALL_RETRY_INSTRUCTION : CONTINUE_INSTRUCTION }]
            }
          ],
          tools: options?.tools ?? [],
          maxChars: deps.config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
          // 续写轮用**同一份**设置 —— 否则同一会话里首轮串行、续写退回批量，指令来回变。
          serialToolCalls: deps.config.serialToolCalls !== false
        });
        currentPrompt = promptParts.full;
        filter = new ToolCallStreamFilter(knownNames);
        reasoningSanitizer = new ReasoningSanitizer();
        echoGuard = new TranscriptEchoGuard();
        systemMarkerFilter = new SystemMarkerStreamFilter();
        boilerplate = new BoilerplateFilter();
      }
    } catch (error) {
      if (error instanceof AdapterLlmError) throw error;
      if (options?.signal?.aborted) throw new AdapterLlmError("deepseek-web \u8BF7\u6C42\u88AB\u8C03\u7528\u65B9\u53D6\u6D88", "ABORTED", { cause: error });
      throw new AdapterLlmError(`deepseek-web \u6D41\u5931\u8D25\uFF1A${error?.message ?? error}`, "TRANSPORT", { cause: error });
    }
    if (echoedTranscript && toolCallCount === 0 && textBlock && textBlock.text.length > 0) {
      const echoNotice = "\n\n[deepseek-web] \u672C\u8F6E\u6709\u4E00\u90E8\u5206\u300C\u5386\u53F2\u56DE\u653E\u683C\u5F0F\u300D\u7684\u5185\u5BB9\u88AB\u8FC7\u6EE4\uFF08\u672A\u4E0A\u5C4F\uFF09\uFF0C\u56DE\u7B54\u53EF\u80FD\u56E0\u6B64\u4E0D\u5B8C\u6574\u3002\n";
      textBlock.text += echoNotice;
      echoNoticeChars = echoNotice.length;
      yield { type: "text-delta", index: textBlock.index, text: echoNotice };
    }
    if (reasoningBlock) {
      yield { type: "block-end", index: reasoningBlock.index, block: { type: "reasoning", text: reasoningBlock.text } };
    }
    if (textBlock) {
      yield { type: "block-end", index: textBlock.index, block: { type: "text", text: textBlock.text } };
    }
    const outputChars = (textBlock?.text?.length ?? 0) + (reasoningBlock?.text?.length ?? 0) - echoNoticeChars;
    let inputTokens = 0, outputTokens = 0;
    let serverTotal = usageRounds.length > 0;
    for (const round of usageRounds) {
      const estimateOutput = Math.ceil(round.outputChars / 3.2);
      if (round.total !== void 0) {
        const output = Math.min(round.total, estimateOutput);
        outputTokens += output;
        inputTokens += round.total - output;
      } else {
        serverTotal = false;
        outputTokens += estimateOutput;
        inputTokens += estimateTokens(round.prompt);
      }
    }
    yield { type: "usage", usage: {
      inputTokens,
      outputTokens,
      serverTotal,
      ...reasoningBlock ? { reasoningTokens: Math.min(outputTokens, estimateTokens(reasoningBlock.text)) } : {}
    } };
    if (toolCallCount > 0) {
      noteCallShape(callShape ?? "none", logger);
      yield { type: "finish", reason: { kind: "tool-calls" }, callShape };
      return;
    }
    const hasVisibleText = (textBlock?.text?.length ?? 0) > 0;
    if (echoedTranscript) {
      logger?.warn?.("deepseek-web: \u6A21\u578B\u56DE\u58F0\u4E86\u300C\u5BF9\u8BDD\u8F6C\u5199\u683C\u5F0F\u300D\uFF08[Tool Result for \u2026] / User: / Assistant: \u7B49\uFF09\uFF0C\u8BE5\u6BB5\u5DF2\u4E22\u5F03\u3001\u4E0D\u4E0A\u5C4F");
    }
    if (disclaimerStripped) {
      logger?.info?.("deepseek-web: \u5DF2\u5265\u79BB\u7F51\u9875\u7AEF\u514D\u8D23\u58F0\u660E\uFF08\u672C\u56DE\u7B54\u7531 AI \u751F\u6210\uFF0C\u5185\u5BB9\u4EC5\u4F9B\u53C2\u8003\uFF0C\u8BF7\u4ED4\u7EC6\u7504\u522B\uFF09");
    }
    if (echoedTranscript && !hasVisibleText && toolCallCount === 0) {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            message: "DeepSeek \u7F51\u9875\u7AEF\u628A\u300C\u5BF9\u8BDD\u8F6C\u5199\u683C\u5F0F\u300D\u5F53\u6210\u56DE\u7B54\u8F93\u51FA\u4E86\uFF08\u5DF2\u4E22\u5F03\uFF0C\u672A\u4E0A\u5C4F\uFF09\uFF0C\u672C\u6B21\u6CA1\u6709\u4EA7\u751F\u6709\u6548\u5185\u5BB9\u3002",
            code: "EMPTY_RESPONSE"
          }
        }
      };
      return;
    }
    if (rejectedProtocol) {
      const reasonText = rejectedReason === "echo" ? "\u7F51\u9875\u7AEF\u672C\u6B21\u8F93\u51FA\u7684\u662F\u4E00\u6BB5\u5386\u53F2\u5185\u5BB9\u56DE\u653E\uFF08\u4E0D\u662F\u771F\u8981\u6267\u884C\u8C03\u7528\uFF09\uFF0C\u5DF2\u4E22\u5F03\u5E76\u81EA\u52A8\u91CD\u8BD5\uFF1B\u65E0\u9700\u5904\u7406\u3002" : rejectedReason === "unbalanced" ? "\u7F51\u9875\u7AEF\u672C\u6B21\u8F93\u51FA\u88AB\u622A\u65AD\uFF0C\u8C03\u7528\u6CA1\u6536\u5168\uFF0C\u5DF2\u4E22\u5F03\u5E76\u81EA\u52A8\u91CD\u8BD5\uFF1B\u65E0\u9700\u5904\u7406\u3002" : "\u7F51\u9875\u7AEF\u672C\u6B21\u7684\u8C03\u7528\u683C\u5F0F\u65E0\u6CD5\u89E3\u6790\uFF0C\u5DF2\u4E22\u5F03\u5E76\u81EA\u52A8\u91CD\u8BD5\uFF1B\u65E0\u9700\u5904\u7406\u3002";
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: { message: reasonText, code: "EMPTY_RESPONSE" }
        }
      };
      return;
    }
    if (!hasVisibleText) {
      const onlyThinking = outputChars > 0;
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            message: onlyThinking ? "DeepSeek \u7F51\u9875\u7AEF\u672C\u8F6E\u6CA1\u6709\u6B63\u6587\u3001\u4E5F\u6CA1\u6709\u5DE5\u5177\u8C03\u7528\uFF08\u5185\u5BB9\u53EF\u80FD\u5168\u843D\u5728\u601D\u8003\u901A\u9053 \u2014\u2014 \u901A\u5E38\u662F\u601D\u8003\u4E0D\u6536\u655B\u540E\u88AB\u622A\u65AD\uFF09\uFF0C\u5DF2\u6309\u53EF\u91CD\u8BD5\u9519\u8BEF\u4E0A\u62A5" : "DeepSeek \u7F51\u9875\u7AEF\u8FD4\u56DE\u4E86\u7A7A\u54CD\u5E94\uFF08\u53EF\u80FD\u89E6\u53D1\u9891\u63A7\u6216\u957F\u4E0A\u4E0B\u6587\u622A\u65AD\uFF09",
            code: "EMPTY_RESPONSE"
          }
        }
      };
      return;
    }
    if (textBlock?.text && looksMidSentence(textBlock.text)) {
      if (!allowsAutoContinue(options?.purpose)) {
        logger?.info?.(
          `deepseek-web: \u5185\u90E8\u7528\u9014\uFF08purpose=${String(options?.purpose)}\uFF09\u7684\u56DE\u7B54\u4EE5\u975E\u6807\u70B9\u6536\u5C3E\uFF0C\u6309\u7EA6\u5B9A\u4E0D\u81EA\u52A8\u7EED\u5199\uFF0C\u6B63\u5E38\u6536\u5C3E\uFF08\u5C3E\u90E8\uFF1A${JSON.stringify(textBlock.text.slice(-40))}\uFF09`
        );
      } else {
        logger?.warn?.(
          `deepseek-web: \u56DE\u7B54\u5728\u53E5\u4E2D\u88AB\u622A\u4E14\u81EA\u52A8\u7EED\u5199\u989D\u5EA6\u5DF2\u7528\u5C3D\uFF0C\u6309\u6B63\u5E38\u5B8C\u6210\u4E0A\u62A5\uFF08\u5C3E\u90E8\uFF1A${JSON.stringify(textBlock.text.slice(-60))}\uFF09`
        );
      }
    }
    noteCallShape("none", logger);
    yield { type: "finish", reason: { kind: "stop" } };
  }
  return adapter;
}
function describeAuth(auth) {
  if (!hasUsableAuth(auth)) return { loggedIn: false, hasCookie: false, hasFingerprint: false };
  let wasmHost;
  try {
    wasmHost = auth.wasmUrl ? new URL(auth.wasmUrl).host : void 0;
  } catch {
    wasmHost = void 0;
  }
  return {
    loggedIn: true,
    ...auth.user?.display ? { display: maskIdentifier(auth.user.display) } : auth.user?.id ? { display: `id:${maskIdentifier(auth.user.id)}` } : {},
    ...auth.capturedAt ? { capturedAt: auth.capturedAt } : {},
    hasCookie: !!auth.cookie,
    hasFingerprint: !!(auth.hifDliq || auth.hifLeim),
    ...wasmHost ? { wasmHost } : {},
    ...auth.unverified ? { unverified: true } : {},
    tokenLength: auth.token.length,
    ...(() => {
      const life = summarizeCookieLife(auth.cookieMeta);
      return life ? { cookieLife: life } : {};
    })()
  };
}

// src/auto-switch.ts
var THROTTLE_SWITCH_WINDOW_MS = 3 * 6e4;
var THROTTLE_SWITCH_COOLDOWN_MS = 3 * 6e4;
function isUsable(account, now) {
  if (account.lastVerifyError) return false;
  const until = Number(account.limit?.untilMs);
  if (Number.isFinite(until) && until > now) return false;
  return true;
}
function isSwitchDue(minutes, lastSwitchAt, now) {
  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  if (!Number.isFinite(lastSwitchAt) || lastSwitchAt <= 0) return false;
  return now - lastSwitchAt >= minutes * 6e4;
}
function isThrottleSwitchAllowed(params) {
  const { throttledAt, lastSwitchAt, now } = params;
  const windowMs = params.windowMs ?? THROTTLE_SWITCH_WINDOW_MS;
  const cooldownMs = params.cooldownMs ?? THROTTLE_SWITCH_COOLDOWN_MS;
  if (!Number.isFinite(throttledAt) || !throttledAt || throttledAt <= 0) return false;
  if (now - throttledAt > windowMs) return false;
  if (Number.isFinite(lastSwitchAt) && lastSwitchAt > 0 && now - lastSwitchAt < cooldownMs) return false;
  return true;
}
function freshThrottledIds(throttledAt, now, windowMs = THROTTLE_SWITCH_WINDOW_MS) {
  const fresh = /* @__PURE__ */ new Set();
  if (!throttledAt) return fresh;
  for (const [id, at] of throttledAt) {
    if (Number.isFinite(at) && at > 0 && now - at <= windowMs) fresh.add(id);
  }
  return fresh;
}
function pickNextAccount(accounts, currentId, now, excludeIds) {
  const usable = accounts.filter((account) => isUsable(account, now) && !excludeIds?.has(account.id));
  if (usable.length === 0) return void 0;
  const index = usable.findIndex((account) => account.id === currentId);
  if (index < 0) return usable[0]?.id;
  if (usable.length === 1) return void 0;
  return usable[(index + 1) % usable.length]?.id;
}
function hasFailoverCandidate(params) {
  if (!Number.isFinite(params.minutes) || params.minutes <= 0) return false;
  if (params.switching) return false;
  return pickNextAccount(params.accounts, params.currentId, params.now, params.excludeIds) !== void 0;
}
function decideAutoSwitch(params) {
  const { minutes, lastSwitchAt, now, accounts, currentId } = params;
  if (!Number.isFinite(minutes) || minutes <= 0) return { action: "skip", reason: "off" };
  const fresh = freshThrottledIds(params.throttledAt, now, params.throttleWindowMs);
  const current = accounts.find((account) => account.id === currentId);
  const currentUnusable = current !== void 0 && !isUsable(current, now);
  const throttleSwitch = isThrottleSwitchAllowed({
    throttledAt: currentId === void 0 ? void 0 : params.throttledAt?.get(currentId),
    // ⚠️ 传的是"上次**真正换过号**的时刻"，不是 `lastSwitchAt`（那个在宿主里被初始化成
    // 启动时刻，拿它算冷却会让每次重启后都有一段时间"限流也不换号"）。见参数注释。
    lastSwitchAt: params.lastSwitchedAt ?? 0,
    now,
    ...params.throttleWindowMs === void 0 ? {} : { windowMs: params.throttleWindowMs },
    ...params.throttleCooldownMs === void 0 ? {} : { cooldownMs: params.throttleCooldownMs }
  });
  if (!currentUnusable && !throttleSwitch && !isSwitchDue(minutes, lastSwitchAt, now)) {
    return { action: "skip", reason: "not-due" };
  }
  const nextId = pickNextAccount(accounts, currentId, now, fresh);
  if (!nextId) {
    const anyUsable = accounts.some((account) => isUsable(account, now) && !fresh.has(account.id));
    return { action: "skip", reason: anyUsable ? "no-other-account" : "no-candidate" };
  }
  return {
    action: "switch",
    nextId,
    reason: currentUnusable ? "current-unusable" : throttleSwitch ? "recently-throttled" : "due"
  };
}

// src/login.ts
import { createRequire } from "node:module";

// src/account-add.ts
var ADD_MODE_TTL_MS = 15 * 6e4;
var startedAt = null;
function beginAddAccount(now = Date.now()) {
  startedAt = now;
}
function addModeActive(now = Date.now()) {
  if (startedAt === null) return false;
  if (now - startedAt > ADD_MODE_TTL_MS) {
    startedAt = null;
    return false;
  }
  return true;
}
function endAddAccount() {
  startedAt = null;
}
var RELOGIN_TTL_MS = 60 * 6e4;
var reloginTarget = null;
function beginRelogin(id, now = Date.now()) {
  reloginTarget = { id, at: now };
}
function endRelogin() {
  reloginTarget = null;
}
function pendingReloginTarget(now = Date.now()) {
  if (!reloginTarget) return void 0;
  if (now - reloginTarget.at > RELOGIN_TTL_MS) {
    reloginTarget = null;
    return void 0;
  }
  return reloginTarget.id;
}
function sameAccount(existing, auth) {
  const incoming = auth;
  const incomingId = incoming.serverId ?? incoming.user?.id;
  const knownId = existing.serverId ?? existing.user?.id;
  if (!incomingId || !knownId) return true;
  return incomingId === knownId;
}
function commitCapturedAuth(auth, now = Date.now()) {
  const target = pendingReloginTarget(now);
  if (target) {
    try {
      const existing = readAccount(target);
      if (existing && sameAccount(existing, auth)) {
        const record = upsertAccount(auth, { id: target });
        updateAccount(target, { lastVerifyError: void 0, lastCheckError: void 0 });
        return { mode: "relogin", created: false, recordId: record.id };
      }
    } finally {
      endAddAccount();
      endRelogin();
    }
  }
  if (!addModeActive(now)) {
    writeAuth(auth);
    const active = activeAccountId();
    return { mode: "switch", ...active ? { recordId: active } : {} };
  }
  const before = new Set(listAccounts().map((item) => item.id));
  const hadActive = activeAccountId() !== void 0;
  try {
    const record = upsertAccount(auth);
    if (!hadActive) setActiveAccount(record.id);
    return { mode: "add", created: !before.has(record.id), recordId: record.id };
  } finally {
    endAddAccount();
  }
}

// src/login.ts
var PARTITION = "persist:dsh-deepseek-web-login";
var LOGIN_URL = `${DS_BASE}/`;
function platformToken() {
  if (process.platform === "win32") return "Windows NT 10.0; Win64; x64";
  if (process.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return "X11; Linux x86_64";
}
function buildLoginUserAgent(chromiumVersion = process.versions.chrome) {
  const major = String(chromiumVersion ?? "").split(".")[0] || "131";
  return `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
function sanitizeClientHints(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (lower !== "sec-ch-ua" && lower !== "sec-ch-ua-full-version-list" && lower !== "user-agent") continue;
    const value = String(out[key]);
    if (lower === "user-agent") {
      if (/electron/i.test(value)) out[key] = buildLoginUserAgent();
      continue;
    }
    const brands = value.split(",").map((part) => part.trim()).filter((part) => part && !/electron/i.test(part));
    out[key] = brands.length > 0 ? brands.join(", ") : '"Chromium";v="131", "Not_A Brand";v="24"';
  }
  return out;
}
function applyBrowserFingerprint(ses, win) {
  const ua = buildLoginUserAgent();
  try {
    ses.setUserAgent(ua);
  } catch {
  }
  try {
    win.webContents.setUserAgent(ua);
  } catch {
  }
}
function observePageFingerprint(win, report) {
  const script = `(() => {
    const bad = /electron|dsh|deepseek-harness/i
    let patchedBrands = null
    try {
      const data = navigator.userAgentData
      if (data && Array.isArray(data.brands)) {
        const dirty = data.brands.filter((b) => bad.test(String(b.brand)))
        if (dirty.length > 0) {
          const clean = data.brands.filter((b) => !bad.test(String(b.brand)))
          try {
            Object.defineProperty(Object.getPrototypeOf(data), 'brands', { get: () => clean, configurable: true })
          } catch {}
        }
      }
    } catch {}
    try {
      if (navigator.webdriver) {
        Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => false, configurable: true })
      }
    } catch {}
    try {
      const data = navigator.userAgentData
      patchedBrands = data && Array.isArray(data.brands) ? data.brands.map((b) => b.brand + '/' + b.version) : null
    } catch {}
    return JSON.stringify({
      ua: navigator.userAgent,
      brands: patchedBrands,
      webdriver: !!navigator.webdriver,
    })
  })()`;
  const read = () => {
    try {
      const promise = win.webContents.executeJavaScript(script, true);
      void Promise.resolve(promise).then((raw) => {
        try {
          const info = JSON.parse(String(raw));
          report.pageUa = String(info.ua ?? "");
          report.pageBrands = Array.isArray(info.brands) ? info.brands.map(String) : void 0;
          report.pageWebdriver = !!info.webdriver;
          fingerprintReport = { ...fingerprintReport ?? { at: (/* @__PURE__ */ new Date()).toISOString(), url: LOGIN_URL, stripped: [] }, ...report };
        } catch {
        }
      }).catch(() => {
      });
    } catch {
    }
  };
  try {
    win.webContents.on("dom-ready", read);
    win.webContents.on("did-finish-load", read);
  } catch {
  }
}
var loginWindow = null;
var stopPolling = null;
var progress = { open: false };
var lastResult;
var fingerprintReport;
function getFingerprintReport() {
  return fingerprintReport;
}
var spawnImpl;
async function openExternalLogin() {
  if (canOpenElectronWindow()) {
    try {
      const electron = createRequire(import.meta.url)("electron");
      await electron.shell.openExternal(LOGIN_URL);
      return { ok: true, url: LOGIN_URL, via: "electron-shell" };
    } catch {
    }
  }
  const failed = (error) => ({
    ok: false,
    url: LOGIN_URL,
    message: `${error instanceof Error ? error.message : String(error)} \u2014\u2014 \u8BF7\u624B\u52A8\u5728\u6D4F\u89C8\u5668\u6253\u5F00 ${LOGIN_URL}`
  });
  try {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", LOGIN_URL] : [LOGIN_URL];
    return await new Promise((resolve) => {
      const child = (spawnImpl ?? createRequire(import.meta.url)("node:child_process").spawn)(command, args, {
        stdio: "ignore",
        detached: true
      });
      child.once("error", (error) => resolve(failed(error)));
      child.once("spawn", () => {
        child.unref?.();
        resolve({ ok: true, url: LOGIN_URL, via: command });
      });
    });
  } catch (error) {
    return failed(error);
  }
}
function getLoginProgress() {
  return progress;
}
function getLastLoginResult() {
  return lastResult;
}
function canOpenElectronWindow() {
  return canOpenElectronWindowWith({
    // @types/node 的 ProcessVersions **不含** electron 字段（Electron 运行时注入）——
    // 进程边界上做一次断言，类型上承认"这里有个未知的 electron 版本位"。
    versions: process.versions,
    processType: process.type,
    loadElectron: () => createRequire(import.meta.url)("electron")
  });
}
function canOpenElectronWindowWith(deps) {
  if (!deps.versions?.electron) return false;
  if (deps.processType && deps.processType !== "browser") return false;
  try {
    const electron = deps.loadElectron();
    if (!electron || typeof electron === "string") return false;
    return !!(electron.session && electron.BrowserWindow);
  } catch {
    return false;
  }
}
function electronAvailable() {
  return canOpenElectronWindow();
}
function isLoginWindowOpen() {
  return !!loginWindow;
}
function cleanup() {
  if (stopPolling) {
    try {
      stopPolling();
    } catch {
    }
    stopPolling = null;
  }
  loginWindow = null;
  progress = { ...progress, open: false };
}
function startCapturePoll(options) {
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : 2e3;
  const maxAttempts = Number.isFinite(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 3;
  const abort = new AbortController();
  let timer = null;
  let stopped = false;
  let committed = false;
  let running = false;
  let attempts = 0;
  const stop = () => {
    stopped = true;
    abort.abort();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = () => {
    if (stopped || committed) return;
    timer = setTimeout(() => {
      void round();
    }, intervalMs);
    timer.unref?.();
  };
  const round = async () => {
    timer = null;
    if (stopped || committed || running) return;
    running = true;
    try {
      const candidates = await options.capture();
      if (stopped || committed) return;
      options.onCaptured?.();
      if (!candidates.length) return;
      attempts += 1;
      let lastError = "";
      for (const token of candidates) {
        const check = await options.verify(token);
        if (stopped || committed) return;
        if (check.ok) {
          committed = true;
          stop();
          await options.commit(token, true);
          return;
        }
        lastError = check.error ?? "validation failed";
      }
      options.onError?.(lastError);
      if (attempts >= maxAttempts) {
        committed = true;
        stop();
        await options.commit(candidates[0], false);
      }
    } catch (error) {
      if (!stopped || committed) {
        options.onError?.("\u767B\u5F55\u6355\u83B7\u6216\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u767B\u5F55");
        options.logger?.warn?.(`deepseek-web: \u767B\u5F55\u6355\u83B7\u6216\u4FDD\u5B58\u5931\u8D25: ${error?.message ?? error}`);
      }
    } finally {
      running = false;
      schedule();
    }
  };
  timer = setTimeout(() => {
    void round();
  }, intervalMs);
  timer.unref?.();
  return stop;
}
var PAGE_READ_SCRIPT = `JSON.stringify({
  userToken: (function () {
    try {
      var raw = localStorage.getItem('userToken')
      if (!raw) return ''
      if (raw.charAt(0) === '{') {
        var parsed = JSON.parse(raw)
        return typeof parsed.value === 'string' ? parsed.value : ''
      }
      return raw
    } catch (e) { return '' }
  })(),
  userInfo: (function () {
    try {
      var raw = localStorage.getItem('__appKit_userInfo')
      if (!raw) return ''
      var parsed = JSON.parse(raw)
      var value = parsed && parsed.value ? parsed.value : parsed
      return JSON.stringify({ id: value && value.id, name: value && (value.name || value.nickname) })
    } catch (e) { return '' }
  })(),
  hifLeim: (function () {
    try {
      var raw = localStorage.getItem('hif_leim_cached')
      if (!raw) return ''
      if (raw.charAt(0) === '"') return JSON.parse(raw)
      return raw
    } catch (e) { return '' }
  })(),
  wasm: (function () {
    try {
      return performance.getEntriesByType('resource').map(function (r) { return r.name })
        .find(function (n) { return /sha3[^\\s]*\\.wasm/.test(n) }) || ''
    } catch (e) { return '' }
  })()
})`;
function successPage(message) {
  const html = `<!doctype html><meta charset="utf-8"><title>DSH \xB7 \u767B\u5F55\u6210\u529F</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0f1115;color:#e6e6e6;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 .card{text-align:center;padding:36px 48px;border:1px solid #2a2f3a;border-radius:14px;background:#151922}
 .ok{font-size:44px;margin-bottom:10px}
 .sub{color:#8b93a3;font-size:13px;margin-top:8px}
</style>
<div class="card"><div class="ok">\u2705</div><div>${message}</div>
<div class="sub">\u6B64\u7A97\u53E3\u5C06\u81EA\u52A8\u5173\u95ED\uFF0C\u53EF\u56DE\u5230 DSH \u7EE7\u7EED\u4F7F\u7528</div></div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
function newBuffer() {
  return {
    headerToken: "",
    localToken: "",
    cookie: "",
    cookieMeta: [],
    hifDliq: "",
    hifLeim: "",
    wasmUrl: "",
    userAgent: "",
    extraHeaders: {},
    user: {}
  };
}
function tokenCandidates(buffer) {
  return [...new Set([buffer.headerToken, buffer.localToken].filter((token) => !!token && token.length > 8))];
}
function buildAuth(buffer, token, unverified) {
  const extraHeaders = Object.keys(buffer.extraHeaders).length > 0 ? buffer.extraHeaders : void 0;
  const defect = captureDefect({ token, cookie: buffer.cookie, extraHeaders });
  return {
    token,
    cookie: buffer.cookie,
    cookieMeta: buffer.cookieMeta,
    hifDliq: buffer.hifDliq,
    hifLeim: buffer.hifLeim,
    wasmUrl: buffer.wasmUrl || DEFAULT_WASM_URL,
    userAgent: buffer.userAgent || FALLBACK_UA,
    ...extraHeaders ? { extraHeaders } : {},
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...unverified ? { unverified: true } : {},
    ...defect ? { captureWarning: defect } : {},
    ...Object.keys(buffer.user).length > 0 ? { user: buffer.user } : {}
  };
}
function progressFrom(buffer) {
  return {
    token: tokenCandidates(buffer).length > 0,
    cookie: !!buffer.cookie,
    fingerprint: !!(buffer.hifDliq || buffer.hifLeim),
    wasm: !!buffer.wasmUrl
  };
}
async function readCookies(ses, buffer) {
  try {
    const cookies = await ses.cookies.get({});
    const relevant = cookies.filter((cookie) => String(cookie?.domain ?? "").includes("deepseek.com"));
    if (relevant.length > 0) {
      buffer.cookie = relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      buffer.cookieMeta = pickCookieMeta(
        relevant,
        (domain) => String(domain ?? "").includes("deepseek.com")
      );
    }
  } catch {
  }
}
async function readPage(win, buffer) {
  try {
    const raw = await win.webContents.executeJavaScript(PAGE_READ_SCRIPT, true);
    const info = typeof raw === "string" ? JSON.parse(raw) : raw;
    const token = unwrapStoredToken(info?.userToken);
    if (token) buffer.localToken = token;
    if (info?.hifLeim) buffer.hifLeim = String(info.hifLeim);
    if (info?.wasm) buffer.wasmUrl = String(info.wasm);
    if (info?.userInfo) {
      try {
        const parsed = JSON.parse(String(info.userInfo));
        if (parsed?.id) buffer.user.id = String(parsed.id);
        if (parsed?.name) buffer.user.display = String(parsed.name);
      } catch {
      }
    }
  } catch {
  }
}
function hookHeaders(ses, buffer, onRewrite) {
  ses.webRequest.onBeforeSendHeaders({ urls: ["https://chat.deepseek.com/*", "https://*.deepseek.com/*"] }, (details, callback) => {
    const headers = { ...details?.requestHeaders ?? {} };
    const lower = {};
    for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = String(value);
    const sanitized = sanitizeClientHints(headers);
    const stripped = [];
    for (const key of Object.keys(headers)) {
      if (String(headers[key]) !== String(sanitized[key])) stripped.push(key.toLowerCase());
    }
    for (const key of Object.keys(headers)) delete headers[key];
    Object.assign(headers, sanitized);
    if (stripped.length > 0) onRewrite?.({ url: String(details?.url ?? ""), stripped });
    const cleanLower = {};
    for (const [key, value] of Object.entries(headers)) cleanLower[key.toLowerCase()] = String(value);
    if (String(details?.url ?? "").includes("/api/")) {
      if (!buffer.userAgent && cleanLower["user-agent"]) buffer.userAgent = cleanLower["user-agent"];
      const authHeader = cleanLower["authorization"];
      if (authHeader?.toLowerCase().startsWith("bearer ")) buffer.headerToken = authHeader.slice(7).trim();
      if (cleanLower["cookie"]) buffer.cookie = cleanLower["cookie"];
      if (cleanLower["x-hif-dliq"]) buffer.hifDliq = cleanLower["x-hif-dliq"];
      if (cleanLower["x-hif-leim"]) buffer.hifLeim = cleanLower["x-hif-leim"];
      if (!buffer.extraHeaders["x-client-version"]) {
        buffer.extraHeaders = pickExtraHeaders(cleanLower);
      }
    }
    callback({ requestHeaders: headers });
  });
}
async function openLoginWindow(logger) {
  if (!electronAvailable()) return { started: false, reason: "not-electron" };
  if (loginWindow) {
    try {
      loginWindow.focus();
    } catch {
    }
    return { started: true, reason: "already-open" };
  }
  const electron = createRequire(import.meta.url)("electron");
  const { BrowserWindow, session } = electron;
  const buffer = newBuffer();
  fingerprintReport = void 0;
  progress = { open: true, startedAt: (/* @__PURE__ */ new Date()).toISOString(), captured: progressFrom(buffer) };
  const ses = session.fromPartition(PARTITION);
  try {
    hookHeaders(ses, buffer, (info) => {
      if (!fingerprintReport) {
        fingerprintReport = { at: (/* @__PURE__ */ new Date()).toISOString(), url: info.url, stripped: info.stripped };
        logger?.info?.(`deepseek-web login: \u5DF2\u5254\u9664 Electron \u6307\u7EB9\u5934 [${info.stripped.join(", ")}]`);
      } else {
        fingerprintReport = { ...fingerprintReport, stripped: info.stripped };
      }
    });
  } catch (error) {
    logger?.warn?.(`deepseek-web login: header capture unavailable: ${error?.message ?? error}`);
  }
  const captureAbort = new AbortController();
  const win = new BrowserWindow({
    width: 1180,
    height: 840,
    title: "DSH \xB7 \u767B\u5F55 DeepSeek \u7F51\u9875\u7248\uFF08\u767B\u5F55\u540E\u81EA\u52A8\u6355\u83B7\uFF09",
    autoHideMenuBar: true,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
  });
  loginWindow = win;
  win.on("closed", () => cleanup());
  applyBrowserFingerprint(ses, win);
  observePageFingerprint(win, {});
  try {
    await win.loadURL(LOGIN_URL);
  } catch (error) {
    logger?.warn?.(`deepseek-web login: load failed: ${error?.message ?? error}`);
  }
  const finish = async (auth, verified) => {
    const commit = commitCapturedAuth(auth);
    const tail = commit.mode === "add" ? "\uFF08\u5DF2\u52A0\u5165\u8D26\u53F7\u5E93\uFF0C\u5F53\u524D\u8D26\u53F7\u672A\u6539\u52A8\uFF09" : "";
    lastResult = {
      ok: true,
      message: (verified ? `\u767B\u5F55\u6210\u529F${auth.user?.display ? `\uFF08${maskIdentifier(auth.user.display)}\uFF09` : ""}\uFF0C\u51ED\u8BC1\u5DF2\u4FDD\u5B58\u5E76\u6821\u9A8C\u901A\u8FC7` : "\u5DF2\u6355\u83B7\u5E76\u4FDD\u5B58\u51ED\u8BC1\uFF0C\u4F46\u670D\u52A1\u7AEF\u6821\u9A8C\u672A\u901A\u8FC7\uFF08\u53EF\u7528\u300C\u53D1\u9001\u6D4B\u8BD5\u300D\u505A\u771F\u5B9E\u5224\u5B9A\uFF09") + tail,
      at: (/* @__PURE__ */ new Date()).toISOString()
    };
    logger?.info?.(`deepseek-web login: credentials saved (verified=${verified}, mode=${commit.mode})`);
    progress = { ...progress, finished: true };
    if (!verified) {
      try {
        win.setTitle("DSH \xB7 \u5DF2\u6355\u83B7\u51ED\u8BC1\uFF08\u672A\u901A\u8FC7\u670D\u52A1\u7AEF\u6821\u9A8C\uFF0C\u53EF\u76F4\u63A5\u5173\u95ED\u6B64\u7A97\u53E3\uFF09");
      } catch {
      }
      return;
    }
    try {
      await win.loadURL(successPage("\u5DF2\u6355\u83B7 DeepSeek \u7F51\u9875\u7AEF\u767B\u5F55\u72B6\u6001"));
    } catch {
    }
    setTimeout(() => {
      try {
        win.close();
      } catch {
      }
    }, 3500);
  };
  let verifiedAuth;
  stopPolling = startCapturePoll({
    capture: async () => {
      await readPage(win, buffer);
      await readCookies(ses, buffer);
      return tokenCandidates(buffer);
    },
    verify: async (token) => {
      const auth = buildAuth(buffer, token, false);
      const signal = AbortSignal.any([captureAbort.signal, AbortSignal.timeout(15e3)]);
      const check = await validateAuth(auth, signal);
      if (check.ok) verifiedAuth = withVerifiedIdentity(auth, check.user);
      return { ok: !!check.ok, ...check.error ? { error: check.error } : {} };
    },
    commit: async (token, verified) => {
      const auth = verified && verifiedAuth ? verifiedAuth : buildAuth(buffer, token, true);
      await finish(auth, verified);
    },
    onCaptured: () => {
      progress.captured = progressFrom(buffer);
    },
    onError: (message) => {
      progress = { ...progress, lastError: message };
    },
    logger
  });
  return { started: true };
}
async function captureFromPartition(logger) {
  if (!electronAvailable()) return { ok: false, verified: false, message: "\u5F53\u524D\u73AF\u5883\u4E0D\u662F Electron \u684C\u9762\u7AEF" };
  const electron = createRequire(import.meta.url)("electron");
  const { BrowserWindow, session } = electron;
  const ses = session.fromPartition(PARTITION);
  const buffer = newBuffer();
  let win;
  try {
    win = new BrowserWindow({ show: false, width: 1e3, height: 720, webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true } });
    try {
      hookHeaders(ses, buffer);
    } catch {
    }
    await win.loadURL(LOGIN_URL);
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1e3));
      await readPage(win, buffer);
      if (buffer.headerToken || buffer.localToken) break;
    }
    await readCookies(ses, buffer);
  } catch (error) {
    try {
      if (win && !win.isDestroyed()) win.close();
    } catch {
    }
    return { ok: false, verified: false, message: `\u6253\u5F00\u5206\u533A\u5931\u8D25\uFF1A${error?.message ?? error}` };
  }
  try {
    if (win && !win.isDestroyed()) win.close();
  } catch {
  }
  const candidates = tokenCandidates(buffer);
  if (candidates.length === 0) {
    return { ok: false, verified: false, message: "\u5206\u533A\u91CC\u6CA1\u6709\u767B\u5F55\u6001\uFF1A\u8BF7\u5148\u7528\u300C\u6D4F\u89C8\u5668\u7A97\u53E3\u767B\u5F55\u300D\u767B\u5F55\u4E00\u6B21" };
  }
  for (const token of candidates) {
    const auth = buildAuth(buffer, token, false);
    const check = await validateAuth(auth);
    if (check.ok) {
      const commit = commitCapturedAuth(withVerifiedIdentity(auth, check.user));
      const tail2 = commit.mode === "add" ? "\uFF08\u5DF2\u52A0\u5165\u8D26\u53F7\u5E93\uFF0C\u5F53\u524D\u8D26\u53F7\u672A\u6539\u52A8\uFF09" : "";
      lastResult = { ok: true, message: "\u5DF2\u4ECE\u5DF2\u767B\u5F55\u7A97\u53E3\u6062\u590D\u51ED\u8BC1\uFF08\u6821\u9A8C\u901A\u8FC7\uFF09" + tail2, at: (/* @__PURE__ */ new Date()).toISOString() };
      logger?.info?.(`deepseek-web login: recovered credentials from partition (verified, mode=${commit.mode})`);
      return { ok: true, verified: true, message: "\u5DF2\u4ECE\u5DF2\u767B\u5F55\u7A97\u53E3\u6062\u590D\u51ED\u8BC1\uFF08\u6821\u9A8C\u901A\u8FC7\uFF09" + tail2 };
    }
  }
  const fallback = commitCapturedAuth(buildAuth(buffer, candidates[0], true));
  const tail = fallback.mode === "add" ? "\uFF08\u5DF2\u52A0\u5165\u8D26\u53F7\u5E93\uFF0C\u5F53\u524D\u8D26\u53F7\u672A\u6539\u52A8\uFF09" : "";
  lastResult = { ok: true, message: "\u5DF2\u4ECE\u5DF2\u767B\u5F55\u7A97\u53E3\u6062\u590D\u51ED\u8BC1\uFF08\u672A\u901A\u8FC7\u670D\u52A1\u7AEF\u6821\u9A8C\uFF09" + tail, at: (/* @__PURE__ */ new Date()).toISOString() };
  logger?.info?.(`deepseek-web login: recovered credentials from partition (unverified, mode=${fallback.mode})`);
  return { ok: true, verified: false, message: "\u5DF2\u6062\u590D\u51ED\u8BC1\uFF0C\u4F46\u670D\u52A1\u7AEF\u6821\u9A8C\u672A\u901A\u8FC7\uFF08\u53EF\u7528\u300C\u53D1\u9001\u6D4B\u8BD5\u300D\u9A8C\u8BC1\uFF09" + tail };
}
async function loginWithToken(token, cookie, logger) {
  const raw = String(token ?? "").trim();
  if (raw.startsWith("{") && !unwrapStoredToken(token)) {
    return {
      ok: false,
      error: "\u7C98\u8D34\u7684\u5185\u5BB9\u50CF localStorage \u5305\u88C5 JSON\uFF0C\u4F46\u89E3\u4E0D\u51FA token\uFF08value \u4E3A\u7A7A\u6216\u5DF2\u635F\u574F\uFF09\u2014\u2014\u8BF7\u53EA\u590D\u5236\u5176\u4E2D\u7684\u5B57\u7B26\u4E32\u503C\uFF0C\u6216\u76F4\u63A5\u7C98\u8D34\u88F8 token"
    };
  }
  const trimmed = unwrapStoredToken(token) || raw;
  if (trimmed.length < 8) return { ok: false, error: "token \u592A\u77ED\uFF0C\u8BF7\u786E\u8BA4\u590D\u5236\u7684\u662F chat.deepseek.com \u7684\u767B\u5F55 token" };
  const auth = {
    token: trimmed,
    cookie: String(cookie ?? "").trim(),
    hifDliq: "",
    hifLeim: "",
    wasmUrl: DEFAULT_WASM_URL,
    userAgent: FALLBACK_UA,
    capturedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const check = await validateAuth(auth);
  if (!check.ok) {
    commitCapturedAuth({ ...auth, unverified: true });
    lastResult = { ok: true, message: `\u51ED\u8BC1\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u670D\u52A1\u7AEF\u6821\u9A8C\u672A\u901A\u8FC7\uFF1A${check.error ?? ""}`, at: (/* @__PURE__ */ new Date()).toISOString() };
    logger?.info?.("deepseek-web login: token saved (unverified)");
    return { ok: true, error: `\u5DF2\u4FDD\u5B58\uFF08\u672A\u901A\u8FC7\u6821\u9A8C\uFF1A${check.error ?? "unknown"}\uFF09` };
  }
  commitCapturedAuth(withVerifiedIdentity(auth, check.user));
  lastResult = {
    ok: true,
    message: `token \u6821\u9A8C\u901A\u8FC7\uFF0C\u51ED\u8BC1\u5DF2\u4FDD\u5B58${check.user?.display ? `\uFF08${maskIdentifier(check.user.display)}\uFF09` : ""}`,
    at: (/* @__PURE__ */ new Date()).toISOString()
  };
  logger?.info?.("deepseek-web login: token saved");
  return { ok: true, ...check.user?.display ? { display: maskIdentifier(check.user.display) } : {} };
}
async function clearLoginState(options = {}) {
  const profileCleared = clearBrowserLoginProfile(options.profileDir);
  const partitionCleared = await clearLoginPartition().catch(() => false);
  return { profileCleared, partitionCleared };
}
async function clearLoginPartition() {
  if (!electronAvailable()) return false;
  try {
    const electron = createRequire(import.meta.url)("electron");
    const ses = electron.session.fromPartition(PARTITION);
    await ses.clearStorageData({
      origin: "https://chat.deepseek.com",
      storages: ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers", "websql"]
    });
    return true;
  } catch {
    return false;
  }
}
function closeLoginWindow() {
  if (loginWindow) {
    try {
      loginWindow.close();
    } catch {
    }
  }
  cleanup();
}
async function logout() {
  closeLoginWindow();
  clearAuth();
  const browserProfileCleared = clearBrowserLoginProfile();
  const partitionCleared = await clearLoginPartition().catch(() => false);
  const partitionOK = partitionCleared || !electronAvailable();
  const cleared = browserProfileCleared && partitionOK;
  lastResult = {
    ok: true,
    message: cleared ? "\u5DF2\u9000\u51FA\u767B\u5F55\uFF1A\u672C\u5730\u51ED\u8BC1\u4E0E\u6D4F\u89C8\u5668\u767B\u5F55\u6001\u90FD\u5DF2\u6E05\u9664" : !browserProfileCleared ? "\u5DF2\u9000\u51FA\u767B\u5F55\uFF1A\u672C\u5730\u51ED\u8BC1\u5DF2\u6E05\u9664\uFF0C\u4F46**\u6D4F\u89C8\u5668\u767B\u5F55\u6001\u672A\u6E05\u6389**\uFF08\u6D4F\u89C8\u5668\u7A97\u53E3\u8FD8\u5F00\u7740\u6216\u8FDB\u7A0B\u6B8B\u7559\uFF09\u2014\u2014\u4E0B\u6B21\u300C\u6D4F\u89C8\u5668\u7A97\u53E3\u767B\u5F55\u300D\u4F1A\u76F4\u63A5\u590D\u7528\u65E7\u767B\u5F55\u6001\uFF0C\u76F8\u5F53\u4E8E\u6CA1\u9000\u51FA\uFF1B\u8BF7\u5173\u6389\u6D4F\u89C8\u5668\u540E\u91CD\u8BD5" : "\u5DF2\u9000\u51FA\u767B\u5F55\uFF1A\u672C\u5730\u51ED\u8BC1\u5DF2\u6E05\u9664\uFF08\u6D4F\u89C8\u5668\u5206\u533A\u6E05\u7406\u5931\u8D25\uFF0C\u767B\u5F55\u7A97\u53E3\u53EF\u80FD\u4ECD\u662F\u65E7\u8D26\u53F7\uFF0C\u8BF7\u624B\u52A8\u9000\u51FA\u7F51\u9875\u7AEF\uFF09",
    at: (/* @__PURE__ */ new Date()).toISOString()
  };
  return cleared;
}

// src/relogin.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync8, readFileSync as readFileSync7 } from "node:fs";
import { join as join8 } from "node:path";
function credentialsPath() {
  return join8(webLoginDir(), "credentials.json");
}
function maskLocalPart(email) {
  const at = email.lastIndexOf("@");
  if (at <= 0) return void 0;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length < 8) return void 0;
  return `${local.slice(0, 4)}${"*".repeat(local.length - 7)}${local.slice(-3)}${domain}`;
}
function readCredentialEntries() {
  const file = credentialsPath();
  if (!existsSync6(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync7(file, "utf8"));
    if (!Array.isArray(parsed?.entries)) return [];
    return parsed.entries.filter((e) => e && typeof e.email === "string" && typeof e.password === "string").map((e) => ({ email: e.email.trim(), password: e.password })).filter((e) => e.email.length > 0 && e.password.length > 0);
  } catch {
    return [];
  }
}
function credentialForDisplay(display, entries = readCredentialEntries()) {
  const needle = (display ?? "").trim();
  if (!needle) return void 0;
  return entries.find((e) => maskLocalPart(e.email) === needle);
}
var TOKEN_TTL_MS = 120 * 60 * 1e3;
var TOKEN_RENEW_AFTER_MS = 100 * 60 * 1e3;
function selectReloginTargets(input) {
  const now = input.now ?? Date.now();
  const out = [];
  for (const account of input.accounts) {
    const entry = credentialForDisplay(account.user?.display, input.entries);
    if (!entry) continue;
    const expired = Boolean(account.lastVerifyError);
    const born = account.capturedAt ? Date.parse(account.capturedAt) : Number.NaN;
    const age = Number.isFinite(born) ? now - born : Number.NaN;
    const expiring = Number.isFinite(age) && age >= TOKEN_RENEW_AFTER_MS;
    if (input.onlyStale && !expired && !expiring) continue;
    out.push({
      accountId: account.id,
      email: entry.email,
      display: account.user?.display ?? entry.email,
      reason: expired ? "expired" : expiring ? "expiring" : "manual"
    });
  }
  return out;
}

// src/net-diagnostics.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync10, readFileSync as readFileSync9, renameSync as renameSync3, writeFileSync as writeFileSync6 } from "node:fs";
import { createServer } from "node:http";
import { dirname, join as join10 } from "node:path";

// src/transport.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync9, readFileSync as readFileSync8, writeFileSync as writeFileSync5 } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { join as join9 } from "node:path";
var DEFAULT_TRANSPORT = "chromium";
var TRANSPORT_HINT = "Chrome \u7F51\u7EDC\u6808\u4F1A\u8DDF\u968F\u300C\u7CFB\u7EDF\u4EE3\u7406\u300D\uFF08Node \u5219\u5B8C\u5168\u65E0\u89C6\u4EE3\u7406\uFF09\u3002\u82E5\u68AF\u5B50\u5173\u95ED\u65F6\u7CFB\u7EDF\u4EE3\u7406\u4ECD\u6307\u5411 127.0.0.1:7897\uFF0C\u5207\u5230 Chrome \u540E\u8BF7\u6C42\u4F1A\u5931\u8D25 \u2014\u2014 \u8FD9\u65F6\u5207\u56DE Node \u5373\u53EF\u3002";
function electronNetFetch() {
  try {
    const electron = createRequire2(import.meta.url)("electron");
    const impl = electron?.net?.fetch;
    return typeof impl === "function" ? impl : void 0;
  } catch {
    return void 0;
  }
}
function transportSettingsPath() {
  return join9(resolveDshHome(), "web-login", "transport.json");
}
function readTransportSetting() {
  try {
    const file = transportSettingsPath();
    if (!existsSync7(file)) return void 0;
    const parsed = JSON.parse(readFileSync8(file, "utf8"));
    return parsed?.transport === "node" || parsed?.transport === "chromium" ? parsed.transport : void 0;
  } catch {
    return void 0;
  }
}
function writeTransportSetting(kind) {
  const file = transportSettingsPath();
  mkdirSync9(join9(file, ".."), { recursive: true });
  writeFileSync5(file, JSON.stringify({ transport: kind }, null, 2) + "\n", "utf8");
}
function resolveTransportState(requested) {
  const electronFetch = electronNetFetch();
  const chromiumAvailable = electronFetch !== void 0;
  const browserAvailable = systemBrowserAvailable();
  if (requested === "chromium") {
    if (electronFetch) {
      return {
        requested,
        effective: "chromium",
        degraded: false,
        chromiumAvailable: true,
        browserAvailable,
        viaBrowserProxy: false
      };
    }
    if (browserAvailable) {
      return {
        requested,
        effective: "chromium",
        degraded: false,
        chromiumAvailable: false,
        browserAvailable: true,
        viaBrowserProxy: true
      };
    }
    return {
      requested,
      effective: "node",
      degraded: true,
      chromiumAvailable: false,
      browserAvailable: false,
      viaBrowserProxy: false
    };
  }
  return {
    requested,
    effective: "node",
    degraded: false,
    chromiumAvailable,
    browserAvailable,
    viaBrowserProxy: false
  };
}
var appliedBrowserFetch;
var currentEffectiveKind = "node";
function currentEffectiveFetch() {
  if (currentEffectiveKind === "browser" && appliedBrowserFetch) {
    return { fetch: appliedBrowserFetch, kind: "browser" };
  }
  const electron = electronNetFetch();
  if (currentEffectiveKind === "electron" && electron) {
    return { fetch: electron, kind: "electron" };
  }
  return { fetch: globalThis.fetch, kind: "node" };
}
function applyTransportState(state) {
  if (state.effective === "chromium" && state.viaBrowserProxy) {
    appliedBrowserFetch = createBrowserFetch();
    setFetchImpl(appliedBrowserFetch);
    currentEffectiveKind = "browser";
    return;
  }
  if (appliedBrowserFetch) {
    void shutdownBrowserTransport();
    appliedBrowserFetch = void 0;
  }
  if (state.effective === "chromium" && electronNetFetch()) {
    setFetchImpl(electronNetFetch());
    currentEffectiveKind = "electron";
    return;
  }
  setFetchImpl(void 0);
  currentEffectiveKind = "node";
}
function applyTransport(requested) {
  const state = resolveTransportState(requested);
  applyTransportState(state);
  return state;
}

// src/net-diagnostics.ts
async function probeStreamingSupport(fetchImpl) {
  const evidence = { chunks: 0, abortedEarly: false };
  let server;
  let reader;
  let timer;
  let aborted = false;
  try {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let n = 0;
      timer = setInterval(() => {
        n += 1;
        res.write(`data: chunk-${n}

`);
        if (n >= 50) {
          if (timer) clearInterval(timer);
          res.end();
        }
      }, 20);
      req.on("close", () => {
        aborted = true;
        if (timer) clearInterval(timer);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    const port = server.address()?.port;
    evidence.url = `http://127.0.0.1:${port}/`;
    const controller = new AbortController();
    const response = await fetchImpl(evidence.url, { signal: controller.signal });
    evidence.status = response.status;
    evidence.hasBody = !!response.body;
    if (!response.body) {
      evidence.ok = false;
      evidence.error = "response.body \u4E3A\u7A7A \u2014\u2014 \u65E0\u6CD5\u8BFB SSE\uFF0C\u6539\u9020\u8DEF\u7EBF\u4E0D\u6210\u7ACB";
      return evidence;
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (evidence.chunks < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      evidence.chunks += 1;
      text += decoder.decode(value, { stream: true });
    }
    evidence.sample = text.slice(0, 60);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 150));
    evidence.abortedEarly = aborted;
    evidence.ok = evidence.chunks >= 3 && evidence.abortedEarly;
    if (evidence.chunks < 3) evidence.error = `\u53EA\u8BFB\u5230 ${evidence.chunks} \u4E2A\u5206\u7247\uFF0C\u7591\u4F3C\u88AB\u6574\u4F53\u7F13\u51B2`;
    else if (!evidence.abortedEarly) evidence.error = "abort \u4E4B\u540E\u670D\u52A1\u7AEF\u4ECD\u8BA4\u4E3A\u8FDE\u63A5\u5F00\u7740\uFF0CAbortSignal \u53EF\u80FD\u672A\u751F\u6548";
    return evidence;
  } catch (error) {
    evidence.ok = false;
    evidence.error = error?.message ?? String(error);
    return evidence;
  } finally {
    try {
      await reader?.cancel();
    } catch {
    }
    if (timer) clearInterval(timer);
    try {
      ;
      server?.closeAllConnections?.();
      server?.close();
    } catch {
    }
  }
}
async function runNetFetchDiagnostics(auth, mode = "probe") {
  const { fetch: netFetch, kind: transportKind } = currentEffectiveFetch();
  if (transportKind === "node") {
    return { ok: false, error: "\u5F53\u524D\u5B9E\u9645\u751F\u6548\u7684\u662F Node fetch\uFF0C\u672A\u542F\u7528 Chrome \u7F51\u7EDC\u6808" };
  }
  const transportLabel = transportKind === "browser" ? "\u6D4F\u89C8\u5668\u4EE3\u7406" : "electron.net.fetch";
  const transportBefore = fetchImplKind();
  const results = [];
  try {
    const response = await netFetch("https://tls.peet.ws/api/all");
    const payload = await response.json();
    results.push({
      step: `\u2460 ${transportLabel} \u2192 tls.peet.ws\uFF08\u6307\u7EB9\uFF09`,
      ok: true,
      status: response.status,
      ja3_hash: payload?.tls?.ja3_hash,
      ja4: payload?.tls?.ja4,
      http2_hash: payload?.http2?.akamai_fingerprint_hash,
      http_version: payload?.http_version,
      ua: String(payload?.user_agent ?? "").slice(0, 70)
    });
  } catch (error) {
    results.push({ step: `\u2460 ${transportLabel} \u2192 tls.peet.ws\uFF08\u6307\u7EB9\uFF09`, ok: false, error: error?.message ?? String(error) });
  }
  results.push({ step: `\u2461 ${transportLabel} \u672C\u5730\u5206\u5757\u6D41\uFF08response.body + AbortSignal\uFF09`, ...await probeStreamingSupport(netFetch) });
  if (!auth) {
    results.push({ step: `\u2462 ${transportLabel} \u2192 users/current\uFF08\u9274\u6743\uFF09`, ok: false, error: "\u5C1A\u672A\u767B\u5F55" });
  } else {
    try {
      const started = Date.now();
      const response = await netFetch("https://chat.deepseek.com/api/v0/users/current", {
        headers: buildDsHeaders(auth),
        signal: AbortSignal.timeout(2e4)
      });
      const text = await response.text();
      results.push({
        step: `\u2462 ${transportLabel} \u2192 users/current\uFF08\u9274\u6743\uFF09`,
        ok: response.ok,
        status: response.status,
        ms: Date.now() - started,
        body: text.slice(0, 240)
      });
    } catch (error) {
      results.push({ step: `\u2462 ${transportLabel} \u2192 users/current\uFF08\u9274\u6743\uFF09`, ok: false, error: error?.message ?? String(error) });
    }
  }
  if (mode === "stream" && auth) {
    setFetchImpl(netFetch);
    try {
      const started = Date.now();
      let chunks = 0;
      let sample = "";
      for await (const event of streamWebCompletion(auth, {
        // 参数形态必须与适配器真实调用一致：thinkingEnabled / modelType 是必填，
        // 缺了会发出残缺请求体（JSON.stringify 丢掉 undefined 字段）而被服务端拒。
        prompt: "\u53EA\u56DE\u590D\u4E24\u4E2A\u5B57\uFF1A\u597D\u7684",
        thinkingEnabled: false,
        modelType: "default",
        refFileIds: [],
        idleTimeoutMs: 3e4,
        onDeleteSession: (sessionId) => scheduleDeleteSession(auth, sessionId)
      })) {
        if (event?.kind === "text") {
          chunks += 1;
          sample += String(event.text ?? "");
          if (chunks >= 6) break;
        }
      }
      results.push({
        step: `\u2463 ${transportLabel} \u2192 DeepSeek \u6D41\u5F0F completion\uFF08\u7AEF\u5230\u7AEF\uFF09`,
        ok: true,
        text_chunks: chunks,
        ms: Date.now() - started,
        sample: sample.slice(0, 80)
      });
    } catch (error) {
      results.push({
        step: `\u2463 ${transportLabel} \u2192 DeepSeek \u6D41\u5F0F completion\uFF08\u7AEF\u5230\u7AEF\uFF09`,
        ok: false,
        code: error?.code,
        error: error?.message ?? String(error)
      });
    } finally {
      if (transportBefore === "injected") setFetchImpl(netFetch);
      else setFetchImpl();
      const now = fetchImplKind();
      results.push({
        step: "\u4F20\u8F93\u5C42\u5DF2\u8FD8\u539F",
        ok: now === transportBefore,
        was: transportBefore,
        now,
        ...now === transportBefore ? {} : { error: "\u8FD8\u539F\u540E\u4E0E\u8BCA\u65AD\u524D\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u91CD\u542F DSH" }
      });
    }
  }
  return { ok: true, mode, transportKind, transportBefore, transportAfter: fetchImplKind(), results };
}
function probeRequestPath() {
  return join10(resolveDshHome(), "web-login", "probe-request.json");
}
function consumeProbeRequest() {
  const file = probeRequestPath();
  try {
    if (!existsSync8(file)) return void 0;
    let mode = "probe";
    try {
      const raw = JSON.parse(readFileSync9(file, "utf8"));
      if (raw?.mode === "stream") mode = "stream";
    } catch {
    }
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    renameSync3(file, `${file}.done-${stamp}`);
    return mode;
  } catch {
    return void 0;
  }
}

// src/ledger.ts
import { appendFileSync as appendFileSync3, existsSync as existsSync9, mkdirSync as mkdirSync11, readdirSync as readdirSync2, readFileSync as readFileSync10, rmSync as rmSync4, statSync as statSync4 } from "node:fs";
import { join as join11 } from "node:path";
var LEDGER_KEEP_DAYS = 7;
var DAY_FILE_SOFT_LIMIT_BYTES = 2 * 1024 * 1024;
function ledgerDir() {
  return join11(webLoginDir(), "ledger");
}
function dayFile(at) {
  const date = new Date(at);
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return join11(ledgerDir(), `${stamp}.jsonl`);
}
function listDayFiles() {
  try {
    return readdirSync2(ledgerDir()).filter((name2) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name2)).sort();
  } catch {
    return [];
  }
}
function noteCall(entry) {
  try {
    const file = dayFile(entry.at);
    mkdirSync11(join11(file, ".."), { recursive: true });
    try {
      if (statSync4(file).size > DAY_FILE_SOFT_LIMIT_BYTES) return;
    } catch {
    }
    appendFileSync3(file, `${JSON.stringify(entry)}
`, "utf8");
  } catch {
  }
}
function pruneLedger(keepDays = LEDGER_KEEP_DAYS) {
  const cutoff = Date.now() - keepDays * 864e5;
  let removed = 0;
  for (const name2 of listDayFiles()) {
    const stamp = name2.replace(/\.jsonl$/, "");
    const at = Date.parse(`${stamp}T00:00:00`);
    if (!Number.isFinite(at) || at >= cutoff) continue;
    try {
      rmSync4(join11(ledgerDir(), name2), { force: true });
      removed += 1;
    } catch {
    }
  }
  return removed;
}
function readEntries(sinceMs) {
  const out = [];
  for (const name2 of listDayFiles()) {
    const stamp = name2.replace(/\.jsonl$/, "");
    const dayEnd = Date.parse(`${stamp}T23:59:59.999`);
    if (Number.isFinite(dayEnd) && dayEnd < sinceMs) continue;
    let text = "";
    try {
      text = readFileSync10(join11(ledgerDir(), name2), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (Number.isFinite(parsed?.at) && parsed.at >= sinceMs) out.push(parsed);
      } catch {
      }
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}
function failureBucket(entry) {
  if (entry.muted) return "\u8D26\u53F7\u88AB\u9650\u5236";
  if (entry.throttled) return "\u9650\u6D41\uFF08\u53D1\u592A\u9891\u7E41\uFF09";
  if (entry.code === "RATE_LIMIT") return "\u9650\u6D41\uFF08\u672A\u5206\u7C7B\uFF09";
  if (entry.code === "AUTH" || entry.code === "MISSING_CREDENTIAL") return "\u767B\u5F55\u6001\u95EE\u9898";
  if (entry.code === "TRANSPORT" || entry.code === "TIMEOUT") return "\u7F51\u7EDC / \u8D85\u65F6";
  if (entry.code === "CONTEXT_WINDOW_EXCEEDED") return "\u4E0A\u4E0B\u6587\u8D85\u9650";
  if (entry.code === "ABORTED") return "\u88AB\u53D6\u6D88";
  return entry.code ? `\u5176\u5B83\uFF08${entry.code}\uFF09` : "\u5176\u5B83";
}
function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}
function summarizeLedger(input = 24) {
  const hours = Number.isFinite(input) ? Math.min(72, Math.max(1, Math.floor(input))) : 24;
  const now = Date.now();
  const entries = readEntries(now - hours * 36e5).filter(
    (entry) => entry.at <= now && Number.isFinite(entry.ms) && entry.ms >= 0
  );
  const failures = {};
  const hourly = new Array(hours).fill(0);
  const hourlyFailed = new Array(hours).fill(0);
  let succeeded = 0;
  const groups = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const bucket = Math.floor((now - entry.at) / 36e5);
    if (bucket >= 0 && bucket < hours) {
      hourly[hours - 1 - bucket] += 1;
      if (!entry.ok) hourlyFailed[hours - 1 - bucket] += 1;
    }
    if (entry.ok) succeeded += 1;
    else {
      const key = failureBucket(entry);
      failures[key] = (failures[key] ?? 0) + 1;
    }
    if (entry.purpose === "chat") {
      const key = entry.accountId ?? "unknown";
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
  }
  const gaps = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.at - a.ms - (b.at - b.ms));
    let lastEnd;
    for (const entry of list) {
      if (lastEnd !== void 0) gaps.push(entry.at - entry.ms - lastEnd);
      lastEnd = Math.max(lastEnd ?? entry.at, entry.at);
    }
  }
  gaps.sort((a, b) => a - b);
  let files = 0;
  let bytes = 0;
  for (const name2 of listDayFiles()) {
    files += 1;
    try {
      bytes += statSync4(join11(ledgerDir(), name2)).size;
    } catch {
    }
  }
  return {
    hours,
    calls: entries.length,
    succeeded,
    failed: entries.length - succeeded,
    failures,
    hourlyFailed,
    gaps: gaps.length > 0 ? {
      samples: gaps.length,
      min: gaps[0],
      p50: percentile(gaps, 0.5),
      p90: percentile(gaps, 0.9),
      max: gaps[gaps.length - 1]
    } : null,
    hourly,
    footprint: { files, bytes },
    // F3（0.2.0）：按账号聚合（groups 本来就为 gap 计算而建，顺手返回 ——
    // 多账号场景"哪个号在烧钱/在被限"一目了然）。
    byAccount: Array.from(groups.entries()).map(([accountId, list]) => ({
      accountId,
      calls: list.length,
      succeeded: list.filter((entry) => entry.ok).length,
      failed: list.filter((entry) => !entry.ok).length
    }))
  };
}

// src/usage.ts
import { appendFileSync as appendFileSync4, existsSync as existsSync10, mkdirSync as mkdirSync12, readdirSync as readdirSync3, readFileSync as readFileSync11, rmSync as rmSync5, statSync as statSync5 } from "node:fs";
import { join as join12 } from "node:path";
var USAGE_KEEP_DAYS = 90;
var DAY_FILE_SOFT_LIMIT_BYTES2 = 2 * 1024 * 1024;
var USAGE_MAX_DAYS = 90;
function usageEntryFrom(info, at) {
  const safe = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  return {
    at,
    ...info.accountId ? { accountId: info.accountId } : {},
    purpose: info.purpose,
    ...info.model ? { model: info.model } : {},
    ok: info.ok,
    in: safe(info.tokens?.inputTokens),
    out: safe(info.tokens?.outputTokens),
    ...Number.isFinite(info.tokens?.reasoningTokens) ? { reasoning: safe(info.tokens?.reasoningTokens) } : {},
    // ⚠️ 只有真的拿到服务端总量才标 true。缺这一步，界面会把估算值说成服务端口径 ——
    // "看起来精确的错数"比不显示更糟。
    ...info.tokens ? { server: info.tokens.serverTotal === true } : {}
  };
}
function usageDir() {
  return join12(webLoginDir(), "usage");
}
function localDateKey(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dayFile2(at) {
  return join12(usageDir(), `${localDateKey(at)}.jsonl`);
}
function listDayFiles2() {
  try {
    return readdirSync3(usageDir()).filter((name2) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name2)).sort();
  } catch {
    return [];
  }
}
function noteUsage(entry) {
  try {
    const file = dayFile2(entry.at);
    mkdirSync12(usageDir(), { recursive: true });
    try {
      if (statSync5(file).size > DAY_FILE_SOFT_LIMIT_BYTES2) return;
    } catch {
    }
    appendFileSync4(file, `${JSON.stringify(entry)}
`, "utf8");
  } catch {
  }
}
function pruneUsage(keepDays = USAGE_KEEP_DAYS) {
  const cutoff = Date.now() - keepDays * 864e5;
  let removed = 0;
  for (const name2 of listDayFiles2()) {
    const stamp = name2.replace(/\.jsonl$/, "");
    const at = Date.parse(`${stamp}T00:00:00`);
    if (!Number.isFinite(at) || at >= cutoff) continue;
    try {
      rmSync5(join12(usageDir(), name2), { force: true });
      removed += 1;
    } catch {
    }
  }
  return removed;
}
function clampUsageDays(value, fallback = 30) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(USAGE_MAX_DAYS, Math.floor(n)));
}
function readEntries2(sinceMs) {
  const out = [];
  for (const name2 of listDayFiles2()) {
    const stamp = name2.replace(/\.jsonl$/, "");
    const dayEnd = Date.parse(`${stamp}T23:59:59.999`);
    if (Number.isFinite(dayEnd) && dayEnd < sinceMs) continue;
    let text = "";
    try {
      text = readFileSync11(join12(usageDir(), name2), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (Number.isFinite(parsed?.at) && parsed.at >= sinceMs) out.push(parsed);
      } catch {
      }
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}
function emptyDay(date) {
  return { date, calls: 0, ok: 0, in: 0, out: 0, serverCalls: 0 };
}
function bumpGroup(map, key, entry) {
  const item = map.get(key) ?? { key, calls: 0, in: 0, out: 0 };
  item.calls += 1;
  item.in += entry.in;
  item.out += entry.out;
  map.set(key, item);
}
function sortedGroups(map) {
  return Array.from(map.values()).sort((a, b) => b.in + b.out - (a.in + a.out) || b.calls - a.calls);
}
function aggregateUsage(entries, options = {}) {
  const now = options.now ?? Date.now();
  const days = clampUsageDays(options.days ?? 30);
  const DAY = 864e5;
  const earliest = entries.reduce((min, item) => {
    const key = localDateKey(item.at);
    return min === null || key < min ? key : min;
  }, null);
  const axisStart = days > 0 ? localDateKey(now - (days - 1) * DAY) : earliest ?? localDateKey(now);
  const axisEnd = localDateKey(now);
  const byModel = /* @__PURE__ */ new Map();
  const byAccount = /* @__PURE__ */ new Map();
  const byPurpose = /* @__PURE__ */ new Map();
  const byDate = /* @__PURE__ */ new Map();
  let calls = 0;
  let ok = 0;
  let inSum = 0;
  let outSum = 0;
  let serverCalls = 0;
  let from = null;
  let to = null;
  for (const entry of entries) {
    const date = localDateKey(entry.at);
    if (date < axisStart || date > axisEnd) continue;
    calls += 1;
    if (entry.ok) ok += 1;
    inSum += entry.in;
    outSum += entry.out;
    if (entry.server) serverCalls += 1;
    if (from === null || date < from) from = date;
    if (to === null || date > to) to = date;
    const day = byDate.get(date) ?? emptyDay(date);
    day.calls += 1;
    if (entry.ok) day.ok += 1;
    day.in += entry.in;
    day.out += entry.out;
    if (entry.server) day.serverCalls += 1;
    byDate.set(date, day);
    bumpGroup(byModel, entry.model || "(\u672A\u6807\u6CE8)", entry);
    bumpGroup(byAccount, entry.accountId ?? "(\u672A\u77E5\u8D26\u53F7)", entry);
    bumpGroup(byPurpose, entry.purpose, entry);
  }
  const series = [];
  const startNoon = Date.parse(`${axisStart}T12:00:00`);
  const endNoon = Date.parse(`${axisEnd}T12:00:00`);
  const steps = Math.max(0, Math.min(USAGE_MAX_DAYS + 1, Math.round((endNoon - startNoon) / DAY)));
  for (let i = 0; i <= steps; i++) {
    const key = localDateKey(startNoon + i * DAY);
    series.push(byDate.get(key) ?? emptyDay(key));
  }
  let files = 0;
  let bytes = 0;
  for (const name2 of listDayFiles2()) {
    files += 1;
    try {
      bytes += statSync5(join12(usageDir(), name2)).size;
    } catch {
    }
  }
  return {
    days,
    totals: {
      calls,
      ok,
      failed: calls - ok,
      in: inSum,
      out: outSum,
      total: inSum + outSum,
      serverCalls,
      avgPerCall: calls > 0 ? Math.round((inSum + outSum) / calls) : 0
    },
    series,
    byModel: sortedGroups(byModel),
    byAccount: sortedGroups(byAccount),
    byPurpose: sortedGroups(byPurpose),
    coverage: { from, to, files, bytes }
  };
}
function summarizeUsage(input = 30) {
  const days = clampUsageDays(input);
  const now = Date.now();
  const sinceMs = days > 0 ? new Date(now - (days - 1) * 864e5).setHours(0, 0, 0, 0) : 0;
  return aggregateUsage(readEntries2(sinceMs), { days, now });
}
function usageExists() {
  try {
    return existsSync10(usageDir());
  } catch {
    return false;
  }
}

// src/update-check.ts
var RELEASE_REPO = "cv-superding/dsh-deepseek-web-login";
function parseVersion(input) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(input ?? "").trim());
  if (!match) return void 0;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function isNewer(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}
async function checkForUpdate(current, fetchImpl) {
  const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
  const base = { ok: false, current, hasUpdate: false, checkedAt };
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `${RELEASE_REPO}-plugin` },
      // 8 秒：国内连 GitHub 往往卡住而不是立刻失败，等太久会让界面以为点了没反应
      signal: AbortSignal.timeout(8e3)
    });
    if (!response.ok) {
      return { ...base, error: `GitHub \u8FD4\u56DE HTTP ${response.status}${response.status === 403 ? "\uFF08\u53EF\u80FD\u662F\u63A5\u53E3\u9650\u6D41\uFF0C\u7A0D\u540E\u518D\u8BD5\uFF09" : ""}` };
    }
    const payload = await response.json();
    const tag = String(payload?.tag_name ?? "");
    const latest = tag.replace(/^v/, "");
    if (!latest) return { ...base, error: "Release \u6570\u636E\u91CC\u6CA1\u6709\u7248\u672C\u53F7" };
    return {
      ok: true,
      current,
      latest,
      hasUpdate: isNewer(latest, current),
      ...typeof payload?.html_url === "string" ? { url: payload.html_url } : {},
      ...typeof payload?.published_at === "string" ? { publishedAt: payload.published_at } : {},
      ...typeof payload?.body === "string" ? { notes: payload.body.split("\n").slice(0, 6).join("\n") } : {},
      checkedAt
    };
  } catch (error) {
    const message = error?.name === "TimeoutError" || /timeout|aborted/i.test(String(error?.message)) ? "\u8FDE\u63A5 GitHub \u8D85\u65F6\uFF08\u56FD\u5185\u5E38\u89C1\uFF1B\u68AF\u5B50\u5F00\u7740\u7684\u8BDD\u5B83\u4F1A\u8DDF\u968F\u7CFB\u7EDF\u4EE3\u7406\uFF09" : `\u8FDE\u63A5 GitHub \u5931\u8D25\uFF1A${error?.message ?? error}`;
    return { ...base, error: message };
  }
}

// src/version.ts
import { readFileSync as readFileSync12 } from "node:fs";
var FALLBACK_VERSION = "0.7.5";
var cached;
function pluginVersion() {
  if (cached) return cached;
  try {
    const raw = readFileSync12(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === "string" && parsed.version) {
      cached = parsed.version;
      return cached;
    }
  } catch {
  }
  cached = FALLBACK_VERSION;
  return cached;
}

// src/session-journal.ts
import { existsSync as existsSync11, mkdirSync as mkdirSync13, readFileSync as readFileSync13, renameSync as renameSync4, unlinkSync, writeFileSync as writeFileSync7 } from "node:fs";
import { dirname as dirname2, join as join13 } from "node:path";
var JOURNAL_VERSION = 1;
function sessionJournalPath() {
  return join13(webLoginDir(), "sessions-in-use.json");
}
function sanitizeEntry(raw) {
  const accountId = typeof raw?.accountId === "string" ? raw.accountId.trim() : "";
  const sessionId = typeof raw?.sessionId === "string" ? raw.sessionId.trim() : "";
  if (!accountId || !sessionId) return void 0;
  return {
    accountId,
    sessionId,
    pid: Number.isFinite(raw?.pid) ? Math.floor(raw.pid) : 0,
    at: Number.isFinite(raw?.at) ? Math.floor(raw.at) : 0,
    state: raw?.state === "queued" ? "queued" : "slot"
  };
}
function readJournal(file = sessionJournalPath()) {
  try {
    if (!existsSync11(file)) return [];
    const parsed = JSON.parse(readFileSync13(file, "utf8"));
    const raw = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      const entry = sanitizeEntry(item);
      if (entry) out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}
function writeJournal(entries, file = sessionJournalPath()) {
  const dir = dirname2(file);
  try {
    if (!existsSync11(dir)) mkdirSync13(dir, { recursive: true });
  } catch {
  }
  const payload = `${JSON.stringify({ version: JOURNAL_VERSION, entries }, null, 2)}
`;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync7(tmp, payload, { encoding: "utf8", mode: 384 });
    try {
      renameSync4(tmp, file);
    } catch {
      writeFileSync7(file, payload, { encoding: "utf8", mode: 384 });
      try {
        unlinkSync(tmp);
      } catch {
      }
    }
  } catch {
  }
}
function upsertJournalEntry(entry, file = sessionJournalPath()) {
  const next = {
    accountId: entry.accountId,
    sessionId: entry.sessionId,
    pid: entry.pid ?? process.pid,
    at: entry.at ?? Date.now(),
    state: entry.state ?? "slot"
  };
  const entries = readJournal(file).filter((item) => item.sessionId !== next.sessionId);
  entries.push(next);
  writeJournal(entries, file);
}
function removeJournalEntry(sessionId, file = sessionJournalPath()) {
  const entries = readJournal(file);
  const kept = entries.filter((item) => item.sessionId !== sessionId);
  if (kept.length === entries.length) return;
  writeJournal(kept, file);
}
function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function planStartupSweep(entries, options) {
  const isAlive = options.isAlive ?? isProcessAlive;
  const plan = { toDelete: [], dropped: [], kept: [] };
  for (const entry of entries) {
    if (entry.pid === options.ownPid || isAlive(entry.pid)) {
      plan.kept.push(entry);
      continue;
    }
    if (!options.deleteEnabled || options.mode === "keep") {
      plan.kept.push(entry);
      continue;
    }
    if (!options.accountExists(entry.accountId)) {
      plan.dropped.push(entry);
      continue;
    }
    plan.toDelete.push(entry);
  }
  return plan;
}
function runStartupSweep(options) {
  const file = options.file ?? sessionJournalPath();
  const entries = readJournal(file);
  if (entries.length === 0) return { scheduled: 0, dropped: 0, kept: 0 };
  const plan = planStartupSweep(entries, options);
  let scheduled = 0;
  for (const entry of plan.toDelete) {
    try {
      options.onSweep(entry);
      scheduled += 1;
    } catch {
      plan.kept.push(entry);
    }
  }
  if (plan.dropped.length > 0) writeJournal([...plan.kept, ...plan.toDelete], file);
  if (scheduled > 0) {
    options.log?.(`deepseek-web: \u4E0A\u6B21\u9000\u51FA\u9057\u7559\u4E86 ${scheduled} \u4E2A\u4E34\u65F6\u4F1A\u8BDD\uFF0C\u5DF2\u4EA4\u7ED9\u6E05\u7406\u5668\u8865\u5220`);
  }
  if (plan.dropped.length > 0) {
    options.log?.(
      `deepseek-web: ${plan.dropped.length} \u4E2A\u9057\u7559\u4F1A\u8BDD\u7684\u8D26\u53F7\u5DF2\u4E0D\u5728\u8D26\u53F7\u5E93\u91CC\uFF0C\u65E0\u6CD5\u56DE\u6536\uFF08\u5DF2\u4ECE\u8BB0\u5F55\u79FB\u9664\uFF09`
    );
  }
  return { scheduled, dropped: plan.dropped.length, kept: plan.kept.length };
}

// src/account-groups.ts
import { randomBytes } from "node:crypto";
import { existsSync as existsSync12, mkdirSync as mkdirSync14, readFileSync as readFileSync14, renameSync as renameSync5, rmSync as rmSync6, writeFileSync as writeFileSync8 } from "node:fs";
import { join as join14 } from "node:path";
var UNGROUPED_KEY = "__ungrouped__";
var UNGROUPED_NAME = "\u672A\u5206\u7EC4";
var MAX_GROUP_NAME = 20;
var MAX_GROUPS = 12;
function groupsFilePath() {
  return join14(webLoginDir(), "groups.json");
}
function normalizeGroupName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME);
}
function normalizeGroupList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name2 = normalizeGroupName(item.name);
    if (!id || !name2 || seen.has(id)) continue;
    const orderRaw = item.order;
    const order = Number.isFinite(orderRaw) ? Number(orderRaw) : out.length;
    seen.add(id);
    out.push({ id, name: name2, order });
  }
  out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return out.slice(0, MAX_GROUPS).map((group, index) => ({ ...group, order: index }));
}
function readGroups() {
  try {
    const file = groupsFilePath();
    if (!existsSync12(file)) return [];
    return normalizeGroupList(JSON.parse(readFileSync14(file, "utf8")));
  } catch {
    return [];
  }
}
function writeGroups(list) {
  const file = groupsFilePath();
  mkdirSync14(join14(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync8(tmp, JSON.stringify(normalizeGroupList(list), null, 2), { encoding: "utf8", mode: 384 });
  try {
    renameSync5(tmp, file);
  } catch (error) {
    try {
      rmSync6(tmp, { force: true });
    } catch {
    }
    throw error;
  }
}
function newGroupId(taken) {
  const used = new Set(taken);
  for (let i = 0; i < 32; i += 1) {
    const id = `g_${randomBytes(4).toString("hex")}`;
    if (!used.has(id)) return id;
  }
  return `g_${randomBytes(6).toString("hex")}`;
}
function createGroup(list, rawName) {
  const current = normalizeGroupList(list);
  const name2 = normalizeGroupName(rawName);
  if (!name2) return { list: current, error: "\u7EC4\u540D\u4E0D\u80FD\u4E3A\u7A7A" };
  if (current.length >= MAX_GROUPS) return { list: current, error: `\u6700\u591A ${MAX_GROUPS} \u4E2A\u7EC4` };
  if (current.some((group2) => group2.name === name2)) return { list: current, error: `\u5DF2\u7ECF\u6709\u4E00\u4E2A\u53EB\u300C${name2}\u300D\u7684\u7EC4\u4E86` };
  const group = { id: newGroupId(current.map((item) => item.id)), name: name2, order: current.length };
  return { list: [...current, group], group };
}
function renameGroup(list, id, rawName) {
  const current = normalizeGroupList(list);
  const name2 = normalizeGroupName(rawName);
  if (!name2) return { list: current, error: "\u7EC4\u540D\u4E0D\u80FD\u4E3A\u7A7A" };
  if (!current.some((group) => group.id === id)) return { list: current, error: "\u7EC4\u4E0D\u5B58\u5728" };
  if (current.some((group) => group.id !== id && group.name === name2)) {
    return { list: current, error: `\u5DF2\u7ECF\u6709\u4E00\u4E2A\u53EB\u300C${name2}\u300D\u7684\u7EC4\u4E86` };
  }
  return { list: current.map((group) => group.id === id ? { ...group, name: name2 } : group) };
}
function removeGroup(list, id) {
  const current = normalizeGroupList(list);
  const kept = current.filter((group) => group.id !== id);
  return kept.map((group, index) => ({ ...group, order: index }));
}
function partitionByGroup(accounts, groups, activeId) {
  const normalized = normalizeGroupList(groups);
  const known = new Set(normalized.map((group) => group.id));
  const buckets = /* @__PURE__ */ new Map();
  const ungrouped = [];
  for (const account of accounts) {
    const gid = account.groupId && known.has(account.groupId) ? account.groupId : "";
    if (!gid) {
      ungrouped.push(account);
      continue;
    }
    const bucket = buckets.get(gid);
    if (bucket) bucket.push(account);
    else buckets.set(gid, [account]);
  }
  const activeGroupId = accounts.find((account) => account.id === activeId)?.groupId ?? "";
  const pinned = activeGroupId && known.has(activeGroupId) ? activeGroupId : "";
  const sections = [];
  const ordered = pinned ? [...normalized.filter((group) => group.id === pinned), ...normalized.filter((group) => group.id !== pinned)] : normalized;
  for (const group of ordered) {
    sections.push({ key: group.id, name: group.name, groupId: group.id, accounts: buckets.get(group.id) ?? [] });
  }
  if (ungrouped.length) {
    sections.push({ key: UNGROUPED_KEY, name: UNGROUPED_NAME, groupId: null, accounts: ungrouped });
  }
  return sections;
}

// src/index.ts
var name = "dsh-deepseek-web-login";
var inject = ["llm", "webServer"];
var IMPORT_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
var API_PREFIX = "/deepseek-web-login/api";
function normalizeLogger(logger) {
  if (!logger) return {};
  return {
    info: typeof logger.info === "function" ? (message) => logger.info(message) : void 0,
    warn: typeof logger.warn === "function" ? (message) => logger.warn(message) : void 0,
    debug: typeof logger.debug === "function" ? (message) => logger.debug(message) : void 0
  };
}
var BodyError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function readJsonBody(req, limitBytes = 256 * 1024) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const cleanup2 = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup2();
      if (error) {
        try {
          req.resume?.();
        } catch {
        }
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > limitBytes) {
        done(new BodyError(413, `\u8BF7\u6C42\u4F53\u8FC7\u5927\uFF08\u4E0A\u9650 ${Math.floor(limitBytes / 1024)} KiB\uFF09`));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (chunks.length === 0) {
        done(void 0, {});
        return;
      }
      try {
        done(void 0, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        done(new BodyError(400, "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON"));
      }
    };
    const onError = () => done(new BodyError(400, "\u8BFB\u53D6\u8BF7\u6C42\u4F53\u5931\u8D25"));
    const onAborted = () => done(new BodyError(400, "\u8BF7\u6C42\u5DF2\u4E2D\u6B62"));
    const onClose = () => {
      if (!req.complete) onAborted();
    };
    const timer = setTimeout(() => done(new BodyError(408, "\u8BFB\u53D6\u8BF7\u6C42\u4F53\u8D85\u65F6")), 1e4);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
  });
}
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}
var accountsRefreshInFlight = false;
function apply(ctx, config = {}) {
  const logger = normalizeLogger(ctx.logger);
  try {
    const electron = createRequire3(import.meta.url)("electron");
    const net = electron?.net;
    const keys = electron && typeof electron === "object" ? Object.keys(electron).sort() : [];
    logger.info?.(
      `deepseek-web: [\u80FD\u529B\u63A2\u6D4B] process.type=${process.type ?? "-"} electron=${process.versions?.electron ?? "-"} | electron:${typeof electron} keys=[${keys.join(",")}] | net=${typeof net} net.fetch=${typeof net?.fetch} net.request=${typeof net?.request} | shell=${typeof electron?.shell} session=${typeof electron?.session} BrowserWindow=${typeof electron?.BrowserWindow}`
    );
  } catch (error) {
    logger.info?.(`deepseek-web: [\u80FD\u529B\u63A2\u6D4B] require('electron') \u5931\u8D25\uFF1A${error?.message ?? error}`);
  }
  const startupProbe = consumeProbeRequest();
  if (startupProbe) {
    void (async () => {
      try {
        const result = await runNetFetchDiagnostics(readAuth(), startupProbe);
        logger.info?.(`deepseek-web: [net-fetch \u63A2\u6D4B] ${JSON.stringify(result)}`);
      } catch (error) {
        logger.info?.(`deepseek-web: [net-fetch \u63A2\u6D4B] \u5931\u8D25\uFF1A${error?.message ?? error}`);
      }
    })();
  }
  const savedGate = readGateSettings();
  const cleanupMode = savedGate?.sessionCleanup ?? config.sessionCleanup ?? DEFAULT_SESSION_CLEANUP.mode;
  const cleanupBatchRange = savedGate?.cleanupBatch ?? DEFAULT_CLEANUP_BATCH;
  const cleanupDelayRange = savedGate?.cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS;
  const cleanupGapRange = savedGate?.cleanupGapMs ?? DEFAULT_CLEANUP_GAP_MS;
  const gate = createRequestGate({
    allowConcurrent: savedGate?.allowConcurrent ?? config.allowConcurrent === true,
    // ⚠️ min / max 必须**成对**传：createRequestGate 在只收到 `minIntervalMs` 时，
    // 会把 `maxIntervalMs` 兜底成 min（见 gate.ts），也就是**随机区间退化成固定间隔**。
    // 2026-09-12 实测：设置页保存的 2000~4000，重启 DSH 后就变成固定 2000ms；
    // 而固定间隔恰恰是最典型的机器特征，用户完全不知情（日志里只会显示"区间 2000~2000"）。
    minIntervalMs: savedGate?.minRequestIntervalMs ?? config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    maxIntervalMs: savedGate?.maxRequestIntervalMs ?? config.maxRequestIntervalMs ?? DEFAULT_MAX_REQUEST_INTERVAL_MS,
    // 长任务保护：连续 N 次请求后强制长休一次（0 = 关闭）。
    longRunThreshold: savedGate?.longRunThreshold ?? DEFAULT_LONG_RUN_THRESHOLD,
    maxPromptChars: savedGate?.maxPromptChars ?? config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
    maxRefImages: savedGate?.maxRefImages ?? config.maxRefImages ?? DEFAULT_MAX_REF_IMAGES,
    contextWindow: savedGate?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    autoSwitchMinutes: savedGate?.autoSwitchMinutes ?? DEFAULT_AUTO_SWITCH_MINUTES,
    // 工具调用是否允批量（**缺省＝串行**）。adapter 每轮序列化 prompt 时现读 ⇒ 改完即时生效。
    serialToolCalls: savedGate?.serialToolCalls !== false,
    // 到期前自动重登（0.6.14）：**缺省关闭**（`=== true` 而不是 `!== false`）——
    // 打开它会每约 2 小时静默起一次无头浏览器，这种事必须是用户明确点开的。
    autoRelogin: savedGate?.autoRelogin === true,
    // 重开链是否换新会话（0.6.22）：**缺省关闭**（`=== true`）—— 见 GateSettings 的说明。
    freshSessionOnRestart: savedGate?.freshSessionOnRestart === true,
    longRunBreakMs: savedGate?.longRunBreakMs,
    // ⚠️ 会话清理这几个字段必须**一起传**（2026-09-14 修）：设置页保存时写的是
    // `gate.settings()` 的返回值 —— 没存进闸门的字段会被**静默抹掉**，
    // 于是用户只调了下请求间隔，清理设置（模式 + 三个区间）就在下次重启时回到内置默认。
    sessionCleanup: cleanupMode,
    cleanupBatch: cleanupBatchRange,
    cleanupDelayMs: cleanupDelayRange,
    cleanupGapMs: cleanupGapRange,
    logger
  });
  applyFreshSessionOnRestart(gate.settings().freshSessionOnRestart === true);
  const migratedAccount = migrateLegacyAuthIfNeeded();
  if (migratedAccount) {
    logger.info?.(`deepseek-web: \u5DF2\u628A\u65E7\u7684\u5355\u8D26\u53F7\u51ED\u8BC1\u8FC1\u79FB\u8FDB\u8D26\u53F7\u5E93\uFF08${migratedAccount.id}\uFF09`);
  } else {
    const migrationError = legacyMigrationError();
    if (migrationError) logger.warn?.(`deepseek-web: ${migrationError}`);
  }
  let transportState = applyTransport(
    readTransportSetting() ?? (config.transport === "node" ? "node" : DEFAULT_TRANSPORT)
  );
  logger.info?.(
    `deepseek-web: \u4F20\u8F93\u5C42=${transportState.effective}` + (transportState.degraded ? "\uFF08\u914D\u7F6E\u8981\u6C42 Chrome\uFF0C\u4F46\u672C\u73AF\u5883\u6CA1\u6709 electron.net.fetch \u4E5F\u6CA1\u6709\u7CFB\u7EDF\u6D4F\u89C8\u5668\uFF0C\u5DF2\u964D\u7EA7\u4E3A Node\uFF09" : transportState.viaBrowserProxy ? "\uFF08\u901A\u8FC7\u7CFB\u7EDF Edge/Chrome \u8FDB\u7A0B\u4EE3\u7406\uFF09" : "")
  );
  let lastAutoSwitchAt = Date.now();
  let lastSwitchedAt = 0;
  let lastAutoSwitch;
  let autoSwitching = false;
  const autoSwitchSkip = /* @__PURE__ */ new Set();
  const throttleAt = /* @__PURE__ */ new Map();
  async function maybeAutoSwitch() {
    if (autoSwitching) return;
    const minutes = gate.settings().autoSwitchMinutes ?? DEFAULT_AUTO_SWITCH_MINUTES;
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const accounts = listAccounts().filter((account) => !autoSwitchSkip.has(account.id));
    const decision = decideAutoSwitch({
      minutes,
      lastSwitchAt: lastAutoSwitchAt,
      now: Date.now(),
      accounts,
      currentId: activeAccountId(),
      // 内存里的限流时刻：既决定"当前账号该不该提前切走"，也用来排除同样刚被限流的号。
      throttledAt: throttleAt,
      // 限流那条的冷却用"上次**真的换过号**"的时刻 —— 不能传 lastAutoSwitchAt（它在启动时
      // 就等于启动时刻，会让每次重启后的一段时间里"限流也不换号"）。见 lastSwitchedAt 的注释。
      lastSwitchedAt
    });
    if (decision.action !== "switch") return;
    autoSwitching = true;
    try {
      const target = readAccount(decision.nextId);
      if (!target) return;
      const probed = await probeOnce(target, {
        info: (message) => logger.info?.(message),
        warn: (message) => logger.warn?.(message)
      });
      if (probed && !probed.ok) {
        autoSwitchSkip.add(decision.nextId);
        lastAutoSwitchAt = Date.now();
        logger.warn?.(
          `deepseek-web: \u81EA\u52A8\u5207\u53F7\u8DF3\u8FC7 ${decision.nextId}\uFF08\u63A2\u6D3B\u672A\u901A\u8FC7\uFF1A${probed.error ?? "\u672A\u77E5\u539F\u56E0"}\uFF09`
        );
        return;
      }
      const fromId = activeAccountId();
      if (!setActiveAccount(decision.nextId)) return;
      lastAutoSwitchAt = Date.now();
      lastSwitchedAt = Date.now();
      const fromRecord = fromId ? readAccount(fromId) : void 0;
      lastAutoSwitch = {
        at: lastAutoSwitchAt,
        from: fromRecord ? accountTitle(fromRecord, maskIdentifier) : "\uFF08\u672A\u77E5\uFF09",
        to: accountTitle(target, maskIdentifier),
        reason: decision.reason
      };
      logger.info?.(
        `deepseek-web: \u5DF2\u81EA\u52A8\u5207\u6362\u8D26\u53F7\u5230 ${decision.nextId}\uFF08\u6BCF ${minutes} \u5206\u949F\u8F6E\u6362` + (decision.reason === "current-unusable" ? "\uFF1B\u539F\u8D26\u53F7\u4E0D\u53EF\u7528\uFF0C\u63D0\u524D\u5207\u8D70" : decision.reason === "recently-throttled" ? "\uFF1B\u539F\u8D26\u53F7\u521A\u88AB\u9650\u6D41\uFF0C\u63D0\u524D\u5207\u8D70" : "") + "\uFF09\u2014\u2014 \u6362\u53F7\u4F1A\u8BA9\u6295\u5582\u94FE\u65AD\u6389\uFF0C\u4E0B\u4E00\u8F6E\u4F1A\u5168\u91CF\u91CD\u53D1"
      );
    } catch (error) {
      lastAutoSwitchAt = Date.now();
      logger.warn?.(`deepseek-web: \u81EA\u52A8\u5207\u6362\u8D26\u53F7\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u672C\u6B21\u8BF7\u6C42\uFF09\uFF1A${error?.message ?? error}`);
    } finally {
      autoSwitching = false;
    }
  }
  const canFailover = (kind) => {
    const minutes = gate.settings().autoSwitchMinutes ?? DEFAULT_AUTO_SWITCH_MINUTES;
    const now = Date.now();
    if (kind === "throttled" && !isThrottleSwitchAllowed({ throttledAt: now, lastSwitchAt: lastSwitchedAt, now })) {
      return false;
    }
    const candidate = hasFailoverCandidate({
      minutes,
      switching: autoSwitching,
      accounts: listAccounts().filter((account) => !autoSwitchSkip.has(account.id)),
      currentId: activeAccountId(),
      now,
      excludeIds: freshThrottledIds(throttleAt, now)
    });
    if (!candidate) {
      logger.info?.(
        `deepseek-web: \u672C\u6B21 ${kind ?? "\u672A\u77E5"} \u5931\u8D25\u65E0\u6CD5\u6362\u53F7\uFF08\u81EA\u52A8\u6362\u53F7=${Number.isFinite(minutes) && minutes > 0 ? `${minutes} \u5206\u949F` : "\u5173\u95ED"}${autoSwitching ? "\uFF0C\u6B63\u5728\u5207\u6362\u4E2D" : ""}\uFF09\u2014\u2014 \u4E0D\u91CD\u8BD5\uFF0C\u4EA4\u7ED9\u7528\u6237\u5904\u7406`
      );
    }
    return candidate;
  };
  let contextMode = applyContextMode(
    readContextModeSetting() ?? (config.contextMode === "chained" ? "chained" : DEFAULT_CONTEXT_MODE)
  );
  logger.info?.(
    `deepseek-web: \u4E0A\u4E0B\u6587\u6295\u5582=${contextMode}` + (contextMode === "chained" ? "\uFF08\u53EA\u53D1\u589E\u91CF + parent \u6307\u5411\u4E0A\u4E00\u6761\u56DE\u7B54\uFF09" : "\uFF08\u6BCF\u8F6E\u91CD\u53D1\u5168\u91CF prompt\uFF09")
  );
  const adapterConfig = {
    maxPromptChars: savedGate?.maxPromptChars ?? config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
    maxRefImages: savedGate?.maxRefImages ?? config.maxRefImages ?? DEFAULT_MAX_REF_IMAGES,
    contextWindow: savedGate?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    idleTimeoutMs: config.idleTimeoutMs ?? 12e4,
    deleteWebSessions: config.deleteWebSessions !== false,
    // 会话复用：默认 20 轮共用一个网页端会话。0 = 关闭（回到每请求一个会话）
    sessionReuseTurns: config.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS,
    autoContinue: config.autoContinue !== false,
    maxContinuations: config.maxContinuations ?? 2,
    // 防风控：默认串行 + 每次调用之间至少 3 秒（见 README「配置」）。
    // 取闸门的实际生效值（可能来自设置页保存的 gate.json）。
    allowConcurrent: gate.settings().allowConcurrent,
    minRequestIntervalMs: gate.settings().minRequestIntervalMs,
    // 同上：必须与 min 成对传，否则这里也退化成固定间隔
    maxRequestIntervalMs: gate.settings().maxRequestIntervalMs,
    logger
  };
  const sessionCleaner = createSessionCleaner({
    // 链式投喂下**只手动清理**（0.6.11）：会话是链的载体，自动删就等于替用户清上下文。
    // 全量模式保持原来的自动清理（每轮都是根消息，会话只是壳）。
    manualOnly: contextMode === "chained",
    policy: {
      mode: cleanupMode,
      delayMs: cleanupMode === "immediate" ? 1500 : config.sessionCleanupDelayMs ?? DEFAULT_SESSION_CLEANUP.delayMs,
      batchSize: cleanupMode === "immediate" ? 1 : config.sessionCleanupBatchSize ?? DEFAULT_SESSION_CLEANUP.batchSize,
      ...cleanupMode === "immediate" ? {} : { batchRange: cleanupBatchRange, delayRange: cleanupDelayRange, gapRange: cleanupGapRange }
    },
    logger
  });
  async function commitBrowserAuth(auth, log) {
    const check = await validateAuth(auth).catch(() => void 0);
    const verified = !!check?.ok;
    const commitAuth = verified ? withVerifiedIdentity(auth, check?.user) : auth;
    const commit = commitCapturedAuth(commitAuth);
    if (verified && check?.user && commit.recordId) {
      const record = listAccounts().find((item) => item.id === commit.recordId);
      const verifiedId = typeof check.user.id === "string" ? String(check.user.id) : "";
      updateAccount(commit.recordId, {
        user: { ...record?.user ?? {}, ...check.user },
        ...verifiedId ? { serverId: verifiedId } : {}
      });
    }
    if (!verified) log.warn?.(`deepseek-web: \u6355\u83B7\u5230\u7684\u51ED\u8BC1\u672A\u901A\u8FC7\u6821\u9A8C\uFF08${check?.error ?? "\u672A\u77E5"}\uFF09`);
    return {
      ...commit.recordId ? { recordId: commit.recordId } : {},
      ...check?.user?.display ? { display: check.user.display } : {},
      verified
    };
  }
  async function autoReloginOne(targetId, log) {
    const target = readAccount(targetId);
    if (!target) return { ok: false, message: "\u8D26\u53F7\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u79FB\u9664\uFF09", error: "missing-account" };
    const entry = credentialForDisplay(target.user?.display);
    if (!entry) {
      return {
        ok: false,
        message: `\u6CA1\u6709\u8FD9\u6761\u8D26\u53F7\u7684\u90AE\u7BB1\u5BC6\u7801\u51ED\u8BC1\uFF08${maskIdentifier(target.user?.display ?? target.id)}\uFF09\u2014\u2014\u8BF7\u7528\u300C\u767B\u5F55\u65B0\u8D26\u53F7\u300D\u8865\u4E00\u6B21\uFF0C\u6216\u628A\u5BC6\u7801\u52A0\u8FDB\u51ED\u8BC1\u5E93`,
        error: "no-credential"
      };
    }
    log.info?.(`deepseek-web: \u81EA\u52A8\u91CD\u767B ${maskIdentifier(target.user?.display ?? target.id)} \u2026`);
    beginRelogin(targetId);
    try {
      const outcome = await browserLogin({
        credentials: entry,
        timeoutMs: 12e4,
        onProgress: (message) => log.info?.(`deepseek-web auto-relogin: ${message}`)
      });
      if (!outcome.ok || !outcome.auth) {
        endRelogin();
        return {
          ok: false,
          message: outcome.message,
          error: outcome.autoLoginError ?? outcome.reason ?? "login-failed"
        };
      }
      const committed = await commitBrowserAuth(outcome.auth, log);
      return {
        ok: true,
        verified: committed.verified,
        ...committed.display ? { display: maskIdentifier(committed.display) } : {},
        message: committed.verified ? `\u5DF2\u81EA\u52A8\u91CD\u767B${committed.display ? `\uFF08${maskIdentifier(committed.display)}\uFF09` : ""}` : "\u5DF2\u81EA\u52A8\u91CD\u767B\uFF0C\u4F46\u670D\u52A1\u7AEF\u6821\u9A8C\u672A\u901A\u8FC7\uFF08\u53EF\u7528\u300C\u53D1\u9001\u6D4B\u8BD5\u300D\u518D\u786E\u8BA4\uFF09"
      };
    } finally {
      endRelogin();
    }
  }
  let autoRenewBusy = false;
  const autoRenewTimer = setInterval(() => {
    void (async () => {
      if (autoRenewBusy) return;
      if (readGateSettings()?.autoRelogin !== true) return;
      const targets = selectReloginTargets({
        accounts: listAccounts().map((record) => ({
          id: record.id,
          ...record.capturedAt ? { capturedAt: record.capturedAt } : {},
          lastVerifyError: record.lastVerifyError ?? null,
          ...record.user ? { user: record.user } : {}
        })),
        entries: readCredentialEntries(),
        onlyStale: true
      });
      if (targets.length === 0) return;
      autoRenewBusy = true;
      logger.info?.(`deepseek-web: \u81EA\u52A8\u91CD\u767B\u5F00\u59CB\uFF08${targets.length} \u4E2A\u8D26\u53F7\u5230\u671F/\u5C06\u5230\u671F\uFF09`);
      try {
        for (const item of targets) {
          const auto = await autoReloginOne(item.accountId, logger);
          logger.info?.(`deepseek-web: \u81EA\u52A8\u91CD\u767B ${item.display} \u2192 ${auto.ok ? "\u6210\u529F" : `\u5931\u8D25\uFF08${auto.message}\uFF09`}`);
        }
      } finally {
        autoRenewBusy = false;
      }
    })();
  }, 10 * 6e4);
  autoRenewTimer.unref?.();
  const journalEnabled = adapterConfig.deleteWebSessions !== false && cleanupMode !== "keep";
  const accountIdOfAuth = (auth) => {
    const token = auth?.token;
    if (!token) return activeAccountId();
    return listAccounts().find((account) => account.token === token)?.id;
  };
  setSessionLifecycleHook((event) => {
    if (event.kind === "deleted" || event.kind === "abandoned") {
      removeJournalEntry(event.sessionId);
      return;
    }
    if (!journalEnabled) return;
    const accountId = accountIdOfAuth(event.auth);
    if (!accountId) return;
    upsertJournalEntry({
      accountId,
      sessionId: event.sessionId,
      state: event.kind === "queued" ? "queued" : "slot"
    });
  });
  if (journalEnabled) {
    try {
      runStartupSweep({
        ownPid: process.pid,
        accountExists: (id) => readAccount(id) !== void 0,
        deleteEnabled: adapterConfig.deleteWebSessions !== false,
        mode: cleanupMode,
        onSweep: (entry) => {
          const account = readAccount(entry.accountId);
          if (!account) throw new Error("\u8D26\u53F7\u5DF2\u4E0D\u5728\u8D26\u53F7\u5E93\u91CC");
          sessionCleaner.schedule(account, entry.sessionId);
        },
        log: (message) => logger.info?.(message)
      });
    } catch (error) {
      logger.warn?.(`deepseek-web: \u542F\u52A8\u8865\u5220\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u4F7F\u7528\uFF09\uFF1A${error?.message ?? error}`);
    }
  }
  const getAuth = () => readAuth();
  try {
    const pruned = pruneLedger(LEDGER_KEEP_DAYS);
    if (pruned > 0) logger.info?.(`deepseek-web: \u5DF2\u6E05\u7406 ${pruned} \u4E2A\u8FC7\u671F\u53F0\u8D26\u6587\u4EF6`);
  } catch {
  }
  try {
    const pruned = pruneUsage(USAGE_KEEP_DAYS);
    if (pruned > 0) logger.info?.(`deepseek-web: \u5DF2\u6E05\u7406 ${pruned} \u4E2A\u8FC7\u671F\u7528\u91CF\u6587\u4EF6`);
  } catch {
  }
  const recordCallOutcome = (info) => {
    try {
      const accountId = info.accountId ?? activeAccountId();
      if (!info.ok && info.throttled && accountId) throttleAt.set(accountId, Date.now());
      const muted = Number.isFinite(info.mutedUntilMs);
      if (!info.ok && muted && accountId) {
        updateAccount(accountId, {
          limit: { untilMs: Number(info.mutedUntilMs), observedAt: (/* @__PURE__ */ new Date()).toISOString() }
        });
        logger.warn?.(
          `deepseek-web: \u8D26\u53F7\u88AB\u4E34\u65F6\u9650\u5236\uFF0C\u5DF2\u8BB0\u5F55\u89E3\u9664\u65F6\u95F4 ${new Date(Number(info.mutedUntilMs)).toLocaleString()}`
        );
      }
      if (!info.ok && info.code === "AUTH" && accountId) {
        const record = listAccounts().find((item) => item.id === accountId);
        if (record) {
          validateAuth(record, AbortSignal.timeout(2e4)).then((verdict) => {
            if (verdict.ok) {
              updateAccount(accountId, { lastVerifyError: void 0 });
              logger.info?.(
                `deepseek-web: \u8D26\u53F7 ${accountId} \u8BF7\u6C42\u88AB\u5224 AUTH\uFF0C\u4F46\u53EA\u8BFB\u63A2\u6D3B\u901A\u8FC7 \u2014\u2014 \u6309\u7AEF\u70B9\u7EA7\u8BEF\u5224\u5904\u7406\uFF0C\u4E0D\u6807\u8BB0\u5931\u6548\uFF08\u672C\u8F6E\u4ECD\u6309\u5931\u8D25\u8BA1\uFF0C\u91CD\u53D1\u5373\u53EF\uFF09`
              );
              return;
            }
            updateAccount(accountId, {
              lastVerifyError: {
                at: (/* @__PURE__ */ new Date()).toISOString(),
                message: String(info.message ?? "\u767B\u5F55\u6001\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55")
              }
            });
            logger.warn?.(
              `deepseek-web: \u8D26\u53F7 ${accountId} AUTH \u590D\u6838\u786E\u8BA4\u5931\u6548\uFF08${verdict.error ?? "\u63A2\u6D3B\u672A\u901A\u8FC7"}\uFF09\uFF0C\u5DF2\u6807\u8BB0\u4E3A\u300C\u9700\u8981\u91CD\u65B0\u767B\u5F55\u300D`
            );
          }).catch((error) => {
            logger.warn?.(
              `deepseek-web: \u8D26\u53F7 ${accountId} AUTH \u590D\u6838\u672A\u5B8C\u6210\uFF08${String(error?.message ?? error)}\uFF09\uFF0C\u6682\u4E0D\u6807\u8BB0`
            );
          });
        }
      }
      if (info.ok && accountId) {
        const record = listAccounts().find((item) => item.id === accountId);
        if (record?.limit && Date.now() >= record.limit.untilMs) {
          updateAccount(accountId, { limit: void 0 });
          logger.info?.("deepseek-web: \u8D26\u53F7\u7EA7\u9650\u5236\u5DF2\u89E3\u9664\uFF0C\u5DF2\u6E05\u9664\u672C\u5730\u7684\u9650\u5236\u6807\u8BB0");
        }
      }
      noteCall({
        at: Date.now(),
        ...accountId ? { accountId } : {},
        purpose: info.purpose,
        ok: info.ok,
        ms: info.ms,
        ...info.code ? { code: info.code } : {},
        ...muted ? { muted: true } : {},
        ...info.throttled ? { throttled: true } : {}
      });
      noteUsage(usageEntryFrom(info, Date.now()));
    } catch {
    }
  };
  const probeIntervalMs = config.probeIntervalMs ?? 30 * 6e4;
  ctx.effect(
    () => startProbeLoop({
      intervalMs: probeIntervalMs,
      getAuth: () => readAuth(),
      logger
    })
  );
  logger.info?.(
    probeIntervalMs > 0 ? `deepseek-web: \u767B\u5F55\u6001\u63A2\u6D3B\u5DF2\u5F00\u542F\uFF0C\u6BCF ${Math.round(probeIntervalMs / 6e4)} \u5206\u949F\u4E00\u6B21\uFF08\u53EA\u8BFB\u3001\u96F6\u989D\u5EA6\uFF09` : "deepseek-web: \u767B\u5F55\u6001\u63A2\u6D3B\u5DF2\u5173\u95ED\uFF08probeIntervalMs=0\uFF09"
  );
  const adapter = createAdapter({
    getAuth,
    noteCall: recordCallOutcome,
    currentAccountId: activeAccountId,
    gate,
    // 自动轮换账号的检查点：adapter 在闸门放行之前 await 一下（见 maybeAutoSwitch 的注释）。
    maybeAutoSwitch,
    // 账号被限时"还能不能换号接着干" —— 决定那次失败给长退避还是短退避（见 canFailover）。
    canFailover,
    sessionCleaner,
    config: adapterConfig,
    readImage: async (ref, signal) => {
      const attachments = ctx.get?.("attachments");
      if (!attachments || typeof attachments.readImage !== "function") {
        throw new Error("attachment service unavailable (ctx.attachments)");
      }
      const stored = await attachments.readImage(ref, signal);
      return {
        data: stored.data,
        ...stored.ref?.mediaType ? { mediaType: String(stored.ref.mediaType) } : {},
        ...stored.ref?.name ? { name: String(stored.ref.name) } : {}
      };
    }
  });
  ctx.llm.registerAdapter([PROVIDER], adapter);
  logger.info?.(`deepseek-web: \u5DF2\u6CE8\u518C provider "${PROVIDER}"\uFF08\u6A21\u578B\uFF1A${MODEL_SPECS.map((spec) => spec.id).join(", ")}\uFF09`);
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: API_PREFIX,
      handler: async (req, res) => {
        const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
        const route = url.pathname.slice(API_PREFIX.length) || "/";
        try {
          if (req.method === "GET" && route === "/gate") {
            sendJson(res, 200, {
              ...gate.settings(),
              presets: INTERVAL_PRESETS.map(([lo, hi]) => ({ min: lo, max: hi })),
              maxIntervalMs: MAX_INTERVAL_MS,
              defaultMinIntervalMs: DEFAULT_MIN_REQUEST_INTERVAL_MS,
              defaultMaxIntervalMs: DEFAULT_MAX_REQUEST_INTERVAL_MS,
              maxPromptCharsBounds: MAX_PROMPT_CHARS_BOUNDS,
              maxPromptCharsDefault: DEFAULT_MAX_PROMPT_CHARS,
              maxRefImagesBounds: MAX_REF_IMAGES_BOUNDS,
              maxRefImagesDefault: DEFAULT_MAX_REF_IMAGES,
              // 上下文窗口用「档位数组」而不是 bounds：面板是索引滑块（32K→1M 是 32 倍跨度，
              // 线性拖动前四分之三的行程都挤在低档，手感很差）。档位同样由后端给。
              contextWindowBounds: CONTEXT_WINDOW_BOUNDS,
              contextWindowDefault: DEFAULT_CONTEXT_WINDOW,
              contextWindowOptions: CONTEXT_WINDOW_OPTIONS,
              autoSwitchBounds: AUTO_SWITCH_BOUNDS,
              autoSwitchDefault: DEFAULT_AUTO_SWITCH_MINUTES,
              // 最近一次自动换号（没换过就是 null）。界面靠它显示"上次换号：X（A → B）"——
              // 换号那轮会全量重发，用户看到变慢时能对上原因。
              lastAutoSwitch: lastAutoSwitch ?? null,
              cleanup: sessionCleaner.policy(),
              // 界面的滑块边界/默认值由后端给 —— 免得两边各写一套数字、改了一边忘另一边
              cleanupBounds: {
                batch: CLEANUP_BATCH_BOUNDS,
                delayMs: CLEANUP_DELAY_BOUNDS_MS,
                gapMs: CLEANUP_GAP_BOUNDS_MS
              },
              cleanupDefaults: {
                batch: DEFAULT_CLEANUP_BATCH,
                delayMs: DEFAULT_CLEANUP_DELAY_MS,
                gapMs: DEFAULT_CLEANUP_GAP_MS
              }
            });
            return;
          }
          if (req.method === "POST" && route === "/gate") {
            const body = await readJsonBody(req);
            if (!body || typeof body !== "object") {
              sendJson(res, 400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON" });
              return;
            }
            const patch = {};
            if (typeof body.allowConcurrent === "boolean") patch.allowConcurrent = body.allowConcurrent;
            for (const field of ["minRequestIntervalMs", "maxRequestIntervalMs"]) {
              if (body[field] === void 0) continue;
              const ms = Number(body[field]);
              if (!Number.isFinite(ms)) {
                sendJson(res, 400, { ok: false, error: `${field} \u5FC5\u987B\u662F\u6570\u5B57` });
                return;
              }
              patch[field] = ms;
            }
            if (body.maxPromptChars !== void 0) {
              const chars = Number(body.maxPromptChars);
              if (!Number.isFinite(chars)) {
                sendJson(res, 400, { ok: false, error: "maxPromptChars \u5FC5\u987B\u662F\u6570\u5B57" });
                return;
              }
              const clamped = clampMaxPromptChars(chars);
              if (clamped !== chars) {
                logger.warn?.(`deepseek-web: maxPromptChars ${chars} \u8D8A\u754C\uFF0C\u5939\u5230 ${clamped}`);
              }
              patch.maxPromptChars = clamped;
            }
            if (body.sessionCleanup !== void 0) {
              if (!["immediate", "deferred", "keep"].includes(body.sessionCleanup)) {
                sendJson(res, 400, { ok: false, error: "sessionCleanup \u53EA\u80FD\u662F immediate / deferred / keep" });
                return;
              }
              patch.sessionCleanup = body.sessionCleanup;
            }
            for (const [field, bounds] of [
              ["cleanupBatch", CLEANUP_BATCH_BOUNDS],
              ["cleanupDelayMs", CLEANUP_DELAY_BOUNDS_MS],
              ["cleanupGapMs", CLEANUP_GAP_BOUNDS_MS]
            ]) {
              if (body[field] === void 0) continue;
              const range = normalizeCleanupRange(body[field], bounds);
              if (!range) {
                sendJson(res, 400, { ok: false, error: `${field} \u9700\u8981 { min, max } \u4E24\u4E2A\u6570\u5B57` });
                return;
              }
              patch[field] = range;
            }
            if (body.maxRefImages !== void 0) {
              const count = Number(body.maxRefImages);
              if (!Number.isFinite(count)) {
                sendJson(res, 400, { ok: false, error: "maxRefImages \u5FC5\u987B\u662F\u6570\u5B57" });
                return;
              }
              patch.maxRefImages = clampMaxRefImages(count);
            }
            if (body.contextWindow !== void 0) {
              const window = Number(body.contextWindow);
              if (!Number.isFinite(window)) {
                sendJson(res, 400, { ok: false, error: "contextWindow \u5FC5\u987B\u662F\u6570\u5B57" });
                return;
              }
              patch.contextWindow = clampContextWindow(window);
            }
            if (body.autoSwitchMinutes !== void 0) {
              const minutes = Number(body.autoSwitchMinutes);
              if (!Number.isFinite(minutes)) {
                sendJson(res, 400, { ok: false, error: "autoSwitchMinutes \u5FC5\u987B\u662F\u6570\u5B57" });
                return;
              }
              patch.autoSwitchMinutes = clampAutoSwitchMinutes(minutes);
            }
            if (body.serialToolCalls !== void 0) {
              if (typeof body.serialToolCalls !== "boolean") {
                sendJson(res, 400, { ok: false, error: "serialToolCalls \u5FC5\u987B\u662F\u5E03\u5C14\u503C" });
                return;
              }
              patch.serialToolCalls = body.serialToolCalls;
            }
            if (body.freshSessionOnRestart !== void 0) {
              if (typeof body.freshSessionOnRestart !== "boolean") {
                sendJson(res, 400, { ok: false, error: "freshSessionOnRestart \u5FC5\u987B\u662F\u5E03\u5C14\u503C" });
                return;
              }
              patch.freshSessionOnRestart = body.freshSessionOnRestart;
            }
            if (body.autoRelogin !== void 0) {
              if (typeof body.autoRelogin !== "boolean") {
                sendJson(res, 400, { ok: false, error: "autoRelogin \u5FC5\u987B\u662F\u5E03\u5C14\u503C" });
                return;
              }
              patch.autoRelogin = body.autoRelogin;
            }
            if (Object.keys(patch).length === 0) {
              sendJson(res, 400, { ok: false, error: "\u6CA1\u6709\u53EF\u66F4\u65B0\u7684\u5B57\u6BB5" });
              return;
            }
            const applied = gate.configure(patch);
            if (applied.maxPromptChars !== void 0) adapterConfig.maxPromptChars = applied.maxPromptChars;
            if (applied.maxRefImages !== void 0) adapterConfig.maxRefImages = applied.maxRefImages;
            if (applied.contextWindow !== void 0) adapterConfig.contextWindow = applied.contextWindow;
            if (applied.serialToolCalls !== void 0) adapterConfig.serialToolCalls = applied.serialToolCalls;
            if (applied.freshSessionOnRestart !== void 0) {
              applyFreshSessionOnRestart(applied.freshSessionOnRestart);
            }
            if (patch.sessionCleanup) sessionCleaner.configure({ mode: patch.sessionCleanup });
            const rangePatch = {};
            if (patch.cleanupBatch) rangePatch.batchRange = patch.cleanupBatch;
            if (patch.cleanupDelayMs) rangePatch.delayRange = patch.cleanupDelayMs;
            if (patch.cleanupGapMs) rangePatch.gapRange = patch.cleanupGapMs;
            if (Object.keys(rangePatch).length > 0) sessionCleaner.configure(rangePatch);
            try {
              writeGateSettings(applied);
            } catch (error) {
              logger.warn?.(`deepseek-web: \u8282\u6D41\u8BBE\u7F6E\u843D\u76D8\u5931\u8D25\uFF1A${error?.message ?? error}`);
              sendJson(res, 200, { ok: true, ...applied, persisted: false, warning: "\u5DF2\u5373\u65F6\u751F\u6548\uFF0C\u4F46\u5199\u5165 gate.json \u5931\u8D25\uFF0C\u91CD\u542F\u540E\u4F1A\u56DE\u5230\u65E7\u503C" });
              return;
            }
            sendJson(res, 200, { ok: true, ...applied, persisted: true, cleanup: sessionCleaner.policy() });
            return;
          }
          if (req.method === "GET" && route === "/ledger") {
            const hours = Math.min(72, Math.max(1, Number(url.searchParams.get("hours")) || 24));
            sendJson(res, 200, summarizeLedger(hours));
            return;
          }
          if (req.method === "GET" && route === "/usage") {
            const raw = url.searchParams.get("days");
            const days = raw === null || raw === "" ? 30 : raw;
            sendJson(res, 200, {
              ...summarizeUsage(days),
              keepDays: USAGE_KEEP_DAYS,
              dir: usageDir(),
              hasData: usageExists()
            });
            return;
          }
          if (req.method === "POST" && route === "/update-check") {
            const result = await checkForUpdate(pluginVersion(), currentFetch);
            sendJson(res, 200, { ...result, repo: RELEASE_REPO });
            return;
          }
          if (req.method === "GET" && route === "/accounts") {
            const activeId = activeAccountId();
            const list = listAccounts();
            const groups = readGroups();
            const accounts = list.map((record) => ({
              id: record.id,
              title: accountTitle(record, maskIdentifier),
              display: record.user?.display ? maskIdentifier(record.user.display) : "",
              label: record.label ?? "",
              groupId: record.groupId ?? "",
              unverified: record.unverified === true,
              // 「邮箱 / 手机号」标志（0.6.13）。判据是纯函数（`identifierKindOf`），
              // 老记录只有脱敏 display 也能判；判不出来就是 unknown，界面不显示。
              identifierKind: identifierKindOf(record.user),
              capturedAt: record.capturedAt,
              lastVerifiedAt: record.lastVerifiedAt ?? null,
              lastVerifyError: record.lastVerifyError ?? null,
              // 网络类的校验失败单传一个字段：界面据此显示"未能校验"，
              // **不能**和 lastVerifyError 混着看（那会让"需要重新登录"变成误报）。
              lastCheckError: record.lastCheckError ?? null,
              limit: record.limit ?? null,
              // cookie 的过期构成（捕获时记下）。老记录 / 手动粘 token 的账号是空数组，
              // 界面据此区分"没记录"和"记录到全是会话级"—— 这两种含义完全不同。
              cookieMeta: record.cookieMeta ?? [],
              isActive: record.id === activeId
            }));
            sendJson(res, 200, {
              activeId: activeId ?? null,
              // 分组定义单独存 groups.json；账号记录里只有 groupId 指针。
              // ⚠️ 客户端的重建签名按 `{activeId, accounts, groups}` 整包算 ——
              // 顶层字段不列进签名，新建/改名组后面板就不会自己刷新（0.1.63/0.1.67 那类坑）。
              groups,
              // 「按组分区」在宿主侧算好：客户端只负责画。
              // 这样分区规则（当前账号所在组置顶 → 其余按 order → 未分组垫底）只有一份实现，
              // 也就只有一处要测 —— 放进客户端会因为 node 依赖而不得不复制一份。
              sections: partitionByGroup(accounts, groups, activeId),
              // 顶层 `accounts` 必须继续返回：客户端有"没有 sections 就平铺"的兜底路径，
              // 而且重建签名是 `{activeId, accounts, groups, sections}` 整包算的。
              accounts,
              footprint: accountsFootprint()
            });
            return;
          }
          if (req.method === "POST" && route === "/accounts/switch") {
            const body = await readJsonBody(req);
            const id = String(body?.id ?? "");
            endAddAccount();
            endRelogin();
            const target = id ? readAccount(id) : void 0;
            if (!target) {
              sendJson(res, 404, { ok: false, error: "\u8D26\u53F7\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u79FB\u9664\uFF09" });
              return;
            }
            const probed = await probeOnce(
              target,
              {
                info: (message) => logger.info?.(message),
                warn: (message) => logger.warn?.(message)
              },
              // 交互式点击：10 秒而不是 20 秒。超了也只当"没能校验"，不拦（见下面的分类）。
              { timeoutMs: SWITCH_PROBE_TIMEOUT_MS }
            );
            const gate2 = switchGateFromProbe(probed);
            if (gate2 === "relogin") {
              sendJson(res, 200, {
                ok: false,
                needsRelogin: true,
                error: `\u8FD9\u4E2A\u53F7\u7684\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF08${probed?.error ?? "\u672A\u77E5\u539F\u56E0"}\uFF09\uFF0C\u9700\u8981\u91CD\u65B0\u767B\u5F55\u4E00\u6B21\u624D\u80FD\u5207\u6362`
              });
              return;
            }
            const warning = gate2 === "warn" ? `\u5DF2\u5207\u6362\uFF0C\u4F46\u6CA1\u80FD\u6821\u9A8C\u8FD9\u4E2A\u53F7\uFF08\u7F51\u7EDC\u95EE\u9898\uFF1A${probed?.error ?? "\u672A\u77E5\u539F\u56E0"}\uFF09\u2014\u2014 \u767B\u5F55\u6001\u672A\u5FC5\u5931\u6548\uFF0C\u7F51\u7EDC\u6062\u590D\u540E\u53EF\u518D\u70B9\u300C\u6821\u9A8C\u5168\u90E8\u300D\u786E\u8BA4` : void 0;
            if (!setActiveAccount(id)) {
              sendJson(res, 404, { ok: false, error: "\u8D26\u53F7\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u79FB\u9664\uFF09" });
              return;
            }
            logger.info?.(`deepseek-web: \u5F53\u524D\u8D26\u53F7\u5DF2\u5207\u6362\u4E3A ${id}`);
            lastAutoSwitchAt = Date.now();
            lastSwitchedAt = Date.now();
            sendJson(res, 200, { ok: true, activeId: id, ...warning ? { warning } : {} });
            return;
          }
          if (req.method === "POST" && route === "/accounts/rename") {
            const body = await readJsonBody(req);
            const id = String(body?.id ?? "");
            const label = String(body?.label ?? "").slice(0, 40);
            if (!updateAccount(id, { label })) {
              sendJson(res, 404, { ok: false, error: "\u8D26\u53F7\u4E0D\u5B58\u5728" });
              return;
            }
            sendJson(res, 200, { ok: true, id, label });
            return;
          }
          if (req.method === "POST" && route === "/accounts/remove") {
            const body = await readJsonBody(req);
            const id = String(body?.id ?? "");
            if (!removeAccount(id)) {
              sendJson(res, 404, { ok: false, error: "\u8D26\u53F7\u4E0D\u5B58\u5728" });
              return;
            }
            logger.info?.(`deepseek-web: \u5DF2\u4ECE\u8D26\u53F7\u5E93\u79FB\u9664 ${id}`);
            sendJson(res, 200, { ok: true, removed: id, activeId: activeAccountId() ?? null });
            return;
          }
          if (req.method === "POST" && route === "/accounts/group/create") {
            const body = await readJsonBody(req);
            const result = createGroup(readGroups(), body?.name);
            if (result.error || !result.group) {
              sendJson(res, 400, { ok: false, error: result.error ?? "\u521B\u5EFA\u5931\u8D25" });
              return;
            }
            writeGroups(result.list);
            sendJson(res, 200, { ok: true, group: result.group, groups: result.list });
            return;
          }
          if (req.method === "POST" && route === "/accounts/group/rename") {
            const body = await readJsonBody(req);
            const result = renameGroup(readGroups(), String(body?.id ?? ""), body?.name);
            if (result.error) {
              sendJson(res, 400, { ok: false, error: result.error });
              return;
            }
            writeGroups(result.list);
            sendJson(res, 200, { ok: true, groups: result.list });
            return;
          }
          if (req.method === "POST" && route === "/accounts/group/delete") {
            const body = await readJsonBody(req);
            const id = String(body?.id ?? "");
            const next = removeGroup(readGroups(), id);
            writeGroups(next);
            logger.info?.(`deepseek-web: \u5DF2\u5220\u9664\u5206\u7EC4 ${id}\uFF08\u7EC4\u5185\u8D26\u53F7\u56DE\u5230\u300C\u672A\u5206\u7EC4\u300D\uFF0C\u8D26\u53F7\u672C\u8EAB\u672A\u52A8\uFF09`);
            sendJson(res, 200, { ok: true, groups: next });
            return;
          }
          if (req.method === "POST" && route === "/accounts/group/assign") {
            const body = await readJsonBody(req);
            const id = String(body?.id ?? "");
            const groupId = String(body?.groupId ?? "");
            if (groupId && !readGroups().some((group) => group.id === groupId)) {
              sendJson(res, 400, { ok: false, error: "\u5206\u7EC4\u4E0D\u5B58\u5728" });
              return;
            }
            if (!updateAccount(id, { groupId })) {
              sendJson(res, 404, { ok: false, error: "\u8D26\u53F7\u4E0D\u5B58\u5728" });
              return;
            }
            sendJson(res, 200, { ok: true, id, groupId });
            return;
          }
          if (req.method === "POST" && route === "/accounts/refresh") {
            if (accountsRefreshInFlight) {
              sendJson(res, 200, { ok: false, error: "\u6B63\u5728\u5237\u65B0\uFF0C\u8BF7\u7A0D\u5019" });
              return;
            }
            accountsRefreshInFlight = true;
            try {
              let passed = 0;
              let failed = 0;
              let authFailed = 0;
              let transportFailed = 0;
              for (const account of listAccounts()) {
                const outcome = await probeOnce(account, {
                  info: (message) => logger.info?.(message),
                  warn: (message) => logger.warn?.(message)
                });
                if (outcome?.ok) passed += 1;
                else if (outcome) {
                  failed += 1;
                  if (outcome.errorKind === "auth") authFailed += 1;
                  else transportFailed += 1;
                }
              }
              logger.info?.(
                `deepseek-web: \u624B\u52A8\u5237\u65B0\u8D26\u53F7\u72B6\u6001\u5B8C\u6210 \u2014\u2014 \u901A\u8FC7 ${passed}\u3001\u6388\u6743\u5931\u6548 ${authFailed}\u3001\u7F51\u7EDC\u672A\u80FD\u6821\u9A8C ${transportFailed}`
              );
              sendJson(res, 200, {
                ok: true,
                checked: passed + failed,
                passed,
                failed,
                authFailed,
                transportFailed
              });
            } finally {
              accountsRefreshInFlight = false;
            }
            return;
          }
          if (req.method === "POST" && route === "/accounts/export") {
            try {
              const result = exportAccountsToFile();
              sendJson(res, 200, { ok: true, ...result, warning: "\u5BFC\u51FA\u6587\u4EF6\u542B\u53EF\u5B8C\u6574\u767B\u5F55\u7684\u51ED\u8BC1\uFF0C\u8BF7\u59A5\u5584\u4FDD\u7BA1\u3001\u52FF\u5206\u4EAB" });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: `\u5BFC\u51FA\u5931\u8D25\uFF1A${error?.message ?? error}` });
            }
            return;
          }
          if (req.method === "POST" && route === "/accounts/export-json") {
            try {
              sendJson(res, 200, { ok: true, ...exportAccounts() });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: `\u5BFC\u51FA\u5931\u8D25\uFF1A${error?.message ?? error}` });
            }
            return;
          }
          if (req.method === "POST" && route === "/accounts/import") {
            const body = await readJsonBody(req, IMPORT_FILE_LIMIT_BYTES);
            if (!body || typeof body !== "object") {
              sendJson(res, 400, { ok: false, error: "\u8BF7\u63D0\u4F9B\u5907\u4EFD\u5185\u5BB9\uFF08payload\uFF09\u6216\u6587\u4EF6\u8DEF\u5F84" });
              return;
            }
            let payload = body.payload;
            const path = typeof body.path === "string" ? body.path.trim() : "";
            if (payload === void 0 && path) {
              try {
                const info = statSync6(path);
                if (!info.isFile()) throw new Error("\u4E0D\u662F\u666E\u901A\u6587\u4EF6");
                if (info.size > IMPORT_FILE_LIMIT_BYTES) {
                  throw new Error(`\u6587\u4EF6 ${Math.ceil(info.size / 1024)} KiB\uFF0C\u8D85\u8FC7\u4E0A\u9650 ${Math.floor(IMPORT_FILE_LIMIT_BYTES / 1024 / 1024)} MiB`);
                }
                payload = JSON.parse(readFileSync15(path, "utf8"));
              } catch (error) {
                sendJson(res, 400, { ok: false, error: `\u8BFB\u53D6\u5BFC\u5165\u6587\u4EF6\u5931\u8D25\uFF1A${error?.message ?? error}` });
                return;
              }
            }
            if (payload === void 0 || payload === null) {
              sendJson(res, 400, { ok: false, error: "\u8BF7\u63D0\u4F9B\u8981\u5BFC\u5165\u7684\u5185\u5BB9\u6216\u6587\u4EF6\u8DEF\u5F84" });
              return;
            }
            try {
              const result = importAccounts(payload);
              logger.info?.(`deepseek-web: \u8D26\u53F7\u5E93\u5BFC\u5165\u5B8C\u6210\uFF08\u65B0\u589E ${result.imported} / \u66F4\u65B0 ${result.updated} / \u8DF3\u8FC7 ${result.skipped}\uFF09`);
              sendJson(res, 200, { ok: true, ...result, activeId: activeAccountId() ?? null });
            } catch (error) {
              if (error instanceof TypeError || error instanceof RangeError) {
                sendJson(res, 400, { ok: false, error: error?.message ?? String(error) });
                return;
              }
              throw error;
            }
            return;
          }
          if (req.method === "GET" && route === "/transport") {
            sendJson(res, 200, { ...transportState, hint: TRANSPORT_HINT, settingsPath: transportSettingsPath() });
            return;
          }
          if (req.method === "POST" && route === "/transport") {
            const body = await readJsonBody(req);
            const wanted = body?.transport;
            if (wanted !== "chromium" && wanted !== "node") {
              sendJson(res, 400, { ok: false, error: "transport \u5FC5\u987B\u662F 'chromium' \u6216 'node'" });
              return;
            }
            transportState = applyTransport(wanted);
            let persisted = true;
            try {
              writeTransportSetting(wanted);
            } catch {
              persisted = false;
            }
            logger.info?.(
              `deepseek-web: \u4F20\u8F93\u5C42\u5207\u6362\u4E3A ${transportState.effective}` + (transportState.degraded ? "\uFF08\u8981\u6C42 Chrome \u4F46\u672C\u73AF\u5883\u4E0D\u53EF\u7528\uFF0C\u5DF2\u964D\u7EA7 Node\uFF09" : transportState.viaBrowserProxy ? "\uFF08\u901A\u8FC7\u7CFB\u7EDF Edge/Chrome \u8FDB\u7A0B\u4EE3\u7406\uFF09" : "")
            );
            sendJson(res, 200, {
              ok: true,
              ...transportState,
              persisted,
              hint: TRANSPORT_HINT,
              settingsPath: transportSettingsPath()
            });
            return;
          }
          if (req.method === "GET" && route === "/context-mode") {
            sendJson(res, 200, {
              mode: contextMode,
              hint: CONTEXT_MODE_HINT,
              settingsPath: contextModeSettingsPath(),
              // 只在链式模式下回链状态（0.1.63）：全量模式下链已经作废，
              // 回它会让界面出现「每轮全量 + 链式投喂正在跑」这种自相矛盾的组合。
              chain: contextMode === "chained" ? contextChainInfo() ?? null : null
            });
            return;
          }
          if (req.method === "POST" && route === "/context-mode") {
            const body = await readJsonBody(req);
            const wanted = body?.mode;
            if (wanted !== "full" && wanted !== "chained") {
              sendJson(res, 400, { ok: false, error: "mode \u5FC5\u987B\u662F 'full' \u6216 'chained'" });
              return;
            }
            contextMode = applyContextMode(wanted);
            if (contextMode === "full") resetContextChain();
            let persisted = true;
            try {
              writeContextModeSetting(wanted);
            } catch {
              persisted = false;
            }
            logger.info?.(`deepseek-web: \u4E0A\u4E0B\u6587\u6295\u5582\u5207\u6362\u4E3A ${contextMode}`);
            sessionCleaner.setManualOnly(contextMode === "chained");
            sendJson(res, 200, {
              ok: true,
              mode: contextMode,
              persisted,
              hint: CONTEXT_MODE_HINT,
              settingsPath: contextModeSettingsPath(),
              chain: contextMode === "chained" ? contextChainInfo() ?? null : null,
              pendingCleanup: sessionCleaner.pendingCount()
            });
            return;
          }
          if (req.method === "POST" && route === "/cleanup") {
            const live = clearLiveSession();
            const auth = getAuth();
            if (auth) for (const id of live) sessionCleaner.schedule(auth, id);
            await sessionCleaner.flush();
            logger.info?.(`deepseek-web: \u624B\u52A8\u6E05\u7406\u5B8C\u6210\uFF08\u9000\u51FA ${live.length} \u4E2A\u4F1A\u8BDD\uFF0C\u961F\u5217\u5DF2\u6E05\u7A7A\uFF09`);
            sendJson(res, 200, {
              ok: true,
              cleared: live.length,
              pending: sessionCleaner.pendingCount(),
              mode: contextMode
            });
            return;
          }
          if (req.method === "POST" && route === "/diagnostics/net-fetch") {
            const body = await readJsonBody(req);
            const mode = body?.mode === "stream" ? "stream" : "probe";
            const result = await runNetFetchDiagnostics(getAuth(), mode);
            sendJson(res, result.ok ? 200 : 500, result);
            return;
          }
          if (req.method === "GET" && (route === "/status" || route === "/")) {
            const light = url.searchParams.get("light") === "1";
            const auth = getAuth();
            const summary = describeAuth(auth);
            let validation;
            if (summary.loggedIn && !light) {
              const check = await validateAuth(auth, AbortSignal.timeout(15e3));
              validation = { ok: check.ok, ...check.error ? { error: check.error } : {} };
              if (check.ok && check.user && auth && (!auth.user || auth.user.display !== check.user.display)) {
                const target = listAccounts().find((item) => item.token === auth.token);
                if (target) refreshVerifiedIdentity(target.id, target.token, check.user);
              }
            }
            let registeredProviders = [];
            try {
              registeredProviders = (ctx.llm.listProviders() ?? []).map((provider) => String(provider?.id ?? provider));
            } catch {
            }
            sendJson(res, 200, {
              provider: PROVIDER,
              registeredProviders,
              electron: canOpenElectronWindow(),
              loginWindowOpen: isLoginWindowOpen(),
              loginProgress: getLoginProgress(),
              fingerprint: getFingerprintReport(),
              lastLoginResult: getLastLoginResult(),
              // 登录能力自检：宿主进程类型 + 能否开 Electron 窗口 + 有没有真实浏览器可用。
              // 这三项是「窗口登录打不开」这类问题的第一现场证据（2026-09-11 就栽在这里）。
              loginCapability: {
                processType: process.type ?? "node",
                canOpenWindow: canOpenElectronWindow(),
                browser: findSystemBrowser()?.name ?? null
              },
              // 账号元信息（限制解除时间 / 探活结果）跟着 auth 一起给界面。
              // 注意 limit 目前仍只从"生成被拒"里学到 —— 虽然 users/current 的响应体里
              // 也带着 chat.mute_until（2026-09-12 实测），但还没接上，见 accounts.ts 的说明。
              // 本地状态位置（「关于」页展示）
              paths: {
                webLogin: webLoginDir(),
                accounts: accountsDir(),
                ledger: ledgerDir()
              },
              auth: {
                ...summary,
                limitUntilMs: Number.isFinite(auth?.limit?.untilMs) ? auth.limit.untilMs : null,
                limitObservedAt: auth?.limit?.observedAt ?? null,
                lastVerifiedAt: auth?.lastVerifiedAt ?? null,
                lastVerifyError: auth?.lastVerifyError ?? null
              },
              validation,
              models: MODEL_SPECS.map((spec) => ({
                id: spec.id,
                name: spec.name,
                description: spec.description,
                modelType: spec.modelType,
                thinking: spec.thinking,
                contextWindow: spec.contextWindow
              })),
              config: {
                maxPromptChars: adapterConfig.maxPromptChars,
                idleTimeoutMs: adapterConfig.idleTimeoutMs,
                deleteWebSessions: adapterConfig.deleteWebSessions !== false,
                allowConcurrent: adapterConfig.allowConcurrent === true,
                minRequestIntervalMs: adapterConfig.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
                maxRequestIntervalMs: adapterConfig.maxRequestIntervalMs ?? DEFAULT_MAX_REQUEST_INTERVAL_MS,
                sessionCleanup: cleanupMode,
                sessionCleanupPending: sessionCleaner.pendingCount(),
                transport: transportState.effective,
                contextMode,
                contextChain: contextChainInfo() ?? null,
                version: pluginVersion(),
                probeIntervalMs
              }
            });
            return;
          }
          if (req.method === "POST" && route === "/login/add") {
            endRelogin();
            beginAddAccount();
            const { profileCleared, partitionCleared } = await clearLoginState();
            logger.info?.(
              `deepseek-web: \u51C6\u5907\u6DFB\u52A0\u65B0\u8D26\u53F7\uFF08profile=${profileCleared} partition=${partitionCleared}\uFF09\u2014\u2014 \u63A5\u4E0B\u6765\u6355\u83B7\u5230\u7684\u51ED\u8BC1\u53EA\u5165\u5E93\u3001\u4E0D\u5207\u6362`
            );
            sendJson(res, 200, {
              ok: true,
              profileCleared,
              partitionCleared,
              hint: "\u767B\u5F55\u7A97\u53E3\u91CC\u767B\u5F55\u53E6\u4E00\u4E2A\u8D26\u53F7\uFF1B\u5B83\u4F1A\u52A0\u5165\u8D26\u53F7\u5E93\uFF0C\u4F46\u4E0D\u4F1A\u81EA\u52A8\u5207\u6362"
            });
            return;
          }
          if (req.method === "POST" && route === "/login/relogin") {
            const body = await readJsonBody(req);
            const id = String(body?.id ?? "");
            const target = id ? readAccount(id) : void 0;
            if (!target) {
              sendJson(res, 404, { ok: false, error: "\u8D26\u53F7\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u79FB\u9664\uFF09\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5" });
              return;
            }
            const probe = await probeOnce(target, {
              info: (message) => logger.info?.(message),
              warn: (message) => logger.warn?.(message)
            }).catch(() => void 0);
            const plan = planRelogin(probe);
            if (plan === "already-valid") {
              logger.info?.(
                `deepseek-web: \u91CD\u767B\u524D\u63A2\u6D3B\u901A\u8FC7\uFF08${target.id}\uFF09\u2014\u2014 \u51ED\u8BC1\u672C\u6765\u5C31\u53EF\u7528\uFF0C\u4E0D\u6253\u5F00\u767B\u5F55\u7A97\u53E3\u3001\u4E0D\u6E05\u4EFB\u4F55\u4E1C\u897F`
              );
              sendJson(res, 200, {
                ok: true,
                targetId: id,
                alreadyValid: true,
                hint: "\u8FD9\u6761\u8D26\u53F7\u6821\u9A8C\u901A\u8FC7 \u2014\u2014 \u5B83\u672C\u6765\u5C31\u662F\u597D\u7684\uFF08\u5931\u8D25\u7684\u6807\u8BB0\u5DF2\u6E05\u6389\uFF09\uFF0C\u4E0D\u9700\u8981\u91CD\u65B0\u767B\u5F55"
              });
              return;
            }
            if (plan === "network") {
              logger.warn?.(
                `deepseek-web: \u91CD\u767B\u524D\u63A2\u6D3B\u5931\u8D25\uFF08\u7F51\u7EDC\u7C7B\uFF09\u2014\u2014 ${probe?.error}\uFF08\u4E0D\u6E05\u767B\u5F55\u6001\u3001\u4E0D\u6253\u5F00\u7A97\u53E3\uFF09`
              );
              sendJson(res, 200, {
                ok: false,
                network: true,
                error: `\u7F51\u7EDC\u6682\u65F6\u4E0D\u901A\uFF0C\u6CA1\u80FD\u6821\u9A8C\u8FD9\u6761\u8D26\u53F7\uFF1A${probe?.error ?? "\u672A\u77E5\u539F\u56E0"}\u3002\u5B83\u7684\u51ED\u8BC1\u6CA1\u6709\u88AB\u6539\u52A8\u8FC7 \u2014\u2014 \u7F51\u7EDC\u6062\u590D\u540E\u518D\u70B9\u4E00\u6B21\u5373\u53EF\uFF0C\u4E0D\u9700\u8981\u91CD\u65B0\u767B\u5F55`
              });
              return;
            }
            const cleared = await clearLoginState();
            logger.info?.(
              `deepseek-web: \u8D26\u53F7\u300C${target.label || target.id}\u300D\u6388\u6743\u5DF2\u5931\u6548\uFF0C\u91CD\u767B\u4E0D\u518D\u590D\u7528\u767B\u5F55\u6001\uFF0C\u5148\u6E05\u6389\uFF08profile=${cleared.profileCleared} partition=${cleared.partitionCleared}\uFF09`
            );
            beginRelogin(id);
            logger.info?.(
              `deepseek-web: \u51C6\u5907\u91CD\u65B0\u767B\u5F55\u300C${target.label || target.id}\u300D\uFF08\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u672C\u6B21\u4E0D\u590D\u7528\uFF09\u2014\u2014 \u6355\u83B7\u540E\u539F\u5730\u66F4\u65B0\u8FD9\u6761\u8BB0\u5F55\uFF0C\u4E0D\u65B0\u589E\u3001\u4E5F\u4E0D\u5207\u6362\u5F53\u524D\u8D26\u53F7`
            );
            if (credentialForDisplay(target.user?.display)) {
              const auto = await autoReloginOne(id, logger);
              sendJson(res, 200, {
                ok: auto.ok,
                targetId: id,
                autoRelogin: true,
                verified: auto.verified ?? false,
                ...auto.display ? { display: auto.display } : {},
                ...auto.ok ? { hint: auto.message } : { error: auto.message, code: auto.error }
              });
              return;
            }
            sendJson(res, 200, {
              ok: true,
              targetId: id,
              keptBrowserSession: false,
              hint: "\u8FD9\u6761\u8D26\u53F7\u7684\u6388\u6743\u786E\u5B9E\u5931\u6548\u4E86\uFF08\u767B\u5F55\u6001\u5DF2\u6E05\u6389\uFF09\uFF0C\u8BF7\u5728\u6253\u5F00\u7684\u7A97\u53E3\u91CC\u91CD\u65B0\u767B\u5F55\u4E00\u6B21"
            });
            return;
          }
          if (req.method === "POST" && route === "/login/relogin-all") {
            const entries = readCredentialEntries();
            const targets = selectReloginTargets({
              accounts: listAccounts().map((record) => ({
                id: record.id,
                ...record.capturedAt ? { capturedAt: record.capturedAt } : {},
                lastVerifyError: record.lastVerifyError ?? null,
                ...record.user ? { user: record.user } : {}
              })),
              entries
            });
            if (targets.length === 0) {
              sendJson(res, 200, {
                ok: false,
                results: [],
                error: entries.length === 0 ? "\u672C\u673A\u8FD8\u6CA1\u6709\u90AE\u7BB1\u5BC6\u7801\u51ED\u8BC1\uFF0C\u65E0\u6CD5\u81EA\u52A8\u91CD\u767B" : "\u73B0\u6709\u8D26\u53F7\u90FD\u5339\u914D\u4E0D\u5230\u90AE\u7BB1\u5BC6\u7801\u51ED\u8BC1\uFF08\u8131\u654F\u540D\u5BF9\u4E0D\u4E0A\uFF09\u2014\u2014\u53EF\u4EE5\u7528\u300C\u767B\u5F55\u65B0\u8D26\u53F7\u300D\u624B\u52A8\u8865\u4E00\u6761"
              });
              return;
            }
            const results = [];
            for (const item of targets) {
              const auto = await autoReloginOne(item.accountId, logger);
              results.push({
                targetId: item.accountId,
                display: item.display,
                reason: item.reason,
                ok: auto.ok,
                message: auto.message
              });
            }
            const okCount = results.filter((r) => r.ok).length;
            logger.info?.(`deepseek-web: \u4E00\u952E\u91CD\u767B\u5B8C\u6210 ${okCount}/${results.length}`);
            sendJson(res, 200, { ok: okCount > 0, results, okCount, total: results.length });
            return;
          }
          if (req.method === "POST" && route === "/login/browser") {
            const freshBody = await readJsonBody(req).catch(() => void 0);
            if (freshBody?.fresh === true) {
              const { profileCleared, partitionCleared } = await clearLoginState();
              logger.info?.(
                `deepseek-web: \u767B\u5F55\u524D\u6E05\u7406\u767B\u5F55\u6001\uFF08profile=${profileCleared} partition=${partitionCleared}\uFF09`
              );
            }
            if (canOpenElectronWindow()) {
              const result = await openLoginWindow(logger);
              sendJson(res, 200, { ...result, mode: "window" });
              return;
            }
            const outcome = await browserLogin({
              onProgress: (message) => logger?.info?.(`deepseek-web login(browser): ${message}`),
              signal: void 0
            });
            if (outcome.ok && outcome.auth) {
              const check = await validateAuth(outcome.auth).catch(() => void 0);
              const verified = !!check?.ok;
              const commitAuth = verified ? withVerifiedIdentity(outcome.auth, check?.user) : outcome.auth;
              const commit = commitCapturedAuth(commitAuth);
              if (verified && check?.user && commit.recordId) {
                const record = listAccounts().find((item) => item.id === commit.recordId);
                const verifiedId = typeof check.user.id === "string" ? String(check.user.id) : "";
                updateAccount(commit.recordId, {
                  user: { ...record?.user ?? {}, ...check.user },
                  // ⚠️ `serverId` 是**去重键**：只回写 user 而不写它，下次同一个号还会被当成新账号
                  ...verifiedId ? { serverId: verifiedId } : {},
                  lastVerifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
                  lastVerifyError: void 0
                });
              }
              sendJson(res, 200, {
                started: true,
                mode: "browser",
                added: commit.mode === "add",
                relogin: commit.mode === "relogin",
                created: commit.created === true,
                activeId: activeAccountId() ?? null,
                ok: true,
                verified,
                message: verified ? `${outcome.message}\uFF0C\u670D\u52A1\u7AEF\u6821\u9A8C\u901A\u8FC7` : `${outcome.message}\uFF1B\u670D\u52A1\u7AEF\u6821\u9A8C\u672A\u901A\u8FC7\uFF08${check?.error ?? "\u672A\u77E5\u539F\u56E0"}\uFF09\u2014\u2014\u53EF\u7528\u300C\u53D1\u9001\u6D4B\u8BD5\u300D\u518D\u786E\u8BA4`,
                display: check?.user?.display ? maskIdentifier(check.user.display) : void 0
              });
              return;
            }
            logger?.warn?.(`deepseek-web api /login/browser(browser) failed: ${outcome.reason} ${outcome.message}`);
            sendJson(res, 200, {
              started: false,
              mode: "browser",
              ok: false,
              reason: outcome.reason ?? "unknown",
              browserLeftOpen: !!outcome.browserLeftOpen,
              message: outcome.message
            });
            return;
          }
          if (req.method === "POST" && route === "/login/external") {
            const result = await openExternalLogin();
            sendJson(res, 200, result);
            return;
          }
          if (req.method === "POST" && route === "/login/token") {
            const body = await readJsonBody(req);
            if (!body || typeof body.token !== "string") {
              sendJson(res, 400, { ok: false, error: "\u8BF7\u6C42\u4F53\u9700\u8981 { token: string, cookie?: string }" });
              return;
            }
            const result = await loginWithToken(body.token, typeof body.cookie === "string" ? body.cookie : void 0, logger);
            sendJson(res, 200, result);
            return;
          }
          if (req.method === "POST" && route === "/login/recover") {
            const result = await captureFromPartition(logger);
            sendJson(res, 200, result);
            return;
          }
          if (req.method === "POST" && route === "/logout") {
            endAddAccount();
            endRelogin();
            const cleared = await logout();
            sendJson(res, 200, { ok: true, partitionCleared: cleared });
            return;
          }
          if (req.method === "POST" && route === "/test") {
            const body = await readJsonBody(req);
            const model = typeof body?.model === "string" ? body.model : "deepseek-chat";
            const prompt = typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt : "\u8BF7\u7528\u4E00\u53E5\u8BDD\u786E\u8BA4\u4F60\u5DF2\u8FDE\u901A\u3002";
            const started = Date.now();
            const text = [];
            const reasoning = [];
            const toolCalls = [];
            let finish;
            try {
              const options = {
                provider: PROVIDER,
                model,
                system: "\u4F60\u662F\u8FDE\u901A\u6027\u6D4B\u8BD5\u63A2\u9488\uFF0C\u56DE\u7B54\u4FDD\u6301\u7B80\u77ED\u3002",
                messages: [
                  {
                    id: "dsw-test-1",
                    role: "user",
                    content: [{ type: "text", text: prompt }],
                    source: { kind: "user" }
                  }
                ],
                signal: AbortSignal.timeout(9e4)
              };
              for await (const chunk of adapter.stream(options)) {
                if (chunk?.type === "text-delta") text.push(chunk.text);
                else if (chunk?.type === "reasoning-delta") reasoning.push(chunk.text);
                else if (chunk?.type === "tool-call-delta") toolCalls.push(`${chunk.name ?? "?"}(${chunk.argumentsDelta ?? ""})`);
                else if (chunk?.type === "finish") finish = chunk.reason;
              }
            } catch (error) {
              sendJson(res, 200, {
                ok: false,
                ms: Date.now() - started,
                error: error?.message ?? String(error),
                code: error?.code ?? error?.failure?.code
              });
              return;
            }
            sendJson(res, 200, {
              ok: finish?.kind !== "error",
              ms: Date.now() - started,
              model,
              text: text.join(""),
              ...reasoning.length > 0 ? { reasoning: reasoning.join("").slice(0, 800) } : {},
              ...toolCalls.length > 0 ? { toolCalls } : {},
              finish
            });
            return;
          }
          if (req.method === "POST" && route === "/models") {
            sendJson(res, 200, { models: await adapter.listModels(PROVIDER) });
            return;
          }
          sendJson(res, 404, { error: `unknown route ${route}` });
        } catch (error) {
          if (error instanceof BodyError) {
            logger.warn?.(`deepseek-web api ${route} \u8BF7\u6C42\u4F53\u88AB\u62D2\uFF1A${error.message}`);
            try {
              res.shouldKeepAlive = false;
            } catch {
            }
            if (!res.destroyed && !res.headersSent) sendJson(res, error.status, { ok: false, error: error.message });
            return;
          }
          logger.warn?.(`deepseek-web api ${route} failed: ${error?.message ?? error}`);
          sendJson(res, 500, { error: error?.message ?? String(error) });
        }
      }
    }),
    "dsh-deepseek-web-login: api"
  );
  ctx.effect(() => () => {
    try {
      if (isLoginWindowOpen()) closeLoginWindow();
    } catch {
    }
    try {
      disposeSessionReuse();
    } catch {
    }
    try {
      void sessionCleaner.flush();
    } catch {
    }
    try {
      void shutdownBrowserTransport();
    } catch {
    }
  }, "dsh-deepseek-web-login: teardown");
}
export {
  BodyError,
  apply,
  inject,
  name,
  readJsonBody
};
