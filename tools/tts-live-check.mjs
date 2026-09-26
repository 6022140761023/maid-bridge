#!/usr/bin/env node
/**
 * maid-bridge / tools/tts-live-check.mjs
 * ============================================================================
 * **语音线的真机自检**：用站点里那把 key，直接打一次**真实 TTS 上游**，
 * 证明「这个 key + 这个音色」能用，并把音频落盘供用户试听。
 *
 * 它回答三个问题（不用等你在游戏里试）：
 *   ① 站点写得对不对（url / enabled / secret_key 在不在）
 *   ② key + voice_id 能不能真出一段音频（HTTP 码 / 上游 status_code）
 *   ③ 出的到底是不是能播的文件（从文件头判断真实格式 + 时长）
 *
 * ⚠️ 本脚本**绝不打印密钥**，只打印它的长度；解析配置失败时也不回显文件内容。
 *
 * 用法：
 *   node tools/tts-live-check.mjs                         # 默认站点生成 ≥2 个音色样本
 *   node tools/tts-live-check.mjs --list-voices           # 列出站点可用音色
 *   node tools/tts-live-check.mjs --voice "Chinese (Mandarin)_BashfulGirl"
 *   node tools/tts-live-check.mjs --voice <id> --say "……" --station minimax
 *   node tools/tts-live-check.mjs --all                   # 生成站点全部音色样本
 *   node tools/tts-live-check.mjs --count 3               # 默认生成前 N 个音色
 *
 * 环境变量：MAID_TTS_JSON 覆盖 tts.json 路径（默认取游戏目录下那份）。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, '..')
const OUT_DIR = join(BRIDGE, '.out', 'tts')
const TTS_JSON = process.env.MAID_TTS_JSON ??
  'E:\\我的世界\\.minecraft\\versions\\1.20.1-Forge_47.4.21 - 副本 - 副本\\config\\touhou_little_maid\\sites\\tts.json'

const DEFAULT_TEXT = '老师。这是本学期第 7 次超支了，我已经把对比数据整理好放在你桌上——别装作没看见。'
const DEFAULT_COUNT = 2

const line = (s = '') => console.log(s)
const keyLen = (v) => (v ? `<长度 ${String(v).length}>` : '(空)')
const fail = () => { globalThis.__fail = (globalThis.__fail ?? 0) + 1 }

/* ── 参数 ────────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2)
const get = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (flag) => args.includes(flag)
const stationOverride = get('--station')
const voiceOverride = get('--voice')
const sayOverride = get('--say')
const countOverride = get('--count')
const tagOverride = get('--tag')

/* ── ① 站点配置 ─────────────────────────────────────────────────────────── */
let cfg
try { cfg = JSON.parse(readFileSync(TTS_JSON, 'utf8')) } catch (e) {
  line(`❌ 读不到 / 解析不了 tts.json（不打印内容）：${e.code ?? e.name}`)
  process.exit(2)
}
const stations = Object.keys(cfg)
let stationId
if (stationOverride) {
  stationId = stationOverride
} else {
  // 默认选「enabled 且有 key」的第一个站点
  stationId = stations.find((id) => cfg[id]?.enabled && cfg[id]?.secret_key)
}
const site = cfg[stationId]
if (!site) {
  line(`❌ tts.json 里没有站点「${stationId}」（现有：${stations.join(', ')}）`)
  process.exit(2)
}

line(`站点 ${stationId}`)
line(`  url      = ${site.url}`)
line(`  enabled  = ${site.enabled}${site.enabled ? '' : '   ⚠️ 关了！游戏里不会出现'}`)
line(`  key      = ${keyLen(site.secret_key)}`)
line(`  model    = ${site.site_model ?? '(未填 site_model)'}`)
const voices = site.models ?? {}
line(`  api_type = ${site.api_type ?? '(未填)'}`)
line(`  音色数   = ${Object.keys(voices).length}`)
if (site.api_type && site.api_type !== 'minimax') {
  line(`  ⚠️ 本自检目前只实现 minimax 协议（POST t2a_v2）；站点 api_type=${site.api_type}，请用对应协议另写或走游戏内自检`)
  process.exit(2)
}
if (!site.enabled) fail()
if (!site.secret_key) { line('  ⚠️ 没有 Secret Key —— 上游会 401 / 认证失败'); fail() }
if (!site.url) { line('  ⚠️ 没有 url'); fail() }
if (!site.site_model) { line('  ⚠️ 没有 site_model（minimax 协议里是请求的 model 字段）'); fail() }
line()

