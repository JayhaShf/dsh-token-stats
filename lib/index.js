/**
 * dsh-token-stats — Token 用量统计（部署级双面插件，宿主半区）。
 *
 * 捕获：按官方记账约定读取每个步骤的 `assistant/chunk { type: 'usage' }`
 * 用量分片；同一步骤最终 `assistant/message.usage` 替换样本（不重复计数）。
 * 模型归属来自该会话最新的 `request/header` 快照（provider/model）；
 * assistant/message 自带 model 溯源时优先使用。
 *
 * 覆盖：启动时回放 `ctx.sessions.list()` 全部会话日志（构造种子不触发
 * `session/event` 火线），随后 `session/created` 回放种子 + `session/event`
 * 逐条增量，按 (sessionId, seq) 去重，三条路径幂等叠加。
 *
 * 持久化：样本以 JSONL 追加写入 `<dataDir>/usage.jsonl`（防抖批量落盘，
 * `session/flush` 时立即落盘）；重载时按同 key 后者胜的 fold 语义重建，
 * message 样本自然覆盖同一 (turn, step) 的 chunk 样本。
 *
 * 服务：webServer 同源前缀路由 `/tokens-api/*` 供设置页统计查询；
 * 注册模型工具 `token_stats`（对话中直接查询用量）。
 */

import Schema from '@deepseek-ai/schemastery'
import { appendFile, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 部署约定：机器本地派生数据放 $DSH_HOME/storages/<plugin>（web-app 的
// session-persistence 根即 dshHomePath('storages')）。DSH_HOME 未设置时回退
// ~/.dsh，避免 process.cwd() 随 bash 调用漂移散落文件。
const DEFAULT_DATA_DIR = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'storages',
  'dsh-token-stats',
)

export const Config = Schema.object({
  dataDir: Schema.string().default(DEFAULT_DATA_DIR),
  // 0 = 永久保留；>0 时加载/采集/查询都按天数裁剪。
  retentionDays: Schema.number().min(0).default(0),
  // 采集样本批量落盘的防抖窗口。
  flushDelayMs: Schema.number().min(50).default(2000),
})

const DAY_MS = 24 * 60 * 60 * 1000

function isUsage(u) {
  return !!u && Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens)
}

function num(v) {
  return Number.isFinite(v) ? v : 0
}

/** 本地时区 YYYY-MM-DD（与服务端/浏览器同一台机器，口径一致）。 */
function localDay(time) {
  const d = new Date(time)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function validDay(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''
}

function emptyTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}

// 合计口径与 dsh-token-meter 一致：输入 + 输出 + 缓存读 + 缓存写；
// 推理是输出的细分项，不再重复计入。
function addTo(t, s) {
  t.requests += 1
  t.inputTokens += s.inputTokens
  t.outputTokens += s.outputTokens
  t.cacheReadTokens += s.cacheReadTokens
  t.cacheWriteTokens += s.cacheWriteTokens
  t.reasoningTokens += s.reasoningTokens
  t.totalTokens += s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens
  return t
}

function getOr(map, key, make) {
  let v = map.get(key)
  if (v === undefined) {
    v = make ? make() : emptyTotals()
    map.set(key, v)
  }
  return v
}

function totalsToJSON(t) {
  return {
    requests: t.requests,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    reasoningTokens: t.reasoningTokens,
    totalTokens: t.totalTokens,
  }
}

