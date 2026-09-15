/**
 * 回归：cookie 过期信息的采集与解读（cookies.ts）。
 *
 * 为什么要单独守：
 * 1) **两种来源字段名不同**：CDP `Storage.getCookies` 给 `expires`（秒，会话级为 `-1`），
 *    Electron `session.cookies.get()` 给 `expirationDate`（会话级**不出现该字段**）。
 *    只认其中一种，另一条捕获路径就会静默记不到任何过期信息。
 * 2) **`0` / 非数 / 负值必须当会话级**：`0` 在 Unix epoch 里会被算成 1970 年，
 *    展示成"已过期"会让人以为账号坏了。
 * 3) **元信息必须与实际带上的 cookie 一一对应**：`pickCookieMeta` 的过滤条件要和
 *    拼 cookie 头的规则一致 —— 多一个少一个都说明两边漂移了。这里用
 *    "与 buildCookieHeader 的产物逐个对齐"来钉住它。
 * 4) **`undefined` 与"全 0"含义不同**：前者是"没记录"（老记录 / 手动粘 token），
 *    后者是"记到了、全是会话级"。界面文案完全依赖这个区分。
 *
 * 用法: node tests/check-cookie-meta.mjs
 */
import assert from 'node:assert/strict'

const {
  describeCookieLife,
  describeRemaining,
  normalizeCookieMetaList,
  pickCookieMeta,
  readCookieExpiry,
  summarizeCookieLife,
} = await import('../src/cookies.ts')
const { buildCookieHeader } = await import('../src/browser-login.ts')

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const DAY = 86_400_000
/** 固定在某个时刻，避免"还剩 N 天"的断言随时钟漂移。 */
const NOW = Date.UTC(2026, 8, 12, 8, 0, 0)
const secs = (ms) => Math.round(ms / 1000)

// ── readCookieExpiry：两种来源 + 各种坏值 ──────────────────────────
test('CDP 形状：expires 是秒，换算成毫秒', () => {
  const r = readCookieExpiry({ name: 'smidV2', expires: 1789000000 })
  assert.equal(r.session, false)
  assert.equal(r.expiresAt, 1789000000 * 1000)
})

test('CDP 形状：expires = -1 是会话级', () => {
  assert.equal(readCookieExpiry({ name: 'ds_session_id', expires: -1 }).session, true)
})

test('Electron 形状：expirationDate 同样按秒处理', () => {
  const r = readCookieExpiry({ name: 'x', expirationDate: 1789000000.75 })
  assert.equal(r.session, false)
  assert.equal(r.expiresAt, 1789000000750)
})

test('Electron 形状：没有 expirationDate 就是会话级（该字段缺失即会话级）', () => {
  assert.equal(readCookieExpiry({ name: 'ds_session_id' }).session, true)
})

test('显式 session: true 优先于任何 expires（两种来源都可能给）', () => {
  const r = readCookieExpiry({ name: 'x', session: true, expires: 1789000000 })
  assert.equal(r.session, true)
  assert.equal(r.expiresAt, undefined)
})

test('expires: 0 当会话级（不能算成 1970 年 → 否则界面显示"已过期"）', () => {
  assert.equal(readCookieExpiry({ name: 'x', expires: 0 }).session, true)
})

test('expires 是非数 / null / undefined 一律当会话级', () => {
  for (const bad of ['abc', null, undefined, {}, NaN, Infinity]) {
    assert.equal(readCookieExpiry({ name: 'x', expires: bad }).session, true, String(bad))
  }
})

test('整个对象就不是对象时也当会话级（不抛错）', () => {
  assert.equal(readCookieExpiry(null).session, true)
  assert.equal(readCookieExpiry(undefined).session, true)
})

// ── pickCookieMeta：过滤 + 边界 ────────────────────────────────────
const CDP_FILTER = (domain) => String(domain ?? '').includes('deepseek')
const electronFilter = (domain) => String(domain ?? '').includes('deepseek.com')

test('只保留过滤命中的域；无名的条目丢掉', () => {
  const metas = pickCookieMeta(
    [
      { name: 'smidV2', domain: '.deepseek.com', expires: 1789000000 * 1 },
      { name: 'deepseek_other', domain: 'chat.deepseek.com', expires: -1 },
      { name: 'tracker', domain: '.doubleclick.net', expires: 1789000000 },
      { domain: '.deepseek.com', expires: 1789000000 },
      { name: '', domain: '.deepseek.com' },
    ],
    CDP_FILTER,
  )
  assert.deepEqual(
    metas.map((m) => m.name),
    ['smidV2', 'deepseek_other'],
  )
  assert.equal(metas[0].session, false)
  assert.equal(metas[1].session, true)
  assert.equal(metas[1].expiresAt, undefined)
})

test('⚠️ 元信息与 buildCookieHeader 的产物逐个对齐（两边过滤条件不许漂移）', () => {
  const raw = [
    { name: 'HWWAFSESID', value: 'a', domain: 'chat.deepseek.com', expires: -1 },
    { name: 'smidV2', value: 'b', domain: '.deepseek.com', expires: 1789000000 },
    { name: 'other', value: 'c', domain: '.example.com', expires: 1789000000 },
  ]
  const fromHeader = buildCookieHeader(raw)
    .split('; ')
    .filter(Boolean)
    .map((pair) => pair.split('=')[0])
  const fromMeta = pickCookieMeta(raw, CDP_FILTER).map((m) => m.name)
  assert.deepEqual(fromMeta, fromHeader)
})

