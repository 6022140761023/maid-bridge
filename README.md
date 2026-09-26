# tlm-ai-bridge —— 给车万女仆换上你自己的角色卡与声音

> 一句话：**在本机起两个小中转，把「你的角色设定」和「你挑的音色」接进车万女仆（Touhou Little Maid）的 AI 对话。**
> 不改 mod、不写 Java、不碰存档 —— 全部是可随时关掉的配置与外部进程。

适用于 **touhoulittlemaid 1.5.3 / Minecraft 1.20.1 Forge**。

```
女仆 ──► ① relay.mjs (127.0.0.1:8788) ──► 你的 LLM 上游（任何 OpenAI 兼容端点）
            插角色卡 / 修上游不认的 role / 思考护栏
女仆 ──► ② tts-relay.mjs (127.0.0.1:8789) ──► Fish Audio（或任何 fish-audio 形状的端点）
            只把 format: opus 改成 mp3（+ 可选走本地代理）
```

## 它解决什么问题

车万女仆的 AI 对话支持"自己加 LLM/TTS 站点"，但有三处不方便：

| 问题 | 本项目的做法 |
| --- | --- |
| **人设只能写进女仆自己的「角色设定」框**，换角色要重新编辑、也不方便版本化 | ① 中转把一份 `persona.md` 作为 `system` 消息**插进每次请求**（位置在女仆自己的 system **之后** —— 模型对靠后的冲突指令更买账） |
| **上游常拒收某些字段**（例如 DeepSeek 不认 `role: developer`；`thinking` 必须是对象；带 tools 时思考模式第二轮必 400） | ① 中转统一改写/护栏，并在日志里写明"改了什么" |
| **TTS 只认 mp3/ogg**，而客户端**强制**发 `format=opus`；某些域名直连还会超时 | ② 中转把 `format` 改成 `mp3`（其余字段原样透传），并支持走本地 HTTP 代理 |

**所有结论都有实测/取证依据**，见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

## 快速开始

### 0. 前置

- **Node.js ≥ 20**（用到内建 `fetch` 与 ESM）。
- 车万女仆 **1.5.3** / **MC 1.20.1 Forge**。
- 一把 **LLM 的 key**（DeepSeek / 任意 OpenAI 兼容服务），以及（可选）一把 **Fish Audio key**。
- Windows 用户可直接用仓库里的 `.vbs` / `.cmd` 启动脚本；其它系统用 `node xxx.mjs` 即可。

```bash
npm install      # 只有一个依赖：undici（TTS 走本地 HTTP 代理时才用得上）
```

### 1. 拿到角色卡

```bash
cp persona.example.md persona.md     # 然后编辑 persona.md
```

`persona.md` 已被 `.gitignore` 排除 —— **你的角色卡不进版本库**（避免许可证与隐私问题）。

> 卡里不要在台词里用引号（`「」『』""`）：TTS 引擎会把引号当成一个独立发音单元，
> 多念出一个语气音。也不要把女仆要求的 `---` 两段结构改掉。

### 2. 起两个中转

```bash
node relay.mjs          # LLM 中转：127.0.0.1:8788
node tts-relay.mjs      # TTS 中转：127.0.0.1:8789
```

Windows 上想开机常驻、又不想要黑窗口：

```powershell
.\start-relay.vbs        # 隐藏窗口启动 LLM 中转
.\start-tts-relay.vbs    # 隐藏窗口启动 TTS 中转
.\stop-relay.cmd         # 按端口停掉（8788）
.\stop-tts-relay.cmd     # 按端口停掉（8789）
```

自检（**不需要任何 key、不碰外网**；`npm test` = 下面三个一起跑）：

```bash
npm test                      # 一条命令跑完三个自检
node test.mjs                 # LLM 中转离线自检（假上游逐字段对账）
node tts-relay-test.mjs       # TTS 中转离线自检
node shared-context-test.mjs  # 共享记忆逻辑自检（可选功能）
curl http://127.0.0.1:8788/health
```

