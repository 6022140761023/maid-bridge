#!/usr/bin/env node
/**
 * shared-context + relay 的共享记忆/狂野模式 离线自检。
 * 用法: node shared-context-test.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { readRuntime, shouldInject, memoryMessage, foldForBridge, shapeBridgeReply } from './shared-context.mjs'
import { createRelay } from './relay.mjs'

const results = []
const ok = (n) => results.push({ pass: true, n })
const bad = (n, d) => results.push({ pass: false, n, d })
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
const base = (p) => `http://127.0.0.1:${p}`

/** 造一个假的插件 data 目录 */
function fakePluginData ({ mode = 'off', mem = '【记忆】老师和我做过车万女仆。', alive = 'fresh', pid = process.pid } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'maid-ctx-'))
  writeFileSync(join(dir, 'mode.json'), JSON.stringify({ mode }), 'utf8')
  writeFileSync(join(dir, 'memory.md'), mem, 'utf8')
  if (alive === 'fresh') writeFileSync(join(dir, 'alive.json'), JSON.stringify({ at: Date.now(), pid, mode }), 'utf8')
  if (alive === 'stale') writeFileSync(join(dir, 'alive.json'), JSON.stringify({ at: Date.now() - 3600_000, pid, mode }), 'utf8')
  if (alive === 'stale-dead') writeFileSync(join(dir, 'alive.json'), JSON.stringify({ at: Date.now() - 3600_000, pid: 999999, mode }), 'utf8')
  return dir
}
const tlmReq = () => ({
  model: 'deepseek-v4-flash',
  messages: [
    { role: 'system', content: '回复必须是 JSON；两段用 --- 分隔。' },
    { role: 'developer', content: '当前游戏上下文：主人血量 20/20。' },
    { role: 'user', content: '优香，过来一下' },
  ],
  tools: [{ type: 'function', function: { name: 'switch_follow_state', parameters: { type: 'object' } } }],
  response_format: { type: 'json_object' },
})

/* ── 1. readRuntime 的判定规则 ─────────────────────────────────────────── */
{
  const empty = mkdtempSync(join(tmpdir(), 'maid-empty-'))
  const r0 = readRuntime(empty)
  if (r0.mode === 'off' && r0.running === false) ok('插件没装/没跑（空目录）⇒ 模式压成 off')
  else bad('空目录', JSON.stringify(r0))

  const off = fakePluginData({ mode: 'off' })
  if (readRuntime(off).mode === 'off' && shouldInject(readRuntime(off)) === false) ok('mode=off ⇒ 不注入')
  else bad('off', 'off 时不该注入')

  const maid = fakePluginData({ mode: 'maid' })
  const rm = readRuntime(maid)
  if (rm.running && rm.mode === 'maid' && shouldInject(rm)) ok('心跳新鲜 + mode=maid ⇒ 注入，并且 running=true')
  else bad('maid', JSON.stringify(rm))

  const staleDead = fakePluginData({ mode: 'both', alive: 'stale-dead' })
  const rs = readRuntime(staleDead)
  if (!rs.running && rs.mode === 'off' && !shouldInject(rs)) ok('心跳过期 + 进程不在 ⇒ **一律按 off**（这就是"插件不跑就不调用"）')
  else bad('stale-dead', JSON.stringify(rs))

  const staleAlive = fakePluginData({ mode: 'both', alive: 'stale' })
  const ra = readRuntime(staleAlive)
  if (ra.running && ra.mode === 'both') ok('心跳过期但**进程还在**（pid 存活）⇒ 仍算在跑')
  else bad('stale-alive', JSON.stringify(ra))

  const wild = fakePluginData({ mode: 'wild' })
  if (readRuntime(wild).wild === true) ok('mode=wild ⇒ wild=true（狂野模式可判定）')
  else bad('wild', 'wild 未识别')

  const noMem = fakePluginData({ mode: 'maid', mem: '   ' })
  const rn = readRuntime(noMem)
  if (rn.mode === 'off' && /空/.test(rn.why)) ok('记忆为空 ⇒ 压成 off 并说明原因')
  else bad('empty-mem', JSON.stringify(rn))
}

