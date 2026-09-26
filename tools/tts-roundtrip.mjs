#!/usr/bin/env node
/**
 * maid-bridge / tools/tts-roundtrip.mjs
 * ============================================================================
 * **闭环验音**：TTS 生成音频 → STT 转写 → 与原文逐字对比 → 输出差异报告。
 * 用转写结果当「耳朵」，判断「数字念不念得对」「标点会不会被念出来」——
 * 这正是「要不要做 TTS 中转（文本预处理）」的决策依据。
 *
 * 链路：
 *   TTS  : minimax  speech-2.8-turbo（读 sites/tts.json 的 minimax 站点）
 *   STT  : SiliconFlow  FunAudioLLM/SenseVoiceSmall（读 sites/stt.json 的 siliconflow 站点）
 *   ⚠️ stt.json 里 siliconflow 的 url 是本地 4316（未起）；本脚本默认**直打云端**
 *      https://api.siliconflow.cn/v1/audio/transcriptions（同一把 key）。
 *
 * 用法：
 *   node tools/tts-roundtrip.mjs                                   # 批量验 .out/tts/*.mp3（读同名 .txt 当原文）
 *   node tools/tts-roundtrip.mjs --dir <目录>                       # 批量验指定目录
 *   node tools/tts-roundtrip.mjs --text "……" --voice "Chinese (Mandarin)_BashfulGirl"  # 现场生成再验
 *   node tools/tts-roundtrip.mjs --origin "……" --dir <目录>         # 无 sidecar 时统一指定原文
 *   node tools/tts-roundtrip.mjs --stt-url http://127.0.0.1:4316/v1/audio/transcriptions  # 测本地网关
 *   node tools/tts-roundtrip.mjs --text "……" --voice "Chinese (Mandarin)_BashfulGirl" --subtitle  # 引擎自证 pronounce_text，不走 STT
 *
 * ⚠️ 绝不回显密钥（只报长度）；解析配置失败不回显文件内容。
 * 报告落盘：maid-bridge/.agent-docs/女仆-TTS念法验证.md
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, '..')
const OUT_DIR = join(BRIDGE, '.out', 'tts')
const DOC_DIR = join(BRIDGE, '.agent-docs')
const REPORT = join(DOC_DIR, '女仆-TTS念法验证.md')

const STT_JSON = process.env.MAID_STT_JSON ??
  'E:\\我的世界\\.minecraft\\versions\\1.20.1-Forge_47.4.21 - 副本 - 副本\\config\\touhou_little_maid\\sites\\stt.json'
const TTS_JSON = process.env.MAID_TTS_JSON ??
  'E:\\我的世界\\.minecraft\\versions\\1.20.1-Forge_47.4.21 - 副本 - 副本\\config\\touhou_little_maid\\sites\\tts.json'
const CLOUD_STT = 'https://api.siliconflow.cn/v1/audio/transcriptions'

/* ── 参数 ────────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2)
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const has = (f) => args.includes(f)
const dirOverride = get('--dir')
const originOverride = get('--origin')
const textOverride = get('--text')
const voiceOverride = get('--voice')
const sttUrl = get('--stt-url') ?? CLOUD_STT
const subtitleMode = has('--subtitle')

const line = (s = '') => console.log(s)
const keyLen = (v) => (v ? `<长度 ${String(v).length}>` : '(空)')

/* ── subtitle 模式（引擎自证 pronounce_text，不依赖 STT）────────────────── */
if (subtitleMode) {
  const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  const EN_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', '赛文', '瑟文', '塞文']
  const QUOTE_TOKENS = ['"', '“', '”', '‘', '’']

  let mm
  try { mm = JSON.parse(readFileSync(TTS_JSON, 'utf8')).minimax } catch (e) {
    console.error(`❌ 读不到 / 解析不了 tts.json（不打印内容）：${e.code ?? e.name}`); process.exit(2)
  }
  if (!mm?.secret_key) { console.error('❌ minimax 站点缺 key 或不存在'); process.exit(2) }
  const defaultVoice = voiceOverride ?? Object.keys(mm.models ?? {})[0]
  if (!defaultVoice) { console.error('❌ minimax 站点 models 为空，无法选音色'); process.exit(2) }

  async function ttsGenerateSubtitle(text, voiceId) {
    const body = {
      model: mm.site_model, text,
      voice_setting: { voice_id: voiceId },
      subtitle_enable: true, subtitle_type: 'word',
    }
    const r = await fetch(mm.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mm.secret_key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok || j?.base_resp?.status_code !== 0) {
      return { error: `HTTP ${r.status} code=${j?.base_resp?.status_code ?? '-'} ${j?.base_resp?.status_msg ?? ''}` }
    }
    const subUrl = j?.data?.subtitle_file
    if (!subUrl) return { error: '上游没回 subtitle_file（该模型可能不支持 subtitle_enable）' }
    const r2 = await fetch(subUrl, { signal: AbortSignal.timeout(30000) })
    let segments = []
    try { segments = JSON.parse(await r2.text()) } catch { return { error: '字幕文件不是 JSON' } }
    const seg = Array.isArray(segments) ? segments[0] : segments
    return { pronounceText: seg?.pronounce_text ?? '', words: seg?.timestamped_words ?? [] }
  }

  function judgeSubtitle(orig, pron, words) {
    const numChecks = []
    for (const m of orig.match(/\d+/g) ?? []) {
      const cn = m.split('').map((d) => CN[Number(d)] ?? d).join('')
      let verdict
      if (EN_WORDS.some((w) => pron.includes(w))) verdict = '⚠️ 数字被念成英文（seven/赛文 之类）'
      else if (pron.includes(cn)) verdict = `数字念成中文「${cn}」✅`
      else if (pron.includes(m)) verdict = '数字按原样保留'
      else verdict = '数字未对应（需人工听）'
      numChecks.push({ num: m, cn, verdict })
    }
    const dashNote = orig.includes('——')
      ? (pron.includes('破折号') ? '⚠️ 破折号被念成「破折号」' : '✅ 破折号只当停顿（pronounce_text 里变句号/逗号）')
      : null
    const quoteTokens = words.filter((w) => QUOTE_TOKENS.includes(w.pronounce_word ?? w.word))
    const quoteNote = (orig.includes('「') || orig.includes('」'))
      ? (quoteTokens.length
          ? `⚠️ 引号被当成独立合成 token（${quoteTokens.length} 处）→ 建议剥引号（已知唯一瑕疵）`
          : '引号未占独立 token')
      : null
    return { numChecks, dashNote, quoteNote }
  }

  function printRow(orig, pron, words) {
    line(`  原文：${orig}`)
    line(`  pronounce_text：${pron}`)
    const j = judgeSubtitle(orig, pron, words)
    for (const n of j.numChecks) line(`  数字「${n.num}」→ ${n.verdict}`)
    if (j.dashNote) line(`  破折号 → ${j.dashNote}`)
    if (j.quoteNote) line(`  引号 → ${j.quoteNote}`)
    if (words.length) line(`  word 级 token（前 20）：${words.slice(0, 20).map((w) => w.pronounce_word ?? w.word).join(' | ')}`)
  }
  const JUDGE_RULE = '  判定规则：pronounce_text 出现「七」且无 seven ⇒ 数字念对；破折号变句号/逗号 ⇒ 只当停顿；「」变弯引号且占独立 token ⇒ 需剥引号。'

  line(`subtitle 模式（引擎自证 pronounce_text）默认音色=${defaultVoice}`)
  line()

  if (textOverride) {
    const g = await ttsGenerateSubtitle(textOverride, defaultVoice)
    if (g.error) { console.error(`❌ ${g.error}`); process.exit(1) }
    printRow(textOverride, g.pronounceText, g.words)
    line(); line(JUDGE_RULE); process.exit(0)
  }

  const dir = dirOverride ?? OUT_DIR
  let files = []
  try { files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')) } catch (e) {
    console.error(`❌ 读不到目录 ${dir}：${e.message}`); process.exit(2)
  }
  const textMap = new Map()  // 原文 -> [对应文件名]
  for (const f of files) {
    const sidecar = join(dir, f).replace(/\.mp3$/, '.txt')
    if (existsSync(sidecar)) {
      const t = readFileSync(sidecar, 'utf8').trim()
      if (t) { if (!textMap.has(t)) textMap.set(t, []); textMap.get(t).push(f) }
    }
  }
  if (!textMap.size) {
    console.error(`❌ ${dir} 里没有带 .txt sidecar 的 mp3（无法拿到原文复验）。先用 --text/--voice 生成带 sidecar 的样本，或手动放同名 .txt。`)
    process.exit(2)
  }
  line(`批量 ${dir}：${files.length} 个 mp3，${textMap.size} 条唯一原文（pronounce_text 与音色无关，同文本只合成一次）`)
  line()
  let i = 0
  for (const [t, fs] of textMap) {
    i++
    line(`── ${i}/${textMap.size}（对应文件：${fs.join('、')}）──`)
    const g = await ttsGenerateSubtitle(t, defaultVoice)
    if (g.error) { line(`  ❌ ${g.error}`); line(); continue }
    printRow(t, g.pronounceText, g.words)
    line()
  }
  line(JUDGE_RULE)
  process.exit(0)
}

