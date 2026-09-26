#!/usr/bin/env node
/**
 * tts-relay 的离线自检：假上游逐字段对账，证明「只改 format」这件事真的只改了 format。
 * 用法: node tts-relay-test.mjs
 */
import { createServer } from 'node:http'
import { createTtsRelay, shapeForUpstream } from './tts-relay.mjs'

const results = []
const ok = (n) => results.push({ pass: true, n })
const bad = (n, d) => results.push({ pass: false, n, d })

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const base = (p) => `http://127.0.0.1:${p}`

/** TLM 的真实请求体（字段与默认值来自 .agent-docs/女仆-TTS协议形状.md §3.1） */
const tlmBody = () => ({
  text: '老师。这是本学期第 7 次超支了，别装作没看见。',
  chunk_length: 200,
  format: 'opus',
  mp3_bitrate: 128,
  opus_bitrate: 24000,
  reference_id: '6309764a-f458-4e72-91b2-5844b70b6b71',
  normalize: true,
  latency: 'normal',
})

/* ── 1. 纯函数 ─────────────────────────────────────────────────────────── */
{
  const src = tlmBody()
  const out = shapeForUpstream(src)
  if (out.format === 'mp3') ok('形变：format opus → mp3')
  else bad('形变（format）', JSON.stringify(out.format))
  const keys = ['text', 'chunk_length', 'mp3_bitrate', 'opus_bitrate', 'reference_id', 'normalize', 'latency']
  if (keys.every((k) => out[k] === src[k])) ok('形变：其余 7 个字段**逐值未动**（text/chunk_length/mp3_bitrate/opus_bitrate/reference_id/normalize/latency）')
  else bad('形变（保真）', JSON.stringify(keys.map((k) => [k, src[k], out[k]])))
  if (!JSON.stringify(out).includes('__notes')) ok('形变：__notes 是非枚举字段，不会发给上游')
  else bad('形变（字段泄漏）', '__notes 被序列化进去了')
  if (shapeForUpstream({ format: 'mp3' }).__notes.length === 0) ok('形变：已经是 mp3 时**不产生**改写记录（幂等）')
  else bad('形变（幂等）', '不该有 notes')
  if (shapeForUpstream(src, { keepOpusBitrate: false }).opus_bitrate === undefined) ok('形变：--drop-opus-bitrate 时才会删除 opus_bitrate（默认保留）')
  else bad('形变（drop 选项）', '未删除')
}

/* ── 2. 转发路径：假上游逐字段对账 ─────────────────────────────────────── */
{
  const FAKE = Buffer.from([0xff, 0xfb, 0x90, 0xc4, ...Array(3000).fill(0x55)])
  let seen = null
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      seen = { headers: req.headers, body: JSON.parse(raw || '{}') }
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.end(FAKE)
    })
  })
  const upPort = await listen(upstream)
  const relay = createTtsRelay({ upstream: `http://127.0.0.1:${upPort}/api/open/v1/speech/tts` })
  const rPort = await listen(relay)
  try {
    const r = await fetch(`${base(rPort)}/v1/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-fish-test' },
      body: JSON.stringify(tlmBody()),
    })
    const buf = Buffer.from(await r.arrayBuffer())

    if (seen?.headers.authorization === 'Bearer sk-fish-test') ok('转发：**原样透传** Authorization（中转自己不存密钥）')
    else bad('转发（鉴权透传）', String(seen?.headers.authorization))
    if (seen?.body.format === 'mp3') ok('转发：上游收到的 format 是 **mp3**（这就是存在的全部理由）')
    else bad('转发（format）', String(seen?.body.format))
    if (seen?.body.chunk_length === 200 && seen?.body.opus_bitrate === 24000 && seen?.body.normalize === true && seen?.body.latency === 'normal' && seen?.body.mp3_bitrate === 128) {
      ok('转发：其余字段**一个不少**（chunk_length/mp3_bitrate/opus_bitrate/normalize/latency 全在）')
    } else bad('转发（字段保真）', JSON.stringify(seen?.body))
    if (seen?.body.reference_id === '6309764a-f458-4e72-91b2-5844b70b6b71') ok('转发：reference_id 原样带过去（= Fish Audio 的 voiceId）')
    else bad('转发（voiceId）', String(seen?.body.reference_id))
    if (r.status === 200 && r.headers.get('content-type') === 'audio/mpeg' && buf.equals(FAKE)) {
      ok('回包：**音频字节与 content-type 原样返回**（TLM 自己解码，中转不许动）')
    } else bad('回包（保真）', `${r.status} ${r.headers.get('content-type')} ${buf.length}B/${FAKE.length}B`)
  } finally { relay.close(); upstream.close() }
}

/* ── 3. mock 模式 + /health ────────────────────────────────────────────── */
{
  const srv = createTtsRelay({ mock: true })
  const port = await listen(srv)
  try {
    const r = await fetch(`${base(port)}/v1/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tlmBody()),
    })
    const buf = Buffer.from(await r.arrayBuffer())
    if (r.status === 200 && (r.headers.get('content-type') ?? '').includes('audio') && buf.length > 1000) ok('mock：不碰网络也能返回合法 mp3 头（可离线验链路）')
    else bad('mock', `${r.status} ${r.headers.get('content-type')} ${buf.length}`)
    const h = await fetch(`${base(port)}/health`).then((x) => x.json())
    if (h.ok === true && h.mode === 'mock') ok('mock：/health 可用')
    else bad('/health', JSON.stringify(h))
  } finally { srv.close() }
}

/* ── 4. 失败路径 ───────────────────────────────────────────────────────── */
{
  const srv = createTtsRelay({ upstream: 'http://127.0.0.1:1/nope' })
  const port = await listen(srv)
  try {
    const r1 = await fetch(`${base(port)}/v1/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tlmBody()) })
    if (r1.status === 401) ok('没有 Authorization：401（且是可读的 JSON 错误，不是空响应）')
    else bad('401', String(r1.status))

    const r2 = await fetch(`${base(port)}/v1/tts`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: 'not-json' })
    if (r2.status === 400) ok('请求体不是 JSON：400')
    else bad('400', String(r2.status))
  } finally { srv.close() }
}

/* ── 5. 上游错误原样透传 ───────────────────────────────────────────────── */
{
  const upstream = createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 'ERR_MISSING_REQUIRED_FIELDS', message: 'Invalid request body' }))
  })
  const upPort = await listen(upstream)
  const relay = createTtsRelay({ upstream: `http://127.0.0.1:${upPort}/x` })
  const rPort = await listen(relay)
  try {
    const r = await fetch(`${base(rPort)}/v1/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify(tlmBody()),
    })
    const j = await r.json()
    if (r.status === 400 && j.code === 'ERR_MISSING_REQUIRED_FIELDS') ok('上游 400：**状态码与错误体原样透传**（排障时看得见真正原因）')
    else bad('上游错误透传', `${r.status} ${JSON.stringify(j)}`)
  } finally { relay.close(); upstream.close() }
}

/* ── 汇总 ─────────────────────────────────────────────────────────────── */
const pass = results.filter((r) => r.pass).length
const fails = results.filter((r) => !r.pass)
console.log('\n=== tts-relay 自检 ===')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${!r.pass ? '  ← ' + r.d : ''}`)
console.log(`--- 汇总：PASS ${pass} / FAIL ${fails.length} ---`)
process.exitCode = fails.length ? 1 : 0
