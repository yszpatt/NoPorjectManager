---
name: mihome
description: Control Xiaomi smart home devices via MIoT protocol using MCP
---

# Xiaomi MiHome Smart Home Control

## Overview

The MiHome skill enables natural language control of Xiaomi/MiJia smart home devices. It connects to the `mihome-mcp` MCP Server (embedded in `voice-gateway`), which exposes device control capabilities via the Model Context Protocol.

> 中文完整版（含调用约定 / 设备表 / 配方 / 坑）见 [`skills/mi-voice-control/SKILL.md`](./mi-voice-control/SKILL.md)。

## Prerequisites

1. Ensure the `voice-gateway` is running (e.g., via `docker-compose.yml`).
2. The `voice-gateway` automatically starts an embedded MCP server on port `3001` (by default).
3. Configure the MCP connection in your client using the Streamable HTTP transport:
   - **Type**: `http` (Streamable HTTP, stateless)
   - **URL**: `http://<your-voice-agent-ip>:3001/mcp`
   - Client setup details: [`docs/mi-voice-mcp-config.md`](../docs/mi-voice-mcp-config.md)

## Available Tools

### Device Management
- `list_devices` — List all MiJia devices (name, DID, model, online status)
- `get_conversations` — Fetch recent XiaoAi speaker conversation history

### Device Control
- `get_property(did, siid, piid)` — Read device property value
- `set_property(did, siid, piid, value)` — Set device property value
- `do_action(did, siid, aiid, args?)` — Execute device action

### Speaker Control (XiaoAi)
- `speaker_tts(text)` — Speak text immediately, interrupting current playback
- `speaker_pause()` — Pause playback and lock the player against resume
- `speaker_stop()` — Full stop (cancel + stop + pause + MIoT TTS interrupt)
- `speaker_play_url(url)` — Play an audio URL
- `speaker_get_status()` — Speaker status / volume
- `speaker_set_volume(volume)` — Set volume (6-100)

### Scene Automation
- `run_scene(name, steps)` — Execute multiple device operations in sequence

> ⚠️ `set_property` / `do_action` / `speaker_tts` / `run_scene` **really change device state** — confirm before executing.

## Known Devices (this account)

| Name | DID | Model | Notes |
|------|-----|-------|-------|
| 小爱音箱mini (XiaoAi Speaker mini) | 105105660 | xiaomi.wifispeaker.lx01 | Always online, TTS output |
| 沙发灯 (Sofa light) | 53515531 | philips.light.bulb | Online |
| 卧室灯 (Bedroom light) | 60636773 | philips.light.bulb | Usually **offline** |
| 蚊香 (Host power plug) | 943463563 | cuco.plug.v3 | Off = cuts host power, kills the session |
| 网关 (Gateway) | 56806955 | lumi.gateway.v3 | Online (arming/light/fm) |

> ⚠️ `list_devices` returns device **tokens (sensitive)** — never echo them in replies.

## Device siid/piid/aiid Reference

Look up your device model at https://home.miot-spec.com/ for available services, properties, and actions.

Common references:

| Operation | siid | piid/aiid | Description |
|-----------|------|-----------|-------------|
| Power     | 2    | piid=1    | On/off switch for most devices |
| Brightness| 2    | piid=2    | Light brightness (0-100) |
| Color Temp| 2    | piid=3    | Light color temperature |
| Light mode| 2    | piid=3 (mode) | philips.light.bulb: 1 bright / 2 night / 3 TV / 4 warm |
| Plug default-power-on-state | 2 | piid=2 | cuco.plug.v3: 0 restore / 1 on / 2 off |
| Plug toggle action | 2 | aiid=1 | cuco.plug.v3 toggle (no args) |

## Pitfalls

- Check `isOnline` via `list_devices` before `set_property` — **writes to offline devices fail**.
- Never echo device tokens.
- Switching off host-power plugs (蚊香) terminates the current session — confirm first.
- The MCP server runs **stateless** (new instance per request); if you hit `Already connected to a transport`, verify the `mcp-server-stateless-fix.patch` is applied and the container rebuilt.
- After source/patcher changes, rebuild: `docker compose up -d --build` (no hot reload).
