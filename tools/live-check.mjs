#!/usr/bin/env node
/**
 * maid-bridge / tools/live-check.mjs
 * ============================================================================
 * **真机测试的前置自检**：用站点里那把 key，经本地中转，打一次**真实上游**。
 *
 * 它回答三个问题（不用等你在游戏里试）：
 *   ① 站点写得对不对（url / enabled / models / key 在不在）
 *   ② 中转 → 上游这条链通不通（key 有效、**模型名在不在**、JSON 模式支不支持）
 *   ③ 角色卡到底插没插进去（读中转 dump 出来的 `upstream.messages`）
 *
 * ⚠️ 本脚本**绝不打印密钥**，只打印它的长度；出错时也不回显 llm.json 内容。
 *
 * 用法：
 *   node tools/live-check.mjs
 *   set MAID_SITE=deepseek && node tools/live-check.mjs      # 换站点
 *   set MAID_LLM_JSON=D:\...\llm.json && node tools/live-check.mjs
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, '..')
const RELAY = process.env.MAID_BRIDGE_URL ?? 'http://127.0.0.1:8788/v1/chat/completions'
const LLM_JSON = process.env.MAID_LLM_JSON ??
  'E:\\我的世界\\.minecraft\\versions\\1.20.1-Forge_47.4.21 - 副本 - 副本\\config\\touhou_little_maid\\sites\\llm.json'
const SITE = process.env.MAID_SITE ?? 'maid_bridge'

const line = (s = '') => console.log(s)
const keyLen = (v) => (v ? `<长度 ${String(v).length}>` : '(空)')
let fail = 0

/* ── ① 站点配置 ─────────────────────────────────────────────────────────── */
let cfg
try { cfg = JSON.parse(readFileSync(LLM_JSON, 'utf8')) } catch (e) {
  line(`❌ 读不到 / 解析不了 llm.json（不打印内容）：${e.code ?? e.name}`)
  process.exit(2)
}
const site = cfg[SITE]
if (!site) { line(`❌ llm.json 里没有站点「${SITE}」（现有：${Object.keys(cfg).join(', ')}）`); process.exit(2) }

line(`站点 ${SITE}`)
line(`  url      = ${site.url}`)
line(`  enabled  = ${site.enabled}${site.enabled ? '' : '   ⚠️ 关了！游戏里不会出现'}`)
line(`  key      = ${keyLen(site.secret_key)}`)
line(`  models   = ${JSON.stringify(site.models)}`)
if (!site.enabled) fail++
if (!site.secret_key) { line('  ⚠️ 没有 Secret Key —— 中转会回 401'); fail++ }
const model = Array.isArray(site.models) ? site.models[0]?.name ?? site.models[0] : site.models
line()

/* ── 中转在不在 ─────────────────────────────────────────────────────────── */
try {
  const h = await fetch(new URL('/health', RELAY.replace(/\/v1\/chat\/completions$/, '')), { signal: AbortSignal.timeout(3000) })
  const hj = await h.json()
  line(`中转 /health：ok=${hj.ok} mode=${hj.mode} 角色卡=${hj.persona} 上游=${hj.upstream ?? '(mock)'}`)
} catch (e) {
  line(`❌ 中转没在跑（${RELAY}）：${e.message}`)
  line('   → 先双击 maid-bridge\\start-relay.vbs')
  process.exit(3)
}
line()

/* ── ② 打真实上游（两种形状各一次）─────────────────────────────────────── */
const personaProbe = '老师：你是谁？请只回一个 JSON，键名 text。'

const probes = [
  {
    tag: 'A 最小形状',
    body: {
      model,
      messages: [{ role: 'user', content: personaProbe }],
      response_format: { type: 'json_object' },
    },
  },
  {
    tag: 'B TLM 形状',
    body: {
      model,
      messages: [
        { role: 'system', content: '（这里占位模拟 TLM 自己那条 system：你扮演游戏里的女仆，必须只输出 JSON。）' },
        { role: 'developer', content: '（这里占位模拟 TLM 的 developer 段：输出 JSON，键名 text。）' },
        { role: 'user', content: personaProbe },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'follow',
          description: '跟随主人',
          parameters: { type: 'object', properties: { player: { type: 'string' } }, required: [] },
        },
      }],
      response_format: { type: 'json_object' },
      // TLM 的真实形状：Thinking 类字段是 type，枚举序列化成 "enabled"/"disabled"
      // （jar: ai/service/llm/openai/request/Thinking.class → Type | type | enabled | ENABLED | disabled | DISABLED）
      thinking: { type: 'disabled' },
    },
  },
  {
    tag: 'C TLM 形状 + 思考开启',
    body: {
      model,
      messages: [
        { role: 'system', content: '（占位：你扮演游戏里的女仆，必须只输出 JSON，键名 text。）' },
        { role: 'user', content: personaProbe },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'follow',
          description: '跟随主人',
          parameters: { type: 'object', properties: { player: { type: 'string' } }, required: [] },
        },
      }],
      response_format: { type: 'json_object' },
      thinking: { type: 'enabled' },
    },
  },
]