> 自检**只依赖仓库自带的东西**（`test-fixtures/` 里的测试角色卡 + 临时空目录）：
> 不读你的 `persona.md`，也不读插件真实数据 —— 所以刚 clone 下来就该全绿。
> 若出现 FAIL，那是真有问题，别当成"环境没配好"。

### 3. 在游戏里加站点

有两种做法，**推荐用游戏内 GUI**（mod 会自己把配置写对，不会踩 BOM 之类的坑）：

1. 进游戏 → 右键女仆 → **女仆 AI 聊天设置** → **站点配置 → 添加**
   - **LLM 站点**：URL 填 `http://127.0.0.1:8788/v1/chat/completions`，Secret Key 填你的 LLM key，
     模型名填上游要的模型 id（如 `deepseek-chat`）
   - **TTS 站点**：选 `fish-audio` 类型，URL 填 `http://127.0.0.1:8789/v1/tts`，
     Secret Key 填 Fish Audio 的 key，**音色 id** 填你想用的那个 voiceId
2. 回到同一界面：**大语言模型站点** = 你刚建的站、**语音合成站点** = 刚建的 TTS 站、
   **语音合成语种** = 中文（⚠️ 若语种与聊天语言不一致，模型会把第 2 段翻成那个语言，
   听起来就像女仆在说外语）

或者直接编辑 `<游戏目录>/config/touhou_little_maid/sites/llm.json` 与 `tts.json`
（结构见 `docs/PROTOCOL.md` §5，改完**要重启游戏**）。

### 4. 验证

```bash
node tools/live-check.mjs                 # 站点/中转/上游/角色卡 四项一起验
node tools/tts-live-check.mjs --list-voices
node tools/tts-live-check.mjs --voice "<voiceId>" --say "老师，账我算好了。"
```

跟女仆说一句话；`relay.log` 里会出现一行 `← TLM 请求 …`，说明请求真的到了中转。

## 配置项

### `relay.mjs`（LLM）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | `8788` | 监听端口 |
| `--upstream` | `https://api.deepseek.com/v1/chat/completions` | 上游端点 |
| `--persona` | `./persona.md` | 角色卡路径（**每 5 秒自动热重载**，改完不用重启） |
| `--mock` | — | 不碰网络，回固定内容（验链路用） |
| `--dump` | — | 每次请求落 `dumps/` |
| `--drop-system` | — | ⚠️ 丢弃女仆自己的 system 段（**会连输出格式约定一起丢**，慎用） |

密钥**透传**：中转不存任何 key，客户端带来的 `Authorization` 原样转发。

### `tts-relay.mjs`（TTS）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | `8789` | 监听端口 |
| `--upstream` | `https://fishaudio.org/api/open/v1/speech/tts` | 上游端点 |
| `--proxy` | `$MAID_BRIDGE_TTS_PROXY` 或 `http://127.0.0.1:10808` | **先代理、失败再直连** |
| `--no-proxy` | — | 只走直连 |
| `--drop-opus-bitrate` | — | 顺手删掉 `opus_bitrate` |
| `--dump` / `--mock` | — | 同 LLM 中转 |

> 为什么默认带代理：实测 `fishaudio.org` 的 **API 路径直连会 `UND_ERR_CONNECT_TIMEOUT`（10 s）**，
> 走本地代理只要 ~1 s。另外两个坑：`NODE_USE_ENV_PROXY` 对 `fetch` 无效；
> **undici 的 `ProxyAgent` 不能喂给 Node 内置 `fetch`**（`UND_ERR_INVALID_ARG`），
> 必须用 undici 自己的 `fetch` —— 所以本项目把 `undici` 作为唯一依赖。

## 可选：共享记忆（需要 DeepSeek Harness）

`extensions/maid-memory/` 是一个 **DSH 隔离 SDK 插件**：把一段「记忆」放在插件里，
**默认 `off`（不注入）**，插件一运行就能按模式注入。

