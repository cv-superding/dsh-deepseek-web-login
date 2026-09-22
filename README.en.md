<div align="center">

<img src="docs/assets/hero.svg" alt="dsh-deepseek-web-login — drive DSH agents with a chat.deepseek.com web login" width="900">

[中文](README.md) · [**English**](README.en.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-263146?style=flat-square&labelColor=0b1220)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4f46e5?style=flat-square&labelColor=0b1220)](https://github.com/deepseek-ai/deepseek-harness)
[![Provider](https://img.shields.io/badge/provider-deepseek--web-06b6d4?style=flat-square&labelColor=0b1220)](#models)
[![Tests](https://img.shields.io/badge/tests-111%20assertions-10b981?style=flat-square&labelColor=0b1220)](#testing)
[![CI](https://github.com/cv-superding/dsh-deepseek-web-login/actions/workflows/ci.yml/badge.svg)](https://github.com/cv-superding/dsh-deepseek-web-login/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/cv-superding/dsh-deepseek-web-login?style=flat-square&labelColor=0b1220&color=f59e0b)](https://github.com/cv-superding/dsh-deepseek-web-login/releases)
[![Status](https://img.shields.io/badge/status-unofficial%20%C2%B7%20use%20at%20your%20own%20risk-ef4444?style=flat-square&labelColor=0b1220)](#disclaimer)
[![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square&labelColor=0b1220)](#contributing)

**Unofficial DSH plugin: use the chat.deepseek.com web models as a DSH LLM provider — browser-login capture, PoW solving, SSE streaming, prompting-based tool calls, and image input. No API key.**

</div>

---

## What it is

DSH (DeepSeek Harness) reaches models through **provider adapters** on `ctx.llm`. This project implements the
`deepseek-web` provider — it does not call the official API. It reuses your **already logged-in web session**:
proof-of-work challenges, chat sessions, SSE streaming and file upload all go through the web client's
private endpoints.

So you can pick `DeepSeek 网页 · 快速模式` (web fast mode) in the model picker and run DSH agents on the
free web quota.

<img src="docs/assets/architecture.svg" alt="Architecture and data flow" width="1000">

### Diagnostics: transport layer (`net.fetch` / TLS fingerprint)

Web requests currently go out through Node's `fetch` (undici), whose TLS/HTTP2 fingerprint differs
**structurally** from a real browser (measured: JA4 `h1` vs `h2`, no GREASE at all, 3x more ciphers).
To check whether switching to Chromium's network stack is viable, run the probe — **zero quota by
default** (no generation, no messages):

```bash
# The host process HTTP endpoint is only reachable from DSH's own same-origin page,
# so this path goes through a file instead:
echo '{"mode":"probe"}' > "$HOME/.dsh/web-login/probe-request.json"
# Restart DSH; the log will contain  deepseek-web: [net-fetch 探测] {...}
```

| Step | Fields | Pass condition |
|---|---|---|
| ① fingerprint | `ja4` / `http_version` / `http2_hash` | becomes `t13d…h2…` with GREASE = matches Chrome |
| ② streaming | `hasBody` / `chunks` / `abortedEarly` | all true, otherwise SSE is impossible |
| ③ auth | `status` / `body` | 200 with the account readable = headers/cookies pass through |

Use `"mode":"stream"` instead to also verify DeepSeek's SSE end-to-end (**consumes a little quota**).
The file is renamed to `probe-request.json.done-<timestamp>` once consumed, so it runs only once.

## How it works (and why it is not a "reverse proxy")

The two questions we get most: **does it drive the DOM, or intercept the page's requests? Is it a reverse
proxy?** Neither. It builds the requests itself and sends them straight to the web app's private endpoints.
The accurate label is an **unofficial client for the web app's private API**.

| Stage | What happens | How |
| --- | --- | --- |
| **① Login capture** (once) | Opens a browser window on an **isolated profile** for you to sign in, then reads one copy of the headers the page itself sends: `Authorization: Bearer`, domain cookies, the anti-bot headers `x-hif-dliq` / `x-hif-leim`, and a set of `x-client-*` | Electron `webRequest.onBeforeSendHeaders` |
| **② Request building** (every call) | Assembles `POST /api/v0/chat/completion` itself; solves the PoW itself: asks `create_pow_challenge`, computes the answer with the SHA3 WASM, sends it as `x-ds-pow-response` | the plugin's own HTTP client |
| **③ Sending** | Leaves through the **Chromium network stack** by default (Electron `net.fetch`), so TLS / HTTP2 fingerprints match a real browser; can be switched back to Node | see "Transport" below |
| **④ Parsing and bridging** | Decodes the `response/fragments` SSE frames itself and splits thinking from answer text; tool calls use a **prompt-based protocol** (the web app has no native function calling) | in-house parser |

**Only step ① touches anything like "interception"** — and it is a read plus cleaning up our own fingerprints:
the same callback strips the Electron branding (UA and UA-CH) from the headers, because otherwise the page
flags the environment as suspicious. It never rewrites the page's own requests and never forwards anything,
and it only applies during that one login. **Once you are signed in, the window can be closed and the plugin
keeps working.**

### Why it is not a "reverse proxy"

A reverse proxy is an **intermediary**: the client believes it is talking to the origin server while the
request is forwarded through another hop. There is no intermediary here — **the plugin is the client**,
talking to DeepSeek as the web app does. No forwarding layer, and no extra local service to run.

### How it differs from the two common alternatives

| | DOM automation (e.g. cuckoo-code) | Request hooking (browser extension, e.g. deepseek-pp) | This plugin |
| --- | --- | --- | --- |
| **Who sends the request** | **The page** | **The page** | **The plugin itself** |
| Where the session comes from | You sign in inside its window | Your everyday browser's session | Captured once, stored locally |
| When the site is redesigned | Selectors break | Only depends on endpoint paths | Only depends on endpoints, never touches the DOM |
| Browser must stay open | Yes | Yes | **No** |

Both alternatives share one property: **the browser sends the requests**. This plugin is the sender instead.
The trade-off is that endpoint changes require updates; what you get is independence from the DOM and
unattended background operation.

## Screenshots

The settings panel is split into **6 tabs** (one page at a time): **Account** (login status /
current account / **account library** / manual token) · **Models** (available models /
connectivity test) · **Anti-throttle** (request pacing / session cleanup with three ranges / **call ledger**) ·
**Transport** (fingerprint + one-click test) · **Context** (full resend / chained incremental) ·
**About** (version & updates / data locations / risks).
The action-feedback strip sits above the tab bar, so it stays visible from any tab.

Settings panel (real screenshot, taken before the tab split): current account / login status (adapter registration, credential source, PoW WASM, server-side verification) / three login paths (Microsoft Edge · default browser · recover from a logged-in window) / manual token.

<img src="docs/assets/screenshot-settings.png" alt="DSH settings panel · DeepSeek web login (real screenshot)" width="820">

DSH's usage-stats page on the free web channel — 10.4M tokens / 164 calls in a single day:

<img src="docs/assets/screenshot-usage-stats.png" alt="DSH usage stats · deepseek-web free channel" width="820">

## Features

| | |
|---|---|
| 🔐 **Web login, no API key** | Log in normally inside an Electron window on its own persistent partition; the plugin captures the real `Authorization`, cookies, `x-hif-*` fingerprint headers and client version headers on the side (it never touches your password) |
| 🧩 **PoW solving** | `create_pow_challenge` + DeepSeek's own `sha3_wasm_bg.*.wasm` `wasm_solve`, with automatic WASM URL discovery (the hash changes between deployments) |
| 🌊 **Streaming** | Handles both the `response/fragments` format (THINK/RESPONSE) and the direct `thinking_content`/`content` paths, including `{o:"APPEND"}` and bare `{v}` continuations; logical-stream dedup so snapshots never double-emit |
| 🛠 **Tool calling** | The web endpoint has no native function calling → a prompting JSON protocol plus a streaming filter (cross-chunk markers, fenced blocks, multiple calls, false-positive fallback) that synthesizes `tool-call` blocks and `finish: tool-calls`; tool definitions are emitted under a 56k-character budget, and when that is exceeded the **names of the omitted tools are listed** with an instruction not to guess their parameters |
| 🛡 **Drift covered twice** | The instructions explicitly forbid XML/DSML markup (the model then refuses that format by itself), and the parser accepts both the JSON and XML/DSML families (`\|DSML\|` prefix, hyphenated `dsml-` tags, bare `<invoke>`, CDATA) |
| 🩹 **Lenient JSON repair** | Models write Windows paths with single backslashes: `\A` is an illegal escape while `\r` is legal and would silently turn `\resources` into a carriage return. A chain of repair candidates restores paths literally; if nothing parses, the text is passed through — **content is never silently dropped** |
| 🖼 **Image input** | Not native multimodal input: images are uploaded via `/api/v0/file/upload_file` and referenced with `ref_file_ids`. The same image appearing more than once in history is deduplicated (the server rejects duplicate ids). Verified against a generated left-red/right-blue PNG — the model answered "left=red, right=blue" |
| 🧹 **Session hygiene** | One temporary chat session per call, deleted afterwards. Verified: the web chat list is byte-identical before and after |
| 🎛 **Settings panel** | Status, browser login, recover-from-window, manual token, connectivity test (host API at `/deepseek-web-login/api/*`) |
| 🔓 **Logout / switch account** | A dedicated "current account" card: **log out** — also clears the chat.deepseek.com storage inside the Electron partition, so the session is really gone and you can log in as somebody else — plus "log out and sign in as another account". Two-step confirmation, so no accidental logout |

<img src="docs/assets/tool-bridge.svg" alt="Tool-calling protocol bridge" width="1000">

## Quick start

```bash
# A: from the release tarball (recommended, no build step)
dsh plugin --profile desktop add ./dsh-deepseek-web-login-0.1.3.tgz

# B: git install (requires github.com reachability)
dsh plugin --profile desktop add github:cv-superding/dsh-deepseek-web-login
```

`--profile desktop` is the profile used by DSH Desktop (the Electron app); use `--profile web` for a web profile.
Restart DSH — the plugin is assembled as a bundle and loads automatically.

Then: **Settings → DeepSeek 网页登录 → 浏览器窗口登录**, log in normally in the window that opens
(phone / email / verification code all work). The window closes itself once the credentials are captured.
Finally pick provider **`DeepSeek 网页版（免费）`** → `DeepSeek 网页 · 快速模式` in the model picker.

> ⚠️ **One chat window per account**: running several windows against the same account triggers a temporary web-side ban (1 day). Use one account per window, or move the extra windows to another provider — see [Known limitations](#known-limitations).

Credentials live only on your machine (`~/.dsh/web-login/deepseek-auth.json`), never in this repository. The panel's **current account → log out** removes them (and the partition storage) in one click.

In manual-token mode the panel shows "cookie / fingerprint headers not captured" — that is expected for this
path (it only has the Bearer token), and it is verified working end to end: validation, PoW solving and a real
completion all succeed. Switch to browser login if you ever hit frequent `AUTH` / `40003` errors.
> 💡 **The browser-login button clears the previous login state first** — it drives a dedicated
> profile (`~/.dsh/web-login/browser-profile`, which never reads or writes your everyday Edge cookies
> or history), so the window always opens on a clean sign-in page. If you would rather reuse a session
> that is still valid, use **Re-login** on the account row instead — that path deliberately keeps it.

If they are lost, **Recover from the logged-in window** reuses the persistent partition — no re-login needed.

## Models

Taken from the account's own server config (`GET /api/v0/client/settings?scope=model` → `model_configs`,
configVersion 81 at the time of writing): only `default` (fast mode) is enabled and switchable; `expert` and
`vision` are **disabled server-side and merged into fast mode**.

The plugin therefore exposes two entries — which are **not two models** but two presets of the same
`thinking_enabled` switch:

| model id | thinking | Best for |
|---|---|---|
| `deepseek-chat` | off | tool calls, rewriting, retrieval — fastest, cheapest |
| `deepseek-reasoner` | on | math, multi-step debugging, planning — reasons first (streamed as thinking blocks) |

Context (verified field by field on 2026-09-11 via `GET /api/v0/client/settings?scope=model`, configVersion 81):

- Hard per-request input cap: `input_character_limit = 2621440` characters (≈2.5 MiB)
- Attachment (`file_feature`) token budget: `token_limit = 890880` — **this is not the context window**.
  It was once mistaken for one (890880 = 870×1024, so a ÷1024 display reads "870K"). The server exposes no
  total-context field, so `contextWindow` is set to the advertised 1M (`1048576`).

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxPromptChars` | `400000` | Prompt character budget (excess is middle-truncated, keeping the system prompt, the tool protocol and the most recent turns). ⚠️ **Raising it clearly increases the risk of being rate-limited**; range `[120000, 1500000]`, and the default is deliberately **not** at the ceiling |
| `maxRefImages` | `24` | How many images one request may carry (`ref_file_ids` length). The web endpoint caps that batch (measured: 40 pass, 52 rejected); going over rejects the **whole turn**, and then **every later turn in that conversation fails** because the images stay in the history. So only the most recent N are sent; skipped ones are marked `[earlier image omitted]` in the prompt. `0` = unlimited (**not recommended**). ⚠️ That "N images" is really **N image-content entries**: every `read_image` by the model, and every re-render / crop that changes the bytes, adds one — so it is usually far more than the number of images you pasted yourself. Since 0.1.79 the notice says "N image-content entries" and is shown **only once per identical trim size** instead of every turn |
| `idleTimeoutMs` | `120000` | SSE idle timeout |
| `deleteWebSessions` | `true` | Delete the temporary web chat session after each call |
| `autoContinue` | `true` | Auto-continue when an answer is cut mid-sentence (seamlessly appended to the same answer). The tail character decides: `，` `、` `；` `：` (and their ASCII forms) mean "clearly unfinished" and trigger a continuation; sentence-ending punctuation (`。` `！` `？` `）` …) counts as complete — including `…`, since an ellipsis may be a deliberate ending. It also gates the corrective round used when the model writes a tool program into the visible text instead of emitting a tool call |
| `maxContinuations` | `2` | Max auto-continuation rounds (each round is a new web request, so it spends more of the free quota) |
| `minRequestIntervalMs` | **`2000`** | Lower bound of the gap between two web calls, measured from when the previous one **finished** |
| `maxRequestIntervalMs` | **`4000`** | Upper bound; the actual wait is picked **randomly** inside the range (equal bounds = fixed interval) |
| `allowConcurrent` | **`false`** | Allow concurrent requests on one account. Off by default: calls queue (FIFO) |
| `sessionCleanup` | **`deferred`** | Temp-session cleanup: `immediate` (delete 1.5s after each call) / `deferred` (batched, default) / `keep` (never delete) |
| `sessionCleanupDelayMs` | `90000` | deferred: max wait before flushing the queue (scalar fallback when no range is set) |
| `sessionCleanupBatchSize` | `8` | deferred: flush as soon as this many sessions are queued (scalar fallback) |
| `cleanupBatch` | `6~10` (random) | deferred: **range** for the queue threshold. How many this cycle = re-rolled at each flush |
| `cleanupDelayMs` | `60000~120000` (random) | deferred: **range** for the max wait (ms). Re-rolled at each flush |
| `cleanupGapMs` | `800~2500` (random) | deferred: **range** for the gap between two adjacent delete requests (ms). Re-rolled per delete |
| `transport` | **`chromium`** | Transport: `chromium` = Electron `net.fetch` (browser-identical fingerprint) / `node` = Node fetch |
| `contextMode` | **`full`** | Context feeding: `full` = resend the whole prompt every turn / `chained` = send only the delta and hang it off the previous answer (see below) |
| `probeIntervalMs` | `1800000` | Read-only login-state probe interval (ms); `0` disables. Uses `users/current`, zero quota |

> ⚠️ **`maxPromptChars` is a throttling valve, not a "bigger is better" knob.**
> The web API is **stateless**: every turn resends the **entire transcript**, so this ceiling directly sets the
> size of each request. Measured within a single conversation, one request grew from 9.7k to **293k tokens**;
> leaving the default at 1.5 M characters (≈1 M tokens of Chinese) means the default itself permits
> "fill the whole 1 M context in one shot". Four of our own accounts were rate-limited within two days,
> with request size the prime suspect. **So from 0.1.76 the default is 400 000** (≈270k tokens — plenty for
> long tasks). You can still raise it (the ceiling stays at 1.5 M), but read that as **trading account
> stability for longer memory**: if you genuinely need long context, switch "Context feeding" to `chained`
> (send only the delta and let the server keep the history) instead of raising this ceiling — the ceiling
> costs you on *every single turn*.

### Context feeding: full resend vs chained incremental

Every completion request carries the **entire transcript** (system prompt + tool catalogue + full history) as
`prompt`. Why resend it all? Because the plugin has always sent `parent_message_id: null` — meaning every message
is a **root** of the web conversation with no parent chain, so the server walks the message tree up to nothing.
That behaviour was measured on 2026-09-12 (send "remember the code ZC-7391-KX" in one session, then ask for the
code → "don't know").

A browser does it differently: `nextParentMessageId = history?.parentMessageId ?? finalAssistantMessageId` and
`isFirstMessage = parent_message_id === null` — **only the first message of a session has a null parent**;
after that each turn sends the previous message id as its parent and the server keeps the history.

The **Context** tab in the settings panel can switch to **chained feeding**: later turns send only the delta and
set `parent_message_id` to the previous answer's `message_id` (read from the first SSE frame,
`event: ready` → `response_message_id`). Requests get much smaller and look like a real continuous chat. The cost:
the tool protocol only exists in the first message of the chain, so if the server ever drops that early context the
model may stop emitting tool calls in the agreed format.

So `full` stays the default (identical to 0.1.61 and earlier), while `chained` follows a "save when safe, fall back
on any doubt" policy — any of these restarts the chain (full prompt + `parent=null`; it only costs a few tokens):

| Falls back to full when | Why |
| --- | --- |
| New session / session rotated / account switched | a chain belongs to one specific session |
| The fixed head (system prompt + tool catalogue) changed | the chain head is stale |
| History is not a **strict append** (compacted, rewritten, rolled back) | the delta cannot be computed |
| Nothing new this turn / the delta itself exceeds budget | nothing worth saving, or the risk outweighs it |
| Previous stream failed, was cancelled, or no `message_id` arrived | the parent may not exist any more |

The decision logic is a pure function (`src/context-feed.ts`), covered by `tests/check-context-feed.mjs`
(the rules) and `tests/check-context-chain.mjs` (wiring and lifecycle, fake transport + fake SSE).

### Why throttling is on by default, and which values to use

The web client allows only one generation per account at a time; concurrent generations are rejected, and the
real cost is worse — two windows generating at once triggered a **1-day account-level restriction** in under
6 minutes (the login stays valid, but every request from that account is refused).

DSH itself does call the same account concurrently. Reconstructing the start/end of 272 calls from the plugin
log showed **16 real overlaps**: one side is the main answer, the other is only 8–17 characters taking 1–3
seconds — that is DSH's **session-title generation** (`options.purpose === 'session-title'`). In other words,
while you are still waiting for the answer, another request has already gone out to the same account.

So the plugin now serialises calls (including title/compaction) and enforces a minimum gap between them.

| Situation | `minRequestIntervalMs` | `allowConcurrent` |
|---|---|---|
| **Recommended (default)** | `3000` | `false` |
| Speed over safety, short tasks only | `1500` | `false` |
| Already throttled once / dense multi-step automation | `8000` | `false` |
| No throttling at all (**not recommended**) | `0` | `false` |
| Experimental: restore native concurrency | any | `true` ⚠️ |

> The gap is measured from when the previous call **finished**, so a long answer is never followed by an
> extra pointless wait — it only affects genuinely dense back-to-back calls.
>
> **Two ways to change it**: ① the "Request throttling" card at the bottom of the settings page
> (switch + slider + three presets) — takes effect immediately and is persisted;
> ② the plugin entry config — needs a DSH restart.
> Precedence: **settings page > entry config > built-in default** (the settings page is an explicit
> user action, so a stale config value never overrides it). Stored at
> `${DSH_HOME:-~/.dsh}/web-login/gate.json`.

### Transport layer: Chromium network stack by default

Measured on the same machine, same day:

| | JA4 | cipher list hash | ALPN |
|---|---|---|---|
| Node fetch (undici) | `t13d5212h1_…` | — | **h1** |
| Chrome (local, 152) | `t13d1517h2_8daaf6152771_cb7bf5808d99` | `8daaf6152771` | h2 |
| **default: net.fetch (Electron 43)** | `t13d1516h2_8daaf6152771_806a8c22fdea` | **`8daaf6152771`** | h2 |

Node's fingerprint gives you away at the TLS layer (no HTTP/2, 3x more ciphers, no GREASE) and
none of that is fixable by tuning. Going through Electron's `net.fetch` uses Chromium's built-in
network stack — the cipher list hash matches Chrome byte for byte — with **zero new dependencies**
(no uTLS, no curl-impersonate). The only residual gap is 16 vs 17 extensions (bundled Chromium 150
vs local Chrome 152, a normal version difference).

### Session cleanup: three ranges instead of hard-coded values

One model call issues 4 requests (create session → PoW → completion → delete session), and
"create one temp session, delete it right away, every single turn" is one of the strongest script
signals. So the delete side is batched: flush once the queue reaches **6–10** sessions, or after at
most **60–120 s**, whichever comes first — with **one batched delete request** whenever the server
accepts it.

The three numbers used to be dead constants, and a constant has a variance of ~0 — itself the
clearest statistical tell (no human is that precise). Each is now a **range** and the actual value is
drawn randomly: the threshold and the max wait are re-rolled **every flush**, and the gap between two
adjacent delete requests is re-rolled **per delete**. That last one exists so that when the server
rejects batched delete (the code then falls back to deleting one by one, permanently) you do not fire
dozens of delete requests back to back. Set the upper bound to 0 to disable the gap. Both batched and
one-by-one deletion are **serialised** — a flush that is still running makes the next one queue up
instead of interleaving.

Switchable in Settings, with a **zero-quota one-click test** (echoes fingerprint / streaming / auth).

⚠️ The Chromium stack **follows the system proxy** (Node ignores it entirely). If your proxy still
points at `127.0.0.1:7897` while the VPN is off, requests will fail — switch back to `node`.

### Account library, call ledger, login probe

**When credentials die, the panel tells you what to do.** An account that fails the probe is
flagged **"needs re-login"** and gets a **"re-login this account"** button on its own row. Unlike
"add new account", re-login by default **does not clear the browser session**: adding must
clear it (otherwise the window opens already logged in as the old account and you capture that one
again), whereas repairing the *same* account is the opposite — keeping it means the window may reuse
it immediately with no password at all.
**An account already known to be dead will not have requests sent for it.** A failing probe writes
the reason onto the account record, and since 0.1.80 the adapter **reads that record before sending
anything**: if the failure is an **authorization** one (`Authorization Failed` / `invalid token` /
`HTTP 401·403`), it returns "this account's login state is invalid (…), the request was not sent"
instead of burning a whole round. Before this, the probe's verdict was used **for display only**
(red flag + log) — a token declared dead at 22:42 was still used at 22:50 to retry the upload of
14 images one by one.
⚠️ **Network failures (offline, timeouts, 5xx, 429) never block** — the credentials are fine there,
and blocking on them would lock a healthy account out. So if an account is blocked but you are sure
it still works, run **"verify all"** once (read-only probe, zero quota) to clear the flag.

⚠️ The exception is an account that is **already flagged as failed**: there the browser session is
cleared first, because that session is exactly what went bad — reusing it would capture the same
dead credential over and over (you would click re-login any number of times and it would never work).
The record is updated **in place**, so whichever account you
are currently using does not change.

**Cookie expiry composition is recorded at capture time** — per cookie, whether it is session-scoped
or persistent, and when the latest one expires; shown as
`5 items · 1 session · 4 persistent · smidV2 399 days left`.
⚠️ This is **not** the lifetime of your login. Measured: the real credential is the `token`
(token alone works; token-less requests are rejected with `40002 Missing Token`), so cookie expiry is
only an **upper bound on the browser side**. Older records and manually pasted tokens have no such
info and the panel says "not recorded (will be filled in on your next login)".

- **Account library** (`~/.dsh/web-login/accounts/`): keep several DeepSeek web accounts, switch with
  one click, add a **note** (the per-account label), remove, export/import backups (both open a **native OS dialog** so you pick the location and file yourself). Switching takes effect on the **next** request.
- **Groups**: create / rename / delete groups, assign an account with the per-row dropdown, sections
  collapse (state is local only), and the group holding the **current account is pinned to the top** so the
  account you are using never sinks. Inside a group the order is still newest-captured-first.
  Group definitions live in `~/.dsh/web-login/groups.json` and an account only stores a pointer, so
  **deleting a group never deletes accounts** — orphans fall back into "Ungrouped".
  Groups affect **display only**: switching, session reuse and cleanup ignore them.
- **Verify all**: one read-only `users/current` probe per account (**zero quota**, run serially) to refresh
  login state, fill in account names and clear recovered failure marks. Not the same as the per-account
  "refresh" button, which re-reads `/status`.
  **Switching accounts does not lose your conversation** — the transcript lives locally in DSH and
  every request re-sends the whole history; the account is just a pass and a quota owner.
- **Call ledger**: per-day JSONL (metadata only, no conversation content or credentials) showing the
  **gap distribution between chat calls** (p50/p90/min — the minimum is what reveals bursts) and the
  **failure breakdown** (throttled / account muted / auth / network).
- **Login probe**: a read-only `users/current` check 20s after startup and every 30 minutes
  (`probeIntervalMs`, zero quota, can be disabled) so an expired login is discovered *before* a long
  task fails midway.
- **Mute countdown**: when the account is temporarily limited, the panel shows the remaining time.
  This state can only be learned from a **rejected generation** — read-only endpoints still return
  200 while muted, so the probe cannot detect it.

> ⚠️ **There is deliberately no auto-rotation between accounts.** Switching is manual only.
> A real person does not swap accounts and keep sending within minutes — that is a very strong
> machine-behaviour signal, and it directly conflicts with the transport-fingerprint / randomized
> pacing / session-cleanup work this plugin does to look less like a script. Providers also link
> accounts (same device, same IP, same fingerprint, similar behaviour), and a "same person, many
> accounts" verdict is usually treated more harshly than single-account overuse.
> Exported backups contain fully usable credentials — never share them or commit them.

**"Sign in a new account" vs "Sign out" — the difference matters:**

- **Sign in a new account (add)** clears the browser-side login state only, then **adds the new
  account to the library without switching to it**. The account you are using is untouched; click
  *Switch* in the list to start using the new one. This is how you keep several accounts side by side.
- **Sign out** **removes that account from the library** — both the local credentials and the browser
  login state are cleared. It is not "just log out". Export a backup first if you want to keep it.

The **Account** tab is also split into two sub-pages (**Login status** / **Account library**) so you
never have to scroll through both halves at once.

**How export/import pick files.** *Export backup…* opens the native **Save As** dialog, so the
location and file name are yours to choose; *Import backup…* opens the native **Open** dialog, so
there is no path to type (and none to look up first). Both fall back gracefully when the environment
cannot show a native dialog: export then writes into the plugin directory and echoes the **full
path**, and import reads the file in the UI instead — the feature never silently stops working.
Import prefers passing only the **file path** to the host (which reads the file itself), so
credential plaintext normally does not travel over HTTP.

## Known limitations

- **One chat window per account**: the web client limits generation per account. Running two or more windows against the same account triggers a server-side **temporary ban (1 day)** — the login stays valid, but every request from that account is rejected until it lifts. Use one account per window, or move the extra windows to another provider
- **Account display names are the server's masked values**: the web API only returns forms like `192******27` or `lidi*********+mn1@gmail.com`, so the raw email / phone number never reaches the plugin — showing the full identifier is **not possible**. Since 0.1.69 that value is no longer masked a **second** time: before, two Gmail accounts both rendered as `lid***@gmail.com` and looked like the same account
- **The account library refreshes itself**: the settings panel re-reads it every **3 seconds** while a login flow is in progress (so a captured account shows up on its own — before 0.1.67 you had to close and reopen the panel) and every **30 seconds** when idle (so the account name / limit / failure mark that the probe fills in appear by themselves). The list is only rebuilt when its content actually changed, so it will not steal a click from you.
- **No native tools**: tool calling is prompting-based. Drift is covered by both the instructions and the parser, but it remains model behaviour
- **The tool catalog has a budget**: the plugin tries to emit every tool definition DSH sends (before 0.1.33 the budget was 24k characters, which silently dropped 26 of 61 real tools). If the catalog still does not fit, the **names of the undescribed tools are listed** so the model asks the user for their parameters instead of guessing
- **60s per-request cap** (`completion_request_timeout_ms`): the web client resumes streams via `sse_auto_resume`; this plugin does not implement resumption and reports `max-tokens` when a stream ends without a `FINISHED` marker instead of pretending it completed
- **Images**: uploaded through the web file channel (`/api/v0/file/upload_file` → `ref_file_ids`). If an upload fails the plugin degrades to the `[image attached]` text marker **and says so at the top of the answer** ("N image(s) could not be sent to the model, ...") — before 0.1.66 the image was dropped silently and the log was the only trace. The same image appearing several times in history (user message plus an embedded `read_image` tool result) is deduplicated, because the server rejects duplicate ids (`biz_code 9 / invalid ref file id`) and a rejected session keeps failing on every later turn. **The upload filename must carry a supported image suffix** (png / jpg / jpeg / webp / gif): the server decides the type from the filename suffix, not from the multipart `content-type` — and the host gives `read_image`-style tool results a `name` that is **a bare sha256 with no suffix**. Since 0.1.68 `imageUploadName()` normalises it to `image.<ext>` (0.1.67 and earlier: every image coming back from a tool was rejected). **A rejected image reference (`code 9 / invalid ref file id`) is now self-healing**: the plugin drops those cache entries, re-uploads, and retries the turn — and if that is rejected too, it resends **without any images** so the session can never get stuck in a fail-on-every-turn loop (0.1.78; the retry only ever happens when nothing has been shown to the user yet, so no duplicated output). **An authorization failure while uploading aborts the remaining images** (the same token would be rejected for those too, so retrying them is pure waste) and the notice says how many were never attempted — 0.1.80; only `AUTH` short-circuits, a stray 5xx still lets the rest try
- **The DSH renderer treats a single `$` as inline math (not this plugin's doing)**: DSH's frontend markdown enables `singleDollarTextMath`, so any text containing `$` is rendered as math — **the `$` disappears, `-` becomes `−` (U+2212), `|` becomes `∣` (U+2223), letters get split one per line while digit runs such as `256` stay together**. PowerShell / bash commands are hit hardest and it looks a lot like "the model produced garbage". Rule of thumb: **if the original text can be reconstructed verbatim, it is not model degradation** (degradation loses information; an encoding/rendering fault only re-encodes it). Workaround: wrap commands in fenced code blocks or backticks — code constructs do not run the math extension.
- **An answer that "stops halfway"** has two causes and since 0.1.70 both are visible instead of silent: (a) the model produced **thinking only** — no text, no tool call — which the adapter used to report as a normal `stop`, so the turn simply ended (it now reports a retryable `EMPTY_RESPONSE` and DSH resends automatically); or (b) the transcript-echo guard fired and **dropped everything from the matching line to the end of the answer**. The guard used to trigger on a *single* inline `[Tool Result for …]` — which is exactly how a model cites a tool result as evidence — so it could swallow the rest of a perfectly good answer. Inline markers are now split into **strong** (prompt truncation placeholders such as `truncated]` / `[N chars omitted]`; still dropped immediately) and **weak** (`[Tool Result` / `[status:` / `[System]`; held, and released as normal prose unless echo markers follow within the next two lines). When content really is dropped you get an explicit line at the end of the answer. **Limitation**: a citation sitting alone at the *start* of a line is byte-identical to a real replay and is still dropped — but you will see the notice. To avoid it entirely, tell the model not to paste raw tool output.
- Reasoning blocks are not replayed into history (token saving)
- `temperature` / `stop` / `max_tokens` have no web equivalent and are ignored; usage is estimated
- Free-tier rate limits apply; `429` carries `providerRetryAfterMs` for DSH's retry policy

## Testing

```bash
node tests/logic-test.mjs            # 111 assertions across 8 files
node tests/probe-live.mjs            # raw SSE event stream + timings (--big=N for long prompts)
node tests/probe-xml-live.mjs        # XML-marker scenario against the live model
node tests/probe-vision.mjs          # image channel (generates a red/blue PNG, uploads it, asks)
node tests/probe-batch-live.mjs     # live repro of incident #4 (deep thinking + a batch of 3 commands with $env:/Windows paths)
node tools/changelog-section.mjs 0.1.3  # print one CHANGELOG section (reused by the release workflow)
node tests/check-bundle.mjs          # verify every fix made it into lib/
node tests/check-image-refs.mjs     # image reference assembly (dedup + "the image was dropped" notice)
node tests/probe-upload-name.mjs    # live A/B: how the filename suffix affects upload (needs a logged-in account)
node tests/check-account-sync.mjs   # account library auto-sync (cadence + change signature)
node tests/check-account-groups.mjs # account groups (storage tolerance / CRUD / section ordering)
node tests/check-accounts-view.mjs  # /accounts sections must carry renderable views (title must not fall back to the id)
node tests/check-login-fresh.mjs    # optional login-state wipe before sign-in (profile + partition, idempotent)
```

Two assertions are frozen from a real incident: a tool call containing an unescaped Windows path once failed
to parse and leaked into the answer as text. It must now parse, with the path restored verbatim.

CI (`.github/workflows/ci.yml`) runs both commands on every push to `main` and every PR; pushing a `v*` tag
makes `.github/workflows/release.yml` create the GitHub Release and attach the tarball, using the repository token
(so a maintainer never needs a personal token).

Another real incident: the model omitted the closing brace of each call object in a batch of three, so the
whole `{"tool_calls":[…]}` block leaked into the answer. The filter now closes such braces structurally —
but only when the array itself is closed (a truncated stream must never be repaired into a half command) —
and an unparsable protocol block is never emitted as answer text again: with no other text in the step it
reports a retryable `EMPTY_RESPONSE`, otherwise it appends a one-line notice and logs the raw block.

## Disclaimer

> ⚠️ **Unofficial.** Not affiliated with, endorsed by, or sponsored by DeepSeek. "DeepSeek" is a trademark of its owner.
>
> ⚠️ **Use at your own risk.** This plugin talks to a **private web endpoint** (not the official API). That may
> violate the service terms and may get your account rate-limited or banned. Evaluate it yourself; intended for
> learning, research and personal use only.
>
> ⚠️ **No credentials in this repo.** The web session is captured locally and stored in `~/.dsh/web-login/`.
>
> ⚠️ **Provided as is**, without warranty of any kind (Apache-2.0 §7). The endpoints can change at any time.

## Acknowledgements

The implementation is original work, but the behaviour of the web endpoints (PoW/WASM convention, SSE patch
stream, file upload with `ref_file_ids`, DSML/XML tool-marker variants) was informed by and verified against
these public projects. **None of their source code is included here.**

- [LLM-Red-Team/deepseek-free-api](https://github.com/LLM-Red-Team/deepseek-free-api)
- [Fly143/deepseek-free-api](https://github.com/Fly143/deepseek-free-api)
- [ForgetMeAI/FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI)

## License

[Apache License 2.0](LICENSE) — includes a patent grant and patent retaliation; does **not** grant trademark
rights (§6). See [NOTICE](NOTICE).

## Community

Questions, updates and general chat — join the QQ group (Chinese):

<p align="center">
  <img src="docs/assets/qq-group.jpg" alt="QQ group QR code" width="300">
  <br>
  <sub>QQ group: <strong>1124773537</strong></sub>
</p>