/* ── ① 读 STT 配置（siliconflow）─────────────────────────────────────────── */
let sttCfg
try { sttCfg = JSON.parse(readFileSync(STT_JSON, 'utf8')) } catch (e) {
  console.error(`❌ 读不到 / 解析不了 stt.json（不打印内容）：${e.code ?? e.name}`); process.exit(2)
}
const sttSite = sttCfg.siliconflow
if (!sttSite) { console.error(`❌ stt.json 里没有 siliconflow 站点（现有：${Object.keys(sttCfg).join(', ')}）`); process.exit(2) }
if (!sttSite.secret_key) { console.error('❌ siliconflow STT 没有 secret_key'); process.exit(2) }

line(`STT siliconflow：model=${sttSite.model}  key=${keyLen(sttSite.secret_key)}`)
line(`  站点配置 url=${sttSite.url}（本地 4316，未起）→ 本次实际打云端 ${sttUrl}`)
line()

/* ── ② STT 转写 ──────────────────────────────────────────────────────────── */
async function transcribe(mp3Path) {
  const buf = readFileSync(mp3Path)
  const ext = extname(mp3Path).slice(1).toLowerCase()
  const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : ext === 'flac' ? 'audio/flac' : 'application/octet-stream'
  const fd = new FormData()
  fd.append('model', sttSite.model)
  fd.append('file', new Blob([buf], { type: mime }), `audio.${ext}`)
  const r = await fetch(sttUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${sttSite.secret_key}` },
    body: fd,
    signal: AbortSignal.timeout(90000),
  })
  const text = await r.text()
  if (!r.ok) {
    let msg = text
    try { msg = JSON.parse(text)?.error?.message ?? msg } catch {}
    return { error: `HTTP ${r.status}: ${String(msg).replace(/\s+/g, ' ').slice(0, 300)}` }
  }
  try {
    const j = JSON.parse(text)
    return { text: j.text, language: j.language, usage: j.usage }
  } catch {
    return { error: `上游返回不是 JSON（前 200 字）：${text.slice(0, 200).replace(/\s+/g, ' ')}` }
  }
}

/* ── ③ TTS 生成（minimax，与 tts-live-check.mjs 同协议）────────────────── */
async function ttsGenerate(text, voiceId) {
  const ttsCfg = JSON.parse(readFileSync(TTS_JSON, 'utf8'))
  const site = ttsCfg.minimax
  if (!site?.secret_key) return { error: 'minimax 站点缺 key 或不存在' }
  const body = { model: site.site_model, text, voice_setting: { voice_id: voiceId } }
  const r = await fetch(site.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${site.secret_key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || j?.base_resp?.status_code !== 0) {
    return { error: `HTTP ${r.status} code=${j?.base_resp?.status_code ?? '-'} ${j?.base_resp?.status_msg ?? ''}` }
  }
  const audio = j?.data?.audio
  if (!audio) return { error: '上游没回音频' }
  const bytes = /^https?:\/\//i.test(audio)
    ? Buffer.from(await (await fetch(audio)).arrayBuffer())
    : Buffer.from(audio, 'hex')
  const safeName = (id) => id.replace(/[\\/:*?"<>|]/g, '_')
  const out = join(OUT_DIR, `minimax__${safeName(voiceId)}__roundtrip.mp3`)
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(out, bytes)
  writeFileSync(out.replace(/\.mp3$/, '.txt'), text, 'utf8')
  return { path: out, bytes: bytes.length }
}

/* ── ④ 差异判定 ──────────────────────────────────────────────────────────── */
const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const EN_NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', '赛文', '瑟文', '塞文']
const PUNCT_NAMES = ['破折号', '引号', '左引号', '右引号', '括号', '句号', '逗号', '顿号', '冒号', '感叹号', '问号', '省略号', '分号', '书名号', '单引号', '双引号']

function normalize(s) {
  // 先把阿拉伯数字统一成中文数字（7→七），再去掉标点 —— 这样「第7次」vs「第七次」算一致，不算漏字/多字
  return s.replace(/\d/g, (d) => CN_DIGIT[Number(d)] ?? d).replace(/[^\u4e00-\u9fff0-9a-zA-Z]/g, '')
}

function countChars(s) {
  const m = new Map()
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1)
  return m
}

function diffSummary(orig, trans) {
  const numChecks = []
  for (const m of orig.match(/\d+/g) ?? []) {
    const digits = m.split('').map((d) => CN_DIGIT[Number(d)] ?? d)
    const cn = digits.join('')
    let verdict
    if (trans.includes(m)) verdict = '数字按原样保留（如「7」）'
    else if (trans.includes(cn)) verdict = `数字念成中文「${cn}」✅`
    else if (EN_NUM_WORDS.some((w) => trans.includes(w))) verdict = '⚠️ 数字被念成英文（seven/赛文 之类）'
    else verdict = '数字未对应（需人工听）'
    numChecks.push({ num: m, cn, verdict })
  }
  const punctRead = PUNCT_NAMES.filter((p) => trans.includes(p))
  const no = normalize(orig)
  const nt = normalize(trans)
  const equal = no === nt
  const cm = countChars(no), ct = countChars(nt)
  const missing = [], extra = []
  for (const [c, n] of cm) for (let i = 0; i < n - (ct.get(c) ?? 0); i++) missing.push(c)
  for (const [c, n] of ct) for (let i = 0; i < n - (cm.get(c) ?? 0); i++) extra.push(c)
  return { numChecks, punctRead, equal, missing, extra }
}

/* ── ⑤ 跑 ────────────────────────────────────────────────────────────────── */
const results = []   // { file, orig, trans, err, d }
const reportLines = []

function header() {
  line(`STT 网关 = ${sttUrl}（${sttUrl.startsWith('http://127') ? '本地' : '云端'}）`)
  line()
}

async function verifyOne(mp3Path, orig) {
  const name = basename(mp3Path)
  const t0 = Date.now()
  const r = await transcribe(mp3Path)
  const ms = Date.now() - t0
  if (r.error) {
    line(`❌ ${name}：${r.error}`)
    results.push({ file: name, orig, err: r.error })
    return
  }
  const d = orig ? diffSummary(orig, r.text) : null
  line(`── ${name} ──`)
  line(`  转写（${ms}ms，${r.language ?? '-'}）：${r.text}`)
  if (orig) {
    line(`  原文：${orig}`)
    if (d.equal) line(`  逐字对比（去标点后）：✅ 一致`)
    else {
      line(`  逐字对比（去标点后）：❌ 有差 → 漏字=[${d.missing.join('')}] 多字=[${d.extra.join('')}]`)
    }
    for (const n of d.numChecks) line(`  数字「${n.num}」→ ${n.verdict}`)
    line(`  标点被念出来：${d.punctRead.length ? '⚠️ ' + d.punctRead.join('、') : '✅ 无（只变成停顿）'}`)
  } else {
    line('  （无原文，仅转写）')
  }
  results.push({ file: name, orig, trans: r.text, lang: r.language, d })
  line()
}

if (textOverride && voiceOverride) {
  header()
  line(`现场生成：voice=${voiceOverride}`)
  line(`文本：${textOverride}`)
  line()
  const g = await ttsGenerate(textOverride, voiceOverride)
  if (g.error) { line(`❌ TTS 生成失败：${g.error}`); process.exit(1) }
  line(`TTS 生成 OK：${g.path}（${g.bytes} 字节）`)
  line()
  await verifyOne(g.path, textOverride)
} else {
  header()
  const dir = dirOverride ?? OUT_DIR
  let files = []
  try { files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')) } catch (e) {
    console.error(`❌ 读不到目录 ${dir}：${e.message}`); process.exit(2)
  }
  if (!files.length) { console.error(`❌ ${dir} 里没有 .mp3`); process.exit(2) }
  line(`批量验 ${dir} 下 ${files.length} 个 mp3`)
  line()
  for (const f of files) {
    const p = join(dir, f)
    const sidecar = p.replace(/\.mp3$/, '.txt')
    const orig = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim() : (originOverride ?? null)
    await verifyOne(p, orig)
  }
}

/* ── ⑥ 写报告 ────────────────────────────────────────────────────────────── */
mkdirSync(DOC_DIR, { recursive: true })
const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
const md = []
md.push('# 女仆 TTS 念法验证（闭环验音）')
md.push('')
md.push(`- 生成时间：${now}`)
md.push('- TTS：minimax `speech-2.8-turbo`（`sites/tts.json` 的 minimax 站点，key 只报长度不落盘）')
md.push(`- STT：SiliconFlow \`${sttSite.model}\`，实际打 ${sttUrl}（key 只报长度）`)
md.push('- 方法：TTS 出音频 → STT 转写 → 与原文逐字对比')
md.push('')
md.push('## 结论（先看这里）')
const allNum = results.flatMap((r) => r.d?.numChecks ?? [])
const anyPunct = results.some((r) => r.d?.punctRead?.length)
const anyEnNum = allNum.some((n) => n.verdict.includes('英文'))
if (results.length === 0) {
  md.push('（无有效结果）')
} else if (anyEnNum) {
  md.push('⚠️ **有数字被念成英文** —— 需要 TTS 中转做文本规范化（数字转中文）。')
} else if (anyPunct) {
  md.push('⚠️ **有标点被念出名称**（破折号/引号/括号之类）—— 需要 TTS 中转剥掉或改写标点。')
} else {
  md.push('✅ **数字念对（中文），标点没有念出名称（只变停顿）** —— 结论：**不需要 TTS 中转**。')
  md.push('（若仍要求「数字统一转汉字、标点完全剥离」这类绝对可控，才考虑做一层轻量文本规范化。）')
}
md.push('')
md.push('## 逐样本')
md.push('')
md.push('| 文件 | 转写 | 数字 | 标点念出 | 去标点对比 |')
md.push('| --- | --- | --- | --- | --- |')
for (const r of results) {
  if (r.err) { md.push(`| ${r.file} | ❌ ${r.err} | - | - | - |`); continue }
  const d = r.d
  const num = d ? d.numChecks.map((n) => `${n.num}→${n.verdict.includes('✅') ? '对' : n.verdict}`).join('；') || '无数字' : '（无原文）'
  const punct = d ? (d.punctRead.length ? d.punctRead.join('、') : '无') : '—'
  const eq = d ? (d.equal ? '一致' : `漏[${d.missing.join('')}] 多[${d.extra.join('')}]`) : '—'
  md.push(`| ${r.file} | ${(r.trans ?? '').replace(/\|/g, '／')} | ${num} | ${punct} | ${eq} |`)
}
md.push('')
md.push('## 原文 / 转写 对照')
md.push('')
for (const r of results) {
  if (r.err) continue
  md.push(`### ${r.file}`)
  md.push(`- 原文：${r.orig ?? '（无）'}`)
  md.push(`- 转写：${r.trans}`)
  md.push('')
}
md.push('## 给 t5 的建议（要不要做 TTS 中转）')
md.push('')
md.push('见顶部「结论」。判定规则：转写出现「七/7」且无「seven/赛文」= 数字念对；出现「破折号/引号/括号」等字样 = 标点被念出来（缺陷）。')
md.push('')
const out = md.join('\n')
writeFileSync(REPORT, out, 'utf8')
line(`📄 报告已落盘：${REPORT}`)
