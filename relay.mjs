#!/usr/bin/env node
/**
 * maid-bridge / relay.mjs
 * ============================================================================
 * **让车万女仆用「我的角色卡」说话的本地 OpenAI 兼容中转。**
 *
 * 为什么需要它：车万女仆（touhoulittlemaid 1.5.3）的 AI 对话支持"自加 LLM 站点"，
 * 站点里填的是一个**完整端点 URL**（类里写死的默认值是
 * `https://api.openai.com/v1/chat/completions`，`LLMApiType.OPENAI` ⇒ OpenAI 兼容）。
 * 所以只要本机起一个同形状的端点，就能在请求里**插入我的角色卡**再转发给 DeepSeek。
 *
 * 请求/响应形状（从 TLM 的 class 里抽出来的，用来对齐）：
 *   请求：{ model, messages[{role,content,tool_calls,tool_call_id}],
 *           tools[{type:'function',function:{...}}], response_format:{type:'json_object'}, thinking? }
 *   响应：{ model, choices:[{ message:{ content, tool_calls } }], usage:{...} }
 *   ⚠️ TLM 会**自己解析回复里的 JSON**（`chat.llm.json_decode_error`）⇒ 本中转**只插入角色卡、
 *      不改上游返回体**，输出格式仍由 TLM 自己那条 system 消息约束。
 *
 * 用法：
 *   node relay.mjs                      # 监听 127.0.0.1:8788，转发到 DeepSeek
 *   node relay.mjs --mock               # 不发外网：返回固定回复（验证 TLM→中转 这条链）
 *   node relay.mjs --port 8788 --host 127.0.0.1
 *   node relay.mjs --upstream https://api.deepseek.com/v1/chat/completions
 *   node relay.mjs --dump               # 每次完整请求/响应写进 dumps/（排查用）
 *   node relay.mjs --drop-system        # 丢掉 TLM 自己的 system 段（⚠️ 可能连输出格式约定一起丢）
 *   node relay.mjs --persona other.md   # 换角色卡
 *
 * 鉴权：默认**透传**客户端带来的 `Authorization` 头（TLM 站点里填的 secret_key）
 *      ⇒ 本中转**不存储任何密钥**。没有该头时才退回环境变量 `MAID_BRIDGE_KEY`。
 * ============================================================================
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { readRuntime, shouldInject, memoryMessage, foldForBridge, shapeBridgeReply } from './shared-context.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_UPSTREAM = 'https://api.deepseek.com/v1/chat/completions'
const MAX_BODY = 4 * 1024 * 1024          // TLM 的上下文可能不小，但别无限
const LOG = join(HERE, 'relay.log')
const DUMPS = join(HERE, 'dumps')

/**
 * 共享记忆的来源：**maid-memory 插件**的 data 目录。
 * 插件没在跑（心跳过期 + 进程不在）时 readRuntime() 会把模式压成 off ⇒ 不注入。
 * 这就是"默认不调用、启动插件才开放注入"的落点。
 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEFAULT_SHARED_DIR = join(DSH_HOME, 'extensions', 'maid-memory', 'data')
/** 狂野模式的上游：DSH 的 openclaw 桥接（OpenAI 兼容，回环免 token） */
const DEFAULT_BRIDGE = `http://127.0.0.1:${process.env.DSH_WEB_PORT ?? 58689}/openclaw-bridge/v1/chat/completions`
const DEFAULT_BRIDGE_MODEL = 'dsh-bridge/maid'

