/**
 * 分组功能（2026-09-16 用户需求）的纯逻辑回归。
 *
 * 覆盖三块容易出错的判断：
 *  1. 读盘容错 —— 一条脏数据不能让整个分组表读不出来；
 *  2. 新建/改名的**重名拒绝**（用规整后的名字比，否则界面上会出现两个看起来一样的组）；
 *  3. 分区排序 —— 尤其是「**当前账号所在的组置顶**」和「组被删掉后账号必须回到未分组」（悬挂指针）。
 *
 * 用法: node tests/check-account-groups.mjs
 */
import assert from 'node:assert/strict'
import {
  MAX_GROUPS,
  MAX_GROUP_NAME,
  UNGROUPED_KEY,
  createGroup,
  normalizeGroupList,
  normalizeGroupName,
  partitionByGroup,
  removeGroup,
  renameGroup,
} from '../src/account-groups.ts'

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

const G = (id, name, order) => ({ id, name, order })

test('组名规整：去首尾空白、折叠连续空白、去掉换行与控制字符、截断到上限', () => {
  assert.equal(normalizeGroupName('  工作  号  '), '工作 号')
  assert.equal(normalizeGroupName('工作\n号'), '工作号')
  assert.equal(normalizeGroupName('工\u200b作'), '工作')
  assert.equal(normalizeGroupName('a'.repeat(50)).length, MAX_GROUP_NAME)
  assert.equal(normalizeGroupName(123), '')
  assert.equal(normalizeGroupName(undefined), '')
  assert.equal(normalizeGroupName(null), '')
})

test('读盘容错：脏条目被丢掉，不影响其余分组', () => {
  const list = normalizeGroupList([
    { id: 'g_1', name: '工作', order: 1 },
    null,
    { id: '', name: '没有 id' },
    { id: 'g_2', name: '' },
    { name: '缺 id' },
    { id: 'g_1', name: '重复 id' },
    { id: 'g_3', name: '个人', order: 0 },
  ])
  assert.deepEqual(list.map((g) => g.id), ['g_3', 'g_1'], '按 order 重排、脏数据全丢')
  assert.deepEqual(list.map((g) => g.order), [0, 1], 'order 被规整成连续整数')
})

test('读盘容错：非数组 / order 非数字都能兜住', () => {
  assert.deepEqual(normalizeGroupList(null), [])
  assert.deepEqual(normalizeGroupList('x'), [])
  assert.deepEqual(normalizeGroupList(undefined), [])
  const list = normalizeGroupList([{ id: 'g_1', name: 'a', order: 'x' }, { id: 'g_2', name: 'b' }])
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((g) => g.order), [0, 1])
})

test('读盘容错：超过上限的组被截断', () => {
  const many = Array.from({ length: MAX_GROUPS + 5 }, (_, i) => G(`g_${i}`, `组${i}`, i))
  assert.equal(normalizeGroupList(many).length, MAX_GROUPS)
})

test('新建组：正常 / 空名 / 重名（规整后算同一个）', () => {
  const r1 = createGroup([], '  工作  ')
  assert.ok(r1.group)
  assert.equal(r1.group.name, '工作', '存进去的是规整后的名字')
  assert.equal(r1.list.length, 1)
  assert.match(r1.group.id, /^g_[0-9a-f]{8}$/)

  assert.ok(createGroup([], '   ').error, '空名要拒绝')
  const base = r1.list
  assert.ok(createGroup(base, '工作').error, '同名要拒绝')
  assert.ok(createGroup(base, ' 工作 ').error, '规整后同名也要拒绝')
  assert.equal(createGroup(base, '工作').list.length, 1, '拒绝时不许改动现有列表')
})

test('新建组：达到上限后拒绝', () => {
  const many = Array.from({ length: MAX_GROUPS }, (_, i) => G(`g_${i}`, `组${i}`, i))
  const result = createGroup(many, '再来一个')
  assert.ok(result.error)
  assert.equal(result.list.length, MAX_GROUPS, '拒绝时列表不变')
})

test('改名：正常 / 重名拒绝 / 不存在拒绝 / 改成自己原名允许', () => {
  const list = [G('g_1', '工作', 0), G('g_2', '个人', 1)]
  const ok = renameGroup(list, 'g_1', '工作号')
  assert.equal(ok.error, undefined)
  assert.equal(ok.list[0].name, '工作号')
  assert.equal(ok.list[1].name, '个人', '别的组不受影响')

  assert.equal(renameGroup(list, 'g_1', '工作').error, undefined, '改成自己原来的名字不该报错')
  assert.ok(renameGroup(list, 'g_1', '个人').error, '撞别的组要拒绝')
  assert.ok(renameGroup(list, 'g_404', 'x').error, '组不存在要拒绝')
  assert.ok(renameGroup(list, 'g_1', '  ').error, '空名要拒绝')
})