if (has('--list-voices')) {
  line('── 可用音色 ──')
  for (const [id, label] of Object.entries(voices)) line(`  ${id}  →  ${label}`)
  process.exit(0)
}

// 决定要生成哪些音色
let picks = []
if (voiceOverride) {
  if (!(voiceOverride in voices)) {
    line(`❌ 音色「${voiceOverride}」不在站点 ${stationId} 的 models 里`)
    line(`  现有：${Object.keys(voices).join(' | ')}`)
    process.exit(2)
  }
  picks = [voiceOverride]
} else if (has('--all')) {
  picks = Object.keys(voices)
} else {
  const n = Math.max(1, parseInt(countOverride ?? DEFAULT_COUNT, 10) || DEFAULT_COUNT)
  picks = Object.keys(voices).slice(0, n)
}
if (!picks.length) { line('⚠️ 没有要生成的音色'); process.exit(2) }
line(`本次生成 ${picks.length} 个音色样本：${picks.join(' | ')}`)
line()

/* ── 工具：文件头判断真实格式 ───────────────────────────────────────────── */
const hasSig = (buf, sig, off = 0) => buf.length >= off + sig.length && sig.every((b, i) => buf[off + i] === b)

function detectFormat(buf) {
  if (hasSig(buf, [0x49, 0x44, 0x33])) return 'mp3 (ID3v2 头)'
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'mp3 (MPEG 帧同步)'
  if (hasSig(buf, [0x52, 0x49, 0x46, 0x46]) && hasSig(buf, [0x57, 0x41, 0x56, 0x45], 8)) return 'wav'
  if (hasSig(buf, [0x66, 0x4C, 0x61, 0x43])) return 'flac'
  if (hasSig(buf, [0x4F, 0x67, 0x67, 0x53])) return 'ogg/opus'
  return `unknown（前 8 字节 ${[...buf.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}）`
}

/* MP3 时长估算：读 ID3v2 长度跳过标签，再解第一个 MPEG 帧头拿码率 */
function id3v2Size(buf) {
  if (!hasSig(buf, [0x49, 0x44, 0x33])) return 0
  // 4 个 syncsafe 字节，各 7 bit
  const s = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]
  return 10 + s
}
const BITRATE_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BITRATE_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
function estimateMp3Duration(buf) {
  const start = id3v2Size(buf)
  if (start + 4 > buf.length) return null
  // 跳过填充的同步字节，找到 0xFF Ex
  let i = start
  while (i + 3 < buf.length && !(buf[i] === 0xFF && (buf[i + 1] & 0xE0) === 0xE0)) i++
  if (i + 3 >= buf.length) return null
  const b1 = buf[i + 1], b2 = buf[i + 2]
  const ver = (b1 >> 3) & 0x03          // 11=MPEG1, 10=MPEG2, 00=MPEG2.5
  const layer = (b1 >> 1) & 0x03        // 01=Layer III
  const brIdx = (b2 >> 4) & 0x0F
  if (ver === 1 || layer !== 1) return null // 只算 MPEG Layer III
  const isV1 = ver === 3
  const kbps = (isV1 ? BITRATE_V1L3 : BITRATE_V2L3)[brIdx]
  if (!kbps) return null
  return (buf.length - start) * 8 / (kbps * 1000) // 秒
}

