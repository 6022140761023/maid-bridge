#!/usr/bin/env node
/**
 * maid-bridge / tools/png-card.mjs
 * ============================================================================
 * **读「角色卡 PNG」里藏着的卡数据**（SillyTavern / TavernAI 那套约定：
 * 把角色 JSON 塞进 PNG 的 tEXt/iTXt 块里，键名通常是 `chara`（V2）或 `ccv3`（V3））。
 *
 * 用法：
 *   node tools/png-card.mjs "C:\path\card.png"           # 只报结构
 *   node tools/png-card.mjs "C:\path\card.png" --json out.json   # 把卡数据落盘
 *   node tools/png-card.mjs "C:\path\card.png" --full     # 正文也打出来（可能很长）
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const wantJson = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const full = args.includes('--full')
if (!file) { console.error('用法: node tools/png-card.mjs <card.png> [--json out.json] [--full]'); process.exit(2) }

const buf = readFileSync(file)
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
if (!buf.subarray(0, 8).equals(SIG)) { console.log('❌ 不是 PNG（文件头不对）'); process.exit(1) }

console.log(`文件：${file}`)
console.log(`大小：${buf.length} 字节`)

/* ── 遍历 PNG 块 ────────────────────────────────────────────────────────── */
const chunks = []
let off = 8
while (off + 12 <= buf.length) {
  const len = buf.readUInt32BE(off)
  const type = buf.toString('latin1', off + 4, off + 8)
  const data = buf.subarray(off + 8, off + 8 + len)
  chunks.push({ type, data, len })
  off += 12 + len
  if (type === 'IEND') break
}
const ihdr = chunks.find((c) => c.type === 'IHDR')
if (ihdr) {
  console.log(`尺寸：${ihdr.data.readUInt32BE(0)} × ${ihdr.data.readUInt32BE(4)}  位深=${ihdr.data[8]}  色型=${ihdr.data[9]}`)
}
console.log(`\n块清单（共 ${chunks.length}）：`)
for (const c of chunks) {
  if (['tEXt', 'iTXt', 'zTXt'].includes(c.type)) {
    const z = c.data.indexOf(0)
    const kw = c.data.toString('latin1', 0, z)
    console.log(`  ${c.type}  ${String(c.len).padStart(8)} 字节  keyword="${kw}"`)
  } else {
    console.log(`  ${c.type}  ${String(c.len).padStart(8)} 字节`)
  }
}

/* ── 取文本块 ──────────────────────────────────────────────────────────── */
function textOf (c) {
  const z = c.data.indexOf(0)
  const kw = c.data.toString('latin1', 0, z)
  if (c.type === 'tEXt') return { kw, text: c.data.toString('latin1', z + 1) }
  if (c.type === 'zTXt') {
    const method = c.data[z + 1]
    const raw = c.data.subarray(z + 2)
    return { kw, text: method === 0 ? inflateSync(raw).toString('utf8') : '(压缩方式不支持)' }
  }
  // iTXt: keyword \0 compFlag compMethod langTag \0 translatedKeyword \0 text
  const compFlag = c.data[z + 1]
  let p = z + 3
  const langEnd = c.data.indexOf(0, p); p = langEnd + 1
  const transEnd = c.data.indexOf(0, p); p = transEnd + 1
  const body = c.data.subarray(p)
  const text = compFlag === 1 ? inflateSync(body).toString('utf8') : body.toString('utf8')
  return { kw, text }
}

const texts = chunks.filter((c) => ['tEXt', 'iTXt', 'zTXt'].includes(c.type)).map(textOf)
if (!texts.length) { console.log('\n❌ 没有任何文本块 —— 这张图里**没有**嵌角色卡数据'); process.exit(0) }

// --chunk <keyword>：直接把某个文本块的内容打出来（ComfyUI 的 workflow / prompt 就靠这个看）
const wantChunk = args.includes('--chunk') ? args[args.indexOf('--chunk') + 1] : null
if (wantChunk) {
  const t = texts.find((x) => x.kw === wantChunk)
  if (!t) { console.log(`\n没有名为「${wantChunk}」的文本块（有：${texts.map((x) => x.kw).join(', ')}）`); process.exit(0) }
  let s = t.text
  try { s = JSON.stringify(JSON.parse(s), null, 2) } catch {}
  console.log(`\n===== ${wantChunk}（原文 ${t.text.length} 字符）=====\n`)
  console.log(s)
  process.exit(0)
}

/* ── 解析卡数据 ────────────────────────────────────────────────────────── */
const CARD_KEYS = ['chara', 'ccv3', 'character', 'card', 'Chara']
let found = null
for (const t of texts) {
  if (!CARD_KEYS.includes(t.kw)) continue
  let json = null
  const tryParse = (s) => { try { return JSON.parse(s) } catch { return null } }
  json = tryParse(t.text)                       // 有的卡直接存明文 JSON
  if (!json) {                                  // 标准做法是 base64
    try { json = tryParse(Buffer.from(t.text.trim(), 'base64').toString('utf8')) } catch {}
  }
  if (json) { found = { kw: t.kw, json }; break }
}

if (!found) {
  console.log(`\n⚠️ 有文本块但没有角色卡键名（${texts.map((t) => t.kw).join(', ')}）`)
  for (const t of texts) console.log(`  ${t.kw} = ${t.text.slice(0, 200)}`)
  process.exit(0)
}

const card = found.json
if (wantJson) { writeFileSync(wantJson, JSON.stringify(card, null, 2), 'utf8'); console.log(`\n已写出：${wantJson}`) }

const spec = card.spec ?? card.spec_version ?? '(未标)'
const d = card.data ?? card
const n = (v) => (Array.isArray(v) ? v.length : (typeof v === 'string' ? v.length : 0))
console.log(`\n✅ 找到角色卡：keyword="${found.kw}"  spec=${spec}  spec_version=${card.spec_version ?? '-'}`)
console.log(`\n顶层键：${Object.keys(card).join(', ')}`)
console.log(`data 键：${Object.keys(d).join(', ')}`)
console.log('\n--- 字段概览（字数）---')
for (const k of ['name', 'creator', 'character_version', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes']) {
  if (d[k] !== undefined) console.log(`  ${k.padEnd(26)} ${String(n(d[k])).padStart(6)} 字${typeof d[k] === 'string' && !full ? '   「' + d[k].slice(0, 60).replace(/\s+/g, ' ') + '…」' : ''}`)
}
if (d.description !== undefined) console.log(`  ${'description'.padEnd(26)} ${String(n(d.description)).padStart(6)} 字${full ? '' : '   「' + String(d.description).slice(0, 60).replace(/\s+/g, ' ') + '…」'}`)
if (d.tags !== undefined) console.log(`  tags: ${JSON.stringify(d.tags)}`)
if (d.alternate_greetings) console.log(`  alternate_greetings: ${d.alternate_greetings.length} 条`)
if (d.character_book) console.log(`  character_book: ${d.character_book?.entries?.length ?? 0} 条世界书条目`)
if (d.extensions) console.log(`  extensions 键: ${Object.keys(d.extensions).join(', ')}`)
if (full) {
  console.log('\n================== 全文 ==================')
  console.log(JSON.stringify(card, null, 2))
}