/* ── 2. 纯函数 ─────────────────────────────────────────────────────────── */
{
  const rt = readRuntime(fakePluginData({ mode: 'maid' }))
  const mm = memoryMessage(rt)
  if (mm?.role === 'system' && mm.content.includes('共享记忆') && mm.content.includes('车万女仆')) ok('memoryMessage：产出 role=system 的记忆消息')
  else bad('memoryMessage', JSON.stringify(mm))

  const folded = foldForBridge(tlmReq(), '【角色卡】你是早濑优香。', { memory: rt.memory })
  const has = (s) => folded.includes(s)
  if (has('【角色卡】') && has('【共享记忆】') && has('【系统要求（必须遵守）】') && has('单独一行只写 ---') && has('【老师刚才说】') && has('优香，过来一下')) {
    ok('foldForBridge：角色卡 + 记忆 + 系统要求 + 输出契约 + 本轮输入，全部折叠进**一条** user 文本')
  } else bad('foldForBridge', folded.slice(0, 300))
  if (!folded.includes('role')) ok('foldForBridge：产物是纯文本（桥接只认 role:user，不能再带 role 字段）')
  else bad('foldForBridge（纯文本）', '混进了 role')

  if (shapeBridgeReply('第一段\n---\n第二段') === '第一段\n---\n第二段') ok('shapeBridgeReply：已有 --- ⇒ 原样保留')
  else bad('shape（保留）', shapeBridgeReply('第一段\n---\n第二段'))
  if (shapeBridgeReply('就一句话').split('\n---\n').length === 2) ok('shapeBridgeReply：没有 --- ⇒ 复制成两段（命中 TLM"第 2 段空则退回第 1 段"的兜底逻辑）')
  else bad('shape（复制）', shapeBridgeReply('就一句话'))
}

