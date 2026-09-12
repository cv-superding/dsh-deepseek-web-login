/**
 * 回归：账号显示名（pickUserDisplay + accountTitle 的兜底）。
 *
 * 事故（2026-09-12，用户实测反馈）：手机号注册的账号在账号库里显示成一串 id
 * （`9d6***13`），刚添加的账号甚至显示成内部 id `acc_cd8e05ec`。
 *
 * 追下去是**两个叠在一起的坑**，而它们在单测之外几乎看不出来
 * （接口返回 200、校验也"通过"，只是名字永远是空）：
 *
 *  1. **`??` 不跳过空字符串。** 接口对没设邮箱的账号返回 `email: ""`，
 *     而 `"" ?? x` 就是 `""` —— 整条回退链被它挡住，`display` 永远是空。
 *     必须按"有内容"取。
 *  2. **字段名是 `mobile_number`，不是 `mobile`。** 我们原本找的是 `mobile`，
 *     所以哪怕修好了第 1 点，也还是拿不到手机号。
 *
 * 用法: node tests/check-user-display.mjs
 */
import assert from 'node:assert/strict'

const { pickUserDisplay, classifyAuthEnvelope } = await import('../src/webapi.ts')
const { accountTitle } = await import('../src/accounts.ts')

let passed = 0
const failures = []
function run(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

/** 脱敏函数就按线上那套掩码规则来（这里只用来验证 title 的走向，不验证掩码细节）。 */
const mask = (raw) => String(raw).replace(/^(.{3}).*(.{2})$/, '$1***$2')

// ── pickUserDisplay ─────────────────────────────────────────────────────
run('有邮箱就用邮箱', () => {
  assert.equal(pickUserDisplay({ email: 'someone@qq.com', mobile_number: '183******78' }), 'someone@qq.com')
})

run('**email 是空串时必须继续往后找**（这是那个 bug 的核心）', () => {
  assert.equal(pickUserDisplay({ email: '', mobile_number: '183******78' }), '183******78')
})

run('email 只有空白也要跳过', () => {
  assert.equal(pickUserDisplay({ email: '   ', mobile_number: '183******78' }), '183******78')
})

run('实测的真实响应形状：email 空 + mobile_number 有值', () => {
  const real = {
    id: '9d6eb6eb-ec0d-47fe-befa-b69437459913',
    token: 'x'.repeat(64),
    email: '',
    mobile_number: '183******78',
    area_code: '+86',
    status: 0,
    chat: { is_muted: 0, mute_until: null },
  }
  assert.equal(pickUserDisplay(real), '183******78', '就是这条以前拿不到名字')
})

run('null / undefined 跳过，不变成字符串 "null"', () => {
  assert.equal(pickUserDisplay({ email: null, mobile_number: undefined, username: 'someone' }), 'someone')
})

run('全是空 → 返回空串（调用方据此回退）', () => {
  assert.equal(pickUserDisplay({ id: 'only-id' }), '')
  assert.equal(pickUserDisplay({ email: '', mobile_number: '' }), '')
  assert.equal(pickUserDisplay({}), '')
  assert.equal(pickUserDisplay(undefined), '')
})

run('非字符串值也能取（数字手机号 / 数字昵称）', () => {
  assert.equal(pickUserDisplay({ mobile_number: 13800000000 }), '13800000000')
  assert.equal(pickUserDisplay({ nickname: 42 }), '42')
})

run('取值优先级：email > mobile_number > mobile > phone > username > nickname > name', () => {
  assert.equal(pickUserDisplay({ name: 'n', nickname: 'nk', username: 'u', phone: 'p', mobile: 'm', mobile_number: 'mn', email: 'e' }), 'e')
  assert.equal(pickUserDisplay({ name: 'n', nickname: 'nk', username: 'u', phone: 'p', mobile: 'm', mobile_number: 'mn' }), 'mn')
  assert.equal(pickUserDisplay({ name: 'n', nickname: 'nk', username: 'u', phone: 'p', mobile: 'm' }), 'm')
  assert.equal(pickUserDisplay({ name: 'n', nickname: 'nk', username: 'u' }), 'u')
  assert.equal(pickUserDisplay({ name: 'n', nickname: 'nk' }), 'nk')
  assert.equal(pickUserDisplay({ name: 'n' }), 'n')
})

run('取到的值会去掉首尾空白', () => {
  assert.equal(pickUserDisplay({ email: '  a@b.com  ' }), 'a@b.com')
})

// ── accountTitle 的兜底 ─────────────────────────────────────────────────
run('有备注名时用备注名（优先于任何自动名字）', () => {
  assert.equal(accountTitle({ id: 'acc_1', label: '工作号', user: { display: '183******78' } }, mask), '工作号')
})

run('有 display 时用 display（走后端给的脱敏形态）', () => {
  assert.equal(accountTitle({ id: 'acc_1', user: { display: '183******78' } }, mask), '183***78')
})

run('只有 id 时退回 id（掩码后）', () => {
  assert.equal(accountTitle({ id: 'acc_1', user: { id: '9d6eb6eb-ec0d-47fe-befa-b69437459913' } }, mask), '9d6***13')
})

run('**什么都没有时不再把内部 id 当名字**（用户看到 hex 会以为是 bug）', () => {
  const title = accountTitle({ id: 'acc_cd8e05ec' }, mask)
  assert.ok(!title.includes('acc_cd8e05ec'), `不该原样显示内部 id，实际 ${title}`)
  assert.match(title, /未识别账号/)
  assert.match(title, /cd8e05ec/, '要留一小截后缀，多个未识别账号之间才能区分')
})

run('两个未识别账号的标题互不相同（否则列表里没法区分）', () => {
  const a = accountTitle({ id: 'acc_cd8e05ec' }, mask)
  const b = accountTitle({ id: 'acc_11223344' }, mask)
  assert.notEqual(a, b)
})

run('F09：resp.json() 失败（HTML/空响应）必须判失败，不能是空壳 ok:true', () => {
  // 旧实现：json=undefined → envelopeError(undefined) 返回 undefined → 走到 ok:true + user:{}
  // 于是反爬页 / WAF 拦截页（同样是 200）会被当成"验证通过"，
  // 0.1.31 的「需要重新登录」按钮永远不会触发。
  for (const bad of [undefined, null, 'not json', 42, []]) {
    const r = classifyAuthEnvelope(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应当判失败`)
    assert.match(r.error, /不是 JSON 对象/)
  }
})

run('F09：业务错误码与形状不符也判失败', () => {
  const biz = classifyAuthEnvelope({ code: 40003, msg: 'Authorization Failed' })
  assert.equal(biz.ok, false)
  assert.match(biz.error, /Authorization Failed/)
  // 外层 code=0 但 data.biz_code 非 0（网页端真实形态）
  const inner = classifyAuthEnvelope({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'invalid session' } })
  assert.equal(inner.ok, false)
  const shapeless = classifyAuthEnvelope({ foo: 1 })
  assert.equal(shapeless.ok, false)
  assert.match(shapeless.error, /形状不符/)
})

run('F09：正常信封仍判成功（别矫枉过正）', () => {
  assert.equal(classifyAuthEnvelope({ code: 0, msg: '', data: { biz_data: { user: { id: 'u1' } } } }).ok, true)
  assert.equal(classifyAuthEnvelope({ data: { biz_data: { id: 'u1' } } }).ok, true)
  // 只有 code 也算（某些响应 data 为空对象）
  assert.equal(classifyAuthEnvelope({ code: 0, data: {} }).ok, true)
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
