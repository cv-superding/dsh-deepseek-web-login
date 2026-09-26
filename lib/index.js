import { createRequire } from "node:module";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
//#region src/cookies.ts
/**
* 归一化一个 cookie 的过期形态。两种来源的字段名不同，这里统一。
*
* 判定顺序：显式 `session === true` 优先；否则看 `expires` / `expirationDate`。
* 缺失、非数、`<= 0` **一律当会话级** —— CDP 对会话级给的就是 `-1`，
* 而"0"在 Unix epoch 里也毫无意义，当成有效时间会算出 1970 年。
*/
function readCookieExpiry(raw) {
	if (!raw || typeof raw !== "object") return { session: true };
	if (raw.session === true) return { session: true };
	const seconds = Number(raw.expires ?? raw.expirationDate);
	if (!Number.isFinite(seconds) || seconds <= 0) return { session: true };
	return {
		session: false,
		expiresAt: Math.round(seconds * 1e3)
	};
}
/**
* 从任意来源的 cookie 数组里挑出目标域的，转成 `CookieMeta`。
*
* ⚠️ `filter` 由调用方给出、且**必须与该处拼 cookie 头的过滤条件逐字一致**：
* 这些元信息要描述的正是"请求里实际带上的那批 cookie"。两条捕获路径原本的过滤条件
* 不同（真实浏览器那条用 `deepseek`，Electron 那条用 `deepseek.com`），
* 这里刻意不强行统一 —— 统一就等于改了请求头内容，而那个改动是没法靠单测兜住的。
*/
function pickCookieMeta(cookies, filter) {
	const out = [];
	for (const raw of cookies ?? []) {
		const name = typeof raw?.name === "string" ? raw.name : "";
		if (!name) continue;
		const domain = String(raw?.domain ?? "");
		if (!filter(domain)) continue;
		const { session, expiresAt } = readCookieExpiry(raw);
		out.push({
			name,
			domain,
			session,
			...expiresAt !== void 0 ? { expiresAt } : {}
		});
	}
	return out;
}
/**
* 规整"已经归一化过"的 `CookieMeta` 数组（从磁盘读账号记录时用）。
* 形状不对的条目直接丢掉，不抛错 —— 一份坏记录不该让整个账号库读不出来。
*/
function normalizeCookieMetaList(raw) {
	if (!Array.isArray(raw)) return void 0;
	const out = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const name = typeof item.name === "string" ? item.name : "";
		if (!name) continue;
		const expiresRaw = Number(item.expiresAt);
		const hasExpiry = Number.isFinite(expiresRaw) && expiresRaw > 0;
		const session = item.session === true || !hasExpiry;
		out.push({
			name,
			domain: typeof item.domain === "string" ? item.domain : "",
			session,
			...session ? {} : { expiresAt: Math.round(expiresRaw) }
		});
	}
	return out.length > 0 ? out : void 0;
}
/**
* 汇总结论。**没有记录时返回 `undefined`**（而不是全 0 的对象）——
* 调用方要区分"没采到过期信息"（老记录 / 手动粘 token）和"采到了、全是会话级"，
* 这两种情况的界面文案完全不同。
*/
function summarizeCookieLife(metas, now = Date.now()) {
	const list = metas ?? [];
	if (list.length === 0) return void 0;
	const persistent = list.filter((item) => !item.session && Number.isFinite(item.expiresAt));
	let latest;
	for (const item of persistent) {
		const expiresAt = item.expiresAt;
		if (!latest || expiresAt > latest.expiresAt) latest = {
			name: item.name,
			expiresAt,
			daysLeft: (expiresAt - now) / 864e5
		};
	}
	return {
		total: list.length,
		sessionCount: list.length - persistent.length,
		persistentCount: persistent.length,
		...latest ? { latest } : {}
	};
}
//#endregion
//#region src/paths.ts
/**
* 路径解析 —— 单独成文件，避免 auth.ts ↔ accounts.ts 互相 import 形成环。
*
* 约定：插件的所有本地状态都放在 `${DSH_HOME || ~/.dsh}/web-login/` 下，
* **不进 settings/credentials 缝合口** —— 那里是通用配置面，不适合放网页端凭证。
*/
/** DSH 主目录（与生态一致的解析顺序）。 */
function resolveDshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}
/** 插件自己的状态目录。 */
function webLoginDir() {
	return join(resolveDshHome(), "web-login");
}
/**
* 旧版单账号凭证文件（0.1.25 及以前只有这一个账号）。
* 现在改为账号库，但**这个路径仍然要认得** —— 用来做一次性迁移。
*/
function legacyAuthFilePath() {
	return join(webLoginDir(), "deepseek-auth.json");
}
//#endregion
//#region src/accounts.ts
/**
* 账号库 —— 把「一个账号」升级成「一库账号，一键切换」。
*
* ## 为什么要做（2026-09-12，借鉴 workbuddy-switch）
*
* 原来只有一份凭证文件（`deepseek-auth.json`），换号的代价是：
* **退出 → 清除浏览器分区 → 重新登录 → 等它捕获**，期间原来的号也回不去了。
* 参考项目把"账号"当成一等公民管理（账号卡片、状态、临期高亮、导入导出），
* 这里把其中适用的部分搬过来：**多账号并存 + 一键切换 + 导入导出**。
*
* 目录结构：
* ```
* <DSH_HOME>/web-login/
*   ├── accounts.json            # 索引：{ activeId }（顺序与展示信息都在各账号文件里）
*   ├── accounts/acc_xxxx.json   # 每个账号一份（WebAuth + 元信息），原子写 + 0600
*   └── deepseek-auth.json       # 旧版单账号文件（只用于首次迁移）
* ```
*
* ## ⚠️ 风险提示（必须让使用者看见，不只是写在文档里）
*
* 账号库让"换号"变得很容易，而**用多账号轮换规避单账号限流，是有代价的**：
*
*  1. 同一服务商会把多账号**关联**起来（同设备、同 IP、同指纹、彼此相近的行为模式）。
*     一旦被判定为"同一人的多开小号"，处置通常比单账号超频更重，且可能波及**全部**关联账号。
*  2. 因此本插件**只提供手动切换**，刻意**不做自动轮换** ——
*     真人不会在几分钟内换一个账号继续发消息，自动换号是极强的机器行为特征，
*     与本插件在传输层/间隔/会话清理上"降低机器可识别性"的努力**直接冲突**。
*  3. 账号库里的每个文件都含**可完整登录的凭证**（token + cookie）。
*     导出的备份文件同样是明文 —— 分享给别人等于把账号给出去。
*
* 换句话说：这个功能的目标是「**在你自己的多个正常账号之间切换得更省事**」
* （比如工作号/个人号），**不是**「靠轮换把限流绕过去」。
*/
const INDEX_VERSION = 1;
function accountsDir() {
	return join(webLoginDir(), "accounts");
}
function accountsIndexPath() {
	return join(webLoginDir(), "accounts.json");
}
function assertSafeAccountId(id) {
	const text = String(id ?? "");
	if (!text || text.includes("\0") || text === "." || text === ".." || /[/\\]/.test(text)) throw new Error(`账号 id 不合法（含路径分隔符或相对路径段）：${JSON.stringify(text)}`);
	return text;
}
function accountFilePath(id) {
	return join(accountsDir(), `${assertSafeAccountId(id)}.json`);
}
/** 新账号 id。用随机 id 而不是 token 哈希：token 会刷新，id 不该跟着变。 */
function newAccountId() {
	return `acc_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
/** 原子写（临时文件 + 替换），非 Windows 下收紧权限到 0600。 */
function writeJsonAtomic(file, value) {
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), {
		encoding: "utf8",
		mode: 384
	});
	try {
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
function readJson(file) {
	try {
		if (!existsSync(file)) return void 0;
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return;
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
	writeJsonAtomic(accountsIndexPath(), {
		version: INDEX_VERSION,
		...index.activeId ? { activeId: index.activeId } : {}
	});
}
/** 把任意对象规整成 AccountRecord（缺字段补默认值；凭证无效返回 undefined）。 */
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
		...(() => {
			const meta = normalizeCookieMetaList(raw.cookieMeta);
			return meta ? { cookieMeta: meta } : {};
		})(),
		...typeof raw.label === "string" && raw.label ? { label: raw.label } : {},
		...typeof raw.groupId === "string" && raw.groupId ? { groupId: raw.groupId } : {},
		...typeof raw.serverId === "string" && raw.serverId ? { serverId: raw.serverId } : {},
		...typeof raw.lastVerifiedAt === "string" ? { lastVerifiedAt: raw.lastVerifiedAt } : {},
		...raw.lastVerifyError && typeof raw.lastVerifyError?.at === "string" ? { lastVerifyError: {
			at: raw.lastVerifyError.at,
			message: String(raw.lastVerifyError.message ?? "")
		} } : {},
		...raw.limit && Number.isFinite(raw.limit?.untilMs) ? { limit: {
			untilMs: Number(raw.limit.untilMs),
			observedAt: String(raw.limit.observedAt ?? "")
		} } : {}
	};
}
/** 库里全部账号，按捕获时间倒序（最近捕获的在前）。 */
function listAccounts() {
	let names = [];
	try {
		names = readdirSync(accountsDir()).filter((name) => name.endsWith(".json") && !name.includes(".tmp-"));
	} catch {
		return [];
	}
	const records = [];
	for (const name of names) {
		const id = name.replace(/\.json$/, "");
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
		return;
	}
}
/** 当前生效的账号（没有就返回 undefined）。 */
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
	const next = normalizeRecord({
		...current,
		...patch,
		id
	}, id);
	if (!next) return void 0;
	saveAccount(next);
	return next;
}
/**
* 从账号库里移除一个账号（**删除凭证文件**）。
*
* 为什么不学其它可逆操作"改名留档"：这里存的是**可完整登录的凭证**，
* 「退出/移除」的语义就是"这份凭证不该再留在磁盘上" ——
* 留一个 `.removed-<时间>` 的明文备份会让"已登出"变成谎话（安全上的倒退）。
* 误删的保护交给两件事：界面上**二次确认**，以及账号库**导出备份**。
*/
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
/**
* 写入/更新一个账号的凭证（登录捕获、手动粘贴 token 都走这里）。
*
* 去重顺序：
*  1. 有 `serverId` 且库里已有同 `serverId` → **更新那一条**（同一账号重新捕获）；
*  2. 否则 token 完全相同的记录 → 更新（serverId 还没拿到的场景）；
*  3. 都没有 → 新增。
*
* ⚠️ **凭证字段一律以本次传入的为准，不做合并**：调用方（例如登录流程）用
* `writeAuth({ ...auth, unverified: true })` 表示"这次没校验成功"，
* 若沿用旧记录的字段，这条 `unverified` 会永远粘住、再也清不掉。
* 需要跨次保留的只有元信息（备注名/探活时间/限制状态），所以只挑那几个字段继承。
*/
function upsertAccount(auth, patch = {}) {
	const incoming = auth;
	const serverId = patch.serverId ?? incoming.serverId;
	const all = listAccounts();
	const existing = (patch.id ? all.find((item) => item.id === patch.id) : void 0) ?? (serverId ? all.find((item) => item.serverId && item.serverId === serverId) : void 0) ?? (serverId ? all.find((item) => !item.serverId && item.user?.id === serverId) : void 0) ?? all.find((item) => item.token === auth.token);
	const id = patch.id ?? existing?.id ?? newAccountId();
	const carried = {};
	for (const key of [
		"label",
		"groupId",
		"serverId",
		"lastVerifiedAt",
		"lastVerifyError",
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
	const record = normalizeRecord({
		...auth,
		...carried,
		id
	}, id);
	saveAccount(record);
	return record;
}
/**
* 打包一份导出数据（含明文凭证 —— 调用方必须把风险讲给用户）。
*
* ⚠️ 这条数据现在有两条出口，安全姿态不同：
*   1. `exportAccountsToFile()` + `POST /accounts/export`：**凭证不出宿主**，
*      宿主自己写盘、只回传路径。始终保留，是回退路径。
*   2. `POST /accounts/export-json`：把内容交给界面，由界面弹系统「另存为」写盘。
*      为了让用户能自己选保存位置，这条路躲不开（理由见 index.ts 里那个路由的注释）。
*/
function exportAccounts() {
	return {
		version: INDEX_VERSION,
		exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
		warning: "此文件含可完整登录的凭证（token + cookie），等同于账号本身，请勿分享或提交到仓库",
		accounts: listAccounts()
	};
}
/**
* 导出到**插件目录下的文件**并返回路径（`<web-login>/exports/accounts-<时间戳>.json`）。
*
* 这是回退路径：界面拿不到系统「另存为」（宿主未注入 File System Access、
* 或弹框被平台拒绝）时用它，保证导出功能永不失效。
* 优点是明文凭证不进 HTTP 响应体，只把**路径**回给界面。
*/
function exportAccountsToFile() {
	const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
	const file = join(webLoginDir(), "exports", `accounts-${stamp}.json`);
	writeJsonAtomic(file, exportAccounts());
	return {
		path: file,
		count: listAccounts().length
	};
}
/**
* 导入（校验 + 去重 + 补 id）。返回新增/更新数量。
*
* ⚠️ **绝不相信备份文件自报的 `id`**（2026-09-13 第二轮审计 N01）：
* 旧实现用 `normalizeRecord(raw)` 时**不传 fallbackId 根本不生效** ——
* `normalizeRecord` 内部仍是 `raw.id ?? fallbackId ?? newAccountId()`，
* 于是备份里写同一个 `id` 的两条不同 token 账号会**互相覆盖**（不需要路径穿越）。
* 现在导入一律**生成本地主键**，只有 token 命中才允许更新已有账号。
*
* `serverId` 同样不用于匹配：它是**备份自报**字段，不能拿它授权覆盖不同 token 的账号。
* 代价：同账号刷新 token 的备份会多出一条，需要用户手动确认合并 —— 但保护了旧凭证。
*
* 上限 500 条，避免一次导入触发对全库的重复扫描；整批非事务，中途磁盘失败可能部分导入。
*/
function importAccounts(payload) {
	const list = Array.isArray(payload) ? payload : payload?.accounts;
	if (!Array.isArray(list)) return {
		imported: 0,
		updated: 0,
		skipped: 0
	};
	if (list.length > 500) throw new RangeError(`每批最多导入 500 个账号`);
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
			record = {
				...matched,
				...candidate,
				id: matched.id,
				label: candidate.label ?? matched.label
			};
			updated += 1;
		} else {
			let id;
			do
				id = newAccountId();
			while (ids.has(id));
			ids.add(id);
			record = {
				...candidate,
				id
			};
			imported += 1;
		}
		saveAccount(record);
		tokens.set(record.token, record);
	}
	if (!activeAccountId()) {
		const first = listAccounts()[0];
		if (first) setActiveAccount(first.id);
	}
	return {
		imported,
		updated,
		skipped
	};
}
/**
* 迁移指针：最近一次迁移是否**完整**完成（失败原因留给调用方记日志）。
*
* 为什么需要它（审计 F21）：以前迁移把旧文件 `rename` 成 `.migrated-<时间戳>` **留档**，
* 于是"退出登录"删掉的是账号库里的记录，而那份**明文旧凭证**还躺在磁盘上、照样能登录 ——
* "已登出"就成了一句谎话。现在成功迁移后**删掉源文件**，失败必须能被看见，不能静默。
*/
let lastMigrationError;
/** 最近一次迁移的失败原因（undefined = 没有失败）。 */
function legacyMigrationError() {
	return lastMigrationError;
}
/**
* 一次性迁移：把 0.1.25 及以前的单账号文件搬进账号库。
*
* 旧文件在**确认新记录已落盘**之后被删除（不再留 `.migrated-*` 明文副本）。
* 返回迁移出的账号（没有则 undefined）；写入校验失败会抛错，由调用方记录。
*/
function migrateLegacyAuth() {
	const legacy = legacyAuthFilePath();
	const record = normalizeRecord(readJson(legacy));
	if (!record) return void 0;
	const existing = listAccounts().find((item) => item.token === record.token);
	const saved = existing ?? {
		...record,
		id: newAccountId()
	};
	if (!existing) saveAccount(saved);
	const verified = readAccount(saved.id);
	if (!verified || verified.token !== record.token) throw new Error("迁移写入验证失败：账号库里的记录与旧凭证不一致");
	rmSync(legacy);
	lastMigrationError = void 0;
	if (!activeAccountId()) setActiveAccount(saved.id);
	return saved;
}
/** 迁移只在"库为空 且 旧文件在"时跑一次。 */
function migrateLegacyAuthIfNeeded() {
	try {
		if (listAccounts().length > 0) return void 0;
		if (!existsSync(legacyAuthFilePath())) return void 0;
		return migrateLegacyAuth();
	} catch (error) {
		lastMigrationError = `旧凭证未清除，迁移未完整完成：${error?.message ?? error}`;
		return;
	}
}
/** 账号展示名：备注名优先，其次掩码账号，再次 id。 */
function accountTitle(record, mask) {
	if (record.label) return record.label;
	const display = record.user?.display || record.user?.id || "";
	if (!display) return `未识别账号（${record.id.replace(/^acc_/, "").slice(0, 8)}）`;
	return mask(display);
}
/** 库文件体积（供界面提示"账号库占用"，也便于发现异常膨胀）。 */
function accountsFootprint() {
	let bytes = 0;
	let count = 0;
	try {
		for (const name of readdirSync(accountsDir())) {
			if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
			count += 1;
			try {
				bytes += statSync(join(accountsDir(), name)).size;
			} catch {}
		}
	} catch {}
	return {
		count,
		bytes
	};
}
//#endregion
//#region src/auth.ts
/**
* 捕获到的凭证有没有「信息偏少」的迹象。返回 undefined = 没发现。
*
* 判据刻意保守：**cookie 与 extraHeaders 同时为空**才算 ——
* 不把"cookie 为空"单独当缺陷，因为鉴权只用 token（见 WebAuth.cookieMeta 的实测结论），
* 手工粘 token 的账号本来就没有 cookie。两者同时为空，才说明"这次捕获几乎什么都没抄到"。
*
* 2026-09-21 的现场：`acc_2df7cf2f` 正是 cookie 与 extraHeaders 双空，
* 且它 `capturedAt` 刷新后 19 秒就撞了 `code 9 / invalid ref file id`。
* ⚠️ 但这只是**时间相关**，不是已证实的因果 —— 所以这里只留痕，不据此阻断。
*/
function captureDefect(auth) {
	if (!String(auth.token ?? "").trim()) return void 0;
	const hasCookie = !!String(auth.cookie ?? "").trim();
	const hasHeaders = !!auth.extraHeaders && Object.keys(auth.extraHeaders).length > 0;
	if (hasCookie || hasHeaders) return void 0;
	return "本次捕获只拿到 token（cookie 与请求头都为空）—— 若之后出现图片引用被拒（code 9）之类的异常，优先怀疑这份凭证";
}
/** 当前生效的登录凭证（没有选择账号 → undefined）。 */
function readAuth() {
	return activeAccount();
}
/**
* 写入/更新凭证。
*
* 语义：**写进去的那个就是接下来要用的那个** —— 所有调用点（浏览器捕获、
* 手动粘 token、登录流程回填账号信息）表达的都是这个意思，所以这里顺带把它设为当前账号。
* 同一个账号重复写入会**更新原记录**（按 serverId / token 去重，见 accounts.upsertAccount）。
*/
function writeAuth(auth) {
	setActiveAccount(upsertAccount(auth).id);
}
/**
* 把「**可信校验**得到的身份」归一进凭证：`user.id` → `serverId`（去重键）。
*
* ⚠️ 为什么必须有这一步（审计 F04）：库里按 `serverId` 去重（同账号重新登录 → 更新而不是新增），
* 但 `user.id` 原本只在登录时被塞进 `user` 字段、**从没写进 `serverId`** ——
* 于是 token 一刷新，去重键就失效，同一个号在库里堆成好几条：
* 真实登录路径上「两级去重」等于没接上（既有测试是手工传 `serverId` 才通过的）。
*
* 只在**服务端校验返回了身份**之后调用（浏览器捕获、分区恢复、手动 token、/status、探活）。
* 备份文件自报的 id 不在这里采信 —— 那条路径由 `importAccounts` 单独把关。
*/
function withVerifiedIdentity(auth, user) {
	const display = typeof user?.display === "string" && user.display ? user.display : void 0;
	const serverId = typeof user?.id === "string" && user.id ? user.id : void 0;
	return {
		...auth,
		unverified: void 0,
		...display || serverId ? { user: {
			...auth.user,
			...display ? { display } : {},
			...serverId ? { id: serverId } : {}
		} } : {},
		...serverId ? { serverId } : {}
	};
}
/**
* 已经在库里的记录：用**可信校验**的结果刷新它的元信息与身份键。
*
* 与 `withVerifiedIdentity` 的分工：那个用于「凭证还没落库/正在落库」，
* 这个用于「记录已经在库里」（例如 `/status` 的迟到校验、探活）。
* 两者都**不切换当前账号**、**不会新建记录** —— 审计 F05/N02 与 F04 是同一条纪律。
*
* 返回是否真的更新了（记录不存在、或 token 已变 → 什么都不做）。
*/
function refreshVerifiedIdentity(id, token, user) {
	const record = readAccount(id);
	if (!record || record.token !== token) return false;
	const display = typeof user?.display === "string" && user.display ? user.display : void 0;
	const serverId = typeof user?.id === "string" && user.id ? user.id : void 0;
	updateAccount(id, {
		...display || serverId ? { user: {
			...record.user,
			...display ? { display } : {},
			...serverId ? { id: serverId } : {}
		} } : {},
		...serverId ? { serverId } : {},
		unverified: void 0,
		lastVerifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
		lastVerifyError: void 0
	});
	return true;
}
/**
* 退出登录：把当前账号从库里**移除**（并清掉当前指针）。
*
* 库里还有其它账号时**刻意不自动切换**：自动换号会让人以为"我只是登出了，
* 怎么又用上另一个号了"。界面会提示"账号库里还有 N 个，点「切换」即可使用"，
* 由人明确选择。
*/
function clearAuth() {
	const active = activeAccount();
	if (active) removeAccount(active.id);
	clearActiveAccount();
}
function hasUsableAuth(auth) {
	return !!auth && typeof auth.token === "string" && auth.token.length > 8;
}
/**
* 一条凭证校验失败的说明，是不是**授权类**失败（token 无效 / 过期）。
*
* 为什么必须分类（0.1.80）：`lastVerifyError` 里既有授权类失败，也有网络抖动
* （断网、超时、上游 5xx、429）。只有授权类才意味着"这份凭证真的不能用了" ——
* 把网络抖动也当成账号死了，**一次断网就会把健康账号锁住**。
* 所以这里用**白名单**：认不出来一律当"不是授权失败"（放行）。
* 代价不对等：漏拦只是白跑一轮请求（下面还有 AUTH 兜底），误拦是功能坏了。
*
* 实测会出现的几种失败串（见 probe.ts / index.ts 的写入点）：
*  · `Authorization Failed (invalid token)`（401 响应体）
*  · `users/current HTTP 401` / `HTTP 403`
*  · `DeepSeek 网页授权失败：… —— 登录态已过期或无效，请…重新登录`
* 反例（**必须放行**）：`fetch failed`、`The operation was aborted due to timeout`、
* `users/current HTTP 500`、`users/current HTTP 429`。
*/
function isAuthFailureMessage(message) {
	const text = String(message ?? "");
	if (!text) return false;
	if (/authorization failed|invalid token|unauthori[sz]ed/i.test(text)) return true;
	if (/授权失败/.test(text)) return true;
	if (/登录(态|状态)?[^。；;]{0,8}(过期|失效|无效)/.test(text)) return true;
	return /HTTP\s*40[13]\b/i.test(text);
}
/**
* 账号此刻是不是处于「已知授权失效」状态；是则返回那条失败说明。
*
* 判据与探活保持一致（见 probe.ts 的 lastProbeFailed）：**失败时间晚于成功时间**
* 才算"当前处于失败态" —— 只看有没有 `lastVerifyError` 会把"失败过、后来成功了"
* 的账号误判成死的。
*
* ⚠️ `lastVerifiedAt` 缺省时用 `''` 参与比较：ISO 串与空串比必然为真（"2" > ""），
* 这正是想要的 —— 从没成功过 + 有授权类失败 ⇒ 就是失效。别改成 `?? 'undefined'`，
* 那个字符串以 'u' 开头，会把所有比较都判成假（这类比较的经典陷阱）。
*
* 为什么要做这件事（0.1.80，2026-09-21 现场）：探活在 22:42 就判定了 token 失效，
* 但**请求路径没人看这块牌子** ⇒ 22:50 还拿它去跑，14 张图逐个走一次 POW + 一次上传
* = 28 次注定失败的请求，直到撞 AUTH 才停。判据本身早就写好了（lastProbeFailed），
* 只是没有人调用它。
*/
function staleAuthRecord(record) {
	const failure = record?.lastVerifyError;
	if (!failure) return void 0;
	if (!(String(failure.at ?? "") > String(record?.lastVerifiedAt ?? ""))) return void 0;
	if (!isAuthFailureMessage(failure.message)) return void 0;
	return String(failure.message ?? "").trim() || "登录态已失效";
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
/**
* 适配器边界错误。自带 `failure` 与 `code` 自有数据属性 ——
* LlmRuntime.normalizeLlmFailure 通过自有属性（而非 instanceof）读取结构化
* 失败信息，因此跨模块边界的自包含打包也能携带 code/status/retryAfter。
*/
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
/** 长休时长区间（1~3 分钟）。 */
const DEFAULT_LONG_RUN_BREAK_MS = {
	min: 6e4,
	max: 18e4
};
/** 长休区间的合法范围（30 秒 ~ 10 分钟）。 */
const LONG_RUN_BREAK_BOUNDS_MS = {
	min: 3e4,
	max: 6e5
};
/** 长休阈值的合法范围（0 = 关闭，上限 100 次）。 */
const LONG_RUN_THRESHOLD_BOUNDS = {
	min: 0,
	max: 100
};
/**
* 每次请求发送的 prompt **字符上限**。
*
* 为什么它是防风的头号阀门（2026-09-13 实测）：网页 API 无状态，**每一轮都要把整段转写重发**，
* 所以转写越长、单次请求越贵。同一个会话里单次输入估算从 9.7k token 涨到 **293k**，
* 180 次请求累计约 **2900 万 token**（这是我们自己的估算值，不是服务端账单，
* 但"每次都在重发历史"是代码事实）。四个账号在两天内陆续被限制，体量是主要嫌疑。
*
* 边界取值理由：
* - 上限就取**原来的默认值 150 万**：再大就有撑爆 1M 上下文的风险
*   （纯中文 150 万字符 ≈ 100 万 token）。
* - 下限取**更早的默认值 12 万**：那是长期在用的值，说明这个量级还能干活（工具目录占约 5.6 万）。
*/
const MAX_PROMPT_CHARS_BOUNDS = {
	min: 12e4,
	max: 15e5
};
/**
* **默认**上限 —— 0.1.76 起由 150 万降到 **40 万**。
*
* 它同时是一个**风控阀门**：网页端无状态，每一轮都要把整段转写重发，所以这个数字直接决定
* 单次请求的体量。会话内实测单次输入从 9.7k token 一路涨到 293k，而 150 万字符（纯中文
* ≈100 万 token）意味着默认就允许"一次顶满 1M 上下文" —— 四个账号两天内陆续被限制，
* 体量是主要嫌疑。40 万 ≈27 万 token，够跑长任务，又不会让默认配置本身贴着天花板。
*
* ⚠️ 可调范围不变（见上面的 BOUNDS）：确实需要更长的转写可以自己往上调，
* 但要知道那是在拿账号的稳定换更长的记忆 —— 面板上那个旋钮的说明写了同一件事。
*/
const DEFAULT_MAX_PROMPT_CHARS = 4e5;
/** 规整 prompt 字符上限：非数 → 默认；越界 → 夹到边界。 */
function clampMaxPromptChars(value) {
	if (!Number.isFinite(value)) return DEFAULT_MAX_PROMPT_CHARS;
	return Math.max(MAX_PROMPT_CHARS_BOUNDS.min, Math.min(MAX_PROMPT_CHARS_BOUNDS.max, Math.round(value)));
}
/**
* 一次请求最多带多少张图片（请求体里 `ref_file_ids` 的长度）。
*
* 为什么默认 24（2026-09-19 群友实测报告）：网页端对这一批引用的数量有上限 ——
* 最后一次成功是 40 张、第一次失败是 52 张，真值落在 (40, 52]。越过之后
* `biz_code 10 / too many ref file` 会让**该会话此后每一轮都失败**（图还留在历史里，
* 每轮重发都超标），用户唯一出路是丢掉整个会话。24 给已知安全线留了 16 张余量。
*
* `0` ＝ 不限制 —— 留着这个取值只是给"确实需要"的人，但**别设**：那等于把 code 10 放回来。
*/
const MAX_REF_IMAGES_BOUNDS = {
	min: 0,
	max: 100
};
/** 规整图片数量上限：非数 → 默认；越界 → 夹到边界。 */
function clampMaxRefImages(value) {
	if (!Number.isFinite(value)) return 24;
	return Math.max(MAX_REF_IMAGES_BOUNDS.min, Math.min(MAX_REF_IMAGES_BOUNDS.max, Math.round(value)));
}
/**
* 对外声明的模型上下文窗口（token），即模型信息里的 `context.contextWindow`。
*
* 它决定的是**DSH 什么时候开始压缩/截断历史**，而不是插件发多少 —— 声明 1M，DSH 就认为
* "还装得下"，于是一直不压，每轮都把整段转写重发。对只跑短任务的人来说，那部分体量是白烧的。
*
* ⚠️ 它和 `maxPromptChars` 是**两道独立阀门**，别混：
*   - `maxPromptChars` 管"单次请求最多发多少字符"（插件自己切，见上）；
*   - `contextWindow` 管"DSH 认为模型能装多少"（DSH 据此决定压不压历史）。
* 两个都调小，单次体量才会真的降下来；只调一个，另一个仍会把请求撑大。
*
* 上限取 DeepSeek 标称的 1Mi（服务端自己的数字也都是 1024 的整数倍），也就是本插件
* 一直以来的硬编码值；下限 32K —— 再小的话工具目录（约 5.6 万字符）就先装不下了。
*/
const CONTEXT_WINDOW_BOUNDS = {
	min: 32768,
	max: 1048576
};
/** 默认＝原来的硬编码值（1Mi）—— 不动这个开关的人行为完全不变。 */
const DEFAULT_CONTEXT_WINDOW = 1048576;
/**
* 面板滑块的档位。
*
* **用档位而不是线性连续值**：32K→1M 是 32 倍跨度，线性拖动时前四分之三的行程都挤在低档位，
* 手感很差；档位化之后每一格都是"翻倍"这个直觉，也正好落在 1024 的整数倍上。
* 直接调接口传任意值仍被接受（只做边界夹取，不强制吸附）—— 档位只约束面板。
*/
const CONTEXT_WINDOW_OPTIONS = [
	32768,
	65536,
	131072,
	262144,
	524288,
	1048576
];
/** 规整上下文窗口：非数 → 默认；越界 → 夹到边界。 */
function clampContextWindow(value) {
	if (!Number.isFinite(value)) return DEFAULT_CONTEXT_WINDOW;
	return Math.max(CONTEXT_WINDOW_BOUNDS.min, Math.min(CONTEXT_WINDOW_BOUNDS.max, Math.round(value)));
}
/**
* 自动切换账号的间隔（分钟）—— **0 表示关闭**。
*
* 用途：按时间把当前账号轮换到下一个，让每个账号分到的请求都变少（降低单账号密度）。
*
* ⚠️ 它和"**一被限流就自动换号**"不是一回事，别混：
*   - 定时均衡轮换 ⇒ 每个号的密度都摊薄，是**分散**；
*   - 遇限流就换   ⇒ 同一个出口 IP 上多号交替活跃，反而更像"有组织的规避"，是**加剧**。
* 所以这里**只看时间**：受限的账号会被跳过（它自己用不了），但不会因为它受限就提前切。
*
* 代价（界面上要讲清楚）：换号会让投喂链断掉 —— `decideFeed` 有 `account-changed` 一档 ⇒
* 必然 `restart` ⇒ 全量重发 + 新会话 + 历史图重新上传。间隔越短，这个代价出现得越频繁。
*/
const AUTO_SWITCH_BOUNDS = {
	min: 0,
	max: 120
};
/** 规整自动切换间隔：非数 → 默认；越界 → 夹到边界。 */
function clampAutoSwitchMinutes(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(AUTO_SWITCH_BOUNDS.min, Math.min(AUTO_SWITCH_BOUNDS.max, Math.round(value)));
}
/** 距上次请求超过这么久就算"歇过了"，连续计数归零。 */
const LONG_RUN_IDLE_RESET_MS = 12e4;
/** 间隔可选的推荐档位（设置页的快捷按钮用）：[下限, 上限]。 */
const INTERVAL_PRESETS = [
	[1500, 2500],
	[2e3, 4e3],
	[5e3, 9e3]
];
/** 设置页滑块的取值上限。 */
const MAX_INTERVAL_MS = 3e4;
/** 攒够几个：默认 6~10（均值 8，等于旧默认）。 */
const DEFAULT_CLEANUP_BATCH = {
	min: 6,
	max: 10
};
/** 从第一个会话入队起最多等多久：默认 60~120 秒（均值 90s，等于旧默认）。 */
const DEFAULT_CLEANUP_DELAY_MS = {
	min: 6e4,
	max: 12e4
};
/** 两次删除之间的间隔：默认 0.8~2.5 秒。
*  新增项 —— 批量删除不被服务端接受时会退化成"逐个删"，原来那串请求中间**没有间隔**。 */
const DEFAULT_CLEANUP_GAP_MS = {
	min: 800,
	max: 2500
};
/** 各区间允许被设置到的范围（设置页滑块也按这个画）。 */
const CLEANUP_BATCH_BOUNDS = {
	min: 1,
	max: 50
};
const CLEANUP_DELAY_BOUNDS_MS = {
	min: 5e3,
	max: 6e5
};
const CLEANUP_GAP_BOUNDS_MS = {
	min: 0,
	max: 6e4
};
/**
* 把任意输入规整成一个合法区间：非数忽略、按 bounds 夹住、**上下限颠倒时自动交换**。
* 返回 undefined 表示"这个字段不合法、当没给"（调用方回落到默认）。
*/
function normalizeCleanupRange(value, bounds) {
	if (!value || typeof value !== "object") return void 0;
	const raw = value;
	const lo = Number(raw.min);
	const hi = Number(raw.max);
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return void 0;
	const clamp = (n) => Math.min(bounds.max, Math.max(bounds.min, Math.floor(n)));
	return {
		min: clamp(Math.min(lo, hi)),
		max: clamp(Math.max(lo, hi))
	};
}
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
		const batch = normalizeCleanupRange(parsed?.cleanupBatch, CLEANUP_BATCH_BOUNDS);
		if (batch) out.cleanupBatch = batch;
		const delay = normalizeCleanupRange(parsed?.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS);
		if (delay) out.cleanupDelayMs = delay;
		const gap = normalizeCleanupRange(parsed?.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS);
		if (gap) out.cleanupGapMs = gap;
		if (Number.isFinite(parsed?.longRunThreshold)) {
			const n = Math.round(Number(parsed.longRunThreshold));
			out.longRunThreshold = Math.max(LONG_RUN_THRESHOLD_BOUNDS.min, Math.min(LONG_RUN_THRESHOLD_BOUNDS.max, n));
		}
		const lrb = normalizeCleanupRange(parsed?.longRunBreakMs, LONG_RUN_BREAK_BOUNDS_MS);
		if (lrb) out.longRunBreakMs = lrb;
		if (Number.isFinite(parsed?.maxPromptChars)) out.maxPromptChars = clampMaxPromptChars(Number(parsed.maxPromptChars));
		if (Number.isFinite(parsed?.maxRefImages)) out.maxRefImages = clampMaxRefImages(Number(parsed.maxRefImages));
		if (Number.isFinite(parsed?.contextWindow)) out.contextWindow = clampContextWindow(Number(parsed.contextWindow));
		if (Number.isFinite(parsed?.autoSwitchMinutes)) out.autoSwitchMinutes = clampAutoSwitchMinutes(Number(parsed.autoSwitchMinutes));
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
	let longRunThreshold = options.longRunThreshold ?? 15;
	let longRunBreakMs = options.longRunBreakMs;
	/** 连续请求计数（长休后、或歇够了之后归零）。 */
	let consecutive = 0;
	let minIntervalMs = clampInterval(options.minIntervalMs ?? (options.maxIntervalMs !== void 0 ? options.maxIntervalMs : 2e3));
	let maxIntervalMs = clampInterval(options.maxIntervalMs ?? (options.minIntervalMs !== void 0 ? options.minIntervalMs : 4e3));
	if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs;
	const random = options.random ?? Math.random;
	const now = options.now ?? (() => Date.now());
	const leaseWatchdogMs = options.leaseWatchdogMs ?? 9e5;
	let leasedAt = 0;
	let activeRelease;
	/**
	* 默认等待：把定时器**挂在 promise 上**，好让 `waitOrAbort` 在取消/结算时把它清掉。
	*
	* ⚠️ 0.1.82 的教训：这里**不能**用 `timer.unref()` 来"让进程不被拖住" ——
	* 被 `await` 的 promise 一旦失去 ref，事件循环可能直接空转退出，
	* 表现为进程/用例挂在 `await` 上**永不结算**（实测两个用例当场挂死）。
	* 长休确实不该拖住宿主关停，但正确做法是"取消时 clearTimeout"，不是 unref。
	*/
	const sleep = options.sleep ?? ((ms) => {
		let timer;
		const promise = new Promise((resolve) => {
			timer = setTimeout(resolve, ms);
		});
		promise.timer = timer;
		return promise;
	});
	const logger = options.logger;
	/** 队尾：每个调用完成后才 resolve，保证 FIFO 且「上一个没结束就不放行下一个」。 */
	let tail = Promise.resolve();
	let running = 0;
	let waiting = 0;
	let lastFinishedAt = 0;
	/** 是否已经有调用结束过 —— 首次调用不该被间隔规则拖住。 */
	let hasFinished = false;
	async function acquire(label = "call", signal) {
		let releaseMine;
		const mine = new Promise((resolve) => {
			releaseMine = resolve;
		});
		const prev = tail;
		tail = prev.then(() => mine);
		const aborted = () => {
			const error = /* @__PURE__ */ new Error(`「${label}」在闸门等待中被取消`);
			error.name = "AbortError";
			return error;
		};
		/** 让等待可被中断：abort 时立刻 reject，不等定时器/前序请求。 */
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
				inner.then(() => {
					signal.removeEventListener("abort", onAbort);
					clearInnerTimer();
					resolve();
				}, (error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				});
			});
		};
		if (!allowConcurrent && running > 0 && activeRelease && now() - leasedAt > leaseWatchdogMs) {
			const heldMin = Math.round((now() - leasedAt) / 6e4);
			logger?.warn?.(`deepseek-web: 闸门许可已持有 ${heldMin} 分钟未释放 —— 通常是宿主丢弃了进行中的流。强制释放，以免后续请求永久排队。`);
			activeRelease();
		}
		waiting += 1;
		try {
			if (signal?.aborted) throw aborted();
			if (!allowConcurrent) {
				if (running > 0 || waiting > 1) logger?.debug?.(`deepseek-web: 「${label}」排队等待（前面还有 ${running} 个在跑 / ${waiting - 1} 个在等）`);
				await waitOrAbort(prev);
			}
			if (hasFinished && now() - lastFinishedAt > LONG_RUN_IDLE_RESET_MS) consecutive = 0;
			const breakRange = longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS;
			const needsBreak = longRunThreshold > 0 && consecutive > 0 && consecutive >= longRunThreshold;
			const gap = needsBreak ? Math.round(breakRange.min + random() * Math.max(0, breakRange.max - breakRange.min)) : nextGap();
			if (hasFinished && (needsBreak || maxIntervalMs > 0)) {
				const waitMs = lastFinishedAt + gap - now();
				if (needsBreak) logger?.info?.(`deepseek-web: 已连续 ${longRunThreshold} 次请求 —— 长休 ${Math.round(gap / 1e3)}s 再继续（长任务保护：连续跑比间隔小更像脚本）`);
				if (waitMs > 0) {
					if (!needsBreak) logger?.info?.(`deepseek-web: 距上次请求不足 ${gap}ms（区间 ${minIntervalMs}~${maxIntervalMs}），等 ${Math.round(waitMs)}ms 再发「${label}」（防账号级限流）`);
					await waitOrAbort(sleep(waitMs));
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
	/** 本次实际使用的间隔：区间内随机；上下限相等则固定。 */
	function nextGap() {
		if (maxIntervalMs <= minIntervalMs) return minIntervalMs;
		return Math.round(minIntervalMs + random() * (maxIntervalMs - minIntervalMs));
	}
	/** 会话清理策略不在本模块实现，只借用设置文件存储（由宿主读取后交给 cleaner）。 */
	/** prompt 字符上限（同 cleanupMode：只是存着，执行在 adapter）。 */
	let maxPromptChars = clampMaxPromptChars(options.maxPromptChars ?? 4e5);
	let maxRefImages = clampMaxRefImages(options.maxRefImages ?? 24);
	let contextWindow = clampContextWindow(options.contextWindow ?? 1048576);
	let autoSwitchMinutes = clampAutoSwitchMinutes(options.autoSwitchMinutes ?? 0);
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
			autoSwitchMinutes
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
		if (next.longRunThreshold !== void 0 && Number.isFinite(next.longRunThreshold)) longRunThreshold = Math.max(LONG_RUN_THRESHOLD_BOUNDS.min, Math.min(LONG_RUN_THRESHOLD_BOUNDS.max, Math.round(next.longRunThreshold)));
		if (next.longRunBreakMs !== void 0) {
			const value = normalizeCleanupRange(next.longRunBreakMs, LONG_RUN_BREAK_BOUNDS_MS);
			if (value) longRunBreakMs = value;
		}
		if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs;
		logger?.info?.(`deepseek-web: 请求节流设置已更新 —— ${allowConcurrent ? "允许并发（不推荐）" : "串行"} · 间隔 ${minIntervalMs}~${maxIntervalMs}ms（随机）` + (cleanupBatch ? ` · 清理阈值 ${cleanupBatch.min}~${cleanupBatch.max} 个` : "") + (cleanupDelayMs ? ` · 最长等待 ${Math.round(cleanupDelayMs.min / 1e3)}~${Math.round(cleanupDelayMs.max / 1e3)}s` : "") + (cleanupGapMs ? ` · 删除间隔 ${cleanupGapMs.min}~${cleanupGapMs.max}ms` : "") + ` · 长任务保护 ${longRunThreshold > 0 ? `每 ${longRunThreshold} 次长休 ${Math.round((longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS).min / 1e3)}~${Math.round((longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS).max / 1e3)}s` : "关闭"}`);
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
//#region src/context-feed.ts
/**
* 上下文投喂方式 —— 每轮到底给网页端发什么。
*
* 两种模式（2026-09-14 加，用户可切换）：
*
*   full    每轮重发全量 prompt（默认）。
*           webapi 每次 completion 都发 `parent_message_id: null`，每条消息都是会话里的
*           根消息、没有父链 —— 服务端按消息树回溯上下文时回溯到空，**拿不到任何历史**。
*           所以历史必须由我们自己每轮重发。DSH 的适配器契约本来就是无状态的
*           （每轮把完整 messages 交给我们），这个模式最稳、行为和 0.1.61 及以前完全一致。
*
*   chained 链式投喂：只发**增量**，并把 `parent_message_id` 指向上一轮 assistant 的
*           message_id，让服务端自己按链维护上下文。
*           依据（读参考实现 + 抓真实帧，不是推理）：浏览器就是这么干的 ——
*           参考实现里的 `nextParentMessageId = history?.parentMessageId ?? finalAssistantMessageId`
*           `interceptor/request-augmentation.ts` 里 `isFirstMessage = parent_message_id === null`
*           ⇒ 只有会话第一条的 parent 是 null，之后每轮都把上一条消息 id 当 parent 发上去。
*           本轮 assistant 的 id 来自 SSE 首帧 `event: ready`
*           （`{"request_message_id":1,"response_message_id":2,...}`，实测样本见
*           `.workbuddy/tmp/shortq-r1-2026-09-14T04-17-41.sse`）。
*
* ⚠️ chained 的代价（必须知道，所以默认不开）：
*   模型能看到的工具协议、系统提示、历史，全都在**链首那条消息**里；一旦服务端侧
*   把早期上下文丢掉（长会话/超窗），模型就没有协议可依 —— 可能直接不按 JSON 发工具调用。
*   本模块的对策是"能省则省、一有不确定就退回全量"：见 decideFeed 的判据。
*
* 本文件是**纯逻辑 + 一点设置读写**，不依赖 webapi，方便直接测（tests/check-context-feed.mjs）。
*/
/** 默认每轮重发全量 —— 与 0.1.61 及以前的行为一致，不改动既有用户。 */
const DEFAULT_CONTEXT_MODE = "full";
function normalizeContextMode(value) {
	return value === "full" || value === "chained" ? value : void 0;
}
/** 设置页展示用（纯文本，别写 markdown 星号）。 */
const CONTEXT_MODE_HINT = "链式投喂：之后每轮只发新增内容，并把上一条回答挂到父消息上，让服务端自己维护上下文 —— 请求体小得多、也更像真人连续对话。代价是工具协议只存在于链首那条消息里，一旦服务端把早期上下文丢掉，模型可能不按约定格式发工具调用；本插件遇到任何不确定会自动退回全量重发。每轮全量：最稳，行为和以前完全一致（网页端会看到每条消息都带着完整提示词）。";
/** 严格前缀：prev 是 next 的前缀（含相等时不算"追加"）。 */
function isStrictPrefix(prev, next) {
	if (next.length <= prev.length) return false;
	for (let i = 0; i < prev.length; i += 1) if (prev[i] !== next[i]) return false;
	return true;
}
/**
* 决定本轮发什么。**纯函数**：不读文件、不看时间、不改全局状态。
*
* 判据宁可保守：只要能续链就发增量，任何一处不确定都退回"全量 + parent=null"
* （退回去只是多花点 token，和以前行为一致；错续链则会让模型上下文错位，代价大得多）。
*/
function decideFeed(input) {
	const full = input.full;
	if (input.mode !== "chained") return {
		prompt: full,
		parentMessageId: null,
		next: void 0,
		reason: "mode-full"
	};
	const head = input.head;
	const entries = input.entries;
	if (typeof head !== "string" || !Array.isArray(entries)) return {
		prompt: full,
		parentMessageId: null,
		next: void 0,
		reason: "no-parts"
	};
	const restart = (reason) => ({
		prompt: full,
		parentMessageId: null,
		next: {
			head,
			entries: entries.slice(),
			sessionId: input.sessionId,
			accountKey: input.accountKey
		},
		reason
	});
	if (!input.reused) return restart("new-session");
	const chain = input.chain;
	if (!chain) return restart("no-chain");
	if (chain.sessionId !== input.sessionId) return restart("session-changed");
	if (chain.accountKey !== input.accountKey) return restart("account-changed");
	if (chain.head !== head) return restart("head-changed");
	if (!isStrictPrefix(chain.entries, entries)) return restart("not-appended");
	const delta = entries.slice(chain.entries.length).join("\n\n");
	if (delta.trim().length === 0) return restart("empty-delta");
	const cap = input.maxChars;
	if (typeof cap === "number" && Number.isFinite(cap) && cap > 0 && delta.length > cap) return restart("delta-too-long");
	return {
		prompt: delta,
		parentMessageId: chain.parentId,
		next: {
			head,
			entries: entries.slice(),
			sessionId: input.sessionId,
			accountKey: input.accountKey
		},
		reason: "chained"
	};
}
let currentMode = DEFAULT_CONTEXT_MODE;
/** 取当前生效的模式（即时生效，无需重启）。 */
function currentContextMode() {
	return currentMode;
}
/** 设置当前模式（设置页保存时立刻生效，无需重启）。 */
function applyContextMode(mode) {
	currentMode = mode;
	return currentMode;
}
function contextModeSettingsPath() {
	return join(resolveDshHome(), "web-login", "context-feed.json");
}
function readContextModeSetting() {
	try {
		const file = contextModeSettingsPath();
		if (!existsSync(file)) return void 0;
		return normalizeContextMode(JSON.parse(readFileSync(file, "utf8"))?.contextMode);
	} catch {
		return;
	}
}
function writeContextModeSetting(mode) {
	const file = contextModeSettingsPath();
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify({ contextMode: mode }, null, 2) + "\n", "utf8");
}
//#endregion
//#region src/webapi.ts
/**
* DeepSeek 网页版 (chat.deepseek.com) API 客户端：
* PoW SHA3 WASM 求解 + chat_session 生命周期 + /chat/completion SSE 流式解析。
*
* 协议依据（2026 年多个活跃逆向实现交叉验证）：
*   POST /api/v0/chat/create_pow_challenge  {target_path} → data.biz_data.challenge
*   POST /api/v0/chat_session/create        {}            → data.biz_data.chat_session.id
*   POST /api/v0/chat_session/delete        {chat_session_id}
*   POST /api/v0/chat/completion            {chat_session_id, parent_message_id:null, prompt,
*                                            ref_file_ids:[], thinking_enabled, search_enabled,
*                                            model_type, action:null, preempt:false}
*   请求头：Authorization: Bearer <token>、Cookie、x-hif-*、x-ds-pow-response
*   SSE 负载为 patch 流：
*     {"v":{"response":{...}}}                  完整快照（fragments / content）
*     {"p":"response/fragments","o":"APPEND","v":{type,content}}
*     {"p":"response/fragments/-1/content","v":"…"}
*     {"p":"response/thinking_content","v":"…"} 旧格式：思考直连
*     {"p":"response/content","v":"…"}          旧格式：正文直连
*     {"v":"…"} / {"o":"APPEND","v":"…"}        承接上一个 path 的续段
*     {"p":"response/status","v":"FINISHED"}    状态
*/
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
/**
* 「能换号接着干」时给的重试退避。
*
* 为什么是 2 秒而不是 0：让 dsh-llm-retry 立刻重发，但仍留一点余量 ——
* 重发进入适配器时，"自动换号"的检查点要先跑完（可能含一次探活）。
* 它**不是**"等对面恢复"的退避，而是"我马上换个号再试一次"的信号。
*/
const FAILOVER_RETRY_MS = 2e3;
/**
* 被限制时的用户可读文案。
*
* 只说结论与解除时间 —— **不解释原因**。原因（免费网页端对高频自动化的静默限流、
* 登录态其实有效、只有 completion 被拒……）属于开发/排查信息，写在这里就够了：
* 用户看到报错时只需要知道「是什么 + 到几点结束」，长篇解释只会淹没这两件事。
*/
function mutedMessage(untilMs) {
	if (untilMs === void 0) return "DeepSeek 网页端已封禁本账号（未给出解除时间）";
	return `DeepSeek 网页端已封禁本账号，${new Date(untilMs).toLocaleString("zh-CN", { hour12: false })} 解除（约 ${Math.max(1, Math.round((untilMs - Date.now()) / 6e4))} 分钟）`;
}
/**
* 「同一账号同时只能生成一条」的并发拒绝（实测 2026-09-11：两个 DSH 窗口共用同一网页账号，
* 一个正在生成时另一个发请求即得此错：`A message is being generated, please try again later.`）。
* 它**不是封号**（封号是 `user is muted`），但也无法立刻成功 ——
* 归为可重试的 RATE_LIMIT，交由 dsh-llm-retry 稍后自动重发，而不是让整轮直接失败。
*/
function isBusyGenerating(message) {
	return /being generated|请稍后再试|稍后再试|正在生成/i.test(String(message ?? ""));
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
/**
* 当前生效的 fetch（诊断/检查更新这类**旁路请求**用它，从而与网页端请求走同一个传输层）。
* 注意它已经做了"每次现取"，直接当 fetch 用即可。
*/
function currentFetch(input, init) {
	return activeFetch(input, init);
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
	if (code === 429 || code === 40029) return "RATE_LIMIT";
	return "PROVIDER_ERROR";
}
/**
* `code 9` 在本项目里有**两个不同含义**，只能靠 msg 区分 —— 别只看数字：
*  · 上传文件时：`unsupported file type`（文件名后缀不被支持）⇒ 换个名字重传即可（见 imageUploadName）
*  · 发请求时：`invalid ref file id`（引用了一批服务端不认的文件 id）⇒ 需要降级重试
*
* 把后者单独识别出来，是为了让适配器能自救。这条错误的特点很恶劣：**带上图就失败**，
* 而图留在历史里，之后每一轮重发都会再撞一次 ⇒ 用户除了丢掉整个会话没有别的出路。
* 实测触发（2026-09-21）：当前账号 `acc_2df7cf2f` 的凭证残缺（cookie 为空）时，
* `new-session` 触发全量重发历史图 ⇒ code 9；而同一操作在另外两个 cookie 完整的账号上正常。
*/
function isInvalidRefFileError(biz) {
	return !!biz && biz.code === 9 && /ref\s*file/i.test(String(biz.msg ?? ""));
}
function bizErrorMessage(code, msg) {
	if (code === 40003 || code === 40001) return `DeepSeek 网页授权失败：${msg} —— 登录态已过期或无效，请到「设置 → DeepSeek 网页登录」重新登录`;
	if (code === 40029) return "网页版限流：发得太频繁，稍后自动重试";
	return `DeepSeek 网页端错误（code ${code}）：${msg}`;
}
let wasmModuleCache = null;
/** 已验证可用/已发现的 WASM 地址（按凭证里记录的原值缓存，避免每次请求都探测）。 */
let resolvedWasmUrl = null;
async function readOfficialResource(url, max, outer) {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443" || parsed.hostname !== "deepseek.com" && !parsed.hostname.endsWith(".deepseek.com")) throw new Error("非官方资源地址");
	const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(15e3)]) : AbortSignal.timeout(15e3);
	const resp = await activeFetch(parsed.href, {
		signal,
		redirect: "error"
	});
	if (!resp.ok || !resp.body) {
		await resp.body?.cancel();
		throw new Error(`资源请求失败 HTTP ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			size += item.value.byteLength;
			if (size > max) throw new Error("资源超过字节上限");
			chunks.push(item.value);
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
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
		resp = await activeFetch(url, {
			method: "GET",
			headers: { range: "bytes=0-0" },
			signal,
			redirect: "error"
		});
		return resp.ok;
	} catch {
		if (outer?.aborted) outer.throwIfAborted();
		return false;
	} finally {
		try {
			await resp?.body?.cancel();
		} catch {}
	}
}
/** 从网页端首页/JS chunk 里发现当前构建的 sha3 wasm 地址（哈希随版本变化）。 */
async function discoverWasmUrl(signal) {
	const decode = (bytes) => new TextDecoder().decode(bytes);
	const find = (text, base) => {
		for (const match of text.matchAll(/[^"'\s<>]*sha3[_a-z0-9.]*\.wasm/gi)) try {
			const url = checkedWasmUrl(new URL(match[0], base).href);
			if (url) return url;
		} catch {}
	};
	try {
		signal?.throwIfAborted();
		const html = decode(await readOfficialResource(`${DS_BASE}/`, 2097152, signal));
		const direct = find(html, `${DS_BASE}/`);
		if (direct) return direct;
		const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].slice(0, 8);
		for (const match of scripts) {
			signal?.throwIfAborted();
			try {
				const url = new URL(match[1], `${DS_BASE}/`).href;
				const found = find(decode(await readOfficialResource(url, 8388608, signal)), url);
				if (found) return found;
			} catch {
				if (signal?.aborted) signal.throwIfAborted();
			}
		}
	} catch {
		if (signal?.aborted) signal.throwIfAborted();
	}
}
/**
* 解析可用的 PoW WASM 地址：凭证记录值 → 已知默认值 → 页面发现。
* 结果按凭证原值缓存一次，避免每个请求都做探测。
*/
async function resolveWasmUrl(auth, signal) {
	const key = auth.wasmUrl || "";
	if (resolvedWasmUrl?.key === key) return resolvedWasmUrl.url;
	const fromAuth = checkedWasmUrl(auth.wasmUrl);
	if (auth.wasmUrl && !fromAuth) lastWasmUrlRejection = auth.wasmUrl;
	const candidates = [fromAuth, checkedWasmUrl(DEFAULT_WASM_URL)].filter((url) => !!url);
	for (const url of candidates) if (await isReachable(url, signal)) {
		resolvedWasmUrl = {
			key,
			url
		};
		return url;
	}
	const discovered = checkedWasmUrl(await discoverWasmUrl(signal));
	if (discovered) {
		resolvedWasmUrl = {
			key,
			url: discovered
		};
		return discovered;
	}
	return fromAuth ?? checkedWasmUrl("https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm") ?? "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";
}
/**
* F12（2026-09-12 审计）：PoW WASM 地址的白名单校验。
*
* 为什么需要：`auth.wasmUrl` 主要来自**导入的账号备份**，可被构造成任意地址
* （审计已复现：可打内网 / 云元数据 / file: 协议）。Electron 的 net.fetch 支持的
* 协议比 Node fetch 更宽，不能把后者的协议限制当成统一边界。
*
* 为什么只限到 deepseek.com 而不是写死单个主机：默认地址里带内容哈希
* （sha3_wasm_bg.7b9ca65ddd.wasm），官方一改就失效；而 `wasmUrl` 实际上**不是**
* 浏览器抓来的（browser-login 里恒为空），页面发现（discoverWasmUrl）是唯一的
* 兜底路径。所以保留发现能力，只把「能不能用」收白名单，既挡 SSRF 又留后路。
*/
const MAX_WASM_BYTES = 8388608;
/** 最近一次被白名单拒绝的凭证 wasmUrl（诊断/单测用；本模块无日志器，留状态而不是打日志）。 */
let lastWasmUrlRejection;
/** 合法则返回规范化后的地址，否则返回 undefined（调用方负责回退并告警）。 */
function checkedWasmUrl(raw) {
	if (typeof raw !== "string" || !raw) return void 0;
	let url;
	try {
		url = new URL(raw);
	} catch {
		return;
	}
	if (url.protocol !== "https:") return void 0;
	if (url.username || url.password) return void 0;
	if (url.port && url.port !== "443") return void 0;
	const host = url.hostname.toLowerCase();
	if (host !== "deepseek.com" && !host.endsWith(".deepseek.com")) return void 0;
	if (!url.pathname.toLowerCase().endsWith(".wasm")) return void 0;
	return url.href;
}
async function loadWasmModule(wasmUrl) {
	const url = checkedWasmUrl(wasmUrl);
	if (!url) throw new Error("非法 WASM 地址");
	if (wasmModuleCache?.url === url) return wasmModuleCache.promise;
	const promise = (async () => WebAssembly.compile(await readOfficialResource(url, MAX_WASM_BYTES)))();
	wasmModuleCache = {
		url,
		promise
	};
	promise.catch(() => {
		if (wasmModuleCache?.promise === promise) wasmModuleCache = null;
		if (resolvedWasmUrl?.url === url) resolvedWasmUrl = null;
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
	delayMs: Math.round((DEFAULT_CLEANUP_DELAY_MS.min + DEFAULT_CLEANUP_DELAY_MS.max) / 2),
	batchSize: Math.round((DEFAULT_CLEANUP_BATCH.min + DEFAULT_CLEANUP_BATCH.max) / 2),
	gapMs: Math.round((DEFAULT_CLEANUP_GAP_MS.min + DEFAULT_CLEANUP_GAP_MS.max) / 2),
	batchRange: DEFAULT_CLEANUP_BATCH,
	delayRange: DEFAULT_CLEANUP_DELAY_MS,
	gapRange: DEFAULT_CLEANUP_GAP_MS
};
/**
* 单个请求里最多塞多少个会话 id。
*
* 为什么要有：队列在"清理很慢"时可能积很多（比如你离开两小时后回来，一次 flush 要删几十个）。
* 「一次请求删掉一大批」正是用户担心的事 —— 所以超过这个数就拆成多次，
* 每次之间按随机间隔停一下。
*/
const MAX_IDS_PER_REQUEST = 20;
let sessionLifecycleHook;
/** 注册生命周期钩子（宿主启动时调一次即可；传 `undefined` 取消）。 */
function setSessionLifecycleHook(hook) {
	sessionLifecycleHook = hook;
}
function emitSessionLifecycle(event) {
	try {
		sessionLifecycleHook?.(event);
	} catch {}
}
function createSessionCleaner(options = {}) {
	const policy = {
		mode: options.policy?.mode ?? DEFAULT_SESSION_CLEANUP.mode,
		delayMs: Math.max(0, Math.floor(options.policy?.delayMs ?? DEFAULT_SESSION_CLEANUP.delayMs)),
		batchSize: Math.max(1, Math.floor(options.policy?.batchSize ?? DEFAULT_SESSION_CLEANUP.batchSize)),
		gapMs: Math.max(0, Math.floor(options.policy?.gapMs ?? (options.policy?.gapRange ? DEFAULT_SESSION_CLEANUP.gapMs : 0))),
		...options.policy?.batchRange ? { batchRange: options.policy.batchRange } : {},
		...options.policy?.delayRange ? { delayRange: options.policy.delayRange } : {},
		...options.policy?.gapRange ? { gapRange: options.policy.gapRange } : {}
	};
	/** 策略切换时按模式给默认延迟/批量（immediate 用老参数）。 */
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
	/** 探测到服务端不接受批量删除后置位 —— 之后一律逐个删，不再浪费请求。 */
	let batchUnsupported = false;
	const random = options.randomImpl ?? Math.random;
	/** 在 [min, max] 里取整数（闭区间）。random 可注入，单测因此可重复。 */
	function pickInt(range) {
		const lo = Math.min(range.min, range.max);
		const hi = Math.max(range.min, range.max);
		if (hi <= lo) return lo;
		return Math.min(hi, lo + Math.floor(random() * (hi - lo + 1)));
	}
	/**
	* 新的一轮清理开始（队列由空变非空）时重新抽：这一轮攒几个、最多等多久。
	*
	* 为什么按"轮"抽而不是每次都抽：阈值与等待时间要在一轮里保持稳定，
	* 否则"攒够 6~10 个"会退化成"好像随时都在触发"。每轮换一组，既有方差又不失节奏。
	*/
	function rollCycle() {
		if (policy.mode !== "deferred") return;
		if (policy.batchRange) policy.batchSize = Math.max(1, pickInt(policy.batchRange));
		if (policy.delayRange) policy.delayMs = Math.max(0, pickInt(policy.delayRange));
	}
	/** 每次要发一个删除请求之前抽一次间隔（顺带记下当前值，供设置页显示）。 */
	function rollGap() {
		policy.gapMs = policy.gapRange ? Math.max(0, pickInt(policy.gapRange)) : Math.max(0, policy.gapMs);
		return policy.gapMs;
	}
	/** 用注入的定时器睡一会儿（单测里就是"等假表被触发"）。 */
	function sleep(ms) {
		if (!(ms > 0)) return Promise.resolve();
		return new Promise((resolve) => {
			setT(() => resolve(), ms)?.unref?.();
		});
	}
	/** 装一次「到点清理」的表（已经装了就不动）。 */
	function armTimer() {
		if (timer !== void 0) return;
		if (policy.mode === "keep") return;
		timer = setT(() => {
			flush();
		}, Math.max(0, policy.delayMs));
		timer?.unref?.();
	}
	/**
	* 服务端"看起来接受了"：HTTP ok 且响应体里没有业务错误信封。
	*
	* 网页端会在 HTTP 200 上裹一层 `{code, msg, data:{biz_code,biz_msg}}` ——
	* 只看 `resp.ok` 会把"其实没删掉"当成成功（F07 踩过这个坑）。
	*/
	/**
	* 批量删除的响应该怎么定性（0.1.82）。
	*
	* 三态而不是两态，因为"失败"里混着两类完全不同的东西：
	*  · `unsupported` —— 服务端**听懂了但拒绝**（4xx，或 HTTP 200 里裹业务错误信封，F07 形态）
	*    ⇒ 可以永久关掉批量，之后逐个删；
	*  · `transient` —— 5xx / 429 / 网关 HTML（非 JSON 正文）⇒ **瞬时**问题，
	*    据此永久关掉批量就会让此后每批退化成 N 个请求（自己把请求密度抬上去）。
	*/
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
	/**
	* 删一个，返回**是否确认删掉** —— 删除回执要用来摘掉"欠删除"日志里的记录
	* （见 session-journal.ts：只有确认删掉才移记录，否则下次启动还来补删）。
	*/
	async function deleteOne(auth, sessionId) {
		try {
			return await respLooksOk(await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
				method: "POST",
				headers: buildDsHeaders(auth),
				body: JSON.stringify({ chat_session_id: sessionId }),
				signal: AbortSignal.timeout(1e4)
			}));
		} catch {
			return false;
		}
	}
	/**
	* 删一批：优先一个请求批量删；服务端不接受则**逐个删**。
	*
	* 逐个删时两个请求之间会停一个随机间隔 —— 原来这里是**连发**（一批 20 个就是 20 个连续请求），
	* 那是最像脚本的部分。
	*/
	async function deleteChunk(batch) {
		if (batch.length === 0) return;
		const firstToken = batch[0].auth?.token;
		const sameAccount = batch.every((item) => item.auth?.token === firstToken);
		if (batch.length > 1 && !batchUnsupported && sameAccount) try {
			const resp = await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
				method: "POST",
				headers: buildDsHeaders(batch[0].auth),
				body: JSON.stringify({ chat_session_ids: batch.map((b) => b.sessionId) }),
				signal: AbortSignal.timeout(15e3)
			});
			const verdict = await classifyDeleteResp(resp);
			if (verdict === "ok") {
				for (const item of batch) emitSessionLifecycle({
					kind: "deleted",
					sessionId: item.sessionId
				});
				logger?.debug?.(`deepseek-web: 已批量清理 ${batch.length} 个临时会话（只用了 1 个请求）`);
				return;
			}
			if (verdict === "unsupported") {
				batchUnsupported = true;
				logger?.debug?.("deepseek-web: 服务端不接受批量删除会话，之后改为逐个删除");
			} else logger?.debug?.(`deepseek-web: 批量删除本次失败（HTTP ${resp.status}），按瞬时问题处理，下次仍试批量`);
		} catch {}
		for (let i = 0; i < batch.length; i += 1) {
			if (i > 0) await sleep(rollGap());
			if (await deleteOne(batch[i].auth, batch[i].sessionId)) emitSessionLifecycle({
				kind: "deleted",
				sessionId: batch[i].sessionId
			});
		}
		logger?.debug?.(`deepseek-web: 已清理 ${batch.length} 个临时会话`);
	}
	/** 真正干活的清理。分片：队列积很多时也不一口气删完（见 MAX_IDS_PER_REQUEST 的说明）。 */
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
				if (i > 0) await sleep(rollGap());
				await deleteChunk(batch.slice(i, i + MAX_IDS_PER_REQUEST));
			}
		} catch (error) {
			logger?.debug?.(`deepseek-web: 会话清理出错（已忽略）：${error?.message ?? error}`);
		} finally {
			if (queue.length > 0) armTimer();
		}
	}
	/**
	* 立即清理队列。
	*
	* **串行化**：上一次还没删完时，这一次排在它后面等 —— 否则两轮 flush 的删除请求会交错发出，
	* 正是我们要避免的"连发"。排队的 flush 轮到自己时才取队列，所以能带上期间新攒的会话。
	*/
	let chain = Promise.resolve();
	function flush() {
		chain = chain.then(doFlush, doFlush);
		return chain;
	}
	function schedule(auth, sessionId) {
		if (policy.mode === "keep") return;
		if (queue.length === 0) rollCycle();
		queue.push({
			auth,
			sessionId
		});
		emitSessionLifecycle({
			kind: "queued",
			auth,
			sessionId
		});
		if (policy.mode === "deferred" && queue.length >= policy.batchSize) {
			flush();
			return;
		}
		armTimer();
	}
	function configure(next) {
		const modeChanged = next.mode !== void 0 && next.mode !== policy.mode;
		if (next.mode !== void 0) policy.mode = next.mode;
		if (next.delayMs !== void 0) policy.delayMs = Math.max(0, Math.floor(next.delayMs));
		if (next.batchSize !== void 0) policy.batchSize = Math.max(1, Math.floor(next.batchSize));
		if (next.gapMs !== void 0) policy.gapMs = Math.max(0, Math.floor(next.gapMs));
		for (const key of [
			"batchRange",
			"delayRange",
			"gapRange"
		]) {
			const value = next[key];
			if (value && Number.isFinite(value.min) && Number.isFinite(value.max)) policy[key] = {
				min: Math.floor(Math.min(value.min, value.max)),
				max: Math.floor(Math.max(value.min, value.max))
			};
		}
		if (modeChanged) applyModeDefaults();
		if (policy.mode === "keep") flush();
		logger?.info?.(`deepseek-web: 会话清理策略已更新 —— ${policy.mode}` + (policy.mode === "deferred" ? `（攒 ${policy.batchSize} 个或 ${Math.round(policy.delayMs / 1e3)}s 后清理` + (policy.gapRange ? `；批量删除不受支持时逐个删，间隔 ${policy.gapMs}ms` : "") + "）" : ""));
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
/**
* 从 `users/current` 的 user 对象里挑一个**能看的账号标识**。
*
* 两个必须记住的坑（都是实测踩出来的，2026-09-12）：
*
*  1. **不能用 `??` 串起来。** 接口对"没设邮箱"的账号会返回 `email: ""`，
*     而空字符串**不是** nullish —— `"" ?? x` 的结果就是 `""`，整条回退链当场被它挡住，
*     display 永远是空，界面只好退回去显示内部 id（`acc_cd8e05ec`）。
*     所以必须按"**有内容**"取，跳过 undefined / null / 空白。
*
*  2. **字段名要和响应对齐。** 手机号是 `mobile_number`（不是 `mobile`），
*     而且服务端返回的**已经是脱敏形态**（如 `183******78`），可以直接展示。
*
* 实测响应形状（只列相关字段）：
*   { id, token, email: "", mobile_number: "183******78", area_code: "+86", chat: {...} }
*/
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
/**
* 判定 `users/current` 的响应体**形状**是否可信。
*
* ⚠️ F09（2026-09-12 审计）：旧代码在 `resp.json()` 抛错时把 json 置为 undefined，
* 而 `envelopeError(undefined)` 返回 undefined，于是径直走到 `ok: true`，
* 返回一个**空壳的 user({})**。也就是说：反爬页 / WAF 拦截页 / 空响应
* —— 它们同样是 HTTP 200 —— 会被当成"验证通过"。
*
* 后果很实际：探活显示"通过"、账号看起来正常，
* 0.1.31 加的「需要重新登录」按钮就永远不会触发；什么都没确认到，却说成功。
* 只读零额度请求偶发失败的代价只是一次重试，远比"误报成功"划算。
*
* 抽成纯函数是为了能单测（validateAuth 要发网络请求，测不了这条分支）。
*/
/**
* 校验 `users/current` 的信封。**必须能辨认出一个用户身份**才算成功。
*
* 2026-09-13 第二轮审计 N09：旧实现只拒绝"不是对象"和"data、code 都缺"，
* 于是 `{code:0}`、`{data:null}`、`{code:"401",data:null}` 这类空壳/错型信封全部被判成功 ——
* 而 `validateAuth` 之后又会回落空对象，导致"校验成功"与"拿到有效身份"脱节。
* 现在：业务码必须是数值、data 必须是对象、且里面要能找到一个可辨认的用户字段。
*/
function classifyAuthEnvelope(json) {
	const fail = (error) => ({
		ok: false,
		error
	});
	if (!json || typeof json !== "object" || Array.isArray(json)) return fail("users/current 响应不是 JSON 对象（可能是反爬页面或网关拦截）");
	const obj = json;
	if (typeof obj.code !== "number") return fail("users/current 缺少数值业务码（形状不符）");
	const bizError = envelopeError(obj);
	if (bizError) return fail(bizError.msg);
	if (obj.code !== 0 || !obj.data || typeof obj.data !== "object" || Array.isArray(obj.data)) return fail("users/current 缺少用户数据（形状不符）");
	if (obj.data.biz_code !== void 0 && typeof obj.data.biz_code !== "number") return fail("users/current 内层业务码无效");
	const payload = obj.data.biz_data ?? obj.data;
	const user = payload?.user ?? payload;
	if (!user || typeof user !== "object" || Array.isArray(user)) return fail("users/current 用户形状无效");
	const hasId = typeof user.id === "string" && user.id.trim().length > 0 || typeof user.id === "number" && Number.isFinite(user.id);
	const named = [
		"email",
		"mobile_number",
		"mobile",
		"phone",
		"username",
		"nickname",
		"name"
	].some((k) => typeof user[k] === "string" && user[k].trim());
	return hasId || named ? { ok: true } : fail("users/current 缺少可辨认的用户身份");
}
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
				...chat && typeof chat.is_muted === "boolean" ? { limit: {
					muted: chat.is_muted === true,
					...untilMs ? { untilMs } : {}
				} } : {},
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
/** F28：思考的标准包装标签。孤儿兜底用（见 finish 里的判据）。 */
const THINKING_WRAPPER_RE = /<\s*\/?\s*(analysis|summary|thinking|scratchpad|thought)\b/i;
/**
* F28 取证开关：把原始 SSE 逐行落盘，给「孤儿思考归正文」这类通道错位定论用。
* 默认关；设环境变量 `DSH_WEB_LOGIN_DUMP_SSE=1` 开启（需重启 DSH 生效）。
* 文件写到 `~/.dsh/deepseek-web/frames/<时间戳>-<序号>.sse`，逐行 append ——
* 就算进程被强杀，已收到的帧也在盘上（F24 的教训：别用构造帧当证据，要抓真实帧）。
*/
function dumpSinkPath() {
	if (process.env.DSH_WEB_LOGIN_DUMP_SSE !== "1") return null;
	try {
		const dir = join(homedir(), ".dsh", "deepseek-web", "frames");
		mkdirSync(dir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		return join(dir, `${stamp}-${Math.random().toString(36).slice(2, 8)}.sse`);
	} catch {
		return null;
	}
}
function createSseState(options = {}) {
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
	/**
	* F25：通道未知的暂存文本。只在「请求开了思考、但还没出现任何 fragment」时使用
	* —— 正常流不会走到这里（首帧快照就带着 THINK fragment）。
	*/
	let orphanBuffer = "";
	const thinkingEnabled = options.thinkingEnabled === true;
	let pendingFinish;
	let sawData = false;
	/** 服务端上报的本消息 token 总量（见 WebStreamEvent 的 totalTokens 说明）。 */
	let totalTokens;
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
	/**
	* F25：把暂存文本按**刚出现的 fragment 类型**归属并发射。
	*
	* 真实帧（2026-09-14 抓，4 轮同构）显示两条规律：
	*   1. 思考的 fragment 由**首帧快照**建立；正文的 fragment 由 `response/fragments`
	*      的 APPEND 建立（`fragments+1 [RESPONSE]`）；
	*   2. 第一个 RESPONSE fragment 出现之前，流上的内容**全是思考**。
	*
	* 所以无论先到的是 THINK 还是 RESPONSE fragment，暂存的那段都应归思考 ——
	* 正文不会"先于自己的 fragment"出现在流上。这样即使快照整帧丢失，
	* 思考仍会回到思考通道，而不是被当成正文顶到用户脸上。
	*/
	const settleOrphans = (out, firstType) => {
		if (!orphanBuffer) return;
		const text = orphanBuffer;
		orphanBuffer = "";
		if (!isReasoningType(firstType)) {}
		directThinking += text;
		emitThinking(out, text);
	};
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
	const replaceFragments = (list, out) => {
		fragments.length = 0;
		for (const f of list) if (f && typeof f === "object" && typeof f.content === "string") fragments.push({
			type: String(f.type ?? "RESPONSE"),
			content: f.content,
			emitted: 0
		});
		rebuildFragmentText();
		sink = fragments.length > 0 ? "fragments" : null;
		if (fragments.length > 0) settleOrphans(out, fragments[0].type);
	};
	/** 增量：追加 fragment（其 content 属于新内容 → 直接发射）。 */
	const appendFragments = (incoming, out) => {
		const list = Array.isArray(incoming) ? incoming : incoming !== void 0 ? [incoming] : [];
		let settled = false;
		for (const f of list) {
			if (!f || typeof f !== "object" || typeof f.content !== "string") continue;
			const fragment = {
				type: String(f.type ?? "RESPONSE"),
				content: f.content,
				emitted: 0
			};
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
		sink = fragments.length > 0 ? "fragments" : null;
	};
	/** 增量：续写最后一个 fragment。 */
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
	/** 增量：裸续段按当前 sink 归属。 */
	const appendSink = (text, out) => {
		if (sink === "thinking") {
			directThinking += text;
			emitThinking(out, text);
		} else if (sink === "content") {
			directText += text;
			emitText(out, text);
		} else if (sink === "fragments") appendToLastFragment(text, out);
		else {
			directText += text;
			emitText(out, text);
		}
	};
	return {
		/** 负载处理（增量直接发射；快照只对账）。 */
		handlePayload(d, eventName) {
			const out = [];
			sawData = true;
			if (d && typeof d === "object" && typeof d.response_message_id === "number") options.onResponseMessageId?.(d.response_message_id);
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
						if (!(fragments.length === 0 && (sink === "thinking" || sink === "content"))) sink = "fragments";
					}
					return out;
				case "response/fragments/-1/elapsed_secs":
					if (typeof value === "number" && value > 0) settleOrphans(out, "THINK");
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
				case "accumulated_token_usage":
					if (typeof value === "number" && Number.isFinite(value)) totalTokens = value;
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
					if (Array.isArray(value)) for (const op of value) {
						if (op && typeof op === "object" && op.p === "fragments" && op.o === "APPEND" && op.v !== void 0) appendFragments(op.v, out);
						if (op && typeof op === "object" && op.p === "accumulated_token_usage") {
							if (typeof op.v === "number" && Number.isFinite(op.v)) totalTokens = op.v;
						}
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
			out.push({
				kind: "finish",
				reason: pendingFinish,
				...totalTokens !== void 0 ? { totalTokens } : {}
			});
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
/** 解析 /chat/completion 的 SSE 字节流，产出增量文本/思考事件。 */
async function* parseWebSse(body, options) {
	const state = createSseState(options);
	let eventName = "";
	/**
	* F13（2026-09-12 审计）：SSE 规范允许一个事件里出现**多个** `data:` 行，
	* 收齐后要用 `\n` 拼接再整体解析。旧实现逐行 `JSON.parse`，一旦服务端把一个
	* JSON 拆到多行（或 payload 里本身含换行），每行都解析失败 → 被
	* `catch { continue }` 静默丢弃，表现为「流突然断了/少了一段」且无任何报错。
	*/
	let dataLines = [];
	const flushData = () => {
		if (dataLines.length === 0) return {
			events: [],
			done: false
		};
		const data = dataLines.join("\n").trim();
		dataLines = [];
		if (data.length === 0) return {
			events: [],
			done: false
		};
		if (data === "[DONE]") return {
			events: Array.from(state.finish()),
			done: true
		};
		let parsed;
		try {
			parsed = JSON.parse(data);
		} catch {
			return {
				events: [],
				done: false
			};
		}
		return {
			events: Array.from(state.handle(parsed, eventName)),
			done: false
		};
	};
	const dumpPath = dumpSinkPath();
	for await (const line of iterateLines(body)) {
		if (dumpPath) try {
			appendFileSync(dumpPath, line + "\n");
		} catch {}
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
/** 复用槽：同一账号当前可复用的会话。key 是凭证摘要（不进日志、不拿明文当键）。 */
/**
* 复用槽。`cleanup` 记录**这个会话归谁回收**（2026-09-13 审计 N04）：
* 切号时旧槽要交回**原账号**的清理回调，不能用当前账号的去删别人的会话。
*/
let reuseSlot;
/**
* 链式投喂的链状态（2026-09-14）。只跟随**正在复用的那个会话**：
* 会话轮换、切号、请求失败/取消、流被污染，都会让它作废 —— 下一轮自动退回全量重发。
* 判定逻辑在 context-feed.ts（纯函数），这里只负责"喂进去 + 按结果记下来"。
*/
let contextChain;
/**
* 服务端**已知**的图片 file_id（0.1.83）：本会话内已经随请求发出去过的那批。
*
* 只用于链式投喂：走 `chained`（有父链）时服务端会回溯历史、那张图已经在它的上下文里，
* 于是每轮重带整批是纯冗余 —— 真机实测见 tests/probe-image-chain.mjs（两张不同布局的图、
* 第二轮都不带 `ref_file_ids`，仍都答对四个角）。
* 会话换掉就整批作废：新会话没有那份历史。
*/
let sentRefIds = /* @__PURE__ */ new Set();
/** `sentRefIds` 归属的会话 id（见上）。 */
let sentRefIdsSession;
/**
* 上一次上报过的决策原因（0.1.63）。链式投喂的决策每轮都在做，
* 但"原因"通常连续几百轮都不变 —— 只在**变化时**上报，日志才不会被刷满，
* 同时"哪一轮开始退回全量、为什么"又一定能看见。
*/
let lastFeedReason;
/** 丢弃当前的链（会话退役/测试隔离用）。 */
function resetContextChain() {
	contextChain = void 0;
	lastFeedReason = void 0;
}
/** 给状态页看：当前链式投喂是否真的在跑（没用链式就返回 undefined）。 */
function contextChainInfo() {
	if (!contextChain) return void 0;
	return {
		sessionId: contextChain.sessionId,
		turns: contextChain.entries.length,
		parentId: contextChain.parentId
	};
}
/** 凭证摘要：只用来判断「是不是同一个账号」。不做安全用途、不落日志。 */
function accountKey(auth) {
	const raw = `${auth?.token ?? ""}|${auth?.cookie ?? ""}`;
	let hash = 2166136261;
	for (let i = 0; i < raw.length; i += 1) {
		hash ^= raw.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
async function leaseSession(auth, signal, transport, maxTurns, cleanup) {
	signal.throwIfAborted();
	const key = accountKey(auth);
	const limit = Number.isFinite(maxTurns) ? Math.max(0, Math.floor(maxTurns)) : 20;
	if (limit === 0) return {
		sessionId: await transport.createSession(auth, signal),
		reused: false
	};
	if (reuseSlot && reuseSlot.key === key && reuseSlot.turns < limit) {
		reuseSlot.turns += 1;
		return {
			sessionId: reuseSlot.sessionId,
			reused: true
		};
	}
	const previous = reuseSlot;
	const sessionId = await transport.createSession(auth, signal);
	if (signal.aborted) {
		try {
			cleanup?.(sessionId);
		} catch {}
		signal.throwIfAborted();
	}
	reuseSlot = {
		key,
		sessionId,
		turns: 1,
		...cleanup ? { cleanup } : {}
	};
	emitSessionLifecycle({
		kind: "leased",
		auth,
		sessionId
	});
	if (previous) try {
		previous.cleanup?.(previous.sessionId);
	} catch {}
	return {
		sessionId,
		reused: false
	};
}
/** 把某个会话从复用槽里摘掉（会话失效 / 请求失败时调用，下次会新建）。 */
function retireSession(sessionId) {
	if (!sessionId || reuseSlot && reuseSlot.sessionId === sessionId) reuseSlot = void 0;
	if (!sessionId || contextChain?.sessionId === sessionId) contextChain = void 0;
}
/**
* 卸载/退出时的收尾：把复用槽里的会话**交回它自己的清理回调**，然后清空槽。
*
* 为什么必须单独有这个函数（2026-09-14）：`retireSession()` 只是把槽清掉，
* 排队删除是槽里那个 `cleanup` 干的活 —— 直接清槽等于把待删的会话一起丢了，
* 它就会永远留在网页端（每次退出必留一个，实测就是这样堆起来的）。
*
* 返回被退役的 sessionId（没有则 `undefined`），调用方可以据此记账/打日志。
* 注意它**只排队**、不等删除完成；删不掉的部分由 `session-journal.ts` 兜底，
* 记录只在"确认删掉"时才被摘掉，所以强杀也能在下次启动补删。
*/
function disposeSessionReuse() {
	const slot = reuseSlot;
	contextChain = void 0;
	sentRefIds = /* @__PURE__ */ new Set();
	sentRefIdsSession = void 0;
	if (!slot) return void 0;
	reuseSlot = void 0;
	try {
		slot.cleanup?.(slot.sessionId);
	} catch {}
	return slot.sessionId;
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
	/**
	* 宿主给的「还能不能换号接着干」。问不出来（没注入 / 抛错）时按**不能**处理 ——
	* 保守方向：宁可让用户点一次「继续」，也不要给一个它其实接不上的短退避。
	*/
	const canFailover = () => {
		try {
			return params.canFailover?.() === true;
		} catch {
			return false;
		}
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		const lease = await leaseSession(auth, signal, transport, params.sessionReuseTurns ?? 20, params.onDeleteSession);
		const sessionId = lease.sessionId;
		const feed = decideFeed({
			mode: currentContextMode(),
			...params.promptParts ? {
				head: params.promptParts.head,
				entries: params.promptParts.entries,
				...params.promptParts.maxChars !== void 0 ? { maxChars: params.promptParts.maxChars } : {}
			} : {},
			full: params.prompt,
			sessionId,
			accountKey: accountKey(auth),
			reused: lease.reused,
			...contextChain ? { chain: contextChain } : {}
		});
		if (feed.reason !== lastFeedReason) {
			lastFeedReason = feed.reason;
			params.onContextFeed?.({
				reason: feed.reason,
				chained: feed.parentMessageId !== null,
				promptChars: feed.prompt.length
			});
		}
		if (sentRefIdsSession !== sessionId) {
			sentRefIds = /* @__PURE__ */ new Set();
			sentRefIdsSession = sessionId;
		}
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
			retireSession(sessionId);
			params.onDeleteSession?.(sessionId);
			if (error instanceof AdapterLlmError) throw error;
			if (params.signal?.aborted) throw new AdapterLlmError("DeepSeek web request aborted by caller", "ABORTED", { cause: error });
			throw new AdapterLlmError(`DeepSeek web request failed: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
		}
		if (!resp.ok) {
			const text = await resp.text().catch(() => "");
			const code = httpErrorCode(resp.status);
			const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
			const hint = code === "AUTH" ? " —— 网页登录态可能已过期，请到「设置 → DeepSeek 网页登录」重新登录" : code === "RATE_LIMIT" ? " —— 网页版限流" : "";
			retireSession(sessionId);
			params.onDeleteSession?.(sessionId);
			throw new AdapterLlmError(`DeepSeek web completion failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ""}${hint}`, code, {
				status: resp.status,
				...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {},
				cause: new Error(text)
			});
		}
		if (!resp.body) {
			retireSession(sessionId);
			params.onDeleteSession?.(sessionId);
			throw new AdapterLlmError("DeepSeek web completion returned no body", "EMPTY_RESPONSE");
		}
		const contentType = String(resp.headers.get("content-type") ?? "");
		if (contentType.includes("text/event-stream")) {
			for (const item of refItemsToSend) sentRefIds.add(item.key);
			return {
				sessionId,
				resp,
				feed
			};
		}
		const text = await resp.text().catch(() => "");
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {}
		const biz = envelopeError(parsed);
		const muted = isMutedError(biz);
		const busy = !muted && !!biz && isBusyGenerating(biz.msg);
		const throttled = !muted && !busy && !!biz && (biz.code === 40029 || isThrottled(biz.msg));
		const untilMs = muteUntilMs(parsed);
		const failure = biz ? new AdapterLlmError(muted ? mutedMessage(untilMs) : busy ? "网页版限流：同一账号同时只能生成一条消息，稍后自动重试" : throttled ? "网页版限流：发得太频繁，稍后自动重试" : bizErrorMessage(biz.code, biz.msg), muted || busy || throttled ? "RATE_LIMIT" : isInvalidSessionError(biz) ? "TRANSPORT" : isInvalidRefFileError(biz) ? "INVALID_REF_FILE" : bizErrorCode(biz.code), {
			status: resp.status,
			...muted && untilMs !== void 0 ? { providerRetryAfterMs: canFailover() ? FAILOVER_RETRY_MS : Math.max(0, untilMs - Date.now()) } : {},
			...muted && untilMs !== void 0 ? { mutedUntilMs: untilMs } : {},
			...busy ? { providerRetryAfterMs: 5e3 } : {},
			...throttled ? {
				rateLimitKind: "throttled",
				providerRetryAfterMs: 2e4
			} : {}
		}) : new AdapterLlmError(`DeepSeek 网页端返回了非流式响应（content-type: ${contentType || "unknown"}）：${text.slice(0, 200)}`, "MALFORMED_RESPONSE", { status: resp.status });
		retireSession(sessionId);
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
/** 复用模式下的"飞行互斥"：保证同一时刻只有一个复用请求在跑，避免轮换撞上并发。 */
let reuseFlightTail = Promise.resolve();
async function* streamWebCompletion(auth, params, transport = defaultTransport) {
	const controller = new AbortController();
	const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;
	const rawLimit = params.sessionReuseTurns ?? 20;
	const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 20;
	let release;
	let sessionId;
	let iterator;
	let body;
	let complete = false;
	let poisoned = false;
	let timer;
	/** 本轮实际发出去了什么（链式投喂据此记账；见 finally 里的链更新）。 */
	let sentFeed;
	/** 首帧 `event: ready` 给的 assistant message_id —— 就是下一轮的 parent_message_id。 */
	let responseMessageId;
	/** 同一个会话只回收一次（复用/轮换/失败三条路径可能都想回收它）。 */
	const deleted = /* @__PURE__ */ new Set();
	const cleanup = (id) => {
		if (deleted.has(id)) return;
		deleted.add(id);
		try {
			params.onDeleteSession?.(id);
		} catch {}
	};
	/** 让等待可被取消：abort 时立刻 reject，不等定时器/对端。 */
	const wait = (promise) => new Promise((resolve, reject) => {
		if (signal.aborted) {
			promise.catch(() => {});
			reject(signal.reason);
			return;
		}
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", abort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", abort);
			reject(error);
		});
	});
	const arm = (ms, message) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => controller.abort(new AdapterLlmError(message, "TIMEOUT")), ms);
		timer.unref?.();
	};
	/**
	* F10：外层拥有本次调用创建过的**全部**会话。
	*
	* 建连阶段没有统一限时时，`createSession` 之后、响应头之前的任何失败都会让
	* 「已建出来但还没人认领」的会话漏在服务端；`openCompletion` 内部的失败分支只覆盖
	* 它自己 catch 得到的错误。超时/取消会**放弃**进行中的 `openCompletion`（不再等它），
	* 所以必须在这里兜住它后续才返回的那些会话。
	*/
	const owned = /* @__PURE__ */ new Set();
	let finalized = false;
	const tracked = {
		...transport,
		createSession: async (value, sig) => {
			const id = await transport.createSession(value, sig);
			if (finalized) {
				retireSession(id);
				cleanup(id);
			} else owned.add(id);
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
			reuseFlightTail = previous.then(() => mine, () => mine);
			await wait(previous);
		}
		const connectMs = Number.isFinite(params.connectTimeoutMs) && params.connectTimeoutMs > 0 ? Math.min(params.connectTimeoutMs, 6e5) : 45e3;
		arm(connectMs, `DeepSeek 建立流超时（${connectMs}ms）`);
		const opened = await wait(openCompletion(auth, {
			...params,
			sessionReuseTurns: limit,
			onDeleteSession: cleanup
		}, signal, tracked));
		sessionId = opened.sessionId;
		sentFeed = opened.feed;
		body = opened.resp.body;
		if (timer) clearTimeout(timer);
		iterator = parseWebSse(body, {
			thinkingEnabled: params.thinkingEnabled,
			onResponseMessageId: (id) => {
				responseMessageId = id;
			}
		});
		const idle = Number.isFinite(params.idleTimeoutMs) && params.idleTimeoutMs > 0 ? Math.min(params.idleTimeoutMs, 6e5) : 12e4;
		for (;;) {
			arm(idle, `DeepSeek 流等待超时（${idle}ms）`);
			const item = await wait(iterator.next());
			if (timer) clearTimeout(timer);
			if (item.done) {
				complete = true;
				break;
			}
			if (item.value.kind === "error") poisoned = true;
			yield item.value;
		}
	} catch (error) {
		if (params.signal?.aborted) throw new AdapterLlmError("请求已取消", "ABORTED", { cause: error });
		if (controller.signal.aborted && controller.signal.reason instanceof AdapterLlmError) throw controller.signal.reason;
		if (error instanceof AdapterLlmError) throw error;
		throw new AdapterLlmError("DeepSeek 流请求失败", "TRANSPORT", { cause: error });
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
		if (iterator) iterator.return(void 0).catch(() => {}).finally(() => {
			if (body && !body.locked) body.cancel().catch(() => {});
		});
		finalized = true;
		for (const id of owned) {
			if (id === sessionId && complete && !poisoned && limit > 0) continue;
			retireSession(id);
			cleanup(id);
		}
		if (sentFeed?.next && complete && !poisoned && typeof responseMessageId === "number") contextChain = {
			...sentFeed.next,
			parentId: responseMessageId
		};
		else if (contextChain && (!sessionId || contextChain.sessionId === sessionId)) contextChain = void 0;
		release?.();
	}
}
//#endregion
//#region src/probe.ts
/**
* 登录态主动探活 —— 在任务跑到一半之前发现登录态失效。
*
* 借鉴 workbuddy-switch 的「Token 保活」。它的做法是"操作前不足阈值就刷新 + 每日无条件刷新一次"，
* 但我们这边**没有 refresh token 可刷**：网页端 token 只能靠重新登录（浏览器捕获）拿新的。
* 所以能做的只有**尽早发现失效**：
*
*  - 启动后延迟一小会儿探一次（覆盖"隔天打开 DSH"这个最常见的过期场景）；
*  - 之后每 N 分钟探一次（默认 30 分钟，可关）；
*  - 探活走**只读**的 `users/current`（零额度、实测 ~430ms），**不生成任何内容**；
*    端点不可用时 `validateAuth` 自己会退回 PoW challenge 探活。
*
* 为什么值得：登录态过期现在的表现是"几十步的任务跑到一半突然失败"。
* 一次只读探活的成本可以忽略，换来的是提前知道 —— 而且探活失败**只提示、不阻断**。
*
* ⚠️ 更正（2026-09-12 实测）：本文档原先写"受限期间探不出限制状态"，**这是错的**。
* `users/current` 的响应体里就带着 `chat: { is_muted, mute_until }` —— 受限期间这个字段是有效的，
* 所以理论上探活**能**提前发现限制（目前尚未接上：限制状态仍由生成失败时的
* `mute_until` 记入 accounts 的 limit 字段，见 webapi.ts 的 muteUntilMs）。
*/
/**
* 探一次。返回 `undefined` 表示"没什么可探的"（未登录）。
*
* 结果写回**发起探活时那个账号**（按 token 匹配）——
* 探活期间用户可能已经切号，绝不能把结果写到新账号头上。
*/
async function probeOnce(auth, logger) {
	if (!hasUsableAuth(auth)) return void 0;
	const at = (/* @__PURE__ */ new Date()).toISOString();
	const target = listAccounts().find((item) => item.token === auth.token);
	let outcome;
	try {
		const result = await validateAuth(auth, AbortSignal.timeout(2e4));
		outcome = result.ok ? {
			ok: true,
			at,
			...result.user ? { user: result.user } : {},
			...result.limit ? { limit: result.limit } : {}
		} : {
			ok: false,
			at,
			error: result.error ?? "校验未通过"
		};
	} catch (error) {
		outcome = {
			ok: false,
			at,
			error: error?.message ?? String(error)
		};
	}
	if (target) {
		if (outcome.ok) {
			const patch = {
				lastVerifiedAt: at,
				lastVerifyError: void 0,
				unverified: false
			};
			if (outcome.limit) patch.limit = outcome.limit.muted && outcome.limit.untilMs ? {
				untilMs: outcome.limit.untilMs,
				observedAt: at
			} : void 0;
			if (outcome.user) {
				patch.user = {
					...target.user ?? {},
					...outcome.user
				};
				const verifiedId = outcome.user.id;
				if (typeof verifiedId === "string" && verifiedId) patch.serverId = verifiedId;
			}
			updateAccount(target.id, patch);
		} else updateAccount(target.id, { lastVerifyError: {
			at,
			message: String(outcome.error ?? "")
		} });
	}
	if (outcome.ok) logger?.info?.(`deepseek-web: 登录态探活通过（${target?.id ?? "未知账号"}）`);
	else logger?.warn?.(`deepseek-web: 登录态探活失败 —— ${outcome.error}（可能已过期，建议重新登录）`);
	return outcome;
}
/**
* 启动定时探活，返回停止函数。
*
* 用 setTimeout 串行链而不是 setInterval：探活本身要花几百毫秒，
* setInterval 在网络慢时会堆叠出并发探活（而这些请求算在同一账号头上）。
*/
function startProbeLoop(options) {
	if (!(options.intervalMs > 0)) return () => {};
	let stopped = false;
	let timer;
	const tick = async () => {
		if (stopped) return;
		try {
			await probeOnce(options.getAuth(), options.logger);
		} catch {}
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
/**
* 当前凭证是否处于「已知**授权**失效」状态；是则返回那条失败说明。
*
* 与 `lastProbeFailed` 的分工：那个回答"探活最近是不是失败过"（**只用于展示/日志**），
* 这个回答"这份凭证现在还能不能用"（**用于请求前拦截**，见 adapter.ts）。
* 差别就在**失败类型**：断网、超时、5xx 也是"探活失败"，但那种情况下凭证是好的，
* 拦下来会误伤健康账号。纯判据在 `auth.ts` 的 `staleAuthRecord`（可单测），
* 这里只负责按 token 找到对应的账号记录。
*/
function staleAuthMessage(auth) {
	if (!auth) return void 0;
	return staleAuthRecord(listAccounts().find((item) => item.token === auth.token));
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
/**
* 单个工具描述的上限。
*
* 2026-09-12 从 400 提到 3200。理由：DSH 实际下发 61 个工具，其中 17 个描述超过 400 字符，
* 而**被砍掉的恰恰是最要紧的部分** —— `pwsh` 的 3010 字符里有 2610 个字符在讲
* 「沙箱拒绝（file access denied）是策略判定、不是命令的 bug，别换个方式重试」
* 「命名管道不可用时 stdio:'pipe' 的 spawn 会报 EPERM，同样别换方式」
* 「只读沙箱下 .NET 静态调用 / Add-Type / COM / 反射会失败」这类**遇错该怎么办**的指引；
* `workflow` 的 2500 字符里是 agent() / pipeline() / parallel() 的钩子签名。
* 把它们砍掉，模型一遇错就只能瞎猜 —— 实测这两个工具正是 rejected.jsonl 里失败最多的。
*/
const MAX_DESCRIPTION_CHARS = 3200;
/**
* 工具目录（一节）的总预算。
*
* 2026-09-12 从 24_000 提到 56_000。理由：实测 DSH 下发 61 个工具、不截描述时共需
* **50,942 字符**，旧预算只装得下 35 个。更糟的是**截断是按字母序发生的**（工具按名排序），
* 于是 `write`(w)、`web_search`、`web_fetch`、`subagent`、`todo_write`、`skill`、`read_image`、
* 全部 `ssh_*`/`sftp_*` 被砍，而极少用的 `db_tx_rollback`、`db_list_connections` 反而留下。
* 取 56_000 留约十分之一余量（够再添几个中等大小的工具）；再超就走下面的"列出名字"兜底。
* 不至于撑爆上下文：DeepSeek 网页端上下文 1M token，而实际生效的 maxChars 是
* **150 万字符**（`index.ts` 的 `maxPromptChars` 默认值；这里 12 万那个旧注释已过时 ——
* 2026-09-13 核对时发现写的还是旧默认值，容易让人误判 prompt 体量）。
*/
const MAX_TOOLS_SECTION_CHARS = 56e3;
const HOLD_BACK_CHARS = 24;
const MAX_CAPTURE_CHARS = 262144;
/** 工具调用协议指令（固定文本，进 prompt 前缀，保持前缀缓存友好）。 */
/**
* head（system + 工具协议 + 工具目录）在 prompt 里最多占的比例。
* 0.62 是 0.1.33 调的：实测 61 个工具时 head 约 6.35 万字符，而 0.45 × 12 万 = 5.4 万装不下。
* 转写仍余约 5.6 万字符 —— 历史可以截，工具定义不可以。
*/
const HEAD_RATIO = .62;
/** 协议段拼接时的固定开销（换行、`---` 分隔、省略标记等）。 */
const PROTOCOL_SLACK_CHARS = 96;
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
6. Do NOT use XML/HTML-like markup for tool calls: no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>), and none of the private delimiter-prefixed variants some DeepSeek surfaces use. The JSON object above is the ONLY accepted format. Markup is not just ignored — it leaks into the visible transcript (and into the web conversation) as broken output.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result …]" blocks, tool output, or the current prompt. Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry — measured case: a model emitted 15 replayed calls inside one 8152-char payload, and every one of them had to be thrown away.
9. Keep each batch SMALL — at most 3 calls, and prefer exactly 1. If you need more, send them in successive steps. Long payloads are the ones that most often come out malformed.
10. Each call must be able to run on its own: no shared shell variables across calls, no dependence on another call in the same batch.`;
/** 判定「这是一段要执行的程序」的最小长度：短于它的多半只是行内提及某个 API。 */
const MIN_TOOL_PROGRAM_CHARS = 80;
/**
* 检测「模型把工具程序写成了正文」——而不是作为工具调用发出。
*
* 现场（2026-09-17 11:00，`--F-Code-DSH-Code-gongji--` 会话）：第三方 preset（染神）
* 的 `tool-bootstrap.mjs` 注入了一条 PTC 说明 ——「你在 Programmatic Tool Calling 模式，
* 所有动作必须通过 run_code 写 TypeScript 程序完成」；同 preset 的 persona 还写着
* `One complete deliverable per turn: numbered steps or code blocks`。
* 于是模型把 run_code 的 code 参数**原样贴进了正文**：三轮里一次工具调用都没发出
* （`toolCallCount` 始终为 0），agent loop 判定回合结束 → 用户看到「它停下来了」。
* 模型自己在 reasoning 里也承认："我把 TypeScript 代码写成了正文文本，而不是作为工具调用发出"。
*
* 判据：正文里出现**围栏代码块**且块内含 `tools.<name>(…)` 形态的调用 —— 那是 PTC
* 程序体的特征（正常回答不会这么写）。没有围栏时只认带 `await` 的形态，更严格，
* 免得把「提到某个 API」错判成「写了程序」。
*
* ⚠️ 这**只是判据**：调用方还要确认「本轮零工具调用」，否则健康的程序化调用轮会被误伤。
*/
function looksLikeUnexecutedToolProgram(text) {
	const source = String(text ?? "");
	if (!source) return false;
	const blocks = [];
	const fence = /```[^\n]*\n([\s\S]*?)```/g;
	let match;
	while ((match = fence.exec(source)) !== null) blocks.push(match[1]);
	if (blocks.length === 0) return /await\s+tools\.[A-Za-z_$][\w$]*\s*\(/.test(source);
	return blocks.some((block) => block.length >= MIN_TOOL_PROGRAM_CHARS && /tools\.[A-Za-z_$][\w$]*\s*\(/.test(block));
}
function truncate(text, max) {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3)}...`;
}
/** 渲染工具目录（含 JSON Schema）。 */
function buildToolSection(tools, maxChars = MAX_TOOLS_SECTION_CHARS) {
	if (!tools || tools.length === 0) return "";
	const parts = ["", "## Available tools"];
	let budget = Math.max(0, Math.min(MAX_TOOLS_SECTION_CHARS, maxChars));
	for (let index = 0; index < tools.length; index += 1) {
		const tool = tools[index];
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
			const rest = tools.slice(index).map((item) => String(item?.name ?? "")).filter(Boolean);
			parts.push(`\n(⚠️ The following ${rest.length} tools are NOT described above (omitted for length): ${rest.join(", ")}. If you need one of them, ask the user for its exact parameters — do NOT guess them.)`);
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
/**
* 逐张产出图片占位标记，**按图片在消息里的实际顺序**。
*
* 为什么要分「带上」与「略过」（0.1.77，群友实测报告 `code 10 / too many ref file`）：
* 图片是**请求级**的（一次请求用 `ref_file_ids` 带一批），而网页端对这一批的数量有上限 ——
* 实测最后一次成功是 40 张、第一次失败是 52 张，真值落在 (40, 52]。超长会话里我们只发
* 最近的 N 张，更早的会被略过；此时若标记仍一律写 `[image attached]`，模型就会**以为它
* 收到了那些图**，然后对着没送出去的图瞎猜。所以分两种标记写。
*
* ⚠️ **必须按顺序逐个产出，不能写成「N 个 attached 再 M 个 omitted」** ——
* 那样标记的先后就不再对应图片的时间先后，模型会搞不清被省略的是哪几张。
*
* `kept` 为 undefined 时全部算「已发出」（＝ 0.1.77 之前的行为，续写轮与既有单测走这条路）；
* 图没有 `attachmentId` 时也算「已发出」—— 那种情况判断不了，保守起见别把真发出去的标成省略。
*/
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
/** mediaType → 文件名后缀。服务端按**后缀**判类型（不看 multipart 里的 content-type）。 */
const IMAGE_EXT_BY_MEDIA_TYPE = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif"
};
/** 服务端认得的图片后缀。不在此列的一律重建名字，别把 bmp/tiff 之类原样发过去再被拒一次。 */
const KNOWN_IMAGE_EXT = /* @__PURE__ */ new Set([
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif"
]);
/**
* 上传时该用的文件名。
*
* 为什么必须归一（2026-09-15 真机 A/B，三组对照，同一份 PNG 字节只改名字）：
*   `image.png` ✅ / `<64位hex>.png` ✅ / **纯 64 位 hex ❌ `code 9 unsupported file type`** /
*   不给 name（走缺省 image.png）✅
* ⇒ 服务端**按文件名后缀**判类型，content-type 说了不算。
* 而宿主给 `tool/result` 内嵌图片的 `name` 正是**纯 sha256（没有后缀）**，
* `user/message` 与 `agent/inbox` 给的是 `image.png` —— 于是"凡是经工具返回的图一律传不上去"：
* 本机 09-14 的 36 次 + 09-15 的 6 次被拒，全部是这个原因（会话日志里
* `tool/result` 的 name 无一例外是 64 位 hex，user/message 无一例外带 .png）。
*
* 所以这里只保留**受支持的后缀**，其余按 mediaType 重建为 `image.<ext>`
* ——保证发出去的文件名总是声明了一个服务端支持的类型。
*/
function imageUploadName(name, mediaType) {
	const ext = IMAGE_EXT_BY_MEDIA_TYPE[String(mediaType ?? "").trim().toLowerCase()] ?? "png";
	const base = (typeof name === "string" ? name.trim() : "").split(/[\\/]/).pop() ?? "";
	const matched = /\.([a-z0-9]{2,5})$/i.exec(base);
	if (matched && KNOWN_IMAGE_EXT.has(matched[1].toLowerCase())) return base;
	return `image.${ext}`;
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
* 与 serializePrompt 同源，但额外交出 `head` 与未截断的 `entries`。
*
* 为什么需要（2026-09-14，链式投喂）：增量 = 本轮条目减去上一轮条目，必须拿
* **结构化**的条目数组去比前缀；而最终字符串可能被 truncateMiddle 从中间截过，
* 用字符串切前缀会把截断位置算错（截断点之后的"新增"其实是被挖掉的中段）。
*/
function serializePromptParts(options) {
	const maxChars = options.maxChars ?? 12e4;
	if (!Number.isSafeInteger(maxChars) || maxChars < 128) throw new RangeError("maxChars 必须为至少 128 的整数");
	const system = String(options.system ?? "").trim();
	const toolBudget = Math.max(0, Math.floor(maxChars * HEAD_RATIO) - system.length - TOOL_PROTOCOL_INSTRUCTIONS.length - PROTOCOL_SLACK_CHARS);
	const toolSection = buildToolSection(options.tools, toolBudget);
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
		const imageMarks = blockImageMarks(blocks, options.keptImageKeys);
		const images = imageMarks.length;
		if (text.trim() || toolResults.length === 0 && images === 0 || images > 0) {
			const imageNote = imageMarks.length > 0 ? `\n${imageMarks.join(" ")}` : "";
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
	if (merged.length <= maxChars) return {
		head,
		entries: lines,
		full: merged
	};
	const separator = transcript ? "\n\n---\n\n" : "";
	const budget = maxChars - head.length - separator.length;
	if (budget < 128) throw new AdapterLlmError("系统/工具定义超出 prompt 预算，请减少固定输入或扩大上限", "CONTEXT_WINDOW_EXCEEDED");
	return {
		head,
		entries: lines,
		full: head + separator + truncateMiddle(transcript, budget, .7)
	};
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
		if (XML_MARKER_STARTERS.some((starter) => starter.startsWith(lower))) return held;
		const loose = lower.replace(/[|｜]|dsml/g, "");
		if (/^<\/?[a-z_]*$/.test(loose) && XML_MARKER_STARTERS.some((starter) => starter.startsWith(loose))) return held;
		return 0;
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
/**
* XML 家族里**最后一个闭合调用块之后**的正文。
*
* 为什么需要它（0.1.82）：XML 捕获态是一直吃到轮末的（`flush` 才结算）。收不到包裹收尾时，
* 整段——包括调用块**之后的正文**——都留在 buffer 里；而 `flush` 只回吐 `calls`，
* 那段正文既不回吐也不计入 rejected ⇒ 回答"凭空中断"，且日志里零线索。
* 这里只负责定位"最后一个 `</invoke>` 家族收尾之后"的部分，交给 flush 剥残片后透出。
* 找不到收尾标签（抢救解析路径）时返回空串 —— 保持旧行为，不猜。
*/
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
		const rest = text.slice(cursor);
		if (isInvokeStart(rest)) continue;
		const stray = new RegExp(`^\\s*<\\/\\s*${DSML_PREFIX}(?:dsml-)?(?:${WRAPPER_NAMES})\\s*>`, "i").exec(rest);
		if (stray) return cursor + stray[0].length;
		const tail = rest.trim();
		if (tail.startsWith("<") && /^<\/?\s*[|｜]?\s*[A-Za-z]{0,14}$/.test(tail)) return -1;
		return cursor;
	}
}
/**
* 剥掉「孤立的工具调用标记残片」。
*
* ⚠️ 2026-09-12 实测泄漏（用户截图里那句 `voke> </ calls>`）：模型把**包裹开始标签写丢**，
* 只留下闭合标签，或者只留下标签的后半截。这些残片不属于回答，但会绕过捕获逻辑
* （识别器只认 `<…invoke` / `<…calls>` 这类**开始**形态）落进正文缓冲，最后被当正文吐出去。
*
* 触发路径是 `flush()`：残片通常很短（`</|DSML|calls>` 只有 16 字符），
* 小于 HOLD_BACK_CHARS 就会被一直 hold 住，流结束时无条件吐出。
*
* 三道规则，从明确到宽松：
*   1. 带 DSML 前缀的孤立闭合标签 —— `</|DSML|calls>` / `</ | DSML | invoke>`
*      （DSML 是 DeepSeek 私有的标记名，正文里不可能正常出现，剥掉零风险）
*   2. 前缀被吃光的退化形态 —— `</ calls>` / `</invoke>`
*   3. 只剩后半截的 —— 独占一行的 `voke>`（`invoke>` 掉了头）
* 正文里正常讨论 XML 时通常写在代码围栏或行内代码里，形态与这三条不同。
*/
function stripStrayToolMarkup(text) {
	if (!text) return text;
	if (!/voke\s*>|calls?\s*>|tool_calls?\s*>|function_calls?\s*>|DSML/i.test(text)) return text;
	return text.replace(new RegExp(`<\\/?\\s*(?:(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)|dsml-)(?:dsml-)?(?:${WRAPPER_NAMES}|invoke)\\s*>`, "gi"), "").replace(new RegExp(`<\\/\\s*(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?(?:dsml-)?(?:${WRAPPER_NAMES}|invoke)\\s*>`, "gi"), "").replace(/<\/\s+(?:tool_calls?|function_calls|calls|invoke)\s*>/gi, "").replace(/(^|\n)[ \t]*(?:in)?voke\s*>\s*(?=\n|$)/gi, "$1");
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
			if (calls) {
				out.calls.push(...calls);
				if (captured.mode === "xml") out.text += stripStrayToolMarkup(xmlToolCallTail(captured.buffer));
			} else if (looksLikeToolCallBlock(captured.mode, captured.buffer)) this.abandoned ??= {
				raw: captured.buffer,
				mode: captured.mode,
				reason: classifyFailure(captured.mode, captured.buffer)
			};
			else out.text += stripStrayToolMarkup(captured.buffer);
			this.capture = null;
		}
		out.text += stripStrayToolMarkup(this.pending);
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
							else out.text += stripStrayToolMarkup(captured.buffer);
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
					else out.text += stripStrayToolMarkup(block);
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
			this.pending = stripStrayToolMarkup(this.pending);
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
* 实测（deepseek-web）：模型会在正文里吐出成串的伪系统标记，**模仿它见过的协议格式**。
* 这与「转写回声」是同一类问题，但形态是 XML 标签而不是 `[Tool Result]` 行，
* 所以单独一层处理。围栏代码块内不剥（正常回答可能讨论这些标记）。
*
* ## 标签清单（只列**有现场证据**的，不做通配）
*
* ⚠️ 刻意**不用** `<[a-z_]+>` 这种通配：用户的正常回答可能就是一段讨论这些标签的文档，
* 通配会把它们一起吃掉。每加一个名字都要有现场 + 穷搜证据。
*
* | 标签 | 现场 |
* | --- | --- |
* | `ds_system` | 2026-09-11：一条正文里 13 个 `<ds_system>Tool result for call_1a2b3c</ds_system>`，调用 ID 还是字母递增编造的（1a2b3c→4d5e6f→7a8b9c…） |
* | `system` | 同批现场 |
* | `ide_result_status` | 2026-09-12（会话 `15ac4c56`）：正文里冒出 `<ide_result_status>Tool ran without output or errors</ide_result_status>`。⚠️ 该串在**DSH 的 `app.asar`（0 处）、全部已装插件（0 处）、`~/.dsh` 全树（0 处）**里都搜不到，且会话日志里**只出现在模型的输出字段**（212 条 `tool/result`、用户消息、系统消息里一处都没有）→ 判定是**模型自己编的**，不是 DSH 提供的 |
*
* @returns 剥离后的文本；`stripped` = 是否剥掉了至少一个标记（用于日志/告警）。
*/
const IMITATED_MARKER_TAGS = [
	"ds_system",
	"system",
	"ide_result_status"
];
/**
* 需要「正文够长」才剥的**跨行**标记。
*
* `tool_result`（2026-09-13 现场，会话 `15ac4c56` 记录 `[1480]`）：模型把 SSH 插件一次
* 读取工具的结果**整段复述**进正文，形如
*   `<tool_result>Path: …` + 换行 + `<path>…</path>` + 换行 + `<type>file</type>` + 换行 + `<content>` …
* 它比 `ds_system` 那批更「可讨论」——用户正在开发**产出它的那个插件**，正常回答里
* 可能出现简短示例。所以要求正文 ≥ 120 字才剥：真实回声是整份文件（实测那处上千字），
* 随口举例不会有那么长。围栏代码块内同样不剥。
*/
const LONG_MARKER_TAGS = [{
	tag: "tool_result",
	minBody: 120
}];
const LONG_MARKER_ALT = LONG_MARKER_TAGS.map((entry) => entry.tag).join("|");
/** 跨行闭合形态（`[\s\S]` 而不是逐行匹配 —— 真实回声的正文是跨行的）。 */
const LONG_CLOSED_MARKER_RE = new RegExp(`<(${LONG_MARKER_ALT})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, "g");
/** 跨行未闭合形态（流被截断在标记中间）。 */
const LONG_OPEN_MARKER_RE = new RegExp(`<(${LONG_MARKER_ALT})\\b[^>]*>([\\s\\S]*)$`, "g");
function minBodyFor(tag) {
	return LONG_MARKER_TAGS.find((entry) => entry.tag === tag)?.minBody ?? 0;
}
/**
* 代码围栏区间（成对的 ``` 或 ~~~）。
* 跨行替换没法像逐行处理那样顺手跟踪 inFence，所以先算出区间再判断命中点是否落在里面。
*/
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
/** 任一伪标记的开头是否出现（快速退出用，省掉对每段正文跑逐行循环）。 */
function hasImitatedMarker(text) {
	if (IMITATED_MARKER_TAGS.some((tag) => text.includes(`<${tag}`))) return true;
	return LONG_MARKER_TAGS.some((entry) => text.includes(`<${entry.tag}`));
}
/**
* 闭合形态 `<tag …>…</tag>`：用**反向引用**要求首尾同名，
* 避免 `<a>…</b>` 这种错配被当成一对连内容一起吃掉。
*/
const CLOSED_MARKER_RE = new RegExp(`<(${IMITATED_MARKER_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`, "g");
/** 未闭合形态：流在标记中间被截断 —— 半截标记同样是垃圾。 */
const OPEN_MARKER_RE = new RegExp(`<(${IMITATED_MARKER_TAGS.join("|")})\\b[^>]*>[\\s\\S]*$`, "g");
var SystemMarkerStreamFilter = class {
	pending = "";
	captured = "";
	tag = "";
	fence = "";
	fenceSize = 0;
	limit = 1048576;
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
		if (this.pending.length + this.captured.length > this.limit) throw new Error("系统标记缓冲超过 1 MiB，拒绝静默截断正文");
		if (final && this.tag) {
			const long = LONG_MARKER_TAGS.find((x) => x.tag === this.tag);
			const bodySize = this.captured.length - this.captured.indexOf(">") - 1;
			if (!long || bodySize >= long.minBody) stripped = true;
			else out += this.captured;
			this.captured = "";
			this.tag = "";
		}
		return {
			text: out,
			stripped
		};
	}
};
function stripSystemMarkers(text) {
	if (!hasImitatedMarker(text)) return {
		text,
		stripped: false
	};
	const ranges = fencedRanges(text);
	let strippedLong = false;
	text = text.replace(LONG_CLOSED_MARKER_RE, (match, tag, body, offset) => {
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
	let out = "";
	let inFence = false;
	let stripped = strippedLong;
	let i = 0;
	while (i < text.length) {
		const lineEnd = text.indexOf("\n", i);
		const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd + 1);
		const trimmed = line.trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) inFence = !inFence;
		if (!inFence) out += line.replace(CLOSED_MARKER_RE, () => {
			stripped = true;
			return "";
		}).replace(OPEN_MARKER_RE, () => {
			stripped = true;
			return "";
		});
		else out += line;
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
*
* `cleanMarkers`（2026-09-13，审计 N03）：是否在**这里**用无状态的 `stripSystemMarkers`
* 补剥伪系统标记。streamImpl 现在传 `false` —— 因为它已经用有状态的
* `SystemMarkerStreamFilter` 处理残余了，两遍都跑只会重复劳动；
* 默认 `true` 保留原语义，供单测与其它调用方使用。
*/
function drainTextPipeline(filter, boilerplate, guard, cleanMarkers = true) {
	const tailGuarded = guard.flush();
	const tailBoiled = boilerplate.flush();
	const tail = filter.flush();
	const dedisclaimered = stripWebDisclaimer(tailGuarded.text + tailBoiled.text + tail.text);
	return {
		text: (cleanMarkers ? stripSystemMarkers(dedisclaimered.text) : {
			text: dedisclaimered.text,
			stripped: false
		}).text,
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
/**
* 行内转写特征 —— **拆成强弱两档**，因为两者的可信度完全不同。
*
* 弱档：模型在**正常回答里引用一次**工具结果当证据是很常见的写法。
*   实测（2026-09-16 17:35，1ceshi 工作区会话 e17f4ccf）：它正是在正文里引 `[Tool Result …]`
*   来证明 `subagent_fork` 的继承范围与文档不符 —— 旧判据"行内命中即从该行起砍到结尾"把
*   整段回答（问题项 4、5 + 结论）一起吞了，用户只看到"话说到一半就停了"。
*   ⇒ 单独出现**不足以判定**是回声：只扣住，等后文再看（见 TranscriptEchoGuard.heldKind）。
*
* 强档：`truncated]` / `Assistant truncated` / `[N chars omitted]` 是 **prompt 自己的截断占位符**，
*   正常回答几乎不会引用它们 ⇒ 仍按回声立即处理
*   （实测 2026-09-11 17:2x：会话超长后模型原样复读这些占位符）。
*/
const ECHO_INLINE_WEAK_SIGNATURES = [
	/\[\s*Tool Result\b/i,
	/\[\s*status\s*:/i,
	/\[\s*(?:System|Assistant)\s*\]/i
];
const ECHO_INLINE_STRONG_SIGNATURES = [
	/\[\s*truncated\s*\]/i,
	/assistant\s+truncated/i,
	/\[\s*\d+\s*chars?\s+omitted\s*\]/i
];
[...ECHO_INLINE_WEAK_SIGNATURES, ...ECHO_INLINE_STRONG_SIGNATURES];
/**
* 行内弱特征行被扣住后，还要看到几行**普通内容**才敢判它是正文。
*
* 取 2：真回声紧跟着的还是转写内容（行首标记 / 轮次行 / 又一处引用），两行都干净就基本不是回放。
*/
const WEAK_HOLD_LINES = 2;
/** 扣住的行最多再缓冲几行就强制放行（防止"只有空行"时无限期扣住）。 */
const MAX_HELD_TAIL = 6;
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
				this.heldLine = null;
				this.heldKind = null;
				this.heldTail = [];
				return {
					text: out,
					echoed: true
				};
			}
			if (verdict === "turn" || verdict === "weak") {
				if (this.heldLine !== null) {
					this.fired = true;
					this.pending = "";
					this.heldLine = null;
					this.heldKind = null;
					this.heldTail = [];
					return {
						text: out,
						echoed: true
					};
				}
				this.heldLine = line;
				this.heldKind = verdict;
				this.heldSeen = 0;
				continue;
			}
			if (this.heldLine !== null) {
				this.heldTail.push(line);
				const blank = line.trim() === "";
				if ((this.heldKind === "turn" ? !blank : !blank && ++this.heldSeen >= WEAK_HOLD_LINES) || this.heldTail.length >= MAX_HELD_TAIL) {
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
/**
* 丢弃载荷的**诊断元信息**落盘。
*
* ⚠️ 默认**不落原文**（审计 F23）：被丢弃的是模型吐坏的工具调用参数，里面完全可能带着
* 命令里的 token、文件内容、个人信息 —— 以前默认把整段 raw 写进 `~/.dsh/deepseek-web/rejected.jsonl`，
* 等于给这些内容在磁盘上留了一份没人在看的副本。而且那个路径是**硬编码 homedir** 的，
* 无视 `DSH_HOME`（我们自己的测试就是被它坑到的：写到了真实用户目录）。
*
* 现在只记「什么时候 / 哪种模式 / 什么原因 / 多长 / 摘要」：
* 足够回答"是不是同一段坏输出反复出现"，又不需要保存原文。
* 需要看完整内容时，应该走"用户显式开启 + 有效期 + 0600 + 清理策略"的独立诊断，
* 而不是默认打开（本版没做）。
*
* ⚠️ 摘要（sha256）挡不住低熵内容被猜出来，它只是"不存原文"而非"内容不可还原"。
*/
function dumpRejectedPayload(raw, mode, reason, logger) {
	try {
		const dir = join(webLoginDir(), "diagnostics");
		mkdirSync(dir, {
			recursive: true,
			mode: 448
		});
		const file = join(dir, "rejected-meta.jsonl");
		const knownMode = [
			"json",
			"xml",
			"dsml"
		].includes(mode) ? mode : "other";
		const knownReason = [
			"unbalanced",
			"unparsable",
			"oversize",
			"echo"
		].includes(reason ?? "") ? reason : "other";
		const line = JSON.stringify({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			mode: knownMode,
			reason: knownReason,
			length: raw.length,
			sha256: createHash("sha256").update(raw).digest("hex")
		}) + "\n";
		let size = 0;
		try {
			size = statSync(file).size;
		} catch {}
		if (size + Buffer.byteLength(line) > 4e6) return;
		appendFileSync(file, line, {
			encoding: "utf8",
			mode: 384
		});
	} catch {
		try {
			logger?.debug?.("deepseek-web: 诊断元信息写入失败");
		} catch {}
	}
}
/**
* 图片上传缓存：`attachmentId → fileId`。
*
* ⚠️ 为什么必须按账号分作用域（审计 F06）：`fileId` 是**归属某个账号**的服务端对象。
* 缓存原先只按 `attachmentId` 记，切到另一个账号后会把上一个账号的 `fileId` 复用出去 ——
* 服务端是否接受是它的事（不能据此断言"跨账号能读到图"），但"把我们这边两个号的引用串了"
* 本身就已经是错的。另外只检查"被查中的那一项"的 TTL 不叫淘汰：一直换新图、不换旧 key 时，
* 旧项会永久滞留在内存里。
*
* 三条纪律：切账号（token 变）立刻整批清空；每次使用前清掉**所有**过期项；条数封顶。
* `token` 只在本进程内存里当作用域，不写日志、不落盘。
*/
var ImageUploadCache = class {
	scope = "";
	entries = /* @__PURE__ */ new Map();
	ttlMs;
	maxEntries;
	constructor(ttlMs = 72e5, maxEntries = 256) {
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
		for (const [key, value] of this.entries) if (now - value.at >= this.ttlMs) {
			this.entries.delete(key);
			removed += 1;
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
			return;
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
		this.entries.set(key, {
			fileId,
			at: now
		});
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
		for (const key of keys) if (this.entries.delete(key)) removed += 1;
		return removed;
	}
	/** 清空（测试隔离用）。 */
	reset() {
		this.entries.clear();
		this.scope = "";
	}
};
/**
* 这次失败该不该走「重传 → 禁图」的降级重试。抽成纯函数是为了能直接测 ——
* 尤其 `yielded` 那一支：用假的流很难构造「内容真的上屏过、然后又出错」的场景
* （文本会被过滤器 hold 到轮末，而异常发生在轮末之前），只能这样钉住它。
*
* 三个条件缺一不可：
*  · 错误是**请求侧的图片引用被拒**（上传侧的 code 9 是另一回事，见 isInvalidRefFileError）
*  · 这次请求**一个字都还没吐给上层** —— generator 已 yield 的内容撤不回来，
*    重试只会让用户看到重复输出
*  · 还没用完两次机会
*/
function canRetryImageReject(error, yielded, attempt) {
	return error?.code === "INVALID_REF_FILE" && !yielded && attempt < 2;
}
/**
* 下一条截断提示的触发门槛（纯函数，可单测）。
*
* 语义（0.1.81）：**首次必说明；之后只有情况明显恶化才再说一次。**
*  · 没提示过，或保留份数变了（用户改了 `maxRefImages`）⇒ 门槛 1（下一次就说明）
*  · 否则 ⇒ `max(FLOOR, 上次的份数 × 2)`，即**翻倍**、且至少再多 `TRIM_NOTICE_FLOOR` 份
*
* 为什么不再用「总条数:保留数」那种精确签名（0.1.79 → 0.1.81 的修正）：
* 「总条数」几乎每轮都在涨（模型每 `read_image` 一次就多一条内容）⇒ 签名天天变 ⇒
* 提示照旧每轮上屏。**判据里只要含一个"单调增长且变化频繁"的量，抑制就等于没做。**
*/
function nextTrimNoticeThreshold(previous, keptCount) {
	if (!previous || previous.kept !== keptCount) return 1;
	return Math.max(10, previous.dropped * 2);
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
/**
* 组装模型信息。
*
* `contextWindowOverride` 来自设置页的「上下文范围」滑块（经 gate.json → index.ts → AdapterConfig）。
* 传 undefined 就沿用 MODEL_SPECS 里的标称值（1Mi）—— 也就是不调这个开关时的原行为。
*
* ⚠️ 这个函数**每次请求都会被调用**（见下方 resolveModel / stream），所以滑块改完是即时生效的，
* 不需要重启 DSH。
*/
function resolvedModelInfo(provider, spec, requestedId, contextWindowOverride) {
	return {
		...modelInfoFor(provider, spec, requestedId),
		context: { contextWindow: contextWindowOverride ?? spec.contextWindow },
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
* 「把工具程序写成了正文」时的纠正指令（比自动续写更强的措辞 —— 续写是"接着写"，
* 这个是"你刚才那一轮等于什么都没做，请重新发一次"）。
*
* 为什么需要（2026-09-17 11:00 现场，见 protocol.ts 里 looksLikeUnexecutedToolProgram 的说明）：
* 染神 preset 注入了 PTC 说明（"所有动作必须通过 run_code 写 TypeScript 程序"），
* 模型于是把 run_code 的 code 直接贴进正文；这一轮零工具调用 ⇒ agent loop 判定回合结束
* ⇒ 界面上看起来"它停下来了"。加这一轮纠正后，模型有机会把同一段程序改发成工具调用。
*
* 措辞要点：① 点破"写出来 ≠ 执行了"；② 给出唯一被接受的形态；③ 明确对抗 PTC 措辞 ——
* 否则模型会继续把系统提示里那句"写出 TypeScript 程序"当成"写进正文"的许可。
*/
const TOOL_CALL_RETRY_INSTRUCTION = "你刚才把要执行的程序写进了正文文本。写在正文里的代码不会被执行 —— 这一轮因此没有发生任何工具调用。\n请把同一段程序作为工具调用重新发出：只输出一个 JSON 对象，前后不要有任何其它文字：\n{\"tool_calls\":[{\"name\":\"<工具名>\",\"arguments\":{...}}]}\n即使系统提示要求你写 TypeScript 程序来完成动作，那个程序也必须放进工具调用的 arguments 里，不能直接写在正文中 —— 只有作为工具调用发出，它才会真的被执行。";
/**
* 出现在末尾即「明显还有下文」的标点：列举 / 分句写到一半停了。
* 正常写完的回答**不可能**以这些收尾（它们是分隔符，不是终止符）。
*
* 0.1.66 补：`；`（全角分号）与 `、`（顿号）在旧实现里都落到了「非标点字符」那条兜底规则上，
* 被判成完整 —— 而这两个恰恰是最强的「没写完」信号（列举到一半、分句列到一半）。
* 实测（源码函数直接求值）旧行为：`；` → false、`、` → false，而 `，`/`：`/`;` → true，
* 同一个文件里两套标准。
*/
const MID_SENTENCE_TAIL = /* @__PURE__ */ new Set([
	"，",
	"、",
	"；",
	"：",
	",",
	";",
	":"
]);
/**
* 出现在末尾即视为「正常收尾」的标点。
*
* ⚠️ `…` 放在这里是**刻意的取舍**：省略号既可能是"话没说完"，也可能是作者有意的收束语气，
* 两种都常见。判 true 会让一句正常收尾的话被要求"接着写"（模型容易重复一遍），
* 感知上比偶发漏判更打扰，所以保守放行。真被服务端切断（无 FINISHED）时走 `cutByServer`，
* 不依赖这条判据。
*/
const COMPLETE_TAIL = /* @__PURE__ */ new Set([
	"。",
	"！",
	"？",
	"!",
	"?",
	"…",
	"）",
	")",
	"】",
	"》",
	"」",
	"』",
	"\"",
	"”",
	"’"
]);
/**
* 启发式：正文是否「在句中被截」。
* 判据（尾部最后一个非空白字符）：
*  - 是 CJK 汉字/字母/数字（没有任何标点收尾）→ 大概率被截；
*  - 是 markdown 强调标记（`**` / `__`）→ 被截在标记中间；
*  - 是逗号/顿号/分号/冒号 → 明显未完。
*  正常结束的正文几乎总以句号/问号/感叹号/右引号/右括号/代码块收尾/表格行结尾出现。
*
* ⚠️ 这是启发式，**只在"明显没写完"时才敢返回 true**：误判 true 只是白发一次续写请求，
* 误判 false 却是用户直接丢内容 —— 两种代价不同，所以判据本身要能读懂「分隔符 vs 终止符」。
*/
function looksMidSentence(text) {
	const trimmed = text.trimEnd();
	if (trimmed.length === 0) return false;
	if (trimmed.length < 40) return false;
	const last = trimmed[trimmed.length - 1];
	if (last === "*" || last === "_" || last === "#" || last === "~" || last === "`") return trimmed.endsWith("**") || trimmed.endsWith("__");
	if (MID_SENTENCE_TAIL.has(last)) return true;
	if (COMPLETE_TAIL.has(last)) return false;
	return /[a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff]/.test(last);
}
/**
* 自动续写只对**用户可见的回答**（purpose === 'chat'）生效。
*
* F26（2026-09-14 实测）：标题生成 / 上下文压缩这类内部调用天然**不以标点收尾**
* （标题就是"以汉字结尾"），于是 `looksMidSentence` 对它**恒为真** →
* 每轮都被判成"句中被截" → 自动发起续写、要求模型"接着写" → 模型把标题重复一遍，
* 直到续写额度用尽。结果标题变成重复垃圾：实测 13 个会话里 **11 个**中招 ——
* `"在吗在吗在吗"`、`"AI助手的记忆功能"×3`、`"安装 archify skills"×3`、
* `"TCP 三次握手原因解析"×3` …（只有走 fallback 的两个标题是正常的）。
*
* 续写的本意是"帮用户把被截断的回答写完整"，对内部短文本没有意义，所以按用途白名单收口：
* 只有 `chat`（或未指定）才续写 —— 将来新增别的内部用途也不会再踩进来。
*/
function allowsAutoContinue(purpose) {
	return purpose === void 0 || purpose === null || purpose === "" || purpose === "chat";
}
/** 构造 deepseek-web 适配器（鸭子类型满足 LlmAdapter 契约，无需继承）。 */
function createAdapter(deps) {
	const logger = deps.config.logger;
	const runStream = deps.streamCompletion ?? streamWebCompletion;
	const uploadImage = deps.uploadImage ?? uploadImageFile;
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
			return Promise.resolve(resolvedModelInfo(provider, resolveSpec(model), String(model ?? ""), deps.config.contextWindow));
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
	/** 图片上传缓存：按账号作用域 + TTL + 条数封顶（见 ImageUploadCache 的说明）。 */
	const uploadCache = new ImageUploadCache();
	/**
	* 上一次请求**实际引用**了哪几张图（attachmentId 集合）。
	* 用途只有一个：请求被服务端以 `code 9 / invalid ref file id` 拒掉时，
	* 知道该清掉缓存里哪几条，好让重试时重新上传（见 streamWithImageFallback）。
	*/
	let lastImageKeys = /* @__PURE__ */ new Set();
	/**
	* 上一次**已经上屏过**的截断规模（保留数 + 当时被略过的份数）。
	*
	* 为什么要它：只要历史里的图片内容超过上限，`uploadRequestImages` 每轮都会算出同一条提示 ——
	* 实测 19 分钟里连着上屏 **52 次**（2026-09-21 那个 drawio 配图会话），用户直接问
	* "为啥每次都这么多提示"。同一件事说一遍就够了，重复的只写日志。
	*
	* 🔴 0.1.81 修正了抑制的粒度。0.1.79 用的是 `总条数:保留数` 这个**精确签名**，
	* 而"总条数"几乎每轮都在涨 —— 模型每 `read_image` 一次就多一条内容 ⇒ 签名变了 ⇒
	* 提示照旧每轮上屏（2026-09-22 现场：29 份 → 30 份又来一遍，用户说"频率还是有点高"）。
	* 改成**阶梯**：首次必说明；之后只有"被略过的份数"比上次翻倍（且至少再多 `TRIM_NOTICE_FLOOR`
	* 份）才再说一次。这样一条会话里它是 O(log n) 次，而不是 O(n) 次。
	* 保留数变了（用户改了 `maxRefImages`）⇒ 情况本身变了，重新说明一次。
	*/
	let lastTrimNotice;
	/**
	* 把请求里出现的图片全部上传到网页端并返回 file_id 列表。
	* 失败不致命：记日志后跳过该图（prompt 里仍有 [image attached] 标记，模型会知道有图但看不到）。
	* 但**取消**要照常传播 —— 用户点了停止就不该继续传图，也不该把它降级成"纯文本继续跑"。
	*/
	async function uploadRequestImages(auth, messages, signal) {
		signal?.throwIfAborted();
		uploadCache.useScope(auth.token);
		const scope = uploadCache.currentScope();
		const refs = collectImageRefs(messages);
		if (refs.length === 0) return {
			ids: [],
			keys: [],
			keptKeys: /* @__PURE__ */ new Set()
		};
		const seen = /* @__PURE__ */ new Set();
		const unique = [];
		for (const ref of refs) {
			const key = String(ref?.attachmentId ?? "");
			if (!key || seen.has(key)) continue;
			seen.add(key);
			unique.push(ref);
		}
		if (unique.length === 0) return {
			ids: [],
			keys: [],
			keptKeys: /* @__PURE__ */ new Set()
		};
		if (!deps.readImage) {
			logger?.warn?.("deepseek-web: 收到图片但附件服务不可用（ctx.attachments），图片被忽略");
			return {
				ids: [],
				keys: [],
				keptKeys: /* @__PURE__ */ new Set(),
				notice: imageNotice(unique.length, "宿主没有提供附件读取能力（ctx.attachments）")
			};
		}
		const maxRefImages = deps.config.maxRefImages ?? 24;
		const overLimit = maxRefImages > 0 && unique.length > maxRefImages;
		const kept = overLimit ? unique.slice(-maxRefImages) : unique;
		const dropped = unique.length - kept.length;
		const trimNotice = overLimit && dropped >= nextTrimNoticeThreshold(lastTrimNotice, kept.length) ? imageTrimNotice(unique.length, dropped, kept.length) : void 0;
		if (trimNotice) lastTrimNotice = {
			kept: kept.length,
			dropped
		};
		if (overLimit) logger?.info?.(`deepseek-web: 本请求的图片共 ${unique.length} 张，超过上限 ${maxRefImages} ⇒ 只发最近的 ${kept.length} 张（较早的 ${unique.length - kept.length} 张本轮略过）`);
		uploadCache.prune();
		const ids = [];
		const failures = [];
		let attempted = 0;
		let skippedByAuth = 0;
		/** 真的进了 `ref_file_ids` 的那些 key —— 提示里的 `[image attached]` 只能写在这些图上。 */
		const sentKeys = /* @__PURE__ */ new Set();
		/** 与 `ids` **同序平行**的 key 数组 —— webapi 的 sentRefIds 按 key 记账需要这个对应关系。 */
		const sentKeyList = [];
		for (const ref of kept) {
			signal?.throwIfAborted();
			const key = String(ref?.attachmentId ?? "");
			const cached = uploadCache.get(key, Date.now(), scope);
			if (cached) {
				ids.push(cached);
				sentKeys.add(key);
				sentKeyList.push(key);
				continue;
			}
			attempted += 1;
			try {
				const stored = await deps.readImage(ref, signal);
				const mediaType = stored.mediaType || String(ref.mediaType ?? "image/png");
				const uploadedFile = await uploadImage(auth, {
					data: stored.data,
					mediaType,
					name: imageUploadName(stored.name ?? ref.name, mediaType)
				}, signal);
				uploadCache.set(key, uploadedFile.fileId, Date.now(), scope);
				ids.push(uploadedFile.fileId);
				sentKeys.add(key);
				sentKeyList.push(key);
			} catch (error) {
				if (signal?.aborted) throw error;
				const message = String(error?.message ?? error);
				failures.push(message);
				logger?.warn?.(`deepseek-web: 图片上传失败（已降级为纯文本）：${message}`);
				if (error?.code === "AUTH") {
					skippedByAuth = kept.length - attempted;
					logger?.warn?.(`deepseek-web: 图片上传遭遇授权失败，剩余 ${skippedByAuth} 张不再尝试`);
					break;
				}
			}
		}
		const notices = [];
		if (trimNotice) notices.push(trimNotice);
		if (failures.length > 0) notices.push(imageNotice(failures.length, failures[0], skippedByAuth));
		return {
			ids,
			keys: sentKeyList,
			keptKeys: sentKeys,
			...notices.length > 0 ? { notice: notices.join("") } : {}
		};
	}
	/**
	* 图片没能送进模型时的用户可见告知。
	*
	* 为什么必须写进回答：旧实现只 `logger.warn` 然后降级成纯文本，**界面上一声不响** ——
	* 用户会以为「模型看不懂图」，而实际上是图根本没发出去（2026-09-15 实测：本机 09-14
	* 有 36 次上传被服务端以 code 9 unsupported file type 拒绝，当轮 completion 正常
	* FINISHED，界面上看不到任何异常）。模型对外的 `inputModalities` 声明了 image，
	* 丢了却不告知，等于让用户对着一个「假装收到了」的输入提问。
	*
	* 与 F28 同一个原则：只要是「本该处理、但被丢弃」的输入，就必须显式说出来。
	*
	* `skipped`（0.1.80）：授权失效导致中途放弃时，**必须把"剩下的根本没试"说出来**。
	* 否则文案只报 `count`（实际只有第一张），用户会以为"只丢了一张图"、继续等结果，
	* 而真实情况是这一轮的图几乎全废了、且凭证已经不能用。
	*/
	function imageNotice(count, reason, skipped = 0) {
		return `\n⚠️ [deepseek-web] 有 ${count} 张图片没能传给模型（${reason.length > 120 ? `${reason.slice(0, 120)}…` : reason}）${skipped > 0 ? `；第一张被拒后即中止，剩余 ${skipped} 张未再尝试（授权失效是全局的，继续重试只是白跑请求）` : ""}，本轮回答只基于文字内容。\n`;
	}
	/**
	* 「本轮只带了最近 N 张图」的告知语。
	*
	* ⚠️ 措辞刻意**不带警告符号、也不用「没能」** —— 这是一次**正常的长度控制**，不是失败。
	* 用报错的口吻会让人以为出了问题，而在弄清原因之前，他很可能就把一个本可以继续用的会话丢掉了
	* （这正是 code 10 最恶劣的地方：会话看起来「坏了」，用户唯一出路是丢掉全部上下文）。
	* 所以这句里明确写了「不是错误」。
	*
	* 与上面那条的分工：那条讲「图发失败」（要警惕），这条讲「图按策略没发」（正常）。
	*/
	function imageTrimNotice(total, dropped, kept) {
		return `\n[deepseek-web] 本轮只带了最近 ${kept} 份图片内容，更早的 ${dropped} 份未随请求发送（历史累计 ${total} 份）。这里的「份」是**图片内容条目**、不是你贴的张数 ——模型每读一次图就会多算一条，所以它远多于你亲手贴的张数。网页端对单次请求能引用的图片数有上限，超了整轮都会被拒，因此按时间留最近的这些。正常的内容控制，不是错误。
`;
	}
	/**
	* 图片引用被服务端拒绝时的降级重试（0.1.78）。
	*
	* `code 9 / invalid ref file id` 的恶劣之处是「**带上图就失败**」：图留在 DSH 的消息历史里，
	* 之后每一轮都会重新收集、重新引用、再撞一次 —— 用户除了丢掉整个会话没有别的出路。
	* 所以给它两级自救，每级各只做一次：
	*   ① 丢掉那几条上传缓存 → 重新上传拿新 file_id → 重发
	*   ② 仍被拒 → **不带任何图片**重发，至少让这一轮继续下去（正文里会告知）
	*
	* ⚠️ **只在一次都没吐出内容时才敢重试**：generator 一旦 yield 过，调用方已经收到那部分，
	* 撤回不了（会变成重复输出）。好在服务端的引用校验发生在生成之前，命中这条错误时
	* 一定还没有任何输出 —— `yielded` 守卫是第二道保险，不是判据本身。
	*/
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
				current = attempt === 1 ? {
					...options,
					__retryImages: true
				} : {
					...options,
					__skipImages: true
				};
				logger?.warn?.(attempt === 1 ? "deepseek-web: 图片引用被服务端拒绝（code 9）—— 丢掉那几张的上传缓存，重新上传后重试一次" : "deepseek-web: 重新上传后图片引用仍被拒（code 9）—— 本轮改为不带图片重发");
			}
		}
	}
	/**
	* streamImpl 的闸门外壳：拿到许可后才真正开始请求，流结束（含被中断/抛错）才释放。
	*
	* ⚠️ 许可在 generator 体**内部**获取 —— 只有真正开始迭代（第一次 next()）才占位，
	* 消费者拿了 generator 却没迭代时不会泄漏名额；流被 abort 时 finally 一定会释放。
	*/
	async function* gatedStream(options) {
		const purpose = typeof options?.purpose === "string" && options.purpose ? options.purpose : "chat";
		try {
			await deps.maybeAutoSwitch?.();
		} catch {}
		const release = await gate.acquire(purpose, options?.signal);
		const startedAt = Date.now();
		const accountIdAtStart = deps.currentAccountId?.();
		let reported = false;
		/**
		* 捕获本轮适配器算出的 token 数（就是下面 yield 出去的 `usage` 事件）。
		* 为什么在这里抓而不是让 streamImpl 再算一遍：**同一组数只能有一个来源**，
		* 两处各算一次迟早会漂（本地统计说 1000、界面用量说 980 这种事最难查）。
		*/
		let capturedTokens;
		/** 上报一次结果。钩子是宿主给的，它自己负责不抛错；这里再兜一层，别让它影响调用。 */
		const report = (info) => {
			if (reported) return;
			reported = true;
			try {
				deps.noteCall?.({
					purpose,
					ms: Date.now() - startedAt,
					accountId: accountIdAtStart,
					...typeof options?.model === "string" && options.model ? { model: options.model } : {},
					...capturedTokens ? { tokens: capturedTokens } : {},
					...info
				});
			} catch {}
		};
		try {
			for await (const event of streamWithImageFallback(options)) {
				if (event?.type === "usage" && event.usage) {
					const input = Number(event.usage.inputTokens);
					const output = Number(event.usage.outputTokens);
					if (Number.isFinite(input) && Number.isFinite(output)) capturedTokens = {
						inputTokens: input,
						outputTokens: output,
						serverTotal: event.usage.serverTotal === true,
						...Number.isFinite(event.usage.reasoningTokens) ? { reasoningTokens: Number(event.usage.reasoningTokens) } : {}
					};
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
		if (!hasUsableAuth(auth)) throw new AdapterLlmError("尚未登录 DeepSeek 网页版：请在「设置 → DeepSeek 网页登录」里用浏览器窗口登录，或手动粘贴 userToken。", "MISSING_CREDENTIAL");
		const stale = staleAuthMessage(auth);
		if (stale) {
			logger?.warn?.(`deepseek-web: 跳过请求 —— 该账号登录态已被判定失效（${stale}）`);
			throw new AdapterLlmError(`这个账号的登录态已失效（${stale}），本次请求没有发出。请在「设置 → DeepSeek 网页登录」用浏览器窗口重新登录该账号；若确认它其实还能用，点账号行上的「校验全部」重新确认一次即可（只读探活，不消耗额度）。`, "AUTH");
		}
		const spec = resolveSpec(String(options?.model ?? ""));
		const { thinkingEnabled } = resolveThinking(options, spec);
		if (options?.__retryImages === true && lastImageKeys.size > 0) {
			const removed = uploadCache.invalidate(lastImageKeys);
			lastImageKeys = /* @__PURE__ */ new Set();
			logger?.warn?.(`deepseek-web: 已丢弃 ${removed} 条上传缓存（它们对应的 file_id 被服务端拒绝过）`);
		}
		const uploaded = options?.__skipImages === true ? {
			ids: [],
			keys: void 0,
			keptKeys: void 0,
			notice: void 0
		} : await uploadRequestImages(auth, options?.messages, options?.signal);
		if (uploaded.keptKeys) lastImageKeys = uploaded.keptKeys;
		const refFileIds = uploaded.ids;
		let promptParts = serializePromptParts({
			system: options?.system,
			messages: options?.messages ?? [],
			tools: options?.tools ?? [],
			maxChars: deps.config.maxPromptChars ?? 4e5,
			keptImageKeys: uploaded.keptKeys
		});
		const prompt = promptParts.full;
		const knownNames = new Set((options?.tools ?? []).map((tool) => String(tool?.name ?? "")));
		let filter = new ToolCallStreamFilter(knownNames);
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
		let echoedTranscript = false;
		/** 被回声守卫砍掉后半段时追加的告知字符数（从 usage 估算里扣掉，别当成模型的输出）。 */
		let echoNoticeChars = 0;
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
			if (uploaded.notice) {
				const noticeBlock = openText();
				textStarted = true;
				yield {
					type: "block-start",
					index: noticeBlock.index,
					blockType: "text"
				};
				noticeBlock.text += uploaded.notice;
				yield {
					type: "text-delta",
					index: noticeBlock.index,
					text: uploaded.notice
				};
			}
			let rounds = 0;
			/** 本步已因「把工具程序写成正文」纠正过一次 —— 只给一次机会，别把请求密度打上去。 */
			let toolCallRetried = false;
			let currentPrompt = prompt;
			/** 本轮开始前已累计的正文长度（用来量出「这一轮到底吐了多少字」）。 */
			let textLenAtRoundStart = 0;
			/** 本轮开始的时刻（用来量出「这一轮到底跑了多久」）。 */
			let roundStartedAt = Date.now();
			for (;;) {
				let roundError;
				const roundUsage = {
					prompt: currentPrompt,
					outputChars: 0
				};
				usageRounds.push(roundUsage);
				finishReason = void 0;
				textLenAtRoundStart = textBlock?.text?.length ?? 0;
				roundStartedAt = Date.now();
				try {
					for await (const event of runStream(auth, {
						prompt: currentPrompt,
						canFailover: deps.canFailover,
						promptParts: {
							head: promptParts.head,
							entries: promptParts.entries,
							maxChars: deps.config.maxPromptChars ?? 4e5
						},
						onContextFeed: (report) => {
							logger?.info?.(report.reason === "chained" ? `deepseek-web: 上下文投喂=链式：本轮只发增量 ${report.promptChars} 字（历史由服务端维护）` : report.reason === "mode-full" ? "deepseek-web: 上下文投喂=每轮全量：重发完整 prompt" : `deepseek-web: 链式投喂退回全量重发（原因=${report.reason}）`);
						},
						thinkingEnabled,
						modelType: spec.modelType,
						refFileIds: rounds === 0 ? refFileIds : [],
						refKeys: rounds === 0 ? uploaded.keys : [],
						signal: options?.signal,
						idleTimeoutMs: deps.config.idleTimeoutMs ?? 12e4,
						...deps.config.sessionReuseTurns !== void 0 ? { sessionReuseTurns: deps.config.sessionReuseTurns } : {},
						onDeleteSession: deps.config.deleteWebSessions === false ? void 0 : (sessionId) => {
							if (deps.sessionCleaner) deps.sessionCleaner.schedule(auth, sessionId);
							else scheduleDeleteSession(auth, sessionId);
						}
					})) {
						if (event.kind === "thinking" || event.kind === "text") roundUsage.outputChars += event.text.length;
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
							const cleaned = systemMarkerFilter.push(guarded.text);
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
								throw new AdapterLlmError(throttled ? "网页版限流：发得太频繁，稍后自动重试" : "网页版限流：同一账号同时只能生成一条消息，稍后自动重试", "RATE_LIMIT", {
									...event.retryAfterMs !== void 0 ? { providerRetryAfterMs: event.retryAfterMs } : {},
									...throttled ? { rateLimitKind: "throttled" } : {}
								});
							}
							throw new AdapterLlmError(`DeepSeek 网页端返回错误：${event.message}`, "PROVIDER_ERROR");
						}
						if (event.kind === "finish") {
							finishReason = event.reason;
							if (typeof event.totalTokens === "number" && Number.isSafeInteger(event.totalTokens) && event.totalTokens >= 0) roundUsage.total = event.totalTokens;
						}
					}
				} catch (error) {
					if (rounds > 0) {
						if (options?.signal?.aborted) throw new AdapterLlmError("deepseek-web 请求被调用方取消", "ABORTED", { cause: error });
						roundError = error instanceof AdapterLlmError ? error : new AdapterLlmError(`deepseek-web 自动续写失败：${error?.message ?? error}`, "TRANSPORT", { cause: error });
						logger?.warn?.(`deepseek-web: 自动续写第 ${rounds} 轮失败，保留已输出部分：${roundError.message}`);
					} else throw error;
				}
				const drained = drainTextPipeline(filter, boilerplate, echoGuard, false);
				if (drained.echoed) echoedTranscript = true;
				if (drained.disclaimers > 0) disclaimerStripped = true;
				const markerPending = systemMarkerFilter.push(drained.text);
				const markerEnd = systemMarkerFilter.flush();
				const tailText = markerPending.text + markerEnd.text;
				if (markerPending.stripped || markerEnd.stripped);
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
					logger?.warn?.(`deepseek-web: 工具调用${drained.rejected.mode === "xml" ? "（XML）" : ""}解析失败[${drained.rejected.reason ?? "unparsable"}]，已丢弃 ${drained.rejected.raw.length} 字符（原文不落盘；以下片段仅写入宿主日志）：` + drained.rejected.raw.slice(0, 2e3));
					if (rounds === 0) {
						rejectedProtocol = drained.rejected.raw;
						rejectedReason = drained.rejected.reason ?? "unparsable";
					} else {
						const notice = `\n[deepseek-web] 本次输出的一个工具调用因格式无法解析（${drained.rejected.reason ?? "unparsable"}）被丢弃，该调用未执行；请改用约定的 JSON 格式重发。\n`;
						const noticeBlock = openText();
						if (!textStarted) {
							textStarted = true;
							yield {
								type: "block-start",
								index: noticeBlock.index,
								blockType: "text"
							};
						}
						noticeBlock.text += notice;
						yield {
							type: "text-delta",
							index: noticeBlock.index,
							text: notice
						};
					}
				}
				const partial = textBlock?.text ?? "";
				const roundChars = partial.length - textLenAtRoundStart;
				const maxRounds = deps.config.maxContinuations ?? 2;
				const cutByServer = finishReason === void 0;
				const midSentence = looksMidSentence(partial);
				logger?.info?.(`deepseek-web: 第 ${rounds + 1} 轮流结束：[本轮 ${roundChars} 字 / 累计 ${partial.length} 字 / 耗时 ${Date.now() - roundStartedAt}ms] finish=${finishReason ?? "(无 FINISHED → 服务端截断)"}${midSentence ? "，尾部是句中" : ""}${roundChars === 0 && rounds === 0 ? toolCallCount > 0 ? "（本轮正文 0 字，但已提取到工具调用 —— 正常形态）" : "（本轮正文 0 字、且无工具调用 —— 内容可能全在思考通道）" : ""}`);
				const eligible = allowsAutoContinue(options?.purpose) && roundError === void 0 && deps.config.autoContinue !== false && rounds < maxRounds && toolCallCount === 0 && !options?.signal?.aborted && partial.length > 0 && roundChars > 0 && (midSentence || cutByServer);
				const unexecutedProgram = !eligible && allowsAutoContinue(options?.purpose) && roundError === void 0 && deps.config.autoContinue !== false && rounds < maxRounds && toolCallCount === 0 && !toolCallRetried && !options?.signal?.aborted && partial.length > 0 && looksLikeUnexecutedToolProgram(partial);
				if (!eligible && !unexecutedProgram) break;
				rounds += 1;
				if (unexecutedProgram) toolCallRetried = true;
				logger?.info?.(unexecutedProgram ? `deepseek-web: 本轮把工具程序写进了正文（零工具调用），已要求它改发工具调用（第 ${rounds}/${maxRounds} 轮）……` : `deepseek-web: 回答疑似在句中被截，自动续写（第 ${rounds}/${maxRounds} 轮）……`);
				promptParts = serializePromptParts({
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
								text: unexecutedProgram ? TOOL_CALL_RETRY_INSTRUCTION : CONTINUE_INSTRUCTION
							}]
						}
					],
					tools: options?.tools ?? [],
					maxChars: deps.config.maxPromptChars ?? 4e5
				});
				currentPrompt = promptParts.full;
				filter = new ToolCallStreamFilter(knownNames);
				echoGuard = new TranscriptEchoGuard();
				systemMarkerFilter = new SystemMarkerStreamFilter();
				boilerplate = new BoilerplateFilter();
			}
		} catch (error) {
			if (error instanceof AdapterLlmError) throw error;
			if (options?.signal?.aborted) throw new AdapterLlmError("deepseek-web 请求被调用方取消", "ABORTED", { cause: error });
			throw new AdapterLlmError(`deepseek-web 流失败：${error?.message ?? error}`, "TRANSPORT", { cause: error });
		}
		if (echoedTranscript && toolCallCount === 0 && textBlock && textBlock.text.length > 0) {
			const echoNotice = "\n\n[deepseek-web] 本轮有一部分「历史回放格式」的内容被过滤（未上屏），回答可能因此不完整。\n";
			textBlock.text += echoNotice;
			echoNoticeChars = 54;
			yield {
				type: "text-delta",
				index: textBlock.index,
				text: echoNotice
			};
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
		yield {
			type: "usage",
			usage: {
				inputTokens,
				outputTokens,
				serverTotal,
				...reasoningBlock ? { reasoningTokens: Math.min(outputTokens, estimateTokens(reasoningBlock.text)) } : {}
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
		if (!hasVisibleText) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: outputChars > 0 ? "DeepSeek 网页端本轮没有正文、也没有工具调用（内容可能全落在思考通道 —— 通常是思考不收敛后被截断），已按可重试错误上报" : "DeepSeek 网页端返回了空响应（可能触发频控或长上下文截断）",
						code: "EMPTY_RESPONSE"
					}
				}
			};
			return;
		}
		if (textBlock?.text && looksMidSentence(textBlock.text)) {
			if (!allowsAutoContinue(options?.purpose)) logger?.info?.(`deepseek-web: 内部用途（purpose=${String(options?.purpose)}）的回答以非标点收尾，按约定不自动续写，正常收尾（尾部：${JSON.stringify(textBlock.text.slice(-40))}）`);
			else logger?.warn?.(`deepseek-web: 回答在句中被截且自动续写额度已用尽，按正常完成上报（尾部：${JSON.stringify(textBlock.text.slice(-60))}）`);
		}
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
		tokenLength: auth.token.length,
		...(() => {
			const life = summarizeCookieLife(auth.cookieMeta);
			return life ? { cookieLife: life } : {};
		})()
	};
}
//#endregion
//#region src/auto-switch.ts
/** 这个账号**现在**能用吗（未失效、未受限）。 */
function isUsable(account, now) {
	if (account.lastVerifyError) return false;
	const until = Number(account.limit?.untilMs);
	if (Number.isFinite(until) && until > now) return false;
	return true;
}
/**
* 到点了吗。
*
* `lastSwitchAt` 由调用方负责给一个有意义的起点（插件启动时刻、或用户上次手动切号的时刻），
* 并**每次成功切换后刷新** —— 否则用户刚手动切完，1 分钟后又被自动切走。
* 没有起点（≤ 0）时**不切**：宁可不动，也不要在不知道"已经用了多久"的情况下贸然换号。
*/
function isSwitchDue(minutes, lastSwitchAt, now) {
	if (!Number.isFinite(minutes) || minutes <= 0) return false;
	if (!Number.isFinite(lastSwitchAt) || lastSwitchAt <= 0) return false;
	return now - lastSwitchAt >= minutes * 6e4;
}
/**
* 挑下一个可切换的账号。
*
* 规则：先滤掉不可用的，再取**当前账号之后的第一个**（走到末尾绕回开头）。
*
* 为什么是"当前账号的下一个"而不是"每次都取第一个可用的"：
*   后者会让列表里的第二个账号成为唯一被切到的目标，其余永远不动 —— 那还是集中，不是分散。
*
* 边界：
*   - 一个可用的都没有 ⇒ undefined（不切）
*   - 当前账号自己不可用（失效/受限）⇒ 取第一个可用的（这是"救急"路径，本来就该切走）
*   - 可用的只有当前这一个 ⇒ undefined（切了还是它，没意义）
*/
function pickNextAccount(accounts, currentId, now) {
	const usable = accounts.filter((account) => isUsable(account, now));
	if (usable.length === 0) return void 0;
	const index = usable.findIndex((account) => account.id === currentId);
	if (index < 0) return usable[0]?.id;
	if (usable.length === 1) return void 0;
	return usable[(index + 1) % usable.length]?.id;
}
/**
* 把上面两个函数合成一次决策。
*
* 「当前账号不可用」是**例外优先**的：哪怕没到点也要切走 —— 让用户在一个失效的账号上
* 继续等满 N 分钟是没有意义的（每个请求都会失败）。这也正好把"自动切号"和
* "失效账号自动救急"合并成一条路径，不用两套逻辑。
*/
function decideAutoSwitch(params) {
	const { minutes, lastSwitchAt, now, accounts, currentId } = params;
	if (!Number.isFinite(minutes) || minutes <= 0) return {
		action: "skip",
		reason: "off"
	};
	const current = accounts.find((account) => account.id === currentId);
	const currentUnusable = current !== void 0 && !isUsable(current, now);
	if (!currentUnusable && !isSwitchDue(minutes, lastSwitchAt, now)) return {
		action: "skip",
		reason: "not-due"
	};
	const nextId = pickNextAccount(accounts, currentId, now);
	if (!nextId) return {
		action: "skip",
		reason: accounts.filter((account) => isUsable(account, now)).length === 0 ? "no-candidate" : "no-other-account"
	};
	return {
		action: "switch",
		nextId,
		reason: currentUnusable ? "current-unusable" : "due"
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
		if (typeof WebSocketCtor !== "function") throw new Error("当前 Node 没有全局 WebSocket，无法使用 CDP");
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
			const onFail = () => finish(/* @__PURE__ */ new Error("CDP 连接失败"));
			const onClosed = () => finish(/* @__PURE__ */ new Error("CDP 建连时连接被关闭"));
			const timer = setTimeout(() => finish(/* @__PURE__ */ new Error("CDP 连接超时")), timeoutMs);
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
				if (message.error) item.reject(/* @__PURE__ */ new Error(`CDP 错误 ${message.error.code ?? ""}: ${message.error.message ?? ""}`));
				else item.resolve(message.result);
				return;
			}
			if (message.method) for (const listener of this.listeners) try {
				listener(message.method, message.params);
			} catch {}
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
			this.pending.set(id, {
				resolve,
				reject,
				timer
			});
			try {
				this.socket.send(JSON.stringify({
					id,
					method,
					params
				}));
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
			item.reject(/* @__PURE__ */ new Error("CDP 已关闭"));
		}
		this.pending.clear();
		this.listeners = [];
		const socket = this.socket;
		this.socket = void 0;
		try {
			if (socket && socket.readyState < 2) socket.close();
		} catch {}
	}
};
const DEFAULT_TIMEOUT_MS = 3e5;
const DEFAULT_PROFILE_DIR = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "web-login", "browser-profile");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
* 探一次 CDP 的 HTTP 端点。
*
* ⚠️ 每次请求都要有**自己的**超时（审计 F15）：旧写法只有外层循环的 deadline，
* 一次请求挂住就再也回不到循环条件上，"deadline"形同虚设。
*/
async function cdpJson(port, endpoint, signal) {
	const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(2e3)]) : AbortSignal.timeout(2e3);
	const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
		signal: bounded,
		redirect: "error"
	});
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new Error("CDP HTTP 请求失败");
	}
	return await res.json();
}
/**
* 这个 target 是不是 chat.deepseek.com 的页面。
*
* 用 `origin` **严格相等**，不用 `includes`（审计 F15）：`includes('deepseek.com')` 会命中
* `chat.deepseek.com.evil.example` 这类域名，也会命中深链页/其它子域，可能选错 target。
*/
/** R7：本插件最近一次拉起的浏览器子进程（clearBrowserLoginProfile 清理失败时杀它重试）。 */
let lastSpawnedChild;
function isDeepSeekPage(target) {
	try {
		return target?.type === "page" && new URL(String(target.url)).origin === "https://chat.deepseek.com";
	} catch {
		return false;
	}
}
/** 等 CDP 的 HTTP 端点可用，返回调试端口。 */
async function waitForDebugPort(profileDir, child, timeoutMs, signal) {
	const portFile = join(profileDir, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) return void 0;
		if (child.exitCode !== null) return void 0;
		try {
			const port = parseDevToolsActivePort(readFileSync(portFile, "utf8"));
			if (port) try {
				await cdpJson(port, "/json/version", signal);
				return port;
			} catch {}
		} catch {}
		await sleep(300);
	}
}
/** 找到 chat.deepseek.com 的页面 target（等 SPA 起来）。 */
async function findPageTarget(port, timeoutMs, signal) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) return null;
		try {
			const targets = await cdpJson(port, "/json/list", signal);
			const page = Array.isArray(targets) ? targets.find((t) => isDeepSeekPage(t)) : void 0;
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
		lastSpawnedChild = child;
	} catch (error) {
		return {
			ok: false,
			reason: "spawn-failed",
			message: `启动 ${browser.name} 失败：${error?.message ?? error}`
		};
	}
	let spawnError;
	child.on("error", (error) => {
		spawnError = error;
		progress(`${browser.name} 启动失败（异步错误）：${error?.message ?? error}`);
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	if (spawnError) {
		try {
			child.kill();
		} catch {}
		return {
			ok: false,
			reason: "spawn-failed",
			message: `启动 ${browser.name} 失败：${spawnError.message}`
		};
	}
	const cleanupBrowser = () => {
		try {
			child.kill();
		} catch {}
	};
	const port = await waitForDebugPort(profileDir, child, 25e3, options.signal);
	if (!port) {
		cleanupBrowser();
		return {
			ok: false,
			reason: "no-debug-port",
			message: `${browser.name} 起来了但调试端口不可用（可能被安全软件拦截）。请改用「用我的默认浏览器登录」+ 手动粘贴 Token。`
		};
	}
	const page = await findPageTarget(port, 2e4, options.signal);
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
			if (child.exitCode !== null || child.killed) {
				cleanupBrowser();
				return {
					ok: false,
					reason: "browser-closed",
					message: "浏览器已关闭，登录已取消。需要的话再点一次「浏览器窗口登录」即可。"
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
				let cookieMeta = [];
				try {
					const raw = (await cdp.send("Storage.getCookies", {}))?.cookies ?? [];
					cookie = buildCookieHeader(raw);
					cookieMeta = pickCookieMeta(raw, (domain) => String(domain ?? "").includes("deepseek"));
				} catch {}
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
		try {
			lastSpawnedChild?.kill();
		} catch {}
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
}
let startedAt = null;
/** 进入添加模式（点「登录新账号」时调用）。 */
function beginAddAccount(now = Date.now()) {
	startedAt = now;
}
/** 当前是否处于添加模式（超时即失效并自行清除）。 */
function addModeActive(now = Date.now()) {
	if (startedAt === null) return false;
	if (now - startedAt > 9e5) {
		startedAt = null;
		return false;
	}
	return true;
}
/** 退出添加模式（捕获完成 / 用户又点了退出或切换 —— 那些是明确的"改当前账号"动作）。 */
function endAddAccount() {
	startedAt = null;
}
let reloginTarget = null;
/** 进入"重新登录"意图（点某个账号那行的「重新登录」时调用）。 */
function beginRelogin(id, now = Date.now()) {
	reloginTarget = {
		id,
		at: now
	};
}
/** 退出意图（捕获完成时消费；用户又去点别的动作时也可以显式清掉）。 */
function endRelogin() {
	reloginTarget = null;
}
/** 取当前待生效的重新登录目标（超时即失效并自行清除）。 */
function pendingReloginTarget(now = Date.now()) {
	if (!reloginTarget) return void 0;
	if (now - reloginTarget.at > 36e5) {
		reloginTarget = null;
		return;
	}
	return reloginTarget.id;
}
/**
* 这次捕获的凭证是不是"就是那条记录对应的账号"。
*
* 捕获本身只拿到 token/cookie，**没有身份**；认不出身份时按"就是它"处理 ——
* 因为意图是用户刚刚在本机点出来的（且只有 TTL 内有效），
* 而"认得出、但明显是另一个号"时才必须放行成新增，免得把别人的记录覆盖掉。
*/
function sameAccount(existing, auth) {
	const incoming = auth;
	const incomingId = incoming.serverId ?? incoming.user?.id;
	const knownId = existing.serverId ?? existing.user?.id;
	if (!incomingId || !knownId) return true;
	return incomingId === knownId;
}
/**
* 捕获到凭证后的统一落库动作。
*
* 默认（非添加模式）：`writeAuth()` —— 写入并设为当前，行为与以前完全一致。
* 添加模式：`upsertAccount()` —— 只入库；当前账号**原样不动**。
*/
function commitCapturedAuth(auth, now = Date.now()) {
	const target = pendingReloginTarget(now);
	if (target) try {
		const existing = readAccount(target);
		if (existing && sameAccount(existing, auth)) {
			const record = upsertAccount(auth, { id: target });
			updateAccount(target, { lastVerifyError: void 0 });
			return {
				mode: "relogin",
				created: false,
				recordId: record.id
			};
		}
	} finally {
		endAddAccount();
		endRelogin();
	}
	if (!addModeActive(now)) {
		writeAuth(auth);
		const active = activeAccountId();
		return {
			mode: "switch",
			...active ? { recordId: active } : {}
		};
	}
	const before = new Set(listAccounts().map((item) => item.id));
	const hadActive = activeAccountId() !== void 0;
	try {
		const record = upsertAccount(auth);
		if (!hadActive) setActiveAccount(record.id);
		return {
			mode: "add",
			created: !before.has(record.id),
			recordId: record.id
		};
	} finally {
		endAddAccount();
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
/**
* 停止当前登录轮询：清定时器 **并且**取消进行中的校验。
* F08 之前存的是定时器句柄，`clearInterval` 只能阻止"下一轮"，
* 拦不住已经在 await 里的那一轮 —— 窗口关闭后它照样会把凭证写回来。
*/
let stopPolling = null;
let progress = { open: false };
let lastResult;
let fingerprintReport;
function getFingerprintReport() {
	return fingerprintReport;
}
/**
* 用系统浏览器打开登录页。
*
* ⚠️ 2026-09-13 第二轮审计 N10：旧实现在 `spawn(...)` 之后立刻 `return {ok:true}`，
* 外面那层 try/catch **只能接同步异常**；`error` 是 EventEmitter 在下一个事件循环异步发出的，
* 没有监听就意味着**未处理错误 → 宿主进程直接退出**（同一类问题在 browser-login.ts 修过，
* 这条路径漏了）。现在等 `spawn`/`error` 之一落地再返回。
*/
async function openExternalLogin() {
	if (canOpenElectronWindow()) try {
		await createRequire(import.meta.url)("electron").shell.openExternal(LOGIN_URL);
		return {
			ok: true,
			url: LOGIN_URL,
			via: "electron-shell"
		};
	} catch {}
	const failed = (error) => ({
		ok: false,
		url: LOGIN_URL,
		message: `${error instanceof Error ? error.message : String(error)} —— 请手动在浏览器打开 ${LOGIN_URL}`
	});
	try {
		const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
		const args = process.platform === "win32" ? [
			"/c",
			"start",
			"",
			LOGIN_URL
		] : [LOGIN_URL];
		return await new Promise((resolve) => {
			const child = (0, createRequire(import.meta.url)("node:child_process").spawn)(command, args, {
				stdio: "ignore",
				detached: true
			});
			child.once("error", (error) => resolve(failed(error)));
			child.once("spawn", () => {
				child.unref?.();
				resolve({
					ok: true,
					url: LOGIN_URL,
					via: command
				});
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
	if (stopPolling) {
		try {
			stopPolling();
		} catch {}
		stopPolling = null;
	}
	loginWindow = null;
	progress = {
		...progress,
		open: false
	};
}
/**
* 登录轮询（F08）。三条不变量都在这里守住，抽成独立函数是为了**能离线验证**——
* 原来它写在 Electron 的 `setInterval` 回调里，一条都测不了。
*
*  ① **串行**：一轮跑完才排下一轮（旧写法是 `setInterval` + 异步体，
*     校验耗时超过 2 秒时会有多轮同时在跑）；
*  ② **至多提交一次**：`committed` 先占位再提交，成功与 fail-open 两条路都走它
*     （旧写法下第二轮会把"添加新账号"再提交一次，而添加模式已被消费 → 变成普通切换）；
*  ③ **停止后不写回**：`stop()` 之后，已经在 `await` 里的那一轮结果一律丢弃。
*
* 返回的 `stop()` 可重复调用。
*/
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
			round();
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
				options.onError?.("登录捕获或保存失败，请重新发起登录");
				options.logger?.warn?.(`deepseek-web: 登录捕获或保存失败: ${error?.message ?? error}`);
			}
		} finally {
			running = false;
			schedule();
		}
	};
	timer = setTimeout(() => {
		round();
	}, intervalMs);
	timer.unref?.();
	return stop;
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
		cookieMeta: [],
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
	const extraHeaders = Object.keys(buffer.extraHeaders).length > 0 ? buffer.extraHeaders : void 0;
	const defect = captureDefect({
		token,
		cookie: buffer.cookie,
		extraHeaders
	});
	return {
		token,
		cookie: buffer.cookie,
		cookieMeta: buffer.cookieMeta,
		hifDliq: buffer.hifDliq,
		hifLeim: buffer.hifLeim,
		wasmUrl: buffer.wasmUrl || "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm",
		userAgent: buffer.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
		const relevant = (await ses.cookies.get({})).filter((cookie) => String(cookie?.domain ?? "").includes("deepseek.com"));
		if (relevant.length > 0) {
			buffer.cookie = relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
			buffer.cookieMeta = pickCookieMeta(relevant, (domain) => String(domain ?? "").includes("deepseek.com"));
		}
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
	const captureAbort = new AbortController();
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
		const commit = commitCapturedAuth(auth);
		const tail = commit.mode === "add" ? "（已加入账号库，当前账号未改动）" : "";
		lastResult = {
			ok: true,
			message: (verified ? `登录成功${auth.user?.display ? `（${maskIdentifier(auth.user.display)}）` : ""}，凭证已保存并校验通过` : "已捕获并保存凭证，但服务端校验未通过（可用「发送测试」做真实判定）") + tail,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		logger?.info?.(`deepseek-web login: credentials saved (verified=${verified}, mode=${commit.mode})`);
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
	let verifiedAuth;
	stopPolling = startCapturePoll({
		capture: async () => {
			await readPage(win, buffer);
			await readCookies(ses, buffer);
			return tokenCandidates(buffer);
		},
		verify: async (token) => {
			const auth = buildAuth(buffer, token, false);
			const check = await validateAuth(auth, AbortSignal.any([captureAbort.signal, AbortSignal.timeout(15e3)]));
			if (check.ok) verifiedAuth = withVerifiedIdentity(auth, check.user);
			return {
				ok: !!check.ok,
				...check.error ? { error: check.error } : {}
			};
		},
		commit: async (token, verified) => {
			const auth = verified && verifiedAuth ? verifiedAuth : buildAuth(buffer, token, true);
			await finish(auth, verified);
		},
		onCaptured: () => {
			progress.captured = progressFrom(buffer);
		},
		onError: (message) => {
			progress = {
				...progress,
				lastError: message
			};
		},
		logger
	});
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
			const commit = commitCapturedAuth(withVerifiedIdentity(auth, check.user));
			const tail = commit.mode === "add" ? "（已加入账号库，当前账号未改动）" : "";
			lastResult = {
				ok: true,
				message: "已从已登录窗口恢复凭证（校验通过）" + tail,
				at: (/* @__PURE__ */ new Date()).toISOString()
			};
			logger?.info?.(`deepseek-web login: recovered credentials from partition (verified, mode=${commit.mode})`);
			return {
				ok: true,
				verified: true,
				message: "已从已登录窗口恢复凭证（校验通过）" + tail
			};
		}
	}
	const fallback = commitCapturedAuth(buildAuth(buffer, candidates[0], true));
	const tail = fallback.mode === "add" ? "（已加入账号库，当前账号未改动）" : "";
	lastResult = {
		ok: true,
		message: "已从已登录窗口恢复凭证（未通过服务端校验）" + tail,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	logger?.info?.(`deepseek-web login: recovered credentials from partition (unverified, mode=${fallback.mode})`);
	return {
		ok: true,
		verified: false,
		message: "已恢复凭证，但服务端校验未通过（可用「发送测试」验证）" + tail
	};
}
/** 手动粘贴 token 登录（非 Electron 环境 / 用户偏好）。 */
async function loginWithToken(token, cookie, logger) {
	const raw = String(token ?? "").trim();
	if (raw.startsWith("{") && !unwrapStoredToken(token)) return {
		ok: false,
		error: "粘贴的内容像 localStorage 包装 JSON，但解不出 token（value 为空或已损坏）——请只复制其中的字符串值，或直接粘贴裸 token"
	};
	const trimmed = unwrapStoredToken(token) || raw;
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
		commitCapturedAuth({
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
	commitCapturedAuth(withVerifiedIdentity(auth, check.user));
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
/**
* 登录前清掉「登录态存放处」—— 独立 profile 目录 + Electron 登录分区。
*
* 只有**明确需要从零开始**的入口才该调它：
*  - 「登录新账号（添加）」：不清的话新窗口一打开就是旧账号，抓回来还是它（等于没加）；
*  - 「用浏览器登录」主按钮：登录前按 `fresh: true` 请求清理；
*  - 「退出并登录其它账号」：走 `logout()`，那边已清。
*
* ⚠️ **「重登」有意不清** —— 留着登录态才可能一打开就复用、一个密码都不用敲
* （见 `beginRelogin` 那条路由的日志）。所以这里是"按需清理"，不是路由的默认行为。
*
* 拆成函数是为了能单测：删目录这种事，值得有一条用例盯着它真的删掉了。
*/
async function clearLoginState(options = {}) {
	return {
		profileCleared: clearBrowserLoginProfile(options.profileDir),
		partitionCleared: await clearLoginPartition().catch(() => false)
	};
}
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
	const partitionOK = await clearLoginPartition().catch(() => false) || !electronAvailable();
	const cleared = browserProfileCleared && partitionOK;
	lastResult = {
		ok: true,
		message: cleared ? "已退出登录：本地凭证与浏览器登录态都已清除" : !browserProfileCleared ? "已退出登录：本地凭证已清除，但**浏览器登录态未清掉**（浏览器窗口还开着或进程残留）——下次「浏览器窗口登录」会直接复用旧登录态，相当于没退出；请关掉浏览器后重试" : "已退出登录：本地凭证已清除（浏览器分区清理失败，登录窗口可能仍是旧账号，请手动退出网页端）",
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	return cleared;
}
const TRANSPORT_HINT = "Chromium 网络栈会跟随「系统代理」（Node 则完全无视代理）。若梯子关闭时系统代理仍指向 127.0.0.1:7897，切到 Chromium 后请求会失败 —— 这时切回 Node 即可。";
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
			if (transportBefore === "injected") setFetchImpl(netFetch);
			else setFetchImpl();
			const now = fetchImplKind();
			results.push({
				step: "传输层已还原",
				ok: now === transportBefore,
				was: transportBefore,
				now,
				...now === transportBefore ? {} : { error: "还原后与诊断前不一致，请重启 DSH" }
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
/** 单日文件软上限：超过就不再追加（避免异常情况下把磁盘写爆）。 */
const DAY_FILE_SOFT_LIMIT_BYTES$1 = 2097152;
function ledgerDir() {
	return join(webLoginDir(), "ledger");
}
function dayFile$1(at) {
	const date = new Date(at);
	const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	return join(ledgerDir(), `${stamp}.jsonl`);
}
function listDayFiles$1() {
	try {
		return readdirSync(ledgerDir()).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
	} catch {
		return [];
	}
}
/**
* 追加一条。**永不抛错** —— 台账是旁路设施，绝不能因为它写失败而影响调用。
*/
function noteCall(entry) {
	try {
		const file = dayFile$1(entry.at);
		mkdirSync(join(file, ".."), { recursive: true });
		try {
			if (statSync(file).size > DAY_FILE_SOFT_LIMIT_BYTES$1) return;
		} catch {}
		appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {}
}
/** 删除超过保留期的台账文件（插件自己的数据，按天滚动清理）。 */
function pruneLedger(keepDays = 7) {
	const cutoff = Date.now() - keepDays * 864e5;
	let removed = 0;
	for (const name of listDayFiles$1()) {
		const stamp = name.replace(/\.jsonl$/, "");
		const at = Date.parse(`${stamp}T00:00:00`);
		if (!Number.isFinite(at) || at >= cutoff) continue;
		try {
			rmSync(join(ledgerDir(), name), { force: true });
			removed += 1;
		} catch {}
	}
	return removed;
}
function readEntries$1(sinceMs) {
	const out = [];
	for (const name of listDayFiles$1()) {
		const stamp = name.replace(/\.jsonl$/, "");
		const dayEnd = Date.parse(`${stamp}T23:59:59.999`);
		if (Number.isFinite(dayEnd) && dayEnd < sinceMs) continue;
		let text = "";
		try {
			text = readFileSync(join(ledgerDir(), name), "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const parsed = JSON.parse(line);
				if (Number.isFinite(parsed?.at) && parsed.at >= sinceMs) out.push(parsed);
			} catch {}
		}
	}
	out.sort((a, b) => a.at - b.at);
	return out;
}
/** 失败分类：把语义错误码翻成"人话"，同类合并。 */
function failureBucket(entry) {
	if (entry.muted) return "账号被限制";
	if (entry.throttled) return "限流（发太频繁）";
	if (entry.code === "RATE_LIMIT") return "限流（未分类）";
	if (entry.code === "AUTH" || entry.code === "MISSING_CREDENTIAL") return "登录态问题";
	if (entry.code === "TRANSPORT" || entry.code === "TIMEOUT") return "网络 / 超时";
	if (entry.code === "CONTEXT_WINDOW_EXCEEDED") return "上下文超限";
	if (entry.code === "ABORTED") return "被取消";
	return entry.code ? `其它（${entry.code}）` : "其它";
}
function percentile(sorted, ratio) {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
}
/**
* 汇总最近 `hours` 小时。
*
* `hours` 会先**取整并夹到 1–72**：以前直接把入参喂给 `new Array(hours)`，而路由只 clamp
* 没取整 → `?hours=1.5` 直接 `RangeError`（已复现）。
*
* 间隔只统计**对话类**调用（`purpose === 'chat'`），并且**按账号分组**：
*  - 跨账号算间隔没有意义（两个号的节奏互不相干，混在一起只会把分布拉平）；
*  - `at` 是**结束**时刻，所以"这次等了多久" = `本次开始 − 上次结束`（`at - ms` 即本次开始）。
*    直接拿相邻 `at` 相减，会把上一轮的生成耗时算进"等待"里；
*  - **失败的调用同样计入**：失败也占用了等待窗口，跳过它们只会把间隔拉大。
*
* 负数保留（表示可能与上一轮重叠，例如被抢占后重发）。要毫秒级精确就得新增显式
* `startedAt` 字段，而不是从 `ms` 反推 —— 旧台账只能按现在的算法近似。
*/
function summarizeLedger(input = 24) {
	const hours = Number.isFinite(input) ? Math.min(72, Math.max(1, Math.floor(input))) : 24;
	const now = Date.now();
	const entries = readEntries$1(now - hours * 36e5).filter((entry) => entry.at <= now && Number.isFinite(entry.ms) && entry.ms >= 0);
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
	for (const name of listDayFiles$1()) {
		files += 1;
		try {
			bytes += statSync(join(ledgerDir(), name)).size;
		} catch {}
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
			p50: percentile(gaps, .5),
			p90: percentile(gaps, .9),
			max: gaps[gaps.length - 1]
		} : null,
		hourly,
		footprint: {
			files,
			bytes
		},
		byAccount: Array.from(groups.entries()).map(([accountId, list]) => ({
			accountId,
			calls: list.length,
			succeeded: list.filter((entry) => entry.ok).length,
			failed: list.filter((entry) => !entry.ok).length
		}))
	};
}
/** 单日文件软上限：超过就不再追加（异常情况下别把磁盘写爆）。 */
const DAY_FILE_SOFT_LIMIT_BYTES = 2097152;
/**
* 把适配器的一次上报整理成一条记录。宿主 `recordCallOutcome` 直接调它。
*
* 抽成纯函数是因为**它是唯一一段"没人守"的胶水**：适配器那边有用例（noteCall 收到了 token）、
* 存储这边也有（noteUsage 读得回来），中间这几行一旦写错（比如把 `server` 恒写成 true，
* 界面就会把估算值说成服务端口径）没有任何断言会响。
*/
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
		...info.tokens ? { server: info.tokens.serverTotal === true } : {}
	};
}
function usageDir() {
	return join(webLoginDir(), "usage");
}
/** 本地时区的 `YYYY-MM-DD`。**不能用 toISOString**（那是 UTC，晚上 8 点后会把日期算到明天）。 */
function localDateKey(at) {
	const date = new Date(at);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dayFile(at) {
	return join(usageDir(), `${localDateKey(at)}.jsonl`);
}
function listDayFiles() {
	try {
		return readdirSync(usageDir()).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
	} catch {
		return [];
	}
}
/**
* 追加一条。**永不抛错** —— 用量是旁路设施，绝不能因为它写失败而影响调用。
*/
function noteUsage(entry) {
	try {
		const file = dayFile(entry.at);
		mkdirSync(usageDir(), { recursive: true });
		try {
			if (statSync(file).size > DAY_FILE_SOFT_LIMIT_BYTES) return;
		} catch {}
		appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {}
}
/** 删除超过保留期的文件（插件自己的数据，按天滚动清理）。 */
function pruneUsage(keepDays = 90) {
	const cutoff = Date.now() - keepDays * 864e5;
	let removed = 0;
	for (const name of listDayFiles()) {
		const stamp = name.replace(/\.jsonl$/, "");
		const at = Date.parse(`${stamp}T00:00:00`);
		if (!Number.isFinite(at) || at >= cutoff) continue;
		try {
			rmSync(join(usageDir(), name), { force: true });
			removed += 1;
		} catch {}
	}
	return removed;
}
/** 规整天数参数：非数 → 默认 30；越界 → 夹到 0~USAGE_MAX_DAYS；**必须取整**。 */
function clampUsageDays(value, fallback = 30) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.min(90, Math.floor(n)));
}
function readEntries(sinceMs) {
	const out = [];
	for (const name of listDayFiles()) {
		const stamp = name.replace(/\.jsonl$/, "");
		const dayEnd = Date.parse(`${stamp}T23:59:59.999`);
		if (Number.isFinite(dayEnd) && dayEnd < sinceMs) continue;
		let text = "";
		try {
			text = readFileSync(join(usageDir(), name), "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const parsed = JSON.parse(line);
				if (Number.isFinite(parsed?.at) && parsed.at >= sinceMs) out.push(parsed);
			} catch {}
		}
	}
	out.sort((a, b) => a.at - b.at);
	return out;
}
function emptyDay(date) {
	return {
		date,
		calls: 0,
		ok: 0,
		in: 0,
		out: 0,
		serverCalls: 0
	};
}
function bumpGroup(map, key, entry) {
	const item = map.get(key) ?? {
		key,
		calls: 0,
		in: 0,
		out: 0
	};
	item.calls += 1;
	item.in += entry.in;
	item.out += entry.out;
	map.set(key, item);
}
/** 分组结果按 token 总量降序（界面直接照顺序画横条，不用再排）。 */
function sortedGroups(map) {
	return Array.from(map.values()).sort((a, b) => b.in + b.out - (a.in + a.out) || b.calls - a.calls);
}
/**
* 纯聚合：喂条目数组出汇总。**刻意不碰 fs** —— 这样用例可以直接喂字面量测边界
* （空数据、跨天、只有失败、没有服务端口径…），不用造临时目录。
*
* `days` = 0 表示"全部（受保留期约束）"；否则从"今天"往前数 `days` 天，
* **并把没有调用的日子补齐成 0**（趋势图需要等距时间轴）。
*
* 🔴 **只聚合落在时间轴内的条目**：窗口外的条目直接丢掉，而不是只从柱子里漏掉。
* 否则「总计」和图上画出来的会不一致 —— 那种"数字对不上"的现象最难排查。
*/
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
		bumpGroup(byModel, entry.model || "(未标注)", entry);
		bumpGroup(byAccount, entry.accountId ?? "(未知账号)", entry);
		bumpGroup(byPurpose, entry.purpose, entry);
	}
	const series = [];
	const startNoon = Date.parse(`${axisStart}T12:00:00`);
	const endNoon = Date.parse(`${axisEnd}T12:00:00`);
	const steps = Math.max(0, Math.min(91, Math.round((endNoon - startNoon) / DAY)));
	for (let i = 0; i <= steps; i++) {
		const key = localDateKey(startNoon + i * DAY);
		series.push(byDate.get(key) ?? emptyDay(key));
	}
	let files = 0;
	let bytes = 0;
	for (const name of listDayFiles()) {
		files += 1;
		try {
			bytes += statSync(join(usageDir(), name)).size;
		} catch {}
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
		coverage: {
			from,
			to,
			files,
			bytes
		}
	};
}
/** 读盘 + 聚合。入参可以是查询串里拿到的字符串（路由直接透传 URL 参数，别在调用处各转一次）。 */
function summarizeUsage(input = 30) {
	const days = clampUsageDays(input);
	const now = Date.now();
	return aggregateUsage(readEntries(days > 0 ? (/* @__PURE__ */ new Date(now - (days - 1) * 864e5)).setHours(0, 0, 0, 0) : 0), {
		days,
		now
	});
}
/** 目录是否存在（界面用来区分"还没跑过"与"跑了但没数据"）。 */
function usageExists() {
	try {
		return existsSync(usageDir());
	} catch {
		return false;
	}
}
//#endregion
//#region src/update-check.ts
/**
* 检查更新 —— 比对自身版本与 GitHub Releases 的 latest。
*
* 借鉴 workbuddy-switch 的「自动更新」。它是 Tauri 桌面 App，能签名校验后**整包升级**；
* 我们是 DSH 插件，**装不了包**，所以只做"检查 + 告诉你 + 给链接"这一段。
*
* ⚠️ 三个必须守住的点：
*  1. **短超时 + 优雅失败**：GitHub API 在国内常常连不上（或要走代理）。
*     查更新失败绝不能把设置页卡住或让它报错 —— 失败就如实说"没查到"。
*  2. **走当前传输层**：用插件自己的 fetch（默认 Chromium 网络栈），
*     这样"系统代理开着"时也能跟着走，和网页端请求的环境一致。
*  3. **只读**：只 GET 一个 releases 接口，不带任何凭证。
*/
/** 仓库地址（发布源）。 */
const RELEASE_REPO = "cv-superding/dsh-deepseek-web-login";
/** 把 `v1.2.3` / `1.2.3-beta.1` 解析成可比较的数字数组（只取前三段数字）。 */
function parseVersion(input) {
	const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(input ?? "").trim());
	if (!match) return void 0;
	return [
		Number(match[1]),
		Number(match[2]),
		Number(match[3])
	];
}
/** a 是否严格大于 b（无法解析时返回 false —— 宁可说"没有更新"）。 */
function isNewer(a, b) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return false;
	for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i];
	return false;
}
/**
* 查一次最新版本。
*
* @param current 当前版本
* @param fetchImpl 注入的 fetch（默认由宿主传入当前传输层）
*/
async function checkForUpdate(current, fetchImpl) {
	const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
	const base = {
		ok: false,
		current,
		hasUpdate: false,
		checkedAt
	};
	try {
		const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": `${RELEASE_REPO}-plugin`
			},
			signal: AbortSignal.timeout(8e3)
		});
		if (!response.ok) return {
			...base,
			error: `GitHub 返回 HTTP ${response.status}${response.status === 403 ? "（可能是接口限流，稍后再试）" : ""}`
		};
		const payload = await response.json();
		const latest = String(payload?.tag_name ?? "").replace(/^v/, "");
		if (!latest) return {
			...base,
			error: "Release 数据里没有版本号"
		};
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
		const message = error?.name === "TimeoutError" || /timeout|aborted/i.test(String(error?.message)) ? "连接 GitHub 超时（国内常见；梯子开着的话它会跟随系统代理）" : `连接 GitHub 失败：${error?.message ?? error}`;
		return {
			...base,
			error: message
		};
	}
}
//#endregion
//#region src/version.ts
/**
* 本插件版本号 —— 单一事实来源是 `package.json`，这里做一层运行时读取 + 兜底常量。
*
* 为什么要兜底常量：`package.json` 相对 `lib/index.js` 在上一级目录，
* 正常安装（作为 npm 包）一定在；但 bunder/注入式装配不一定。
* 兜底常量与 package.json 的一致性由 `tests/check-smoke.mjs` 守着，不会漂。
*/
/** 与 package.json 保持一致的兜底版本（由测试保证不会漂）。 */
const FALLBACK_VERSION = "0.4.1";
let cached;
/** 本插件版本（如 `0.1.26`）。 */
function pluginVersion() {
	if (cached) return cached;
	try {
		const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed?.version === "string" && parsed.version) {
			cached = parsed.version;
			return cached;
		}
	} catch {}
	cached = FALLBACK_VERSION;
	return cached;
}
/** `~/.dsh/web-login/sessions-in-use.json`（与 gate.json / 账号库同目录）。 */
function sessionJournalPath() {
	return join(webLoginDir(), "sessions-in-use.json");
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
/**
* 读日志。文件不存在 / 损坏 / 结构不对一律当作**空**（绝不因此让插件启动失败）；
* 单条坏记录被丢掉，其余照常可用。
*/
function readJournal(file = sessionJournalPath()) {
	try {
		if (!existsSync(file)) return [];
		const parsed = JSON.parse(readFileSync(file, "utf8"));
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
/** 原子写：先写同目录临时文件再 rename，避免中途被杀留下半截 JSON。 */
function writeJournal(entries, file = sessionJournalPath()) {
	const dir = dirname(file);
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	} catch {}
	const payload = `${JSON.stringify({
		version: 1,
		entries
	}, null, 2)}\n`;
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		writeFileSync(tmp, payload, {
			encoding: "utf8",
			mode: 384
		});
		try {
			renameSync(tmp, file);
		} catch {
			writeFileSync(file, payload, {
				encoding: "utf8",
				mode: 384
			});
			try {
				unlinkSync(tmp);
			} catch {}
		}
	} catch {}
}
/** 记一条（同一 sessionId 覆盖）。 */
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
/** 确认删掉 → 摘掉这条。 */
function removeJournalEntry(sessionId, file = sessionJournalPath()) {
	const entries = readJournal(file);
	const kept = entries.filter((item) => item.sessionId !== sessionId);
	if (kept.length === entries.length) return;
	writeJournal(kept, file);
}
/** 进程是否还活着（判断"写记录的那个进程走了没有"）。 */
function isProcessAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
/**
* 纯决策：每一条记录该怎么办。**不碰磁盘、不发请求**，可离线测。
*
* 判定顺序有意如此：
*   ① 进程还活着 → 保留（多实例共用同一个 DSH_HOME 时，别删另一个实例正在用的会话）；
*   ② 用户不允许删（`keep` / `deleteWebSessions: false`）→ 保留，等以后允许了再扫；
*   ③ 账号已被移除 → 放弃（没凭证，留着也删不掉）；
*   ④ 其余 → 补删。
*/
function planStartupSweep(entries, options) {
	const isAlive = options.isAlive ?? isProcessAlive;
	const plan = {
		toDelete: [],
		dropped: [],
		kept: []
	};
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
/**
* 启动扫尾：读日志 → 决策 → 对每条该补删的调用 `onSweep`（由调用方排进清理器，
* 那里才有账号凭证与节流）。
*
* **不在这里清记录**：记录要留到"确认删掉"（`removeJournalEntry` 由删除回执触发）。
* 这样即使本次删除失败、或者进程又在中途被杀，下次启动还能再补。
* 唯一会立刻移除的是 `dropped`（账号没了，永远删不掉）。
*/
function runStartupSweep(options) {
	const file = options.file ?? sessionJournalPath();
	const entries = readJournal(file);
	if (entries.length === 0) return {
		scheduled: 0,
		dropped: 0,
		kept: 0
	};
	const plan = planStartupSweep(entries, options);
	let scheduled = 0;
	for (const entry of plan.toDelete) try {
		options.onSweep(entry);
		scheduled += 1;
	} catch {
		plan.kept.push(entry);
	}
	if (plan.dropped.length > 0) writeJournal(plan.kept, file);
	if (scheduled > 0) options.log?.(`deepseek-web: 上次退出遗留了 ${scheduled} 个临时会话，已交给清理器补删`);
	if (plan.dropped.length > 0) options.log?.(`deepseek-web: ${plan.dropped.length} 个遗留会话的账号已不在账号库里，无法回收（已从记录移除）`);
	return {
		scheduled,
		dropped: plan.dropped.length,
		kept: plan.kept.length
	};
}
//#endregion
//#region src/account-groups.ts
/**
* 账号分组：组定义落盘 + 列表按组分区。
*
* ── 为什么要单独一个文件，而不是把组名写进每条账号记录 ──
*
* 1. 组要能**改名** —— 写进账号记录的话，改一次要遍历所有账号文件；
* 2. 组要能**排序** —— 否则"组之间"照样乱（这次要解决的正是"顺序不受控"）；
* 3. 账号记录里只留一个 `groupId` 指针 ⇒ 删组不会留下散落的组名，也不会误删账号。
*
* 因此分工是：`groups.json` 存**组的定义**（id / name / order），
* 账号记录里只存 `groupId`。**组不存在（被删了）或没设组的账号 ⇒ 一律归入「未分组」**，
* 一个都不会从列表里消失。
*
* 纯函数（normalizeGroupList / createGroup / renameGroup / removeGroup / partitionByGroup）
* 不碰磁盘，便于单测；读写只有 readGroups / writeGroups 两个口子。
*
* ⚠️ 分组的定位是**只影响显示**：切号、会话复用槽、会话清理一律不感知组。
* 让分组参与调度会把"插件什么时候建会话/删会话"变得难以预测，收益却很小。
*/
/** 未分组的伪组 key（不会与真实组 id 冲突：真实 id 一律以 `g_` 开头）。 */
const UNGROUPED_KEY = "__ungrouped__";
const UNGROUPED_NAME = "未分组";
function groupsFilePath() {
	return join(webLoginDir(), "groups.json");
}
/**
* 规整组名：去首尾空白、把连续空白折成一个空格、去掉换行与控制字符、截断到上限。
*
* 为什么要去掉换行：组名会进 `title` / `option` 这类文本节点，带换行的名字在界面上会撑破一行，
* 而且用户从别处粘贴时很容易把换行一起带进来。
*/
function normalizeGroupName(raw) {
	if (typeof raw !== "string") return "";
	return raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
}
/**
* 读盘容错：只收形状正确的条目，丢掉的坏数据**不会**让整个分组表读不出来。
*
* 与账号记录的姿态一致（那边也是"形状不对的条目丢掉、不让整条记录失败"）：
* 分组只是展示辅助，宁可少显示一个组，也不要因为一条脏数据让面板报错。
* 读回后按 order 重排（顺序值可能是手改过的、重复的、非整数的）。
*/
function normalizeGroupList(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const id = typeof item.id === "string" ? item.id.trim() : "";
		const name = normalizeGroupName(item.name);
		if (!id || !name || seen.has(id)) continue;
		const orderRaw = item.order;
		const order = Number.isFinite(orderRaw) ? Number(orderRaw) : out.length;
		seen.add(id);
		out.push({
			id,
			name,
			order
		});
	}
	out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
	return out.slice(0, 12).map((group, index) => ({
		...group,
		order: index
	}));
}
function readGroups() {
	try {
		const file = groupsFilePath();
		if (!existsSync(file)) return [];
		return normalizeGroupList(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return [];
	}
}
function writeGroups(list) {
	const file = groupsFilePath();
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(normalizeGroupList(list), null, 2), {
		encoding: "utf8",
		mode: 384
	});
	try {
		renameSync(tmp, file);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {}
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
/**
* 新建组。名字为空 / 重名 / 超过组数上限时返回 `error`（不改动 `list`）。
*
* 重名判定用**规整后的名字**：`" 工作 "` 与 `"工作"` 算同一个，免得界面上出现两个看起来一样的组。
*/
function createGroup(list, rawName) {
	const current = normalizeGroupList(list);
	const name = normalizeGroupName(rawName);
	if (!name) return {
		list: current,
		error: "组名不能为空"
	};
	if (current.length >= 12) return {
		list: current,
		error: `最多 12 个组`
	};
	if (current.some((group) => group.name === name)) return {
		list: current,
		error: `已经有一个叫「${name}」的组了`
	};
	const group = {
		id: newGroupId(current.map((item) => item.id)),
		name,
		order: current.length
	};
	return {
		list: [...current, group],
		group
	};
}
function renameGroup(list, id, rawName) {
	const current = normalizeGroupList(list);
	const name = normalizeGroupName(rawName);
	if (!name) return {
		list: current,
		error: "组名不能为空"
	};
	if (!current.some((group) => group.id === id)) return {
		list: current,
		error: "组不存在"
	};
	if (current.some((group) => group.id !== id && group.name === name)) return {
		list: current,
		error: `已经有一个叫「${name}」的组了`
	};
	return { list: current.map((group) => group.id === id ? {
		...group,
		name
	} : group) };
}
/**
* 删除组定义。
*
* ⚠️ **只删组、不删账号**：账号记录里的 `groupId` 会变成一个"指向不存在组"的悬挂指针，
* 而 `partitionByGroup` 对这种情况的处理就是把它归入「未分组」——
* 所以调用方不需要（也不应该）去逐个改账号文件。
*/
function removeGroup(list, id) {
	return normalizeGroupList(list).filter((group) => group.id !== id).map((group, index) => ({
		...group,
		order: index
	}));
}
/**
* 把账号切成「按组分区」的若干段，供面板直接渲染。
*
* 排序规则（用户 2026-09-16 明确要的）：
*  1. **当前账号所在的组置顶** —— 常用号不因为新加账号而沉下去；
*  2. 其余组按 `order`；
*  3. **未分组垫底**（含 `groupId` 指向已删除组的账号）。
*
* 组内顺序**保持传入顺序**（`listAccounts()` 已按捕获时间倒序），不再排序 ——
* 组的意义是"分类"，组内再按捕获时间排就是用户熟悉的既有行为。
*
* 空组**照样返回**：新建完组要能立刻看见它，否则"建了组却没反应"。
* 未分组为空时**不返回**（没意义的一行）。
*/
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
	for (const group of ordered) sections.push({
		key: group.id,
		name: group.name,
		groupId: group.id,
		accounts: buckets.get(group.id) ?? []
	});
	if (ungrouped.length) sections.push({
		key: UNGROUPED_KEY,
		name: UNGROUPED_NAME,
		groupId: null,
		accounts: ungrouped
	});
	return sections;
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
/** 账号备份导入的大小上限 —— 与前端 `IMPORT_FILE_LIMIT_BYTES` 保持一致（实测单账号
*  ~1.7 KB、账号数上限 500 → ~850 KB，取 2 MiB 留 2 倍余量）。 */
const IMPORT_FILE_LIMIT_BYTES = 2097152;
const API_PREFIX = "/deepseek-web-login/api";
function normalizeLogger(logger) {
	if (!logger) return {};
	return {
		info: typeof logger.info === "function" ? (message) => logger.info(message) : void 0,
		warn: typeof logger.warn === "function" ? (message) => logger.warn(message) : void 0,
		debug: typeof logger.debug === "function" ? (message) => logger.debug(message) : void 0
	};
}
/**
* 读取并解析 JSON 请求体。
*
* ⚠️ 审计 F16 修的三件事：
*  - **生命周期**：客户端只触发 `close`/`aborted`（不发 `end`/`error`）时，旧实现会**永不结算**，
*    那个 Promise 连同它的监听器一起挂着；现在把 close/aborted 也当"结束"，并且**每种结局都清监听**。
*  - **应用层超时**：慢速上传没有 deadline，一个连接可以永远占着；现在 10 秒截止。
*  - **结构化错误**：超限旧实现是 `destroy()` 后 resolve(undefined)，调用方只能报"缺少 payload"，
*    客户端更可能只看到断连。现在抛带状态码的 BodyError，由 handler 统一回 413/400/408。
*/
var BodyError = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.status = status;
	}
};
async function readJsonBody(req, limitBytes = 262144) {
	return await new Promise((resolve, reject) => {
		let size = 0;
		let settled = false;
		const chunks = [];
		const cleanup = () => {
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
			cleanup();
			if (error) {
				try {
					req.resume?.();
				} catch {}
				reject(error);
			} else resolve(value);
		};
		const onData = (chunk) => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.byteLength;
			if (size > limitBytes) {
				done(new BodyError(413, `请求体过大（上限 ${Math.floor(limitBytes / 1024)} KiB）`));
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
				done(new BodyError(400, "请求体不是合法 JSON"));
			}
		};
		const onError = () => done(new BodyError(400, "读取请求体失败"));
		const onAborted = () => done(new BodyError(400, "请求已中止"));
		const onClose = () => {
			if (!req.complete) onAborted();
		};
		const timer = setTimeout(() => done(new BodyError(408, "读取请求体超时")), 1e4);
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("aborted", onAborted);
		req.on("close", onClose);
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
/** `/accounts/refresh` 的互斥：手动刷新是串行探活，狂点按钮不该叠起来打。 */
let accountsRefreshInFlight = false;
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
	const cleanupMode = savedGate?.sessionCleanup ?? config.sessionCleanup ?? DEFAULT_SESSION_CLEANUP.mode;
	const cleanupBatchRange = savedGate?.cleanupBatch ?? DEFAULT_CLEANUP_BATCH;
	const cleanupDelayRange = savedGate?.cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS;
	const cleanupGapRange = savedGate?.cleanupGapMs ?? DEFAULT_CLEANUP_GAP_MS;
	const gate = createRequestGate({
		allowConcurrent: savedGate?.allowConcurrent ?? config.allowConcurrent === true,
		minIntervalMs: savedGate?.minRequestIntervalMs ?? config.minRequestIntervalMs ?? 2e3,
		maxIntervalMs: savedGate?.maxRequestIntervalMs ?? config.maxRequestIntervalMs ?? 4e3,
		longRunThreshold: savedGate?.longRunThreshold ?? 15,
		maxPromptChars: savedGate?.maxPromptChars ?? config.maxPromptChars ?? 4e5,
		maxRefImages: savedGate?.maxRefImages ?? config.maxRefImages ?? 24,
		contextWindow: savedGate?.contextWindow ?? 1048576,
		autoSwitchMinutes: savedGate?.autoSwitchMinutes ?? 0,
		longRunBreakMs: savedGate?.longRunBreakMs,
		sessionCleanup: cleanupMode,
		cleanupBatch: cleanupBatchRange,
		cleanupDelayMs: cleanupDelayRange,
		cleanupGapMs: cleanupGapRange,
		logger
	});
	const migratedAccount = migrateLegacyAuthIfNeeded();
	if (migratedAccount) logger.info?.(`deepseek-web: 已把旧的单账号凭证迁移进账号库（${migratedAccount.id}）`);
	else {
		const migrationError = legacyMigrationError();
		if (migrationError) logger.warn?.(`deepseek-web: ${migrationError}`);
	}
	let transportState = applyTransport(readTransportSetting() ?? (config.transport === "node" ? "node" : "chromium"));
	logger.info?.(`deepseek-web: 传输层=${transportState.effective}` + (transportState.degraded ? "（配置要求 Chromium，但本环境没有 electron.net.fetch，已降级为 Node）" : ""));
	let lastAutoSwitchAt = Date.now();
	let autoSwitching = false;
	/** 本轮探活失败过的账号 —— 不选它们，避免在同一个坏号上反复试。进程重启即清空。 */
	const autoSwitchSkip = /* @__PURE__ */ new Set();
	async function maybeAutoSwitch() {
		if (autoSwitching) return;
		const minutes = gate.settings().autoSwitchMinutes ?? 0;
		if (!Number.isFinite(minutes) || minutes <= 0) return;
		const accounts = listAccounts().filter((account) => !autoSwitchSkip.has(account.id));
		const decision = decideAutoSwitch({
			minutes,
			lastSwitchAt: lastAutoSwitchAt,
			now: Date.now(),
			accounts,
			currentId: activeAccountId()
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
				logger.warn?.(`deepseek-web: 自动切号跳过 ${decision.nextId}（探活未通过：${probed.error ?? "未知原因"}）`);
				return;
			}
			if (!setActiveAccount(decision.nextId)) return;
			lastAutoSwitchAt = Date.now();
			logger.info?.(`deepseek-web: 已自动切换账号到 ${decision.nextId}（每 ${minutes} 分钟轮换` + (decision.reason === "current-unusable" ? "；原账号不可用，提前切走" : "") + "）—— 换号会让投喂链断掉，下一轮会全量重发");
		} catch (error) {
			lastAutoSwitchAt = Date.now();
			logger.warn?.(`deepseek-web: 自动切换账号失败（不影响本次请求）：${error?.message ?? error}`);
		} finally {
			autoSwitching = false;
		}
	}
	/**
	* 「当前账号被限时，换个号还能不能接着干」—— 只决定失败该给长退避还是短退避。
	*
	* ⚠️ 只在用户**明确开了**自动换号（间隔 > 0）时才为真。默认关闭 ⇒ 保持原行为
	* （长退避 ⇒ 重试策略放弃），免得把一个没打算换号的用户悄悄换到别的账号上。
	*/
	const canFailover = () => {
		const minutes = gate.settings().autoSwitchMinutes ?? 0;
		if (!Number.isFinite(minutes) || minutes <= 0) return false;
		if (autoSwitching) return false;
		return pickNextAccount(listAccounts().filter((account) => !autoSwitchSkip.has(account.id)), activeAccountId(), Date.now()) !== void 0;
	};
	let contextMode = applyContextMode(readContextModeSetting() ?? (config.contextMode === "chained" ? "chained" : "full"));
	logger.info?.(`deepseek-web: 上下文投喂=${contextMode}` + (contextMode === "chained" ? "（只发增量 + parent 指向上一条回答）" : "（每轮重发全量 prompt）"));
	const adapterConfig = {
		maxPromptChars: savedGate?.maxPromptChars ?? config.maxPromptChars ?? 4e5,
		maxRefImages: savedGate?.maxRefImages ?? config.maxRefImages ?? 24,
		contextWindow: savedGate?.contextWindow ?? 1048576,
		idleTimeoutMs: config.idleTimeoutMs ?? 12e4,
		deleteWebSessions: config.deleteWebSessions !== false,
		sessionReuseTurns: config.sessionReuseTurns ?? 20,
		autoContinue: config.autoContinue !== false,
		maxContinuations: config.maxContinuations ?? 2,
		allowConcurrent: gate.settings().allowConcurrent,
		minRequestIntervalMs: gate.settings().minRequestIntervalMs,
		maxRequestIntervalMs: gate.settings().maxRequestIntervalMs,
		logger
	};
	const sessionCleaner = createSessionCleaner({
		policy: {
			mode: cleanupMode,
			delayMs: cleanupMode === "immediate" ? 1500 : config.sessionCleanupDelayMs ?? DEFAULT_SESSION_CLEANUP.delayMs,
			batchSize: cleanupMode === "immediate" ? 1 : config.sessionCleanupBatchSize ?? DEFAULT_SESSION_CLEANUP.batchSize,
			...cleanupMode === "immediate" ? {} : {
				batchRange: cleanupBatchRange,
				delayRange: cleanupDelayRange,
				gapRange: cleanupGapRange
			}
		},
		logger
	});
	const journalEnabled = adapterConfig.deleteWebSessions !== false && cleanupMode !== "keep";
	/** 会话所属账号 —— 删除必须用它自己的凭证（拿 A 的凭证删 B 的会话会被服务端拒，见 F07）。 */
	const accountIdOfAuth = (auth) => {
		const token = auth?.token;
		if (!token) return activeAccountId();
		return listAccounts().find((account) => account.token === token)?.id;
	};
	setSessionLifecycleHook((event) => {
		if (!journalEnabled) return;
		if (event.kind === "deleted") {
			removeJournalEntry(event.sessionId);
			return;
		}
		const accountId = accountIdOfAuth(event.auth);
		if (!accountId) return;
		upsertJournalEntry({
			accountId,
			sessionId: event.sessionId,
			state: event.kind === "queued" ? "queued" : "slot"
		});
	});
	if (journalEnabled) try {
		runStartupSweep({
			ownPid: process.pid,
			accountExists: (id) => readAccount(id) !== void 0,
			deleteEnabled: adapterConfig.deleteWebSessions !== false,
			mode: cleanupMode,
			onSweep: (entry) => {
				const account = readAccount(entry.accountId);
				if (!account) throw new Error("账号已不在账号库里");
				sessionCleaner.schedule(account, entry.sessionId);
			},
			log: (message) => logger.info?.(message)
		});
	} catch (error) {
		logger.warn?.(`deepseek-web: 启动补删失败（不影响使用）：${error?.message ?? error}`);
	}
	const getAuth = () => readAuth();
	try {
		const pruned = pruneLedger(7);
		if (pruned > 0) logger.info?.(`deepseek-web: 已清理 ${pruned} 个过期台账文件`);
	} catch {}
	try {
		const pruned = pruneUsage(90);
		if (pruned > 0) logger.info?.(`deepseek-web: 已清理 ${pruned} 个过期用量文件`);
	} catch {}
	/**
	* 每次模型调用的结果上报（adapter 的 noteCall 钩子）。做三件事：
	*
	*  1. **把"账号级限制"学到账号上**。这个状态只能在生成请求被拒时学到
	*     （受限期间 `users/current` 依然 200），所以必须在这里记；成功一次且已过解除时间就清掉。
	*  2. 写本地台账，供设置页看请求密度与失败分类（保留 7 天）。
	*  3. 写本地用量，供设置页的「Token 统计」页看长期趋势（保留 90 天）。
	*
	* 全程 try/catch：旁路设施绝不能影响调用本身。
	*/
	const recordCallOutcome = (info) => {
		try {
			const accountId = info.accountId ?? activeAccountId();
			const muted = Number.isFinite(info.mutedUntilMs);
			if (!info.ok && muted && accountId) {
				updateAccount(accountId, { limit: {
					untilMs: Number(info.mutedUntilMs),
					observedAt: (/* @__PURE__ */ new Date()).toISOString()
				} });
				logger.warn?.(`deepseek-web: 账号被临时限制，已记录解除时间 ${new Date(Number(info.mutedUntilMs)).toLocaleString()}`);
			}
			if (!info.ok && info.code === "AUTH" && accountId) {
				const record = listAccounts().find((item) => item.id === accountId);
				if (record) validateAuth(record, AbortSignal.timeout(2e4)).then((verdict) => {
					if (verdict.ok) {
						updateAccount(accountId, { lastVerifyError: void 0 });
						logger.info?.(`deepseek-web: 账号 ${accountId} 请求被判 AUTH，但只读探活通过 —— 按端点级误判处理，不标记失效（本轮仍按失败计，重发即可）`);
						return;
					}
					updateAccount(accountId, { lastVerifyError: {
						at: (/* @__PURE__ */ new Date()).toISOString(),
						message: String(info.message ?? "登录态无效，请重新登录")
					} });
					logger.warn?.(`deepseek-web: 账号 ${accountId} AUTH 复核确认失效（${verdict.error ?? "探活未通过"}），已标记为「需要重新登录」`);
				}).catch((error) => {
					logger.warn?.(`deepseek-web: 账号 ${accountId} AUTH 复核未完成（${String(error?.message ?? error)}），暂不标记`);
				});
			}
			if (info.ok && accountId) {
				const record = listAccounts().find((item) => item.id === accountId);
				if (record?.limit && Date.now() >= record.limit.untilMs) {
					updateAccount(accountId, { limit: void 0 });
					logger.info?.("deepseek-web: 账号级限制已解除，已清除本地的限制标记");
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
		} catch {}
	};
	const probeIntervalMs = config.probeIntervalMs ?? 18e5;
	ctx.effect(() => startProbeLoop({
		intervalMs: probeIntervalMs,
		getAuth: () => readAuth(),
		logger
	}));
	logger.info?.(probeIntervalMs > 0 ? `deepseek-web: 登录态探活已开启，每 ${Math.round(probeIntervalMs / 6e4)} 分钟一次（只读、零额度）` : "deepseek-web: 登录态探活已关闭（probeIntervalMs=0）");
	const adapter = createAdapter({
		getAuth,
		noteCall: recordCallOutcome,
		currentAccountId: activeAccountId,
		gate,
		maybeAutoSwitch,
		canFailover,
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
						maxPromptCharsBounds: MAX_PROMPT_CHARS_BOUNDS,
						maxPromptCharsDefault: DEFAULT_MAX_PROMPT_CHARS,
						maxRefImagesBounds: MAX_REF_IMAGES_BOUNDS,
						maxRefImagesDefault: 24,
						contextWindowBounds: CONTEXT_WINDOW_BOUNDS,
						contextWindowDefault: DEFAULT_CONTEXT_WINDOW,
						contextWindowOptions: CONTEXT_WINDOW_OPTIONS,
						autoSwitchBounds: AUTO_SWITCH_BOUNDS,
						autoSwitchDefault: 0,
						cleanup: sessionCleaner.policy(),
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
					if (body.maxPromptChars !== void 0) {
						const chars = Number(body.maxPromptChars);
						if (!Number.isFinite(chars)) {
							sendJson(res, 400, {
								ok: false,
								error: "maxPromptChars 必须是数字"
							});
							return;
						}
						const clamped = clampMaxPromptChars(chars);
						if (clamped !== chars) logger.warn?.(`deepseek-web: maxPromptChars ${chars} 越界，夹到 ${clamped}`);
						patch.maxPromptChars = clamped;
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
					for (const [field, bounds] of [
						["cleanupBatch", CLEANUP_BATCH_BOUNDS],
						["cleanupDelayMs", CLEANUP_DELAY_BOUNDS_MS],
						["cleanupGapMs", CLEANUP_GAP_BOUNDS_MS]
					]) {
						if (body[field] === void 0) continue;
						const range = normalizeCleanupRange(body[field], bounds);
						if (!range) {
							sendJson(res, 400, {
								ok: false,
								error: `${field} 需要 { min, max } 两个数字`
							});
							return;
						}
						patch[field] = range;
					}
					if (body.maxRefImages !== void 0) {
						const count = Number(body.maxRefImages);
						if (!Number.isFinite(count)) {
							sendJson(res, 400, {
								ok: false,
								error: "maxRefImages 必须是数字"
							});
							return;
						}
						patch.maxRefImages = clampMaxRefImages(count);
					}
					if (body.contextWindow !== void 0) {
						const window = Number(body.contextWindow);
						if (!Number.isFinite(window)) {
							sendJson(res, 400, {
								ok: false,
								error: "contextWindow 必须是数字"
							});
							return;
						}
						patch.contextWindow = clampContextWindow(window);
					}
					if (body.autoSwitchMinutes !== void 0) {
						const minutes = Number(body.autoSwitchMinutes);
						if (!Number.isFinite(minutes)) {
							sendJson(res, 400, {
								ok: false,
								error: "autoSwitchMinutes 必须是数字"
							});
							return;
						}
						patch.autoSwitchMinutes = clampAutoSwitchMinutes(minutes);
					}
					if (Object.keys(patch).length === 0) {
						sendJson(res, 400, {
							ok: false,
							error: "没有可更新的字段"
						});
						return;
					}
					const applied = gate.configure(patch);
					if (applied.maxPromptChars !== void 0) adapterConfig.maxPromptChars = applied.maxPromptChars;
					if (applied.maxRefImages !== void 0) adapterConfig.maxRefImages = applied.maxRefImages;
					if (applied.contextWindow !== void 0) adapterConfig.contextWindow = applied.contextWindow;
					if (patch.sessionCleanup) sessionCleaner.configure({ mode: patch.sessionCleanup });
					const rangePatch = {};
					if (patch.cleanupBatch) rangePatch.batchRange = patch.cleanupBatch;
					if (patch.cleanupDelayMs) rangePatch.delayRange = patch.cleanupDelayMs;
					if (patch.cleanupGapMs) rangePatch.gapRange = patch.cleanupGapMs;
					if (Object.keys(rangePatch).length > 0) sessionCleaner.configure(rangePatch);
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
						persisted: true,
						cleanup: sessionCleaner.policy()
					});
					return;
				}
				if (req.method === "GET" && route === "/ledger") {
					sendJson(res, 200, summarizeLedger(Math.min(72, Math.max(1, Number(url.searchParams.get("hours")) || 24))));
					return;
				}
				if (req.method === "GET" && route === "/usage") {
					const raw = url.searchParams.get("days");
					sendJson(res, 200, {
						...summarizeUsage(raw === null || raw === "" ? 30 : raw),
						keepDays: 90,
						dir: usageDir(),
						hasData: usageExists()
					});
					return;
				}
				if (req.method === "POST" && route === "/update-check") {
					sendJson(res, 200, {
						...await checkForUpdate(pluginVersion(), currentFetch),
						repo: RELEASE_REPO
					});
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
						capturedAt: record.capturedAt,
						lastVerifiedAt: record.lastVerifiedAt ?? null,
						lastVerifyError: record.lastVerifyError ?? null,
						limit: record.limit ?? null,
						cookieMeta: record.cookieMeta ?? [],
						isActive: record.id === activeId
					}));
					sendJson(res, 200, {
						activeId: activeId ?? null,
						groups,
						sections: partitionByGroup(accounts, groups, activeId),
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
						sendJson(res, 404, {
							ok: false,
							error: "账号不存在（可能已被移除）"
						});
						return;
					}
					const probed = await probeOnce(target, {
						info: (message) => logger.info?.(message),
						warn: (message) => logger.warn?.(message)
					});
					if (probed && !probed.ok) {
						sendJson(res, 200, {
							ok: false,
							needsRelogin: true,
							error: `该账号登录态校验未通过（${probed.error ?? "未知原因"}），请重新登录后再切换`
						});
						return;
					}
					if (!setActiveAccount(id)) {
						sendJson(res, 404, {
							ok: false,
							error: "账号不存在（可能已被移除）"
						});
						return;
					}
					logger.info?.(`deepseek-web: 当前账号已切换为 ${id}`);
					lastAutoSwitchAt = Date.now();
					sendJson(res, 200, {
						ok: true,
						activeId: id
					});
					return;
				}
				if (req.method === "POST" && route === "/accounts/rename") {
					const body = await readJsonBody(req);
					const id = String(body?.id ?? "");
					const label = String(body?.label ?? "").slice(0, 40);
					if (!updateAccount(id, { label })) {
						sendJson(res, 404, {
							ok: false,
							error: "账号不存在"
						});
						return;
					}
					sendJson(res, 200, {
						ok: true,
						id,
						label
					});
					return;
				}
				if (req.method === "POST" && route === "/accounts/remove") {
					const body = await readJsonBody(req);
					const id = String(body?.id ?? "");
					if (!removeAccount(id)) {
						sendJson(res, 404, {
							ok: false,
							error: "账号不存在"
						});
						return;
					}
					logger.info?.(`deepseek-web: 已从账号库移除 ${id}`);
					sendJson(res, 200, {
						ok: true,
						removed: id,
						activeId: activeAccountId() ?? null
					});
					return;
				}
				if (req.method === "POST" && route === "/accounts/group/create") {
					const body = await readJsonBody(req);
					const result = createGroup(readGroups(), body?.name);
					if (result.error || !result.group) {
						sendJson(res, 400, {
							ok: false,
							error: result.error ?? "创建失败"
						});
						return;
					}
					writeGroups(result.list);
					sendJson(res, 200, {
						ok: true,
						group: result.group,
						groups: result.list
					});
					return;
				}
				if (req.method === "POST" && route === "/accounts/group/rename") {
					const body = await readJsonBody(req);
					const result = renameGroup(readGroups(), String(body?.id ?? ""), body?.name);
					if (result.error) {
						sendJson(res, 400, {
							ok: false,
							error: result.error
						});
						return;
					}
					writeGroups(result.list);
					sendJson(res, 200, {
						ok: true,
						groups: result.list
					});
					return;
				}
				if (req.method === "POST" && route === "/accounts/group/delete") {
					const body = await readJsonBody(req);
					const id = String(body?.id ?? "");
					const next = removeGroup(readGroups(), id);
					writeGroups(next);
					logger.info?.(`deepseek-web: 已删除分组 ${id}（组内账号回到「未分组」，账号本身未动）`);
					sendJson(res, 200, {
						ok: true,
						groups: next
					});
					return;
				}
				if (req.method === "POST" && route === "/accounts/group/assign") {
					const body = await readJsonBody(req);
					const id = String(body?.id ?? "");
					const groupId = String(body?.groupId ?? "");
					if (groupId && !readGroups().some((group) => group.id === groupId)) {
						sendJson(res, 400, {
							ok: false,
							error: "分组不存在"
						});
						return;
					}
					if (!updateAccount(id, { groupId })) {
						sendJson(res, 404, {
							ok: false,
							error: "账号不存在"
						});
						return;
					}
					sendJson(res, 200, {
						ok: true,
						id,
						groupId
					});
					return;
				}
				/**
				* 手动刷新账号状态：对库里每个账号做一次**只读探活**（`users/current`，零额度），
				* 顺带把补上的显示名、清掉的失败标记写回记录（那是 probeOnce 自己干的）。
				*
				* 为什么需要它：自动探活 30 分钟才一次，而"我刚在浏览器里动过这个号，它现在到底还行不行"
				* 是随时会冒出来的问题 —— 以前只能等，或者切过去试（那要发一次生成请求，烧额度）。
				* 串行 + 互斥：单次探活虽轻，一口气并发 7 个也会像脚本；狂点按钮更不该叠起来打。
				*/
				if (req.method === "POST" && route === "/accounts/refresh") {
					if (accountsRefreshInFlight) {
						sendJson(res, 200, {
							ok: false,
							error: "正在刷新，请稍候"
						});
						return;
					}
					accountsRefreshInFlight = true;
					try {
						let passed = 0;
						let failed = 0;
						for (const account of listAccounts()) {
							const outcome = await probeOnce(account, {
								info: (message) => logger.info?.(message),
								warn: (message) => logger.warn?.(message)
							});
							if (outcome?.ok) passed += 1;
							else if (outcome) failed += 1;
						}
						logger.info?.(`deepseek-web: 手动刷新账号状态完成 —— 通过 ${passed}、失败 ${failed}`);
						sendJson(res, 200, {
							ok: true,
							checked: passed + failed,
							passed,
							failed
						});
					} finally {
						accountsRefreshInFlight = false;
					}
					return;
				}
				if (req.method === "POST" && route === "/accounts/export") {
					try {
						sendJson(res, 200, {
							ok: true,
							...exportAccountsToFile(),
							warning: "导出文件含可完整登录的凭证，请妥善保管、勿分享"
						});
					} catch (error) {
						sendJson(res, 500, {
							ok: false,
							error: `导出失败：${error?.message ?? error}`
						});
					}
					return;
				}
				if (req.method === "POST" && route === "/accounts/export-json") {
					try {
						sendJson(res, 200, {
							ok: true,
							...exportAccounts()
						});
					} catch (error) {
						sendJson(res, 500, {
							ok: false,
							error: `导出失败：${error?.message ?? error}`
						});
					}
					return;
				}
				if (req.method === "POST" && route === "/accounts/import") {
					const body = await readJsonBody(req, IMPORT_FILE_LIMIT_BYTES);
					if (!body || typeof body !== "object") {
						sendJson(res, 400, {
							ok: false,
							error: "请提供备份内容（payload）或文件路径"
						});
						return;
					}
					let payload = body.payload;
					const path = typeof body.path === "string" ? body.path.trim() : "";
					if (payload === void 0 && path) try {
						const info = statSync(path);
						if (!info.isFile()) throw new Error("不是普通文件");
						if (info.size > IMPORT_FILE_LIMIT_BYTES) throw new Error(`文件 ${Math.ceil(info.size / 1024)} KiB，超过上限 ${Math.floor(IMPORT_FILE_LIMIT_BYTES / 1024 / 1024)} MiB`);
						payload = JSON.parse(readFileSync(path, "utf8"));
					} catch (error) {
						sendJson(res, 400, {
							ok: false,
							error: `读取导入文件失败：${error?.message ?? error}`
						});
						return;
					}
					if (payload === void 0 || payload === null) {
						sendJson(res, 400, {
							ok: false,
							error: "请提供要导入的内容或文件路径"
						});
						return;
					}
					try {
						const result = importAccounts(payload);
						logger.info?.(`deepseek-web: 账号库导入完成（新增 ${result.imported} / 更新 ${result.updated} / 跳过 ${result.skipped}）`);
						sendJson(res, 200, {
							ok: true,
							...result,
							activeId: activeAccountId() ?? null
						});
					} catch (error) {
						if (error instanceof TypeError || error instanceof RangeError) {
							sendJson(res, 400, {
								ok: false,
								error: error?.message ?? String(error)
							});
							return;
						}
						throw error;
					}
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
				if (req.method === "GET" && route === "/context-mode") {
					sendJson(res, 200, {
						mode: contextMode,
						hint: CONTEXT_MODE_HINT,
						settingsPath: contextModeSettingsPath(),
						chain: contextMode === "chained" ? contextChainInfo() ?? null : null
					});
					return;
				}
				if (req.method === "POST" && route === "/context-mode") {
					const wanted = (await readJsonBody(req))?.mode;
					if (wanted !== "full" && wanted !== "chained") {
						sendJson(res, 400, {
							ok: false,
							error: "mode 必须是 'full' 或 'chained'"
						});
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
					logger.info?.(`deepseek-web: 上下文投喂切换为 ${contextMode}`);
					sendJson(res, 200, {
						ok: true,
						mode: contextMode,
						persisted,
						hint: CONTEXT_MODE_HINT,
						settingsPath: contextModeSettingsPath(),
						chain: contextMode === "chained" ? contextChainInfo() ?? null : null
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
						if (check.ok && check.user && auth && (!auth.user || auth.user.display !== check.user.display)) {
							const target = listAccounts().find((item) => item.token === auth.token);
							if (target) refreshVerifiedIdentity(target.id, target.token, check.user);
						}
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
							minRequestIntervalMs: adapterConfig.minRequestIntervalMs ?? 2e3,
							maxRequestIntervalMs: adapterConfig.maxRequestIntervalMs ?? 4e3,
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
					logger.info?.(`deepseek-web: 准备添加新账号（profile=${profileCleared} partition=${partitionCleared}）—— 接下来捕获到的凭证只入库、不切换`);
					sendJson(res, 200, {
						ok: true,
						profileCleared,
						partitionCleared,
						hint: "登录窗口里登录另一个账号；它会加入账号库，但不会自动切换"
					});
					return;
				}
				if (req.method === "POST" && route === "/login/relogin") {
					const body = await readJsonBody(req);
					const id = String(body?.id ?? "");
					const target = id ? readAccount(id) : void 0;
					if (!target) {
						sendJson(res, 404, {
							ok: false,
							error: "账号不存在（可能已被移除），请刷新后重试"
						});
						return;
					}
					const stale = !!target.lastVerifyError;
					if (stale) {
						const cleared = await clearLoginState();
						logger.info?.(`deepseek-web: 账号「${target.label || target.id}」已被标记失效，重登不再复用登录态，先清掉（profile=${cleared.profileCleared} partition=${cleared.partitionCleared}）`);
					}
					beginRelogin(id);
					logger.info?.(`deepseek-web: 准备重新登录「${target.label || target.id}」（${stale ? "登录态已失效，本次不复用" : "不清理浏览器登录态，能复用就直接复用"}）—— 捕获后原地更新这条记录，不新增、也不切换当前账号`);
					sendJson(res, 200, {
						ok: true,
						targetId: id,
						keptBrowserSession: !stale,
						hint: stale ? "这条账号已被标记失效，浏览器里剩下的登录态也已经不可用 —— 已帮你清掉，请在打开的窗口里重新登录一次" : "登录窗口会打开：如果浏览器里还留着这个账号的登录态会立刻复用，否则在里面重新登录一次"
					});
					return;
				}
				if (req.method === "POST" && route === "/login/browser") {
					if ((await readJsonBody(req).catch(() => void 0))?.fresh === true) {
						const { profileCleared, partitionCleared } = await clearLoginState();
						logger.info?.(`deepseek-web: 登录前清理登录态（profile=${profileCleared} partition=${partitionCleared}）`);
					}
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
						const check = await validateAuth(outcome.auth).catch(() => void 0);
						const verified = !!check?.ok;
						const commit = commitCapturedAuth(verified ? withVerifiedIdentity(outcome.auth, check?.user) : outcome.auth);
						if (verified && check?.user && commit.recordId) {
							const record = listAccounts().find((item) => item.id === commit.recordId);
							const verifiedId = typeof check.user.id === "string" ? String(check.user.id) : "";
							updateAccount(commit.recordId, {
								user: {
									...record?.user ?? {},
									...check.user
								},
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
					endAddAccount();
					endRelogin();
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
				if (error instanceof BodyError) {
					logger.warn?.(`deepseek-web api ${route} 请求体被拒：${error.message}`);
					try {
						res.shouldKeepAlive = false;
					} catch {}
					if (!res.destroyed && !res.headersSent) sendJson(res, error.status, {
						ok: false,
						error: error.message
					});
					return;
				}
				logger.warn?.(`deepseek-web api ${route} failed: ${error?.message ?? error}`);
				sendJson(res, 500, { error: error?.message ?? String(error) });
			}
		}
	}), "dsh-deepseek-web-login: api");
	ctx.effect(() => () => {
		try {
			if (isLoginWindowOpen()) closeLoginWindow();
		} catch {}
		try {
			disposeSessionReuse();
		} catch {}
		try {
			sessionCleaner.flush();
		} catch {}
	}, "dsh-deepseek-web-login: teardown");
}
//#endregion
export { BodyError, apply, inject, name, readJsonBody };

//# sourceMappingURL=index.js.map