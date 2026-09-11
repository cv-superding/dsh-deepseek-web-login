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
		const styles = `
.dsw-page{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.65;padding:14px 16px;max-width:760px;color:var(--theme-text,#ddd)}
.dsw-title{margin:0 0 4px;font-size:13px;font-weight:600}
.dsw-sub{color:var(--theme-text-secondary,#8b93a3);font-size:11px;margin:0 0 14px}
.dsw-card{border:1px solid var(--theme-border,#2a2f3a);border-radius:10px;padding:12px 14px;margin-bottom:12px;background:var(--theme-input-bg,#151922)}
.dsw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsw-badge{font-size:10px;padding:2px 8px;border-radius:10px;white-space:nowrap}
.dsw-badge.on{background:rgba(46,204,113,.16);color:#2ecc71}
.dsw-badge.off{background:rgba(241,196,15,.14);color:#f1c40f}
.dsw-badge.err{background:rgba(217,51,51,.16);color:#e05a5a}
.dsw-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}
.dsw-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.dsw-btn.danger{background:transparent;border:1px solid #d33;color:#e05a5a}
.dsw-btn.armed{background:#b3261e;border-color:#b3261e;color:#fff;font-weight:600}
.dsw-btn:disabled{opacity:.45;cursor:not-allowed}
.dsw-input,.dsw-area{width:100%;box-sizing:border-box;background:var(--theme-bg,#0f1115);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:6px 8px;font-size:12px;font-family:inherit}
.dsw-area{min-height:64px;resize:vertical}
.dsw-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin-top:8px}
.dsw-kv .k{color:var(--theme-text-secondary,#8b93a3)}
.dsw-msg{margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--theme-bg,#0f1115);border:1px solid var(--theme-border,#333);white-space:pre-wrap;max-height:200px;overflow:auto;font-size:11px}
.dsw-msg.err{border-color:#6b2b2b;color:#ffb4b4}
.dsw-msg.ok{border-color:#2b6b45;color:#a8e6c0}
.dsw-models{list-style:none;margin:6px 0 0;padding:0}
.dsw-models li{padding:6px 0;border-top:1px dashed var(--theme-border,#2a2f3a)}
.dsw-models .name{font-weight:600}
.dsw-models .id{color:var(--theme-text-secondary,#8b93a3);font-size:11px}
.dsw-hint{color:var(--theme-text-secondary,#8b93a3);font-size:11px;margin:6px 0 0}
.dsw-code{background:var(--theme-bg,#0f1115);border:1px solid var(--theme-border,#333);border-radius:6px;padding:6px 8px;display:block;margin:4px 0;overflow-x:auto;font-size:11px}
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
				const loginHead = el("div", "dsw-row");
				const loginTitle = el("div");
				loginTitle.append(el("span", "name", "登录状态"), document.createTextNode(" "));
				const badge = el("span", "dsw-badge off", "未登录");
				loginTitle.append(badge);
				loginHead.append(loginTitle);
				loginCard.append(loginHead);
				const statusKv = el("div", "dsw-kv");
				loginCard.append(statusKv);
				const accountCard = el("div", "dsw-card");
				accountCard.append(el("div", "name", "当前账号"));
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
				const recoverBtn = el("button", "dsw-btn ghost", "从已登录窗口恢复");
				const refreshBtn = el("button", "dsw-btn ghost", "刷新状态");
				loginActions.append(browserBtn, recoverBtn, refreshBtn);
				loginCard.append(loginActions);
				loginCard.append(el("p", "dsw-hint", "「从已登录窗口恢复」= 复用上次登录过的窗口分区直接取凭证（免重新登录），凭证丢失时用它救急。"));
				page.append(loginCard);
				const tokenCard = el("div", "dsw-card");
				tokenCard.append(el("div", "name", "手动粘贴 Token（可选路径）"));
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
				testCard.append(el("div", "name", "连通性测试"));
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
				modelsCard.append(el("div", "name", "可用模型（网页免费）"));
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
						rows.push(["Cookie", status.auth.hasCookie ? "已捕获" : "未捕获（可能仍可用）"]);
						rows.push(["指纹头", status.auth.hasFingerprint ? "已捕获" : "未捕获"]);
						rows.push(["PoW WASM", status.auth.wasmHost || "默认地址"]);
						rows.push(["token 长度", `${status.auth.tokenLength ?? 0} 字符`]);
						if (status.validation) rows.push(["服务端校验", status.validation.ok ? "通过" : `失败：${status.validation.error ?? ""}`]);
					} else rows.push(["登录方式", electron ? "可开浏览器窗口（Electron 主进程）" : "当前为非 Electron 环境，请手动粘贴 token"]);
					if (status.lastLoginResult) rows.push(["最近结果", `${status.lastLoginResult.message} · ${new Date(status.lastLoginResult.at).toLocaleTimeString()}`]);
					if (status.loginWindowOpen && status.loginProgress?.captured) {
						const captured = status.loginProgress.captured;
						rows.push(["捕获进度", `token ${captured.token ? "✓" : "…"} / cookie ${captured.cookie ? "✓" : "…"} / 指纹 ${captured.fingerprint ? "✓" : "…"}`]);
					}
					if (status.loginProgress?.lastError && status.loginWindowOpen) rows.push(["窗口提示", status.loginProgress.lastError]);
					renderKv(rows);
					browserBtn.disabled = !electron;
					browserBtn.textContent = windowOpen ? "登录窗口已打开" : "浏览器窗口登录";
					browserBtn.title = electron ? "" : "当前 DSH 不是 Electron 桌面端，请改用手动粘贴 token";
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
				browserBtn.addEventListener("click", () => {
					(async () => {
						browserBtn.disabled = true;
						showMessage("正在打开登录窗口……在窗口里完成 DeepSeek 登录即可，捕获成功后窗口会自动关闭。");
						try {
							const result = await api("/login/browser", {
								method: "POST",
								body: "{}"
							});
							if (!result?.started) showMessage(result?.reason === "not-electron" ? "当前 DSH 运行在非 Electron 环境，无法自动开窗：请用下方「手动粘贴 Token」。" : `打开失败：${result?.reason ?? "未知原因"}`, "err");
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