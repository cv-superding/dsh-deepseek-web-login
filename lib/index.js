import { createRequire } from "node:module";
import { homedir } from "node:os";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
//#region src/auth.ts
/**
* dsh-deepseek-web-login — 凭证存储与结构化错误。
*
* 登录凭证来自 chat.deepseek.com 网页端（浏览器窗口捕获或手动粘贴）：
* Bearer token + cookie + 反爬指纹头（x-hif-*）+ PoW WASM 地址。
* 存放于 `${DSH_HOME || ~/.dsh}/web-login/deepseek-auth.json`（插件自治，
* 不进 settings/credentials 缝合口，避免敏感凭据落入通用配置面）。
*/
/** DSH 主目录（与生态一致的解析顺序）。 */
function resolveDshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}
function authFilePath() {
	return join(resolveDshHome(), "web-login", "deepseek-auth.json");
}
function readAuth() {
	try {
		const raw = readFileSync(authFilePath(), "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed?.token === "string" && parsed.token.length > 0) return {
			token: parsed.token,
			cookie: typeof parsed.cookie === "string" ? parsed.cookie : "",
			hifDliq: typeof parsed.hifDliq === "string" ? parsed.hifDliq : "",
			hifLeim: typeof parsed.hifLeim === "string" ? parsed.hifLeim : "",
			wasmUrl: typeof parsed.wasmUrl === "string" ? parsed.wasmUrl : "",
			userAgent: typeof parsed.userAgent === "string" ? parsed.userAgent : "",
			...parsed.extraHeaders && typeof parsed.extraHeaders === "object" ? { extraHeaders: parsed.extraHeaders } : {},
			capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : "",
			...parsed.unverified === true ? { unverified: true } : {},
			...parsed.user && typeof parsed.user === "object" ? { user: parsed.user } : {}
		};
	} catch {}
}
function writeAuth(auth) {
	const file = authFilePath();
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(auth, null, 2), "utf8");
	try {
		rmSync(file, { force: true });
		renameSync(tmp, file);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {}
		throw error;
	}
	if (process.platform !== "win32") try {
		chmodSync(file, 384);
	} catch {}
}
function clearAuth() {
	try {
		rmSync(authFilePath(), { force: true });
	} catch {}
}
function hasUsableAuth(auth) {
	return !!auth && typeof auth.token === "string" && auth.token.length > 8;
}
/**
* 解包页面读回的 token（兼容裸字符串与 AppKit 包装 JSON）。
*
* ⚠️ 两个必须守住的边界（都是实测形态）：
*  - 未登录时网页端返回的是 `{"value":null,"__version":"0"}` → 必须得到**空串**，
*    绝不能把字符串 "null" 当 token（否则会拿垃圾 token 去请求，报 40003 让人一头雾水）。
*  - 旧版本网页端存的是裸 token 字符串 → 原样返回。
*/
function unwrapStoredToken(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return "";
	if (text.startsWith("{")) try {
		const parsed = JSON.parse(text);
		return typeof parsed?.value === "string" ? parsed.value.trim() : "";
	} catch {
		return "";
	}
	return text === "null" || text === "undefined" ? "" : text;
}
/** 掩码账号标识（保留可辨识部分，足以确认「是哪个号」而不泄露全量）。 */
function maskIdentifier(raw) {
	const value = String(raw || "").trim();
	if (!value) return "";
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
/**
* 适配器边界错误。自带 `failure` 与 `code` 自有数据属性 ——
* LlmRuntime.normalizeLlmFailure 通过自有属性（而非 instanceof）读取结构化
* 失败信息，因此跨模块边界的自包含打包也能携带 code/status/retryAfter。
*/
var AdapterLlmError = class extends Error {
	failure;
	code;
	constructor(message, code, options = {}) {
		super(message);
		this.name = "LlmError";
		this.code = code;
		this.failure = {
			message,
			code,
			...options.status !== void 0 ? { status: options.status } : {},
			...options.providerRetryAfterMs !== void 0 ? { providerRetryAfterMs: options.providerRetryAfterMs } : {}
		};
		if (options.cause !== void 0) this.cause = options.cause;
	}
};
/** 把 HTTP 状态映射为稳定错误码（对齐 dsh-llm 默认可重试码表：SERVER/RATE_LIMIT/TIMEOUT/TRANSPORT）。 */
function httpErrorCode(status) {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 429) return "RATE_LIMIT";
	if (status === 402) return "QUOTA";
	if (status >= 500) return "SERVER";
	return "PROVIDER_ERROR";
}
/** 解析 Retry-After（秒数或 HTTP-date），返回毫秒。 */
function parseRetryAfterMs(raw) {
	if (!raw) return void 0;
	const text = String(raw).trim();
	if (/^\d+$/.test(text)) return Math.max(1e3, Number(text) * 1e3);
	const parsed = Date.parse(text);
	if (!Number.isNaN(parsed)) return Math.max(1e3, parsed - Date.now());
}
//#endregion
//#region src/gate.ts
/**
* 请求闸门（request gate）—— 限制「同一账号上同时在飞的网页端请求」。
*
* 为什么需要它（2026-09-12 实测）：
*  从插件日志反推每次调用的起止时间，272 轮里发现 **16 对时间重叠**，
*  特征非常清楚：一方是主回答（数百字、6~40 秒），另一方**只有 8~17 个字、耗时 1~3 秒**
*  —— 那是 DSH 的**会话标题生成**（`options.purpose === 'session-title'`）。
*  也就是说，你还在等回答的时候，DSH 已经又往同一个账号发了一个短请求。
*
*  网页端同一账号**同时只能生成一条**，并发生成会被拒（`A message is being generated…`），
*  更严重的是实测：双窗口并发生成不到 6 分钟就触发账号级限制（mute 1 天）。
*  所以「并发」不是能白拿的吞吐，而是要主动规避的风险源。
*
* 两道约束：
*  1. `allowConcurrent === false`（默认）：**串行**，同一时刻只放行一个调用，其余排队（FIFO）。
*  2. `minIntervalMs`：两次调用**之间**至少间隔这么久（按上一次「结束」时间算），
*     把请求密度压下来 —— 这是防风控真正起作用的那一项。
*/
/**
* 推荐的调用间隔：**随机区间 2~4 秒**（下限 / 上限）。
*
* 为什么是区间而不是固定值：固定间隔的方差≈0，在统计上就是「定时器特征」；
* 人的操作间隔是有方差的。同类项目 cuckoo-code（从未被风控）用的正是 2000~4000ms 随机区间。
*/
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 2e3;
const DEFAULT_MAX_REQUEST_INTERVAL_MS = 4e3;
/** 间隔可选的推荐档位（设置页的快捷按钮用）：[下限, 上限]。 */
const INTERVAL_PRESETS = [
	[1500, 2500],
	[2e3, 4e3],
	[5e3, 9e3]
];
/** 设置页滑块的取值上限。 */
const MAX_INTERVAL_MS = 3e4;
/** 节流设置文件：`${DSH_HOME || ~/.dsh}/web-login/gate.json`（插件自治，与凭证同目录）。 */
function gateSettingsPath() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "web-login", "gate.json");
}
/**
* 读设置页保存过的值。文件不存在/损坏都返回 undefined（回落到 cordis config）。
* 优先级：**设置页（文件）> cordis config > 内置默认** —— 设置页是用户的显式操作，
* 不该被配置文件里的旧值盖掉。
*/
function readGateSettings() {
	try {
		const file = gateSettingsPath();
		if (!existsSync(file)) return void 0;
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		const out = {};
		if (typeof parsed?.allowConcurrent === "boolean") out.allowConcurrent = parsed.allowConcurrent;
		if (Number.isFinite(parsed?.minRequestIntervalMs)) out.minRequestIntervalMs = clampInterval(Number(parsed.minRequestIntervalMs));
		if (Number.isFinite(parsed?.maxRequestIntervalMs)) out.maxRequestIntervalMs = clampInterval(Number(parsed.maxRequestIntervalMs));
		if (out.minRequestIntervalMs !== void 0 && out.maxRequestIntervalMs === void 0) out.maxRequestIntervalMs = out.minRequestIntervalMs;
		const cleanup = parsed?.sessionCleanup;
		if (cleanup === "immediate" || cleanup === "deferred" || cleanup === "keep") out.sessionCleanup = cleanup;
		return Object.keys(out).length > 0 ? out : void 0;
	} catch {
		return;
	}
}
function writeGateSettings(settings) {
	const file = gateSettingsPath();
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
/** 把任意输入规整成合法间隔：非数 → 默认，负 → 0，超上限 → 上限。 */
function clampInterval(value) {
	if (!Number.isFinite(value)) return DEFAULT_MIN_REQUEST_INTERVAL_MS;
	return Math.min(MAX_INTERVAL_MS, Math.max(0, Math.floor(value)));
}
function createRequestGate(options = {}) {
	let allowConcurrent = options.allowConcurrent === true;
	let minIntervalMs = clampInterval(options.minIntervalMs ?? (options.maxIntervalMs !== void 0 ? options.maxIntervalMs : 2e3));
	let maxIntervalMs = clampInterval(options.maxIntervalMs ?? (options.minIntervalMs !== void 0 ? options.minIntervalMs : 4e3));
	if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs;
	const random = options.random ?? Math.random;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const logger = options.logger;
	/** 队尾：每个调用完成后才 resolve，保证 FIFO 且「上一个没结束就不放行下一个」。 */
	let tail = Promise.resolve();
	let running = 0;
	let waiting = 0;
	let lastFinishedAt = 0;
	/** 是否已经有调用结束过 —— 首次调用不该被间隔规则拖住。 */
	let hasFinished = false;
	async function acquire(label = "call") {
		let releaseMine;
		const mine = new Promise((resolve) => {
			releaseMine = resolve;
		});
		const prev = tail;
		tail = prev.then(() => mine);
		waiting += 1;
		try {
			if (!allowConcurrent) {
				if (running > 0 || waiting > 1) logger?.debug?.(`deepseek-web: 「${label}」排队等待（前面还有 ${running} 个在跑 / ${waiting - 1} 个在等）`);
				await prev;
			}
		} finally {
			waiting -= 1;
		}
		if (maxIntervalMs > 0 && hasFinished) {
			const gap = nextGap();
			const waitMs = lastFinishedAt + gap - now();
			if (waitMs > 0) {
				logger?.info?.(`deepseek-web: 距上次请求不足 ${gap}ms（区间 ${minIntervalMs}~${maxIntervalMs}），等 ${Math.round(waitMs)}ms 再发「${label}」（防账号级限流）`);
				await sleep(waitMs);
			}
		}
		running += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			running -= 1;
			lastFinishedAt = now();
			hasFinished = true;
			releaseMine();
		};
	}
	/** 本次实际使用的间隔：区间内随机；上下限相等则固定。 */
	function nextGap() {
		if (maxIntervalMs <= minIntervalMs) return minIntervalMs;
		return Math.round(minIntervalMs + random() * (maxIntervalMs - minIntervalMs));
	}
	/** 会话清理策略不在本模块实现，只借用设置文件存储（由宿主读取后交给 cleaner）。 */
	let cleanupMode;
	function settings() {
		return {
			allowConcurrent,
			minRequestIntervalMs: minIntervalMs,
			maxRequestIntervalMs: maxIntervalMs,
			...cleanupMode ? { sessionCleanup: cleanupMode } : {}
		};
	}
	function configure(next) {
		if (typeof next.allowConcurrent === "boolean") allowConcurrent = next.allowConcurrent;
		if (next.minRequestIntervalMs !== void 0) minIntervalMs = clampInterval(Number(next.minRequestIntervalMs));
		if (next.maxRequestIntervalMs !== void 0) maxIntervalMs = clampInterval(Number(next.maxRequestIntervalMs));
		if (next.sessionCleanup !== void 0) cleanupMode = next.sessionCleanup;
		if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs;
		logger?.info?.(`deepseek-web: 请求节流设置已更新 —— ${allowConcurrent ? "允许并发（不推荐）" : "串行"} · 间隔 ${minIntervalMs}~${maxIntervalMs}ms（随机）`);
		return settings();
	}
	return {
		acquire,
		stats: () => ({
			running,
			waiting,
			lastFinishedAt
		}),
		settings,
		configure
	};
}
//#endregion
//#region src/webapi.ts
const DS_BASE = "https://chat.deepseek.com";
/** PoW 求解器 WASM 的已知默认地址（页面资源捕获失败时兜底）。 */
const DEFAULT_WASM_URL = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";
/** 浏览器 UA 兜底（捕获失败时使用）。 */
const FALLBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/**
* 组装一次网页端请求的头。
* 优先复用登录时捕获的浏览器真实头（extraHeaders），再用最新登录态覆盖
* authorization/cookie/指纹；user-agent 采用浏览器值（网页端接口需要浏览器指纹），
* DSH 归属信息通过 `x-deepseek-harness` 头显式声明。
*/
function buildDsHeaders(auth, referer) {
	const headers = {
		"user-agent": auth.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		accept: "application/json, text/plain, */*",
		"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
		"content-type": "application/json",
		origin: DS_BASE,
		referer: referer || `https://chat.deepseek.com/`,
		"x-client-platform": "web",
		"x-client-version": "2.0.0",
		"x-app-version": "2.0.0",
		...auth.extraHeaders ?? {}
	};
	headers.authorization = `Bearer ${auth.token}`;
	headers["content-type"] = "application/json";
	headers.origin = DS_BASE;
	headers.referer = referer || `https://chat.deepseek.com/`;
	headers["user-agent"] = auth.userAgent || headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
	headers["x-deepseek-harness"] = "deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness); provider=deepseek-web";
	delete headers["x-ds-pow-response"];
	if (auth.cookie) headers.cookie = auth.cookie;
	else delete headers.cookie;
	if (auth.hifDliq) headers["x-hif-dliq"] = auth.hifDliq;
	if (auth.hifLeim) headers["x-hif-leim"] = auth.hifLeim;
	return headers;
}
/** 网页端统一信封：code===0 为成功；非 0 时 msg 是给用户看的诊断。 */
function envelopeError(json) {
	if (!json || typeof json !== "object") return void 0;
	const code = json.code;
	if (typeof code === "number" && code !== 0) return {
		code,
		msg: String(json.msg ?? json.message ?? "unknown error")
	};
	const bizCode = json.data?.biz_code;
	if (typeof bizCode === "number" && bizCode !== 0) {
		const bizMsg = json.data?.biz_msg;
		return {
			code: bizCode,
			msg: bizMsg === void 0 || bizMsg === null || bizMsg === "" ? "unknown error" : String(bizMsg)
		};
	}
}
/**
* 账号被临时限制判定（实测 2026-09-11）：
*   {"code":0,"data":{"biz_code":5,"biz_msg":"user is muted",
*                     "biz_data":{"is_muted":1,"mute_until":1789173841.894}}}
* 这是**服务端对账号的限制**（免费网页端对高频自动化调用的静默限流），不是插件 bug：
* 登录态有效、建会话也成功，只有 completion 被拒。必须把解除时间明确告诉用户，
* 并且**不要空转重试** —— 否则每一轮都白发请求，还可能延长限制。
*/
function isMutedError(biz) {
	return biz?.code === 5 || /user\s+is\s+muted|account\s+is\s+muted/i.test(String(biz?.msg ?? ""));
}
/** 从响应信封里读出解除限制的时间（ms）；读不到返回 undefined。 */
function muteUntilMs(json) {
	const raw = json?.data?.biz_data?.mute_until;
	const seconds = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) return void 0;
	return Math.round(seconds * 1e3);
}
/** 被限制时的用户可读文案（带解除时间）。 */
function mutedMessage(untilMs) {
	if (untilMs === void 0) return "DeepSeek 网页端已临时限制本账号（user is muted），未给出解除时间。这期间任何网页模型调用都会失败；请等待解除，或改用官方 API key。";
	return `DeepSeek 网页端已临时限制本账号（user is muted）：预计 ${new Date(untilMs).toLocaleString("zh-CN", { hour12: false })} 解除，约 ${Math.max(1, Math.round((untilMs - Date.now()) / 6e4))} 分钟后。这期间任何网页模型调用都会失败（登录态本身有效、建会话也正常，只有发消息被拒）；请等待解除，或改用官方 API key。免费网页端对高频自动化调用会静默限流，刚跑过大量工具步骤的会话尤其容易被限。`;
}
/**
* 「同一账号同时只能生成一条」的并发拒绝（实测 2026-09-11：两个 DSH 窗口共用同一网页账号，
* 一个正在生成时另一个发请求即得此错：`A message is being generated, please try again later.`）。
* 它**不是封号**（封号是 `user is muted`），但也无法立刻成功 ——
* 归为可重试的 RATE_LIMIT，交由 dsh-llm-retry 稍后自动重发，而不是让整轮直接失败。
*/
function isBusyGenerating(message) {
	return /being generated|try again later|请稍后再试|稍后再试|正在生成/i.test(String(message ?? ""));
}
/**
* 连续节流的状态：被限一次就退避久一点，别在限流窗口里反复撞。
* （实测 2026-09-11 下午：同一个账号连续被限，5 次重试全落在窗口里 → 整轮失败。）
*/
/**
* 当前使用的 fetch 实现。
*
* 默认是 Node 的全局 fetch（undici）。宿主可以注入 **Electron 的 `net.fetch`** ——
* 后者走 Chromium 原生网络库，能带来与真实浏览器一致的 TLS / HTTP2 指纹。
* 为什么在意：实测 Node fetch 与 Chrome 的指纹差异是**结构性**的
* （JA4 的 h1 vs h2、Node 无 GREASE、cipher 55 个 vs 15 个、扩展集合完全不同）。
*
* 注意：Electron 的 utility 进程里 `require('electron')` 只暴露 `net` 与 `systemPreferences`
* （实测 2026-09-12），所以宿主只能注入 net.fetch，拿不到别的网络相关能力。
*/
let injectedFetch;
/**
* 实际发请求用的 fetch —— 刻意做成**每次现取**（`injectedFetch ?? fetch`），
* 而不是在模块加载那一刻把全局 fetch 固化下来。
*
* 原因（2026-09-12 实测踩到）：固化写法会让「模块加载之后再替换 globalThis.fetch」失效 ——
* 单测正是用这种方式打桩，结果请求绕过了桩件、**真的发到了线上**
* （拿回一个 INVALID_TOKEN，测试看着在验证错误分类，实际在打网络）。
*/
function activeFetch(input, init) {
	return (injectedFetch ?? fetch)(input, init);
}
/** 注入 fetch 实现；传 undefined 还原为 Node 全局 fetch。 */
function setFetchImpl(impl) {
	injectedFetch = impl;
}
/** 当前用的是注入实现还是 Node 原生（诊断用）。 */
function fetchImplKind() {
	return injectedFetch ? "injected" : "node";
}
let throttleStreak = 0;
let lastThrottleAt = 0;
/** 取下一次节流退避（ms）：20s 起、每次翻倍、上限 90s，并加 0~30% 抖动。 */
function throttleBackoffMs(now = Date.now()) {
	if (now - lastThrottleAt > 3e5) throttleStreak = 0;
	const base = Math.min(2e4 * 2 ** throttleStreak, 9e4);
	return base + Math.round(base * .3 * Math.random());
}
/** 记录一次节流；返回本次应给的退避（ms）。 */
function noteThrottled(now = Date.now()) {
	if (now - lastThrottleAt > 3e5) throttleStreak = 0;
	throttleStreak += 1;
	lastThrottleAt = now;
	return throttleBackoffMs(now);
}
/**
* 账号级节流：「发得太频繁」。
*
* 实测 2026-09-11 16:11（SSE error 事件，不是 HTTP 429）：
*   `消息发送过于频繁，请稍后重试`
* ⚠️ 注意它和上面那条**差一个字**：并发拒绝写的是「请稍后再**试**」，节流写的是「请稍后**重**试」。
* 之前只匹配前者，于是这条落到 PROVIDER_ERROR（**不可重试**）→ 整轮直接失败、只能手点「继续」。
*
* 与 `user is muted`（有明确解除时间）也不是一回事：节流是短时的，退避够久就能过去。
* 退避给 20s（并发那条只给 5s）：撞得越勤越可能延长限制。
*/
function isThrottled(message) {
	return /过于频繁|太频繁|操作频繁|too\s+many\s+requests|rate\s*limit|稍后重试|限流/i.test(String(message ?? ""));
}
/**
* 会话失效判定：服务端用 biz_msg 表达「这个 chat_session_id 不存在/无效」。
* 触发场景（实测）：请求发出前会话已被删除（旧版把删除排在建会话之后 1.5s，
* 而 PoW 求解 + 建连可能超过 1.5s），或服务端自行回收了闲置会话。
* 这类失败**可以透明恢复**：本插件每次调用都是全新会话、不依赖服务端历史 → 换个会话重发即可。
*/
function isInvalidSessionError(biz) {
	return /invalid\s+chat\s+session|chat\s+session\s+(?:not\s+found|expired|invalid)|chat_session_id[^\p{L}]{0,4}(?:无效|不存在|已过期|非法)|会话.{0,8}(?:无效|不存在|已过期)/iu.test(String(biz?.msg ?? ""));
}
/** 业务错误码 → 稳定错误码（40003/40001：授权失败）。 */
function bizErrorCode(code) {
	if (code === 40003 || code === 40001) return "AUTH";
	if (code === 429) return "RATE_LIMIT";
	return "PROVIDER_ERROR";
}
function bizErrorMessage(code, msg) {
	if (code === 40003 || code === 40001) return `DeepSeek 网页授权失败：${msg} —— 登录态已过期或无效，请到「设置 → DeepSeek 网页登录」重新登录`;
	return `DeepSeek 网页端错误（code ${code}）：${msg}`;
}
let wasmModuleCache = null;
/** 已验证可用/已发现的 WASM 地址（按凭证里记录的原值缓存，避免每次请求都探测）。 */
let resolvedWasmUrl = null;
async function isReachable(url, signal) {
	try {
		const resp = await activeFetch(url, {
			method: "GET",
			headers: { range: "bytes=0-0" },
			signal: signal ?? AbortSignal.timeout(1e4)
		});
		return resp.ok || resp.status === 206;
	} catch {
		return false;
	}
}
/** 从网页端首页/JS chunk 里发现当前构建的 sha3 wasm 地址（哈希随版本变化）。 */
async function discoverWasmUrl(signal) {
	try {
		const html = await (await activeFetch(`${DS_BASE}/`, { signal: signal ?? AbortSignal.timeout(15e3) })).text();
		const direct = html.match(/https?:\/\/[^"'\s]*sha3[_a-z0-9.]*\.wasm/i);
		if (direct) return direct[0];
		const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => match[1]).slice(0, 8);
		for (const src of scripts) {
			const url = src.startsWith("http") ? src : new URL(src, `${DS_BASE}/`).href;
			try {
				const found = (await (await activeFetch(url, { signal: AbortSignal.timeout(15e3) })).text()).match(/[^"'\s]*sha3[_a-z0-9.]*\.wasm/i);
				if (found) return found[0].startsWith("http") ? found[0] : new URL(found[0], url).href;
			} catch {}
		}
	} catch {}
}
/**
* 解析可用的 PoW WASM 地址：凭证记录值 → 已知默认值 → 页面发现。
* 结果按凭证原值缓存一次，避免每个请求都做探测。
*/
async function resolveWasmUrl(auth, signal) {
	const key = auth.wasmUrl || "";
	if (resolvedWasmUrl?.key === key) return resolvedWasmUrl.url;
	const candidates = [auth.wasmUrl, DEFAULT_WASM_URL].filter((url) => !!url);
	for (const url of candidates) if (await isReachable(url, signal)) {
		resolvedWasmUrl = {
			key,
			url
		};
		return url;
	}
	const discovered = await discoverWasmUrl(signal);
	if (discovered) {
		resolvedWasmUrl = {
			key,
			url: discovered
		};
		return discovered;
	}
	return auth.wasmUrl || "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";
}
async function loadWasmModule(wasmUrl) {
	if (wasmModuleCache?.url === wasmUrl) return wasmModuleCache.promise;
	const promise = (async () => {
		const resp = await activeFetch(wasmUrl, { signal: AbortSignal.timeout(15e3) });
		if (!resp.ok) throw new Error(`PoW WASM fetch failed (HTTP ${resp.status})`);
		return WebAssembly.compile(await resp.arrayBuffer());
	})();
	wasmModuleCache = {
		url: wasmUrl,
		promise
	};
	promise.catch(() => {
		if (wasmModuleCache?.url === wasmUrl) wasmModuleCache = null;
	});
	return promise;
}
/**
* 调用 DeepSeek 的 sha3_wasm_bg 求解 PoW。
* wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)；
* prefix = `${salt}_${expire_at}_`；返回 float64 答案（取整）。
*/
async function solvePoW(challenge, wasmUrl) {
	const module = await loadWasmModule(wasmUrl);
	const e = (await WebAssembly.instantiate(module, { wbg: {} })).exports;
	if (typeof e.wasm_solve !== "function" || typeof e.__wbindgen_export_0 !== "function" || !e.memory) throw new Error("PoW WASM exports missing (wasm_solve / __wbindgen_export_0 / memory)");
	const encoder = new TextEncoder();
	const cBytes = encoder.encode(challenge.challenge);
	const pBytes = encoder.encode(`${challenge.salt}_${challenge.expire_at}_`);
	const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
	const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
	new Uint8Array(e.memory.buffer).set(cBytes, cP);
	new Uint8Array(e.memory.buffer).set(pBytes, pP);
	const sp = e.__wbindgen_add_to_stack_pointer(-16);
	e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, Number(challenge.difficulty));
	const dv = new DataView(e.memory.buffer);
	const code = dv.getInt32(sp, true);
	const answer = dv.getFloat64(sp + 8, true);
	e.__wbindgen_add_to_stack_pointer(16);
	if (code === 0 || !Number.isFinite(answer) || answer <= 0) throw new Error(`PoW solve failed (code=${code})`);
	return Math.floor(answer);
}
/** 取得一次完成请求的 PoW 响应头值（base64 JSON）。 */
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
		throw new AdapterLlmError(`DeepSeek PoW challenge failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ""}`, httpErrorCode(resp.status), {
			status: resp.status,
			...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {}
		});
	}
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new AdapterLlmError("DeepSeek PoW challenge returned non-JSON", "MALFORMED_RESPONSE", { status: resp.status });
	}
	const biz = envelopeError(json);
	if (biz) throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status });
	const challenge = json?.data?.biz_data?.challenge;
	if (!challenge?.challenge || !challenge?.salt || !challenge?.signature) throw new AdapterLlmError("DeepSeek PoW challenge missing fields（登录态可能已过期，或被要求人机校验）", "MALFORMED_RESPONSE", { status: resp.status });
	const answer = await solvePoW(challenge, await resolveWasmUrl(auth, signal));
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
/** 上传一张图片，返回 file_id。`data` 为原始编码字节（png/jpeg/webp/gif）。 */
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
		resp = await activeFetch(`${DS_BASE}${targetPath}`, {
			method: "POST",
			headers,
			body: form,
			signal
		});
	} catch (error) {
		throw new AdapterLlmError(`DeepSeek 图片上传失败：${error?.message ?? error}`, "TRANSPORT", { cause: error });
	}
	const text = await resp.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = void 0;
	}
	if (!resp.ok) throw new AdapterLlmError(`DeepSeek 图片上传失败 (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ""}`, httpErrorCode(resp.status), { status: resp.status });
	const biz = envelopeError(json);
	if (biz) throw new AdapterLlmError(`DeepSeek 图片上传被拒（code ${biz.code}）：${biz.msg}`, bizErrorCode(biz.code), { status: resp.status });
	const fileId = json?.data?.biz_data?.id ?? json?.data?.id;
	if (typeof fileId !== "string" || !fileId) throw new AdapterLlmError("DeepSeek 图片上传未返回 file_id", "MALFORMED_RESPONSE", { status: resp.status });
	return {
		fileId,
		...input.name ? { name: input.name } : {}
	};
}
/** 新建一个网页端聊天会话，返回 chat_session_id。 */
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
		throw new AdapterLlmError(`DeepSeek session create failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ""}`, httpErrorCode(resp.status), {
			status: resp.status,
			...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {}
		});
	}
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new AdapterLlmError("DeepSeek session create returned non-JSON", "MALFORMED_RESPONSE", { status: resp.status });
	}
	const biz = envelopeError(json);
	if (biz) throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status });
	const id = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id;
	if (typeof id !== "string" || !id) throw new AdapterLlmError("DeepSeek session create missing id", "MALFORMED_RESPONSE", { status: resp.status });
	return id;
}
const DEFAULT_SESSION_CLEANUP = {
	mode: "deferred",
	delayMs: 9e4,
	batchSize: 8
};
function createSessionCleaner(options = {}) {
	const policy = {
		mode: options.policy?.mode ?? DEFAULT_SESSION_CLEANUP.mode,
		delayMs: Math.max(0, Math.floor(options.policy?.delayMs ?? DEFAULT_SESSION_CLEANUP.delayMs)),
		batchSize: Math.max(1, Math.floor(options.policy?.batchSize ?? DEFAULT_SESSION_CLEANUP.batchSize))
	};
	/** 策略切换时按模式给默认延迟/批量（immediate 用老参数）。 */
	function applyModeDefaults() {
		if (policy.mode === "immediate") {
			policy.delayMs = 1500;
			policy.batchSize = 1;
		} else if (policy.mode === "deferred" && policy.batchSize <= 1) {
			policy.delayMs = DEFAULT_SESSION_CLEANUP.delayMs;
			policy.batchSize = DEFAULT_SESSION_CLEANUP.batchSize;
		}
	}
	const doFetch = options.fetchImpl ?? fetch;
	const setT = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
	const clearT = options.clearTimeoutImpl ?? ((t) => clearTimeout(t));
	const logger = options.logger;
	let queue = [];
	let timer;
	/** 探测到服务端不接受批量删除后置位 —— 之后一律逐个删，不再浪费请求。 */
	let batchUnsupported = false;
	async function deleteOne(auth, sessionId) {
		try {
			await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
				method: "POST",
				headers: buildDsHeaders(auth),
				body: JSON.stringify({ chat_session_id: sessionId }),
				signal: AbortSignal.timeout(1e4)
			});
		} catch {}
	}
	async function flush() {
		if (timer !== void 0) {
			clearT(timer);
			timer = void 0;
		}
		const batch = queue;
		queue = [];
		if (batch.length === 0) return;
		if (batch.length > 1 && !batchUnsupported) try {
			const resp = await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
				method: "POST",
				headers: buildDsHeaders(batch[0].auth),
				body: JSON.stringify({ chat_session_ids: batch.map((b) => b.sessionId) }),
				signal: AbortSignal.timeout(15e3)
			});
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
			if (ok) {
				logger?.debug?.(`deepseek-web: 已批量清理 ${batch.length} 个临时会话（只用了 1 个请求）`);
				return;
			}
			batchUnsupported = true;
			logger?.debug?.("deepseek-web: 服务端不接受批量删除会话，之后改为逐个删除");
		} catch {}
		for (const item of batch) await deleteOne(item.auth, item.sessionId);
		logger?.debug?.(`deepseek-web: 已清理 ${batch.length} 个临时会话`);
	}
	function schedule(auth, sessionId) {
		if (policy.mode === "keep") return;
		queue.push({
			auth,
			sessionId
		});
		if (policy.mode === "deferred" && queue.length >= policy.batchSize) {
			flush();
			return;
		}
		if (timer === void 0) {
			timer = setT(() => {
				flush();
			}, policy.delayMs);
			timer?.unref?.();
		}
	}
	function configure(next) {
		const modeChanged = next.mode !== void 0 && next.mode !== policy.mode;
		if (next.mode !== void 0) policy.mode = next.mode;
		if (next.delayMs !== void 0) policy.delayMs = Math.max(0, Math.floor(next.delayMs));
		if (next.batchSize !== void 0) policy.batchSize = Math.max(1, Math.floor(next.batchSize));
		if (modeChanged) applyModeDefaults();
		if (policy.mode === "keep") flush();
		logger?.info?.(`deepseek-web: 会话清理策略已更新 —— ${policy.mode}` + (policy.mode === "deferred" ? `（攒 ${policy.batchSize} 个或 ${Math.round(policy.delayMs / 1e3)}s 后清理）` : ""));
		return { ...policy };
	}
	return {
		schedule,
		flush,
		pendingCount: () => queue.length,
		policy: () => ({ ...policy }),
		configure
	};
}
/** 默认清理器（immediate 语义，兼容旧调用方）。 */
const defaultCleaner = createSessionCleaner({ policy: {
	mode: "immediate",
	delayMs: 1500,
	batchSize: 1
} });
function scheduleDeleteSession(auth, sessionId) {
	defaultCleaner.schedule(auth, sessionId);
}
/** 验证登录态：优先 users/current，端点不存在时退回 PoW challenge 探活。 */
async function validateAuth(auth, signal) {
	try {
		const resp = await activeFetch(`${DS_BASE}/api/v0/users/current`, {
			headers: buildDsHeaders(auth),
			signal
		});
		if (resp.ok) {
			let json;
			try {
				json = await resp.json();
			} catch {
				json = void 0;
			}
			const bizError = envelopeError(json);
			if (bizError) return {
				ok: false,
				error: bizError.msg
			};
			const payload = json?.data?.biz_data ?? json?.data;
			const user = payload?.user ?? payload ?? {};
			const display = user?.email ?? user?.mobile ?? user?.phone ?? user?.username ?? user?.nickname ?? user?.name ?? "";
			return {
				ok: true,
				user: {
					...user?.id !== void 0 ? { id: String(user.id) } : {},
					...display ? { display: String(display) } : {}
				}
			};
		}
		if (resp.status === 404) {
			await createPowHeader(auth, "/api/v0/chat/completion", signal);
			return { ok: true };
		}
		return {
			ok: false,
			error: `users/current HTTP ${resp.status}`
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
function isReasoningType(type) {
	const t = type.toUpperCase();
	return t === "THINK" || t === "REASONING" || t === "THINKING";
}
/** 把字节流切成行（SSE 帧以 \n 分隔）。 */
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
			} catch {}
		}
	} else if (body?.[Symbol.asyncIterator]) for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		yield* drain();
	}
	if (buffer.length > 0) yield buffer.replace(/\r$/, "");
}
/**
* 网页端 completion 负载的解析状态机（可单测：handle 返回待 yield 的事件）。
*
* ⚠️ 正确性模型（2026-09 事故修复）：
*   真实事故：模型回答了完整一段，DSH 里只显示「，」「不上」「了一圈」这类 1~3 字碎片，
*   并伴随 EMPTY_RESPONSE 重试。根因是旧实现用「只增不减的 emitted 计数器」做去重，
*   而快照会把派生文本重置为更短的内容 —— 计数器被撑大后保持高位，后续只在文本长度
*   超过它时才吐字，于是前面的全丢、只剩余数的尾巴；余数为空又触发重试。
*
*   现在的规则：
*     ① **增量事件驱动发射**（fragment APPEND / -1/content / thinking_content / content / 裸 v）
*     ② **快照只做对账**：仅当候选文本是「已发射内容的严格延伸」时补差；
*        更短（过期快照）或分歧（服务端重排/回退）一律忽略，绝不重置已发射内容
*     ③ 快照永远不会让已发射内容变小 → 不会丢字、不会因此触发假 EMPTY_RESPONSE
*/
function createSseState() {
	const fragments = [];
	/** fragments 派生文本（仅用于快照对账候选）。 */
	let fragmentsText = "";
	let fragmentsThinking = "";
	/** 直连格式的派生文本（仅用于快照对账候选）。 */
	let directText = "";
	let directThinking = "";
	/** 已发射的规范流（只增不减）。 */
	let outText = "";
	let outThinking = "";
	let divergences = 0;
	let sink = null;
	let pendingFinish;
	let sawData = false;
	const emit = (out, kind, delta) => {
		if (!delta) return;
		if (kind === "text") outText += delta;
		else outThinking += delta;
		out.push({
			kind,
			text: delta
		});
	};
	const emitText = (out, delta) => emit(out, "text", delta);
	const emitThinking = (out, delta) => emit(out, "thinking", delta);
	/** 快照对账：只在候选是严格延伸时补差；过期/分歧忽略（宁可漏一次快照，也不吐乱码或丢字）。 */
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
	/** 重建 fragments 派生文本（快照覆盖时用）。 */
	const rebuildFragmentText = () => {
		fragmentsText = "";
		fragmentsThinking = "";
		for (const fragment of fragments) if (isReasoningType(fragment.type)) fragmentsThinking += fragment.content;
		else fragmentsText += fragment.content;
	};
	/** 快照：整表替换 + 对账（不直接发射）。 */
	const replaceFragments = (list) => {
		fragments.length = 0;
		for (const f of list) if (f && typeof f === "object" && typeof f.content === "string") fragments.push({
			type: String(f.type ?? "RESPONSE"),
			content: f.content,
			emitted: 0
		});
		rebuildFragmentText();
		sink = fragments.length > 0 ? "fragments" : null;
	};
	/** 增量：追加 fragment（其 content 属于新内容 → 直接发射）。 */
	const appendFragments = (incoming, out) => {
		const list = Array.isArray(incoming) ? incoming : incoming !== void 0 ? [incoming] : [];
		for (const f of list) {
			if (!f || typeof f !== "object" || typeof f.content !== "string") continue;
			const fragment = {
				type: String(f.type ?? "RESPONSE"),
				content: f.content,
				emitted: 0
			};
			fragments.push(fragment);
			if (isReasoningType(fragment.type)) {
				fragmentsThinking += fragment.content;
				emitThinking(out, fragment.content);
			} else {
				fragmentsText += fragment.content;
				emitText(out, fragment.content);
			}
		}
		sink = fragments.length > 0 ? "fragments" : null;
	};
	/** 增量：续写最后一个 fragment。 */
	const appendToLastFragment = (text, out) => {
		const fragment = fragments[fragments.length - 1];
		if (!fragment) {
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
	/** 增量：裸续段按当前 sink 归属。 */
	const appendSink = (text, out) => {
		if (sink === "thinking") {
			directThinking += text;
			emitThinking(out, text);
		} else if (sink === "content") {
			directText += text;
			emitText(out, text);
		} else if (sink === "fragments") appendToLastFragment(text, out);
	};
	return {
		/** 负载处理（增量直接发射；快照只对账）。 */
		handlePayload(d, eventName) {
			const out = [];
			sawData = true;
			if (d && typeof d === "object" && d.v && typeof d.v === "object" && d.v.response && typeof d.v.response === "object") {
				const response = d.v.response;
				if (Array.isArray(response.fragments)) {
					replaceFragments(response.fragments);
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
				if (response.finish_reason !== void 0 && response.finish_reason !== null) pendingFinish = String(response.finish_reason);
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
					event.retryAfterMs = noteThrottled();
					event.rateLimitKind = "throttled";
				}
				out.push(event);
				return out;
			}
			if (eventName === "toast") {
				const message = d && typeof d === "object" ? d.content ?? d.message ?? JSON.stringify(d) : String(d);
				const full = `DeepSeek toast: ${String(message).slice(0, 200)}`;
				const event = {
					kind: "error",
					message: full
				};
				if (isBusyGenerating(full)) {
					event.code = "RATE_LIMIT";
					event.retryAfterMs = 5e3;
					event.rateLimitKind = "concurrent";
				} else if (isThrottled(full)) {
					event.code = "RATE_LIMIT";
					event.retryAfterMs = noteThrottled();
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
			if (typeof path === "string") switch (path) {
				case "response/fragments":
					appendFragments(value, out);
					return out;
				case "response/fragments/-1/content":
					if (typeof value === "string") {
						appendToLastFragment(value, out);
						sink = "fragments";
					}
					return out;
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
				case "response/status":
					if (typeof value === "string") {
						out.push({
							kind: "status",
							value
						});
						if (value === "FINISHED") pendingFinish = pendingFinish ?? "FINISHED";
					}
					return out;
				case "response":
					if (Array.isArray(value)) {
						for (const op of value) if (op && typeof op === "object" && op.p === "fragments" && op.o === "APPEND" && op.v !== void 0) appendFragments(op.v, out);
					}
					return out;
				default: return out;
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
			return sawData ? [{
				kind: "finish",
				reason: pendingFinish
			}] : [];
		},
		/** 诊断：已发射正文/思考长度与快照分歧次数（单测与排查用）。 */
		stats() {
			return {
				text: outText,
				thinking: outThinking,
				divergences
			};
		}
	};
}
/** 解析 /chat/completion 的 SSE 字节流，产出增量文本/思考事件。 */
async function* parseWebSse(body) {
	const state = createSseState();
	let eventName = "";
	for await (const line of iterateLines(body)) {
		if (line.length === 0) {
			eventName = "";
			continue;
		}
		if (line.startsWith(":")) continue;
		if (line.startsWith("event:")) {
			eventName = line.slice(6).trim();
			continue;
		}
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (data === "[DONE]") {
			for (const event of state.finish()) yield event;
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(data);
		} catch {
			continue;
		}
		for (const event of state.handle(parsed, eventName)) yield event;
		eventName = "";
	}
	for (const event of state.finish()) yield event;
}
const defaultTransport = {
	createSession: createChatSession,
	powHeader: createPowHeader
};
/**
* 打开一次 completion 请求（建会话 + PoW + 发送），返回可用的会话与响应。
*
* 非 SSE 响应（HTTP 200 上裹着业务错误信封）在这里统一裁决：
*  - 会话失效（invalid chat session id）→ **换一个新会话透明重试一次**（用户无感）；
*  - 其它业务错误 → 按业务码抛出（AUTH / RATE_LIMIT / PROVIDER_ERROR…）。
*/
async function openCompletion(auth, params, signal, transport) {
	let lastFailure;
	for (let attempt = 0; attempt < 2; attempt++) {
		const sessionId = await transport.createSession(auth, signal);
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
					parent_message_id: null,
					prompt: params.prompt,
					ref_file_ids: params.refFileIds ?? [],
					thinking_enabled: params.thinkingEnabled,
					search_enabled: params.searchEnabled ?? false,
					model_type: params.modelType,
					action: null,
					preempt: false
				}),
				signal
			});
		} catch (error) {
			if (params.signal?.aborted) throw new AdapterLlmError("DeepSeek web request aborted by caller", "ABORTED", { cause: error });
			throw new AdapterLlmError(`DeepSeek web request failed: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
		}
		if (!resp.ok) {
			const text = await resp.text().catch(() => "");
			const code = httpErrorCode(resp.status);
			const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
			const hint = code === "AUTH" ? " —— 网页登录态可能已过期，请到「设置 → DeepSeek 网页登录」重新登录" : code === "RATE_LIMIT" ? " —— 网页端频控（免费额度），稍后重试即可" : "";
			params.onDeleteSession?.(sessionId);
			throw new AdapterLlmError(`DeepSeek web completion failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ""}${hint}`, code, {
				status: resp.status,
				...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {},
				cause: new Error(text)
			});
		}
		if (!resp.body) {
			params.onDeleteSession?.(sessionId);
			throw new AdapterLlmError("DeepSeek web completion returned no body", "EMPTY_RESPONSE");
		}
		const contentType = String(resp.headers.get("content-type") ?? "");
		if (contentType.includes("text/event-stream")) return {
			sessionId,
			resp
		};
		const text = await resp.text().catch(() => "");
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {}
		const biz = envelopeError(parsed);
		const muted = isMutedError(biz);
		const busy = !muted && !!biz && isBusyGenerating(biz.msg);
		const untilMs = muteUntilMs(parsed);
		const failure = biz ? new AdapterLlmError(muted ? mutedMessage(untilMs) : busy ? "DeepSeek 网页端同一账号同时只能生成一条消息（另一个窗口/标签页正在用同一账号生成）。这一步会自动重试；若两个窗口都要用网页模型，建议其中一个换 provider 或换账号。" : bizErrorMessage(biz.code, biz.msg), muted || busy ? "RATE_LIMIT" : isInvalidSessionError(biz) ? "TRANSPORT" : bizErrorCode(biz.code), {
			status: resp.status,
			...muted && untilMs !== void 0 ? { providerRetryAfterMs: Math.max(0, untilMs - Date.now()) } : {},
			...busy ? { providerRetryAfterMs: 5e3 } : {}
		}) : new AdapterLlmError(`DeepSeek 网页端返回了非流式响应（content-type: ${contentType || "unknown"}）：${text.slice(0, 200)}`, "MALFORMED_RESPONSE", { status: resp.status });
		params.onDeleteSession?.(sessionId);
		if (attempt === 0 && biz && isInvalidSessionError(biz)) {
			lastFailure = failure;
			continue;
		}
		throw failure;
	}
	throw lastFailure ?? new AdapterLlmError("DeepSeek 网页端无法建立可用会话", "PROVIDER_ERROR");
}
/**
* 发起一次网页版完成请求并流式产出事件；会话在**流结束之后**尽力删除。
*
* ⚠️ 删除时机是这个模块最容易被写错的地方（2026-09-11 实测故障）：
* 旧实现把 `onDeleteSession` 放在**建会话之后立刻**调用，而它内部是「延迟 1.5s 删除」，
* 于是会话可能在 completion 请求发出之前就被自己删掉 —— 若 PoW 求解 + 建连超过 1.5s，
* 服务端回
*   {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id"}}
* 更隐蔽的是「生成进行到一半会话消失」，服务端可能直接掐断流 —— 表现就是回答说半句就停、
* 工具调用没收全（正是我们一直在追的那类截断）。
* 现在删除只发生在 finally（流正常结束、报错或调用方中止都算），会话在整个请求期间都活着。
*/
async function* streamWebCompletion(auth, params, transport = defaultTransport) {
	const idle = params.idleTimeoutMs ?? 12e4;
	const controller = new AbortController();
	const { sessionId, resp } = await openCompletion(auth, params, params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal, transport);
	let timer = null;
	let settled = false;
	let fireIdle = () => {};
	const idlePromise = new Promise((_, reject) => {
		fireIdle = reject;
	});
	const armIdle = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			if (settled) return;
			controller.abort("idle timeout");
			fireIdle(new AdapterLlmError(`DeepSeek web stream idle timeout after ${idle}ms`, "TIMEOUT"));
		}, idle);
		timer.unref?.();
	};
	armIdle();
	try {
		const iterator = parseWebSse(resp.body)[Symbol.asyncIterator]();
		while (true) {
			const result = await Promise.race([iterator.next(), idlePromise]);
			armIdle();
			if (result.done) break;
			yield result.value;
		}
	} catch (error) {
		if (error instanceof AdapterLlmError) throw error;
		if (params.signal?.aborted) throw new AdapterLlmError("DeepSeek web stream aborted by caller", "ABORTED", { cause: error });
		throw new AdapterLlmError(`DeepSeek web stream failed: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
	} finally {
		settled = true;
		if (timer) clearTimeout(timer);
		try {
			controller.abort("stream consumer stopped");
		} catch {}
		params.onDeleteSession?.(sessionId);
	}
}
//#endregion
//#region src/protocol.ts
/**
* 提示词协议层：
*  1) 把 DSH 的消息词汇（system / user / assistant / tool-result / reasoning / tool-call）
*     序列化成网页端可吃的单段 prompt（网页 API 只有 `prompt` 字符串，无 tools 字段）。
*  2) 工具调用桥：网页模型没有原生 function calling，改用「JSON 协议 + 流式解析」——
*     指令要求模型只输出 {"tool_calls":[{"name":…,"arguments":{…}}]}，
*     本模块在流式文本上做 hold-back 扫描，命中即转成 tool-call 块，不命中则原样透传正文。
*/
const MAX_DESCRIPTION_CHARS = 400;
const MAX_TOOLS_SECTION_CHARS = 24e3;
const HOLD_BACK_CHARS = 24;
const MAX_CAPTURE_CHARS = 262144;
/** 工具调用协议指令（固定文本，进 prompt 前缀，保持前缀缓存友好）。 */
const TOOL_PROTOCOL_INSTRUCTIONS = `# Tool Calling Protocol

You can call tools to complete the user's task. When you need a tool, output ONLY a single JSON object, with no other text before or after it:

{"tool_calls":[{"name":"<tool-name>","arguments":{<json-arguments>}}]}

Rules:
1. Put every tool you want to run in the "tool_calls" array (usually exactly one; a batch is allowed).
2. Stop immediately after that JSON object. The runner executes the call(s) and returns the results to you as the next message.
3. Never fabricate, guess, or simulate tool output — always wait for the real result.
4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable. Close every brace: the call object and its "arguments" object each need their OWN closing "}" — one missing "}" makes the whole batch unparsable and the call will be discarded.
5b. Two things break the JSON most often — check them before you emit:
   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. Get-ChildItem "$env:USERPROFILE\\.dsh". Every such inner double quote MUST be escaped as \\" inside the JSON string. An unescaped one ends the string early and discards the whole call.
   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. When a command needs several statements, join them with ";" on ONE line, or use \\n escapes — do not paste them as actual newlines. Prefer single quotes inside commands to reduce escaping.
6. Do NOT use XML/HTML-like markup such as <tool_calls>, <invoke>, <parameter>, <|DSML|>, or any fenced variant of them. The JSON object above is the ONLY accepted format; markup text would be shown to the user as broken output instead of running the tool.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result …]" blocks, tool output, or the current prompt. Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry — measured case: a model emitted 15 replayed calls inside one 8152-char payload, and every one of them had to be thrown away.
9. Keep each batch SMALL — at most 3 calls, and prefer exactly 1. If you need more, send them in successive steps. Long payloads are the ones that most often come out malformed.
10. Each call must be able to run on its own: no shared shell variables across calls, no dependence on another call in the same batch.`;
function truncate(text, max) {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3)}...`;
}
/** 渲染工具目录（含 JSON Schema）。 */
function buildToolSection(tools) {
	if (!tools || tools.length === 0) return "";
	const parts = ["", "## Available tools"];
	let budget = MAX_TOOLS_SECTION_CHARS;
	for (const tool of tools) {
		let schemaText = "";
		try {
			schemaText = JSON.stringify(tool.parameters ?? {});
		} catch {
			schemaText = "{}";
		}
		const block = [
			"",
			`### ${tool.name}`,
			truncate(String(tool.description ?? "").replace(/\s+/g, " ").trim(), MAX_DESCRIPTION_CHARS),
			`Parameters (JSON Schema): ${schemaText}`
		].join("\n");
		if (budget - block.length < 0) {
			parts.push("\n(remaining tools omitted for length)");
			break;
		}
		budget -= block.length;
		parts.push(block);
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
function countImages(blocks) {
	let count = 0;
	for (const block of blocks ?? []) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "image") count += 1;
		else if (block.type === "tool-result" && Array.isArray(block.content)) count += countImages(block.content);
	}
	return count;
}
/** 按出现顺序收集消息里的图片附件引用（含 tool-result 内嵌图片）。 */
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
/** 把一条 assistant 消息里的 tool-call 块渲染回协议 JSON（供历史学习格式）。 */
function renderToolCalls(blocks) {
	const calls = (blocks ?? []).filter((block) => block?.type === "tool-call");
	if (calls.length === 0) return null;
	const payload = { tool_calls: calls.map((call) => {
		let args = {};
		try {
			args = call.arguments ? JSON.parse(call.arguments) : {};
		} catch {
			args = { _raw: String(call.arguments ?? "") };
		}
		return {
			name: String(call.name ?? ""),
			arguments: args
		};
	}) };
	return JSON.stringify(payload);
}
/** 中间截断：保留开头（任务/协议）与结尾（最近回合），并把省略标记计入预算。 */
function truncateMiddle(text, maxChars, tailRatio = .7) {
	if (text.length <= maxChars) return text;
	const budget = Math.max(0, maxChars - 64);
	const tail = Math.floor(budget * tailRatio);
	const head = Math.max(0, budget - tail);
	const marker = `\n\n...[${text.length - head - tail} chars omitted]...\n\n`;
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}
/**
* 序列化为网页端单段 prompt。
* 结构：system → 工具协议与目录 → 对话转写（User:/Assistant:/[Tool Result]）。
*/
function serializePrompt(options) {
	const maxChars = options.maxChars ?? 12e4;
	const system = String(options.system ?? "").trim();
	const toolSection = buildToolSection(options.tools);
	const protocol = toolSection ? `\n\n${TOOL_PROTOCOL_INSTRUCTIONS}${toolSection}` : "";
	const lines = [];
	for (const message of options.messages ?? []) {
		if (!message || typeof message !== "object") continue;
		const blocks = Array.isArray(message.content) ? message.content : [];
		if (message.role === "system") {
			const text = flattenText(blocks).join("");
			if (text.trim()) lines.push(`[System]\n${text}`);
			continue;
		}
		if (message.role === "assistant") {
			const text = flattenText(blocks).join("");
			const renderedCalls = renderToolCalls(blocks);
			if (renderedCalls) lines.push(`Assistant: ${renderedCalls}`);
			else if (text.trim()) lines.push(`Assistant: ${text}`);
			continue;
		}
		const toolResults = blocks.filter((block) => block?.type === "tool-result");
		const text = flattenText(blocks.filter((block) => block?.type !== "tool-result")).join("");
		const images = countImages(blocks);
		if (text.trim() || toolResults.length === 0 && images === 0 || images > 0) {
			const imageNote = images > 0 ? `\n${Array.from({ length: images }, () => "[image attached]").join(" ")}` : "";
			lines.push(`User: ${text}${imageNote}`);
		}
		for (const result of toolResults) {
			const body = flattenText(result.content).join("") || "(no output)";
			const errorMark = result.isError ? " [ERROR]" : "";
			lines.push(`[Tool Result${errorMark} for ${String(result.toolCallId ?? "")}]\n${body}`);
		}
	}
	const transcript = lines.join("\n\n");
	const head = system ? `${system}${protocol}` : protocol.trim();
	const merged = transcript ? `${head}\n\n---\n\n${transcript}` : head;
	if (merged.length <= maxChars) return merged;
	const headBudget = Math.min(head.length, Math.floor(maxChars * .45));
	const boundedHead = head.length <= headBudget ? head : truncateMiddle(head, headBudget, .85);
	return `${boundedHead}\n\n---\n\n${truncateMiddle(transcript, Math.max(1e3, maxChars - boundedHead.length - 8), .7)}`;
}
/** 完整 JSON 调用标记：{"tool_calls": 或 {"tool_call": （允许空白）。 */
const MARKER_RE = /\{\s*"tool_calls?"\s*:/;
/**
* XML 风格调用标记（实测：思考模式下模型偶尔改用这套标记，形如
* `<tool_calls><invoke name="read"><parameter name="file_path">…</parameter></invoke></tool_calls>`；
* 亦兼容 DeepSeek 自家的 DSML 前缀与 `dsml-` 连字符变体）。
*
* ⚠️ 2026-09-10 实测泄漏样本（真正的乱码来源）：模型把 DSML 前缀写成**重复的全角竖线**，
* 且包裹标签名退化成 `calls`：
*   `<` + `｜｜` + `DSML` + `｜｜` + ` ` + `calls>`
* 旧写法只容忍单个竖线（`[|｜]`），于是 `<` 后吃掉一个 `｜` 就要求紧跟 `DSML`，
* 却撞上第二个 `｜` → 整个标记认不出来 → 不进捕获态 → 原样进正文 → GUI 渲染成乱码。
* 现在竖线按 `+` 容忍（含全角/半角混用），并把 `calls` 也列入包裹标签名。
*/
const DSML_PREFIX = "(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?";
const WRAPPER_NAMES = "tool_calls|tool_call|function_calls|calls";
const XML_STARTER_RE = new RegExp(`<\\s*${DSML_PREFIX}(?:dsml-)?(${WRAPPER_NAMES}|invoke)\\b`, "i");
/** 代码围栏收尾（模型常把调用块放进 ``` 里）。 */
const FENCE_TAIL_RE = /\n?[ \t]*```[a-zA-Z0-9]*[ \t]*\n?$/;
const FENCE_HEAD_RE = /^[ \t]*\n?```[ \t]*\n?/;
/**
* 开/收标签前缀（宽容写法）。严格解析与宽容解析**必须共用同一套**，否则会出现
* 「findXmlToolCallEnd 认得出收尾、parseXmlToolCalls 认不出 invoke」→ 整块被降级成正文泄漏。
* 覆盖：`< invoke`（标签名带空白）、单/重复竖线的 DSML 前缀（含全角）、`<dsml-invoke>`。
*/
const TAG_OPEN_PREFIX = `<\\s*${DSML_PREFIX}(?:dsml-)?`;
const TAG_CLOSE_PREFIX = `<\\/\\s*${DSML_PREFIX}(?:dsml-)?`;
const XML_CLOSE_NAMES = `parameter|invoke|${WRAPPER_NAMES}`;
/**
* 归一化 DSML 噪声 → 标准标签。
* 竖线支持**重复与全角**（实测样本是双全角竖线），并连带吃掉其后的空白，
* 让标签名紧跟在 `<` 之后（`<` + 前缀 + ` ` + `invoke` → `<invoke`）。
*/
function normalizeDsml(text) {
	return text.replace(new RegExp(`<(/?)${DSML_PREFIX}`, "gi"), "<$1").replace(/<\s*dsml-/gi, "<").replace(/<\/\s*dsml-/gi, "</");
}
/**
* JSON 调用标记前缀（用于跨包 hold-back 判断）。
* ⚠️ 2026-09 事故：真实分块会把标记切成 `{"tool` + `_calls":[{"name":…` 两半。
* 旧实现比较时多拼了一个引号（`{'{"' + body}`，而 body 已含前引号 → `{""tool`），
* 于是「末尾是潜在前缀」永远判 false → 半截标记被当正文吐出去、后半个再也拼不回完整标记
* → 整个 JSON 泄漏成正文。修复见 partialMarkerSuffixLength。
*/
const JSON_MARKER_STARTERS = ["{\"tool_calls\"", "{\"tool_call\""];
/** XML 标记前缀（用于跨包 hold-back 判断）。`calls` 是实测出现的退化包裹名。 */
const XML_MARKER_STARTERS = [
	"<tool_calls",
	"<tool_call",
	"<function_calls",
	"<calls",
	"<invoke",
	"<dsml-tool_calls",
	"<dsml-invoke"
];
/**
* 判断 text 末尾是否是（可能的）标记前缀 —— 决定是否 hold back。
* @returns 需要保留在缓冲区里的尾部字符数（0 = 无需保留）
*/
function partialMarkerSuffixLength(text) {
	const from = Math.max(0, text.length - 32);
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
		return JSON_MARKER_STARTERS.some((starter) => starter.startsWith(`{${body}`)) ? held : 0;
	}
	if (normalized.startsWith("<")) {
		if (XML_STARTER_RE.test(normalized)) return 0;
		const lower = normalized.toLowerCase().replace(/\s+/g, "");
		return XML_MARKER_STARTERS.some((starter) => starter.startsWith(lower)) ? held : 0;
	}
	return 0;
}
/** 从 index 0 起抽取一个配平的 JSON 对象；不完整返回 null。 */
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
		if (ch === "\"") {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return {
				json: text.slice(0, i + 1),
				end: i + 1
			};
		}
	}
	return null;
}
/** 读取一个 XML 属性值（支持双引号/单引号/裸值）。 */
function readAttr(attrs, name) {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>/]+))`, "i").exec(attrs);
	if (!match) return void 0;
	return match[1] ?? match[2] ?? match[3];
}
/**
* 宽容 JSON 解析。实测场景：模型把 Windows 路径写成 `"D:\apps\DSH"`（单个反斜杠，
* 非法转义），JSON.parse 直接抛错 → 工具调用解析失败、整段标记被当正文吐给用户。
* 先试原样；失败则修补：非法转义补成字面反斜杠、字符串内裸换行转义、去尾逗号。
*/
function parseJsonLenient(text) {
	try {
		return JSON.parse(text);
	} catch {}
	for (const candidate of jsonRepairCandidates(text)) try {
		const parsed = JSON.parse(candidate);
		if (parsed !== void 0) return parsed;
	} catch {}
}
/**
* 依次尝试的修复候选（只在原样解析失败时使用）。顺序有讲究：
*
* 先跑「路径尾反斜杠」启发式（`"…\app.asar\"` 里的 `\"` 是转义引号 → 字符串不终止，
* 必须在切分字符串**之前**修，否则整个字符串范围都会错），再跑字符串级修复。
*
* 字符串级修复的智能规则：若某字符串里出现**非法转义**（如 `\A`），说明模型是「原样写出」
* 未转义的反斜杠 —— 此时该字符串内所有反斜杠都按字面处理，否则 `\resources` 里的 `\r`
* 会被 JSON 当成回车，路径被悄悄改坏（实测用户样本 #2）。
* 若字符串里没有非法转义，则只做保守修补（保留 `\\`、`\"` 等合法转义）。
*/
/**
* 修复「**字符串值里出现未转义的双引号**」——实测最高频的坏法，也是「自动停止」的元凶。
*
* 实测（2026-09-10 23:27:13，deepseek-reasoner）：命令天然写作
*   `Get-ChildItem "$env:USERPROFILE\.dsh" | Select-Object Name`
* 模型把这串里的引号**原样**塞进 JSON 字符串 → `Expected ',' or '}' after property value`
* → 整条调用被丢弃 → 那一轮没有工具调用 → agent loop 认为回合正常结束
* → 用户看到的症状就是「说半句就停了」。
*
* 判据（对 JSON 语法是稳的）：在字符串内部遇到双引号时，向后跳过空白看一个字符 ——
* 只有它还是 `,` `}` `]`（或文本结束）时才说明字符串真的结束；否则该引号是内容里的字面引号。
*
* ⚠️ 冒号必须**按位置**区别对待：`"` 后面跟 `:` 只在「键的位置」才是结构符。
* 若把值里的 `"` + `:` 也当成结束，那么命令内嵌 JSON 时会误判，例如
*   `node -e "const o={"a":1}"`
* 里的 `"a"` 会被当成字符串收尾 → 后面全部错位 → 整条调用照样被丢弃（我第一版就踩了这个洞）。
* 因此这里跟踪「进入字符串时是否处于键位置」（上一结构符是 `{` / `,` / `[`）。
*/
function escapeInnerQuotes(text) {
	let out = "";
	let inString = false;
	let keyPosition = false;
	let lastStructural = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!inString) {
			if (ch === "\"") {
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
		if (ch === "\"") {
			let j = i + 1;
			while (j < text.length && " 	\n\r".includes(text[j])) j++;
			const next = text[j];
			if (next === "," || next === "}" || next === "]" || next === void 0 || next === ":" && keyPosition) {
				inString = false;
				lastStructural = next === void 0 ? "" : next;
				out += ch;
			} else out += "\\\"";
			continue;
		}
		out += ch;
	}
	return out;
}
/**
* ⚠️ 刻意**不提供**「更激进的猜测」候选（例如把 `"` 后跟 `}` 也一律当内容）。
* 试过，结果是灾难：外层键的收尾引号也会被转义 → 整个载荷被搅坏；
* 而且即使侥幸解析成功，也可能交出一条**被改坏的命令**并真的执行它。
* 嵌套引号（`node -e "console.log({"k":"v"})"`）在原理上无法靠单字符前瞻消歧 ——
* 这种极端用例的正确处置是**拒绝 + 重试**（重试后模型通常会改用更简单的写法），
* 而不是猜。宁可拒绝，也绝不交出坏命令。
*/
function* jsonRepairCandidates(text) {
	const pathTail = (value) => value.replace(/([A-Za-z]:[^"]*?)\\"(?=[,}\]\s])/g, "$1\\\\\"");
	for (const base of [text, ...structuralRepairCandidates(text)]) for (const variant of [base, escapeInnerQuotes(base)]) {
		yield repairJsonText(pathTail(variant), { mode: "smart" });
		yield repairJsonText(variant, { mode: "smart" });
		yield repairJsonText(pathTail(variant), { mode: "conservative" });
		yield repairJsonText(variant, { mode: "conservative" });
	}
}
/**
* 结构性修复候选：模型写的 tool_calls JSON 常有**括号结构错误**（漏写闭合、数组/对象闭合顺序错乱）。
*
* 已覆盖的实测形态：
*  - 每个调用对象少写一个 `}`（2026-09 事故 #4：批量 3 个调用各少一个）
*  - arguments 写成数组、且 `]`/`}` 顺序错乱（2026-09-11 事故 #5：
*    `{"tool_calls":[{"name":"pwsh","arguments":[{…}}]}`  ← args 数组没闭合就写了 `}`）
*  - 外层对象少写收尾 `}`
*
* 做法（rebuildToolCallJson）：栈引导重排 —— 遇到不匹配的闭合符时，**插入缺失的容器闭合**
* 使其匹配。只插入括号，绝不改写字符串内容。配合 parseToolCallJson 的
* 「arguments 数组 → 取唯一元素」解包，这类调用可以完整恢复并执行。
*/
function* structuralRepairCandidates(text) {
	if (!/^\s*\{\s*"tool_calls?"\s*:\s*\[/.exec(text)) return;
	const rebuilt = rebuildToolCallJson(text);
	if (rebuilt && rebuilt !== text) yield rebuilt;
}
/**
* 栈引导的 tool_calls JSON 重排（只在严格解析失败后使用，**只插入括号、绝不改写字符串内容**）。
*
* 规则：
*  1) 正常的开/闭符合配 → 原样输出并弹栈；
*  2) 闭合符与栈顶不匹配 → 在其前**插入**能使它匹配的闭合序列（有上限保护），再正常闭合；
*  3) `,` 出现在 tool_calls 数组的元素层级、而栈顶是未闭合的调用对象 → 先补 `}`
*     （实测形态：批量调用每个元素都少写一个 `}`）；
*  4) 收尾按栈补齐剩余闭合。
*
* ⚠️ 安全闸门：扫描结束时若**仍在字符串内**（流被服务端 60s 上限截断的典型特征）→ 返回 null。
* 此时补括号会得到一条**被截断的命令**并真的执行它 —— 宁可拒绝（→ 重试），也不执行半条命令。
*/
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
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") {
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
/**
* 修复常见 JSON 语法问题。
* @param options.mode - `smart`（默认）：字符串内出现非法转义时，把该字符串所有反斜杠按字面
*   处理（模型原样写路径的常态，避免 `\r`/`\n`/`\t` 被误当转义）；
*   `conservative`：只补非法转义，其余原样保留。
*/
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
			if (ch === "\"") {
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
		if (ch === "\"") {
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
/** 字符串里是否存在「非法转义」（判断模型是否原样写出了未转义的反斜杠）。 */
function hasInvalidEscape(body) {
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== "\\") continue;
		const next = body[i + 1];
		if (next === void 0) return true;
		if (!"\"\\/bfnrtu".includes(next)) return true;
		i += 1;
	}
	return false;
}
/**
* 把「模型原样写出的字符串」按字面语义重新转义。
* 逐字符处理以避免正则的重复加倍：`\\` 保留为一个字面反斜杠、`\"` 保留为转义引号，
* 其余单个反斜杠一律补成 `\\`（关键：让 `\resources` 里的 `\r` 不再变成回车）。
*/
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
		if (next === "\"") {
			out += "\\\"";
			i += 1;
			continue;
		}
		out += "\\\\";
	}
	return out;
}
/** 只把「非法转义」补成字面反斜杠，合法转义原样保留。 */
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
		if ("\"\\/bfnrtu".includes(next)) {
			out += ch + next;
			i += 1;
			continue;
		}
		out += "\\\\";
	}
	return out;
}
/** 去掉 CDATA 包装并按 JSON 解析值（解析不出就当字符串）。 */
function parseParameterValue(raw) {
	let text = raw.trim();
	const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(text);
	if (cdata) text = cdata[1];
	if (text === "") return "";
	const parsed = parseJsonLenient(text);
	return parsed === void 0 ? text : parsed;
}
/**
* 解析 XML/DSML 风格的工具调用块（整块文本，可能含多个 invoke）。
* 支持：`<tool_calls>`/`<function_calls>` 包裹、裸 `<invoke>`、`|DSML|` 前缀、
* CDATA 值、属性任意顺序、围栏包裹。
*/
function parseXmlToolCalls(block) {
	const text = normalizeDsml(block).replace(FENCE_HEAD_RE, "").replace(/```\s*$/, "");
	const invokeRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>([\\s\\S]*?)${TAG_CLOSE_PREFIX}invoke\\s*>`, "gi");
	const calls = [];
	let invoke;
	while ((invoke = invokeRe.exec(text)) !== null) {
		const name = readAttr(invoke[1], "name");
		if (!name) continue;
		const body = invoke[2];
		const args = {};
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
			if (inner) try {
				const parsed = JSON.parse(inner);
				if (parsed && typeof parsed === "object") Object.assign(args, parsed);
				else args._raw = parsed;
			} catch {
				args._raw = inner;
			}
		}
		calls.push({
			id: `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
			name,
			arguments: JSON.stringify(args)
		});
	}
	if (calls.length > 0) return calls;
	return salvageXmlToolCalls(text);
}
/**
* 宽容抢救：模型写出的 XML 调用块**收尾不全**时的最后一道网。
*
* 实测泄漏样本（2026-09，正是「一个字符一行」乱码的来源）：
*   `<tool_calls><invoke name="pwsh"><parameter name="command">…</parameter>`
* —— 参数值写完了，但**缺内层 `</invoke>`**（流被服务端上限截断时常见）。此时严格解析
* 认不出 invoke（它的正则要求 `</invoke>` 收尾），于是整块被当正文吐给用户；
* 而 Web GUI 把命令行里的 `$…$` 当 KaTeX 渲染 → 用户看到「一个字符一行 + 弯引号」的乱码。
* （注：只缺最外层 `</tool_calls>` 的情形严格解析本来就能兜住，不是泄漏源。）
*
* 做法：不依赖任何闭合标签，只按「`<invoke name=…>` 开标签 → 下一个开标签或块尾」切段取值。
* ⚠️ 只在**严格解析完全失败**时兜底，因此不会抢占正常路径。
* 宁可能截断也不要泄漏 —— 截断的调用会在下一轮被模型自己纠正。
*/
function salvageXmlToolCalls(text) {
	const invokeStartRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>`, "gi");
	const starts = [];
	let match;
	while ((match = invokeStartRe.exec(text)) !== null) starts.push({
		index: match.index,
		attrs: match[1]
	});
	if (starts.length === 0) return null;
	const calls = [];
	for (let i = 0; i < starts.length; i++) {
		const name = readAttr(starts[i].attrs, "name");
		if (!name) continue;
		const bodyStart = starts[i].index + starts[i].attrs.length;
		const nextStart = starts[i + 1]?.index ?? text.length;
		const body = text.slice(bodyStart, nextStart);
		calls.push({
			id: `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
			name,
			arguments: JSON.stringify(salvageXmlParameters(body))
		});
	}
	return calls.length > 0 ? calls : null;
}
/** 从残缺的 invoke 内文里取出参数：按开标签切段，值取到下一个开标签或段尾。 */
function salvageXmlParameters(body) {
	const args = {};
	const paramStartRe = new RegExp(`${TAG_OPEN_PREFIX}parameter\\b([^>]*)>`, "gi");
	const found = [];
	let match;
	while ((match = paramStartRe.exec(body)) !== null) {
		const key = readAttr(match[1], "name");
		if (key) found.push({
			start: match.index,
			end: paramStartRe.lastIndex,
			key
		});
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
/** 剥掉值尾部残留的收尾标签与空白。 */
function stripXmlClosers(value) {
	const re = new RegExp(`(?:\\s*${TAG_CLOSE_PREFIX}(?:${XML_CLOSE_NAMES})\\s*>)+\\s*$`, "i");
	return value.replace(re, "");
}
/**
* 判断捕获到的协议块是否**确实是一次工具调用尝试**（而不是正文里恰好提到了 `<invoke>` 这类词）。
* 只用于「解析失败时该丢弃还是该透出」的裁决：
*  - 像调用 → 丢弃 + 告警（绝不泄漏成乱码，交给上层重试）
*  - 不像调用 → 当普通正文透出（绝不吞掉模型正文）
*/
function looksLikeToolCallBlock(mode, raw) {
	if (mode === "json") return MARKER_RE.test(raw);
	const text = normalizeDsml(raw);
	return new RegExp(`${TAG_OPEN_PREFIX}invoke\\b[^>]*\\bname\\s*=`, "i").test(text) || new RegExp(`${TAG_OPEN_PREFIX}parameter\\b[^>]*\\bname\\s*=`, "i").test(text);
}
/**
* 分类失败形态，用于诊断 —— 日志只保留前 400 字符，看不到后半段的坏点，
* 所以必须把「没收全」与「收全了但结构不对」分开，否则永远在猜。
*
*  - `unbalanced`：块没配平/没收全 —— 多半是流被服务端 60s 上限截断，不是模型写错；
*  - `unparsable`：块是完整的，但结构不符（漏括号、引号没转义、形状不对）；
*  - `echo`      ：载荷里裹着转写回声（模型在回放历史，不是在调用）。
*/
function classifyFailure(mode, raw) {
	if (/\[\s*Tool Result\b/i.test(raw)) return "echo";
	if (mode === "json") return extractBalancedJson(raw.replace(FENCE_HEAD_RE, "")) ? "unparsable" : "unbalanced";
	return findXmlToolCallEnd(raw) === -1 ? "unbalanced" : "unparsable";
}
/** 把解析出的 JSON 转成工具调用请求；非协议形状返回 null。 */
function parseToolCallJson(json) {
	const parsed = parseJsonLenient(json);
	if (!parsed || typeof parsed !== "object") return null;
	const raw = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : parsed.tool_call && typeof parsed.tool_call === "object" ? [parsed.tool_call] : null;
	if (!raw) return null;
	const calls = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const name = typeof entry.name === "string" ? entry.name : typeof entry.tool === "string" ? entry.tool : "";
		if (!name) continue;
		let args = entry.arguments ?? entry.parameters ?? entry.args ?? {};
		if (Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) args = args[0];
		if (typeof args === "string") {
			if (parseJsonLenient(args) === void 0) args = JSON.stringify({ _raw: args });
		} else try {
			args = JSON.stringify(args ?? {});
		} catch {
			args = "{}";
		}
		calls.push({
			id: `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
			name,
			arguments: String(args)
		});
	}
	return calls.length > 0 ? calls : null;
}
/**
* 流尾兜底的 JSON 抢救（比 parseToolCallJson 多退一步）。
*
* 捕获缓冲里可能带着捕获后残留的多余字符（围栏、正文），此时整段 `JSON.parse` 必然失败，
* 但**配平的前缀本身是好的调用** —— 取前缀再解析，别把能救的调用整批丢掉。
* 注意：不配平的截断仍由 structuralRepairCandidates 的安全闸门拒绝（宁可不执行半条命令）。
*/
function parseSalvagedToolCallJson(buffer) {
	const text = buffer.replace(FENCE_HEAD_RE, "");
	const direct = parseToolCallJson(text);
	if (direct) return direct;
	const balanced = extractBalancedJson(text);
	if (balanced && balanced.end < text.length) return parseToolCallJson(balanced.json);
	return null;
}
/**
* 在捕获缓冲里找 XML 调用块的结束位置（含结束标签）。
* - 包裹式（`<tool_calls>` / `<function_calls>`）：找对应闭合标签
* - 裸 `<invoke>`：找到 `</invoke>` 后继续吞并紧随其后的 invoke 块（同一批调用）
* 返回 -1 表示尚未收全（继续等流）。
*/
function findXmlToolCallEnd(buffer) {
	const text = buffer;
	const wrapper = new RegExp(`<\\s*${DSML_PREFIX}(?:dsml-)?(${WRAPPER_NAMES})\\b`, "i").exec(text);
	const startsWithWrapper = wrapper !== null && wrapper.index === 0;
	const isInvokeStart = (value) => new RegExp(`^\\s*<\\s*${DSML_PREFIX}(?:dsml-)?invoke\\b`, "i").test(value);
	if (startsWithWrapper) {
		const tag = wrapper[1].toLowerCase();
		const match = new RegExp(`<\\/\\s*${DSML_PREFIX}(?:dsml-)?${tag}\\s*>`, "i").exec(text);
		return match ? match.index + match[0].length : -1;
	}
	if (!isInvokeStart(text)) return -1;
	let cursor = 0;
	for (;;) {
		const slice = text.slice(cursor);
		if (!isInvokeStart(slice)) return cursor > 0 ? cursor : -1;
		const match = /<\/\s*(?:\|\s*DSML\s*\|\s*)?(?:dsml-)?invoke\s*>/i.exec(slice);
		if (!match) return -1;
		cursor += match.index + match[0].length;
		if (!isInvokeStart(text.slice(cursor))) return cursor;
	}
}
/**
* 流式工具调用过滤器。
* - 普通正文：立即透传（仅 hold back 末尾少量字符以观测跨包的调用标记）
* - 命中调用标记（JSON 或 XML 两套）：进入捕获态，收全后转成 tool-call 请求，标记本身不外泄
* - 解析失败：把捕获内容当普通正文吐出（降级但可见，绝不静默丢内容）
* - 调用后面的剩余文本继续按普通正文处理（含围栏收尾清理）
*/
var ToolCallStreamFilter = class {
	pending = "";
	capture = null;
	abandoned = null;
	knownTools;
	constructor(knownTools) {
		this.knownTools = knownTools;
	}
	push(text) {
		const out = {
			text: "",
			calls: []
		};
		if (text) {
			if (this.capture) this.capture.buffer += text;
			else this.pending += text;
		}
		this.drain(out);
		return out;
	}
	flush() {
		const out = {
			text: "",
			calls: []
		};
		if (this.capture) {
			const captured = this.capture;
			const calls = captured.mode === "xml" ? parseXmlToolCalls(captured.buffer) : parseSalvagedToolCallJson(captured.buffer);
			if (calls) out.calls.push(...calls);
			else if (looksLikeToolCallBlock(captured.mode, captured.buffer)) this.abandoned ??= {
				raw: captured.buffer,
				mode: captured.mode,
				reason: classifyFailure(captured.mode, captured.buffer)
			};
			else out.text += captured.buffer;
			this.capture = null;
		}
		out.text += this.pending;
		this.pending = "";
		if (this.abandoned) out.rejected = this.abandoned;
		return out;
	}
	drain(out) {
		for (;;) {
			if (this.capture) {
				const captured = this.capture;
				if (captured.mode === "xml") {
					const end = findXmlToolCallEnd(captured.buffer);
					if (end === -1) {
						if (captured.buffer.length > MAX_CAPTURE_CHARS) {
							if (looksLikeToolCallBlock("xml", captured.buffer)) this.abandoned ??= {
								raw: captured.buffer,
								mode: "xml",
								reason: "oversize"
							};
							else out.text += captured.buffer;
							this.capture = null;
							continue;
						}
						return;
					}
					const block = captured.buffer.slice(0, end);
					const calls = parseXmlToolCalls(block);
					if (calls) out.calls.push(...calls);
					else if (looksLikeToolCallBlock("xml", block)) this.abandoned ??= {
						raw: block,
						mode: "xml",
						reason: "unparsable"
					};
					else out.text += block;
					this.capture = null;
					this.pending = captured.buffer.slice(end).replace(FENCE_HEAD_RE, "") + this.pending;
					continue;
				}
				const balanced = extractBalancedJson(captured.buffer);
				if (!balanced) {
					if (captured.buffer.length > MAX_CAPTURE_CHARS) {
						this.abandoned ??= {
							raw: captured.buffer,
							mode: "json",
							reason: "oversize"
						};
						this.capture = null;
						continue;
					}
					return;
				}
				const calls = parseToolCallJson(balanced.json);
				if (calls) {
					out.calls.push(...calls);
					this.capture = null;
					this.pending = captured.buffer.slice(balanced.end).replace(FENCE_HEAD_RE, "") + this.pending;
					continue;
				}
				const head = captured.buffer.slice(0, balanced.end);
				if (looksLikeToolCallBlock("json", head)) this.abandoned ??= {
					raw: head,
					mode: "json",
					reason: "unparsable"
				};
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
				let head = this.pending.slice(0, index);
				const fence = FENCE_TAIL_RE.exec(head);
				if (fence) head = head.slice(0, fence.index);
				out.text += head;
				this.capture = {
					mode: useXml ? "xml" : "json",
					buffer: this.pending.slice(index)
				};
				this.pending = "";
				continue;
			}
			if (this.pending.length <= HOLD_BACK_CHARS) return;
			const hold = partialMarkerSuffixLength(this.pending);
			if (hold > 0) {
				out.text += this.pending.slice(0, this.pending.length - hold);
				this.pending = this.pending.slice(this.pending.length - hold);
				return;
			}
			out.text += this.pending;
			this.pending = "";
			return;
		}
	}
};
/**
* 剥离模型模仿的「系统标记」（`<ds_system>…</ds_system>` / `<system>…</system>`）。
*
* 实测（2026-09-11，deepseek-web）：模型会在正文里吐出成串的伪系统标记——
* 最严重的一现场是一条消息里 13 个 `<ds_system>Tool result for call_1a2b3c</ds_system>`，
* 调用 ID 还是字母递增编造的（1a2b3c→4d5e6f→7a8b9c…）。这与「转写回声」是同一类问题
* （模型在模仿协议格式），但形态是 XML 标签而不是 `[Tool Result]` 行，
* 所以单独一层处理。围栏代码块内不剥（正常回答可能讨论这些标记）。
*
* @returns 剥离后的文本；`stripped` = 是否剥掉了至少一个标记（用于日志/告警）。
*/
function stripSystemMarkers(text) {
	if (!text.includes("<ds_system") && !text.includes("<system>") && !text.includes("<system ")) return {
		text,
		stripped: false
	};
	let out = "";
	let inFence = false;
	let stripped = false;
	let i = 0;
	while (i < text.length) {
		const lineEnd = text.indexOf("\n", i);
		const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd + 1);
		const trimmed = line.trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) inFence = !inFence;
		if (!inFence) {
			const cleaned = line.replace(/<ds_system\b[^>]*>[\s\S]*?<\/ds_system>/g, () => {
				stripped = true;
				return "";
			}).replace(/<ds_system\b[^>]*>[\s\S]*$/g, () => {
				stripped = true;
				return "";
			}).replace(/<system\b[^>]*>[\s\S]*?<\/system>/g, () => {
				stripped = true;
				return "";
			}).replace(/<system\b[^>]*>[\s\S]*$/g, () => {
				stripped = true;
				return "";
			});
			out += cleaned;
		} else out += line;
		i = lineEnd === -1 ? text.length : lineEnd + 1;
	}
	return {
		text: out,
		stripped
	};
}
/**
* DeepSeek 网页端在**每一轮回复末尾**自动追加的免责声明（不是模型回答的一部分）。
*
* 实测（2026-09-11，27 个 DSH 会话里命中 43 处，形态唯一）：
*   `本回答由 AI 生成，内容仅供参考，请仔细甄别`
* 它会以 SSE 增量形式到达，甚至被拆成「 AI」「 生成」「，」「内容」这样的小包。
*
* 为什么必须剥掉：
*   - 它卡在两条回答中间（自动续写的缝就在它后面），用户会以为「模型怎么突然插了这句话」；
*   - 结尾是「甄别」这种汉字 → `looksMidSentence` 恒为真 → **每一轮都被误判成「句中被截」**，
*     于是无限触发自动续写（续写轮又追加一遍声明，再被判成截断……）。
*/
const WEB_DISCLAIMER = "本回答由 AI 生成，内容仅供参考，请仔细甄别";
/**
* 一次性剥离网页端免责声明（非流式）。
*
* 轮末残余必须用它再过一遍：`BoilerplateFilter` 的流式扣留只管它**收到**的文本，
* 而过滤器扣住的最后 ≤24 个字符还没经过它 —— 声明恰好 23 字，实测就整段从尾巴漏出去
* （会话 `6c0dbc47` 里它是一个只有单个 delta 的独立 text 块，跟在工具调用后面）。
*/
function stripWebDisclaimer(text) {
	if (!text.includes(WEB_DISCLAIMER)) return {
		text,
		stripped: false
	};
	return {
		text: text.split(WEB_DISCLAIMER).join(""),
		stripped: true
	};
}
/**
* 轮末收尾：把三层缓冲扣住的残余按**真实顺序**吐净，并补跑只作用于上屏前的两道清理。
*
* ⚠️ 为什么不能只把三层 flush 结果拼起来：
*   - 吐净顺序必须是流水线**反序**（越深的层扣住的文本越早）—— 否则最后几段文字前后颠倒；
*   - 浅层（过滤器）扣住的字符**从没经过**「剥声明」这一层，而声明就爱待在最后几个字符里；
*   - 同理，伪系统标记也可能整段藏在尾巴里。
* 轮末没有后续输入了，所以这里可以直接做一次性替换，不需要流式扣留。
*/
function drainTextPipeline(filter, boilerplate, guard) {
	const tailGuarded = guard.flush();
	const tailBoiled = boilerplate.flush();
	const tail = filter.flush();
	const dedisclaimered = stripWebDisclaimer(tailGuarded.text + tailBoiled.text + tail.text);
	return {
		text: stripSystemMarkers(dedisclaimered.text).text,
		echoed: tailGuarded.echoed,
		disclaimers: boilerplate.count + (dedisclaimered.stripped ? 1 : 0),
		calls: tail.calls,
		rejected: tail.rejected
	};
}
/**
* 流式剥离网页端免责声明。
*
* 逐包调用：命中即整段丢弃。
*
* ⚠️ 扣留策略必须是「**恒定扣住最后 |声明|-1 个字符**」，不能只扣「声明的前缀」：
* 声明会被 SSE 切成任意小包（实测有「 AI」「 生成」「，」「内容」这种），
* 一旦切点落在声明中间，前半截已经不是「前缀」了 —— 只扣前缀就会把它放出去，
* 后半截到齐时再也拼不回来（2026-09-11 实测漏过一次）。
* 扣 22 个字符的代价是上屏延迟 22 字，肉眼不可见。
*/
var BoilerplateFilter = class {
	pending = "";
	hits = 0;
	stripped = false;
	holdChars = 22;
	push(text) {
		this.pending += text;
		let out = "";
		for (;;) {
			const at = this.pending.indexOf(WEB_DISCLAIMER);
			if (at !== -1) {
				out += this.pending.slice(0, at);
				this.pending = this.pending.slice(at + 23);
				this.hits += 1;
				this.stripped = true;
				continue;
			}
			const hold = Math.min(this.pending.length, this.holdChars);
			out += this.pending.slice(0, this.pending.length - hold);
			this.pending = this.pending.slice(this.pending.length - hold);
			return {
				text: out,
				stripped: this.stripped
			};
		}
	}
	flush() {
		const rest = this.pending;
		this.pending = "";
		return {
			text: rest,
			stripped: this.stripped
		};
	}
	/** 本次流剥掉了几处声明（用于留痕）。 */
	get count() {
		return this.hits;
	}
};
/**
* 转写格式标记 —— 也就是 `serializePrompt` 写进 prompt 的那套行首标记。
*
* 模型会**照着 prompt 里的转写格式模仿**，把工具结果 / 系统标记当回答吐出来。
* 这与「工具调用标记泄漏」是**两个独立的泄漏源**：`ToolCallStreamFilter` 只防后者。
*
* 实测（2026-09-10，deepseek-web / deepseek-reasoner）可见正文里出现：
*   `[Tool Result for call_xxx]` + 真实工具输出 + `[status: running]`
* 以及成串的 `User: …` / `Assistant: …` 转写行。
* 2026-09-11 补：还有一种更隐蔽的形态 —— 给回声行加 `Assistant: ` 前缀
* （`Assistant: [Tool Result for call_xxx]`），必须按「行内含转写标记」判，见 ECHO_INLINE_SIGNATURES。
*/
const ECHO_SIGNATURES = [
	/^\[\s*Tool Result\b/i,
	/^\[\s*status\s*:\s*[a-z_]+\s*\]$/i,
	/^\[\s*(?:System|Assistant)\s*\]$/i
];
/** 转写轮次行：单行可能只是正文，成串出现才是回声。 */
const ECHO_TURN_RE = /^(?:User|Assistant)\s*:/;
/**
* 转写特征出现在**行内任意位置**（不要求行首）。
*
* 实测（2026-09-11 17:07，install-plugin 工作区）：模型输出的回声长这样 ——
*   `Assistant: [Tool Result for call_7b1a7d39a2e54bc0b8f1]`
*   `direct ERR fetch failed`
* 它给回声加了 `Assistant: ` 前缀，于是行首不再匹配 ECHO_SIGNATURES，
* 被当成「正文里偶尔出现的 User: 字样」放行（还顺带把后面那行也带了出来）。
* 所以只要一行里**含有**这些标记，就当回声处理。
*/
const ECHO_INLINE_SIGNATURES = [
	/\[\s*Tool Result\b/i,
	/\[\s*status\s*:/i,
	/\[\s*Truncated\s*\]/i,
	/\[\s*(?:System|Assistant)\s*\]/i,
	/\[\s*truncated\s*\]/i,
	/assistant\s+truncated/i,
	/\[\s*\d+\s*chars?\s+omitted\s*\]/i
];
/** 光秃秃的 `Assistant:` / `User:`（冒号后没有内容）—— 模型正在起一行假转写。 */
const ECHO_BARE_TURN_RE = /^(?:User|Assistant)\s*:\s*$/;
/** 回声标记的**半截前缀**（流在行中间被截断时出现）——同样是垃圾，不能上屏。 */
const ECHO_PREFIXES = [
	"[tool result",
	"[status:",
	"[system]",
	"[assistant]"
];
/** 该行是否是某个回声标记的开头片段。 */
function looksLikeEchoPrefix(line) {
	const t = line.trim().toLowerCase();
	return t.length > 0 && ECHO_PREFIXES.some((p) => p.startsWith(t));
}
/**
* 逐行守卫：命中回声特征后，**从该行起全部丢弃**。
*
* 为什么这样设计：
*  - 回声几乎总出现在末尾（模型在「续写转写」），前面才是真回答 → 截断比整段丢弃更保内容；
*  - 围栏代码块内不判定 —— 正常回答里也可能引用这些标记（比如讨论本插件时）；
*  - 逐行缓冲、保留末尾未完成的半行 → 流式下也不会先把垃圾推给用户再吞回去。
*/
var TranscriptEchoGuard = class {
	pending = "";
	inFence = false;
	/** 已扣住、尚未判定的一行转写轮次行（等下一行决定它是回声还是正文）。 */
	turnCandidate = null;
	fired = false;
	/**
	* @returns `text` = 可以安全上屏的部分；`echoed` = 本轮是否出现过回声（那部分已被丢弃）。
	*/
	push(text) {
		if (this.fired) return {
			text: "",
			echoed: true
		};
		this.pending += text;
		let out = "";
		for (;;) {
			const nl = this.pending.indexOf("\n");
			if (nl === -1) break;
			const line = this.pending.slice(0, nl + 1);
			this.pending = this.pending.slice(nl + 1);
			const verdict = this.classify(line);
			if (verdict === "echo") {
				this.fired = true;
				this.pending = "";
				this.turnCandidate = null;
				return {
					text: out,
					echoed: true
				};
			}
			if (verdict === "turn") {
				if (this.turnCandidate !== null) {
					this.fired = true;
					this.pending = "";
					this.turnCandidate = null;
					return {
						text: out,
						echoed: true
					};
				}
				this.turnCandidate = line;
				continue;
			}
			if (this.turnCandidate !== null && line.trim() !== "") {
				out += this.turnCandidate;
				this.turnCandidate = null;
			}
			out += line;
		}
		return {
			text: out,
			echoed: false
		};
	}
	flush() {
		if (this.fired) return {
			text: "",
			echoed: true
		};
		let out = "";
		if (this.turnCandidate !== null) {
			out += this.turnCandidate;
			this.turnCandidate = null;
		}
		const rest = this.pending;
		this.pending = "";
		if (rest && (this.classify(rest) === "echo" || looksLikeEchoPrefix(rest))) {
			this.fired = true;
			return {
				text: out,
				echoed: true
			};
		}
		return {
			text: out + rest,
			echoed: false
		};
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
		for (const re of ECHO_INLINE_SIGNATURES) if (re.test(t)) return "echo";
		if (ECHO_BARE_TURN_RE.test(t)) return "echo";
		if (ECHO_TURN_RE.test(t)) return "turn";
		return "plain";
	}
};
//#endregion
//#region src/adapter.ts
/**
* deepseek-web 适配器：把 DSH 的 LLM 调用翻译成 chat.deepseek.com 网页端对话。
*
* 与官方 dsh-llm-deepseek 的差异（受限于网页端能力）：
*  - 网页接口只吃单段 `prompt` 字符串 → 由 protocol.ts 序列化整段转写
*  - 无原生 function calling → 提示词 JSON 协议 + 流式解析（protocol.ts）
*  - 无 temperature / stop / max_tokens 字段 → 忽略（不报错）
*  - 每次调用新建 chat_session 并在结束后删除（保持无状态 + 不污染网页端列表）
*/
/**
* 把「被丢弃的完整载荷」落盘，专供事后定位。
*
* 为什么必须这么做：日志里只留前 400 字符，而实测的坏点几乎总在后半段
* （长 PowerShell 命令、批量多调用）。没有完整原文就只能靠猜——
* 2026-09-10 已经因此多绕了好几轮：先误判成 DSML 双竖线，真实原因却是未转义双引号。
* 落盘后可以直接把原文喂进解析器复现，从「猜」变成「验」。
*
* 失败必须无声（诊断代码绝不能影响主流程）。
*/
function dumpRejectedPayload(raw, mode, reason, logger) {
	try {
		const dir = join(homedir(), ".dsh", "deepseek-web");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "rejected.jsonl");
		try {
			if (statSync(file).size > 4e6) writeFileSync(file, "");
		} catch {}
		appendFileSync(file, `${JSON.stringify({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			mode,
			reason,
			length: raw.length,
			raw
		})}\n`, "utf8");
	} catch (error) {
		logger?.debug?.(`deepseek-web: 落盘被丢弃载荷失败：${error?.message ?? error}`);
	}
}
const PROVIDER = "deepseek-web";
/**
* 网页免费模型目录。
*
* 权威依据：`GET /api/v0/client/settings?scope=model` 的 `model_configs`
* （服务器按账号返回，实测 configVersion 81）：
*   default / 快速模式 → enabled=true,  switchable=true,  is_default=true
*   expert  / 专家模式 → enabled=false, switchable=false
*   vision  / 识图模式 → enabled=false, switchable=false
* 即专家/识图已被服务端停用并合并进快速模式。**目录里的两条不是两个模型**，
* 而是同一个「快速模式」的 `thinking_enabled` 开关两档预设（方便一键选）；
* 也可以通过推理强度（reasoningEffort）在同一个档位上切换。
* 旧档位选择由 LEGACY_ALIASES 回退承接。
*
* 容量（2026-09-11 直接抓服务端 `client/settings` 逐字段核对，configVersion 81）：
*   `input_character_limit = 2621440`        —— **单请求输入字符数硬上限**（= 2.5 MiB 字符）
*   `file_feature.token_limit = 890880`      —— 附件/文件的 token 预算（开不开思考都一样）
*   `file_feature.token_limit_with_thinking = 890880`
* ⚠️ 曾经的错误：把 `890880` 当成「模型上下文窗口」，还在文档里写成「1M 扣输出预留」。
* 它是 **file_feature（附件）的 token 预算**，跟上下文窗口不是一回事；而且 890880 = 870×1024，
* 面板按 ÷1024 显示就成了「870K」，于是看起来像「说好的 1M 变成了 870K」。
* 服务端并没有给出「总上下文窗口」字段；可核对的硬约束只有上面那条字符上限。
* 因此 contextWindow 按 DeepSeek 标称的 1M 取 1048576（1 Mi；服务端自己的数字也都是 1024 的整数倍：
* 2621440 = 2.5×1048576、890880 = 870×1024），真正防越界的是 maxPromptChars（远低于字符硬上限）。
*/
const MODEL_SPECS = [{
	id: "deepseek-chat",
	name: "DeepSeek 网页 · 快速模式（不思考）",
	description: "同一模型，thinking 关闭：直接作答、最快、最省免费额度。适合工具调用/改写/检索类任务",
	modelType: "default",
	thinking: false,
	configurableThinking: true,
	contextWindow: 1048576,
	maxOutputTokens: 16384
}, {
	id: "deepseek-reasoner",
	name: "DeepSeek 网页 · 快速模式（深度思考）",
	description: "同一模型，thinking 开启：先推理再作答（推理流作为思考块回传）。适合数学/多步调试/规划，更慢也更耗额度",
	modelType: "default",
	thinking: true,
	configurableThinking: true,
	contextWindow: 1048576,
	maxOutputTokens: 32768
}];
/**
* 旧档位兼容：expert/vision 被服务端停用后不再出现在 listModels 里，
* 但历史会话/预设里若仍指向它们，这里做路由回退而不是直接报错。
*/
const LEGACY_ALIASES = {
	"deepseek-pro": "deepseek-reasoner",
	"deepseek-expert": "deepseek-reasoner",
	"deepseek-vision": "deepseek-chat"
};
const EFFORT_OFF = "off";
const EFFORT_LOW = "low";
const EFFORT_HIGH = "high";
const EFFORT_MAX = "max";
const REASONING_EFFORTS = [
	{
		id: EFFORT_OFF,
		name: "Off",
		description: "关闭思考（网页快速模式）"
	},
	{
		id: EFFORT_LOW,
		name: "Low",
		description: "开启思考（网页只区分开/关，等同 High）"
	},
	{
		id: EFFORT_HIGH,
		name: "High",
		description: "开启思考（默认）"
	},
	{
		id: EFFORT_MAX,
		name: "Max",
		description: "开启思考（网页只区分开/关，等同 High）"
	}
];
const OFF_ONLY_EFFORTS = [{
	id: EFFORT_OFF,
	name: "Off",
	description: "该模型固定为非思考模式"
}];
/** 估算 token 数（网页端不返回 usage；CJK/英文混合按 ~3.2 字符/token 粗估）。 */
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
/** 上下文超限的文案识别（网页端返回的是自然语言错误）。 */
function isContextTooLong(message) {
	return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|too\s+many\s+tokens|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)|содержани|контекст/i.test(message);
}
function modelInfoFor(provider, spec, requestedId) {
	return {
		provider,
		id: requestedId ?? spec.id,
		name: spec.name,
		description: spec.description,
		inputModalities: ["text", "image"]
	};
}
function resolvedModelInfo(provider, spec, requestedId) {
	return {
		...modelInfoFor(provider, spec, requestedId),
		context: { contextWindow: spec.contextWindow },
		defaultMaxTokens: spec.maxOutputTokens,
		reasoning: spec.configurableThinking ? {
			efforts: REASONING_EFFORTS,
			defaultEffort: spec.thinking ? EFFORT_HIGH : EFFORT_OFF
		} : {
			efforts: OFF_ONLY_EFFORTS,
			defaultEffort: EFFORT_OFF
		}
	};
}
/**
* 解析模型：命中目录直接用；命中旧档位（expert/vision）按别名回退到对应档位，
* 但**保留请求时的 id** —— 运行时要求 resolveModel 返回的 id 必须与请求一致
* （INVALID_MODEL_INFO），否则历史会话里的旧档位选择会直接报错。
*/
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
/** 解析本次请求的思考开关。 */
function resolveThinking(options, spec) {
	if (options?.purpose === "session-title" || options?.purpose === "compaction") return { thinkingEnabled: false };
	if (!spec.configurableThinking) return { thinkingEnabled: spec.thinking };
	const effort = options?.reasoningEffort;
	if (effort === void 0) return { thinkingEnabled: spec.thinking };
	if (effort === EFFORT_OFF) return { thinkingEnabled: false };
	if (effort === EFFORT_LOW || effort === EFFORT_HIGH || effort === EFFORT_MAX) return { thinkingEnabled: true };
	throw new AdapterLlmError(`deepseek-web 不支持 reasoning effort "${String(effort)}"`, "UNSUPPORTED_REASONING_EFFORT");
}
/**
* 自动续写的用户指令（流被截后，适配器自动发起新请求让模型接着写——
* 等价于用户手动说「继续」，但无需用户参与、且文本无缝拼接进同一条回答）。
*/
const CONTINUE_INSTRUCTION = "继续：请从你上一条回复的结尾处无缝接着往下写——不要重复任何已输出的内容，不要加「好的」「以下是」之类的开场白，不要重新组织语言；如果上一条回复停在句子中间，就从那个断点直接把句子写完并继续。";
/**
* 启发式：正文是否「在句中被截」。
* 判据（尾部最后一个非空白字符）：
*  - 是 CJK 汉字/字母/数字（没有任何标点收尾）→ 大概率被截；
*  - 是 markdown 强调标记（`**` / `__`）→ 被截在标记中间；
*  - 是逗号/顿号/冒号/开引号/开括号 → 明显未完。
*  正常结束的正文几乎总以句号/问号/感叹号/右引号/右括号/代码块收尾/表格行结尾出现。
*/
function looksMidSentence(text) {
	const trimmed = text.trimEnd();
	if (trimmed.length === 0) return false;
	const last = trimmed[trimmed.length - 1];
	if ("。，？！；：,?!;:…）】》」』\"'`*_#~".includes(last)) {
		if (last === "*" || last === "_" || last === "#" || last === "~" || last === "`") return trimmed.endsWith("**") || trimmed.endsWith("__");
		return "，：,;：：".includes(last) || last === "，" || last === "," || last === ":" || last === "：" || last === ";";
	}
	return /[a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff]/.test(last);
}
/** 构造 deepseek-web 适配器（鸭子类型满足 LlmAdapter 契约，无需继承）。 */
function createAdapter(deps) {
	const logger = deps.config.logger;
	const runStream = deps.streamCompletion ?? streamWebCompletion;
	const gate = deps.gate ?? createRequestGate({
		allowConcurrent: deps.config.allowConcurrent === true,
		minIntervalMs: deps.config.minRequestIntervalMs ?? 2e3,
		logger
	});
	const adapter = {
		providerInfo(provider) {
			return {
				id: provider,
				name: "DeepSeek 网页版（免费）"
			};
		},
		/** 未配置策略 → 走 dsh-llm 默认重试码表（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT）。 */
		providerRetryPolicy(_provider) {},
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
		imageRequestPricing(_provider, _model) {},
		listModels(provider) {
			return Promise.resolve(MODEL_SPECS.map((spec) => modelInfoFor(provider, spec)));
		},
		resolveModel(provider, model) {
			return Promise.resolve(resolvedModelInfo(provider, resolveSpec(model), String(model ?? "")));
		},
		/**
		* 运行时契约（dsh-llm 0.1.2-rc.1）：dispatch 前先取「精确模型元数据 + 该次调用的 stream」。
		* 返回的 stream 接收运行时补齐后的 options。
		*/
		prepareCall(provider, model, _signal) {
			const spec = resolveSpec(model);
			return Promise.resolve({
				model: resolvedModelInfo(provider, spec, String(model ?? "")),
				stream: (options) => gatedStream(options)
			});
		},
		stream(options) {
			return gatedStream(options);
		}
	};
	/** 上传缓存：attachmentId → fileId（内容寻址，跨轮次复用，避免重复上传同一张图）。 */
	const uploadCache = /* @__PURE__ */ new Map();
	const UPLOAD_TTL_MS = 72e5;
	/**
	* 把请求里出现的图片全部上传到网页端并返回 file_id 列表。
	* 失败不致命：记日志后跳过该图（prompt 里仍有 [image attached] 标记，模型会知道有图但看不到）。
	*/
	async function uploadRequestImages(auth, messages, signal) {
		const refs = collectImageRefs(messages);
		if (refs.length === 0) return [];
		if (!deps.readImage) {
			logger?.warn?.("deepseek-web: 收到图片但附件服务不可用（ctx.attachments），图片被忽略");
			return [];
		}
		const ids = [];
		const now = Date.now();
		for (const ref of refs) {
			const key = String(ref?.attachmentId ?? "");
			if (!key) continue;
			const cached = uploadCache.get(key);
			if (cached && now - cached.at < UPLOAD_TTL_MS) {
				ids.push(cached.fileId);
				continue;
			}
			try {
				const stored = await deps.readImage(ref, signal);
				const uploaded = await uploadImageFile(auth, {
					data: stored.data,
					mediaType: stored.mediaType || String(ref.mediaType ?? "image/png"),
					...stored.name || ref.name ? { name: String(stored.name ?? ref.name) } : {}
				}, signal);
				uploadCache.set(key, {
					fileId: uploaded.fileId,
					at: Date.now()
				});
				ids.push(uploaded.fileId);
			} catch (error) {
				logger?.warn?.(`deepseek-web: 图片上传失败（已降级为纯文本）：${error?.message ?? error}`);
			}
		}
		return ids;
	}
	/**
	* streamImpl 的闸门外壳：拿到许可后才真正开始请求，流结束（含被中断/抛错）才释放。
	*
	* ⚠️ 许可在 generator 体**内部**获取 —— 只有真正开始迭代（第一次 next()）才占位，
	* 消费者拿了 generator 却没迭代时不会泄漏名额；流被 abort 时 finally 一定会释放。
	*/
	async function* gatedStream(options) {
		const purpose = typeof options?.purpose === "string" && options.purpose ? options.purpose : "chat";
		const release = await gate.acquire(purpose);
		try {
			yield* streamImpl(options);
		} finally {
			release();
		}
	}
	async function* streamImpl(options) {
		const auth = deps.getAuth();
		if (!hasUsableAuth(auth)) throw new AdapterLlmError("尚未登录 DeepSeek 网页版：请在「设置 → DeepSeek 网页登录」里用浏览器窗口登录，或手动粘贴 userToken。", "MISSING_CREDENTIAL");
		const spec = resolveSpec(String(options?.model ?? ""));
		const { thinkingEnabled } = resolveThinking(options, spec);
		const refFileIds = await uploadRequestImages(auth, options?.messages, options?.signal);
		const prompt = serializePrompt({
			system: options?.system,
			messages: options?.messages ?? [],
			tools: options?.tools ?? [],
			maxChars: deps.config.maxPromptChars ?? 15e5
		});
		const knownNames = new Set((options?.tools ?? []).map((tool) => String(tool?.name ?? "")));
		let filter = new ToolCallStreamFilter(knownNames);
		let echoGuard = new TranscriptEchoGuard();
		let boilerplate = new BoilerplateFilter();
		let nextIndex = 0;
		let textBlock = null;
		let textStarted = false;
		let reasoningBlock = null;
		let reasoningStarted = false;
		let toolCallCount = 0;
		let finishReason;
		let rejectedProtocol = "";
		let rejectedReason;
		let echoedTranscript = false;
		/** 本轮是否剥掉了网页端免责声明（`本回答由 AI 生成…`）。 */
		let disclaimerStripped = false;
		const openText = () => {
			if (!textBlock) textBlock = {
				index: nextIndex++,
				text: ""
			};
			return textBlock;
		};
		const openReasoning = () => {
			if (!reasoningBlock) reasoningBlock = {
				index: nextIndex++,
				text: ""
			};
			return reasoningBlock;
		};
		const emitCalls = function* (calls) {
			for (const call of calls) {
				const index = nextIndex++;
				toolCallCount += 1;
				yield {
					type: "block-start",
					index,
					blockType: "tool-call"
				};
				yield {
					type: "tool-call-delta",
					index,
					id: call.id,
					name: call.name,
					argumentsDelta: call.arguments
				};
				yield {
					type: "block-end",
					index,
					block: {
						type: "tool-call",
						id: call.id,
						name: call.name,
						arguments: call.arguments
					}
				};
			}
		};
		try {
			let rounds = 0;
			let currentPrompt = prompt;
			/** 本轮开始前已累计的正文长度（用来量出「这一轮到底吐了多少字」）。 */
			let textLenAtRoundStart = 0;
			/** 本轮开始的时刻（用来量出「这一轮到底跑了多久」）。 */
			let roundStartedAt = Date.now();
			for (;;) {
				let roundError;
				finishReason = void 0;
				textLenAtRoundStart = textBlock?.text?.length ?? 0;
				roundStartedAt = Date.now();
				try {
					for await (const event of runStream(auth, {
						prompt: currentPrompt,
						thinkingEnabled,
						modelType: spec.modelType,
						refFileIds: rounds === 0 ? refFileIds : [],
						signal: options?.signal,
						idleTimeoutMs: deps.config.idleTimeoutMs ?? 12e4,
						onDeleteSession: deps.config.deleteWebSessions === false ? void 0 : (sessionId) => {
							if (deps.sessionCleaner) deps.sessionCleaner.schedule(auth, sessionId);
							else scheduleDeleteSession(auth, sessionId);
						}
					})) {
						if (event.kind === "thinking") {
							const block = openReasoning();
							if (!reasoningStarted) {
								reasoningStarted = true;
								yield {
									type: "block-start",
									index: block.index,
									blockType: "reasoning"
								};
							}
							block.text += event.text;
							yield {
								type: "reasoning-delta",
								index: block.index,
								text: event.text
							};
							continue;
						}
						if (event.kind === "text") {
							const out = filter.push(event.text);
							const boiled = boilerplate.push(out.text);
							const guarded = echoGuard.push(boiled.text);
							if (guarded.echoed) echoedTranscript = true;
							const cleaned = stripSystemMarkers(guarded.text);
							if (cleaned.stripped) logger?.debug?.("deepseek-web: 已剥离伪系统标记（<ds_system>/<system>）");
							if (cleaned.text) {
								const block = openText();
								if (!textStarted) {
									textStarted = true;
									yield {
										type: "block-start",
										index: block.index,
										blockType: "text"
									};
								}
								block.text += cleaned.text;
								yield {
									type: "text-delta",
									index: block.index,
									text: cleaned.text
								};
							}
							if (out.calls.length > 0) yield* emitCalls(out.calls);
							continue;
						}
						if (event.kind === "status") {
							logger?.debug?.(`deepseek-web: status=${event.value}`);
							continue;
						}
						if (event.kind === "error") {
							if (isContextTooLong(event.message)) throw new AdapterLlmError(`DeepSeek 网页端上下文超限：${event.message}`, "CONTEXT_WINDOW_EXCEEDED");
							if (event.code === "RATE_LIMIT") {
								const throttled = event.rateLimitKind === "throttled";
								throw new AdapterLlmError(throttled ? `DeepSeek 网页端对这个账号限流了（发得太频繁）。这不是封号：登录态有效、建会话也正常，只有发消息被拒。这一步会自动退避重试；若一直不过，请等几分钟再继续，或降低自动化步骤密度（每一轮工具调用都是一次网页端请求）。` : `DeepSeek 网页端同一账号同时只能生成一条消息（另一个窗口/标签页正在用同一账号生成）。这一步会自动重试；若两个窗口都要用网页模型，建议其中一个换 provider 或换账号。`, "RATE_LIMIT", {
									...event.retryAfterMs !== void 0 ? { providerRetryAfterMs: event.retryAfterMs } : {},
									...throttled ? { rateLimitKind: "throttled" } : {}
								});
							}
							throw new AdapterLlmError(`DeepSeek 网页端返回错误：${event.message}`, "PROVIDER_ERROR");
						}
						if (event.kind === "finish") finishReason = event.reason;
					}
				} catch (error) {
					if (rounds > 0) {
						if (options?.signal?.aborted) throw new AdapterLlmError("deepseek-web 请求被调用方取消", "ABORTED", { cause: error });
						roundError = error instanceof AdapterLlmError ? error : new AdapterLlmError(`deepseek-web 自动续写失败：${error?.message ?? error}`, "TRANSPORT", { cause: error });
						logger?.warn?.(`deepseek-web: 自动续写第 ${rounds} 轮失败，保留已输出部分：${roundError.message}`);
					} else throw error;
				}
				const drained = drainTextPipeline(filter, boilerplate, echoGuard);
				if (drained.echoed) echoedTranscript = true;
				if (drained.disclaimers > 0) disclaimerStripped = true;
				const tailText = drained.text;
				if (tailText) {
					const block = openText();
					if (!textStarted) {
						textStarted = true;
						yield {
							type: "block-start",
							index: block.index,
							blockType: "text"
						};
					}
					block.text += tailText;
					yield {
						type: "text-delta",
						index: block.index,
						text: tailText
					};
				}
				if (drained.calls.length > 0) yield* emitCalls(drained.calls);
				if (drained.rejected) {
					dumpRejectedPayload(drained.rejected.raw, drained.rejected.mode, drained.rejected.reason ?? "unparsable", logger);
					logger?.warn?.(`deepseek-web: 工具调用${drained.rejected.mode === "xml" ? "（XML）" : ""}解析失败[${drained.rejected.reason ?? "unparsable"}]，已丢弃 ${drained.rejected.raw.length} 字符（完整原文见 ~/.dsh/deepseek-web/rejected.jsonl）：` + drained.rejected.raw.slice(0, 2e3));
					if (rounds === 0) {
						rejectedProtocol = drained.rejected.raw;
						rejectedReason = drained.rejected.reason ?? "unparsable";
					}
				}
				const partial = textBlock?.text ?? "";
				const roundChars = partial.length - textLenAtRoundStart;
				const maxRounds = deps.config.maxContinuations ?? 2;
				const cutByServer = finishReason === void 0;
				const midSentence = looksMidSentence(partial);
				logger?.info?.(`deepseek-web: 第 ${rounds + 1} 轮流结束：[本轮 ${roundChars} 字 / 累计 ${partial.length} 字 / 耗时 ${Date.now() - roundStartedAt}ms] finish=${finishReason ?? "(无 FINISHED → 服务端截断)"}${midSentence ? "，尾部是句中" : ""}`);
				if (!(roundError === void 0 && deps.config.autoContinue !== false && rounds < maxRounds && toolCallCount === 0 && !options?.signal?.aborted && partial.length > 0 && roundChars > 0 && (midSentence || cutByServer))) break;
				rounds += 1;
				logger?.info?.(`deepseek-web: 回答疑似在句中被截，自动续写（第 ${rounds}/${maxRounds} 轮）……`);
				currentPrompt = serializePrompt({
					system: options?.system,
					messages: [
						...options?.messages ?? [],
						{
							role: "assistant",
							content: [{
								type: "text",
								text: partial
							}]
						},
						{
							role: "user",
							content: [{
								type: "text",
								text: CONTINUE_INSTRUCTION
							}]
						}
					],
					tools: options?.tools ?? [],
					maxChars: deps.config.maxPromptChars ?? 15e5
				});
				filter = new ToolCallStreamFilter(knownNames);
				echoGuard = new TranscriptEchoGuard();
				boilerplate = new BoilerplateFilter();
			}
		} catch (error) {
			if (error instanceof AdapterLlmError) throw error;
			if (options?.signal?.aborted) throw new AdapterLlmError("deepseek-web 请求被调用方取消", "ABORTED", { cause: error });
			throw new AdapterLlmError(`deepseek-web 流失败：${error?.message ?? error}`, "TRANSPORT", { cause: error });
		}
		if (reasoningBlock) yield {
			type: "block-end",
			index: reasoningBlock.index,
			block: {
				type: "reasoning",
				text: reasoningBlock.text
			}
		};
		if (textBlock) yield {
			type: "block-end",
			index: textBlock.index,
			block: {
				type: "text",
				text: textBlock.text
			}
		};
		const outputChars = (textBlock?.text?.length ?? 0) + (reasoningBlock?.text?.length ?? 0);
		yield {
			type: "usage",
			usage: {
				inputTokens: estimateTokens(prompt),
				outputTokens: Math.ceil(outputChars / 3.2),
				...reasoningBlock ? { reasoningTokens: estimateTokens(reasoningBlock.text) } : {}
			}
		};
		if (toolCallCount > 0) {
			yield {
				type: "finish",
				reason: { kind: "tool-calls" }
			};
			return;
		}
		const hasVisibleText = (textBlock?.text?.length ?? 0) > 0;
		if (echoedTranscript) logger?.warn?.("deepseek-web: 模型回声了「对话转写格式」（[Tool Result for …] / User: / Assistant: 等），该段已丢弃、不上屏");
		if (disclaimerStripped) logger?.info?.("deepseek-web: 已剥离网页端免责声明（本回答由 AI 生成，内容仅供参考，请仔细甄别）");
		if (echoedTranscript && !hasVisibleText && toolCallCount === 0) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: "DeepSeek 网页端把「对话转写格式」当成回答输出了（已丢弃，未上屏），本次没有产生有效内容。",
						code: "EMPTY_RESPONSE"
					}
				}
			};
			return;
		}
		if (rejectedProtocol) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: rejectedReason === "echo" ? "网页端本次输出的是一段历史内容回放（不是真要执行调用），已丢弃并自动重试；无需处理。" : rejectedReason === "unbalanced" ? "网页端本次输出被截断，调用没收全，已丢弃并自动重试；无需处理。" : "网页端本次的调用格式无法解析，已丢弃并自动重试；无需处理。",
						code: "EMPTY_RESPONSE"
					}
				}
			};
			return;
		}
		if (!(outputChars > 0)) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: "DeepSeek 网页端返回了空响应（可能触发频控或长上下文截断）",
						code: "EMPTY_RESPONSE"
					}
				}
			};
			return;
		}
		if (looksMidSentence(textBlock?.text ?? "")) logger?.warn?.(`deepseek-web: 回答在句中被截且自动续写额度已用尽，按正常完成上报（尾部：${JSON.stringify((textBlock?.text ?? "").slice(-60))}）`);
		yield {
			type: "finish",
			reason: { kind: "stop" }
		};
	}
	return adapter;
}
/** 供 UI 展示的账号摘要。 */
function describeAuth(auth) {
	if (!hasUsableAuth(auth)) return {
		loggedIn: false,
		hasCookie: false,
		hasFingerprint: false
	};
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
		tokenLength: auth.token.length
	};
}
//#endregion
//#region src/browser-login.ts
/**
* 浏览器登录（CDP 版）—— 用**系统里真实的 Edge/Chrome** 当登录窗口。
*
* 为什么需要它（2026-09-11 DSH 更新后的架构变化）：
*   DSH 把插件宿主从 Electron **主进程**挪到了 **utility 进程**（实测 `process.type === 'utility'`）。
*   utility 进程里 `require('electron')` 拿不到 `BrowserWindow` / `session`（那是主进程专属 API），
*   于是原来「插件自己开一个 BrowserWindow 登录」的做法直接炸在 `session.fromPartition` 上。
*   而且新架构也没有给插件暴露任何「开窗口 / 开外部 URL」的通用服务
*   （`desktopRuntime` 只有 openTerminal / pickDirectory / openProfileCreateWindow 这类专用接口）。
*
* 做法：拉起一个**可见的真实浏览器**（独立 profile 目录 + 远程调试端口），用 CDP 读：
*   - `localStorage.userToken`（网页端的真实 token，AppKit 包装 `{"value":"…"}` → 解包）
*   - `Storage.getCookies`（cookie 串，免去 DPAPI 解密）
*   - `Network.*` 事件里的 `/api/*` 真实请求头（authorization / x-hif-* / x-client-*）
*   - `navigator.userAgent`（后续 API 请求要用同一个 UA）
* 优点：真实浏览器不会被网页端判「使用环境异常」；也不依赖任何 Electron API。
*
* 踩坑记录（都已在代码里规避）：
*   1) **必须用 `--remote-debugging-port=0`**：Windows 保留了大量端口区间
*      （实测 8792-9897、10001-10100… 全被排除），硬编码端口会 `bind()` 失败（WSAEACCES 10013），
*      Chromium 报 "Cannot start http server for devtools"。端口 0 由系统分配，然后把真实端口
*      写进 `<profile>/DevToolsActivePort`（第一行端口、第二行 ws 路径）。
*   2) 未登录时 `localStorage.userToken` 是 `{"value":null,"__version":"0"}` ——
*      解包必须把 null 当空值，不能把字符串 "null" 当 token。
*   3) 用**独立 profile**（`<DSH_HOME>/web-login/browser-profile`）：既避免和用户正在用的浏览器
*      抢单实例（同 user-data-dir 会转发给已有实例、调试端口根本不起来），也让登录态可复用。
*/
/** 找系统里可用的 Chromium 系浏览器（Edge 优先：Windows 必装）。 */
function findSystemBrowser() {
	const pf = process.env.ProgramFiles || "C:\\Program Files";
	const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
	const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
	const candidates = process.platform === "win32" ? [
		{
			name: "Microsoft Edge",
			path: join(pf86, "Microsoft", "Edge", "Application", "msedge.exe")
		},
		{
			name: "Microsoft Edge",
			path: join(pf, "Microsoft", "Edge", "Application", "msedge.exe")
		},
		{
			name: "Google Chrome",
			path: join(pf, "Google", "Chrome", "Application", "chrome.exe")
		},
		{
			name: "Google Chrome",
			path: join(pf86, "Google", "Chrome", "Application", "chrome.exe")
		},
		{
			name: "Google Chrome",
			path: join(local, "Google", "Chrome", "Application", "chrome.exe")
		}
	] : process.platform === "darwin" ? [{
		name: "Google Chrome",
		path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	}, {
		name: "Microsoft Edge",
		path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
	}] : [
		{
			name: "Google Chrome",
			path: "/usr/bin/google-chrome"
		},
		{
			name: "Chromium",
			path: "/usr/bin/chromium"
		},
		{
			name: "Chromium",
			path: "/usr/bin/chromium-browser"
		},
		{
			name: "Microsoft Edge",
			path: "/usr/bin/microsoft-edge"
		}
	];
	for (const candidate of candidates) try {
		if (existsSync(candidate.path)) return candidate;
	} catch {}
	return null;
}
/** 启动参数（纯函数，便于单测）：**必须**带 `--remote-debugging-port=0`。 */
function buildBrowserArgs(profileDir, url) {
	return [
		"--remote-debugging-port=0",
		"--remote-debugging-address=127.0.0.1",
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--no-service-autorun",
		"--disable-background-mode",
		url
	];
}
/** 解析 `<profile>/DevToolsActivePort`：第一行是端口；容忍 CRLF 与附带内容。 */
function parseDevToolsActivePort(text) {
	const first = String(text ?? "").split(/\r?\n/)[0]?.trim();
	if (!first) return void 0;
	const port = Number(first);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : void 0;
}
/** 从 CDP 的 cookie 列表拼出请求用的 cookie 串（只取 deepseek 域）。纯函数。 */
function buildCookieHeader(cookies) {
	return (cookies ?? []).filter((cookie) => cookie && typeof cookie.name === "string" && String(cookie.domain ?? "").includes("deepseek")).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
/**
* 从 `/api/*` 请求头里挑出我们需要的指纹/版本头（与旧 webRequest 钩子同款规则）。
* 纯函数，便于单测。
*/
function pickExtraHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		const lower = key.toLowerCase();
		if (!/^x-/.test(lower)) continue;
		if (lower === "x-ds-pow-response" || lower === "x-hif-dliq" || lower === "x-hif-leim") continue;
		out[lower] = String(value);
	}
	const acceptLanguage = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "accept-language");
	if (acceptLanguage) out["accept-language"] = String(acceptLanguage[1]);
	return out;
}
/** 极简 CDP 客户端：只需 send + 事件监听。 */
var CdpClient = class {
	socket;
	nextId = 0;
	pending = /* @__PURE__ */ new Map();
	listeners = [];
	opened = false;
	url;
	constructor(url) {
		this.url = url;
	}
	async connect(timeoutMs = 1e4) {
		const WebSocketCtor = globalThis.WebSocket;
		if (typeof WebSocketCtor !== "function") throw new Error("当前 Node 没有全局 WebSocket，无法使用 CDP");
		const socket = new WebSocketCtor(this.url);
		this.socket = socket;
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(/* @__PURE__ */ new Error("CDP 连接超时")), timeoutMs);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				this.opened = true;
				resolve();
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error("CDP 连接失败"));
			});
		});
		socket.addEventListener("message", (event) => {
			let message;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (message.id && this.pending.has(message.id)) {
				this.pending.get(message.id)?.(message);
				this.pending.delete(message.id);
				return;
			}
			if (message.method) for (const listener of this.listeners) listener(message.method, message.params);
		});
	}
	onEvent(listener) {
		this.listeners.push(listener);
	}
	send(method, params = {}, timeoutMs = 15e3) {
		if (!this.opened) return Promise.reject(/* @__PURE__ */ new Error("CDP 未连接"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(/* @__PURE__ */ new Error(`CDP ${method} 超时`));
			}, timeoutMs);
			this.pending.set(id, (message) => {
				clearTimeout(timer);
				resolve(message.result);
			});
			this.socket.send(JSON.stringify({
				id,
				method,
				params
			}));
		});
	}
	close() {
		try {
			this.socket?.close();
		} catch {}
	}
};
const DEFAULT_TIMEOUT_MS = 3e5;
const DEFAULT_PROFILE_DIR = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "web-login", "browser-profile");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 等 CDP 的 HTTP 端点可用，返回调试端口。 */
async function waitForDebugPort(profileDir, child, timeoutMs) {
	const portFile = join(profileDir, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) return void 0;
		try {
			const port = parseDevToolsActivePort(readFileSync(portFile, "utf8"));
			if (port) try {
				if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return port;
			} catch {}
		} catch {}
		await sleep(300);
	}
}
/** 找到 chat.deepseek.com 的页面 target（等 SPA 起来）。 */
async function findPageTarget(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t?.type === "page" && String(t.url ?? "").includes("deepseek.com"));
			if (page?.webSocketDebuggerUrl) return page;
		} catch {}
		await sleep(400);
	}
	return null;
}
/**
* 完整流程：拉起真实浏览器 → CDP 抓凭证。
* 成功时返回可直接落盘的 WebAuth；失败时给出分类原因。
*/
async function browserLogin(options = {}) {
	const browser = findSystemBrowser();
	if (!browser) return {
		ok: false,
		reason: "no-browser",
		message: "没有找到 Edge/Chrome。请改用「用我的默认浏览器登录」+ 手动粘贴 Token。"
	};
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
	const pollIntervalMs = options.pollIntervalMs ?? 1200;
	const progress = options.onProgress ?? (() => {});
	try {
		mkdirSync(profileDir, { recursive: true });
	} catch {}
	progress(`正在启动 ${browser.name}（独立 profile，不会影响你日常浏览器的登录态）……`);
	let child;
	try {
		child = spawn(browser.path, buildBrowserArgs(profileDir, `${DS_BASE}/`), {
			stdio: "ignore",
			detached: false
		});
	} catch (error) {
		return {
			ok: false,
			reason: "spawn-failed",
			message: `启动 ${browser.name} 失败：${error?.message ?? error}`
		};
	}
	const cleanupBrowser = () => {
		try {
			child.kill();
		} catch {}
	};
	const port = await waitForDebugPort(profileDir, child, 25e3);
	if (!port) {
		cleanupBrowser();
		return {
			ok: false,
			reason: "no-debug-port",
			message: `${browser.name} 起来了但调试端口不可用（可能被安全软件拦截）。请改用「用我的默认浏览器登录」+ 手动粘贴 Token。`
		};
	}
	const page = await findPageTarget(port, 2e4);
	if (!page) {
		cleanupBrowser();
		return {
			ok: false,
			reason: "no-page",
			message: `${browser.name} 里没找到 chat.deepseek.com 页面。`
		};
	}
	const cdp = new CdpClient(page.webSocketDebuggerUrl);
	try {
		await cdp.connect();
	} catch (error) {
		cleanupBrowser();
		return {
			ok: false,
			reason: "cdp-failed",
			message: `连接浏览器调试接口失败：${error?.message ?? error}`
		};
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
	await cdp.send("Runtime.enable").catch(() => {});
	await cdp.send("Network.enable").catch(() => {});
	progress("浏览器已打开：请在其中登录 DeepSeek（手机号/邮箱/扫码均可）。登录成功后会自动捕获，无需复制粘贴。");
	const deadline = Date.now() + timeoutMs;
	let lastNotice = 0;
	try {
		while (Date.now() < deadline) {
			if (options.signal?.aborted) {
				cdp.close();
				cleanupBrowser();
				return {
					ok: false,
					reason: "aborted",
					message: "已取消登录。"
				};
			}
			let token = "";
			let pageUserAgent = "";
			try {
				const value = await cdp.send("Runtime.evaluate", {
					expression: "String(localStorage.getItem('userToken') || '')",
					returnByValue: true
				});
				token = unwrapStoredToken(String(value?.result?.value ?? ""));
				const ua = await cdp.send("Runtime.evaluate", {
					expression: "navigator.userAgent",
					returnByValue: true
				});
				pageUserAgent = String(ua?.result?.value ?? "");
			} catch {}
			if (token) {
				progress("已捕获 token，正在读取 cookie 与指纹头……");
				let cookie = "";
				try {
					cookie = buildCookieHeader((await cdp.send("Storage.getCookies", {}))?.cookies ?? []);
				} catch {}
				const auth = {
					token,
					cookie,
					hifDliq: String(extraHeaders["x-hif-dliq"] ?? ""),
					hifLeim: String(extraHeaders["x-hif-leim"] ?? ""),
					wasmUrl: "",
					userAgent: apiUserAgent || pageUserAgent,
					...Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {},
					capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
					unverified: true
				};
				cdp.close();
				cleanupBrowser();
				return {
					ok: true,
					auth,
					message: `已从 ${browser.name} 捕获登录态（token + ${cookie ? "cookie + " : ""}指纹头）`
				};
			}
			if (Date.now() - lastNotice > 3e4) {
				lastNotice = Date.now();
				progress(`等待登录中……（还剩约 ${Math.ceil((deadline - Date.now()) / 6e4)} 分钟；已在浏览器里登录的话下一步就会自动读取）`);
			}
			await sleep(pollIntervalMs);
		}
		cdp.close();
		return {
			ok: false,
			reason: "timeout",
			browserLeftOpen: true,
			message: `等了 ${Math.round(timeoutMs / 6e4)} 分钟没读到登录态。浏览器窗口保留着，登录完成后可以再点一次「浏览器窗口登录」（profile 复用，不用重新登录）。`
		};
	} finally {
		cdp.close();
	}
}
/** 清掉浏览器登录用的独立 profile（退出账号时调用：连浏览器端的登录态一起清）。 */
function clearBrowserLoginProfile(profileDir = DEFAULT_PROFILE_DIR) {
	try {
		rmSync(profileDir, {
			recursive: true,
			force: true
		});
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/login.ts
/**
* 网页登录：Electron 独立分区窗口（persist:dsh-deepseek-web-login）。
*
* 为什么用 Electron 窗口而不是外部浏览器 + 扩展/CDP：
*   DSH Desktop 本身就是 Electron 主进程，插件直接开窗口即可 ——
*   窗口内用户正常完成手机号/密码/验证码登录，插件旁路捕获：
*     1) webRequest.onBeforeSendHeaders 抓 /api/* 的真实 Authorization（权威 token）、
*        Cookie、x-hif-* 指纹头、x-client-* 版本头
*     2) 读 localStorage —— ⚠️ 实测（2026-09）新版网页端的 userToken 是 AppKit 包装的
*        JSON：`{"value":"<token>",...}`，必须解包；早期版本才是裸字符串。
*        把包装 JSON 原文当 token 会被服务端判 40003 Authorization Failed。
*     3) 校验通过即落盘；**校验不通过也先落盘（fail-open）**，避免出现
*        「用户已登录成功、但校验端点不配合 → 凭证永远拿不到」的死局。
* 非 Electron 环境（纯 web profile）自动降级为「手动粘贴 token」。
*/
const PARTITION = "persist:dsh-deepseek-web-login";
const LOGIN_URL = `${DS_BASE}/`;
/** 当前运行环境对应的平台串（与 Chromium 的取值一致）。 */
function platformToken() {
	if (process.platform === "win32") return "Windows NT 10.0; Win64; x64";
	if (process.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
	return "X11; Linux x86_64";
}
/**
* 构造干净的 Chrome UA（剔除 Electron/应用名）。
* Chromium 大版本取当前运行时真实版本，避免出现「UA 版本与能力不符」这类更明显的矛盾。
*/
function buildLoginUserAgent(chromiumVersion = process.versions.chrome) {
	const major = String(chromiumVersion ?? "").split(".")[0] || "131";
	return `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
/**
* 清掉 UA-CH（Sec-CH-UA*）里的 Electron/应用品牌 —— 只改 UA 字符串是不够的：
* Chromium 还会通过 client hints 把品牌列表发出去，里面同样带着非浏览器品牌。
* 纯函数，便于单测。
*/
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
		out[key] = brands.length > 0 ? brands.join(", ") : "\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"";
	}
	return out;
}
/** 把干净指纹应用到分区与窗口（session 管网络，webContents 管页面里的 navigator.userAgent）。 */
function applyBrowserFingerprint(ses, win) {
	const ua = buildLoginUserAgent();
	try {
		ses.setUserAgent(ua);
	} catch {}
	try {
		win.webContents.setUserAgent(ua);
	} catch {}
}
/**
* 页面内归一化 + 回读「网页端实际看到的指纹」。
*
* 为什么要回读：服务端对两种 UA 返回的 HTML 完全一样（实测 2026-09-11 探针），
* 说明「使用环境异常」是**页面内 JS**判定的。既然如此，就必须能看到**页面到底看到了什么**，
* 否则永远只能猜（UA 改没改对、品牌列表脏不脏、webdriver 是不是 true）。
*
* 归一化只动「非浏览器品牌」与 webdriver 这两个明确属于自动化痕迹的字段；
* 没有 Electron 痕迹时不做任何改写。
*/
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
			Promise.resolve(promise).then((raw) => {
				try {
					const info = JSON.parse(String(raw));
					report.pageUa = String(info.ua ?? "");
					report.pageBrands = Array.isArray(info.brands) ? info.brands.map(String) : void 0;
					report.pageWebdriver = !!info.webdriver;
					fingerprintReport = {
						...fingerprintReport ?? {
							at: (/* @__PURE__ */ new Date()).toISOString(),
							url: LOGIN_URL,
							stripped: []
						},
						...report
					};
				} catch {}
			}).catch(() => {});
		} catch {}
	};
	try {
		win.webContents.on("dom-ready", read);
		win.webContents.on("did-finish-load", read);
	} catch {}
}
let loginWindow = null;
let pollTimer = null;
let progress = { open: false };
let lastResult;
let fingerprintReport;
function getFingerprintReport() {
	return fingerprintReport;
}
/**
* 用**系统默认浏览器**打开 chat.deepseek.com（兜底路径）。
*
* 适用场景：网页端连干净指纹的窗口也拦、或者用户就是想用自己的日常浏览器。
* 注意：外部浏览器里的登录态插件抓不到（没有 webRequest 钩子），
* 所以这条路径要和「手动粘贴 token」配合 —— 面板里给了现成的控制台命令。
*
* ⚠️ 2026-09-11：插件宿主在 **utility 进程**里没有 `shell`（主进程专属），所以加了
* 纯 Node 的打开方式（Windows `start` / macOS `open` / Linux `xdg-open`），保证任何宿主都能用。
*/
async function openExternalLogin() {
	if (canOpenElectronWindow()) try {
		await createRequire(import.meta.url)("electron").shell.openExternal(LOGIN_URL);
		return {
			ok: true,
			url: LOGIN_URL,
			via: "electron-shell"
		};
	} catch (error) {}
	try {
		const { spawn } = createRequire(import.meta.url)("node:child_process");
		const args = process.platform === "win32" ? [
			"/c",
			"start",
			"",
			LOGIN_URL
		] : process.platform === "darwin" ? [LOGIN_URL] : [LOGIN_URL];
		const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
		spawn(command, args, {
			stdio: "ignore",
			detached: true
		}).unref?.();
		return {
			ok: true,
			url: LOGIN_URL,
			via: command
		};
	} catch (error) {
		return {
			ok: false,
			url: LOGIN_URL,
			message: `${error?.message ?? error} —— 请手动在浏览器打开 ${LOGIN_URL}`
		};
	}
}
function getLoginProgress() {
	return progress;
}
function getLastLoginResult() {
	return lastResult;
}
/**
* 本进程能否**真的开 Electron 窗口**（= Electron 主进程，且 electron 模块带 session/BrowserWindow）。
*
* ⚠️ 旧实现只检查 `process.versions.electron`，在 DSH 把插件宿主挪到 **utility 进程**之后成了**假阳性**：
* `process.versions.electron` 依然有值，但 utility 进程里 `require('electron')` 拿不到
* `BrowserWindow` / `session`（它们是主进程专属 API）→ 检查通过、随后炸在 `session.fromPartition`
* （实测：`Cannot read properties of undefined (reading 'fromPartition')`，面板表现是「窗口登录打不开」）。
*/
function canOpenElectronWindow() {
	return canOpenElectronWindowWith({
		versions: process.versions,
		processType: process.type,
		loadElectron: () => createRequire(import.meta.url)("electron")
	});
}
/**
* canOpenElectronWindow 的纯函数内核（便于用真实事故参数做单测）。
* 判定条件三条缺一不可：① 是 Electron 运行时；② 进程类型是主进程；③ electron 模块真的带窗口 API。
*/
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
/** 兼容旧调用点：语义即「能否使用 Electron 能力」，因此等同于 canOpenElectronWindow。 */
function electronAvailable() {
	return canOpenElectronWindow();
}
function isLoginWindowOpen() {
	return !!loginWindow;
}
function cleanup() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	loginWindow = null;
	progress = {
		...progress,
		open: false
	};
}
/** 页面内取值脚本：处理 AppKit 包装（{"value":...}）与裸值两种形态。 */
const PAGE_READ_SCRIPT = `JSON.stringify({
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
	const html = `<!doctype html><meta charset="utf-8"><title>DSH · 登录成功</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0f1115;color:#e6e6e6;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 .card{text-align:center;padding:36px 48px;border:1px solid #2a2f3a;border-radius:14px;background:#151922}
 .ok{font-size:44px;margin-bottom:10px}
 .sub{color:#8b93a3;font-size:13px;margin-top:8px}
</style>
<div class="card"><div class="ok">✅</div><div>${message}</div>
<div class="sub">此窗口将自动关闭，可回到 DSH 继续使用</div></div>`;
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
function newBuffer() {
	return {
		headerToken: "",
		localToken: "",
		cookie: "",
		hifDliq: "",
		hifLeim: "",
		wasmUrl: "",
		userAgent: "",
		extraHeaders: {},
		user: {}
	};
}
/** 候选 token：请求头里的（服务端实际在用，权威）优先，其次 localStorage。 */
function tokenCandidates(buffer) {
	return [...new Set([buffer.headerToken, buffer.localToken].filter((token) => !!token && token.length > 8))];
}
function buildAuth(buffer, token, unverified) {
	return {
		token,
		cookie: buffer.cookie,
		hifDliq: buffer.hifDliq,
		hifLeim: buffer.hifLeim,
		wasmUrl: buffer.wasmUrl || "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm",
		userAgent: buffer.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		...Object.keys(buffer.extraHeaders).length > 0 ? { extraHeaders: buffer.extraHeaders } : {},
		capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
		...unverified ? { unverified: true } : {},
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
		const relevant = (await ses.cookies.get({})).filter((cookie) => String(cookie?.domain ?? "").includes("deepseek.com"));
		if (relevant.length > 0) buffer.cookie = relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
	} catch {}
}
async function readPage(win, buffer) {
	try {
		const raw = await win.webContents.executeJavaScript(PAGE_READ_SCRIPT, true);
		const info = typeof raw === "string" ? JSON.parse(raw) : raw;
		const token = unwrapStoredToken(info?.userToken);
		if (token) buffer.localToken = token;
		if (info?.hifLeim) buffer.hifLeim = String(info.hifLeim);
		if (info?.wasm) buffer.wasmUrl = String(info.wasm);
		if (info?.userInfo) try {
			const parsed = JSON.parse(String(info.userInfo));
			if (parsed?.id) buffer.user.id = String(parsed.id);
			if (parsed?.name) buffer.user.display = String(parsed.name);
		} catch {}
	} catch {}
}
/**
* 在 session 上挂请求头捕获钩子（同时负责剔除 Electron 指纹）。
* ⚠️ 一个 session 只能注册一个 onBeforeSendHeaders 处理器（后注册会覆盖先注册），
* 所以「清理指纹」必须合并在同一个回调里，不能另开一个。
*/
function hookHeaders(ses, buffer, onRewrite) {
	ses.webRequest.onBeforeSendHeaders({ urls: ["https://chat.deepseek.com/*", "https://*.deepseek.com/*"] }, (details, callback) => {
		const headers = { ...details?.requestHeaders ?? {} };
		const lower = {};
		for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = String(value);
		const sanitized = sanitizeClientHints(headers);
		const stripped = [];
		for (const key of Object.keys(headers)) if (String(headers[key]) !== String(sanitized[key])) stripped.push(key.toLowerCase());
		for (const key of Object.keys(headers)) delete headers[key];
		Object.assign(headers, sanitized);
		if (stripped.length > 0) onRewrite?.({
			url: String(details?.url ?? ""),
			stripped
		});
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
				const snapshot = {};
				for (const [key, value] of Object.entries(cleanLower)) {
					if (!/^x-/.test(key)) continue;
					if (key === "x-ds-pow-response" || key === "x-hif-dliq" || key === "x-hif-leim") continue;
					snapshot[key] = value;
				}
				if (cleanLower["accept-language"]) snapshot["accept-language"] = cleanLower["accept-language"];
				buffer.extraHeaders = snapshot;
			}
		}
		callback({ requestHeaders: headers });
	});
}
/**
* 打开登录窗口并开始捕获（分区已登录时几乎是瞬间完成）。
*/
async function openLoginWindow(logger) {
	if (!electronAvailable()) return {
		started: false,
		reason: "not-electron"
	};
	if (loginWindow) {
		try {
			loginWindow.focus();
		} catch {}
		return {
			started: true,
			reason: "already-open"
		};
	}
	const { BrowserWindow, session } = createRequire(import.meta.url)("electron");
	const buffer = newBuffer();
	fingerprintReport = void 0;
	progress = {
		open: true,
		startedAt: (/* @__PURE__ */ new Date()).toISOString(),
		captured: progressFrom(buffer)
	};
	const ses = session.fromPartition(PARTITION);
	try {
		hookHeaders(ses, buffer, (info) => {
			if (!fingerprintReport) {
				fingerprintReport = {
					at: (/* @__PURE__ */ new Date()).toISOString(),
					url: info.url,
					stripped: info.stripped
				};
				logger?.info?.(`deepseek-web login: 已剔除 Electron 指纹头 [${info.stripped.join(", ")}]`);
			} else fingerprintReport = {
				...fingerprintReport,
				stripped: info.stripped
			};
		});
	} catch (error) {
		logger?.warn?.(`deepseek-web login: header capture unavailable: ${error?.message ?? error}`);
	}
	const win = new BrowserWindow({
		width: 1180,
		height: 840,
		title: "DSH · 登录 DeepSeek 网页版（登录后自动捕获）",
		autoHideMenuBar: true,
		webPreferences: {
			session: ses,
			nodeIntegration: false,
			contextIsolation: true
		}
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
		writeAuth(auth);
		lastResult = {
			ok: true,
			message: verified ? `登录成功${auth.user?.display ? `（${maskIdentifier(auth.user.display)}）` : ""}，凭证已保存并校验通过` : "已捕获并保存凭证，但服务端校验未通过（可用「发送测试」做真实判定）",
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		logger?.info?.(`deepseek-web login: credentials saved (verified=${verified})`);
		progress = {
			...progress,
			finished: true
		};
		if (!verified) {
			try {
				win.setTitle("DSH · 已捕获凭证（未通过服务端校验，可直接关闭此窗口）");
			} catch {}
			return;
		}
		try {
			await win.loadURL(successPage("已捕获 DeepSeek 网页端登录状态"));
		} catch {}
		setTimeout(() => {
			try {
				win.close();
			} catch {}
		}, 3500);
	};
	let attempts = 0;
	pollTimer = setInterval(() => {
		(async () => {
			if (!loginWindow) return;
			await readPage(win, buffer);
			await readCookies(ses, buffer);
			progress.captured = progressFrom(buffer);
			const candidates = tokenCandidates(buffer);
			if (candidates.length === 0) return;
			attempts += 1;
			let lastError = "";
			for (const token of candidates) {
				const auth = buildAuth(buffer, token, false);
				const check = await validateAuth(auth);
				if (check.ok) {
					await finish({
						...auth,
						...check.user ? { user: {
							...auth.user,
							...check.user
						} } : {}
					}, true);
					return;
				}
				lastError = check.error ?? "validation failed";
			}
			progress = {
				...progress,
				lastError
			};
			if (attempts >= 3) await finish(buildAuth(buffer, candidates[0], true), false);
		})();
	}, 2e3);
	pollTimer.unref?.();
	return { started: true };
}
/**
* 从已登录的持久化分区恢复凭证（免重新登录）。
* 用于凭证文件被删/未落盘、或重启后快速恢复。
*/
async function captureFromPartition(logger) {
	if (!electronAvailable()) return {
		ok: false,
		verified: false,
		message: "当前环境不是 Electron 桌面端"
	};
	const { BrowserWindow, session } = createRequire(import.meta.url)("electron");
	const ses = session.fromPartition(PARTITION);
	const buffer = newBuffer();
	let win;
	try {
		win = new BrowserWindow({
			show: false,
			width: 1e3,
			height: 720,
			webPreferences: {
				session: ses,
				nodeIntegration: false,
				contextIsolation: true
			}
		});
		try {
			hookHeaders(ses, buffer);
		} catch {}
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
		} catch {}
		return {
			ok: false,
			verified: false,
			message: `打开分区失败：${error?.message ?? error}`
		};
	}
	try {
		if (win && !win.isDestroyed()) win.close();
	} catch {}
	const candidates = tokenCandidates(buffer);
	if (candidates.length === 0) return {
		ok: false,
		verified: false,
		message: "分区里没有登录态：请先用「浏览器窗口登录」登录一次"
	};
	for (const token of candidates) {
		const auth = buildAuth(buffer, token, false);
		const check = await validateAuth(auth);
		if (check.ok) {
			writeAuth({
				...auth,
				...check.user ? { user: {
					...auth.user,
					...check.user
				} } : {}
			});
			lastResult = {
				ok: true,
				message: "已从已登录窗口恢复凭证（校验通过）",
				at: (/* @__PURE__ */ new Date()).toISOString()
			};
			logger?.info?.("deepseek-web login: recovered credentials from partition (verified)");
			return {
				ok: true,
				verified: true,
				message: "已从已登录窗口恢复凭证（校验通过）"
			};
		}
	}
	writeAuth(buildAuth(buffer, candidates[0], true));
	lastResult = {
		ok: true,
		message: "已从已登录窗口恢复凭证（未通过服务端校验）",
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	logger?.info?.("deepseek-web login: recovered credentials from partition (unverified)");
	return {
		ok: true,
		verified: false,
		message: "已恢复凭证，但服务端校验未通过（可用「发送测试」验证）"
	};
}
/** 手动粘贴 token 登录（非 Electron 环境 / 用户偏好）。 */
async function loginWithToken(token, cookie, logger) {
	const trimmed = unwrapStoredToken(token) || String(token ?? "").trim();
	if (trimmed.length < 8) return {
		ok: false,
		error: "token 太短，请确认复制的是 chat.deepseek.com 的登录 token"
	};
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
		writeAuth({
			...auth,
			unverified: true
		});
		lastResult = {
			ok: true,
			message: `凭证已保存，但服务端校验未通过：${check.error ?? ""}`,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		logger?.info?.("deepseek-web login: token saved (unverified)");
		return {
			ok: true,
			error: `已保存（未通过校验：${check.error ?? "unknown"}）`
		};
	}
	writeAuth({
		...auth,
		...check.user ? { user: check.user } : {}
	});
	lastResult = {
		ok: true,
		message: `token 校验通过，凭证已保存${check.user?.display ? `（${maskIdentifier(check.user.display)}）` : ""}`,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	logger?.info?.("deepseek-web login: token saved");
	return {
		ok: true,
		...check.user?.display ? { display: maskIdentifier(check.user.display) } : {}
	};
}
/**
* 清掉登录窗口所在 Electron 分区里的 **chat.deepseek.com 站点数据**（cookie / localStorage）。
*
* 为什么必须做：只删本地凭证文件的话，浏览器分区里仍是同一个账号的登录态 ——
* 于是「退出当前账号」之后：
*   1) 再点「从已登录窗口恢复」会把**同一个账号**原样抓回来（用户以为退不掉）；
*   2) 点「浏览器窗口登录」打开的是已登录页面，根本没法换号。
* 只清 deepseek 域，不动分区里的其它数据；失败静默（退出登录本身必须成功）。
*/
async function clearLoginPartition() {
	if (!electronAvailable()) return false;
	try {
		await createRequire(import.meta.url)("electron").session.fromPartition(PARTITION).clearStorageData({
			origin: "https://chat.deepseek.com",
			storages: [
				"cookies",
				"localstorage",
				"indexdb",
				"cachestorage",
				"serviceworkers",
				"websql"
			]
		});
		return true;
	} catch {
		return false;
	}
}
/**
* 退出登录：关闭登录窗口 → 清除本地凭证 → **清除浏览器分区里的站点登录态**。
*
* 最后一步是 2026-09-11 补的：此前只有前两步，导致「退出」在网页端看来根本没退出
* （同一个账号随时能被恢复回来，也无法切换到另一个账号）。
*/
/**
* 只关闭登录窗口（不动凭证）。
* 卸载/热重载插件时用它 —— 卸载插件不应该把用户登出（这是旧实现的一个隐患：
* 卸载时它调用的是 logout()，会把凭证一起删掉）。
*/
function closeLoginWindow() {
	if (loginWindow) try {
		loginWindow.close();
	} catch {}
	cleanup();
}
async function logout() {
	closeLoginWindow();
	clearAuth();
	const browserProfileCleared = clearBrowserLoginProfile();
	const cleared = await clearLoginPartition().catch(() => false) || browserProfileCleared;
	lastResult = {
		ok: true,
		message: cleared ? "已退出登录：本地凭证与浏览器登录态都已清除" : "已退出登录：本地凭证已清除（浏览器登录态未能清理——非主进程环境或清理失败，登录窗口可能仍是旧账号，请手动退出网页端）",
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	return cleared;
}
const TRANSPORT_HINT = "Chromium 网络栈会跟随**系统代理**（Node 则完全无视代理）。若梯子关闭时系统代理仍指向 127.0.0.1:7897，切到 Chromium 后请求会失败 —— 这时切回 Node 即可。";
/** 取 Electron 的 `net.fetch`；不可用（非 Electron 环境 / 未暴露 net）返回 undefined。 */
function electronNetFetch() {
	try {
		const impl = createRequire(import.meta.url)("electron")?.net?.fetch;
		return typeof impl === "function" ? impl : void 0;
	} catch {
		return;
	}
}
function transportSettingsPath() {
	return join(resolveDshHome(), "web-login", "transport.json");
}
function readTransportSetting() {
	try {
		const file = transportSettingsPath();
		if (!existsSync(file)) return void 0;
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed?.transport === "node" || parsed?.transport === "chromium" ? parsed.transport : void 0;
	} catch {
		return;
	}
}
function writeTransportSetting(kind) {
	const file = transportSettingsPath();
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify({ transport: kind }, null, 2) + "\n", "utf8");
}
/**
* 决定实际用哪个。
*
* 降级只在**启动时**按能力判定（拿不到 `electron.net.fetch` 就用 Node），
* **不做「请求失败后自动换一条重试」** —— 完成请求一旦重发可能就是一次重复生成，
* 代价比"切错了手动改回来"大得多。
*/
function resolveTransportState(requested) {
	const chromiumAvailable = electronNetFetch() !== void 0;
	if (requested === "chromium" && chromiumAvailable) return {
		requested,
		effective: "chromium",
		degraded: false,
		chromiumAvailable
	};
	if (requested === "chromium") return {
		requested,
		effective: "node",
		degraded: true,
		chromiumAvailable
	};
	return {
		requested,
		effective: "node",
		degraded: false,
		chromiumAvailable
	};
}
/** 把状态落到 webapi 的注入层（`undefined` 即还原为 Node 全局 fetch）。 */
function applyTransportState(state) {
	setFetchImpl(state.effective === "chromium" ? electronNetFetch() : void 0);
}
/** 读设置 → 解析 → 应用，一步到位。 */
function applyTransport(requested) {
	const state = resolveTransportState(requested);
	applyTransportState(state);
	return state;
}
//#endregion
//#region src/net-diagnostics.ts
/**
* net.fetch 诊断 —— 验证「把网页端请求从 Node 网络栈切到 Chromium 网络栈」是否可行。
*
* 背景（2026-09-12 实测）：
*  - 用 Node 的 fetch（undici）与 Chrome 分别请求 tls.peet.ws，指纹差异是**结构性**的：
*    JA4 的 h1 vs h2、Node 无 GREASE、cipher 55 个 vs 15 个、扩展集合完全不同。
*    也就是说请求在 TLS 层就能被判定为「非浏览器客户端」。
*  - 参考项目 cuckoo-code / deepseek-pp 都**不让 Node 发请求**（前者内嵌浏览器、后者 hook 用户浏览器），
*    从未被风控 —— 印证了"请求从哪出去"才是关键差异。
*  - DSH 本体是 Electron，插件宿主是 **utility 进程**。官方文档：`net` 模块适用 Main + Utility，
*    且 utility 的网络请求默认走 Chromium 的 system network context。
*  - 实测能力探测（2026-09-12）确认：utility 进程里 `require('electron')` 只暴露
*    `net` 与 `systemPreferences`，其中 **`net.fetch` 是 function** ✅
*
* 所以理论上不必引入 uTLS / curl-impersonate，换一处传输层就能拿到浏览器指纹。
* 但动主路径之前必须先坐实三件事，本模块就是干这个的：
*  ① TLS/HTTP2 指纹是否真的变成浏览器（请求第三方检测站，零额度）
*  ② **能否读流式响应**（`response.body` + AbortSignal）—— 这是成败点：
*     拿不到 body 就没法读 SSE，整条改造路线直接作废。用**本地分块服务**测，
*     确定性、零外部依赖、零额度。
*  ③ 鉴权是否照常（header / cookie 原样透传：请求 DeepSeek 的 users/current，只读不生成）
*
* 另有一个可选档 `stream`：再跑一次迷你 completion（**会消耗一点额度**），
* 端到端验证 DeepSeek 的 SSE 流。默认不跑。
*
* 触发方式（两种共用同一份实现）：
*  - 接口：`POST /deepseek-web-login/api/diagnostics/net-fetch`，body `{"mode":"probe"|"stream"}`
*  - 启动时：往 `<DSH_HOME>/web-login/probe-request.json` 写 `{"mode":"probe"}` 后重启 DSH
*    （宿主进程的 HTTP 端点只有 DSH 自己的同源页面打得通，从外部 curl 会撞同源守卫；
*    读完会把文件改名为 `*.done-<时间>`，不删文件）
*/
/**
* 用一次本地分块响应，验证指定 fetch 能否**增量读流**并支持 AbortSignal。
* 导出是为了单测 —— 这条判据本身必须可被正/反向验证（见 tests/check-net-diagnostics.mjs）。
*
* 为什么不直接打远程：这一步只关心传输实现的流式能力，本地服务是确定性的 ——
* 不受外网抖动/代理影响，也不会产生任何真实请求。服务器写满 50 个分片才算完，
* 我们读到 3 个就 abort，同时观察服务端是否看到连接被断开。
*/
async function probeStreamingSupport(fetchImpl) {
	const evidence = {
		chunks: 0,
		abortedEarly: false
	};
	let server;
	let reader;
	let timer;
	let aborted = false;
	try {
		server = createServer((req, res) => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache"
			});
			let n = 0;
			timer = setInterval(() => {
				n += 1;
				res.write(`data: chunk-${n}\n\n`);
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
		evidence.url = `http://127.0.0.1:${server.address()?.port}/`;
		const controller = new AbortController();
		const response = await fetchImpl(evidence.url, { signal: controller.signal });
		evidence.status = response.status;
		evidence.hasBody = !!response.body;
		if (!response.body) {
			evidence.ok = false;
			evidence.error = "response.body 为空 —— 无法读 SSE，改造路线不成立";
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
		if (evidence.chunks < 3) evidence.error = `只读到 ${evidence.chunks} 个分片，疑似被整体缓冲`;
		else if (!evidence.abortedEarly) evidence.error = "abort 之后服务端仍认为连接开着，AbortSignal 可能未生效";
		return evidence;
	} catch (error) {
		evidence.ok = false;
		evidence.error = error?.message ?? String(error);
		return evidence;
	} finally {
		try {
			await reader?.cancel();
		} catch {}
		if (timer) clearInterval(timer);
		try {
			server?.closeAllConnections?.();
			server?.close();
		} catch {}
	}
}
/**
* 跑一轮诊断。
*
* `probe`（默认，**零额度**）：指纹 + 流式能力 + 鉴权，三步都不产生生成请求。
* `stream`：在 probe 之上再跑一次迷你 completion（**会消耗一点额度**），端到端验证 DeepSeek 的 SSE。
*
* 整个过程**不改变主请求路径** —— 注入的传输层用完即还原（finally 保证）。
*/
async function runNetFetchDiagnostics(auth, mode = "probe") {
	const netFetch = electronNetFetch();
	if (!netFetch) return {
		ok: false,
		error: "electron.net.fetch 不可用（宿主未暴露 net）"
	};
	const transportBefore = fetchImplKind();
	const results = [];
	try {
		const response = await netFetch("https://tls.peet.ws/api/all");
		const payload = await response.json();
		results.push({
			step: "① netFetch → tls.peet.ws（指纹）",
			ok: true,
			status: response.status,
			ja3_hash: payload?.tls?.ja3_hash,
			ja4: payload?.tls?.ja4,
			http2_hash: payload?.http2?.akamai_fingerprint_hash,
			http_version: payload?.http_version,
			ua: String(payload?.user_agent ?? "").slice(0, 70)
		});
	} catch (error) {
		results.push({
			step: "① netFetch → tls.peet.ws（指纹）",
			ok: false,
			error: error?.message ?? String(error)
		});
	}
	results.push({
		step: "② netFetch 本地分块流（response.body + AbortSignal）",
		...await probeStreamingSupport(netFetch)
	});
	if (!auth) results.push({
		step: "③ netFetch → users/current（鉴权）",
		ok: false,
		error: "尚未登录"
	});
	else try {
		const started = Date.now();
		const response = await netFetch("https://chat.deepseek.com/api/v0/users/current", {
			headers: buildDsHeaders(auth),
			signal: AbortSignal.timeout(2e4)
		});
		const text = await response.text();
		results.push({
			step: "③ netFetch → users/current（鉴权）",
			ok: response.ok,
			status: response.status,
			ms: Date.now() - started,
			body: text.slice(0, 240)
		});
	} catch (error) {
		results.push({
			step: "③ netFetch → users/current（鉴权）",
			ok: false,
			error: error?.message ?? String(error)
		});
	}
	if (mode === "stream" && auth) {
		setFetchImpl(netFetch);
		try {
			const started = Date.now();
			let chunks = 0;
			let sample = "";
			for await (const event of streamWebCompletion(auth, {
				prompt: "只回复两个字：好的",
				thinkingEnabled: false,
				modelType: "default",
				refFileIds: [],
				idleTimeoutMs: 3e4,
				onDeleteSession: (sessionId) => scheduleDeleteSession(auth, sessionId)
			})) if (event?.kind === "text") {
				chunks += 1;
				sample += String(event.text ?? "");
				if (chunks >= 6) break;
			}
			results.push({
				step: "④ netFetch → DeepSeek 流式 completion（端到端）",
				ok: true,
				text_chunks: chunks,
				ms: Date.now() - started,
				sample: sample.slice(0, 80)
			});
		} catch (error) {
			results.push({
				step: "④ netFetch → DeepSeek 流式 completion（端到端）",
				ok: false,
				code: error?.code,
				error: error?.message ?? String(error)
			});
		} finally {
			setFetchImpl();
			results.push({
				step: "传输层已还原",
				ok: true,
				was: transportBefore,
				now: fetchImplKind()
			});
		}
	}
	return {
		ok: true,
		mode,
		transportBefore,
		transportAfter: fetchImplKind(),
		results
	};
}
/** 启动探测的标记文件路径（与 gate.json 同目录，沿用 DSH_HOME 约定）。 */
function probeRequestPath() {
	return join(resolveDshHome(), "web-login", "probe-request.json");
}
/**
* 读并"消费"启动探测请求。读到就返回 mode，并把文件改名为 `*.done-<时间戳>`
* （本机禁止删除文件，用改名表示已执行；也留作历史记录）。
*/
function consumeProbeRequest() {
	const file = probeRequestPath();
	try {
		if (!existsSync(file)) return void 0;
		let mode = "probe";
		try {
			if (JSON.parse(readFileSync(file, "utf8"))?.mode === "stream") mode = "stream";
		} catch {}
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		renameSync(file, `${file}.done-${stamp}`);
		return mode;
	} catch {
		return;
	}
}
//#endregion
//#region src/index.ts
/**
* dsh-deepseek-web-login — 插件入口（host）。
*
* 做三件事：
*  1) 把 deepseek-web 适配器注册进 ctx.llm（注册即绑定本插件 fiber，热重载即净）
*  2) 挂 webServer 前缀 API /deepseek-web-login/api/*（client 面板消费）
*  3) 提供设置页（client 侧 slots: settings.section）所需的状态/登录/测试接口
*
* 设计约束：宿主自包含打包（除 node: 与 electron 外全部 bundle），
* 不依赖 DSH 内部包的可解析性 —— 任何装配路径（注入 / bundle / patch）都能加载。
*/
const name = "dsh-deepseek-web-login";
const inject = ["llm", "webServer"];
const API_PREFIX = "/deepseek-web-login/api";
function normalizeLogger(logger) {
	if (!logger) return {};
	return {
		info: typeof logger.info === "function" ? (message) => logger.info(message) : void 0,
		warn: typeof logger.warn === "function" ? (message) => logger.warn(message) : void 0,
		debug: typeof logger.debug === "function" ? (message) => logger.debug(message) : void 0
	};
}
async function readJsonBody(req, limitBytes = 262144) {
	return await new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limitBytes) {
				resolve(void 0);
				try {
					req.destroy();
				} catch {}
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve(void 0);
			}
		});
		req.on("error", () => resolve(void 0));
	});
}
function sendJson(res, status, payload) {
	const text = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(text);
}
function apply(ctx, config = {}) {
	const logger = normalizeLogger(ctx.logger);
	try {
		const electron = createRequire(import.meta.url)("electron");
		const net = electron?.net;
		const keys = electron && typeof electron === "object" ? Object.keys(electron).sort() : [];
		logger.info?.(`deepseek-web: [能力探测] process.type=${process.type ?? "-"} electron=${process.versions?.electron ?? "-"} | electron:${typeof electron} keys=[${keys.join(",")}] | net=${typeof net} net.fetch=${typeof net?.fetch} net.request=${typeof net?.request} | shell=${typeof electron?.shell} session=${typeof electron?.session} BrowserWindow=${typeof electron?.BrowserWindow}`);
	} catch (error) {
		logger.info?.(`deepseek-web: [能力探测] require('electron') 失败：${error?.message ?? error}`);
	}
	const startupProbe = consumeProbeRequest();
	if (startupProbe) (async () => {
		try {
			const result = await runNetFetchDiagnostics(readAuth(), startupProbe);
			logger.info?.(`deepseek-web: [net-fetch 探测] ${JSON.stringify(result)}`);
		} catch (error) {
			logger.info?.(`deepseek-web: [net-fetch 探测] 失败：${error?.message ?? error}`);
		}
	})();
	const savedGate = readGateSettings();
	const gate = createRequestGate({
		allowConcurrent: savedGate?.allowConcurrent ?? config.allowConcurrent === true,
		minIntervalMs: savedGate?.minRequestIntervalMs ?? config.minRequestIntervalMs ?? 2e3,
		logger
	});
	let transportState = applyTransport(readTransportSetting() ?? (config.transport === "node" ? "node" : "chromium"));
	logger.info?.(`deepseek-web: 传输层=${transportState.effective}` + (transportState.degraded ? "（配置要求 Chromium，但本环境没有 electron.net.fetch，已降级为 Node）" : ""));
	const adapterConfig = {
		maxPromptChars: config.maxPromptChars ?? 15e5,
		idleTimeoutMs: config.idleTimeoutMs ?? 12e4,
		deleteWebSessions: config.deleteWebSessions !== false,
		autoContinue: config.autoContinue !== false,
		maxContinuations: config.maxContinuations ?? 2,
		allowConcurrent: gate.settings().allowConcurrent,
		minRequestIntervalMs: gate.settings().minRequestIntervalMs,
		logger
	};
	const cleanupMode = savedGate?.sessionCleanup ?? config.sessionCleanup ?? DEFAULT_SESSION_CLEANUP.mode;
	const sessionCleaner = createSessionCleaner({
		policy: {
			mode: cleanupMode,
			delayMs: cleanupMode === "immediate" ? 1500 : config.sessionCleanupDelayMs ?? DEFAULT_SESSION_CLEANUP.delayMs,
			batchSize: cleanupMode === "immediate" ? 1 : config.sessionCleanupBatchSize ?? DEFAULT_SESSION_CLEANUP.batchSize
		},
		logger
	});
	const getAuth = () => readAuth();
	const adapter = createAdapter({
		getAuth,
		gate,
		sessionCleaner,
		config: adapterConfig,
		readImage: async (ref, signal) => {
			const attachments = ctx.get?.("attachments");
			if (!attachments || typeof attachments.readImage !== "function") throw new Error("attachment service unavailable (ctx.attachments)");
			const stored = await attachments.readImage(ref, signal);
			return {
				data: stored.data,
				...stored.ref?.mediaType ? { mediaType: String(stored.ref.mediaType) } : {},
				...stored.ref?.name ? { name: String(stored.ref.name) } : {}
			};
		}
	});
	ctx.llm.registerAdapter([PROVIDER], adapter);
	logger.info?.(`deepseek-web: 已注册 provider "${PROVIDER}"（模型：${MODEL_SPECS.map((spec) => spec.id).join(", ")}）`);
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
			const route = url.pathname.slice(23) || "/";
			try {
				if (req.method === "GET" && route === "/gate") {
					sendJson(res, 200, {
						...gate.settings(),
						presets: INTERVAL_PRESETS.map(([lo, hi]) => ({
							min: lo,
							max: hi
						})),
						maxIntervalMs: MAX_INTERVAL_MS,
						defaultMinIntervalMs: DEFAULT_MIN_REQUEST_INTERVAL_MS,
						defaultMaxIntervalMs: DEFAULT_MAX_REQUEST_INTERVAL_MS,
						cleanup: sessionCleaner.policy()
					});
					return;
				}
				if (req.method === "POST" && route === "/gate") {
					const body = await readJsonBody(req);
					if (!body || typeof body !== "object") {
						sendJson(res, 400, {
							ok: false,
							error: "请求体不是合法 JSON"
						});
						return;
					}
					const patch = {};
					if (typeof body.allowConcurrent === "boolean") patch.allowConcurrent = body.allowConcurrent;
					for (const field of ["minRequestIntervalMs", "maxRequestIntervalMs"]) {
						if (body[field] === void 0) continue;
						const ms = Number(body[field]);
						if (!Number.isFinite(ms)) {
							sendJson(res, 400, {
								ok: false,
								error: `${field} 必须是数字`
							});
							return;
						}
						patch[field] = ms;
					}
					if (body.sessionCleanup !== void 0) {
						if (![
							"immediate",
							"deferred",
							"keep"
						].includes(body.sessionCleanup)) {
							sendJson(res, 400, {
								ok: false,
								error: "sessionCleanup 只能是 immediate / deferred / keep"
							});
							return;
						}
						patch.sessionCleanup = body.sessionCleanup;
					}
					if (Object.keys(patch).length === 0) {
						sendJson(res, 400, {
							ok: false,
							error: "没有可更新的字段"
						});
						return;
					}
					const applied = gate.configure(patch);
					if (patch.sessionCleanup) sessionCleaner.configure({ mode: patch.sessionCleanup });
					try {
						writeGateSettings(applied);
					} catch (error) {
						logger.warn?.(`deepseek-web: 节流设置落盘失败：${error?.message ?? error}`);
						sendJson(res, 200, {
							ok: true,
							...applied,
							persisted: false,
							warning: "已即时生效，但写入 gate.json 失败，重启后会回到旧值"
						});
						return;
					}
					sendJson(res, 200, {
						ok: true,
						...applied,
						persisted: true
					});
					return;
				}
				if (req.method === "GET" && route === "/transport") {
					sendJson(res, 200, {
						...transportState,
						hint: TRANSPORT_HINT,
						settingsPath: transportSettingsPath()
					});
					return;
				}
				if (req.method === "POST" && route === "/transport") {
					const wanted = (await readJsonBody(req))?.transport;
					if (wanted !== "chromium" && wanted !== "node") {
						sendJson(res, 400, {
							ok: false,
							error: "transport 必须是 'chromium' 或 'node'"
						});
						return;
					}
					transportState = applyTransport(wanted);
					let persisted = true;
					try {
						writeTransportSetting(wanted);
					} catch {
						persisted = false;
					}
					logger.info?.(`deepseek-web: 传输层切换为 ${transportState.effective}` + (transportState.degraded ? "（要求 Chromium 但本环境不可用，已降级 Node）" : ""));
					sendJson(res, 200, {
						ok: true,
						...transportState,
						persisted,
						hint: TRANSPORT_HINT,
						settingsPath: transportSettingsPath()
					});
					return;
				}
				if (req.method === "POST" && route === "/diagnostics/net-fetch") {
					const mode = (await readJsonBody(req))?.mode === "stream" ? "stream" : "probe";
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
						validation = {
							ok: check.ok,
							...check.error ? { error: check.error } : {}
						};
						if (check.ok && check.user && auth && (!auth.user || auth.user.display !== check.user.display)) writeAuth({
							...auth,
							user: check.user
						});
					}
					let registeredProviders = [];
					try {
						registeredProviders = (ctx.llm.listProviders() ?? []).map((provider) => String(provider?.id ?? provider));
					} catch {}
					sendJson(res, 200, {
						provider: PROVIDER,
						registeredProviders,
						electron: canOpenElectronWindow(),
						loginWindowOpen: isLoginWindowOpen(),
						loginProgress: getLoginProgress(),
						fingerprint: getFingerprintReport(),
						lastLoginResult: getLastLoginResult(),
						loginCapability: {
							processType: process.type ?? "node",
							canOpenWindow: canOpenElectronWindow(),
							browser: findSystemBrowser()?.name ?? null
						},
						auth: summary,
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
							minRequestIntervalMs: adapterConfig.minRequestIntervalMs ?? 2e3,
							sessionCleanup: cleanupMode,
							sessionCleanupPending: sessionCleaner.pendingCount(),
							transport: transportState.effective
						}
					});
					return;
				}
				if (req.method === "POST" && route === "/login/browser") {
					if (canOpenElectronWindow()) {
						sendJson(res, 200, {
							...await openLoginWindow(logger),
							mode: "window"
						});
						return;
					}
					const outcome = await browserLogin({
						onProgress: (message) => logger?.info?.(`deepseek-web login(browser): ${message}`),
						signal: void 0
					});
					if (outcome.ok && outcome.auth) {
						writeAuth(outcome.auth);
						const check = await validateAuth(outcome.auth).catch(() => void 0);
						const verified = !!check?.ok;
						sendJson(res, 200, {
							started: true,
							mode: "browser",
							ok: true,
							verified,
							message: verified ? `${outcome.message}，服务端校验通过` : `${outcome.message}；服务端校验未通过（${check?.error ?? "未知原因"}）——可用「发送测试」再确认`,
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
					sendJson(res, 200, await openExternalLogin());
					return;
				}
				if (req.method === "POST" && route === "/login/token") {
					const body = await readJsonBody(req);
					if (!body || typeof body.token !== "string") {
						sendJson(res, 400, {
							ok: false,
							error: "请求体需要 { token: string, cookie?: string }"
						});
						return;
					}
					sendJson(res, 200, await loginWithToken(body.token, typeof body.cookie === "string" ? body.cookie : void 0, logger));
					return;
				}
				if (req.method === "POST" && route === "/login/recover") {
					sendJson(res, 200, await captureFromPartition(logger));
					return;
				}
				if (req.method === "POST" && route === "/logout") {
					sendJson(res, 200, {
						ok: true,
						partitionCleared: await logout()
					});
					return;
				}
				if (req.method === "POST" && route === "/test") {
					const body = await readJsonBody(req);
					const model = typeof body?.model === "string" ? body.model : "deepseek-chat";
					const prompt = typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt : "请用一句话确认你已连通。";
					const started = Date.now();
					const text = [];
					const reasoning = [];
					const toolCalls = [];
					let finish;
					try {
						const options = {
							provider: PROVIDER,
							model,
							system: "你是连通性测试探针，回答保持简短。",
							messages: [{
								id: "dsw-test-1",
								role: "user",
								content: [{
									type: "text",
									text: prompt
								}],
								source: { kind: "user" }
							}],
							signal: AbortSignal.timeout(9e4)
						};
						for await (const chunk of adapter.stream(options)) if (chunk?.type === "text-delta") text.push(chunk.text);
						else if (chunk?.type === "reasoning-delta") reasoning.push(chunk.text);
						else if (chunk?.type === "tool-call-delta") toolCalls.push(`${chunk.name ?? "?"}(${chunk.argumentsDelta ?? ""})`);
						else if (chunk?.type === "finish") finish = chunk.reason;
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
				logger.warn?.(`deepseek-web api ${route} failed: ${error?.message ?? error}`);
				sendJson(res, 500, { error: error?.message ?? String(error) });
			}
		}
	}), "dsh-deepseek-web-login: api");
	ctx.effect(() => () => {
		try {
			if (isLoginWindowOpen()) closeLoginWindow();
		} catch {}
	}, "dsh-deepseek-web-login: teardown");
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.js.map