test('删除组：只删定义，order 重排成连续', () => {
  const list = [G('g_1', 'a', 0), G('g_2', 'b', 1), G('g_3', 'c', 2)]
  const next = removeGroup(list, 'g_2')
  assert.deepEqual(next.map((g) => g.id), ['g_1', 'g_3'])
  assert.deepEqual(next.map((g) => g.order), [0, 1])
})

test('分区：基本分组 + 未分组垫底', () => {
  const groups = [G('g_1', '工作', 0), G('g_2', '个人', 1)]
  const accounts = [{ id: 'a', groupId: 'g_2' }, { id: 'b' }, { id: 'c', groupId: 'g_1' }]
  const sections = partitionByGroup(accounts, groups, null)
  assert.deepEqual(sections.map((s) => s.name), ['工作', '个人', '未分组'])
  assert.deepEqual(sections[0].accounts.map((a) => a.id), ['c'])
  assert.deepEqual(sections[2].accounts.map((a) => a.id), ['b'])
  assert.equal(sections[2].key, UNGROUPED_KEY)
  assert.equal(sections[2].groupId, null)
})

test('分区：当前账号所在的组置顶（用户明确要的行为）', () => {
  const groups = [G('g_1', '工作', 0), G('g_2', '个人', 1), G('g_3', '备用', 2)]
  const accounts = [{ id: 'a', groupId: 'g_1' }, { id: 'b', groupId: 'g_2' }, { id: 'c', groupId: 'g_3' }]

  assert.deepEqual(
    partitionByGroup(accounts, groups, 'b').map((s) => s.name),
    ['个人', '工作', '备用'],
    '当前账号在「个人」⇒ 它排最前',
  )
  assert.deepEqual(
    partitionByGroup(accounts, groups, 'a').map((s) => s.name),
    ['工作', '个人', '备用'],
    '当前账号在最前面的组时，顺序看起来不变',
  )
  assert.deepEqual(
    partitionByGroup(accounts, groups, '不存在').map((s) => s.name),
    ['工作', '个人', '备用'],
    '当前账号不在任何组 ⇒ 不置顶',
  )
  assert.deepEqual(
    partitionByGroup([...accounts, { id: 'd' }], groups, 'd').map((s) => s.name),
    ['工作', '个人', '备用', '未分组'],
    '当前账号在「未分组」⇒ 组顺序不动、未分组仍在最后',
  )
})

test('分区：组被删掉的账号回到「未分组」（悬挂指针必须兜住）', () => {
  const groups = [G('g_1', '工作', 0)]
  const accounts = [{ id: 'a', groupId: 'g_1' }, { id: 'b', groupId: 'g_已经删了' }]
  const sections = partitionByGroup(accounts, groups, null)
  assert.deepEqual(sections.map((s) => s.name), ['工作', '未分组'])
  assert.deepEqual(sections[1].accounts.map((a) => a.id), ['b'], '账号不能因为组没了就从列表里消失')
})

test('分区：空组照样返回（刚建完要能看见它）', () => {
  const groups = [G('g_1', '工作', 0), G('g_2', '空组', 1)]
  const sections = partitionByGroup([{ id: 'a', groupId: 'g_1' }], groups, null)
  assert.equal(sections.length, 2)
  assert.deepEqual(sections[1].accounts, [])
  assert.equal(sections[1].name, '空组')
})

test('分区：未分组为空时不返回（不留一行没意义的标题）', () => {
  const groups = [G('g_1', '工作', 0)]
  assert.deepEqual(partitionByGroup([{ id: 'a', groupId: 'g_1' }], groups, null).map((s) => s.name), ['工作'])
})

test('分区：组内保持传入顺序（捕获时间倒序，不再二次排序）', () => {
  const groups = [G('g_1', '工作', 0)]
  const accounts = [{ id: 'c', groupId: 'g_1' }, { id: 'a', groupId: 'g_1' }, { id: 'b', groupId: 'g_1' }]
  assert.deepEqual(partitionByGroup(accounts, groups, null)[0].accounts.map((a) => a.id), ['c', 'a', 'b'])
})

test('分区：一个组都没有时，全部落进「未分组」', () => {
  const sections = partitionByGroup([{ id: 'a' }, { id: 'b' }], [], null)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].groupId, null)
  assert.equal(sections[0].accounts.length, 2)
})

test('分区：空账号列表 + 空分组 ⇒ 空结果（面板据此显示空态）', () => {
  assert.deepEqual(partitionByGroup([], [], null), [])
})

test('分区：组定义顺序被打乱时，仍按 order 排', () => {
  const groups = [G('g_2', '第二', 1), G('g_1', '第一', 0)]
  const sections = partitionByGroup([{ id: 'a', groupId: 'g_1' }, { id: 'b', groupId: 'g_2' }], groups, null)
  assert.deepEqual(sections.map((s) => s.name), ['第一', '第二'])
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