/** 本地时间戳 —— 用 UTC 的 ISO 串会和游戏里的时间对不上，排查时容易看走眼 */
const stamp = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const log = (m) => {
  const line = `[${stamp()}] ${m}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch {}
}

/**
 * 上游（DeepSeek）只认这几个 role。
 * ⚠️ 车万女仆会发 **`developer`** —— 那是 OpenAI 新版里 `system` 的继任者，
 * 但 DeepSeek 直接回 422：`unknown variant 'developer', expected one of
 * system, user, assistant, tool, latest_reminder`
 * （证据：jar 里 `ai/service/llm/Role.class` 的枚举是
 *   system / user / assistant / tool / developer，且 `LLMOpenAIClient` 会调
 *   `ChatMessage.developerChat(...)`）
 * ⇒ 本中转把不认的 role 一律改写成 `system`，**这就是它存在的第二个理由**。
 */
export const UPSTREAM_ROLES = new Set(['system', 'user', 'assistant', 'tool', 'latest_reminder'])

export function normalizeRoles (messages, onRoleFix) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const r = m?.role
    if (!r || UPSTREAM_ROLES.has(r)) return m
    onRoleFix?.(r, 'system')
    return { ...m, role: 'system' }
  })
}

/**
 * 插角色卡。
 * 位置：**在开头那一段 system/developer 之后**、对话之前 ——
 *   [TLM system][TLM developer→system][⭐角色卡][user][assistant]…
 * 为什么不放第 0 条：TLM 那条 system 通常就是女仆自己的「角色设定」，
 * 而模型对**靠后的**冲突指令更买账 ⇒ 我的卡放后面才管得住她
 * （persona.md 里那句「覆盖此前任何角色设定」也因此才成立）。
 * 其余消息**原样保留所有字段**（content / tool_calls / tool_call_id / name …）。
 */
export function buildMessages (messages, personaText, { dropSystem = false, roleFix = true, onRoleFix = null, onPersonaAt = null } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const kept = dropSystem
    ? list.filter((m) => m?.role !== 'system' && m?.role !== 'developer')
    : list
  const out = kept.map((m) => ({ ...m }))
  if (roleFix) {
    const fixed = normalizeRoles(out, onRoleFix)
    out.length = 0; out.push(...fixed)
  }
  let at = 0
  while (at < out.length && (out[at].role === 'system' || out[at].role === 'developer')) at++
  if (personaText) {
    out.splice(at, 0, { role: 'system', content: personaText })
    onPersonaAt?.(at)
  }
  return out
}

/**
 * 思考模式的坑（都有证据，不是猜的）：
 *   ① DeepSeek 规定：**带 tools 的请求**必须把上一轮的 `reasoning_content` 原样回传，
 *      否则后续请求直接 400（api-docs.deepseek.com/guides/thinking_mode）。
 *   ② 车万女仆的 `response/Message.class` 字段只有 role / content / tool_calls
 *      —— **根本不存 reasoning_content**（整个 jar 里 "reasoning" 只出现在站点配置的
 *      isReasoning 与 usage 的 reasoning_tokens 上）。
 *   ⇒ 只要 TLM 发 `thinking:{type:'enabled'}` 又带 tools，工具调用在第二轮**必然 400**。
 *   所以默认：**带 tools 时把 enabled 降级成 disabled**，并把这笔改写记进日志。
 *   想保留思考（并自己承担那个 400）：设环境变量 `MAID_BRIDGE_KEEP_THINKING=1`。
 */
export function guardThinking (body, notes = []) {
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
  if (!hasTools) return body                       // 不带 tools ⇒ 思考随便开，不插手
  const t = body.thinking
  const cur = (t && typeof t === 'object') ? t.type : undefined
  if (cur === 'disabled') return body              // 已经关着 ⇒ 不动
  body.thinking = { ...(t && typeof t === 'object' ? t : {}), type: 'disabled' }
  notes.push(cur === 'enabled'
    ? 'thinking: enabled → disabled —— TLM 不存 reasoning_content，带 tools 的思考模式第二轮必然 400'
    : 'thinking: 请求里**没给**（DeepSeek 默认是开）→ 显式改成 disabled —— 同上，TLM 存不下 reasoning_content')
  return body
}

/** 把 TLM 的请求体改成要发给上游的请求体（只动 messages / thinking，其余字段原样透传） */
export function buildUpstreamBody (body, personaText, opts = {}) {
  const out = { ...(body && typeof body === 'object' ? body : {}) }
  const notes = []
  out.messages = buildMessages(out.messages, personaText, opts)
  if (!out.model) out.model = opts.defaultModel ?? 'deepseek-chat'
  if (opts.thinkingGuard !== false && !process.env.MAID_BRIDGE_KEEP_THINKING) guardThinking(out, notes)
  // 非枚举 ⇒ JSON.stringify 不会把它发给上游；只是给调用方拿来打日志
  Object.defineProperty(out, '__notes', { value: notes, enumerable: false })
  return out
}

const json = (res, code, obj) => {
  const s = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

/** 给 TLM 一个**标准形状**的错误（它会显示 `HTTP Error Code: %d, Response: %s`） */
const oaiError = (res, code, message) => json(res, code, {
  error: { message, type: 'maid_bridge_error', code },
})

export function createRelay (opts = {}) {
  const {
    personaPath = join(HERE, 'persona.md'),
    upstream = DEFAULT_UPSTREAM,
    upstreamKey = process.env.MAID_BRIDGE_KEY ?? '',
    mock = false,
    dump = false,
    dropSystem = false,
    defaultModel = 'deepseek-chat',
    fetchImpl = globalThis.fetch,
    // ── 共享记忆 / 狂野模式 ────────────────────────────────────────────────
    sharedContextDir = DEFAULT_SHARED_DIR,
    bridge = DEFAULT_BRIDGE,
    bridgeModel = DEFAULT_BRIDGE_MODEL,
  } = opts

  let persona = ''
  try { persona = readFileSync(personaPath, 'utf8').trim() } catch (e) { log(`⚠️ 角色卡读不到（${personaPath}）：${e.message} —— 将只做透传`) }
  // 角色卡热重载：每 5 秒看一眼文件 ⇒ 改完 persona.md 不用重启中转
  // （unref 过，所以它不会拖着进程不退出；test.mjs 里创建的那些实例也不受影响）
  const personaWatch = setInterval(() => {
    try {
      const t = readFileSync(personaPath, 'utf8').trim()
      if (t !== persona) { persona = t; log(`角色卡已热重载：${t.length} 字符`) }
    } catch {}
  }, 5000)
  personaWatch.unref?.()

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      const r = readRuntime(sharedContextDir)
      return json(res, 200, {
        ok: true, service: 'maid-bridge', mode: mock ? 'mock' : 'forward',
        upstream: mock ? null : upstream, persona: persona ? `${persona.length} 字符` : '(未加载)',
        dropSystem,
        shared: { mode: r.mode, pluginRunning: r.running, memoryChars: r.memory.length, why: r.why, dir: sharedContextDir },
        bridge: { url: bridge, model: bridgeModel, note: '模式=wild 时女仆的脑子会走这里（DSH 会话）' },
        tips: '把这个地址填进车万女仆的 LLM 站点 URL（要带 /v1/chat/completions）',
      })
    }
    // 有的客户端会探模型列表；给一个静态表就够（TLM 的模型是在站点配置里手填的）
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: [{ id: 'deepseek-chat', object: 'model' }, { id: 'deepseek-reasoner', object: 'model' },
          { id: 'deepseek-v4-flash', object: 'model' }],
      })
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return oaiError(res, 404, `只支持 POST /v1/chat/completions（收到 ${req.method} ${url.pathname}）`)
    }

    // ── 读请求体 ──────────────────────────────────────────────────────────
    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > MAX_BODY) { oaiError(res, 413, '请求体过大'); req.destroy(); return }
      }
    } catch (e) { return oaiError(res, 400, `读请求体失败：${e.message}`) }

    let body
    try { body = JSON.parse(raw || '{}') } catch (e) { return oaiError(res, 400, `请求体不是合法 JSON：${e.message}`) }

    const inMsgs = Array.isArray(body.messages) ? body.messages : []
    const tools = Array.isArray(body.tools) ? body.tools : []
    log(`← TLM 请求：model=${body.model ?? '(未给)'} messages=${inMsgs.length}（roles=${[...new Set(inMsgs.map((m) => m?.role))].join('/')}）tools=${tools.length} response_format=${body.response_format?.type ?? '-'} auth=${req.headers.authorization ? '有' : '无'}`)

    // ── 共享记忆 / 狂野模式 ────────────────────────────────────────────────
    // 真源是 maid-memory 插件写的文件；**插件没在跑就一律按 off**（见 shared-context.mjs）。
    const rt = readRuntime(sharedContextDir)
    if (rt.running || rt.mode !== 'off') log(`  共享记忆：${rt.why}（记忆 ${rt.memory.length} 字符）`)

    if (rt.wild) {
      // 狂野模式：女仆的脑子直接接到 DSH 会话。
      // 折叠 system→一条 user（桥接只认 role:user），回复再整形回 TLM 要的两段式。
      const folded = foldForBridge(body, persona, { memory: rt.memory })
      const t0w = Date.now()
      try {
        const r = await fetchImpl(bridge, {
          method: 'POST',
          // 回环地址免 token ⇒ **故意不转发**客户端的 Authorization
          // （那是 Fish/DeepSeek 的 key，桥接不认，转发反而可能被拒）
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: bridgeModel, stream: false, messages: [{ role: 'user', content: folded }] }),
        })
        const text = await r.text()
        let j = null
        try { j = JSON.parse(text) } catch {}
        const raw = j?.choices?.[0]?.message?.content ?? text
        const shaped = shapeBridgeReply(raw)
        let out
        if (j?.choices?.[0]?.message) { j.choices[0].message.content = shaped; out = j }
        else out = { choices: [{ index: 0, message: { role: 'assistant', content: shaped }, finish_reason: 'stop' }] }
        log(`→ 狂野模式（DSH 会话「${bridgeModel}」）上游 ${r.status}（${Date.now() - t0w}ms，折叠 ${folded.length} → 整形 ${shaped.length} 字符）`)
        if (dump) { try { if (!existsSync(DUMPS)) mkdirSync(DUMPS, { recursive: true }); writeFileSync(join(DUMPS, `${Date.now()}-wild.json`), JSON.stringify({ folded, raw, shaped }, null, 2), 'utf8') } catch {} }
        return json(res, r.ok ? 200 : r.status, out)
      } catch (e) {
        log(`× 狂野模式失败：${e.message}`)
        return oaiError(res, 502, `狂野模式（DSH 桥接）失败：${e.message}`)
      }
    }

    const roleFixes = []
    let personaAt = null
    const upBody = buildUpstreamBody(body, persona, {
      dropSystem,
      defaultModel,
      onRoleFix: (from, to) => roleFixes.push(`${from}→${to}`),
      onPersonaAt: (i) => { personaAt = i },
    })
    if (roleFixes.length) log(`  ⚠️ 上游不认的 role 已改写：${[...new Set(roleFixes)].join('、')}（DeepSeek 只认 system/user/assistant/tool/latest_reminder）`)
    for (const n of upBody.__notes ?? []) log(`  ⚠️ ${n}`)

    // 共享记忆注入（mode = maid / both）：插在**角色卡之后**（靠后 = 更被买账）
    if (shouldInject(rt)) {
      const mm = memoryMessage(rt)
      if (mm) {
        upBody.messages.splice((personaAt ?? 0) + 1, 0, mm)
        log(`  ✅ 已注入共享记忆（第 ${(personaAt ?? 0) + 1} 条 system，${mm.content.length} 字符）`)
      } else log('  ⚠️ 模式要求注入，但记忆是空的 → 跳过')
    }
    if (persona) log(`  角色卡 → 第 ${personaAt} 条（TLM 的 system/developer 段之后）；出方向共 ${upBody.messages.length} 条`)
    if (dump) {
      try {
        if (!existsSync(DUMPS)) mkdirSync(DUMPS, { recursive: true })
        const f = join(DUMPS, `${Date.now()}-request.json`)
        writeFileSync(f, JSON.stringify({ incomingHeaders: { authorization: req.headers.authorization ? '(已省略)' : null }, incoming: body, upstream: upBody }, null, 2), 'utf8')
        log(`  已 dump 请求 → ${f}`)
      } catch (e) { log(`  dump 失败：${e.message}`) }
    }

    // ── mock 模式：不发外网 ────────────────────────────────────────────────
    if (mock) {
      const echo = {
        model: body.model ?? defaultModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              note: '（maid-bridge 自检回复）',
              persona_injected: Boolean(persona),
              messages_in: inMsgs.length,
              messages_out: upBody.messages.length,
              tools_seen: tools.length,
              persona_at: personaAt,
              roles_out: upBody.messages.map((m) => m.role),
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }
      log('→ mock 回复')
      return json(res, 200, echo)
    }

    // ── 转发上游（透传 Authorization，自己不存密钥）────────────────────────
    const auth = req.headers.authorization || (upstreamKey ? `Bearer ${upstreamKey}` : '')
    if (!auth) return oaiError(res, 401, '没有 Authorization：请在女仆的站点里填 Secret Key，或给中转设 MAID_BRIDGE_KEY')
    const t0 = Date.now()
    try {
      const r = await fetchImpl(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(upBody),
      })
      const text = await r.text()
      log(`→ 上游 ${r.status}（${Date.now() - t0}ms，${text.length} 字节）`)
      if (dump) { try { writeFileSync(join(DUMPS, `${Date.now()}-response.json`), text, 'utf8') } catch {} }
      // **原样回包**：TLM 要自己解析里面的 JSON，别动
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json; charset=utf-8' })
      return res.end(text)
    } catch (e) {
      log(`× 上游失败：${e.message}`)
      return oaiError(res, 502, `转发上游失败：${e.message}`)
    }
  })
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(`--${name}`)
  const val = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }
  const port = Number(val('port', 8788))
  const host = val('host', '127.0.0.1')
  const opts = {
    mock: flag('mock'), dump: flag('dump'), dropSystem: flag('drop-system'),
    upstream: val('upstream', DEFAULT_UPSTREAM),
    personaPath: val('persona', join(HERE, 'persona.md')),
  }
  const srv = createRelay(opts)
  // 端口被占时 node 默认把 EADDRINUSE 抛在 stderr 上，而中转是无窗口启动的 ⇒ 会**静默失败**。
  // 这里一定要落进 relay.log，否则"我起了但它没起来"永远查不出来。
  srv.on('error', (e) => {
    log(`× 监听失败：${e.code ?? e.message}${e.code === 'EADDRINUSE'
      ? ` —— ${host}:${port} 已被占用（多半是**已经有一个中转在跑**；本进程退出）`
      : ''}`)
    process.exit(1)
  })
  srv.listen(port, host, () => {
    log(`maid-bridge 已启动：http://${host}:${port}（PID ${process.pid}${opts.dump ? '，已开 --dump' : ''}）`)
    log(`  模式：${opts.mock ? '**mock（不发外网）**' : `转发 → ${opts.upstream}`}`)
    log(`  角色卡：${opts.personaPath}${opts.dropSystem ? '（并丢弃 TLM 的 system 段⚠️）' : ''}`)
    log(`  角色卡位置：TLM 的 system/developer 段**之后**（模型对靠后的冲突指令更买账）`)
    log(`  role 修正：上游不认的 role 自动改写成 system（TLM 会发 developer，不改 DeepSeek 回 422）`)
    log(`  思考护栏：带 tools 时强制 thinking=disabled（TLM 不存 reasoning_content，否则第二轮 400；MAID_BRIDGE_KEEP_THINKING=1 可关）`)
    log(`  在车万女仆里：AI 对话 → 设置 → 站点配置 → 添加，URL 填：`)
    log(`     http://${host}:${port}/v1/chat/completions`)
    log(`  Secret Key 填你自己的 DeepSeek key（中转不存储它，只透传）`)
  })
  const bye = () => { log('收到退出信号，关闭…'); srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref() }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
}
