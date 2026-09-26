#!/usr/bin/env node
/**
 * maid-bridge / shared-context.mjs
 * ============================================================================
 * **共享记忆的读取与决策**（纯函数，好测）。供 relay.mjs 每回合调用。
 *
 * 记忆与开关都由 **maid-memory 插件**写在 `<extensions>/maid-memory/data/`：
 *   mode.json   { "mode": "off" | "maid" | "both" | "wild" }   ← 唯一真源
 *   alive.json  { at, pid, mode, version }                     ← 心跳（5s 一次）
 *   memory.md   记忆正文（人可读可改）
 *
 * 判定规则（这就是"默认不调用、插件一跑就开放注入"的实现）：
 *   1. **插件没在跑 → 一律按 off**（心跳过期且进程不在）
 *   2. 插件在跑 → 按 mode.json：
 *        off   不注入
 *        maid  只注入女仆的请求（本模块产出一条 system）
 *        both  女仆侧注入（DSH 侧由插件 provideContext 自己注）
 *        wild  **狂野模式**：女仆的脑子改走 DSH 会话（relay 切上游 + 折叠 system + 整形回复）
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MODES = ['off', 'maid', 'both', 'wild']
/** 心跳新鲜度上限：超过它就要求"进程还在"才算活着 */
export const ALIVE_MS = 20000

const safeJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const safeText = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

/** pid 是否存活（Windows/POSIX 通用：signal 0 探测） */
export function pidAlive (pid) {
  if (!pid || typeof pid !== 'number') return false
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

/**
 * 读运行时状态。
 * @returns {{dir:string, mode:string, running:boolean, memory:string, injEctReason:string, wild:boolean}}
 */
export function readRuntime (dir, { now = Date.now(), aliveMs = ALIVE_MS } = {}) {
  const out = { dir, mode: 'off', running: false, memory: '', why: '', wild: false }
  if (!dir) { out.why = '未配置共享记忆目录'; return out }

  const modeJson = safeJson(join(dir, 'mode.json'))
  const rawMode = String(modeJson?.mode ?? 'off').toLowerCase()
  out.mode = MODES.includes(rawMode) ? rawMode : 'off'

  const alive = safeJson(join(dir, 'alive.json'))
  const fresh = Boolean(alive && typeof alive.at === 'number' && now - alive.at <= aliveMs && alive.at > 0)
  const processUp = pidAlive(alive?.pid)
  out.running = fresh || processUp
  out.heartbeatAgeMs = alive?.at ? now - alive.at : null
  out.pid = alive?.pid ?? null

  out.memory = safeText(join(dir, 'memory.md')).trim()

  if (!out.running) {
    out.why = `插件没在跑（心跳${alive?.at ? `${Math.round((now - alive.at) / 1000)}s 前` : '缺失'}、pid ${alive?.pid ?? '?'} 不在）⇒ 按 off`
    out.mode = 'off'
  } else if (out.mode === 'off') {
    out.why = '模式 = off（默认）'
  } else if (!out.memory) {
    out.why = '模式要求注入，但 memory.md 是空的'
    out.mode = 'off'
  } else {
    out.why = `模式 = ${out.mode}`
  }
  out.wild = out.mode === 'wild'
  return out
}

/** 女仆侧要不要注入（maid / both 注入；wild 走另一条路，不在这注） */
export function shouldInject (rt) {
  return rt.mode === 'maid' || rt.mode === 'both'
}

/** 把记忆包成一条 system 消息（放在优香卡之后，靠后=更被买账） */
export function memoryMessage (rt) {
  if (!rt.memory) return null
  return {
    role: 'system',
    content: `【共享记忆（maid-memory，模式 ${rt.mode}）】\n${rt.memory}\n（以上是你和老师共有的记忆事实，语气仍按上面的角色卡。）`,
  }
}

/**
 * 狂野模式：把 TLM 的多段消息**折叠成一条 user 文本**（桥接只认 role:user）。
 * TLM 的格式契约（两段 --- /JSON）在这里变成"写在 user 文本里的要求"。
 */
export function foldForBridge (body, personaText, opts = {}) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  const parts = []
  if (personaText) parts.push(`【角色设定】\n${personaText}`)
  if (opts.memory) parts.push(`【共享记忆】\n${opts.memory}`)
  for (const m of msgs) {
    const c = typeof m?.content === 'string' ? m.content : ''
    if (!c.trim()) continue
    if (m.role === 'system' || m.role === 'developer') parts.push(`【系统要求（必须遵守）】\n${c}`)
  }
  // 只要最后一条 user 的内容当"本轮输入"，历史由 DSH 会话自己记
  const lastUser = [...msgs].reverse().find((m) => m?.role === 'user')
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : ''
  const contract = [
    '【输出契约（最高优先级）】',
    '1) 回复分两段，中间**单独一行只写 ---**；第 1 段进游戏气泡，第 2 段才会被念出来（两段内容一致即可）。',
    '2) 每段**尽量短**（一句话），纯文本，不要 *动作*、不要括号说明、台词里不要加引号。',
    '3) 不要报告任何工具调用结果，不要提 schedule/mode/context 这类系统词，不要报具体时间。',
  ].join('\n')
  parts.push(contract)
  parts.push(`【老师刚才说】\n${userText}`)
  return parts.join('\n\n')
}

/**
 * 狂野模式：把 DSH 的纯文本回复**整形**成 TLM 期望的 content。
 * TLM 的 ResponseChat 用 split("---", 2)：第 2 段为空时会退回念第 1 段，
 * 所以我们只要保证"有且只有一个分隔符"即可稳妥。
 */
export function shapeBridgeReply (text) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  const parts = t.split(/\n?-{3,}\n?/).map((s) => s.trim()).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]}\n---\n${parts.slice(1).join(' ')}`
  return `${t}\n---\n${t}`
}
