#!/usr/bin/env node
/**
 * maid-bridge / test.mjs —— 离线自检：证明"TLM → 中转 → 上游 → 原样回包"这条链是对的
 *
 * 为什么必须离线自检：真机那一步要**你在游戏里点几次**（加站点、填 key、跟女仆说话），
 * 而一旦出错，TLM 只会显示一句 `HTTP Error Code: %d, Response: %s`（甚至只说"解析 JSON 出错"），
 * 根本看不出是哪一层的问题。所以先把中转**自己**验干净：
 *   · 假上游（扮演 DeepSeek）记录收到的头与体 ⇒ 逐字段断言
 *   · mock 模式不需要 key、不碰外网 ⇒ 可以随时确认"服务活着、形状对"
 *
 * 用法：node test.mjs
 */
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createRelay, buildMessages, buildUpstreamBody } from './relay.mjs'

const results = []
const ok = (n, extra = '') => results.push({ pass: true, n, extra })
const bad = (n, d) => results.push({ pass: false, n, d })

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const base = (p) => `http://127.0.0.1:${p}`

/** 一份**照着 TLM 的类形状**造的请求：model + messages(system/developer/user) + tools + response_format */
const tlmShapeRequest = () => ({
  model: 'deepseek-v4-flash',
  messages: [
    { role: 'system', content: '回复必须是 JSON：{"text":"<要说的话>"}。你是女仆小玉。' },
    { role: 'developer', content: '当前游戏上下文：主人血量 20/20，附近实体：僵尸×2，距离主人 3.2 格。' },
    { role: 'user', content: '小玉，过来一下' },
  ],
  tools: [
    { type: 'function', function: { name: 'switch_follow_state', description: '切换跟随', parameters: { type: 'object', properties: { follow: { type: 'boolean' } }, required: ['follow'] } } },
    { type: 'function', function: { name: 'switch_work_task', description: '切换工作模式', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } },
  ],
  response_format: { type: 'json_object' },
})