/* ── 3. relay 端到端：注入 ─────────────────────────────────────────────── */
{
  let seen = null
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      seen = JSON.parse(raw || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"text":"a---b"}' } }] }))
    })
  })
  const upPort = await listen(upstream)
  const ctxDir = fakePluginData({ mode: 'maid' })
  const relay = createRelay({ upstream: `http://127.0.0.1:${upPort}/v1/chat/completions`, sharedContextDir: ctxDir })
  const rPort = await listen(relay)
  try {
    await fetch(`${base(rPort)}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer X' }, body: JSON.stringify(tlmReq()) })
    const roles = (seen?.messages ?? []).map((m) => m.role)
    const memAt = (seen?.messages ?? []).findIndex((m) => String(m.content).includes('【共享记忆'))
    const personaAt = (seen?.messages ?? []).findIndex((m) => String(m.content).includes('早濑优香'))
    if (memAt >= 0 && memAt === personaAt + 1) ok(`relay 注入：共享记忆落在**角色卡之后**（角色卡第 ${personaAt} 条、记忆第 ${memAt} 条）`)
    else bad('注入位置', JSON.stringify({ personaAt, memAt, roles }))
    if (roles.join('/') === 'system/system/system/system/user') ok('relay 注入：出方向角色序列 = system×4 + user（TLM 两段 + 角色卡 + 记忆）')
    else bad('角色序列', roles.join('/'))
  } finally { relay.close(); upstream.close(); rmSync(ctxDir, { recursive: true, force: true }) }
}

/* ── 4. relay 端到端：插件没跑 ⇒ 不注入 ───────────────────────────────── */
{
  let seen = null
  const upstream = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c })
    req.on('end', () => { seen = JSON.parse(raw || '{}'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"x"}}]}') })
  })
  const upPort = await listen(upstream)
  const ctxDir = fakePluginData({ mode: 'both', alive: 'stale-dead' })
  const relay = createRelay({ upstream: `http://127.0.0.1:${upPort}/x`, sharedContextDir: ctxDir })
  const rPort = await listen(relay)
  try {
    await fetch(`${base(rPort)}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer X' }, body: JSON.stringify(tlmReq()) })
    if (!(seen?.messages ?? []).some((m) => String(m.content).includes('【共享记忆'))) ok('relay：**插件没在跑 ⇒ 一条都不注入**（默认不调用的硬保证）')
    else bad('未跑却注入', '不该注入')
  } finally { relay.close(); upstream.close(); rmSync(ctxDir, { recursive: true, force: true }) }
}

/* ── 5. relay 狂野模式：切上游到 DSH 桥接 + 整形回复 ───────────────────── */
{
  let bridgeReq = null
  const fakeBridge = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c })
    req.on('end', () => {
      bridgeReq = { url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'dsh-bridge/maid', choices: [{ index: 0, message: { role: 'assistant', content: '老师，账我记着呢。' }, finish_reason: 'stop' }] }))
    })
  })
  const bPort = await listen(fakeBridge)
  const ctxDir = fakePluginData({ mode: 'wild' })
  // 故意给一个“正常上游”地址：狂野模式**不该**用它
  const relay = createRelay({ upstream: 'http://127.0.0.1:1/should-not-be-used', sharedContextDir: ctxDir, bridge: `http://127.0.0.1:${bPort}/openclaw-bridge/v1/chat/completions`, bridgeModel: 'dsh-bridge/test' })
  const rPort = await listen(relay)
  try {
    const r = await fetch(`${base(rPort)}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer SHOULD-NOT-FORWARD' }, body: JSON.stringify(tlmReq()) })
    const j = await r.json()
    if (j?.choices?.[0]?.message?.content === '老师，账我记着呢。\n---\n老师，账我记着呢。') ok('狂野模式：DSH 纯文本回复被**整形为两段式** content')
    else bad('狂野（整形）', JSON.stringify(j?.choices?.[0]?.message?.content))
    if (bridgeReq?.body?.model === 'dsh-bridge/test') ok('狂野模式：用 bridgeModel 当会话 key（不同名字 = 不同 DSH 会话）')
    else bad('狂野（model）', JSON.stringify(bridgeReq?.body?.model))
    if (!bridgeReq?.headers?.authorization) ok('狂野模式：**故意不转发** Authorization（回环免 token，转发别人的 key 反而会被拒）')
    else bad('狂野（透传了 Authorization）', String(bridgeReq?.headers?.authorization))
    const u = String(bridgeReq?.body?.messages?.[0]?.content ?? '')
    if (u.includes('【角色设定】') && u.includes('【共享记忆】') && u.includes('单独一行只写 ---') && u.includes('早濑优香')) ok('狂野模式：折叠后的 user 文本含 真实角色卡 + 记忆 + 输出契约')
    else bad('狂野（折叠）', u.slice(0, 200))
    if (bridgeReq?.body?.messages?.length === 1 && bridgeReq?.body?.messages?.[0]?.role === 'user') ok('狂野模式：只发**一条** user（桥接只认 user）')
    else bad('狂野（消息数）', JSON.stringify(bridgeReq?.body?.messages?.map((m) => m.role)))
  } finally { relay.close(); fakeBridge.close(); rmSync(ctxDir, { recursive: true, force: true }) }
}

/* ── 汇总 ─────────────────────────────────────────────────────────────── */
const pass = results.filter((r) => r.pass).length
const fails = results.filter((r) => !r.pass)
console.log('\n=== shared-context / relay 共享记忆自检 ===')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${!r.pass ? '  ← ' + r.d : ''}`)
console.log(`--- 汇总：PASS ${pass} / FAIL ${fails.length} ---`)
process.exitCode = fails.length ? 1 : 0
