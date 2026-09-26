# 车万女仆（Touhou Little Maid）AI 协议笔记

> 本文是**实测取证**的结果，不是从文档抄的。所有结论后面都标了来源：
> `[jar]` = 反编译/字节码取证，`[实测]` = 真机打过一次请求并看到响应。
>
> 目标版本：**touhoulittlemaid 1.5.3（Forge, MC 1.20.1）**。

---

## 一、女仆发给上游的请求长什么样

`[实测]` 一次真实的 AI 对话请求（经本项目中转抓取）：

```
POST <站点 URL>
Authorization: Bearer <站点里填的 Secret Key>
model     = <站点 models 里选的那个>
messages  = [system, user, assistant, user, ...]      # roles 只出现 system/user/assistant
tools     = 7 个：use_skill, query_minecraft_wiki, query_game_context,
            switch_follow_state, switch_work_task, switch_schedule, switch_sit
response_format = text        # 注意：是 text，不是 json_object
thinking  = 通常不带
```

要点：

- **只出现 `system` / `user` / `assistant`** 三种 role（这次没见到 `developer`）。
- `[jar]` 但 jar 里的 `Role` 枚举是 `system / user / assistant / tool / **developer**`，
  且 `LLMOpenAIClient` 会调用 `ChatMessage.developerChat(...)` —— 所以**别的调用路径可能发
  `developer`**，而不少上游（例如 DeepSeek）会直接回
  `422 unknown variant 'developer'`。中转应当把不认的 role 改写成 `system`。
- `response_format` 实际是 **`text`** —— 回复**不是 JSON**（这点很容易搞错，
  因为它同时带了 `tools`，看起来像"要 JSON 的工具调用协议"）。

## 二、回复的格式契约（最重要）

`[实测]` 从女仆自己的 system 消息里抠出来的原文：

```
Output ONLY **STRICT PLAIN TEXT**.
## Output Format Requirements
- Do not include narrative descriptions of actions or expressions (e.g. *smiles*, *waves hand*).
- Output exactly two parts separated by a line containing only ---
  - Part 1: Your reply in <聊天语言>.
  - Part 2: An exact copy of Part 1 (used for text-to-speech).
      （聊天语言与语音语言不同时，Part 2 = Part 1 的翻译）
## Output Example:
part1 in <聊天语言> language
---
part2 in <聊天语言> language
```

代码侧对应 `ai/manager/response/ResponseChat`：`String.split("---", 2)` →
`part[0]` 进气泡、`part[1]` 送去 TTS；`toString()` 还原成 `"%s---%s"`。
**第 2 段为空时会退回念第 1 段**（所以合并不报错，但行为会静默改变）。

同一段 system 里还有这些硬规则（角色卡不应与之冲突）：

| 规则 | 原文 |
| --- | --- |
| 回复要短 | `KEEP REPLIES UNDER 72 CHARACTERS` |
| 不报工具结果 | `NEVER report the result of a tool call to the user` |
| 禁词 | 具体时间（`02:32`）、系统词（`schedule` / `mode` / `work task` / `context`） |
| 不要动作描写 | `Do not include narrative descriptions of actions or expressions` |

> 推论：**角色卡（人设）应当插在这条 system 之后**。模型对靠后的冲突指令更买账，
> 而这条 system 里同时装着"输出格式约定"和"默认称呼（`Refer to the user as "主人"`）"，
> 人设卡放后面才压得住它。

## 三、TTS 协议（六种 api_type）

| api_type | URL | 鉴权 | 文本字段 | 响应 |
| --- | --- | --- | --- | --- |
| `minimax` | 站点 `url`（如 `https://api.minimaxi.com/v1/t2a_v2`） | `Authorization: Bearer <key>` | `text` | **JSON**，`base_resp.status_code==0` 时把 `data.audio` 当**十六进制**解成字节 |
| `fish-audio` | 站点 `url` | 同上 | `text` | 裸音频字节 |
| `gpt-sovits` | 站点 `url`（如 `http://127.0.0.1:9880/tts`） | 同上 | `text` | 裸音频字节 |
| `siliconflow` | 站点 `url` | 同上 | **`input`**（不是 text） | 裸音频字节 |
| `player2` | 站点 `url`（本地 app） | 头 `player2-game-key` | `text` | 见下 |
| `system` | 无 | 无 | — | 用 MC 内置旁白（客户端 `Narrator.say`） |

其它实测/取证要点：

- **零重试、零切分、零并发限制**；HTTP 客户端连接超时 **10 s**、单请求 **20 s**。
  成功判定 = `200 ≤ code < 300`；失败码 0 = 发送错误、1 = 接收错误
  （玩家在聊天栏看到的就是这两句）。
- `player2` **在 MC 里不发声**：`play()` 带 `isClient()` 守卫 + `@OnlyIn(CLIENT)`，
  音频交给本机 Player2 app。想听女仆出声**别选它**。