| 模式 | DSH 侧 | 女仆侧 |
| --- | --- | --- |
| `off`（默认） | 不注入 | 不注入 |
| `maid` | — | 注入一条 `system` |
| `both` | 注入 | 注入 |
| `wild` | 注入 | **女仆的"脑子"直接接到 DSH 会话**（实验性；桥接不支持 `tools`，游戏动作会失效） |

**硬保证**：**插件没在跑就一律按 `off`**（心跳过期 **且** pid 不在）—— 默认不花任何代价，
是代码强制的，不靠自觉。

不使用 DSH 的人可以完全忽略这一节；`shared-context.mjs` 只在中转里被动读取，缺省即关闭。

## 排障

| 症状 | 大概率原因 |
| --- | --- |
| 女仆照常说话，但语气没变 | **站点没选中**（未选站点时 mod 会回退到内置默认站点）。看 `relay.log` 有没有 `← TLM 请求` 即可判定 |
| 有气泡、**没声音也不报错** | 音频不是 mp3/ogg（客户端只认这两种，其它格式**静默失败**） |
| 聊天栏红字 `HTTP Error Code: 5xx` | 中转连不上上游。看 `relay.log` / `tts-relay.log` 里的"通路"日志 |
| 说出**外语** | 「语音合成语种」与聊天语言不一致 |
| `解析大语言模型返回的 JSON 时出错` | 输出格式约定被破坏（例如用了 `--drop-system`，或角色卡把 `---` 两段结构改掉了） |
| 改完 `sites/*.json` 没反应 | 这两个文件在**游戏启动时**读，需要重启游戏 |

更多见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md) §4「踩过的坑」。

## 联机说明

- **所有改动都是配置与外部进程**，没有改 mod 代码/网络协议/存档格式 ⇒
  用**同版本原版 mod** 的玩家可以正常和你联机。
- 女仆的 AI 是**服务端**跑的（mod 里明写 `addToolResult must be called on the server thread`）
  ⇒ **谁开房，AI 就在谁的机器上跑**：
  - **你开房**（单机／对局域网开放）：人设与声音对同场所有人生效，**他们不需要装任何东西**；
  - **别人开房**：你的 `127.0.0.1` 中转他够不着 ⇒ 女仆会退回那台机器上的站点（人设/声音就没了）。
- 纯原版（没装 mod）的客户端**进不来**：Forge 会因 mod 列表不匹配拒绝。

## 安全

- 中转**只绑 `127.0.0.1`**，且**不存储任何密钥**（透传 `Authorization`）。
- 你的 key 存在游戏自己的 `sites/*.json` 里 —— **别把那个文件推到公开仓库**。
- 日志里只记录密钥**长度**，不记录内容。

## 目录结构

```
relay.mjs              LLM 中转（角色卡注入 / role 修正 / 思考护栏）
tts-relay.mjs          TTS 中转（format opus→mp3 / 代理）
shared-context.mjs     共享记忆的读取与决策（纯函数）
persona.example.md     角色卡模板（复制成 persona.md 再用）
test.mjs               relay 离线自检
tts-relay-test.mjs     tts-relay 离线自检
shared-context-test.mjs 共享记忆自检
test-fixtures/         自检用的测试角色卡（不含任何第三方角色卡）
tools/                 真机自检与取证工具（见 docs/PROTOCOL.md §6）
extensions/maid-memory/ 可选的 DSH 插件（共享记忆）
docs/PROTOCOL.md       实测协议笔记与踩坑清单
start-*.vbs / stop-*.cmd Windows 启停脚本
```

## 许可与致谢

- 本项目代码：**MIT**（见 `LICENSE`）。
- **不含任何第三方角色卡**：`persona.md` 与 `cards/` 已被 `.gitignore` 排除 ——
  角色卡常另有许可证（如 CC BY-SA）或属个人创作，请自行判断能否公开。
- 协议取证基于 `touhoulittlemaid`（作者 Tartaric Acid 等，MIT）1.5.3 的 jar 反编译；
  本项目与 mod 作者无隶属关系。
