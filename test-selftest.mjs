// 功能自测：mock ctx，模拟 session 事件，验证捕获/去重/替换/聚合/HTTP 载荷。
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 默认导入本仓库源码；安装冒烟测试可通过 DSH_TOKEN_STATS_ENTRY 指向已安装
// 包的 lib/index.js，以验证打包/安装后的产物。
const entry = process.env.DSH_TOKEN_STATS_ENTRY
  ? path.resolve(process.env.DSH_TOKEN_STATS_ENTRY)
  : fileURLToPath(new URL('./lib/index.js', import.meta.url))
const mod = (await import(pathToFileURL(entry).href)).default

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ts-test-'))
const cfg = mod.Config({ dataDir: tmp, flushDelayMs: 50 })
console.log('config:', JSON.stringify(cfg))

const handlers = {}
const registered = { tools: null, routes: [] }
let seqCounter = 0
let curTime = Date.now()

function mkEvent(type, data) {
  return { type, seq: seqCounter++, time: curTime, data }
}

// ---- mock ctx ----
const fakeSession = { id: 'sess-1', events: [] }
const ctx = {
  get(name) {
    if (name === 'tools') return {
      register(t) { registered.tools = t },
    }
    if (name === 'webServer') return {
      register(route) { registered.routes.push(route); return () => {} },
    }
    return undefined
  },
  on(ev, fn) { handlers[ev] = fn },
  effect(fn) { const d = fn(); this._disposers = this._disposers || []; if (typeof d === 'function') this._disposers.push(d) },
  sessions: {
    list() { return [fakeSession] },
  },
}

mod.apply(ctx, cfg)

// ---- 模拟会话事件流 ----
function stepUsage(sessionId, turn, step, provider, model, usage, time) {
  curTime = time
  const hdr = mkEvent('request/header', { header: { config: { provider, model } }, reason: turn === 0 && step === 0 ? 'initial' : 'change' })
  handlers['session/event'](fakeSession, hdr)
  const chunk = mkEvent('assistant/chunk', { turn, step, chunk: { type: 'usage', usage } })
  handlers['session/event'](fakeSession, chunk)
  const msg = mkEvent('assistant/message', {
    turn, step,
    message: { role: 'assistant', source: { kind: 'model', provider, model }, content: [{ type: 'text', text: 'ok' }] },
    usage,
  })
  handlers['session/event'](fakeSession, msg)
}

