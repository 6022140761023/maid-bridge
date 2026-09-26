#!/usr/bin/env node
/**
 * maid-bridge / tts-relay.mjs
 * ============================================================================
 * **车万女仆 ⇄ Fish Audio 的本地中转。它只做一件事：把 `format` 从 `opus` 改成 `mp3`。**
 *
 * 为什么需要它（全部是实测证据，不是推测）：
 *   · 车万女仆的 fish-audio 客户端**强制**发 `format=opus` + `opus_bitrate=24000`
 *     （证据：`.agent-docs/女仆-TTS协议形状.md` §3.1，`play` 偏移 35/41 的字节码）
 *   · 而 `https://fishaudio.org/api/open/v1/speech/tts` **只认 mp3**：
 *     给 `format=opus` 或 `format=ogg` 一律回 `400 ERR_MISSING_REQUIRED_FIELDS / Invalid request body`
 *   · 其余字段（`chunk_length` / `mp3_bitrate` / `opus_bitrate` / `normalize` / `latency` /
 *     `reference_id` / `text`）**全部被容忍** —— 实测「只改 format」就 200 出音频
 *   · 客户端解码器只认 **MP3 / Ogg(Opus/Vorbis)**，而 mp3 是它**第一个尝试**的格式 ⇒ 返回 mp3 正合适
 *
 * 不存密钥：**透传**客户端带来的 `Authorization`（密钥留在游戏自己的站点配置里）。
 *
 * 用法：
 *   node tts-relay.mjs                      # 监听 127.0.0.1:8789
 *   node tts-relay.mjs --mock               # 不碰网络，返回一小段假音频（验链路）
 *   node tts-relay.mjs --dump               # 每次请求/响应落 dumps/
 *   node tts-relay.mjs --port 8789 --upstream https://fishaudio.org/api/open/v1/speech/tts
 * ============================================================================
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_UPSTREAM = 'https://fishaudio.org/api/open/v1/speech/tts'
const MAX_BODY = 2 * 1024 * 1024
const LOG = join(HERE, 'tts-relay.log')
const DUMPS = join(HERE, 'dumps-tts')

/**
 * ⚠️ **为什么要走代理**（2026-09-26 实测，不是猜的）：
 *   · 直连 `https://fishaudio.org/api/open/v1/...` → **UND_ERR_CONNECT_TIMEOUT（10.6 秒）**
 *   · 同机经本地 HTTP 代理 `127.0.0.1:10808` 打同一路径 → **HTTP 401（954ms）**（= 路由通了）
 *   · `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 对 fetch **实测无效**
 *   · **npm 的 undici ProxyAgent 不能喂给 Node 内置 fetch**（UND_ERR_INVALID_ARG）
 *     ⇒ 必须用 **undici 自己的 fetch** 配 ProxyAgent
 * 策略：**先代理、失败再直连**（两条都记进日志）；`--no-proxy` 可关掉代理。
 */
const DEFAULT_PROXY = process.env.MAID_BRIDGE_TTS_PROXY ?? 'http://127.0.0.1:10808'
/** undici 只在需要代理时动态加载；没装就退回直连，不影响其它功能 */
const loadUndici = async () => { try { return await import('undici') } catch { return null } }

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
 * 纯函数：把 TLM 的请求体改成上游能吃的形状。
 * **只动 format**（以及可选的 opus_bitrate 清理），其余字段一个不动。
 */
export function shapeForUpstream (body, { keepOpusBitrate = true } = {}) {
  const out = { ...(body && typeof body === 'object' ? body : {}) }
  const notes = []
  const want = String(out.format ?? '').toLowerCase()
  if (want !== 'mp3') {
    notes.push(`format: ${out.format ?? '(未给)'} → mp3（上游只认 mp3；opus/ogg 都回 400）`)
    out.format = 'mp3'
  }
  if (!keepOpusBitrate && 'opus_bitrate' in out) {
    delete out.opus_bitrate
    notes.push('已删除 opus_bitrate（改用 mp3 后它无意义）')
  }
  Object.defineProperty(out, '__notes', { value: notes, enumerable: false })
  return out
}