/* ── 工具：安全文件名（只替换 Windows 非法字符，保留空格/括号） ──────────── */
const safeName = (id) => id.replace(/[\\/:*?"<>|]/g, '_')

/* ── ② 打真实上游 ───────────────────────────────────────────────────────── */
let okCount = 0
for (const voiceId of picks) {
  const label = voices[voiceId] ?? ''
  line(`── 音色 ${voiceId}${label ? `（${label}）` : ''} ──`)
  const body = {
    model: site.site_model,
    text: sayOverride ?? DEFAULT_TEXT,
    voice_setting: { voice_id: voiceId },
  }
  const t0 = Date.now()
  let resp, text
  try {
    resp = await fetch(site.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${site.secret_key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    text = await resp.text()
  } catch (e) {
    line(`  ❌ 请求失败：${e.message}`); fail(); line(); continue
  }
  line(`  HTTP ${resp.status}（${Date.now() - t0}ms，响应 ${text.length} 字符）`)

  let j = null
  try { j = JSON.parse(text) } catch {
    line(`  ❌ 上游返回不是 JSON（前 160 字符）：${text.slice(0, 160).replace(/\s+/g, ' ')}`)
    fail(); line(); continue
  }
  if (!resp.ok) {
    const msg = j?.base_resp?.status_msg ?? j?.error?.message ?? j?.message ?? text.slice(0, 200)
    line(`  ❌ 上游报错（HTTP ${resp.status}）：${String(msg).replace(/\s+/g, ' ').slice(0, 200)}`)
    fail(); line(); continue
  }
  const statusCode = j?.base_resp?.status_code
  if (statusCode !== 0) {
    line(`  ❌ 上游业务错误 code=${statusCode}：${j?.base_resp?.status_msg ?? '(无 status_msg)'}`)
    fail(); line(); continue
  }

  const audio = j?.data?.audio
  if (!audio) {
    line(`  ❌ 上游没回音频（data=${JSON.stringify(j?.data)}, base_resp=${JSON.stringify(j?.base_resp)}）`)
    fail(); line(); continue
  }

  // audio 可能是 hex 串，也可能是 url（output_format=url 时）
  let bytes
  if (/^https?:\/\//i.test(audio)) {
    let ar
    try {
      const r2 = await fetch(audio, { signal: AbortSignal.timeout(60000) })
      ar = await r2.arrayBuffer()
      line(`  音频为 URL 下载：HTTP ${r2.status}`)
    } catch (e) { line(`  ❌ 下载音频 URL 失败：${e.message}`); fail(); line(); continue }
    bytes = Buffer.from(ar)
  } else {
    bytes = Buffer.from(audio, 'hex')
  }

  const fmt = detectFormat(bytes)
  const extra = j?.extra_info ?? {}
  const upstreamMs = extra.audio_length
  const localSec = fmt.startsWith('mp3') ? estimateMp3Duration(bytes) : null

  mkdirSync(OUT_DIR, { recursive: true })
  const ext = fmt.startsWith('mp3') ? 'mp3' : fmt.startsWith('wav') ? 'wav' : fmt.startsWith('flac') ? 'flac' : fmt.startsWith('ogg') ? 'ogg' : 'bin'
  const base = tagOverride ? `${stationId}__${safeName(voiceId)}__${safeName(tagOverride)}` : `${stationId}__${safeName(voiceId)}`
  const outPath = join(OUT_DIR, `${base}.${ext}`)
  writeFileSync(outPath, bytes)

  line(`  字节数   = ${bytes.length}`)
  line(`  真实格式 = ${fmt}`)
  line(`  上游时长 = ${upstreamMs != null ? `${(upstreamMs / 1000).toFixed(2)}s（audio_length=${upstreamMs}ms）` : '（未回传）'}`)
  line(`  本地估算 = ${localSec != null ? `${localSec.toFixed(2)}s（按 MP3 帧码率估算）` : '（非 mp3 / 无法估算）'}`)
  line(`  落盘     = ${outPath}`)
  okCount++
  line()
}

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
line(okCount === picks.length && !globalThis.__fail
  ? `✅ 全绿：${okCount}/${picks.length} 个音色都出了真实音频，落在 ${OUT_DIR}`
  : `⚠️ ${okCount}/${picks.length} 成功，${picks.length - okCount} 失败（见上）`)
process.exit(okCount === picks.length ? 0 : 1)