// step 1: 模型A，usage 与 message 一致（无缓存）
stepUsage('sess-1', 1, 0, 'deepseek', 'deepseek-v4-flash', { inputTokens: 100, outputTokens: 50 }, Date.now() - 2 * 86400000)
// step 2: 模型A 带缓存与推理；message 用量替换 chunk 用量（模拟 message 比 chunk 更全）
{
  curTime = Date.now() - 2 * 86400000
  const hdr = mkEvent('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } }, reason: 'change' })
  handlers['session/event'](fakeSession, hdr)
  const c1 = mkEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 80, outputTokens: 20 } } })
  handlers['session/event'](fakeSession, c1)
  const c2 = mkEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 500, cacheWriteTokens: 60, reasoningTokens: 10 } } })
  handlers['session/event'](fakeSession, c2)
  const msg = mkEvent('assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' }, content: [] },
    usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 500, cacheWriteTokens: 60, reasoningTokens: 10 },
  })
  handlers['session/event'](fakeSession, msg)
}
// step 3: 今天，模型B，只有 chunk 用量、message 无 usage（兜底场景）
{
  curTime = Date.now()
  const hdr = mkEvent('request/header', { header: { config: { provider: 'pi-ai', model: 'pi-ai-model-b' } }, reason: 'change' })
  handlers['session/event'](fakeSession, hdr)
  const c = mkEvent('assistant/chunk', { turn: 2, step: 0, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } })
  handlers['session/event'](fakeSession, c)
  const msg = mkEvent('assistant/message', { turn: 2, step: 0, message: { role: 'assistant', source: { kind: 'model', provider: 'pi-ai', model: 'pi-ai-model-b' }, content: [] } })
  handlers['session/event'](fakeSession, msg)
}
// step 4: 今天，模型B，纯 chunk 且 message 带 usage（替换）
{
  curTime = Date.now()
  const c = mkEvent('assistant/chunk', { turn: 3, step: 0, chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500 } } })
  handlers['session/event'](fakeSession, c)
  const msg = mkEvent('assistant/message', {
    turn: 3, step: 0,
    message: { role: 'assistant', source: { kind: 'model', provider: 'pi-ai', model: 'pi-ai-model-b' }, content: [] },
    usage: { inputTokens: 900, outputTokens: 400, cacheReadTokens: 50 },
  })
  handlers['session/event'](fakeSession, msg)
}
// 重复事件（模拟 created 回放与 event 火线重叠）：同 seq 应被去重
handlers['session/event'](fakeSession, { type: 'assistant/message', seq: 3, time: Date.now() - 2 * 86400000, data: { turn: 1, step: 0, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' }, content: [] }, usage: { inputTokens: 999999, outputTokens: 999999 } } })

// session/flush 立即落盘
await handlers['session/flush'](fakeSession)

// ---- 断言 ----
const route = registered.routes[0]
const send = (body) => { lastResp = { code: 200, obj: JSON.parse(body) } }
let lastResp = null
const req = { url: '/tokens-api/stats?from=&to=', method: 'GET' }
await route.handler(req, { writeHead: () => {}, end: send })

const r = lastResp.obj
console.log('overall:', JSON.stringify(r.overall, null, 1))
console.log('today:', JSON.stringify(r.today))
console.log('range:', JSON.stringify(r.range))

function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name)
  if (!cond) process.exitCode = 1
}

const o = r.overall
// 总：100+50 + 100+30+500+60 + 10+5 + 900+400+50 = 2205
check('overall totalTokens = 2205', o.totalTokens === 2205)
check('overall requests = 4', o.requests === 4)
check('overall reasoning = 10', o.reasoningTokens === 10)
check('model count = 2', o.models.length === 2)
const flash = o.models.find((m) => m.model === 'deepseek-v4-flash')
check('flash total = 840', flash.totalTokens === 840)
check('flash share', Math.abs(flash.share - Math.round((840 / 2205) * 1000) / 10) < 0.001)
// 今天 = step3(15) + step4(1350) = 1365
check('today totalTokens = 1365', r.today.totalTokens === 1365)
check('today requests = 2', r.today.requests === 2)

// 日期区间：只取昨天
const req2 = { url: '/tokens-api/stats?from=' + encodeURIComponent(new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)) + '&to=' + encodeURIComponent(new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)), method: 'GET' }
lastResp = null
await route.handler(req2, { writeHead: () => {}, end: send })
const rr = lastResp.obj.range
check('range exists', !!rr)
check('range total = 840', rr.totalTokens === 840)
check('range days length = 1', rr.days.length === 1)

// 重启恢复：重新 apply（新 ctx），load 应重建同样的聚合
const handlers2 = {}
const registered2 = { routes: [] }
const ctx2 = {
  get(name) {
    if (name === 'webServer') return { register(route) { registered2.routes.push(route); return () => {} } }
    return undefined
  },
  on(ev, fn) { handlers2[ev] = fn },
  effect(fn) { fn() },
  sessions: { list() { return [] } },
}
mod.apply(ctx2, cfg)
await new Promise((res) => setTimeout(res, 20))
const route2 = registered2.routes[0]
lastResp = null
await route2.handler({ url: '/tokens-api/stats', method: 'GET' }, { writeHead: () => {}, end: send })
const r2 = lastResp.obj
check('reload: overall totalTokens = 2205', r2.overall.totalTokens === 2205)
check('reload: requests = 4', r2.overall.requests === 4)
check('reload: today = 1365', r2.today.totalTokens === 1365)
check('meta.dataDir', r2.meta.dataDir === tmp)

rmSync(tmp, { recursive: true, force: true })
console.log('done')
