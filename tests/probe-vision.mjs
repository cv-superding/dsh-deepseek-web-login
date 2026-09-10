/**
 * 线上验证「原生图片通道」——走插件自身的模块代码（uploadImageFile + streamWebCompletion），
 * 而不是探针内联实现，确保真实代码路径可用。
 *
 * 自造一张 128x128 左红右蓝 PNG（极简 PNG 编码器），上传后带 ref_file_ids 提问。
 * 用法：node tests/probe-vision.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { uploadImageFile, streamWebCompletion } from '../src/webapi.ts'

// ── 极简 PNG 编码器（RGB8）──
const crcTable = (() => {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}
function makePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y)
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const auth = JSON.parse(readFileSync(join(home, 'web-login', 'deepseek-auth.json'), 'utf8'))
const png = makePng(128, 128, (x) => (x < 64 ? [255, 0, 0] : [0, 0, 255]))

const uploaded = await uploadImageFile(auth, { data: new Uint8Array(png), mediaType: 'image/png', name: 'redblue.png' })
console.log('上传结果:', uploaded)

let answer = ''
let sessionId = null
for await (const event of streamWebCompletion(auth, {
  prompt: '这张图的左半边和右半边分别是什么颜色？只回答：左=X，右=Y。',
  thinkingEnabled: false,
  modelType: 'default',
  refFileIds: [uploaded.fileId],
  idleTimeoutMs: 120_000,
  onDeleteSession: (id) => {
    sessionId = id
  },
})) {
  if (event.kind === 'text') answer += event.text
  else if (event.kind === 'error') console.log('错误事件:', event.message)
}

// 清理临时会话
if (sessionId) {
  try {
    await fetch('https://chat.deepseek.com/api/v0/chat_session/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}`, ...(auth.extraHeaders ?? {}) },
      body: JSON.stringify({ chat_session_id: sessionId }),
    })
  } catch {}
}

console.log(JSON.stringify({ answer: answer.slice(0, 200), sawRed: /红/.test(answer), sawBlue: /蓝/.test(answer), cleanedSession: !!sessionId }, null, 2))
