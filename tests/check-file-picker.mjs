/**
 * 回归：账号备份的「导出/导入」走系统文件对话框（file-picker.ts）。
 *
 * 为什么要单独守：
 * 1) **顺序**。Chromium 的瞬时用户激活有时限 —— 必须是"先弹「另存为」、再取内容"。
 *    反过来的写法（先 await 取备份、再弹框）在真机上会直接抛错，
 *    而这里的假 picker 不会报错，所以只能靠断言顺序来钉住。
 * 2) **取消不是错误**。用户取消（AbortError）不该被当成失败、更不该让回退逻辑
 *    偷偷把文件写到别的地方去。
 * 3) **取消时不要取内容**。用户点了取消却仍然把明文凭证从宿主拉进界面，
 *    是把敏感数据无谓地多暴露一次。
 * 4) **能拿路径就别解析内容**。拿到真实路径时宿主自己去读文件，
 *    凭证不进 HTTP；这时哪怕"内容"是坏 JSON 也应该继续走路径。
 *
 * 用法: node tests/check-file-picker.mjs
 */
import assert from 'node:assert/strict'

const {
  canSaveWithPicker,
  isPickerCancel,
  pickJsonFile,
  readImportSource,
  resolvePickedPath,
  saveWithPicker,
  suggestedExportName,
} = await import('../src/file-picker.ts')

let passed = 0
const failures = []
async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

/** 假的 <input type="file">：只要够 pickJsonFile 用即可（不引 jsdom）。 */
function fakeDocument() {
  const state = { input: undefined, removed: false, clicked: 0 }
  const body = { appendChild: (node) => { state.input = node } }
  const doc = {
    body,
    createElement: () => {
      const listeners = {}
      const input = {
        type: '',
        accept: '',
        style: {},
        files: null,
        addEventListener: (event, fn) => {
          listeners[event] = fn
        },
        remove: () => {
          state.removed = true
        },
        click: () => {
          state.clicked += 1
        },
      }
      state.listeners = listeners
      return input
    },
  }
  return { doc, state }
}

const fakeFile = (name, body, { json = true } = {}) => ({
  name,
  text: async () => {
    if (!json) throw new Error('不是 UTF-8 文本')
    return body
  },
})

