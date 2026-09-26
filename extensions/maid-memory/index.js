/**
 * maid-memory — DSH 隔离 SDK 插件（VNext Extension SDK V1）
 * ============================================================================
 * **把一段「共享记忆」放在插件里；默认 off（不注入），插件一跑起来就能按模式注入。**
 *
 * 四个模式（写在 data/mode.json，也可用本插件的 maid_memory 工具切换）：
 *   off   默认。谁都不注入。（插件不运行时**一律按 off 处理**）
 *   maid  只注入**女仆**的 LLM 请求（由本机 maid-bridge/relay.mjs 读取 state/memory 后插入）
 *   both  DSH 侧（provideContext）与女仆侧**都**注入
 *   wild  **狂野模式**：女仆的「脑子」直接接到 DSH 会话（共享记忆＝她就是有记忆的我）。
 *         标记为实验性：切换立即生效（relay 每回合读 mode.json），但输出契约尚未实机验证。
 *
 * 与外部的接口（刻意做成**文件**，因为 relay 是另一个进程）：
 *   data/mode.json   { "mode": "off" }            ← 模式的唯一真源（用户/工具都可改）
 *   data/alive.json  { at, pid, mode, version }   ← 心跳：relay 据此判断"插件真的活着"
 *   data/memory.md   记忆正文（人可读可改）
 *
 * 设计原则：**任何异常都不许抛回宿主**（插件挂了不该拖垮 DSH）。
 * ============================================================================
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERSION = '0.1.0';
const MODES = ['off', 'maid', 'both', 'wild'];
const HEARTBEAT_MS = 5000;

const DEFAULT_MEMORY = [
  '# 共享记忆（maid-memory）',
  '',
  '> 这是默认稿：直接改这个文件即可（改完立刻生效，不用重启）。',
  '',
  '## 约定',
  '',
  '- 回复分两段，中间一行只写 `---`：第一段进气泡，第二段才会被念出来。',
  '- 每段尽量短；纯文本；不要 `*动作*`；台词里不要加引号。',
  '',
].join('\n');

module.exports.activate = function activate(ctx) {
  const dataDir = ctx.dataDir;
  const modePath = path.join(dataDir, 'mode.json');
  const alivePath = path.join(dataDir, 'alive.json');
  const memPath = path.join(dataDir, 'memory.md');

  const safe = (fn, fallback) => { try { return fn() } catch { return fallback } };

  const readMemory = () => safe(() => fs.readFileSync(memPath, 'utf8'), '');
  const writeMemory = (text) => {
    fs.writeFileSync(memPath, text, 'utf8');
    return text.length;
  };
  const ensureMemory = () => {
    if (!fs.existsSync(memPath)) safe(() => writeMemory(DEFAULT_MEMORY), 0);
  };

  // ── 模式：data/mode.json 是唯一真源 ─────────────────────────────────────
  const readMode = () => {
    const j = safe(() => JSON.parse(fs.readFileSync(modePath, 'utf8')), null);
    const m = String((j && j.mode) || 'off').toLowerCase();
    return MODES.includes(m) ? m : 'off';
  };
  const writeMode = (mode) => {
    if (!MODES.includes(mode)) throw new Error(`未知模式：${mode}（可选 ${MODES.join('/')}）`);
    fs.writeFileSync(modePath, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    safe(() => ctx.settings.set('mode', mode), null);   // 顺便同步到插件私有设置
    beat();
    return mode;
  };

  // ── 心跳：relay 用它判断"插件在不在跑" ─────────────────────────────────
  let timer = null;
  const beat = () => safe(() => {
    fs.writeFileSync(alivePath, JSON.stringify({
      at: Date.now(), pid: process.pid, mode: readMode(), version: VERSION,
    }) + '\n', 'utf8');
  }, null);

  ensureMemory();
  if (!fs.existsSync(modePath)) safe(() => writeMode('off'), null);
  beat();
  try { timer = setInterval(beat, HEARTBEAT_MS); if (timer.unref) timer.unref(); } catch { /* 宿主不允许定时器就退化到"调用时打点" */ }

  ctx.log('info', `maid-memory v${VERSION} 已激活（dataDir=${dataDir}，模式=${readMode()}）`);

  // ── 上下文贡献：both / wild 时把记忆注入 DSH 每回合的上下文 ──────────────
  ctx.provideContext(() => {
    beat();
    const mode = readMode();
    if (mode !== 'both' && mode !== 'wild') return '';
    const mem = readMemory().trim();
    if (!mem) return '';
    return `【共享记忆 · maid-memory（模式 ${mode}）】\n${mem}`;
  });

  // ── 工具：让我（Agent）在对话里直接读写记忆与切模式 ─────────────────────
  ctx.registerTool(
    'maid_memory',
    {
      description: '读写/追加「共享记忆」，或切换共享模式。模式：off(默认，不注入) / maid(只给女仆) / both(两边都注入) / wild(狂野模式：女仆的脑子直接接到 DSH 会话，实验性)。',
      parameters: {
        action: { type: 'string', required: true, description: 'status | read | write | append | set_mode' },
        text: { type: 'string', required: false, description: 'write/append 时的正文' },
        mode: { type: 'string', required: false, description: 'set_mode 时的模式：off | maid | both | wild' },
      },
    },
    (args) => {
      beat();
      const action = String(args.action || '').toLowerCase();
      switch (action) {
        case 'status':
          return { mode: readMode(), modes: MODES, version: VERSION, dataDir, memoryChars: readMemory().length, alive: alivePath };
        case 'read':
          return { mode: readMode(), memory: readMemory() };
        case 'write': {
          const n = writeMemory(String(args.text ?? ''));
          ctx.log('info', `maid_memory: 记忆整写 ${n} 字符`);
          return { ok: true, wrote: n };
        }
        case 'append': {
          const add = String(args.text ?? '');
          const cur = readMemory();
          const n = writeMemory(cur + (cur.endsWith('\n') ? '' : '\n') + add + '\n');
          ctx.log('info', `maid_memory: 记忆追加 ${add.length} 字符`);
          return { ok: true, totalChars: n };
        }
        case 'set_mode':
          return { ok: true, mode: writeMode(String(args.mode || 'off').toLowerCase()) };
        default:
          return { ok: false, error: `未知 action：${action}（可选 status/read/write/append/set_mode）` };
      }
    },
  );

  // ── 收尾：宿主若支持 deactivate 就停表（不支持也无害，心跳会自然过期）──
  return function deactivate() {
    try { if (timer) clearInterval(timer); } catch { /* noop */ }
    safe(() => fs.writeFileSync(alivePath, JSON.stringify({ at: 0, pid: process.pid, mode: 'off', version: VERSION }) + '\n', 'utf8'), null);
  };
};
