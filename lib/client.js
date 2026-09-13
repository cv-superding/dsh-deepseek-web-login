window.__ModuleLoader__.load({
	id: "dsh-deepseek-web-login",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/file-picker.ts
		const win = () => globalThis;
		/**
		* 把界面选中的 File 还原成**真实磁盘路径**。
		*
		* 这一步的价值：拿到路径后，宿主可以**自己去读那个文件**，
		* 于是导入的凭证明文根本不经过 HTTP 请求体 —— 只是把"文件在哪"告诉宿主。
		* 桥不可用（宿主没注入 / 非磁盘来源的 File）就返回 undefined，调用方改用内容导入。
		*/
		function resolvePickedPath(file, w = win()) {
			if (!file) return void 0;
			try {
				const resolved = w.__DSH_DESKTOP_FILE_PATH__?.getPathForFile?.(file);
				return typeof resolved === "string" && resolved.trim() ? resolved : void 0;
			} catch {
				return;
			}
		}
		/** 渲染进程是否支持 File System Access 的「另存为」。 */
		function canSaveWithPicker(w = win()) {
			return typeof w?.showSaveFilePicker === "function";
		}
		/**
		* 备份文件建议名。
		*
		* 刻意只用 **数字 / 字母 / 短横线 / 点**：这个字符串会进系统另存为框的
		* `suggestedName`，冒号、斜杠在 Windows 上是非法文件名字符（`toISOString()` 恰好
		* 带冒号，直接拿来当文件名会踩坑）。
		*/
		function suggestedExportName(now = /* @__PURE__ */ new Date()) {
			const pad = (value) => String(value).padStart(2, "0");
			return `deepseek-accounts-${`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`}.json`;
		}
		/** 用户取消选择时 Chromium 抛的是 AbortError，要和其他失败区分开（取消不是错误）。 */
		function isPickerCancel(error) {
			return error?.name === "AbortError";
		}
		/**
		* 弹系统「另存为」，并把 `produce()` 产出的文本写进用户选定的位置。
		*
		* ⚠️ 为什么收一个回调而不是直接收文本：**必须先弹框、再取内容**。
		* Chromium 的瞬时用户激活是有时限的，若调用方先 `await` 一次网络请求
		* （取备份内容）再弹框，很可能被判成"没有用户手势"而直接抛错。
		* 把取数包成回调，顺序就锁在这个函数里，调用方想写错都难。
		*/
		async function saveWithPicker(suggestedName, produce, w = win()) {
			if (!canSaveWithPicker(w)) return { kind: "unsupported" };
			try {
				const handle = await w.showSaveFilePicker({
					suggestedName,
					types: [{
						description: "JSON 备份",
						accept: { "application/json": [".json"] }
					}]
				});
				const text = await produce();
				const writable = await handle.createWritable();
				await writable.write(new Blob([text], { type: "application/json" }));
				await writable.close();
				return {
					kind: "saved",
					name: typeof handle?.name === "string" && handle.name ? handle.name : suggestedName
				};
			} catch (error) {
				if (isPickerCancel(error)) return { kind: "cancelled" };
				return {
					kind: "failed",
					reason: `${error?.name ?? ""} ${error?.message ?? error}`.trim()
				};
			}
		}
		/**
		* 弹系统「打开」框选一个 JSON。返回 undefined 表示用户取消。
		*
		* 用 `<input type="file">` 而不是 `showOpenFilePicker`：前者在**任何** Chromium
		* 环境里都可用（包括跨域 iframe，Chromium 150 起第三方 iframe 是被禁止弹
		* File System Access 文件框的），是我们最可靠的"让人选文件"手段。
		*/
		function pickJsonFile(doc = document) {
			return new Promise((resolve) => {
				const input = doc.createElement("input");
				input.type = "file";
				input.accept = ".json,application/json";
				input.style.display = "none";
				let settled = false;
				const finish = (file) => {
					if (settled) return;
					settled = true;
					input.remove();
					resolve(file);
				};
				input.addEventListener("change", () => finish(input.files?.[0]));
				input.addEventListener("cancel", () => finish(void 0));
				doc.body.appendChild(input);
				input.click();
			});
		}
		/**
		* 把用户选中的文件变成"宿主能用的东西"。
		*
		* 优先走路径（凭证不进 HTTP），拿不到路径才退回内容 —— 后者是必要的兜底：
		* 宿主没注入路径桥时功能不该整体失效。
		*/
		async function readImportSource(file, w = win()) {
			const name = file.name || "备份文件";
			const path = resolvePickedPath(file, w);
			if (path) return {
				kind: "path",
				path,
				name
			};
			try {
				return {
					kind: "content",
					payload: JSON.parse(await file.text()),
					name
				};
			} catch (error) {
				return {
					kind: "unreadable",
					name,
					reason: `${error?.message ?? error}`
				};
			}
		}
		//#endregion
		//#region src/cookies.ts
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
		/** 剩余时间的口语化写法。 */
		function describeRemaining(daysLeft) {
			if (daysLeft <= 0) return "已过期";
			if (daysLeft >= 1) return `还剩 ${Math.floor(daysLeft)} 天`;
			return `还剩 ${Math.max(1, Math.round(daysLeft * 24))} 小时`;
		}
		/**
		* 一句话说清 cookie 的寿命构成（界面直接展示）。
		*
		* 三种情况分开写，因为它们的含义完全不同：
		*  - 没记录 → 老记录 / 手动粘 token，下次重新登录会补上；
		*  - 全是会话级 → 浏览器侧本来就没有到期时间，看它撑多久没意义；
		*  - 有持久级 → 给出最晚那个的剩余时间（**只是浏览器侧的上界，不是登录态寿命**）。
		*/
		function describeCookieLife(summary, now = Date.now()) {
			if (!summary) return "未记录（重新登录后会补上）";
			const parts = [`${summary.total} 项`];
			parts.push(summary.sessionCount > 0 ? `${summary.sessionCount} 会话级` : "无会话级");
			if (summary.persistentCount > 0) parts.push(`${summary.persistentCount} 持久级`);
			if (summary.latest) {
				const daysLeft = (summary.latest.expiresAt - now) / 864e5;
				parts.push(`${summary.latest.name} ${describeRemaining(daysLeft)}`);
			}
			return parts.join(" · ");
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* dsh-deepseek-web-login — client 设置页（slots: settings.section）。
		*
		* 与 host 通过同源 fetch 通信：/deepseek-web-login/api/*
		* 渲染契约（沿用生态实测结论）：槽位 register 必须带 name 字段，
		* 渲染函数返回 React 元素（createElement），React #130 的坑即来自返回非元素。
		*/
		const inject = ["slots"];
		const API = "/deepseek-web-login/api";
		async function api(path, init) {
			return await (await fetch(API + path, {
				headers: { "content-type": "application/json" },
				...init
			})).json();
		}
		/**
		* 样式表 —— 全部走宿主的主题令牌（`--dsw-alias-*`）。
		*
		* 历史坑（2026-09-12 用户实测）：以前用的是 `var(--theme-text, #ddd)` 这套**并不存在**的变量名，
		* 于是每个颜色都落到兜底值上；兜底又全是深色 → 浅色主题下整个面板仍是黑底，
		* 灰色文字贴在深底上几乎读不出来。
		*
		* 现在的做法：
		*  1. 颜色优先取宿主令牌（`--dsw-alias-label-primary` / `bg-layer-*` / `border-l*` / `state-*` …），
		*     这些令牌由 DSH 按当前主题（浅 / 深 / 皮肤）重定义，插件无需自己判断主题；
		*  2. 令牌缺失时（老宿主 / 令牌改名）退回 `--fb-*`，而 `--fb-*` 由 `prefers-color-scheme` 切换，
		*     保证「浅色主题不会出现黑界面」这条底线永远成立；
		*  3. 正文改用系统无衬线字体（原来是等宽字体铺满全屏，观感像终端日志），等宽只留给命令与代码。
		*/
		const styles = `
.dsw-page{
/* 兜底色：令牌缺失时才用到，随系统主题切换 */
--fb-fg:#1f2329;--fb-fg2:#545b66;--fb-fg3:#8b93a3;
--fb-bg1:#f6f7f9;--fb-bg2:#ffffff;--fb-bd:#e8eaee;--fb-bd2:#d7dae0;
--fb-hover:#0000000f;--fb-code:#f3f4f6;
/* 语义层 */
--fg:var(--dsw-alias-label-primary,var(--fb-fg));
--fg2:var(--dsw-alias-label-secondary,var(--fb-fg2));
--fg3:var(--dsw-alias-label-tertiary,var(--fb-fg3));
--bg1:var(--dsw-alias-bg-layer-1,var(--fb-bg1));
--bg2:var(--dsw-alias-bg-layer-2,var(--fb-bg2));
--bd:var(--dsw-alias-border-l1,var(--fb-bd));
--bd2:var(--dsw-alias-border-l2,var(--fb-bd2));
--hover:var(--dsw-alias-interactive-bg-hover,var(--fb-hover));
--code-bg:var(--dsw-alias-markdown-code-block,var(--fb-code));
--accent:var(--dsw-alias-brand-primary,#3b6ef0);
--on-accent:var(--dsw-alias-label-primary-foreground,#ffffff);
--ok:var(--dsw-alias-state-success-primary,#1a9f5a);
--warn:var(--dsw-alias-state-warn-label,#9a6a00);
--err:var(--dsw-alias-state-error-primary,#d93025);
--mono:var(--dsw-alias-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
font-size:13px;line-height:1.6;color:var(--fg);max-width:760px;padding:2px 0 12px;
-webkit-font-smoothing:antialiased;
}
@media (prefers-color-scheme:dark){
.dsw-page{--fb-fg:#ededed;--fb-fg2:#b6bcc6;--fb-fg3:#858c99;
--fb-bg1:#212121;--fb-bg2:#2a2a2a;--fb-bd:#333333;--fb-bd2:#3d3d3d;
--fb-hover:#ffffff14;--fb-code:#1c1c1c}
}
.dsw-title{margin:0 0 3px;font-size:14px;font-weight:500;color:var(--fg)}
.dsw-sub{margin:0 0 14px;font-size:12px;line-height:1.55;color:var(--fg3)}
/* provider 名带连字符，万一折行会断成 deepseek- / web（看着像故障）—— 整词不拆 */
.dsw-nobreak{white-space:nowrap}
.dsw-card{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.dsw-cardhead{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:13px;font-weight:500;color:var(--fg)}
.dsw-card > .name{margin:0 0 8px;font-size:13px;font-weight:500;color:var(--fg)}
.dsw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsw-badge{font-size:11px;font-weight:500;line-height:1.7;padding:1px 9px;border-radius:999px;white-space:nowrap}
.dsw-badge.on{color:var(--ok);background:rgba(26,159,90,.15)}
.dsw-badge.off{color:var(--warn);background:rgba(200,140,20,.16)}
.dsw-badge.err{color:var(--err);background:rgba(217,48,37,.15)}
.dsw-btn{font:inherit;font-size:12px;font-weight:500;line-height:1.5;padding:6px 13px;border-radius:8px;
border:1px solid transparent;background:var(--accent);color:var(--on-accent);cursor:pointer;
transition:background-color .15s ease,border-color .15s ease,opacity .15s ease}
.dsw-btn:hover:not(:disabled){opacity:.88}
.dsw-btn:active:not(:disabled){opacity:.72}
.dsw-btn:disabled{opacity:.4;cursor:not-allowed}
.dsw-btn.ghost{background:transparent;border-color:var(--bd2);color:var(--fg)}
.dsw-btn.ghost:hover:not(:disabled){background:var(--hover);opacity:1}
.dsw-btn.danger{background:transparent;border-color:var(--bd2);color:var(--err)}
.dsw-btn.danger:hover:not(:disabled){background:rgba(217,48,37,.1);border-color:var(--err);opacity:1}
.dsw-btn.armed{background:var(--err);border-color:var(--err);color:#ffffff}
.dsw-btn.armed:hover:not(:disabled){opacity:.9}
.dsw-input,.dsw-area{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;
background:var(--bg1);color:var(--fg);border:1px solid var(--bd2);border-radius:8px;padding:7px 10px;
outline:none;transition:border-color .15s ease,box-shadow .15s ease}
.dsw-input:focus,.dsw-area:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--hover)}
.dsw-area{min-height:68px;resize:vertical;font-family:var(--mono);font-size:12px;line-height:1.5}
.dsw-kv{display:grid;grid-template-columns:auto 1fr;gap:0 12px;margin:2px 0 0;align-items:baseline}
.dsw-kv > *{padding:5px 0;border-top:1px solid var(--bd);min-width:0}
.dsw-kv > :nth-child(1),.dsw-kv > :nth-child(2){border-top:none}
.dsw-kv .k{color:var(--fg3);font-size:12px;white-space:nowrap}
.dsw-kv > *:not(.k){color:var(--fg);word-break:break-word}
.dsw-msg{margin-top:10px;padding:9px 12px;border-radius:8px;background:var(--bg1);border:1px solid var(--bd);
border-left:3px solid var(--fg3);white-space:pre-wrap;max-height:240px;overflow:auto;
font-size:12px;line-height:1.6;color:var(--fg)}
.dsw-msg.err{border-left-color:var(--err);color:var(--err)}
.dsw-msg.ok{border-left-color:var(--ok)}
.dsw-models{list-style:none;margin:2px 0 0;padding:0}
.dsw-models li{padding:9px 0;border-top:1px solid var(--bd)}
.dsw-models li:first-child{border-top:none;padding-top:2px}
.dsw-models .name{font-size:13px;font-weight:500;color:var(--fg)}
.dsw-models .id{color:var(--fg3);font-size:12px;margin-top:1px;word-break:break-word}
.dsw-hint{color:var(--fg3);font-size:12px;line-height:1.6;margin:8px 0 0}
.dsw-gate-row{display:flex;align-items:center;gap:10px;margin:10px 0;flex-wrap:wrap}
.dsw-gate-label{color:var(--fg3);font-size:12px;min-width:52px;flex:0 0 auto}
.dsw-gate-value{font-size:12px;color:var(--fg);min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
/* 「上下限」成对的一行：两个滑块并排，右边一个合成值（如「6~10 个」）。
   —— 比"每个边界各占一行"省一半高度，而且两个边界的相对位置一眼能比出来。 */
.dsw-range-pair{flex:1 1 240px;display:flex;gap:8px;align-items:center;min-width:190px}
.dsw-gate-pair-value{font-size:12px;color:var(--fg);min-width:78px;text-align:right;font-variant-numeric:tabular-nums}
.dsw-switch{display:inline-flex;align-items:center;gap:9px;font-size:13px;color:var(--fg);cursor:pointer;user-select:none}
.dsw-switch input{position:absolute;opacity:0;width:0;height:0}
.dsw-switch-track{width:34px;height:20px;border-radius:999px;background:var(--bd2);position:relative;transition:background-color .15s ease;flex:0 0 auto}
.dsw-switch-track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease}
.dsw-switch input:checked + .dsw-switch-track{background:var(--err)}
.dsw-switch input:checked + .dsw-switch-track::after{transform:translateX(14px)}
.dsw-range{-webkit-appearance:none;appearance:none;flex:1 1 160px;height:4px;border-radius:999px;background:var(--bd2);outline:none;cursor:pointer}
.dsw-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:var(--accent);cursor:pointer;border:none}
.dsw-preset{padding:4px 10px;font-size:12px}
.dsw-preset.active{background:var(--accent);border-color:transparent;color:var(--on-accent)}
.dsw-gate-msg{color:var(--fg3);min-height:1.6em}
.dsw-code{display:block;margin:6px 0;padding:7px 10px;background:var(--code-bg);border:1px solid var(--bd);
border-radius:8px;font-family:var(--mono);font-size:12px;line-height:1.5;color:var(--fg);
overflow-x:auto;white-space:pre}
.dsw-msg::-webkit-scrollbar,.dsw-code::-webkit-scrollbar,.dsw-area::-webkit-scrollbar{width:8px;height:8px}
.dsw-msg::-webkit-scrollbar-thumb,.dsw-code::-webkit-scrollbar-thumb,.dsw-area::-webkit-scrollbar-thumb{
background:var(--bd2);border-radius:4px}
/* ── 标签页：把原来一页到底的 7 张卡拆成 4 页 ────────────────────────
   标签栏做成带边框的圆角容器；未选中 70% 透明度 + 下划线指示当前页。
   颜色全部走设计令牌，浅色/深色自动跟随，不用写第二份。 */
.dsw-tabs{display:inline-flex;gap:4px;border:1px solid var(--bd);border-radius:8px;
padding:0 10px;margin:4px 0 14px;background:var(--bg1)}
.dsw-tab{appearance:none;background:transparent;border:none;border-bottom:2px solid transparent;
padding:8px 14px;font:inherit;font-size:13px;color:var(--fg2);opacity:.7;cursor:pointer;
transition:opacity .15s ease,border-color .15s ease}
.dsw-tab:hover{opacity:1}
.dsw-tab.active{opacity:1;color:var(--fg);border-bottom-color:var(--fg)}
.dsw-pane[hidden]{display:none}
/* 二级（子页面）标签：**分段胶囊**。
   刻意和一级标签长得不一样（一级是"下划线 + 大字号"），这样一眼能看出自己在第几层；
   否则两层长得一样、用户会以为回到了同一层。 */
.dsw-subtabs{display:inline-flex;gap:2px;padding:3px;margin:0 0 14px;border-radius:999px;
  background:var(--bg1);border:1px solid var(--bd)}
.dsw-subtab{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;
  font-weight:500;color:var(--fg2);padding:4px 14px;border-radius:999px;cursor:pointer;
  transition:color .15s ease,background-color .15s ease}
.dsw-subtab:hover{color:var(--fg)}
/* 选中态：底色用 bg2 铺在 bg1 上，深色主题里这两档只差一点点，
   所以必须再加一圈描边（bd2 比 bd 明显）才立得住 —— 实测深色下不加就跟没选中一样。 */
.dsw-subtab.active{background:var(--bg2);color:var(--fg);font-weight:600;
  box-shadow:inset 0 0 0 1px var(--bd2)}
/* 调用台账 */
.dsw-spark{display:block;width:100%;height:40px;margin:8px 0 2px}
.dsw-spark rect{fill:var(--bd2)}
.dsw-spark rect.on{fill:var(--accent)}
.dsw-spark rect.bad{fill:var(--err)}
.dsw-path{font-family:var(--mono);font-size:11px;color:var(--fg2);word-break:break-all}
/* 账号库 */
.dsw-accounts{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.dsw-account{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--bd);
border-radius:10px;padding:9px 11px;background:var(--bg1)}
.dsw-account.active{border-color:var(--accent)}
.dsw-account-main{flex:1 1 200px;min-width:0}
.dsw-account-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:500}
.dsw-account-meta{font-size:11px;color:var(--fg3);margin-top:3px;word-break:break-all}
.dsw-account-fix{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
.dsw-account-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsw-labelinput{font:inherit;font-size:12px;padding:3px 7px;border-radius:6px;border:1px solid var(--bd2);
background:var(--bg2);color:var(--fg);width:150px;margin-top:4px}
.dsw-limit{color:var(--warn)}
/* 操作反馈：不归属任何一页，常驻在标签栏之上 */
.dsw-alert{margin:0 0 12px;padding:8px 10px;border-radius:8px;border:1px solid var(--bd);
background:var(--bg1);white-space:pre-wrap;font-size:12px}
.dsw-alert.ok{border-left:3px solid var(--ok);color:var(--ok)}
.dsw-alert.err{border-left:3px solid var(--err);color:var(--err)}
`;
		/** 短时间：今天只显示时分，其它显示月/日 时:分。 */
		function shortTime(input) {
			if (input === void 0 || input === null || input === "") return "";
			const date = new Date(input);
			if (Number.isNaN(date.getTime())) return "";
			const now = /* @__PURE__ */ new Date();
			const sameDay = date.toDateString() === now.toDateString();
			const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
			return sameDay ? hhmm : `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
		}
		/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
		function relTime(input) {
			if (!input) return "";
			const at = new Date(input).getTime();
			if (!Number.isFinite(at)) return "";
			const diff = Date.now() - at;
			if (diff < 6e4) return "刚刚";
			if (diff < 36e5) return `${Math.floor(diff / 6e4)} 分钟前`;
			if (diff < 864e5) return `${Math.floor(diff / 36e5)} 小时前`;
			return `${Math.floor(diff / 864e5)} 天前`;
		}
		/** 倒计时：还剩 2 小时 13 分 / 已解除。 */
		function countdown(untilMs) {
			if (!untilMs || !Number.isFinite(untilMs)) return "";
			const left = untilMs - Date.now();
			if (left <= 0) return "已解除";
			const totalMinutes = Math.ceil(left / 6e4);
			const hours = Math.floor(totalMinutes / 60);
			const minutes = totalMinutes % 60;
			if (hours > 0) return `剩余 ${hours} 小时 ${minutes} 分`;
			return `剩余 ${minutes} 分`;
		}
		function el(tag, cls, text) {
			const node = document.createElement(tag);
			if (cls) node.className = cls;
			if (text !== void 0) node.textContent = text;
			return node;
		}
		/** 面板本体：命令式 DOM（生态既有插件同款做法），挂在 React 容器里。 */
		function Panel() {
			const hostRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const root = hostRef.current;
				if (!root) return;
				let disposed = false;
				let timer;
				const style = document.createElement("style");
				style.textContent = styles;
				const page = el("div", "dsw-page");
				const title = el("h3", "dsw-title", "DeepSeek 网页登录（免费模型）");
				const sub = el("p", "dsw-sub");
				sub.append("用 chat.deepseek.com 的登录态驱动 DSH，不需要 API Key（provider：");
				sub.append(el("span", "dsw-nobreak", "deepseek-web"));
				sub.append("）");
				page.append(style, title, sub);
				const message = el("div", "dsw-alert");
				message.style.display = "none";
				page.append(message);
				const showMessage = (text, kind = "") => {
					message.textContent = text;
					message.className = `dsw-alert${kind ? ` ${kind}` : ""}`;
					message.style.display = "block";
				};
				const TAB_KEYS = [
					"account",
					"model",
					"gate",
					"transport",
					"about"
				];
				const TAB_LABELS = {
					account: "账号",
					model: "模型",
					gate: "防风控",
					transport: "传输层",
					about: "关于"
				};
				const accountPane = el("div", "dsw-pane");
				const modelPane = el("div", "dsw-pane");
				const gatePane = el("div", "dsw-pane");
				const transportPane = el("div", "dsw-pane");
				const aboutPane = el("div", "dsw-pane");
				const panes = {
					account: accountPane,
					model: modelPane,
					gate: gatePane,
					transport: transportPane,
					about: aboutPane
				};
				const tabButtons = {};
				const selectTab = (key) => {
					for (const each of TAB_KEYS) {
						const on = each === key;
						panes[each].hidden = !on;
						tabButtons[each].classList.toggle("active", on);
						tabButtons[each].setAttribute("aria-selected", String(on));
					}
				};
				const tabBar = el("div", "dsw-tabs");
				tabBar.setAttribute("role", "tablist");
				for (const key of TAB_KEYS) {
					const btn = el("button", "dsw-tab", TAB_LABELS[key]);
					btn.type = "button";
					btn.setAttribute("role", "tab");
					btn.addEventListener("click", () => selectTab(key));
					tabButtons[key] = btn;
					tabBar.append(btn);
					panes[key].setAttribute("role", "tabpanel");
				}
				page.append(tabBar, ...TAB_KEYS.map((key) => panes[key]));
				selectTab("account");
				const ACCT_KEYS = ["status", "library"];
				const ACCT_LABELS = {
					status: "登录状态",
					library: "账号库"
				};
				const acctStatusPane = el("div", "dsw-pane");
				const acctLibraryPane = el("div", "dsw-pane");
				const acctPanes = {
					status: acctStatusPane,
					library: acctLibraryPane
				};
				const acctButtons = {};
				const selectAcctTab = (key) => {
					for (const each of ACCT_KEYS) {
						const on = each === key;
						acctPanes[each].hidden = !on;
						acctButtons[each].classList.toggle("active", on);
						acctButtons[each].setAttribute("aria-selected", String(on));
					}
				};
				const acctTabBar = el("div", "dsw-subtabs");
				acctTabBar.setAttribute("role", "tablist");
				for (const key of ACCT_KEYS) {
					const btn = el("button", "dsw-subtab", ACCT_LABELS[key]);
					btn.type = "button";
					btn.setAttribute("role", "tab");
					btn.addEventListener("click", () => selectAcctTab(key));
					acctButtons[key] = btn;
					acctTabBar.append(btn);
					acctPanes[key].setAttribute("role", "tabpanel");
				}
				accountPane.append(acctTabBar, acctStatusPane, acctLibraryPane);
				selectAcctTab("status");
				const loginCard = el("div", "dsw-card");
				const loginHead = el("div", "dsw-cardhead");
				const loginTitle = el("div");
				loginTitle.append(el("span", "name", "登录状态"));
				const badge = el("span", "dsw-badge off", "未登录");
				loginTitle.append(badge);
				loginHead.append(loginTitle);
				loginCard.append(loginHead);
				const statusKv = el("div", "dsw-kv");
				loginCard.append(statusKv);
				let activeLimitUntilMs = null;
				const limitRow = el("p", "dsw-hint dsw-limit");
				limitRow.style.display = "none";
				limitRow.style.marginTop = "8px";
				loginCard.append(limitRow);
				const paintLimit = () => {
					if (!activeLimitUntilMs) {
						limitRow.style.display = "none";
						return;
					}
					const text = countdown(activeLimitUntilMs);
					limitRow.style.display = "";
					limitRow.textContent = text === "已解除" ? `账号级限制已解除（${shortTime(activeLimitUntilMs)}）。` : `⚠️ 账号级限制：${text}（${shortTime(activeLimitUntilMs)} 解除）—— 期间生成会被拒；只读调用（校验 / 探活）不受影响。`;
				};
				const accountCard = el("div", "dsw-card");
				accountCard.append(el("div", "dsw-cardhead", "当前账号"));
				const accountLine = el("div", "dsw-kv");
				accountCard.append(accountLine);
				const accountActions = el("div", "dsw-row");
				accountActions.style.marginTop = "8px";
				const logoutBtn = el("button", "dsw-btn danger", "退出当前账号");
				const switchBtn = el("button", "dsw-btn ghost", "退出并登录其它账号");
				accountActions.append(logoutBtn, switchBtn);
				accountCard.append(accountActions);
				const accountHint = el("p", "dsw-hint", "⚠️ 「退出」= 把该账号从账号库移除，不是\"只登出\"：本地凭证与浏览器登录态会一起清掉。想留住它就先「导出备份」；只是想换个号用，去「账号库 → 登录新账号」。");
				accountCard.append(accountHint);
				const loginActions = el("div", "dsw-row");
				loginActions.style.marginTop = "10px";
				const browserBtn = el("button", "dsw-btn", "浏览器窗口登录");
				const externalBtn = el("button", "dsw-btn ghost", "用我的默认浏览器登录");
				const recoverBtn = el("button", "dsw-btn ghost", "从已登录窗口恢复");
				const refreshBtn = el("button", "dsw-btn ghost", "刷新状态");
				loginActions.append(browserBtn, externalBtn, recoverBtn, refreshBtn);
				loginCard.append(loginActions);
				loginCard.append(el("p", "dsw-hint", "「用我的默认浏览器登录」= 用系统浏览器打开 chat.deepseek.com（网页端若提示「使用环境异常」，走这条）。外部浏览器的登录态插件抓不到，所以要用 F12 控制台取 token 粘到下面那张卡（命令已备好）。"));
				loginCard.append(el("p", "dsw-hint", "「从已登录窗口恢复」= 复用上次登录过的窗口分区直接取凭证（免重新登录），凭证丢失时用它救急。"));
				acctStatusPane.append(loginCard, accountCard);
				const accountsCard = el("div", "dsw-card");
				const accountsHead = el("div", "dsw-cardhead");
				accountsHead.append(el("span", "name", "账号库"));
				const accountsBadge = el("span", "dsw-badge off", "—");
				accountsHead.append(accountsBadge);
				accountsCard.append(accountsHead);
				accountsCard.append(el("p", "dsw-hint", "保存过的账号都在本机，点「切换」即时生效，不用重新登录。切换后**下一次请求**就用新账号。"));
				const accountsList = el("ul", "dsw-accounts");
				accountsCard.append(accountsList);
				const accountsEmpty = el("p", "dsw-hint", "账号库是空的 —— 用上面的「登录」或「手动粘贴 Token」添加一个。");
				accountsCard.append(accountsEmpty);
				const accountsIOPanel = el("div", "dsw-row");
				accountsIOPanel.style.marginTop = "10px";
				const addAccountBtn = el("button", "dsw-btn", "登录新账号（添加）");
				const exportBtn = el("button", "dsw-btn ghost", "导出备份…");
				const importBtn = el("button", "dsw-btn ghost", "导入备份…");
				accountsIOPanel.append(addAccountBtn, exportBtn, importBtn);
				accountsCard.append(accountsIOPanel);
				accountsCard.append(el("p", "dsw-hint", "「登录新账号」会先清掉上次的浏览器登录态（库里已有的账号不受影响），登录后新账号只入库、不切换当前账号 ——加完在列表里点「切换」即可使用。某个账号标着「需要重新登录」时，用它自己那行上的按钮修 ——那条路不清浏览器登录态，能复用就直接复用。导出/导入会弹系统对话框，自己选位置和文件。"));
				const accountsMsg = el("p", "dsw-hint dsw-gate-msg", "");
				accountsCard.append(accountsMsg);
				accountsCard.append(el("p", "dsw-hint", "导出的备份文件里是**可完整登录的凭证**（等同于账号本身），别分享、别提交到仓库。"));
				acctLibraryPane.append(accountsCard);
				const renderAccounts = (data) => {
					const items = Array.isArray(data?.accounts) ? data.accounts : [];
					accountsBadge.textContent = `${items.length} 个`;
					accountsBadge.className = `dsw-badge ${items.length ? "on" : "off"}`;
					accountsEmpty.hidden = items.length > 0;
					accountsList.textContent = "";
					for (const item of items) accountsList.append(accountRow(item));
				};
				/**
				* 「重新登录这个账号」：给凭证失效（探活失败）的账号用。
				*
				* 与「登录新账号」的唯一区别是**不清浏览器登录态**：后者要先清干净才能加到别的号，
				* 而修同一个号正相反 —— 留着才可能一打开就复用上。落库仍走添加模式（只入库、不切换），
				* 所以修好它也不会顶掉你正在用的账号；若它本来就是当前账号，那正是你要的效果。
				*/
				const reloginAccount = (id, title) => {
					(async () => {
						accountsMsg.textContent = `正在为「${title}」打开登录窗口（不清理浏览器登录态，能复用就直接复用）……`;
						try {
							const prep = await api("/login/relogin", {
								method: "POST",
								body: JSON.stringify({ id })
							});
							if (prep?.ok === false) {
								accountsMsg.textContent = `准备失败：${prep?.error ?? "未知原因"}`;
								return;
							}
							boostUntil = Date.now() + 3e5;
							accountsMsg.textContent = "登录窗口已打开：浏览器里若还留着这个账号的登录态会立刻复用；否则在里面重新登录一次……";
							const result = await api("/login/browser", {
								method: "POST",
								body: "{}"
							});
							if (result?.started === false) {
								accountsMsg.textContent = `打开登录窗口失败：${result?.reason ?? "未知原因"}（可改用「手动粘贴 Token」）`;
								return;
							}
							accountsMsg.textContent = result?.added ? `「${title}」的凭证已更新 —— 当前使用的账号没有改变。` : "已捕获并保存凭证。";
							await loadAccounts();
						} catch (error) {
							accountsMsg.textContent = `重新登录失败：${error?.message ?? error}`;
						} finally {
							await refresh(false).catch(() => void 0);
						}
					})();
				};
				const accountRow = (item) => {
					const row = el("li", `dsw-account${item.isActive ? " active" : ""}`);
					const main = el("div", "dsw-account-main");
					const title = el("div", "dsw-account-title");
					title.append(el("span", void 0, item.title || item.id));
					if (item.isActive) title.append(el("span", "dsw-badge on", "当前"));
					if (item.unverified) title.append(el("span", "dsw-badge off", "未校验"));
					if (item.limit && Number.isFinite(item.limit.untilMs) && item.limit.untilMs > Date.now()) title.append(el("span", "dsw-badge off", `受限至 ${shortTime(item.limit.untilMs)}`));
					if (item.lastVerifyError) title.append(el("span", "dsw-badge err", "需要重新登录"));
					main.append(title);
					const meta = [];
					if (item.display) meta.push(item.display);
					if (item.capturedAt) meta.push(`${shortTime(item.capturedAt)} 捕获`);
					meta.push(item.lastVerifiedAt ? `最近校验 ${relTime(item.lastVerifiedAt)}` : "尚未校验");
					const cookieMeta = Array.isArray(item.cookieMeta) ? item.cookieMeta : [];
					meta.push(`cookie：${describeCookieLife(summarizeCookieLife(cookieMeta))}`);
					main.append(el("div", "dsw-account-meta", meta.join(" · ")));
					if (item.lastVerifyError) {
						const fix = el("div", "dsw-account-fix");
						fix.append(el("span", "dsw-hint", `${relTime(item.lastVerifyError.at)}校验失败：${item.lastVerifyError.message}（凭证多半已失效；重新登录会原地更新它，不改变当前账号）`));
						const reloginBtn = el("button", "dsw-btn dsw-preset", "重新登录这个账号");
						reloginBtn.addEventListener("click", () => reloginAccount(item.id, item.title || item.id));
						fix.append(reloginBtn);
						main.append(fix);
					}
					row.append(main);
					const actions = el("div", "dsw-account-actions");
					if (item.isActive) actions.append(el("span", "dsw-hint", "使用中"));
					else {
						const useBtn = el("button", "dsw-btn ghost dsw-preset", "切换");
						useBtn.addEventListener("click", () => void switchToAccount(item.id));
						actions.append(useBtn);
					}
					const renameBtn = el("button", "dsw-btn ghost dsw-preset", "重命名");
					let editing = false;
					renameBtn.addEventListener("click", () => {
						if (editing) return;
						editing = true;
						const input = el("input", "dsw-labelinput");
						input.value = item.label || "";
						input.placeholder = "备注名，如「工作号」";
						main.append(input);
						input.focus();
						let settled = false;
						const commit = () => {
							if (settled) return;
							settled = true;
							saveAccountLabel(item.id, input.value);
						};
						input.addEventListener("keydown", (event) => {
							if (event.key === "Enter") commit();
							if (event.key === "Escape") {
								settled = true;
								loadAccounts();
							}
						});
						input.addEventListener("blur", commit);
					});
					actions.append(renameBtn);
					const removeBtn = el("button", "dsw-btn danger dsw-preset", "移除");
					let armed = false;
					removeBtn.addEventListener("click", () => {
						if (!armed) {
							armed = true;
							removeBtn.textContent = "确认移除？";
							removeBtn.classList.add("armed");
							window.setTimeout(() => {
								armed = false;
								removeBtn.textContent = "移除";
								removeBtn.classList.remove("armed");
							}, 4e3);
							return;
						}
						removeAccountById(item.id);
					});
					actions.append(removeBtn);
					row.append(actions);
					return row;
				};
				const loadAccounts = async () => {
					try {
						renderAccounts(await api("/accounts"));
					} catch (error) {
						accountsMsg.textContent = `账号库读取失败：${error?.message ?? error}`;
					}
				};
				const switchToAccount = async (id) => {
					accountsMsg.textContent = "切换中……";
					try {
						const result = await api("/accounts/switch", {
							method: "POST",
							body: JSON.stringify({ id })
						});
						if (!result?.ok) {
							accountsMsg.textContent = `切换失败：${result?.error ?? "未知原因"}`;
							return;
						}
						accountsMsg.textContent = "已切换（下一次请求生效）。正在刷新登录状态……";
						await loadAccounts();
						await refresh(false);
						accountsMsg.textContent = "已切换（下一次请求生效）";
					} catch (error) {
						accountsMsg.textContent = `切换失败：${error?.message ?? error}`;
					}
				};
				const removeAccountById = async (id) => {
					try {
						const result = await api("/accounts/remove", {
							method: "POST",
							body: JSON.stringify({ id })
						});
						if (!result?.ok) {
							accountsMsg.textContent = `移除失败：${result?.error ?? "未知原因"}`;
							return;
						}
						accountsMsg.textContent = "已移除该账号（凭证已删除）";
						await loadAccounts();
						await refresh(true);
					} catch (error) {
						accountsMsg.textContent = `移除失败：${error?.message ?? error}`;
					}
				};
				const saveAccountLabel = async (id, label) => {
					try {
						await api("/accounts/rename", {
							method: "POST",
							body: JSON.stringify({
								id,
								label
							})
						});
					} catch {}
					await loadAccounts();
				};
				addAccountBtn.addEventListener("click", () => {
					(async () => {
						addAccountBtn.disabled = true;
						accountsMsg.textContent = "正在准备登录窗口（会清掉上次的浏览器登录态，不影响账号库里的账号）……";
						try {
							const prep = await api("/login/add", {
								method: "POST",
								body: "{}"
							});
							if (prep?.ok === false) {
								accountsMsg.textContent = `准备失败：${prep?.error ?? "未知原因"}`;
								return;
							}
							boostUntil = Date.now() + 3e5;
							accountsMsg.textContent = "登录窗口已打开：请在窗口里登录另一个账号（不要登当前这个，否则只是刷新凭证）……";
							const result = await api("/login/browser", {
								method: "POST",
								body: "{}"
							});
							if (result?.started === false) {
								accountsMsg.textContent = `打开登录窗口失败：${result?.reason ?? "未知原因"}（可改用「手动粘贴 Token」）`;
								return;
							}
							if (result?.added) accountsMsg.textContent = result.created ? "已把新账号加入账号库 —— 当前账号没有改动，点列表里的「切换」才会用它。" : "这个账号本来就在库里（凭证已更新）—— 当前账号未改动。";
							else accountsMsg.textContent = "已捕获并保存凭证。";
							await loadAccounts();
						} catch (error) {
							accountsMsg.textContent = `添加账号失败：${error?.message ?? error}`;
						} finally {
							addAccountBtn.disabled = false;
							await refresh(false).catch(() => void 0);
						}
					})();
				});
				exportBtn.addEventListener("click", () => {
					(async () => {
						exportBtn.disabled = true;
						accountsMsg.textContent = "导出中……";
						try {
							const outcome = await saveWithPicker(suggestedExportName(), async () => {
								const data = await api("/accounts/export-json", {
									method: "POST",
									body: "{}"
								});
								if (!data?.ok) throw new Error(data?.error ?? "读取备份内容失败");
								const { ok: _ok, ...backup } = data;
								return JSON.stringify(backup, null, 2);
							});
							if (outcome.kind === "saved") accountsMsg.textContent = `已保存：${outcome.name}（含明文凭证，请妥善保管）`;
							else if (outcome.kind === "cancelled") accountsMsg.textContent = "已取消导出。";
							else {
								const result = await api("/accounts/export", {
									method: "POST",
									body: "{}"
								});
								const why = outcome.kind === "unsupported" ? "当前环境不支持系统另存为" : `系统另存为失败（${outcome.reason}）`;
								accountsMsg.textContent = result?.ok ? `${why}，已改为保存到插件目录：${result.path}` : `导出失败：${result?.error ?? "未知原因"}`;
							}
						} catch (error) {
							accountsMsg.textContent = `导出失败：${error?.message ?? error}`;
						} finally {
							exportBtn.disabled = false;
						}
					})();
				});
				importBtn.addEventListener("click", () => {
					(async () => {
						importBtn.disabled = true;
						accountsMsg.textContent = "请选择备份文件……";
						try {
							const file = await pickJsonFile();
							if (!file) {
								accountsMsg.textContent = "已取消导入。";
								return;
							}
							accountsMsg.textContent = `正在读取 ${file.name}……`;
							const source = await readImportSource(file);
							if (source.kind === "unreadable") {
								accountsMsg.textContent = `读取失败：${source.name} 不是有效的 JSON 备份（${source.reason}）`;
								return;
							}
							const body = source.kind === "path" ? { path: source.path } : { payload: source.payload };
							const result = await api("/accounts/import", {
								method: "POST",
								body: JSON.stringify(body)
							});
							accountsMsg.textContent = result?.ok ? `导入完成（${source.name}）：新增 ${result.imported} / 更新 ${result.updated} / 跳过 ${result.skipped}` : `导入失败：${result?.error ?? "未知原因"}`;
							if (result?.ok) await loadAccounts();
						} catch (error) {
							accountsMsg.textContent = `导入失败：${error?.message ?? error}`;
						} finally {
							importBtn.disabled = false;
						}
					})();
				});
				const tokenCard = el("div", "dsw-card");
				tokenCard.append(el("div", "dsw-cardhead", "手动粘贴 Token（可选路径）"));
				tokenCard.append(el("p", "dsw-hint", "在浏览器打开 chat.deepseek.com 并登录 → F12 控制台执行下面一行 → 把结果粘贴到输入框："));
				const snippet = el("code", "dsw-code", "JSON.parse(localStorage.getItem('userToken')).value");
				tokenCard.append(snippet);
				tokenCard.append(el("p", "dsw-hint", "（新版网页端 token 存在 {\"value\": …} 包装里；若上面那行报错，改成 localStorage.getItem('userToken') 直接复制整串，插件会自动解包）"));
				const tokenInput = el("textarea", "dsw-area");
				tokenInput.placeholder = "粘贴 token（包装 JSON 或裸 token 都行；可选：下一行粘贴 Cookie，格式 name=value; name2=value2）";
				tokenCard.append(tokenInput);
				const tokenActions = el("div", "dsw-row");
				tokenActions.style.marginTop = "8px";
				const tokenBtn = el("button", "dsw-btn", "保存并验证");
				tokenActions.append(tokenBtn);
				tokenCard.append(tokenActions);
				acctLibraryPane.append(tokenCard);
				const testCard = el("div", "dsw-card");
				testCard.append(el("div", "dsw-cardhead", "连通性测试"));
				testCard.append(el("p", "dsw-hint", "直接经适配器发一次最小请求（会消耗一点网页端额度）："));
				const testActions = el("div", "dsw-row");
				testActions.style.marginTop = "6px";
				const modelSelect = el("select", "dsw-input");
				modelSelect.style.maxWidth = "220px";
				const testBtn = el("button", "dsw-btn", "发送测试");
				testActions.append(modelSelect, testBtn);
				testCard.append(testActions);
				const testOut = el("div", "dsw-msg");
				testOut.style.display = "none";
				testCard.append(testOut);
				const modelsCard = el("div", "dsw-card");
				modelsCard.append(el("div", "dsw-cardhead", "可用模型（网页免费）"));
				const modelsList = el("ul", "dsw-models");
				modelsCard.append(modelsList);
				const modelsHint = el("p", "dsw-hint", "");
				modelsCard.append(modelsHint);
				modelPane.append(modelsCard, testCard);
				let loggedIn = false;
				let electron = false;
				let windowOpen = false;
				let probeIntervalMs = 0;
				const renderKv = (rows) => {
					statusKv.textContent = "";
					for (const [key, value] of rows) statusKv.append(el("div", "k", key), el("div", void 0, value));
				};
				const applyStatus = (status) => {
					loggedIn = !!status.auth?.loggedIn;
					electron = !!status.electron;
					windowOpen = !!status.loginWindowOpen;
					badge.textContent = loggedIn ? status.auth.unverified ? "已捕获（未校验）" : "已登录" : "未登录";
					badge.className = `dsw-badge ${loggedIn ? status.auth.unverified ? "off" : "on" : "off"}`;
					if (loggedIn && !status.auth.unverified) {
						const valid = status.validation;
						if (valid && !valid.ok) {
							badge.textContent = "登录态校验失败";
							badge.className = "dsw-badge err";
						}
					}
					const rows = [];
					activeLimitUntilMs = Number.isFinite(status.auth?.limitUntilMs) ? Number(status.auth?.limitUntilMs) : null;
					paintLimit();
					probeIntervalMs = Number(status.config?.probeIntervalMs ?? 0);
					renderVersion({
						current: status.config?.version,
						probeIntervalMs
					});
					renderPaths(status.paths);
					rows.push(["适配器注册", (status.registeredProviders ?? []).includes(status.provider) ? `✅ ${status.provider} 已注册到 llm` : `⚠️ 未在 llm 中找到 ${status.provider}`]);
					if (loggedIn) {
						rows.push(["账号", status.auth.display || "（未获取到账号信息）"]);
						rows.push(["捕获时间", status.auth.capturedAt ? new Date(status.auth.capturedAt).toLocaleString() : "未知"]);
						if (!status.auth.hasCookie && !status.auth.hasFingerprint) rows.push(["凭证来源", "手动粘贴 token（实测：仅凭 Bearer token 即可完成校验/求解/生成）"]);
						else rows.push(["凭证来源", "浏览器登录捕获（token + cookie + 指纹头，登录态通常更耐久）"]);
						rows.push(["Cookie", status.auth.hasCookie ? "✅ 已捕获" : "未捕获 —— 手动 token 模式本就没有（已验证不影响请求；若日后频繁遇到 AUTH/40003，改用「浏览器登录」）"]);
						if (status.auth.hasCookie) rows.push(["Cookie 过期", `${describeCookieLife(status.auth.cookieLife)}（会话级 = 浏览器关掉就没了；这是浏览器侧的上界，不是登录态寿命）`]);
						rows.push(["指纹头", status.auth.hasFingerprint ? "✅ 已捕获（x-hif-* / x-client-*）" : "未捕获 —— 同上，已实测可用"]);
						rows.push(["PoW WASM", status.auth.wasmHost || "默认地址"]);
						rows.push(["token 长度", `${status.auth.tokenLength ?? 0} 字符`]);
						if (status.validation) rows.push(["服务端校验", status.validation.ok ? "通过" : `失败：${status.validation.error ?? ""}`]);
						const verifiedAt = status.auth?.lastVerifiedAt;
						const verifyError = status.auth?.lastVerifyError;
						if (verifyError) rows.push(["登录态探活", `❌ ${relTime(verifyError.at)}失败：${verifyError.message}（可能已过期，建议重新登录）`]);
						else if (verifiedAt) rows.push(["登录态探活", `✅ ${relTime(verifiedAt)}通过（后台定时校验，零额度）`]);
						const interval = status.config?.minRequestIntervalMs;
						if (interval !== void 0) rows.push(["请求节流", status.config?.allowConcurrent ? `⚠️ 允许并发 · 间隔 ${interval}ms（并发生成有账号级限制风险，不建议）` : `串行（一次只发一条）· 间隔 ${interval}ms`]);
					} else {
						const available = status.loginCapability;
						rows.push(["登录方式", available ? available.canOpenWindow ? "插件自开窗口（Electron 主进程，带指纹伪装）" : available.browser ? `用真实浏览器登录（${available.browser} + 调试协议，自动读取凭证）` : "未找到 Edge/Chrome：请用「用我的默认浏览器登录」+ 手动粘贴 token" : electron ? "可开浏览器窗口" : "请用「用我的默认浏览器登录」+ 手动粘贴 token"]);
					}
					if (status.lastLoginResult) rows.push(["最近结果", `${status.lastLoginResult.message} · ${new Date(status.lastLoginResult.at).toLocaleTimeString()}`]);
					if (status.loginWindowOpen && status.loginProgress?.captured) {
						const captured = status.loginProgress.captured;
						rows.push(["捕获进度", `token ${captured.token ? "✓" : "…"} / cookie ${captured.cookie ? "✓" : "…"} / 指纹 ${captured.fingerprint ? "✓" : "…"}`]);
					}
					if (status.loginProgress?.lastError && status.loginWindowOpen) rows.push(["窗口提示", status.loginProgress.lastError]);
					if (status.fingerprint && status.fingerprint.stripped.length > 0) rows.push(["指纹清理", `已剔除 ${status.fingerprint.stripped.length} 个 Electron 头：${status.fingerprint.stripped.join(", ")}`]);
					else if (status.loginWindowOpen) rows.push(["指纹清理", "窗口已打开（尚未命中需要清理的头）"]);
					if (status.fingerprint?.pageUa) {
						const bad = /electron/i.test(status.fingerprint.pageUa);
						rows.push(["页面看到 UA", `${bad ? "⚠️ 仍含 Electron：" : "✅ "}${status.fingerprint.pageUa}`]);
					}
					if (status.fingerprint?.pageBrands?.length) {
						const dirty = status.fingerprint.pageBrands.filter((b) => /electron|dsh/i.test(b));
						rows.push(["页面品牌", `${dirty.length ? `⚠️ ${dirty.join(", ")}` : "✅ "}${status.fingerprint.pageBrands.join(", ")}`]);
					}
					if (status.fingerprint?.pageWebdriver !== void 0) rows.push(["webdriver", status.fingerprint.pageWebdriver ? "⚠️ true（自动化痕迹）" : "✅ false"]);
					renderKv(rows);
					browserBtn.disabled = false;
					const capability = status.loginCapability;
					if (capability) {
						const mode = capability.canOpenWindow ? "可开 Electron 窗口" : capability.browser ? `无窗口 API（${capability.processType} 进程）→ 用真实浏览器` : `无窗口 API（${capability.processType} 进程）且未找到 Edge/Chrome`;
						rows.push(["宿主进程", `${capability.processType} · ${mode}`]);
						browserBtn.textContent = capability.canOpenWindow ? "浏览器窗口登录" : capability.browser ? `用 ${capability.browser} 登录` : "浏览器窗口登录";
						browserBtn.disabled = !capability.canOpenWindow && !capability.browser;
						browserBtn.title = capability.canOpenWindow ? "插件自己开窗口（带指纹伪装）" : capability.browser ? `拉起真实的 ${capability.browser}（独立 profile）完成登录，插件通过调试协议读取登录态` : "既不能开窗口也没找到 Edge/Chrome：请用「用我的默认浏览器登录」+ 手动粘贴 Token";
					} else {
						browserBtn.disabled = !electron;
						browserBtn.textContent = windowOpen ? "登录窗口已打开" : "浏览器窗口登录";
						browserBtn.title = electron ? "" : "当前宿主无法开窗：请用「用我的默认浏览器登录」+ 手动粘贴 Token";
					}
					accountLine.textContent = "";
					if (loggedIn) {
						accountLine.append(el("div", "k", "账号"), el("div", void 0, status.auth.display || "（未获取到账号信息）"));
						accountLine.append(el("div", "k", "登录时间"), el("div", void 0, status.auth.capturedAt ? new Date(status.auth.capturedAt).toLocaleString() : "未知"));
					} else accountLine.append(el("div", "k", "状态"), el("div", void 0, "未登录（没有可退出的账号）"));
					logoutBtn.disabled = !loggedIn;
					switchBtn.disabled = !loggedIn || !electron;
					switchBtn.title = electron ? "" : "当前不是 Electron 桌面端：请先「退出当前账号」，再手动粘贴另一个账号的 token";
					if (modelSelect.options.length !== status.models.length) {
						modelSelect.textContent = "";
						for (const model of status.models) {
							const option = document.createElement("option");
							option.value = model.id;
							option.textContent = model.name;
							modelSelect.append(option);
						}
					}
					modelsList.textContent = "";
					for (const model of status.models) {
						const item = el("li");
						item.append(el("div", "name", model.name));
						const ctxLabel = model.contextWindow >= 1048576 ? `${(model.contextWindow / 1048576).toFixed(0)}M` : `${Math.round(model.contextWindow / 1024)}K`;
						item.append(el("div", "id", `${model.id} · thinking ${model.thinking ? "开" : "关"} · 上下文 ${ctxLabel} token（标称）`));
						item.append(el("div", "id", model.description));
						modelsList.append(item);
					}
					modelsHint.textContent = `两条是同一个「快速模式」的思考开关两档预设（也可在模型选择器的推理强度里切换）。图片输入直接可用（走网页端文件上传通道）。每次调用会新建并删除临时会话；prompt 字符上限 ${status.config?.maxPromptChars ?? 0}（服务端硬上限 2621440 字符，另附件 token 预算 890880 —— 后者常被误读成「上下文窗口」）。`;
				};
				const refresh = async (light = true) => {
					try {
						const status = await api(`/status${light ? "?light=1" : ""}`);
						if (disposed) return;
						applyStatus(status);
					} catch (error) {
						showMessage(`状态读取失败：${error?.message ?? error}`, "err");
					}
				};
				const gateCard = el("div", "dsw-card");
				gateCard.append(el("div", "dsw-cardhead", "请求节流（防风控）"));
				const rangeInput = () => {
					const input = el("input", "dsw-range");
					input.type = "range";
					input.min = "0";
					input.max = "30000";
					input.step = "500";
					return input;
				};
				const concRow = el("div", "dsw-gate-row");
				const concLabel = el("label", "dsw-switch");
				const concInput = el("input");
				concInput.type = "checkbox";
				const concTrack = el("span", "dsw-switch-track");
				concLabel.append(concInput, concTrack, el("span", void 0, "允许并发（同一账号同时发两条）"));
				concRow.append(concLabel);
				gateCard.append(concRow);
				const minRow = el("div", "dsw-gate-row");
				minRow.append(el("span", "dsw-gate-label", "间隔下限"));
				const minRange = rangeInput();
				const minValue = el("span", "dsw-gate-value", "—");
				minRow.append(minRange, minValue);
				gateCard.append(minRow);
				const maxRow = el("div", "dsw-gate-row");
				maxRow.append(el("span", "dsw-gate-label", "间隔上限"));
				const maxRange = rangeInput();
				const maxValue = el("span", "dsw-gate-value", "—");
				maxRow.append(maxRange, maxValue);
				gateCard.append(maxRow);
				const intervalHint = el("p", "dsw-hint", "");
				gateCard.append(intervalHint);
				const presetRow = el("div", "dsw-gate-row");
				gateCard.append(presetRow);
				const promptRow = el("div", "dsw-gate-row");
				promptRow.append(el("span", "dsw-gate-label", "prompt 上限"));
				const promptRange = el("input", "dsw-range");
				promptRange.type = "range";
				promptRange.setAttribute("aria-label", "prompt 字符上限");
				promptRange.title = "每次请求最多发送多少字符（含工具目录与全部历史）";
				const promptValue = el("span", "dsw-gate-value", "—");
				promptRow.append(promptRange, promptValue);
				gateCard.append(promptRow);
				const promptHint = el("p", "dsw-hint", "");
				gateCard.append(promptHint);
				/** 字符数 → 「万字符」。界面上出现一长串 0 没人看得出差别。 */
				const fmtChars = (n) => `${Number.isFinite(n) ? (n / 1e4).toFixed(n % 1e4 === 0 ? 0 : 1) : "—"} 万字符`;
				const paintPromptCap = () => {
					const chars = Number(promptRange.value);
					promptValue.textContent = fmtChars(chars);
					const level = chars >= 12e5 ? "偏高" : chars >= 6e5 ? "中等" : "省 token";
					promptHint.textContent = `每次请求最多发送 ${fmtChars(chars)}（${level}）。网页端是无状态的，每一轮都会把整段对话历史重新发一遍：上限越大，模型越不容易「忘事」，但单次消耗的 token 也越多。长任务建议调小，或拆成多个会话（新会话从零开始，单次最省）。`;
				};
				const tokenNote = el("p", "dsw-hint", "");
				tokenNote.textContent = "说明：DSH 底部的 token 数目前是**按字符估算**的（网页端只回一个「本消息累计 token」，我们还没接进来）；「缓存命中 0%」是因为网页端不提供缓存信息、我们也就没有上报 —— 不代表真的没命中。";
				gateCard.append(tokenNote);
				promptRange.addEventListener("input", paintPromptCap);
				promptRange.addEventListener("change", () => {
					paintPromptCap();
					saveGate({ maxPromptChars: Number(promptRange.value) });
				});
				const cleanupRow = el("div", "dsw-gate-row");
				cleanupRow.append(el("span", "dsw-gate-label", "会话清理"));
				const cleanupBtns = {};
				for (const pair of [
					["immediate", "立即"],
					["deferred", "延迟（推荐）"],
					["keep", "不删"]
				]) {
					const key = pair[0];
					const btn = el("button", "dsw-btn ghost dsw-preset", pair[1]);
					btn.addEventListener("click", () => void saveGate({ sessionCleanup: key }));
					cleanupBtns[key] = btn;
					cleanupRow.append(btn);
				}
				gateCard.append(cleanupRow);
				const cleanupHint = el("p", "dsw-hint", "");
				gateCard.append(cleanupHint);
				const cleanupRanges = el("div");
				cleanupRanges.style.display = "none";
				gateCard.append(cleanupRanges);
				/** 一对「上下限」滑块：一行两个 range + 右侧合成值。拖动中只更新数字，松手才提交。 */
				const rangePair = (label, bounds, step, format, commit) => {
					const row = el("div", "dsw-gate-row");
					row.append(el("span", "dsw-gate-label", label));
					const lo = el("input", "dsw-range");
					const hi = el("input", "dsw-range");
					for (const [input, which] of [[lo, "下限"], [hi, "上限"]]) {
						input.type = "range";
						input.min = String(bounds.min);
						input.max = String(bounds.max);
						input.step = step;
						input.setAttribute("aria-label", `${label}${which}`);
						input.title = `${label}${which}`;
					}
					const value = el("span", "dsw-gate-pair-value", "—");
					const paint = () => {
						value.textContent = format(Number(lo.value), Number(hi.value));
					};
					const onInput = () => {
						if (Number(lo.value) > Number(hi.value)) {
							const swap = lo.value;
							lo.value = hi.value;
							hi.value = swap;
						}
						paint();
					};
					const onCommit = () => commit(Number(lo.value), Number(hi.value));
					lo.addEventListener("input", onInput);
					hi.addEventListener("input", onInput);
					lo.addEventListener("change", onCommit);
					hi.addEventListener("change", onCommit);
					const pair = el("div", "dsw-range-pair");
					pair.append(lo, hi);
					row.append(pair, value);
					return {
						row,
						set: (lo2, hi2) => {
							lo.value = String(lo2);
							hi.value = String(hi2);
							paint();
						}
					};
				};
				const batchPair = rangePair("攒够数量", {
					min: 1,
					max: 50
				}, "1", (lo, hi) => `${lo}~${hi} 个`, (lo, hi) => void saveGate({ cleanupBatch: {
					min: lo,
					max: hi
				} }));
				const delayPair = rangePair("最长等待", {
					min: 5,
					max: 600
				}, "5", (lo, hi) => `${lo}~${hi} 秒`, (lo, hi) => void saveGate({ cleanupDelayMs: {
					min: Math.round(lo * 1e3),
					max: Math.round(hi * 1e3)
				} }));
				const gapPair = rangePair("删除间隔", {
					min: 0,
					max: 60
				}, "0.1", (lo, hi) => hi <= 0 ? "不等待" : `${lo.toFixed(1)}~${hi.toFixed(1)} 秒`, (lo, hi) => void saveGate({ cleanupGapMs: {
					min: Math.round(lo * 1e3),
					max: Math.round(hi * 1e3)
				} }));
				cleanupRanges.append(batchPair.row, delayPair.row, gapPair.row);
				cleanupRanges.append(el("p", "dsw-hint", "上面三个都是「下限 ~ 上限」：实际取值每次在区间内随机抽 —— 攒批阈值与最长等待每轮清理重抽、删除间隔每删一个重抽。这样\"什么时候动手删\"就没有固定规律了。"));
				cleanupRanges.append(el("p", "dsw-hint", "「删除间隔」只在逐个删除时起作用：优先走一个请求批量删；若服务端不接受批量删（会自动退化为逐个删），相邻两个删除请求之间就按这个间隔停一下 —— 避免\"一下子连发几十个删除请求\"。"));
				gateCard.append(el("p", "dsw-hint", "并发默认关闭：DSH 的会话标题生成会与主回答同时发往同一账号，网页端同一账号同时只能生成一条，实测双窗口并发不到 6 分钟即触发账号级限制（1 天）。"));
				const gateMsg = el("p", "dsw-hint dsw-gate-msg", "");
				gateCard.append(gateMsg);
				gatePane.append(gateCard);
				const ledgerCard = el("div", "dsw-card");
				const ledgerHead = el("div", "dsw-cardhead");
				ledgerHead.append(el("span", "name", "调用台账"));
				const ledgerBadge = el("span", "dsw-badge off", "近 24 小时");
				ledgerHead.append(ledgerBadge);
				ledgerCard.append(ledgerHead);
				ledgerCard.append(el("p", "dsw-hint", "本地记录每次调用的结果（不含任何对话内容与凭证）。用来判断节流是否真的在起作用。"));
				const ledgerKv = el("div", "dsw-kv");
				ledgerCard.append(ledgerKv);
				const ledgerSparkBox = el("div");
				ledgerCard.append(ledgerSparkBox);
				const ledgerRow = el("div", "dsw-row");
				const ledgerRefreshBtn = el("button", "dsw-btn ghost", "刷新台账");
				ledgerRow.append(ledgerRefreshBtn);
				ledgerCard.append(ledgerRow);
				const ledgerMsg = el("p", "dsw-hint dsw-gate-msg", "");
				ledgerCard.append(ledgerMsg);
				gatePane.append(ledgerCard);
				/** 24 根小柱：每小时调用量。高度按最大值归一，失败多的时段用红色。 */
				const sparkSvg = (hourly, failedHours) => {
					const values = hourly.length ? hourly : [0];
					const max = Math.max(1, ...values);
					const barW = 100 / values.length;
					let out = "<svg class=\"dsw-spark\" viewBox=\"0 0 100 100\" preserveAspectRatio=\"none\">";
					values.forEach((value, index) => {
						const height = value / max * 100;
						const cls = failedHours.has(index) ? " class=\"bad\"" : "";
						out += `<rect${cls} x="${(index * barW).toFixed(2)}" y="${(100 - height).toFixed(2)}" width="${(barW * .7).toFixed(2)}" height="${Math.max(height, value > 0 ? 3 : .6).toFixed(2)}" rx="1"></rect>`;
					});
					out += "</svg>";
					return out;
				};
				const fmtMs = (ms) => ms >= 6e4 ? `${(ms / 6e4).toFixed(1)} 分` : `${(ms / 1e3).toFixed(1)} 秒`;
				const renderLedger = (data) => {
					const calls = Number(data?.calls ?? 0);
					ledgerBadge.textContent = `近 ${data?.hours ?? 24} 小时`;
					ledgerBadge.className = `dsw-badge ${calls > 0 ? "on" : "off"}`;
					ledgerKv.textContent = "";
					ledgerSparkBox.textContent = "";
					if (calls === 0) {
						ledgerMsg.textContent = "还没有记录 —— 跑一次对话后回来看。";
						return;
					}
					const push = (key, value) => {
						ledgerKv.append(el("div", "k", key), el("div", void 0, value));
					};
					push("调用次数", `${calls}（成功 ${data.succeeded ?? 0} / 失败 ${data.failed ?? 0}）`);
					const gaps = data.gaps;
					push("相邻对话间隔", gaps ? `中位 ${fmtMs(gaps.p50)} · p90 ${fmtMs(gaps.p90)} · 最短 ${fmtMs(gaps.min)}（样本 ${gaps.samples}）` : "样本不足");
					if (gaps && gaps.min < 1500) ledgerMsg.textContent = `⚠️ 出现过 ${fmtMs(gaps.min)} 的极短间隔 —— 检查一下节流是否被关掉了。`;
					const failures = data.failures ?? {};
					push("失败分类", Object.keys(failures).length ? Object.entries(failures).map(([key, count]) => `${key} ${count}`).join(" · ") : "无");
					push("台账占用", `${data.footprint?.files ?? 0} 个文件 · ${Math.round((data.footprint?.bytes ?? 0) / 1024)} KB`);
					const hourly = Array.isArray(data.hourly) ? data.hourly : [];
					ledgerSparkBox.innerHTML = sparkSvg(hourly, /* @__PURE__ */ new Set());
					ledgerSparkBox.append(el("p", "dsw-hint", `每小时调用量（最近 1 小时在最右，峰值 ${Math.max(0, ...hourly)} 次）`));
				};
				const loadLedger = async () => {
					try {
						renderLedger(await api("/ledger?hours=24"));
					} catch (error) {
						ledgerMsg.textContent = `台账读取失败：${error?.message ?? error}`;
					}
				};
				ledgerRefreshBtn.addEventListener("click", () => void loadLedger());
				const transportCard = el("div", "dsw-card");
				transportCard.append(el("div", "dsw-cardhead", "传输层（指纹）"));
				const transportRow = el("div", "dsw-gate-row");
				transportRow.append(el("span", "dsw-gate-label", "请求从哪出去"));
				const transportBtns = {};
				for (const pair of [["chromium", "Chromium 网络栈（推荐）"], ["node", "Node"]]) {
					const key = pair[0];
					const btn = el("button", "dsw-btn ghost dsw-preset", pair[1]);
					btn.addEventListener("click", () => void saveTransport(key));
					transportBtns[key] = btn;
					transportRow.append(btn);
				}
				transportCard.append(transportRow);
				const transportHint = el("p", "dsw-hint", "");
				transportCard.append(transportHint);
				const transportProxyHint = el("p", "dsw-hint", "");
				transportCard.append(transportProxyHint);
				const testRow = el("div", "dsw-gate-row");
				const transportTestBtn = el("button", "dsw-btn ghost", "测试传输层（零额度）");
				testRow.append(transportTestBtn);
				transportCard.append(testRow);
				const transportTestOut = el("div", "dsw-msg", "");
				transportTestOut.style.display = "none";
				transportCard.append(transportTestOut);
				const transportMsg = el("p", "dsw-hint dsw-gate-msg", "");
				transportCard.append(transportMsg);
				transportPane.append(transportCard);
				const aboutCard = el("div", "dsw-card");
				aboutCard.append(el("div", "dsw-cardhead", "版本与更新"));
				const versionKv = el("div", "dsw-kv");
				aboutCard.append(versionKv);
				const updateRow = el("div", "dsw-row");
				updateRow.style.marginTop = "8px";
				const updateBtn = el("button", "dsw-btn ghost", "检查更新");
				updateRow.append(updateBtn);
				aboutCard.append(updateRow);
				const updateMsg = el("p", "dsw-hint dsw-gate-msg", "");
				aboutCard.append(updateMsg);
				aboutCard.append(el("p", "dsw-hint", "插件装不了包，所以这里只做\"检查 + 给链接\"。GitHub 在国内可能连不上，检查失败是正常的。"));
				aboutPane.append(aboutCard);
				const renderVersion = (info) => {
					versionKv.textContent = "";
					versionKv.append(el("div", "k", "当前版本"), el("div", void 0, info?.current || "未知"));
					versionKv.append(el("div", "k", "登录态探活"), el("div", void 0, info?.probeIntervalMs > 0 ? `每 ${Math.round(info.probeIntervalMs / 6e4)} 分钟一次（只读、零额度）` : "已关闭"));
				};
				updateBtn.addEventListener("click", () => {
					(async () => {
						updateBtn.disabled = true;
						updateMsg.textContent = "正在检查……";
						try {
							const result = await api("/update-check", {
								method: "POST",
								body: "{}"
							});
							if (!result?.ok) {
								updateMsg.textContent = `检查失败：${result?.error ?? "未知原因"}`;
								return;
							}
							const current = result.current;
							renderVersion({
								current,
								probeIntervalMs
							});
							if (result.hasUpdate) updateMsg.textContent = `发现新版本 ${result.latest}（当前 ${current}）${result.publishedAt ? ` · ${shortTime(result.publishedAt)} 发布` : ""}${result.url ? ` · ${result.url}` : ""}`;
							else updateMsg.textContent = `已是最新版本（${current}）。`;
						} catch (error) {
							updateMsg.textContent = `检查失败：${error?.message ?? error}`;
						} finally {
							updateBtn.disabled = false;
						}
					})();
				});
				const pathsCard = el("div", "dsw-card");
				pathsCard.append(el("div", "dsw-cardhead", "数据位置"));
				pathsCard.append(el("p", "dsw-hint", "插件的本地状态都在 DSH 主目录下，不进通用配置面（避免凭证混进 settings/credentials）。"));
				const pathsKv = el("div", "dsw-kv");
				pathsCard.append(pathsKv);
				pathsCard.append(el("p", "dsw-hint", "账号库里每个文件都是**可完整登录的凭证**；导出的备份同样是明文 —— 账号库卡片里的提示请当真。"));
				aboutPane.append(pathsCard);
				const renderPaths = (paths) => {
					pathsKv.textContent = "";
					const rows = [
						["账号库", paths?.accounts || "（未知）"],
						["账号索引", paths?.webLogin ? `${paths.webLogin}/accounts.json` : "（未知）"],
						["调用台账", paths?.ledger || "（未知）"],
						["导出备份", paths?.webLogin ? `${paths.webLogin}/exports/` : "（未知）"]
					];
					for (const [key, value] of rows) pathsKv.append(el("div", "k", key), el("div", "dsw-path", value));
				};
				const riskCard = el("div", "dsw-card");
				riskCard.append(el("div", "dsw-cardhead", "为什么没有「自动换号」"));
				riskCard.append(el("p", "dsw-hint", "账号库支持一键手动切换，但**刻意不做自动轮换**（检测到限流就自动换一个号继续发）。原因不是保守："));
				riskCard.append(el("p", "dsw-hint", "参考项目切的是「CLI 下次启动用哪个账号」——服务端看不到；而我们每次对话都实时发请求。真人不会在几分钟内换一个账号接着发消息，自动换号是极强的机器行为特征，与本插件在传输层指纹、随机间隔、会话清理上「降低机器可识别性」的努力直接冲突。"));
				riskCard.append(el("p", "dsw-hint", "另外：同一服务商会把多账号关联起来（同设备 / 同 IP / 同指纹 / 相近的行为模式）。一旦被判定为同一人的多开小号，处置通常比单账号超频更重，而且可能波及全部关联账号。所以账号库的目标是「在自己的多个正常账号之间切换更省事」，不是「靠轮换把限流绕过去」。"));
				aboutPane.append(riskCard);
				const applyTransportCard = (info) => {
					if (!info) return;
					const requested = String(info.requested ?? info.effective ?? "chromium");
					const effective = String(info.effective ?? requested);
					for (const key of Object.keys(transportBtns)) transportBtns[key].classList.toggle("active", key === requested);
					const available = info.chromiumAvailable !== false;
					transportBtns.chromium.disabled = !available;
					transportBtns.chromium.title = available ? "" : "本环境拿不到 electron.net.fetch（只有 Electron 的 utility 进程里有）";
					const parts = [effective === "chromium" ? "实际生效：Chromium 网络栈" : "实际生效：Node fetch"];
					if (info.degraded) parts.push("配置要求 Chromium，但本环境不支持，已降级为 Node");
					if (effective === "chromium") parts.push("cipher 列表哈希与 Chrome 一致、ALPN 走 h2");
					transportHint.textContent = parts.join(" · ");
					transportProxyHint.textContent = String(info.hint ?? "");
				};
				const saveTransport = async (kind) => {
					transportMsg.textContent = "切换中……";
					try {
						const result = await api("/transport", {
							method: "POST",
							body: JSON.stringify({ transport: kind })
						});
						if (result?.ok) {
							applyTransportCard(result);
							transportMsg.textContent = `已切换到 ${result.effective === "chromium" ? "Chromium 网络栈" : "Node fetch"}，即时生效` + (result.persisted === false ? "（未能写入配置，重启后会回到上次保存的值）" : "（已写入配置，重启后仍生效）");
						} else transportMsg.textContent = `切换失败：${result?.error ?? "未知原因"}`;
					} catch (error) {
						transportMsg.textContent = `切换失败：${error?.message ?? error}`;
					}
				};
				transportTestBtn.addEventListener("click", () => {
					(async () => {
						transportTestBtn.disabled = true;
						transportTestOut.style.display = "";
						transportTestOut.textContent = "正在探测（指纹 / 流式 / 鉴权）……";
						try {
							const result = await api("/diagnostics/net-fetch", {
								method: "POST",
								body: JSON.stringify({ mode: "probe" })
							});
							const lines = [];
							for (const step of result?.results ?? []) {
								const title = String(step.step ?? "");
								if (title.startsWith("①")) lines.push(`① 指纹  ja4=${step.ja4 ?? "-"}  HTTP=${step.http_version ?? "-"}`);
								else if (title.startsWith("②")) lines.push(`② 流式  ${step.ok ? "支持" : "不支持"}  分片=${step.chunks ?? 0}  abort=${step.abortedEarly ? "生效" : "未生效"}`);
								else if (title.startsWith("③")) lines.push(`③ 鉴权  HTTP ${step.status ?? "-"}  ${step.ok ? "通过" : step.error ?? "未通过"}`);
							}
							transportTestOut.textContent = lines.length ? lines.join("\n") : JSON.stringify(result);
						} catch (error) {
							transportTestOut.textContent = `探测失败：${error?.message ?? error}`;
						} finally {
							transportTestBtn.disabled = false;
						}
					})();
				});
				(async () => {
					try {
						applyTransportCard(await api("/transport"));
					} catch {
						transportMsg.textContent = "传输层设置读取失败（宿主未响应）";
					}
				})();
				loadAccounts();
				loadLedger();
				refresh(true);
				/** 渲染宿主返回的节流设置（含可选档位与清理策略）。 */
				const applyGate = (g) => {
					if (!g) return;
					concInput.checked = !!g.allowConcurrent;
					const cap = String(g.maxIntervalMs ?? 3e4);
					minRange.max = cap;
					maxRange.max = cap;
					const lo = Number(g.minRequestIntervalMs ?? 2e3);
					const hi = Number(g.maxRequestIntervalMs ?? lo);
					minRange.value = String(lo);
					maxRange.value = String(hi);
					minValue.textContent = `${lo}ms`;
					maxValue.textContent = `${hi}ms`;
					intervalHint.textContent = lo === hi ? `固定间隔 ${lo}ms（上下限相等）。建议拉开成区间 —— 固定值方差≈0，是明显的「定时器特征」。` : `实际等待在 ${lo}~${hi}ms 之间随机取值（均值约 ${Math.round((lo + hi) / 2)}ms）。`;
					presetRow.textContent = "";
					presetRow.append(el("span", "dsw-gate-label", "快捷"));
					const presets = g.presets ?? [
						{
							min: 1500,
							max: 2500
						},
						{
							min: 2e3,
							max: 4e3
						},
						{
							min: 5e3,
							max: 9e3
						}
					];
					for (const preset of presets) {
						const isDefault = preset.min === (g.defaultMinIntervalMs ?? 2e3) && preset.max === (g.defaultMaxIntervalMs ?? 4e3);
						const btn = el("button", "dsw-btn ghost dsw-preset", `${preset.min}~${preset.max}ms${isDefault ? "（推荐）" : ""}`);
						btn.addEventListener("click", () => void saveGate({
							minRequestIntervalMs: preset.min,
							maxRequestIntervalMs: preset.max
						}));
						if (isDefault && g.minRequestIntervalMs === preset.min && g.maxRequestIntervalMs === preset.max) btn.classList.add("active");
						presetRow.append(btn);
					}
					const capBounds = g.maxPromptCharsBounds ?? {
						min: 12e4,
						max: 15e5
					};
					promptRange.min = String(capBounds.min);
					promptRange.max = String(capBounds.max);
					promptRange.step = "20000";
					promptRange.value = String(g.maxPromptChars ?? g.maxPromptCharsDefault ?? capBounds.max);
					paintPromptCap();
					const mode = g.cleanup?.mode ?? "deferred";
					for (const key of Object.keys(cleanupBtns)) cleanupBtns[key].classList.toggle("active", key === mode);
					const showRanges = mode === "deferred";
					cleanupRanges.style.display = showRanges ? "" : "none";
					if (showRanges) {
						const batchRange = g.cleanup?.batchRange ?? g.cleanupDefaults?.batch;
						if (batchRange) batchPair.set(batchRange.min, batchRange.max);
						const delayRange = g.cleanup?.delayRange ?? g.cleanupDefaults?.delayMs;
						if (delayRange) delayPair.set(Math.round(delayRange.min / 1e3), Math.round(delayRange.max / 1e3));
						const gapRange = g.cleanup?.gapRange ?? g.cleanupDefaults?.gapMs;
						if (gapRange) gapPair.set(+(gapRange.min / 1e3).toFixed(1), +(gapRange.max / 1e3).toFixed(1));
					}
					cleanupHint.textContent = mode === "keep" ? "不删：请求最少，但网页端会留下临时会话记录。" : mode === "immediate" ? "立即：调用结束后 1.5 秒删掉（老行为，每轮多一个删除请求）。" : `延迟：这一轮攒够 ${g.cleanup?.batchSize ?? 8} 个、或最多等 ${Math.round((g.cleanup?.delayMs ?? 9e4) / 1e3)} 秒就集中清理，并优先用一个请求批量删 ——减少「每轮建一个立刻删一个」的机器特征。上面三个区间决定"这一轮具体攒几个 / 等多久"。`;
				};
				const saveGate = async (patch) => {
					gateMsg.textContent = "保存中……";
					try {
						const result = await api("/gate", {
							method: "POST",
							body: JSON.stringify(patch)
						});
						if (result?.ok) {
							applyGate(result);
							gateMsg.textContent = `已生效：${result.allowConcurrent ? "允许并发（不推荐）" : "串行"} · 间隔 ${result.minRequestIntervalMs}~${result.maxRequestIntervalMs}ms · 清理 ${result.sessionCleanup ?? result.cleanup?.mode ?? "-"}` + (result.cleanup?.batchRange ? `（阈值 ${result.cleanup.batchRange.min}~${result.cleanup.batchRange.max} 个 · 等待 ${Math.round((result.cleanup.delayRange?.min ?? 0) / 1e3)}~${Math.round((result.cleanup.delayRange?.max ?? 0) / 1e3)}s · ` + (result.cleanup.gapRange ? `删除间隔 ${(result.cleanup.gapRange.min / 1e3).toFixed(1)}~${(result.cleanup.gapRange.max / 1e3).toFixed(1)}s` : "删除间隔关") + "）" : "") + ` · prompt 上限 ${fmtChars(Number(result.maxPromptChars ?? 0))}` + (result.persisted === false ? ` ⚠️ ${result.warning ?? "未能写入配置"}` : "（已写入配置，重启后仍生效）");
						} else gateMsg.textContent = `保存失败：${result?.error ?? "未知原因"}`;
					} catch (error) {
						gateMsg.textContent = `保存失败：${error?.message ?? error}`;
					}
				};
				concInput.addEventListener("change", () => void saveGate({ allowConcurrent: concInput.checked }));
				minRange.addEventListener("input", () => {
					minValue.textContent = `${minRange.value}ms`;
				});
				maxRange.addEventListener("input", () => {
					maxValue.textContent = `${maxRange.value}ms`;
				});
				minRange.addEventListener("change", () => void saveGate({ minRequestIntervalMs: Number(minRange.value) }));
				maxRange.addEventListener("change", () => void saveGate({ maxRequestIntervalMs: Number(maxRange.value) }));
				(async () => {
					try {
						applyGate(await api("/gate"));
					} catch {
						gateMsg.textContent = "节流设置读取失败（宿主未响应）";
					}
				})();
				let boostUntil = 0;
				recoverBtn.addEventListener("click", () => {
					(async () => {
						recoverBtn.disabled = true;
						showMessage("正在从已登录窗口分区读取凭证……（复用上次登录态，不需要重新登录）");
						try {
							const result = await api("/login/recover", {
								method: "POST",
								body: "{}"
							});
							if (result?.ok) showMessage(`${result.verified ? "✅" : "⚠️"} ${result.message}`, result.verified ? "ok" : "");
							else showMessage(`❌ ${result?.message ?? "恢复失败"}`, "err");
						} catch (error) {
							showMessage(`恢复失败：${error?.message ?? error}`, "err");
						}
						recoverBtn.disabled = false;
						await refresh(false);
					})();
				});
				externalBtn.addEventListener("click", () => {
					(async () => {
						externalBtn.disabled = true;
						try {
							const result = await api("/login/external", {
								method: "POST",
								body: "{}"
							});
							if (result?.ok) showMessage(`已用系统默认浏览器打开 ${result.url}\n① 在浏览器里正常登录；②按 F12 → Console，粘贴下方「手动粘贴 Token」卡里的那行命令；③ 把打印出来的结果粘到那张卡的输入框 → 点「保存并验证」。`);
							else showMessage(`打开失败：${result?.message ?? "未知原因"}；请手动在浏览器访问 ${result?.url ?? "https://chat.deepseek.com"}`, "err");
						} catch (error) {
							showMessage(`打开失败：${error?.message ?? error}`, "err");
						}
						externalBtn.disabled = false;
					})();
				});
				browserBtn.addEventListener("click", () => {
					(async () => {
						browserBtn.disabled = true;
						showMessage("正在启动浏览器……若是真实浏览器，请在其中登录 DeepSeek（登录成功后会自动捕获，不用复制粘贴）。");
						try {
							const result = await api("/login/browser", {
								method: "POST",
								body: "{}"
							});
							if (result?.mode === "browser") {
								if (result.ok) showMessage(`${result.verified ? "✅" : "⚠️"} ${result.message}${result.display ? `（${result.display}）` : ""}`, result.verified ? "ok" : "");
								else showMessage(`❌ ${result.message ?? `登录未完成（${result.reason ?? "未知"}）`}`, "err");
							} else if (!result?.started) showMessage(result?.reason === "not-electron" ? "当前宿主进程无法开 Electron 窗口，且没找到可用的 Edge/Chrome：请用「用我的默认浏览器登录」+ 手动粘贴 Token。" : `打开失败：${result?.reason ?? "未知原因"}`, "err");
							else showMessage("登录窗口已打开，正在旁路捕获登录凭证……");
						} catch (error) {
							showMessage(`打开登录窗口失败：${error?.message ?? error}`, "err");
						}
						boostUntil = Date.now() + 3e5;
						await refresh(false);
					})();
				});
				tokenBtn.addEventListener("click", () => {
					(async () => {
						const raw = tokenInput.value.trim();
						if (!raw) {
							showMessage("请先粘贴 userToken", "err");
							return;
						}
						const [tokenLine, ...rest] = raw.split("\n");
						const token = tokenLine.trim();
						const cookie = rest.join(" ").trim();
						tokenBtn.disabled = true;
						showMessage("正在校验 token……");
						try {
							const result = await api("/login/token", {
								method: "POST",
								body: JSON.stringify({
									token,
									cookie
								})
							});
							if (result?.ok) {
								if (result.error) showMessage(`⚠️ ${result.error}`, "");
								else showMessage(`✅ ${result.display ? `账号 ${result.display} · ` : ""}token 校验通过，已保存`, "ok");
								tokenInput.value = "";
							} else showMessage(`❌ 校验失败：${result?.error ?? "未知原因"}`, "err");
						} catch (error) {
							showMessage(`保存失败：${error?.message ?? error}`, "err");
						}
						tokenBtn.disabled = false;
						await refresh(false);
					})();
				});
				/**
				* 二次确认：退出账号是不可逆操作（凭证 + 浏览器登录态都会被清），
				* 所以第一次点击只把按钮变成「确认退出？」，3 秒内再点一次才真的执行。
				* 不用 window.confirm（插件面板里被宿主拦截的风险，且样式不可控）。
				*/
				const armConfirm = (button, label, confirmLabel, run) => {
					let armed = false;
					let timer;
					const reset = () => {
						armed = false;
						if (timer !== void 0) window.clearTimeout(timer);
						button.textContent = label;
						button.classList.remove("armed");
					};
					button.textContent = label;
					button.addEventListener("click", () => {
						if (!armed) {
							armed = true;
							button.textContent = confirmLabel;
							button.classList.add("armed");
							timer = window.setTimeout(reset, 3e3);
							return;
						}
						reset();
						run();
					});
				};
				const doLogout = (thenLogin) => {
					(async () => {
						logoutBtn.disabled = true;
						switchBtn.disabled = true;
						try {
							await api("/logout", {
								method: "POST",
								body: "{}"
							});
							tokenInput.value = "";
							showMessage(thenLogin ? "已退出当前账号，正在打开登录窗口……" : "已退出当前账号：本地凭证与浏览器登录态都已清除。");
							await refresh(false);
							if (thenLogin) {
								const result = await api("/login/browser", {
									method: "POST",
									body: "{}"
								});
								if (result?.started === false) showMessage(`已退出账号；打开登录窗口失败：${result?.reason ?? "未知原因"}（可改用手动粘贴 token）`, "err");
								else {
									boostUntil = Date.now() + 18e4;
									showMessage("已退出账号，登录窗口已打开：请在窗口里登录**其它账号**，凭证会自动捕获。");
								}
							}
						} catch (error) {
							showMessage(`退出失败：${error?.message ?? error}`, "err");
						} finally {
							await refresh(false);
						}
					})();
				};
				armConfirm(logoutBtn, "退出当前账号", "确认退出？", () => doLogout(false));
				armConfirm(switchBtn, "退出并登录其它账号", "确认退出并换号？", () => doLogout(true));
				testBtn.addEventListener("click", () => {
					(async () => {
						testBtn.disabled = true;
						testOut.style.display = "block";
						testOut.className = "dsw-msg";
						testOut.textContent = "请求中……（首次调用要解 PoW，可能需要几秒）";
						try {
							const result = await api("/test", {
								method: "POST",
								body: JSON.stringify({ model: modelSelect.value })
							});
							if (result?.ok) {
								testOut.className = "dsw-msg ok";
								testOut.textContent = `✅ ${result.ms}ms · ${result.model}\n${result.text || "(空响应)"}${result.reasoning ? `\n\n[思考] ${result.reasoning}` : ""}`;
							} else {
								testOut.className = "dsw-msg err";
								testOut.textContent = `❌ ${result?.code ? `[${result.code}] ` : ""}${result?.error ?? "失败"}`;
							}
						} catch (error) {
							testOut.className = "dsw-msg err";
							testOut.textContent = `❌ ${error?.message ?? error}`;
						}
						testBtn.disabled = false;
					})();
				});
				refreshBtn.addEventListener("click", () => void refresh(false));
				root.append(page);
				refresh(false);
				const countdownTimer = window.setInterval(paintLimit, 3e4);
				timer = window.setInterval(() => {
					if (windowOpen || Date.now() < boostUntil) {
						refresh(true);
						return;
					}
					if (Math.random() < .15) refresh(false);
				}, 2e3);
				return () => {
					disposed = true;
					if (timer !== void 0) window.clearInterval(timer);
					window.clearInterval(countdownTimer);
				};
			}, []);
			return (0, react.createElement)("div", { ref: hostRef });
		}
		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "deepseek-web-login",
				order: 46,
				label: () => "DeepSeek 网页登录"
			}, () => (0, react.createElement)(Panel))), "deepseek-web-login: settings page");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map