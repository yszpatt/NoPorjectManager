---
name: mi-voice-control
description: 通过 mi-voice MCP（小米 / 米家 / 小爱同学）控制智能家居——小爱音箱 TTS 播报、列设备、读写设备属性、执行动作 / 场景。当用户要让小爱同学说话、用音箱播提醒/问候/闲聊、查或控米家设备（灯、插座、网关等）、关灯/断电时使用。已固化已知设备的 siid/piid 映射与调用流程，无需翻文档。
---

# mi-voice 小爱 / 米家设备控制

mi-voice 是 **deferred MCP**：调用前必须先 `ToolSearch` 取 schema，再用 `DeferExecuteTool` 调用。

## 前置条件

- `voice-gateway` 容器已运行，内嵌 MCP Server 监听 `:3001`（默认）。
- 客户端 MCP 配置见 [`docs/mi-voice-mcp-config.md`](../docs/mi-voice-mcp-config.md)。
- 完整接入 / 部署背景见 [`docs/mi-voice-agent-guide.md`](../docs/mi-voice-agent-guide.md)。

## 调用流程（每次必做）

1. `ToolSearch` → `tool_names: ["mcp__mi-voice__<tool>"]` 取参数 schema。
2. `DeferExecuteTool` → `toolName: "mcp__mi-voice__<tool>"` + 参数。

## 常用工具

| 工具 | 作用 | 必填参数 |
|---|---|---|
| `list_devices` | 列账号全部米家设备（did/model/isOnline） | 无 |
| `speaker_tts` | 小爱音箱**立刻 TTS 播报**，打断当前播放 | `text` |
| `speaker_get_status` | 音箱状态 / 音量 | 无 |
| `get_property` | 读设备属性 | did, siid, piid |
| `set_property` | 写设备属性 | did, siid, piid, value |
| `do_action` | 执行设备动作 | did, siid, aiid, args |
| `run_scene` | 跑多步场景 | name, steps |
| `speaker_play_url` / `speaker_set_volume` / `get_conversations` | 播 URL / 调音量 / 查对话 | — |

## 已知设备（本账号）

| 名称 | did | model | 备注 |
|---|---|---|---|
| 小爱音箱mini | 105105660 | xiaomi.wifispeaker.lx01 | 常在线，TTS 出口 |
| 沙发灯 | 53515531 | philips.light.bulb | 在线 |
| 卧室灯 | 60636773 | philips.light.bulb | **常离线**，控不了 |
| 蚊香（宿主机供电） | 943463563 | cuco.plug.v3 | 关掉=切断宿主机电源，会终止本会话 |
| 网关 | 56806955 | lumi.gateway.v3 | 在线（arming/light/fm） |
| U300 / UPS / 其他插座 | — | cuco.plug.v3 | 在线 |

> ⚠️ `list_devices` 返回含设备 **token（敏感）**，回复里**不要回显**。

## 控制配方

### 小爱音箱说话（TTS）

```
DeferExecuteTool speaker_tts: {"text": "想播的内容"}
```

- 立即打断当前播放；适合问候 / 提醒 / 闲聊 / 任务完成播报。
- 给小朋友「满满」用**温和、不施压**语气；可提他喜欢的汪汪队、钢琴（《小马快跑》《圆舞曲》）。

### 飞利浦球泡灯（philips.light.bulb）

`set_property` → siid=2 (light)

- piid=1 `on` (bool) — 开关 `{value: true/false}`
- piid=2 `brightness` (1–100)
- piid=3 `mode` (1明亮/2夜灯/3电视/4温馨)
- piid=4 `color-temperature` (3000–5700)

### 米家插座3（cuco.plug.v3）

`set_property` → siid=2 (switch)

- piid=1 `on` (bool) — 主开关 `{value: true/false}`
- piid=2 `default-power-on-state` (0恢复/1上电开/2上电关)
- piid=3 `fault`
- 动作 aiid=1 `toggle`（无参）

### 网关（lumi.gateway.v3）

- 属性：`arming`(警戒) / `light`(灯) / `fm_current_status`

## 通用：查任意设备属性 siid/piid

1. `list_devices` 拿到目标 `model`。
2. 打开 `https://home.miot-spec.com/spec/<model>` 找 service→siid / property→piid。
3. 读：`get_property`{did,siid,piid}；写：`set_property`{did,siid,piid,value}。

## 必坑

- `set_property` 前务必 `list_devices` 核 `isOnline`：**离线设备写属性会失败**。
- 不回显设备 token。
- 切换 / 关断「宿主机供电」类插座（如蚊香）会终止本会话——执行前确认用户知情。
- MCP Server 为 **stateless** 模式（每请求新建实例），多客户端并发安全；若遇 `Already connected to a transport`，确认容器已应用 `deploy-lx01-deepseek/mcp-server-stateless-fix.patch`。
- 改源码或 patch 后必须 `docker compose up -d --build` 重建容器才生效。