/* ── 1. 纯函数：插角色卡的正确性（最容易写错的一层）────────────────────────── */
{
  const req = tlmShapeRequest()
  const m = buildMessages(req.messages, '【角色卡】你是早濑优香。')
  const personaAt = m.findIndex((x) => String(x.content).includes('早濑优香'))
  if (m.length === req.messages.length + 1 && personaAt === 2) ok('插角色卡：多了一条 system，且落在 TLM 的 system/developer 段**之后**（第 2 条）')
  else bad('插角色卡（位置）', JSON.stringify({ len: m.length, personaAt, roles: m.map((x) => x.role) }))
  if (String(m[0].content).includes('JSON') && String(m[1].content).includes('游戏上下文')) ok('插角色卡：TLM 自己的输出格式约定与游戏上下文**原封不动**（连顺序都没变）')
  else bad('插角色卡（保真）', 'TLM 的 system/developer 段被动过 —— 输出格式约定丢了会导致"解析 JSON 出错"')
  if (!m.some((x) => x.role === 'developer')) ok('role 修正：**没有 developer 漏到上游**（DeepSeek 会回 422，已实测）')
  else bad('role 修正', JSON.stringify(m.map((x) => x.role)))
  const fixed = []
  buildMessages(req.messages, '', { onRoleFix: (a, b) => fixed.push(`${a}→${b}`) })
  if (fixed.join() === 'developer→system') ok('role 修正：改写有回调记录（日志里能说清"改了哪一条"）')
  else bad('role 修正（回调）', JSON.stringify(fixed))
  if (Array.isArray(m[1].tool_calls) === false) ok('插角色卡：消息原有字段未被破坏（tool_calls 等原样）')
  else bad('插角色卡（字段）', '不该凭空出现 tool_calls')

  const dropped = buildMessages(req.messages, '【角色卡】', { dropSystem: true })
  if (dropped.length === 2 && dropped[0].content === '【角色卡】') ok('--drop-system：丢掉 TLM 的 system/developer，只留角色卡（⚠️ 这条要慎用）')
  else bad('--drop-system', JSON.stringify(dropped.map((x) => x.role)))

  const up = buildUpstreamBody(req, '【角色卡】')
  if (up.model === 'deepseek-v4-flash' && up.tools.length === 2 && up.response_format.type === 'json_object') {
    ok('转发体：model / tools / response_format 原样透传（一个字段都没动）')
  } else bad('转发体', JSON.stringify({ model: up.model, tools: up.tools?.length, rf: up.response_format }))

  const up2 = buildUpstreamBody({ messages: [] }, '【角色卡】', { defaultModel: 'deepseek-chat' })
  if (up2.model === 'deepseek-chat') ok('转发体：请求没给 model 时用 defaultModel 兜底（否则上游会 400）')
  else bad('转发体（model 兜底）', String(up2.model))

  const tk = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }]
  const g1 = buildUpstreamBody({ messages: [], tools: tk, thinking: { type: 'enabled' } }, '【卡】')
  if (g1.thinking.type === 'disabled') ok('思考护栏：带 tools 且 enabled ⇒ 降级 disabled（TLM 存不下 reasoning_content，不降第二轮必 400）')
  else bad('思考护栏（enabled）', JSON.stringify(g1.thinking))
  const g2 = buildUpstreamBody({ messages: [], tools: tk }, '【卡】')
  if (g2.thinking?.type === 'disabled') ok('思考护栏：带 tools 但**没给** thinking ⇒ 也显式关掉（上游缺省是开）')
  else bad('思考护栏（字段缺省）', JSON.stringify(g2.thinking))
  const g3 = buildUpstreamBody({ messages: [], thinking: { type: 'enabled' } }, '【卡】')
  if (g3.thinking.type === 'enabled') ok('思考护栏：**不带 tools** 就不插手（没必要时不改模型行为）')
  else bad('思考护栏（无 tools）', JSON.stringify(g3.thinking))
  if (!JSON.stringify(g1).includes('__notes')) ok('思考护栏：__notes 是非枚举字段，不会跟着请求发给上游')
  else bad('思考护栏（字段泄漏）', '__notes 被序列化进去了')
}

