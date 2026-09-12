window.__ModuleLoader__.load({
	id: "dsh-deepseek-web-login",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
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
.dsw-code{display:block;margin:6px 0;padding:7px 10px;background:var(--code-bg);border:1px solid var(--bd);
border-radius:8px;font-family:var(--mono);font-size:12px;line-height:1.5;color:var(--fg);
overflow-x:auto;white-space:pre}
.dsw-msg::-webkit-scrollbar,.dsw-code::-webkit-scrollbar,.dsw-area::-webkit-scrollbar{width:8px;height:8px}
.dsw-msg::-webkit-scrollbar-thumb,.dsw-code::-webkit-scrollbar-thumb,.dsw-area::-webkit-scrollbar-thumb{
background:var(--bd2);border-radius:4px}
`;
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
				const sub = el("p", "dsw-sub", "用 chat.deepseek.com 网页版登录态驱动 DSH agent —— 不需要 API Key。provider 路由：deepseek-web");
				page.append(style, title, sub);
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
				const accountHint = el("p", "dsw-hint", "退出会同时清除本地凭证与浏览器分区里的 chat.deepseek.com 登录态（否则「从已登录窗口恢复」会把同一个账号原样抓回来，也无法换号）。");
				accountCard.append(accountHint);
				page.append(accountCard);
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
				page.append(loginCard);
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
				page.append(tokenCard);
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
				page.append(testCard);
				const modelsCard = el("div", "dsw-card");
				modelsCard.append(el("div", "dsw-cardhead", "可用模型（网页免费）"));
				const modelsList = el("ul", "dsw-models");
				modelsCard.append(modelsList);
				const modelsHint = el("p", "dsw-hint", "");
				modelsCard.append(modelsHint);
				page.append(modelsCard);
				const message = el("div", "dsw-msg");
				message.style.display = "none";
				page.append(message);
				const showMessage = (text, kind = "") => {
					message.textContent = text;
					message.className = `dsw-msg${kind ? ` ${kind}` : ""}`;
					message.style.display = "block";
				};
				let loggedIn = false;
				let electron = false;
				let windowOpen = false;
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
					rows.push(["适配器注册", (status.registeredProviders ?? []).includes(status.provider) ? `✅ ${status.provider} 已注册到 llm` : `⚠️ 未在 llm 中找到 ${status.provider}`]);
					if (loggedIn) {
						rows.push(["账号", status.auth.display || "（未获取到账号信息）"]);
						rows.push(["捕获时间", status.auth.capturedAt ? new Date(status.auth.capturedAt).toLocaleString() : "未知"]);
						if (!status.auth.hasCookie && !status.auth.hasFingerprint) rows.push(["凭证来源", "手动粘贴 token（实测：仅凭 Bearer token 即可完成校验/求解/生成）"]);
						else rows.push(["凭证来源", "浏览器登录捕获（token + cookie + 指纹头，登录态通常更耐久）"]);
						rows.push(["Cookie", status.auth.hasCookie ? "✅ 已捕获" : "未捕获 —— 手动 token 模式本就没有（已验证不影响请求；若日后频繁遇到 AUTH/40003，改用「浏览器登录」）"]);
						rows.push(["指纹头", status.auth.hasFingerprint ? "✅ 已捕获（x-hif-* / x-client-*）" : "未捕获 —— 同上，已实测可用"]);
						rows.push(["PoW WASM", status.auth.wasmHost || "默认地址"]);
						rows.push(["token 长度", `${status.auth.tokenLength ?? 0} 字符`]);
						if (status.validation) rows.push(["服务端校验", status.validation.ok ? "通过" : `失败：${status.validation.error ?? ""}`]);
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