// ── 文件名 ──────────────────────────────────────────────────────────────
await run('备份文件名不含 Windows 非法字符（toISOString 的冒号不能直接拿来用）', async () => {
  const name = suggestedExportName(new Date(2026, 8, 12, 14, 7, 33))
  assert.equal(name, 'deepseek-accounts-20260912-140733.json')
  assert.ok(!/[:/\\*?"<>|]/.test(name), `文件名含非法字符: ${name}`)
})

await run('备份文件名可被当作路径段安全使用（无空格、无前导点）', async () => {
  const name = suggestedExportName()
  assert.match(name, /^deepseek-accounts-\d{8}-\d{6}\.json$/)
  assert.ok(!name.startsWith('.'))
  assert.ok(!name.includes(' '))
})

// ── 取真实路径 ──────────────────────────────────────────────────────────
await run('有路径桥时，拿得到真实磁盘路径', async () => {
  const win = { __DSH_DESKTOP_FILE_PATH__: { getPathForFile: () => 'F:\\bk\\accounts.json' } }
  assert.equal(resolvePickedPath({ name: 'accounts.json' }, win), 'F:\\bk\\accounts.json')
})

await run('没有路径桥 → undefined（调用方改用内容导入）', async () => {
  assert.equal(resolvePickedPath({ name: 'a.json' }, {}), undefined)
})

await run('桥抛错时不冒泡（非磁盘来源的 File 不该把导入弄崩）', async () => {
  const win = {
    __DSH_DESKTOP_FILE_PATH__: {
      getPathForFile: () => {
        throw new Error('Not a disk-backed file')
      },
    },
  }
  assert.equal(resolvePickedPath({ name: 'a.json' }, win), undefined)
})

await run('桥返回非字符串 / 空白 → 一律当拿不到', async () => {
  for (const bad of [null, undefined, 42, {}, '', '   ']) {
    const win = { __DSH_DESKTOP_FILE_PATH__: { getPathForFile: () => bad } }
    assert.equal(resolvePickedPath({ name: 'a.json' }, win), undefined, `坏值 ${JSON.stringify(bad)} 应被忽略`)
  }
})

await run('没有文件时不查桥', async () => {
  let called = 0
  const win = {
    __DSH_DESKTOP_FILE_PATH__: {
      getPathForFile: () => {
        called += 1
        return 'x'
      },
    },
  }
  assert.equal(resolvePickedPath(undefined, win), undefined)
  assert.equal(resolvePickedPath(null, win), undefined)
  assert.equal(called, 0)
})

// ── 另存为能力与结果分类 ────────────────────────────────────────────────
await run('另存为能力探测：只有函数才算支持', async () => {
  assert.equal(canSaveWithPicker({ showSaveFilePicker: async () => {} }), true)
  assert.equal(canSaveWithPicker({}), false)
  assert.equal(canSaveWithPicker({ showSaveFilePicker: 'yes' }), false)
  assert.equal(canSaveWithPicker({ showSaveFilePicker: null }), false)
})

await run('取消（AbortError）与真失败要分开', async () => {
  assert.equal(isPickerCancel({ name: 'AbortError' }), true)
  assert.equal(isPickerCancel({ name: 'TypeError' }), false)
  assert.equal(isPickerCancel(new Error('boom')), false)
  assert.equal(isPickerCancel(undefined), false)
})

await run('不支持另存为 → unsupported，且**不调用**取内容回调', async () => {
  let produced = 0
  const outcome = await saveWithPicker('n.json', async () => {
    produced += 1
    return '{}'
  }, {})
  assert.equal(outcome.kind, 'unsupported')
  assert.equal(produced, 0, '不支持时不该去取内容')
})

await run('先弹「另存为」再取内容（顺序反了在真机上会被判成没有用户手势）', async () => {
  const order = []
  let written
  let options
  const win = {
    showSaveFilePicker: async (opts) => {
      order.push('picker')
      options = opts
      return {
        name: 'my-backup.json',
        createWritable: async () => ({
          write: async (blob) => {
            order.push('write')
            written = blob
          },
          close: async () => order.push('close'),
        }),
      }
    },
  }
  const outcome = await saveWithPicker('suggested.json', async () => {
    order.push('produce')
    return '{"accounts":[]}'
  }, win)

  assert.equal(outcome.kind, 'saved')
  assert.equal(outcome.name, 'my-backup.json', '文件名应取用户实际选的')
  assert.deepEqual(order, ['picker', 'produce', 'write', 'close'], `实际顺序 ${order.join(' → ')}`)
  assert.equal(await written.text(), '{"accounts":[]}', '写进文件的应是取回来的内容')
  assert.equal(options.suggestedName, 'suggested.json', '建议文件名要透传给对话框')
})

await run('另存为的参数对 Chromium 合法（accept 的键必须是 MIME）', async () => {
  let options
  await saveWithPicker('n.json', async () => '{}', {
    showSaveFilePicker: async (opts) => {
      options = opts
      return { name: 'n.json', createWritable: async () => ({ write: async () => {}, close: async () => {} }) }
    },
  })
  const types = options.types
  assert.ok(Array.isArray(types) && types.length > 0, '应给出文件类型过滤')
  for (const type of types) {
    for (const mime of Object.keys(type.accept)) {
      // 非法 MIME 会让 showSaveFilePicker 直接抛 TypeError（Chromium 行为）
      assert.ok(mime.includes('/'), `accept 的键必须是 MIME 类型，实际 "${mime}"`)
      assert.ok(type.accept[mime].every((ext) => ext.startsWith('.')), '扩展名要带点')
    }
  }
})

await run('用户取消 → cancelled，且**不取内容**（别为一次取消多暴露一遍凭证）', async () => {
  let produced = 0
  const win = {
    showSaveFilePicker: async () => {
      const error = new Error('The user aborted a request.')
      error.name = 'AbortError'
      throw error
    },
  }
  const outcome = await saveWithPicker('n.json', async () => {
    produced += 1
    return '{}'
  }, win)
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(produced, 0)
})

await run('弹框真失败 → failed（带原因，供界面说明回退理由）', async () => {
  const win = {
    showSaveFilePicker: async () => {
      const error = new Error('Cross origin sub frames are not allowed to show a file picker')
      error.name = 'SecurityError'
      throw error
    },
  }
  const outcome = await saveWithPicker('n.json', async () => '{}', win)
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.reason, /SecurityError/)
})

await run('写盘失败也算 failed，不吞掉（否则文件没落盘却报成功）', async () => {
  const win = {
    showSaveFilePicker: async () => ({
      name: 'n.json',
      createWritable: async () => {
        throw new Error('disk full')
      },
    }),
  }
  const outcome = await saveWithPicker('n.json', async () => '{}', win)
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.reason, /disk full/)
})

