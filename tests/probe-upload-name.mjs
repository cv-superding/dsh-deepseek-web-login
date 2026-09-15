/**
 * 真机 A/B：同一个图片字节，只改 multipart 里的**文件名**，看服务端分别怎么回。
 *
 * 背景：2026-09-15 本机反复出现「图片上传被拒（code 9）：unsupported file type」。
 * 从会话日志发现规律 ——
 *   user/message 与 agent/inbox 的 attachment.name = "image.png"（有扩展名）
 *   tool/result 的 attachment.name = 纯 sha256 hex（**没有扩展名**）
 * 而 `uploadImageFile` 是 `new Blob([bytes], {type: mediaType}), input.name || 'image.png'`
 * —— 文件名原样发出。本脚本验证「文件名缺扩展名」是否就是被拒的原因。
 *
 * 用法：node tests/probe-upload-name.mjs
 * 只做上传（不建会话、不提问），四张都用同一份真实 PNG 字节。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { readAuth } = await import('../src/auth.ts')
const { uploadImageFile } = await import('../src/webapi.ts')

// ── 取附件库里最小的一张真实 PNG 当样本 ──
function smallestPng() {
  const base = join(homedir(), '.dsh', 'attachments', 'v1', 'objects')
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const buf = readFileSync(p)
        if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) out.push({ p, buf })
      }
    }
  }
  walk(base)
  out.sort((a, b) => a.buf.length - b.buf.length)
  return out[0]
}

const auth = readAuth()
if (!auth?.token) {
  console.log('✗ readAuth() 没有返回可用凭证（未选账号？）')
  process.exit(1)
}
const who = auth.user?.display ?? auth.user?.id ?? '(未知)'
console.log('账号:', who, ' token 前缀:', String(auth.token).slice(0, 8) + '…')

const sample = smallestPng()
console.log('样本 PNG:', sample.p.length > 90 ? '…' + sample.p.slice(-90) : sample.p, sample.buf.length, 'B')
console.log()

const HEX = 'e999c658e69b144938fb4efe278c80acc56947d9fed142d7978878dd3fb8609e'
const cases = [
  ['A 正常名 image.png          ', 'image.png'],
  ['B 纯 hex（tool/result 现状）', HEX],
  ['C hex + .png（修法候选）    ', HEX + '.png'],
  ['D 不给 name（走缺省）       ', undefined],
]

const results = []
for (const [label, name] of cases) {
  try {
    const r = await uploadImageFile(auth, {
      data: new Uint8Array(sample.buf),
      mediaType: 'image/png',
      ...(name ? { name } : {}),
    })
    console.log('%s → ✅ 成功  file_id=%s', label, String(r.fileId).slice(0, 28) + '…')
    results.push([label, 'OK', ''])
  } catch (e) {
    console.log('%s → ❌ %s', label, e?.message ?? e)
    results.push([label, 'FAIL', String(e?.message ?? e)])
  }
}

console.log()
console.log('=== 结论表 ===')
for (const [label, st, msg] of results) console.log('  %s  %s  %s', label, st, msg.slice(0, 70))