for (const p of probes) {
  line(`── ${p.tag} ──`)
  const t0 = Date.now()
  let r, text
  try {
    r = await fetch(RELAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${site.secret_key}` },
      body: JSON.stringify(p.body),
      signal: AbortSignal.timeout(120000),
    })
    text = await r.text()
  } catch (e) {
    line(`  ❌ 请求失败：${e.message}`); fail++; line(); continue
  }
  line(`  HTTP ${r.status}（${Date.now() - t0}ms，${text.length} 字节）`)
  let j = null
  try { j = JSON.parse(text) } catch { line('  ⚠️ 返回不是 JSON'); }
  if (!r.ok) {
    line(`  上游报错：${j?.error?.message ?? text.slice(0, 300)}`)
    fail++
    line()
    continue
  }
  const content = j?.choices?.[0]?.message?.content
  const tc = j?.choices?.[0]?.message?.tool_calls
  line(`  回复：${String(content ?? '(空)').slice(0, 300).replace(/\s+/g, ' ')}`)
  if (tc?.length) line(`  tool_calls：${tc.map((t) => t.function?.name).join(', ')}`)
  line(`  usage：${JSON.stringify(j?.usage ?? {})}`)
  line()
}

/* ── ③ 角色卡插没插进去（读中转的 dump）────────────────────────────────── */
line('── 角色卡注入核对（读 dumps\\ 里最新一份）──')
try {
  const dir = join(BRIDGE, 'dumps')
  const files = readdirSync(dir).filter((f) => f.endsWith('-request.json'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  if (!files.length) {
    line('  （没有 dump。中转启动时没带 --dump？）')
  } else {
    const d = JSON.parse(readFileSync(join(dir, files[0].f), 'utf8'))
    const up = d.upstream?.messages ?? []
    const inN = d.incoming?.messages?.length ?? '?'
    line(`  最新 dump：${files[0].f}`)
    line(`  进：${inN} 条  →  出：${up.length} 条（应当 +1）`)
    const pat = up.findIndex((m) => String(m.content ?? '').includes('早濑优香'))
    line(`  第 0 条：role=${up[0]?.role} 长度=${String(up[0]?.content ?? '').length} 开头=「${String(up[0]?.content ?? '').slice(0, 36).replace(/\s+/g, ' ')}」`)
    line(`  角色卡位置：第 ${pat} 条  长度=${String(up[pat]?.content ?? '').length}`)
    if (pat >= 1 && up.slice(0, pat).every((m) => m.role === 'system' || m.role === 'developer')) {
      line('  ✅ 角色卡落在 TLM 的 system/developer 段之后（模型对靠后的冲突指令更买账）')
    } else { line('  ❌ 角色卡位置不对（看 relay.mjs buildMessages 的插入点）'); fail++ }
    const roles = up.map((m) => m.role)
    line(`  出方向 roles：${roles.join(' / ')}`)
    const devLeft = roles.filter((r) => r === 'developer').length
    if (devLeft === 0) line('  ✅ 没有 developer 漏到上游（已改写成 system）')
    else { line(`  ❌ 还有 ${devLeft} 条 developer —— 上游会 422`); fail++ }
    line(`  tools 透传：${d.upstream?.tools?.length ?? 0} 个   response_format=${d.upstream?.response_format?.type ?? '-'}   thinking=${d.upstream?.thinking ?? '-'}`)
  }
} catch (e) { line(`  跳过（${e.message}）`) }

line()
line(fail === 0 ? '✅ 全绿：站点 / 中转 / 上游 / 角色卡 四项都对得上' : `⚠️ 有 ${fail} 项需要处理（见上）`)
process.exit(fail === 0 ? 0 : 1)