test('两种来源各用自己的过滤条件时，结果可以不同（这是刻意的，不是 bug）', () => {
  const raw = [{ name: 'a', domain: 'deepseek.cn', expires: 1789000000 }]
  assert.equal(pickCookieMeta(raw, CDP_FILTER).length, 1)
  assert.equal(pickCookieMeta(raw, electronFilter).length, 0)
})

test('空输入 / undefined 返回空数组', () => {
  assert.deepEqual(pickCookieMeta([], CDP_FILTER), [])
  assert.deepEqual(pickCookieMeta(undefined, CDP_FILTER), [])
})

// ── normalizeCookieMetaList：读磁盘记录时用 ────────────────────────
test('非数组 / 空数组 → undefined（区分"没记录"与"记录到 0 项"）', () => {
  assert.equal(normalizeCookieMetaList(undefined), undefined)
  assert.equal(normalizeCookieMetaList('x'), undefined)
  assert.equal(normalizeCookieMetaList([]), undefined)
})

test('丢掉无名条目；保留合法的持久级与会话级', () => {
  const out = normalizeCookieMetaList([
    { name: 'a', domain: '.deepseek.com', session: false, expiresAt: 1789000000000 },
    { name: 'b', domain: '.deepseek.com', session: true },
    { domain: '.deepseek.com', session: true },
    null,
    'nope',
  ])
  assert.deepEqual(
    out.map((m) => m.name),
    ['a', 'b'],
  )
  assert.equal(out[0].expiresAt, 1789000000000)
  assert.equal(out[1].session, true)
  assert.equal(out[1].expiresAt, undefined)
})

test('expiresAt 缺失 / 非法时降级成会话级（而不是留下一个坏数字）', () => {
  const out = normalizeCookieMetaList([
    { name: 'a', domain: '', expiresAt: 'abc' },
    { name: 'b', domain: '', expiresAt: 0 },
    { name: 'c', domain: '', expiresAt: -5 },
  ])
  for (const item of out) {
    assert.equal(item.session, true, item.name)
    assert.equal(item.expiresAt, undefined, item.name)
  }
})

// ── summarizeCookieLife ────────────────────────────────────────────
test('没有记录 → undefined（不是全 0 对象）', () => {
  assert.equal(summarizeCookieLife(undefined, NOW), undefined)
  assert.equal(summarizeCookieLife([], NOW), undefined)
})

test('全是会话级 → latest 不出现（浏览器侧本来就没有到期时间可看）', () => {
  const s = summarizeCookieLife(
    [
      { name: 'a', domain: '', session: true },
      { name: 'b', domain: '', session: true },
    ],
    NOW,
  )
  assert.equal(s.total, 2)
  assert.equal(s.sessionCount, 2)
  assert.equal(s.persistentCount, 0)
  assert.equal(s.latest, undefined)
})

test('混合时 latest 取**最晚**到期的那个（会话级不参与比较）', () => {
  const s = summarizeCookieLife(
    [
      { name: 'a', domain: '', session: false, expiresAt: NOW + 10 * DAY },
      { name: 'b', domain: '', session: true },
      { name: 'smidV2', domain: '', session: false, expiresAt: NOW + 399 * DAY },
    ],
    NOW,
  )
  assert.equal(s.total, 3)
  assert.equal(s.sessionCount, 1)
  assert.equal(s.persistentCount, 2)
  assert.equal(s.latest.name, 'smidV2')
  assert.ok(Math.abs(s.latest.daysLeft - 399) < 0.01)
})

test('会话级条目带了个坏 expiresAt 也不会被当成持久级', () => {
  const s = summarizeCookieLife([{ name: 'a', domain: '', session: true, expiresAt: NOW + DAY }], NOW)
  assert.equal(s.persistentCount, 0)
  assert.equal(s.latest, undefined)
})

// ── 文案 ───────────────────────────────────────────────────────────
test('剩余时间：天 / 小时 / 已过期', () => {
  assert.equal(describeRemaining(399.4), '还剩 399 天')
  assert.equal(describeRemaining(1), '还剩 1 天')
  assert.equal(describeRemaining(0.5), '还剩 12 小时')
  assert.equal(describeRemaining(0.01), '还剩 1 小时')
  assert.equal(describeRemaining(0), '已过期')
  assert.equal(describeRemaining(-3), '已过期')
})

test('没记录 / 全会话级 / 混合，三种说法各不相同', () => {
  // 0.1.64：文案加了 ⚠️ 前缀（界面里这条容易被当成噪音跳过，用户反馈"重要注释要标注"）。
  // 行为没变，断言的牙齿保留：必须仍然给出"重新登录后会补上"这条可执行指引。
  assert.equal(describeCookieLife(undefined, NOW), '⚠️ 未记录（重新登录后会补上）')
  assert.equal(
    describeCookieLife(summarizeCookieLife([{ name: 'a', domain: '', session: true }], NOW), NOW),
    '1 项 · 1 会话级',
  )
  assert.equal(
    describeCookieLife(
      summarizeCookieLife(
        [
          { name: 'a', domain: '', session: true },
          { name: 'smidV2', domain: '', session: false, expiresAt: NOW + 399 * DAY },
        ],
        NOW,
      ),
      NOW,
    ),
    '2 项 · 1 会话级 · 1 持久级 · smidV2 还剩 399 天',
  )
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