- **客户端只解 MP3 与 Ogg(Opus/Vorbis)**：`MaidAISoundInstance` 先试 `Mp3AudioStream`
  （javazoom 解 MPEG 帧），抛异常才用 `OggReader` 嗅探；**WAV / 裸 PCM 播不出来，
  而且完全静默**（HTTP 200、气泡照常显示、只在客户端日志留一句）。
  ⇒ 排障时"没声音但不报错"的头号嫌疑就是它。
- 站点未选 / 被禁用时会**回退到默认站点**（`DefaultLLMSite`，例如内置的 deepseek），
  所以"女仆照常说话"并不代表你的站点生效了。
- 语音语言：`TTSConfig.language` 实际发出的是 `getTTSLanguage().split("_")[0]`
  —— 例如 `en_us` 会变成 `"en"`。

## 四、踩过的坑（每条都真的踩过）

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| `422 unknown variant 'developer'` | 上游不认 `developer` role | 中转把不认的 role 改写成 `system` |
| `422 thinking: invalid type: boolean` | `thinking` 必须是对象 | 正确形状 `{"thinking":{"type":"enabled"\|"disabled"}}` |
| 带 tools 时第二轮 `400 ... reasoning_content` | 思考模式下**带 tools 的请求必须回传上一轮 `reasoning_content`**，而 mod 的 `response/Message` 只有 `role/content/tool_calls`，**存不下** | 带 tools 时把 `thinking` 强制成 `disabled` |
| TTS `400 Invalid request body` | 客户端**强制**发 `format=opus`，而上游只认 mp3 | 中转把 `format` 改成 `mp3`（其余字段全部被上游容忍） |
| 有气泡、**没声音、也不报错** | 音频不是 mp3/ogg（例如 wav） | 让上游吐 mp3 |
| 语音输入/合成超时 | 站点域名被墙（例如 `fishaudio.org` 的 API 路径直连会 `UND_ERR_CONNECT_TIMEOUT`） | 中转走本地 HTTP 代理；注意 `NODE_USE_ENV_PROXY` 对 fetch 无效、且 **undici 的 ProxyAgent 与 Node 内置 fetch 不兼容**（`UND_ERR_INVALID_ARG`），必须用 undici 自己的 fetch |
| 数字/标点念错 | 引擎念法 | 实测 MiniMax 会把「7」念成「七」、破折号只当停顿；**引号「」会被当独立 token 念出一个语气音** ⇒ 台词里不要加引号 |

## 五、站点配置文件

位置：`<游戏目录>/config/touhou_little_maid/sites/{llm,tts,stt}.json`

- 顶层是 `站点 id → 站点对象` 的映射；`models` 字段是 **`id → 显示名` 的映射**
  （不是数组），key 就是发给上游的模型 id / 音色 id。
- `stt.json` 里若指向本地服务（如 `http://127.0.0.1:4316/v1/audio/transcriptions`），
  游戏启动时会去探活，服务不在就报 `STT request failed`（不影响 TTS）。
- **这两个文件由 mod 自己在玩家改设置时重写**（会重新序列化，属正常）。
- **改文件要重启游戏才生效**（`AvailableSites.init()` 是启动时一次性初始化）；
  而"在女仆界面里换站点/音色"是**逐女仆**保存的、改完即对该女仆生效。
- ⚠️ 用 PowerShell 改这些文件时**别写出 BOM**：`Set-Content -Encoding UTF8` 会加 BOM，
  而 `JSON.parse` 不认（`ConvertFrom-Json` 却认 —— 所以很难发现）。
  用 `[IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($false)))`。

## 六、自测工具（都在 `tools/`）

| 脚本 | 作用 |
| --- | --- |
| `tools/live-check.mjs` | 读站点配置 → 经本机中转打**真实上游** → 核对角色卡注入位置与字段透传 |
| `tools/tts-live-check.mjs` | 生成/试听 TTS 音色样本；`--list-voices` 列出可用音色 |
| `tools/tts-roundtrip.mjs` | TTS→STT 转写→与原文逐字对比；`--subtitle` 用引擎自证的 `pronounce_text`（最硬的念法证据） |
| `tools/png-card.mjs` | 拆 PNG 里藏的卡数据（SillyTavern 的 `chara`/`ccv3`）或 ComfyUI 生成参数 |

## 七、取证方法（没有 javap 也能干）

本机没有 JDK。可用 Python 自写一个 class 解析器：解常量池全部 tag + `RuntimeVisibleAnnotations`
（**Gson 的 `@SerializedName` 字段名只藏在这里**，普通"抽可打印串"抽不到），再读方法体字节码。
本文 `[jar]` 标记的结论都是这么做出来的，产物可以按类名 grep，不必每次重跑。
