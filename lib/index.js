import { createRequire } from "node:module";
import { homedir } from "node:os";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
		const resp = await fetch(url, {
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
		const html = await (await fetch(`${DS_BASE}/`, { signal: signal ?? AbortSignal.timeout(15e3) })).text();
		const direct = html.match(/https?:\/\/[^"'\s]*sha3[_a-z0-9.]*\.wasm/i);
		if (direct) return direct[0];
		const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => match[1]).slice(0, 8);
		for (const src of scripts) {
			const url = src.startsWith("http") ? src : new URL(src, `${DS_BASE}/`).href;
			try {
				const found = (await (await fetch(url, { signal: AbortSignal.timeout(15e3) })).text()).match(/[^"'\s]*sha3[_a-z0-9.]*\.wasm/i);
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
		const resp = await fetch(wasmUrl, { signal: AbortSignal.timeout(15e3) });
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
		resp = await fetch(`${DS_BASE}/api/v0/chat/create_pow_challenge`, {
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
		resp = await fetch(`${DS_BASE}${targetPath}`, {
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
		resp = await fetch(`${DS_BASE}/api/v0/chat_session/create`, {
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
/** 尽力删除一个网页端会话（避免污染用户网页端聊天列表）。失败静默。 */
function scheduleDeleteSession(auth, sessionId, delayMs = 1500) {
	setTimeout(() => {
		(async () => {
			try {
				await fetch(`${DS_BASE}/api/v0/chat_session/delete`, {
					method: "POST",
					headers: buildDsHeaders(auth),
					body: JSON.stringify({ chat_session_id: sessionId }),
					signal: AbortSignal.timeout(1e4)
				});
			} catch {}
		})();
	}, delayMs).unref?.();
}
/** 验证登录态：优先 users/current，端点不存在时退回 PoW challenge 探活。 */
async function validateAuth(auth, signal) {
	try {
		const resp = await fetch(`${DS_BASE}/api/v0/users/current`, {
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
/** 网页端 completion 负载的解析状态机（可单测：handle 返回待 yield 的事件）。 */
function createSseState() {
	const fragments = [];
	let fragmentsText = "";
	let fragmentsThinking = "";
	let directText = "";
	let directThinking = "";
	let emittedText = 0;
	let emittedThinking = 0;
	let sink = null;
	let pendingFinish;
	let sawData = false;
	const fullText = () => fragments.length > 0 ? fragmentsText : directText;
	const fullThinking = () => fragments.length > 0 ? fragmentsThinking : directThinking;
	/** 计算两条逻辑流的增量（快照重放/交错格式下都只吐新增部分）。 */
	const emitDiffs = (out) => {
		const thinking = fullThinking();
		if (thinking.length > emittedThinking) {
			const delta = thinking.slice(emittedThinking);
			emittedThinking = thinking.length;
			if (delta) out.push({
				kind: "thinking",
				text: delta
			});
		}
		const text = fullText();
		if (text.length > emittedText) {
			const delta = text.slice(emittedText);
			emittedText = text.length;
			if (delta) out.push({
				kind: "text",
				text: delta
			});
		}
	};
	/** 重建 fragments 派生文本（快照覆盖时用）。 */
	const rebuildFragmentText = () => {
		fragmentsText = "";
		fragmentsThinking = "";
		for (const fragment of fragments) if (isReasoningType(fragment.type)) fragmentsThinking += fragment.content;
		else fragmentsText += fragment.content;
	};
	const pushFragments = (incoming) => {
		const list = Array.isArray(incoming) ? incoming : incoming !== void 0 ? [incoming] : [];
		for (const f of list) if (f && typeof f === "object" && typeof f.content === "string") {
			const fragment = {
				type: String(f.type ?? "RESPONSE"),
				content: f.content,
				emitted: 0
			};
			fragments.push(fragment);
			if (isReasoningType(fragment.type)) fragmentsThinking += fragment.content;
			else fragmentsText += fragment.content;
		}
		sink = fragments.length > 0 ? "fragments" : null;
	};
	const appendToFragment = (fragment, text) => {
		fragment.content += text;
		if (isReasoningType(fragment.type)) fragmentsThinking += text;
		else fragmentsText += text;
	};
	const appendSink = (text) => {
		if (sink === "thinking") directThinking += text;
		else if (sink === "content") directText += text;
		else if (sink === "fragments") {
			const fragment = fragments[fragments.length - 1];
			if (fragment) appendToFragment(fragment, text);
		}
	};
	return {
		/** 负载处理（只改状态，返回即时事件；文本增量由外层 handle 统一发射）。 */
		handlePayload(d, eventName) {
			const out = [];
			sawData = true;
			if (d && typeof d === "object" && d.v && typeof d.v === "object" && d.v.response && typeof d.v.response === "object") {
				const response = d.v.response;
				if (Array.isArray(response.fragments)) {
					fragments.length = 0;
					for (const f of response.fragments) if (f && typeof f === "object" && typeof f.content === "string") fragments.push({
						type: String(f.type ?? "RESPONSE"),
						content: f.content,
						emitted: 0
					});
					rebuildFragmentText();
					sink = fragments.length > 0 ? "fragments" : null;
				}
				if (typeof response.content === "string") {
					directText = response.content;
					sink = "content";
				}
				if (response.finish_reason !== void 0 && response.finish_reason !== null) pendingFinish = String(response.finish_reason);
				return out;
			}
			if (d && typeof d === "object" && d.type === "error") {
				const message = typeof d.content === "string" ? d.content : typeof d.message === "string" ? d.message : "model error";
				out.push({
					kind: "error",
					message,
					...d.finish_reason !== void 0 ? { raw: String(d.finish_reason) } : {}
				});
				return out;
			}
			if (eventName === "toast") {
				const message = d && typeof d === "object" ? d.content ?? d.message ?? JSON.stringify(d) : String(d);
				out.push({
					kind: "error",
					message: `DeepSeek toast: ${String(message).slice(0, 200)}`
				});
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
					pushFragments(value);
					return out;
				case "response/fragments/-1/content":
					if (typeof value === "string") {
						const fragment = fragments[fragments.length - 1];
						if (fragment) appendToFragment(fragment, value);
						else directText += value;
						sink = "fragments";
					}
					return out;
				case "response/thinking_content":
					if (typeof value === "string") {
						directThinking += value;
						sink = "thinking";
					}
					return out;
				case "response/content":
					if (typeof value === "string") {
						directText += value;
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
						for (const op of value) if (op && typeof op === "object" && op.p === "fragments" && op.o === "APPEND" && op.v !== void 0) pushFragments(op.v);
					}
					return out;
				default: return out;
			}
			if (typeof value === "string" && value.length > 0) appendSink(value);
			return out;
		},
		/** 对外入口：先跑负载逻辑，再把两条逻辑流的增量吐出来（快照重放不重复）。 */
		handle(d, eventName) {
			const out = this.handlePayload(d, eventName);
			emitDiffs(out);
			return out;
		},
		/** 流结束：产出 finish（若确实收到过数据）。 */
		finish() {
			return sawData ? [{
				kind: "finish",
				reason: pendingFinish
			}] : [];
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
/** 发起一次网页版完成请求并流式产出事件；会话在结束时尽力删除。 */
async function* streamWebCompletion(auth, params) {
	const idle = params.idleTimeoutMs ?? 12e4;
	const controller = new AbortController();
	const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;
	const sessionId = await createChatSession(auth, signal);
	params.onDeleteSession?.(sessionId);
	const powHeader = await createPowHeader(auth, "/api/v0/chat/completion", signal);
	let resp;
	try {
		resp = await fetch(`${DS_BASE}/api/v0/chat/completion`, {
			method: "POST",
			headers: {
				...buildDsHeaders(auth, `${DS_BASE}/a/chat/s/${sessionId}`),
				accept: "text/event-stream",
				"x-ds-pow-response": powHeader
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
		throw new AdapterLlmError(`DeepSeek web completion failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ""}${hint}`, code, {
			status: resp.status,
			...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {},
			cause: new Error(text)
		});
	}
	if (!resp.body) throw new AdapterLlmError("DeepSeek web completion returned no body", "EMPTY_RESPONSE");
	const contentType = String(resp.headers.get("content-type") ?? "");
	if (!contentType.includes("text/event-stream")) {
		const text = await resp.text().catch(() => "");
		let biz;
		try {
			biz = envelopeError(JSON.parse(text));
		} catch {}
		throw new AdapterLlmError(biz ? bizErrorMessage(biz.code, biz.msg) : `DeepSeek 网页端返回了非流式响应（content-type: ${contentType || "unknown"}）：${text.slice(0, 200)}`, biz ? bizErrorCode(biz.code) : "MALFORMED_RESPONSE", { status: resp.status });
	}
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
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable.
6. Do NOT use XML/HTML-like markup such as <tool_calls>, <invoke>, <parameter>, <|DSML|>, or any fenced variant of them. The JSON object above is the ONLY accepted format; markup text would be shown to the user as broken output instead of running the tool.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).`;
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
* 亦兼容 DeepSeek 自家的 `|DSML|` 前缀与 `dsml-` 连字符变体）。
*/
const XML_STARTER_RE = /<(?:\|\s*DSML\s*\|)?(?:dsml-)?(tool_calls|function_calls|invoke)\b/i;
/** 代码围栏收尾（模型常把调用块放进 ``` 里）。 */
const FENCE_TAIL_RE = /\n?[ \t]*```[a-zA-Z0-9]*[ \t]*\n?$/;
const FENCE_HEAD_RE = /^[ \t]*\n?```[ \t]*\n?/;
/** 归一化 DSML 噪声：`<|DSML|invoke>` / `</|DSML|invoke>` / `<｜DSML｜>` / `<dsml-invoke>` → 标准标签。 */
function normalizeDsml(text) {
	return text.replace(/<(\/?)\s*[|｜]\s*DSML\s*[|｜]\s*(?=[a-zA-Z_])/gi, "<$1").replace(/<\s*dsml-/gi, "<").replace(/<\/\s*dsml-/gi, "</");
}
/** 判断 tail 末尾是否是（可能的）标记前缀 —— 决定是否 hold back。 */
function partialMarkerSuffixLength(text) {
	const from = Math.max(0, text.length - 32);
	const tail = normalizeDsml(text.slice(from));
	const braceAt = tail.lastIndexOf("{");
	const angleAt = tail.lastIndexOf("<");
	const startAt = Math.max(braceAt, angleAt);
	if (startAt === -1) return 0;
	const rest = tail.slice(startAt);
	const offsetFromTail = tail.length - rest.length;
	const consumed = text.length - from - offsetFromTail;
	const JSON_STARTERS = ["{\"tool_calls\"", "{\"tool_call\""];
	if (rest.startsWith("{")) {
		const body = rest.replace(/^\{\s*/, "");
		return JSON_STARTERS.some((starter) => starter.startsWith(`{"${body}`)) ? consumed : 0;
	}
	if (rest.startsWith("<")) {
		if (XML_STARTER_RE.test(rest)) return 0;
		const XML_PREFIXES = [
			"<tool_calls",
			"<tool_call",
			"<function_calls",
			"<invoke",
			"<|dsml|",
			"<｜dsml｜",
			"<dsml-"
		];
		const lower = rest.toLowerCase();
		return XML_PREFIXES.some((prefix) => prefix.startsWith(lower) || lower.startsWith(prefix.slice(0, lower.length))) ? consumed : 0;
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
function* jsonRepairCandidates(text) {
	const pathTail = (value) => value.replace(/([A-Za-z]:[^"]*?)\\"(?=[,}\]\s])/g, "$1\\\\\"");
	yield repairJsonText(pathTail(text), { mode: "smart" });
	yield repairJsonText(text, { mode: "smart" });
	yield repairJsonText(pathTail(text), { mode: "conservative" });
	yield repairJsonText(text, { mode: "conservative" });
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
	const invokeRe = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;
	const calls = [];
	let invoke;
	while ((invoke = invokeRe.exec(text)) !== null) {
		const name = readAttr(invoke[1], "name");
		if (!name) continue;
		const body = invoke[2];
		const args = {};
		let sawParam = false;
		const paramRe = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
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
	return calls.length > 0 ? calls : null;
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
* 在捕获缓冲里找 XML 调用块的结束位置（含结束标签）。
* - 包裹式（`<tool_calls>` / `<function_calls>`）：找对应闭合标签
* - 裸 `<invoke>`：找到 `</invoke>` 后继续吞并紧随其后的 invoke 块（同一批调用）
* 返回 -1 表示尚未收全（继续等流）。
*/
function findXmlToolCallEnd(buffer) {
	const text = buffer;
	const wrapper = /<\s*(?:\|\s*DSML\s*\|\s*)?(?:dsml-)?(tool_calls|function_calls)\b/i.exec(text);
	const startsWithWrapper = wrapper !== null && wrapper.index === 0;
	const isInvokeStart = (value) => /^\s*<\s*(?:\|\s*DSML\s*\|\s*)?(?:dsml-)?invoke\b/i.test(value);
	if (startsWithWrapper) {
		const tag = wrapper[1].toLowerCase();
		const match = new RegExp(`</\\s*(?:\\|\\s*DSML\\s*\\|\\s*)?(?:dsml-)?${tag}\\s*>`, "i").exec(text);
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
			const calls = captured.mode === "xml" ? parseXmlToolCalls(captured.buffer) : parseToolCallJson(captured.buffer.replace(FENCE_HEAD_RE, ""));
			if (calls) out.calls.push(...calls);
			else out.text += captured.buffer;
			this.capture = null;
		}
		out.text += this.pending;
		this.pending = "";
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
							out.text += captured.buffer;
							this.capture = null;
							continue;
						}
						return;
					}
					const block = captured.buffer.slice(0, end);
					const calls = parseXmlToolCalls(block);
					if (calls) out.calls.push(...calls);
					else out.text += block;
					this.capture = null;
					this.pending = captured.buffer.slice(end).replace(FENCE_HEAD_RE, "") + this.pending;
					continue;
				}
				const balanced = extractBalancedJson(captured.buffer);
				if (!balanced) {
					if (captured.buffer.length > MAX_CAPTURE_CHARS) {
						out.text += captured.buffer;
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
				out.text += captured.buffer.slice(0, balanced.end);
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
* 容量：服务器声明 `normal_history_and_file_token_limit = 890880`
* （1M 总量扣除输出预留后的可用预算）、单请求 `input_character_limit = 2621440` 字符。
* 因此 contextWindow 取 890880，送出的 prompt 字符上限由 maxPromptChars 控制。
*/
const MODEL_SPECS = [{
	id: "deepseek-chat",
	name: "DeepSeek 网页 · 快速模式（不思考）",
	description: "同一模型，thinking 关闭：直接作答、最快、最省免费额度。适合工具调用/改写/检索类任务",
	modelType: "default",
	thinking: false,
	configurableThinking: true,
	contextWindow: 890880,
	maxOutputTokens: 16384
}, {
	id: "deepseek-reasoner",
	name: "DeepSeek 网页 · 快速模式（深度思考）",
	description: "同一模型，thinking 开启：先推理再作答（推理流作为思考块回传）。适合数学/多步调试/规划，更慢也更耗额度",
	modelType: "default",
	thinking: true,
	configurableThinking: true,
	contextWindow: 890880,
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
* 网页端 finish 归一。
* 实测：正常完成必定带 `response/status: FINISHED`；若流在没有该标记的情况下结束，
* 说明被服务端上限打断（`completion_request_timeout_ms = 60000`，网页端靠
* sse_auto_resume 续接，本适配器不实现续接）→ 报 max-tokens 而不是假装 stop，
* 让上层知道回答被截断。
*/
function mapFinish(reason) {
	if (reason === void 0) return { kind: "max-tokens" };
	const text = String(reason).toUpperCase();
	if (text.includes("LENGTH") || text.includes("MAX_TOKEN")) return { kind: "max-tokens" };
	return { kind: "stop" };
}
/** 构造 deepseek-web 适配器（鸭子类型满足 LlmAdapter 契约，无需继承）。 */
function createAdapter(deps) {
	const logger = deps.config.logger;
	const adapter = {
		providerInfo(provider) {
			return {
				id: provider,
				name: "DeepSeek 网页版（免费）"
			};
		},
		/** 未配置策略 → 走 dsh-llm 默认重试码表（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT）。 */
		providerRetryPolicy(_provider) {},
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
				stream: (options) => streamImpl(options)
			});
		},
		stream(options) {
			return streamImpl(options);
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
			maxChars: deps.config.maxPromptChars ?? 12e5
		});
		const filter = new ToolCallStreamFilter(new Set((options?.tools ?? []).map((tool) => String(tool?.name ?? ""))));
		let nextIndex = 0;
		let textBlock = null;
		let textStarted = false;
		let reasoningBlock = null;
		let reasoningStarted = false;
		let toolCallCount = 0;
		let finishReason;
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
			for await (const event of streamWebCompletion(auth, {
				prompt,
				thinkingEnabled,
				modelType: spec.modelType,
				refFileIds,
				signal: options?.signal,
				idleTimeoutMs: deps.config.idleTimeoutMs ?? 12e4,
				onDeleteSession: deps.config.deleteWebSessions === false ? void 0 : (sessionId) => {
					scheduleDeleteSession(auth, sessionId);
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
					if (out.text) {
						const block = openText();
						if (!textStarted) {
							textStarted = true;
							yield {
								type: "block-start",
								index: block.index,
								blockType: "text"
							};
						}
						block.text += out.text;
						yield {
							type: "text-delta",
							index: block.index,
							text: out.text
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
					throw new AdapterLlmError(`DeepSeek 网页端返回错误：${event.message}`, "PROVIDER_ERROR");
				}
				if (event.kind === "finish") finishReason = event.reason;
			}
			const tail = filter.flush();
			if (tail.text) {
				const block = openText();
				if (!textStarted) {
					textStarted = true;
					yield {
						type: "block-start",
						index: block.index,
						blockType: "text"
					};
				}
				block.text += tail.text;
				yield {
					type: "text-delta",
					index: block.index,
					text: tail.text
				};
			}
			if (tail.calls.length > 0) yield* emitCalls(tail.calls);
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
		yield {
			type: "finish",
			reason: mapFinish(finishReason)
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
let loginWindow = null;
let pollTimer = null;
let progress = { open: false };
let lastResult;
function getLoginProgress() {
	return progress;
}
function getLastLoginResult() {
	return lastResult;
}
/** 当前进程是否跑在 Electron 主进程里（DSH Desktop 是；纯 web profile 不是）。 */
function electronAvailable() {
	if (!process.versions?.electron) return false;
	try {
		createRequire(import.meta.url)("electron");
		return true;
	} catch {
		return false;
	}
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
/** 解包页面读回的 token（兼容裸字符串与 AppKit 包装 JSON）。 */
function unwrapStoredToken(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return "";
	if (text.startsWith("{")) try {
		const parsed = JSON.parse(text);
		return typeof parsed?.value === "string" ? parsed.value : "";
	} catch {
		return "";
	}
	return text;
}
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
/** 在 session 上挂请求头捕获钩子。 */
function hookHeaders(ses, buffer) {
	ses.webRequest.onBeforeSendHeaders({ urls: ["https://chat.deepseek.com/*", "https://*.deepseek.com/*"] }, (details, callback) => {
		const headers = { ...details?.requestHeaders ?? {} };
		const lower = {};
		for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = String(value);
		if (String(details?.url ?? "").includes("/api/")) {
			if (!buffer.userAgent && lower["user-agent"]) buffer.userAgent = lower["user-agent"];
			const authHeader = lower["authorization"];
			if (authHeader?.toLowerCase().startsWith("bearer ")) buffer.headerToken = authHeader.slice(7).trim();
			if (lower["cookie"]) buffer.cookie = lower["cookie"];
			if (lower["x-hif-dliq"]) buffer.hifDliq = lower["x-hif-dliq"];
			if (lower["x-hif-leim"]) buffer.hifLeim = lower["x-hif-leim"];
			if (!buffer.extraHeaders["x-client-version"]) {
				const snapshot = {};
				for (const [key, value] of Object.entries(lower)) {
					if (!/^x-/.test(key)) continue;
					if (key === "x-ds-pow-response" || key === "x-hif-dliq" || key === "x-hif-leim") continue;
					snapshot[key] = value;
				}
				if (lower["accept-language"]) snapshot["accept-language"] = lower["accept-language"];
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
	progress = {
		open: true,
		startedAt: (/* @__PURE__ */ new Date()).toISOString(),
		captured: progressFrom(buffer)
	};
	const ses = session.fromPartition(PARTITION);
	try {
		hookHeaders(ses, buffer);
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
/** 退出登录：关闭登录窗口并清除本地凭证。 */
function logout() {
	if (loginWindow) try {
		loginWindow.close();
	} catch {}
	cleanup();
	clearAuth();
	lastResult = {
		ok: true,
		message: "已退出登录并清除本地凭证",
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
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
	const adapterConfig = {
		maxPromptChars: config.maxPromptChars ?? 12e5,
		idleTimeoutMs: config.idleTimeoutMs ?? 12e4,
		deleteWebSessions: config.deleteWebSessions !== false,
		logger
	};
	const getAuth = () => readAuth();
	const adapter = createAdapter({
		getAuth,
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
						electron: electronAvailable(),
						loginWindowOpen: isLoginWindowOpen(),
						loginProgress: getLoginProgress(),
						lastLoginResult: getLastLoginResult(),
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
							deleteWebSessions: adapterConfig.deleteWebSessions !== false
						}
					});
					return;
				}
				if (req.method === "POST" && route === "/login/browser") {
					sendJson(res, 200, await openLoginWindow(logger));
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
					logout();
					sendJson(res, 200, { ok: true });
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
			if (isLoginWindowOpen()) logout();
		} catch {}
	}, "dsh-deepseek-web-login: teardown");
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.js.map