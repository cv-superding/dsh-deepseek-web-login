import { createRequestGate } from '../src/gate.ts'

function make({ threshold = 3, brk = { min: 60_000, max: 60_000 } } = {}) {
  const waits = []
  const logs = []
  let t = 1_000
  const gate = createRequestGate({
    allowConcurrent: false,
    minIntervalMs: 0,
    maxIntervalMs: 0,
    longRunThreshold: threshold,
    longRunBreakMs: brk,
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms)
      t += ms
    },
    logger: { info: (m) => logs.push(m), debug: () => {} },
  })
  return { gate, waits, logs, tick: (ms) => (t += ms), now: () => t }
}

// 场景 1：连跑 10 次（阈值 3）
{
  const { gate, waits, logs, tick } = make()
  for (let i = 0; i < 10; i += 1) {
    const release = await gate.acquire('chat')
    release()
    tick(100)
  }
  const breaks = waits.filter((w) => w >= 60_000)
  console.log('场景1 阈值3、连跑10次')
  console.log('  等待序列:', JSON.stringify(waits))
  console.log('  长休次数:', breaks.length, '(期望 3)')
  console.log('  日志样例:', logs.find((l) => l.includes('长休'))?.slice(0, 92))
  console.log()
}

// 场景 2：关闭保护（threshold=0）
{
  const { gate, waits, tick } = make({ threshold: 0 })
  for (let i = 0; i < 10; i += 1) {
    const release = await gate.acquire('chat')
    release()
    tick(100)
  }
  console.log('场景2 关闭保护（threshold=0）')
  console.log('  等待序列:', JSON.stringify(waits), ' 长休次数:', waits.filter((w) => w >= 60_000).length, '(期望 0)')
  console.log()
}

// 场景 3：中间歇够了（>120s）→ 连续计数归零
{
  const { gate, waits, tick } = make()
  for (let i = 0; i < 3; i += 1) {
    const release = await gate.acquire('chat')
    release()
    tick(100)
  }
  tick(200_000) // 歇了 200 秒
  for (let i = 0; i < 3; i += 1) {
    const release = await gate.acquire('chat')
    release()
    tick(100)
  }
  console.log('场景3 中间歇 200s')
  console.log('  等待序列:', JSON.stringify(waits), ' 长休次数:', waits.filter((w) => w >= 60_000).length, '(期望 0)')
  console.log()
}

// 场景 4：settings 回显
{
  const { gate } = make()
  console.log('场景4 settings():', JSON.stringify(gate.settings()))
}
