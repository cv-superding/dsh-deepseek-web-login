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

## Screenshots

Settings panel (real screenshot): current account / login status (adapter registration, credential source, PoW WASM, server-side verification) / three login paths (Microsoft Edge · default browser · recover from a logged-in window) / manual token.

<img src="docs/assets/screenshot-settings.png" alt="DSH settings panel · DeepSeek web login (real screenshot)" width="820">

DSH's usage-stats page on the free web channel — 10.4M tokens / 164 calls in a single day:

<img src="docs/assets/screenshot-usage-stats.png" alt="DSH usage stats · deepseek-web free channel" width="820">

## Features

| | |
|---|---|
| 🔐 **Web login, no API key** | Log in normally inside an Electron window on its own persistent partition; the plugin captures the real `Authorization`, cookies, `x-hif-*` fingerprint headers and client version headers on the side (it never touches your password) |
| 🧩 **PoW solving** | `create_pow_challenge` + DeepSeek's own `sha3_wasm_bg.*.wasm` `wasm_solve`, with automatic WASM URL discovery (the hash changes between deployments) |
| 🌊 **Streaming** | Handles both the `response/fragments` format (THINK/RESPONSE) and the direct `thinking_content`/`content` paths, including `{o:"APPEND"}` and bare `{v}` continuations; logical-stream dedup so snapshots never double-emit |
| 🛠 **Tool calling** | The web endpoint has no native function calling → a prompting JSON protocol plus a streaming filter (cross-chunk markers, fenced blocks, multiple calls, false-positive fallback) that synthesizes `tool-call` blocks and `finish: tool-calls` |
| 🛡 **Drift covered twice** | The instructions explicitly forbid XML/DSML markup (the model then refuses that format by itself), and the parser accepts both the JSON and XML/DSML families (`\|DSML\|` prefix, hyphenated `dsml-` tags, bare `<invoke>`, CDATA) |
| 🩹 **Lenient JSON repair** | Models write Windows paths with single backslashes: `\A` is an illegal escape while `\r` is legal and would silently turn `\resources` into a carriage return. A chain of repair candidates restores paths literally; if nothing parses, the text is passed through — **content is never silently dropped** |
| 🖼 **Image input** | Not native multimodal input: images are uploaded via `/api/v0/file/upload_file` and referenced with `ref_file_ids`. Verified against a generated left-red/right-blue PNG — the model answered "left=red, right=blue" |
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
| `maxPromptChars` | `1500000` | Prompt character budget (excess is middle-truncated, keeping the system prompt, the tool protocol and the most recent turns) |
| `idleTimeoutMs` | `120000` | SSE idle timeout |
| `deleteWebSessions` | `true` | Delete the temporary web chat session after each call |
| `autoContinue` | `true` | Auto-continue when an answer is cut mid-sentence (seamlessly appended to the same answer) |
| `maxContinuations` | `2` | Max auto-continuation rounds (each round is a new web request, so it spends more of the free quota) |
| `minRequestIntervalMs` | **`3000`** | Minimum gap between two web calls, measured from when the previous one **finished**. `0` disables it |
| `allowConcurrent` | **`false`** | Allow concurrent requests on one account. Off by default: calls queue (FIFO) |

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

## Known limitations

- **One chat window per account**: the web client limits generation per account. Running two or more windows against the same account triggers a server-side **temporary ban (1 day)** — the login stays valid, but every request from that account is rejected until it lifts. Use one account per window, or move the extra windows to another provider
- **No native tools**: tool calling is prompting-based. Drift is covered by both the instructions and the parser, but it remains model behaviour
- **60s per-request cap** (`completion_request_timeout_ms`): the web client resumes streams via `sse_auto_resume`; this plugin does not implement resumption and reports `max-tokens` when a stream ends without a `FINISHED` marker instead of pretending it completed
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