// ── 打开文件 ────────────────────────────────────────────────────────────
await run('打开框：只收 json、点了才弹、选完清理 DOM', async () => {
  const { doc, state } = fakeDocument()
  const promise = pickJsonFile(doc)
  assert.equal(state.clicked, 1, '应立即触发一次点击')
  assert.equal(state.input.type, 'file')
  assert.equal(state.input.accept, '.json,application/json')
  assert.equal(state.input.style.display, 'none', '隐藏的 input 也能弹框（Chromium 行为）')

  const picked = fakeFile('accounts.json', '{"accounts":[]}')
  state.input.files = [picked]
  state.listeners.change()
  assert.equal(await promise, picked)
  assert.equal(state.removed, true, '选完应把临时 input 从 DOM 摘掉')
})

await run('打开框：用户取消 → undefined，同样清理 DOM', async () => {
  const { doc, state } = fakeDocument()
  const promise = pickJsonFile(doc)
  state.listeners.cancel()
  assert.equal(await promise, undefined)
  assert.equal(state.removed, true)
})

await run('打开框：change 与 cancel 都到达时只认第一次（不重复决议）', async () => {
  const { doc, state } = fakeDocument()
  const promise = pickJsonFile(doc)
  const picked = fakeFile('a.json', '{}')
  state.input.files = [picked]
  state.listeners.change()
  state.listeners.cancel()
  assert.equal(await promise, picked)
})

// ── 导入来源 ────────────────────────────────────────────────────────────
await run('有路径桥 → 走 path（宿主自己读文件，凭证不进 HTTP）', async () => {
  const win = { __DSH_DESKTOP_FILE_PATH__: { getPathForFile: () => 'F:\\bk\\a.json' } }
  const source = await readImportSource(fakeFile('a.json', '{"accounts":[]}'), win)
  assert.equal(source.kind, 'path')
  assert.equal(source.path, 'F:\\bk\\a.json')
  assert.equal(source.name, 'a.json')
})

await run('走 path 时不解析内容（坏 JSON 也不该拦下来）', async () => {
  const win = { __DSH_DESKTOP_FILE_PATH__: { getPathForFile: () => 'F:\\bk\\broken.json' } }
  const source = await readImportSource(fakeFile('broken.json', '{ 这不是 JSON', { json: true }), win)
  assert.equal(source.kind, 'path', '有路径就该走路径，解析失败与否由宿主去报')
})

await run('没路径桥 → 退回 content（兜底：别让功能整体失效）', async () => {
  const source = await readImportSource(fakeFile('a.json', '{"accounts":[{"token":"t"}]}'), {})
  assert.equal(source.kind, 'content')
  assert.deepEqual(source.payload, { accounts: [{ token: 't' }] })
})

await run('没路径桥且内容不是 JSON → unreadable（如实报，不静默）', async () => {
  const source = await readImportSource(fakeFile('a.txt', 'hello'), {})
  assert.equal(source.kind, 'unreadable')
  assert.equal(source.name, 'a.txt')
  assert.ok(source.reason.length > 0)
})

await run('读取本身抛错（非文本文件）→ unreadable', async () => {
  const source = await readImportSource(fakeFile('a.json', '', { json: false }), {})
  assert.equal(source.kind, 'unreadable')
  assert.match(source.reason, /不是 UTF-8/)
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