const json = (res, code, obj) => {
  const s = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

export function createTtsRelay (opts = {}) {
  const {
    upstream = DEFAULT_UPSTREAM,
    mock = false,
    dump = false,
    keepOpusBitrate = true,
    fetchImpl = globalThis.fetch,
    proxy = DEFAULT_PROXY,
    proxyAgent = null,          // 测试可注入；不传则用 undici 的 ProxyAgent
  } = opts

  /** 转发时按顺序尝试的"通路"：先代理（实测快 10 倍），失败再直连 */
  const isLocalUpstream = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/i.test(upstream)
  const attempts = []
  if (proxy && !isLocalUpstream) attempts.push({ tag: `代理 ${proxy}`, agent: proxyAgent ?? undefined })
  attempts.push({ tag: '直连', agent: null })
  let lastGood = null

  /** 懒加载 undici：只在第一次真的要用代理时才 import */
  let undiciReady = null
  const ensureUndici = async () => {
    if (undiciReady !== null) return undiciReady
    undiciReady = await loadUndici()
    return undiciReady
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      return json(res, 200, {
        ok: true, service: 'maid-bridge-tts', mode: mock ? 'mock' : 'forward',
        upstream: mock ? null : upstream,
        proxy: proxy || '(直连)',
        lastRoute: lastGood,
        why: '把 TLM 的 format=opus 改成 mp3；其余字段透传；顺带带上代理（fishaudio.org 直连会超时）',
      })
    }
    if (req.method !== 'POST') return json(res, 404, { error: { message: `只支持 POST（收到 ${req.method} ${url.pathname}）` } })

    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > MAX_BODY) { json(res, 413, { error: { message: '请求体过大' } }); req.destroy(); return }
      }
    } catch (e) { return json(res, 400, { error: { message: `读请求体失败：${e.message}` } }) }

    let body
    try { body = JSON.parse(raw || '{}') } catch (e) { return json(res, 400, { error: { message: `请求体不是合法 JSON：${e.message}` } }) }

    const text = String(body.text ?? '')
    log(`← TLM TTS 请求：text=${text.length} 字，format=${body.format ?? '(未给)'}，reference_id=${body.reference_id ? '(有)' : '(无)'}，auth=${req.headers.authorization ? '有' : '无'}`)

    const shaped = shapeForUpstream(body, { keepOpusBitrate })
    for (const n of shaped.__notes ?? []) log(`  ⚠️ ${n}`)

    if (dump) {
      try {
        if (!existsSync(DUMPS)) mkdirSync(DUMPS, { recursive: true })
        writeFileSync(join(DUMPS, `${Date.now()}-request.json`),
          JSON.stringify({ incoming: body, upstream: shaped, headers: { authorization: req.headers.authorization ? '(已省略)' : null } }, null, 2), 'utf8')
      } catch (e) { log(`  dump 失败：${e.message}`) }
    }

    if (mock) {
      // 一段最小的合法 mp3 帧（静音），只为验证"链路通 + 形状对"
      const fake = Buffer.alloc(4096, 0)
      fake[0] = 0xff; fake[1] = 0xfb; fake[2] = 0x90; fake[3] = 0xc4
      log(`→ mock 音频 ${fake.length} 字节`)
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': fake.length })
      return res.end(fake)
    }

    const auth = req.headers.authorization
    if (!auth) return json(res, 401, { error: { message: '没有 Authorization：请在女仆的 TTS 站点里填 Secret Key' } })

    const t0 = Date.now()
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(shaped),
    }
    let r = null
    let lastErr = null
    for (const a of attempts) {
      const ta = Date.now()
      try {
        // 代理那一路必须用 undici 自己的 fetch（Node 内置 fetch 喂 ProxyAgent 会 UND_ERR_INVALID_ARG）
        let doFetch = fetchImpl
        if (a.tag.startsWith('代理')) {
          const u = await ensureUndici()
          if (!u) { log(`  ⚠️ 未装 undici，跳过代理直接试直连`); continue }
          const agent = a.agent ?? new u.ProxyAgent(proxy)
          doFetch = (uurl, o) => u.fetch(uurl, { ...o, dispatcher: agent })
        }
        r = await doFetch(upstream, init)
        lastGood = a.tag
        if (attempts.indexOf(a) > 0) log(`  通路：${a.tag} 成功（${Date.now() - ta}ms）`)
        break
      } catch (e) {
        lastErr = e
        log(`  ⚠️ 通路「${a.tag}」失败：${e.cause?.code ?? e.message}（${Date.now() - ta}ms）`)
      }
    }
    if (!r) {
      log(`× 所有通路都失败：${lastErr?.cause?.code ?? lastErr?.message}`)
      return json(res, 502, { error: { message: `转发上游失败（代理与直连都不通）：${lastErr?.message ?? '未知'}` } })
    }
    try {
      const buf = Buffer.from(await r.arrayBuffer())
      const ct = r.headers.get('content-type') ?? 'application/octet-stream'
      log(`→ 上游 ${r.status}（${Date.now() - t0}ms，${buf.length} 字节，${ct.split(';')[0]}，通路=${lastGood}）`)
      if (dump) { try { writeFileSync(join(DUMPS, `${Date.now()}-response.bin`), buf) } catch {} }
      // **原样回包**：字节与 content-type 都不改
      res.writeHead(r.status, { 'content-type': ct, 'content-length': buf.length })
      return res.end(buf)
    } catch (e) {
      log(`× 读上游响应失败：${e.message}`)
      return json(res, 502, { error: { message: `读上游响应失败：${e.message}` } })
    }
  })
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const argv = process.argv.slice(2)
  const flag = (n) => argv.includes(`--${n}`)
  const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
  const port = Number(val('port', 8789))
  const host = val('host', '127.0.0.1')
  const opts = {
    mock: flag('mock'), dump: flag('dump'),
    upstream: val('upstream', DEFAULT_UPSTREAM),
    keepOpusBitrate: !flag('drop-opus-bitrate'),
    proxy: flag('no-proxy') ? null : val('proxy', DEFAULT_PROXY),
  }

  const srv = createTtsRelay(opts)
  srv.on('error', (e) => {
    log(`× 监听失败：${e.code ?? e.message}${e.code === 'EADDRINUSE' ? ` —— ${host}:${port} 已被占用（是不是已经起了一个 TTS 中转？）` : ''}`)
    process.exit(1)
  })
  srv.listen(port, host, () => {
    log(`maid-bridge TTS 中转已启动：http://${host}:${port}（PID ${process.pid}${opts.dump ? '，已开 --dump' : ''}）`)
    log(`  模式：${opts.mock ? '**mock（不碰网络）**' : `转发 → ${opts.upstream}`}`)
    log(`  通路：${opts.proxy ? `先代理 ${opts.proxy}、失败再直连` : '仅直连'}（fishaudio.org 直连实测会超时，所以默认带代理）`)
    log(`  只做一件事：format opus → mp3（其余字段透传）；**不存密钥**，Authorization 原样转发`)
    log(`  在车万女仆里：TTS 站点 fish-audio 的 url 填 http://${host}:${port}/v1/tts，Secret Key 填 Fish Audio 的 key`)
  })
  const bye = () => { log('收到退出信号，关闭…'); srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref() }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
}