/* ── 2. mock 模式：形状自检（不需要 key、不碰外网）─────────────────────────── */
{
  const srv = createRelay({ mock: true })
  const port = await listen(srv)
  try {
    const r = await fetch(`${base(port)}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tlmShapeRequest()),
    })
    const j = await r.json()
    if (r.status === 200 && j.choices?.[0]?.message?.content) ok('mock：返回标准 OpenAI 形状（choices[0].message.content）')
    else bad('mock 形状', `${r.status} ${JSON.stringify(j).slice(0, 200)}`)
    const echo = JSON.parse(j.choices?.[0]?.message?.content ?? '{}')
    if (echo.persona_injected === true && echo.persona_at === 2) ok('mock：确认角色卡已注入，且落在第 2 条（TLM 的 system/developer 之后）')
    else bad('mock（角色卡）', JSON.stringify(echo))
    if (echo.messages_in === 3 && echo.messages_out === 4 && !echo.roles_out.includes('developer')) ok('mock：3 → 4 条，且出方向**没有 developer**')
    else bad('mock（消息数/role）', JSON.stringify(echo))
    if (echo.tools_seen === 2) ok('mock：工具定义原样带到上游侧（TLM 的工具调用不会被中转吃掉）')
    else bad('mock（tools）', JSON.stringify(echo))

    const h = await fetch(`${base(port)}/health`).then((x) => x.json())
    if (h.ok === true && h.mode === 'mock') ok('mock：/health 可用（用来确认"服务是否活着"）')
    else bad('/health', JSON.stringify(h))
  } finally { srv.close() }
}

/* ── 3. 转发路径：假上游逐字段对账（这是最关键的一节）────────────────────── */
{
  /** 假 DeepSeek：记录收到的头/体，回一个**带 tool_calls** 的响应 */
  let seen = null
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      seen = { headers: req.headers, body: JSON.parse(raw || '{}') }
      const body = JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion', model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'switch_follow_state', arguments: '{"follow":true}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    })
  })
  const upPort = await listen(upstream)
  const relay = createRelay({ upstream: `http://127.0.0.1:${upPort}/v1/chat/completions`, personaPath: fileURLToPath(new URL('./persona.md', import.meta.url)) })
  const rPort = await listen(relay)
  try {
    const r = await fetch(`${base(rPort)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-1234' },
      body: JSON.stringify(tlmShapeRequest()),
    })
    const text = await r.text()

    if (seen?.headers.authorization === 'Bearer sk-test-1234') ok('转发：**原样透传**客户端的 Authorization（中转自己不用存密钥）')
    else bad('转发（鉴权透传）', String(seen?.headers.authorization))
    const msgs = seen?.body.messages ?? []
    const pat = msgs.findIndex((x) => String(x.content).includes('早濑优香'))
    if (pat === 2) ok('转发：角色卡真读进了 persona.md，并落在第 2 条（TLM 的 system/developer 之后）')
    else bad('转发（角色卡）', JSON.stringify({ pat, roles: msgs.map((x) => x.role) }).slice(0, 200))
    if (!msgs.some((x) => x.role === 'developer')) ok('转发：到上游时 **developer 已被改写成 system**（不修这条，游戏里必然 422）')
    else bad('转发（role 修正）', JSON.stringify(msgs.map((x) => x.role)))
    if (seen?.body.tools?.length === 2 && seen?.body.response_format?.type === 'json_object' && seen?.body.model === 'deepseek-v4-flash') {
      ok('转发：model / tools / response_format 一个不少（工具调用链不会被掐断）')
    } else bad('转发（字段）', JSON.stringify({ m: seen?.body.model, t: seen?.body.tools?.length, r: seen?.body.response_format }))
    if (r.status === 200 && JSON.parse(text).choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'switch_follow_state') {
      ok('转发：**原样回包**（tool_calls 完整回到 TLM —— 它要自己解析，所以中转不许改）')
    } else bad('转发（原样回包）', text.slice(0, 200))
  } finally { relay.close(); upstream.close() }
}

/* ── 4. 没有 key / 走错路：必须给**标准形状**的错误（TLM 只会显示这一行）──────── */
{
  const srv = createRelay({ upstream: 'http://127.0.0.1:1/nope', upstreamKey: '' })
  const port = await listen(srv)
  try {
    const r = await fetch(`${base(port)}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tlmShapeRequest()),
    })
    const j = await r.json()
    if (r.status === 401 && j.error?.message?.includes('Authorization')) ok('没有 key：401 + OpenAI 形状的错误（TLM 能显示人话，不是"解析 JSON 出错"）')
    else bad('401 形状', `${r.status} ${JSON.stringify(j).slice(0, 160)}`)

    const r2 = await fetch(`${base(port)}/v1/wrong`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const j2 = await r2.json()
    if (r2.status === 404 && j2.error) ok('走错路径：404 + 标准错误体（而不是空响应）')
    else bad('404 形状', `${r2.status}`)

    const r3 = await fetch(`${base(port)}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: 'not-json',
    })
    const j3 = await r3.json()
    if (r3.status === 400 && j3.error) ok('请求体不是 JSON：400 + 标准错误体')
    else bad('400 形状', `${r3.status}`)
  } finally { srv.close() }
}

/* ── 汇总 ─────────────────────────────────────────────────────────────────── */
const pass = results.filter((r) => r.pass).length
const fails = results.filter((r) => !r.pass)
console.log('\n=== maid-bridge 自检 ===')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.pass && r.extra ? '  (' + r.extra + ')' : ''}${!r.pass ? '  ← ' + r.d : ''}`)
console.log(`--- 汇总：PASS ${pass} / FAIL ${fails.length} ---`)
process.exitCode = fails.length ? 1 : 0