function apply(ctx, config) {
  const sessions = ctx.sessions
  const tools = ctx.get('tools')
  const webServer = ctx.get('webServer')

  const dataFile = path.join(config.dataDir, 'usage.jsonl')

  // ---- 状态：samples 是最终 fold 态（同 key 后者胜） ----
  const state = {
    samples: new Map(), // key `${sessionId}:${turn}:${step}` -> sample
    seenSeqs: new Map(), // sessionId -> Set<seq>（三条路径去重）
    header: new Map(), // sessionId -> { provider, model, time }（最新 request/header）
    pending: [], // 待落盘样本
    chain: Promise.resolve(), // 串行化 appendFile
    flushTimer: null,
    processed: 0,
  }

  const retentionCutoff = () =>
    config.retentionDays > 0 ? Date.now() - config.retentionDays * DAY_MS : 0

  function makeSample(sessionId, turn, step, time, attr, usage, source) {
    return {
      key: `${sessionId}:${turn}:${step}`,
      sessionId,
      turn,
      step,
      provider: attr && attr.provider ? attr.provider : 'unknown',
      model: attr && attr.model ? attr.model : 'unknown',
      time,
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadTokens: num(usage.cacheReadTokens),
      cacheWriteTokens: num(usage.cacheWriteTokens),
      reasoningTokens: num(usage.reasoningTokens),
      source,
    }
  }

  function addSample(sample) {
    if (config.retentionDays > 0 && sample.time < retentionCutoff()) return
    state.samples.set(sample.key, sample) // 同 key 后者胜（message 覆盖 chunk）
    state.pending.push(sample)
    state.processed += 1
    scheduleFlush()
  }

  function processEvent(sessionId, ev) {
    let seen = state.seenSeqs.get(sessionId)
    if (!seen) {
      seen = new Set()
      state.seenSeqs.set(sessionId, seen)
    }
    if (seen.has(ev.seq)) return
    seen.add(ev.seq)

    const d = ev.data || {}
    switch (ev.type) {
      case 'request/header': {
        const cfg = d.header && d.header.config
        if (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
          state.header.set(sessionId, { provider: cfg.provider, model: cfg.model, time: ev.time })
        }
        return
      }
      case 'assistant/chunk': {
        const c = d.chunk
        if (c && c.type === 'usage' && isUsage(c.usage)) {
          addSample(makeSample(
            sessionId, d.turn, d.step, ev.time,
            state.header.get(sessionId), c.usage, 'chunk',
          ))
        }
        return
      }
      case 'assistant/message': {
        if (isUsage(d.usage)) {
          // 最终消息用量替换该步骤的 chunk 样本（官方语义：不重复计数）。
          const src = d.message && d.message.source && d.message.source.kind === 'model'
            ? d.message.source
            : null
          const attr = src
            ? { provider: src.provider, model: src.model, time: ev.time }
            : state.header.get(sessionId)
          addSample(makeSample(
            sessionId, d.turn, d.step, ev.time, attr, d.usage, 'message',
          ))
        }
        return
      }
    }
  }

  function replaySession(s) {
    for (const ev of s.events) processEvent(s.id, ev)
  }

  // ---- 持久化 ----
  function appendLines(lines) {
    return new Promise((resolve, reject) => {
      appendFile(dataFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  function drain() {
    if (state.pending.length === 0) return
    const batch = state.pending
    state.pending = []
    state.chain = state.chain
      .then(() => appendLines(batch))
      .catch((err) => {
        console.log('[token-stats] 写入用量日志失败：' + (err && err.message ? err.message : String(err)))
      })
    return state.chain
  }

  function scheduleFlush() {
    if (state.flushTimer) return
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null
      drain()
    }, config.flushDelayMs)
  }

  function load() {
    mkdirSync(config.dataDir, { recursive: true })
    if (!existsSync(dataFile)) return
    let text = ''
    try {
      text = readFileSync(dataFile, 'utf8')
    } catch (err) {
      console.log('[token-stats] 读取用量日志失败：' + (err && err.message ? err.message : String(err)))
      return
    }
    const cutoff = retentionCutoff()
    const keep = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const s = JSON.parse(t)
        if (!s || typeof s.key !== 'string') continue
        if (cutoff && s.time < cutoff) continue
        state.samples.set(s.key, s)
        keep.push(s)
      } catch (e) {
        // 损坏行跳过，不阻断加载。
      }
    }
    state.processed += keep.length
    if (cutoff && keep.length < text.split('\n').length) {
      try {
        writeFileSync(dataFile, keep.map((l) => JSON.stringify(l)).join('\n') + (keep.length ? '\n' : ''))
      } catch (e) {
        // 压缩失败不影响运行，下次加载再试。
      }
    }
  }

  // ---- 聚合查询 ----
  function aggregate(fromDay, toDay) {
    const overall = emptyTotals()
    const byModel = new Map()
    const byDay = new Map()
    const byDayModel = new Map()
    const cutoff = retentionCutoff()
    for (const s of state.samples.values()) {
      if (cutoff && s.time < cutoff) continue
      const day = localDay(s.time)
      if (fromDay && day < fromDay) continue
      if (toDay && day > toDay) continue
      addTo(overall, s)
      addTo(getOr(byModel, s.model), s)
      addTo(getOr(byDay, day), s)
      addTo(getOr(getOr(byDayModel, day, () => new Map()), s.model), s)
    }
    return { overall, byModel, byDay, byDayModel }
  }

  function modelList(byModel, overall) {
    const rows = []
    for (const [model, t] of byModel) {
      rows.push(Object.assign({ model }, totalsToJSON(t), {
        share: overall.totalTokens > 0
          ? Math.round((t.totalTokens / overall.totalTokens) * 1000) / 10
          : 0,
      }))
    }
    rows.sort((a, b) => b.totalTokens - a.totalTokens)
    return rows
  }

  function dayList(byDay) {
    const rows = []
    for (const [day, t] of byDay) {
      rows.push(Object.assign({ day }, totalsToJSON(t)))
    }
    rows.sort((a, b) => a.day.localeCompare(b.day))
    return rows
  }

  function statsPayload(from, to) {
    const fromDay = validDay(from)
    const toDay = validDay(to)
    const agg = aggregate(fromDay, toDay)
    const today = localDay(Date.now())
    const todayAgg = aggregate(today, today)
    return {
      ok: true,
      meta: {
        dataDir: config.dataDir,
        retentionDays: config.retentionDays,
        recordCount: state.samples.size,
        processed: state.processed,
      },
      overall: Object.assign(totalsToJSON(agg.overall), {
        models: modelList(agg.byModel, agg.overall),
        days: dayList(agg.byDay),
      }),
      today: totalsToJSON(todayAgg.overall),
      range: fromDay || toDay
        ? Object.assign(
            { from: fromDay || '', to: toDay || '' },
            totalsToJSON(agg.overall),
            { models: modelList(agg.byModel, agg.overall), days: dayList(agg.byDay) },
          )
        : null,
    }
  }

  // ---- 浏览器同源 HTTP 接口（/tokens-api/*）----
  // webServer.register 不是 effect 注册（路由存进服务表、disposer 由调用方持有），
  // 必须经 ctx.effect 声明清理：插件卸载/HMR 重载时移除路由，否则残留路由会让
  // 下次 register 抛 duplicate prefix route 导致插件加载失败。
  if (webServer) {
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: '/tokens-api',
        handler: async (req, res) => {
          const send = (code, obj) => {
            const body = JSON.stringify(obj)
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(body)
          }
          try {
            const url = new URL(req.url || '/', 'http://x')
            const pathname = url.pathname
            const method = req.method || 'GET'
            if (method === 'GET' && pathname === '/tokens-api/ping') {
              send(200, { ok: true, t: Date.now() })
              return
            }
            if (method === 'GET' && pathname === '/tokens-api/stats') {
              send(200, statsPayload(
                url.searchParams.get('from') || '',
                url.searchParams.get('to') || '',
              ))
              return
            }
            send(404, { ok: false, error: 'not found' })
          } catch (err) {
            try { send(500, { ok: false, error: err && err.message ? err.message : String(err) }) } catch (e) { /* 响应已销毁 */ }
          }
        },
      })
      return dispose
    })
  }

  // ---- 模型工具：对话中直接查询用量 ----
  if (tools) {
    tools.register({
      name: 'token_stats',
      description:
        '查询 DSH 的 Token 用量统计（提供方上报数据）：累计/今日总量、按模型与按天分解、日期范围查询。' +
        '传 days=最近 N 天，或传 from/to（YYYY-MM-DD）指定区间；都不传时默认最近 7 天。',
      // OpenAI 兼容网关要求 function.parameters 是 type:"object" 的 JSON Schema，
      // 裸注册必须显式声明 type 根节点（defineTool 编译后的工具均带）。
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '最近 N 天的用量（默认 7，最大 365）' },
          from: { type: 'string', description: '起始日期，格式 YYYY-MM-DD' },
          to: { type: 'string', description: '结束日期，格式 YYYY-MM-DD，缺省为今天' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            range: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                    requests: { type: 'number' },
                    inputTokens: { type: 'number' },
                    outputTokens: { type: 'number' },
                    cacheReadTokens: { type: 'number' },
                    cacheWriteTokens: { type: 'number' },
                    reasoningTokens: { type: 'number' },
                    totalTokens: { type: 'number' },
                  },
                  required: ['from', 'to', 'requests', 'totalTokens'],
                },
                { type: 'null' },
              ],
            },
            today: {
              type: 'object',
              properties: {
                requests: { type: 'number' },
                inputTokens: { type: 'number' },
                outputTokens: { type: 'number' },
                cacheReadTokens: { type: 'number' },
                cacheWriteTokens: { type: 'number' },
                reasoningTokens: { type: 'number' },
                totalTokens: { type: 'number' },
              },
              required: ['requests', 'totalTokens'],
            },
            overall: {
              type: 'object',
              properties: {
                requests: { type: 'number' },
                inputTokens: { type: 'number' },
                outputTokens: { type: 'number' },
                cacheReadTokens: { type: 'number' },
                cacheWriteTokens: { type: 'number' },
                reasoningTokens: { type: 'number' },
                totalTokens: { type: 'number' },
              },
              required: ['requests', 'totalTokens'],
            },
            models: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  model: { type: 'string' },
                  requests: { type: 'number' },
                  inputTokens: { type: 'number' },
                  outputTokens: { type: 'number' },
                  cacheReadTokens: { type: 'number' },
                  cacheWriteTokens: { type: 'number' },
                  reasoningTokens: { type: 'number' },
                  totalTokens: { type: 'number' },
                  share: { type: 'number' },
                },
                required: ['model', 'requests', 'totalTokens'],
              },
            },
            days: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  day: { type: 'string' },
                  requests: { type: 'number' },
                  inputTokens: { type: 'number' },
                  outputTokens: { type: 'number' },
                  cacheReadTokens: { type: 'number' },
                  cacheWriteTokens: { type: 'number' },
                  reasoningTokens: { type: 'number' },
                  totalTokens: { type: 'number' },
                },
                required: ['day', 'requests', 'totalTokens'],
              },
            },
          },
          required: ['ok', 'today', 'overall'],
          additionalProperties: false,
        },
        render(_args, value) {
          const v = value || {}
          if (!v.ok) return [{ type: 'text', text: 'Token 用量查询失败：' + (v.error || '未知错误') }]
          const fmt = (n) => String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
          const lines = []
          const o = v.overall || {}
          lines.push(
            `累计用量：${fmt(o.totalTokens)} tokens（请求 ${fmt(o.requests)} 次；` +
            `输入 ${fmt(o.inputTokens)} · 输出 ${fmt(o.outputTokens)} · ` +
            `缓存读 ${fmt(o.cacheReadTokens)} · 缓存写 ${fmt(o.cacheWriteTokens)}` +
            (o.reasoningTokens ? ` · 其中推理 ${fmt(o.reasoningTokens)}` : '）'),
          )
          const t = v.today || {}
          lines.push(`今日用量：${fmt(t.totalTokens)} tokens（请求 ${fmt(t.requests)} 次）`)
          const r = v.range
          if (r) {
            lines.push(
              `${r.from || '?'} ~ ${r.to || '?'} 区间：${fmt(r.totalTokens)} tokens（请求 ${fmt(r.requests)} 次）`,
            )
          }
          const ms = v.models || []
          if (ms.length) {
            lines.push('按模型：' + ms.map((m) => `${m.model} ${fmt(m.totalTokens)} (${m.share || 0}%)`).join(' · '))
          }
          const ds = v.days || []
          if (ds.length) {
            lines.push('按天：' + ds.slice(-7).map((d) => `${d.day} ${fmt(d.totalTokens)}`).join(' · '))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        let from = ''
        let to = ''
        if (typeof args.from === 'string' && args.from) from = args.from
        if (typeof args.to === 'string' && args.to) to = args.to
        if (!from && !to) {
          const days = Number.isFinite(args.days)
            ? Math.max(1, Math.min(365, Math.floor(args.days)))
            : 7
          const d = new Date()
          d.setDate(d.getDate() - (days - 1))
          from = localDay(d.getTime())
          to = localDay(Date.now())
        }
        return statsPayload(from, to)
      },
    })
  }

  // ---- 启动：加载持久化样本 + 回放现存会话 + 订阅实时事件 ----
  load()

  for (const s of sessions.list()) replaySession(s)

  ctx.on('session/created', (s) => replaySession(s))
  ctx.on('session/event', (s, ev) => processEvent(s.id, ev))
  // session/flush 是受等待的持久性检查点：立即排空缓冲。
  ctx.on('session/flush', () => drain())

  // 落盘防抖定时器 + 卸载清理。
  ctx.effect(() => {
    return () => {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer)
        state.flushTimer = null
      }
      drain()
    }
  })

  console.log(`[token-stats] plugin loaded! dataDir=${config.dataDir}`)
}

export default { name: 'dsh-token-stats', Config, apply }
