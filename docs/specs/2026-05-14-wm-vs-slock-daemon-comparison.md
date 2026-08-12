# WM Daemon vs Slock Daemon 架构对比

> 日期：2026-05-14
>
> 目的：全面对比两个 daemon 的架构差异，为平台演进（agent 在线化、飞书接入、agent-agent 协作）提供技术决策依据。

## 一、核心架构差异总览

| 维度 | WM Daemon | Slock Daemon |
|------|-----------|--------------|
| **进程模型** | 按需 spawn，turn 结束销毁进程 | 进程常驻，turn 结束标记 idle |
| **上下文恢复** | 通过 sessionId 调 API resume | 进程内存保持，无需恢复 |
| **消息投递** | turn 间批量投递 | stdin 实时投递（idle 和 busy 均可） |
| **Turn 中追加** | 不支持 | Claude: gated steering；Codex: turn/steer |
| **平台通信桥** | wm CLI wrapper（HTTP） | chat-bridge MCP Server（stdio） |
| **唤醒延迟** | 秒级（spawn + init + session resume） | 毫秒级（stdin write） |
| **资源占用** | idle 时零进程 | idle 时进程常驻（低 CPU，占内存） |

## 二、进程生命周期

### WM Daemon：Turn-Per-Process

```text
消息到达 → spawn 进程 → 传入 prompt + sessionId
→ runtime 执行 turn → 返回结果 + 新 sessionId
→ 销毁进程 → 缓存 idleConfig(sessionId + config + workspace)
→ 下次消息到达 → 重新 spawn + resume
```

关键代码路径：
- `agent-process-manager.ts` → `runAgentRuntime()` 每次创建新 adapter 实例
- Claude adapter: 每次 `sdkQuery()` 创建新 API stream，结束后 stream 关闭
- Codex adapter: 每次 `spawn("codex", ["app-server"])` 新进程，turn 结束 `client.destroy()` 杀进程
- `drainQueuedMessagesAfterTurn()`: 有排队消息时通过 `queueMicrotask` 立即重新 spawn

优点：
- idle 时零资源消耗
- 进程隔离，crash 不影响后续 turn

缺点：
- 每次唤醒有冷启动开销（spawn + init + session resume）
- 无法在 turn 执行中追加消息
- session resume 依赖外部 API 的上下文重建能力

### Slock Daemon：Persistent Process

```text
首次消息 → spawn 进程（Claude: stream-json 模式 / Codex: app-server stdio）
→ 通过 stdin 写入 prompt
→ runtime 执行 turn → stdout 输出 turn_end 事件
→ 进程保持运行，标记 isIdle = true
→ 下次消息 → 直接 stdin write，标记 isIdle = false
→ 进程异常退出时才重新 spawn
```

关键实现：
- Claude: `--input-format stream-json --output-format stream-json` 保持 stdin/stdout 流打开
- Codex: `app-server --listen stdio://` 保持 JSON-RPC 通道打开
- `deliverMessagesViaStdin()`: 直接写入 `proc.stdin.write(encoded + "\n")`
- idle → active 转换：仅修改 `ap.isIdle = false`，无进程操作

优点：
- 毫秒级唤醒（stdin write）
- 上下文在进程内存中保持，不依赖外部 API resume
- 支持 turn 中追加消息（steering）

缺点：
- idle 进程占用内存（Claude CLI ~65MB，Codex ~18MB）
- 进程 crash 需要重建上下文

## 三、消息投递机制

### WM Daemon

```text
消息到达 → deliverMessage()
  ├─ agent starting → queue to startingInboxes
  ├─ agent idle (not running) → enqueueStart(wakeMessage) → spawn 新进程
  ├─ agent running → queue to runningInboxes → turn 结束后 drain
  └─ agent offline → reject (accepted=false)
```

- 消息只能在 turn 边界投递
- turn 执行中的消息排队等待
- 排队消息在 turn 结束后通过 `drainQueuedMessagesAfterTurn()` 批量送入下一个 turn

### Slock Daemon

```text
消息到达 → deliverMessage()
  ├─ agent not running, has idle config → auto-restart from cache
  ├─ agent running, idle → stdin write (mode: "idle") → 立即处理
  ├─ agent running, busy
  │   ├─ Claude (gated) → 等待安全边界 → stdin write
  │   ├─ Codex (direct) → turn/steer 直接注入
  │   └─ 其他 (none) → queue → turn 结束后重启
  └─ agent starting → queue
```

Slock 的 gated steering 机制（Claude 特有）：

```text
phase: idle → accepting → pending → idle
  - idle: 等待安全写入点
  - accepting: 无进行中的 tool use，可以安全写入 stdin
  - pending: 消息已写入，等待 runtime 响应
  - 安全边界判断: outstandingToolUses === 0 && !compacting
```

这意味着即使 agent 正在执行任务，新消息也能被注入到当前 turn 中，agent 可以在不中断的情况下感知新信息。

## 四、平台通信桥

### WM Daemon: wm CLI Wrapper

```text
Agent runtime
  → 调用 wm CLI（bash wrapper → node wm-cli.js）
  → HTTP POST/GET 到 Server /internal/agent/{agentId}/*
  → Server 处理并返回
```

- `wm` 是 bash 脚本，exec 到 node `wm-cli.js`
- 每次调用是独立 HTTP 请求
- 支持约 20 个命令：message check/send/read/search, task list/claim/unclaim/update/create, attachment upload/view, profile show/update, reminder schedule/list/snooze/update/cancel, auth whoami
- 没有 MCP 集成，runtime 通过 tool_use 调用 shell 命令

### Slock Daemon: chat-bridge MCP Server

```text
Agent runtime
  → MCP tool call (mcp__chat__send_message 等)
  → chat-bridge.js (MCP Server, stdio transport)
  → HTTP 到 Slock API
```

- chat-bridge 作为 MCP server 随 runtime 启动，通过 `--mcp-config` 注入
- 使用 `@modelcontextprotocol/sdk` 标准实现
- 通信走 MCP 协议（stdio），不需要 shell 调用开销
- 支持消息去重（10k 缓存）和投递确认（receive-ack）
- 工具列表：send_message, check_messages, read_history, search_messages, list_server, leave_channel, list_tasks, create_tasks, claim_tasks, unclaim_task, update_task_status, upload_file, view_file, schedule_reminder, list_reminders, cancel_reminder

核心差异：
- WM 的 wm CLI 是 shell → node → HTTP 三层调用，每次有进程启动开销
- Slock 的 chat-bridge 是常驻 MCP server，工具调用走内存 stdio，零启动开销

## 五、Runtime 支持矩阵

### WM Daemon

| Runtime | 通信方式 | 进程模型 | Session Resume |
|---------|---------|---------|----------------|
| Claude | SDK API stream | 每 turn 新 stream | `resume: sessionId` |
| Codex | JSON-RPC stdio | 每 turn 新进程 | `thread/resume` |
| Cursor | ACP JSON-RPC | 每 turn 新进程 | `session/load` |
| Gemini | ACP JSON-RPC | 每 turn 新进程 | `session/load` |
| Hermes | ACP JSON-RPC | 每 turn 新进程 | `session/load` |
| OpenCode | 未接入 | 不支持 | 不支持 |

### Slock Daemon

| Runtime | 通信方式 | 进程模型 | Turn 中投递 | stdin 投递 |
|---------|---------|---------|------------|-----------|
| Claude | stream-json stdin/stdout | 常驻 | gated steering | 支持 |
| Codex | JSON-RPC stdio | 常驻 | turn/steer | 支持 |
| Copilot | — | 每次重启 | 不支持 | 不支持 |
| Cursor | — | 每次重启 | 不支持 | 不支持 |
| Gemini | — | turn 结束终止 | 不支持 | 不支持 |
| Kimi | — | turn 结束终止 | 不支持 | 不支持 |
| OpenCode | stdio | 常驻 | direct | 支持 |

关键差异：Slock 对 Claude 和 Codex 实现了进程常驻 + stdin 实时投递，这两个是最核心的 runtime；其他 runtime 降级到按需重启。

> **2026-05-14 实测更新**：对本机 runtime 能力进行了常驻进程测试和代码对照。Claude 的常驻模式不是当前 SDK stream，而是 Slock 已验证的 Claude CLI `stream-json` 模式；Codex 使用 app-server stdio；Cursor/Gemini/Hermes/OpenCode 走 ACP/stdio 或等价 stdio 协议。
>
> | Runtime | 进程常驻 | 两轮 turn 存活 | 备注 |
> |---------|---------|---------------|------|
> | Claude | ✅ | ✅ | 需从 SDK one-shot 切到 CLI `--input-format stream-json --output-format stream-json`，Slock 已验证可行 |
> | Codex | ✅ | ✅ | 当前代码 finally 里 destroy 了 client，去掉即可 |
> | Cursor | ✅ | ✅ | ACP 模式两轮 prompt 均 `stopReason: "end_turn"`，进程不退出 |
> | Gemini | ✅ | ✅ | ACP 模式两轮 prompt 均正常返回，进程不退出 |
> | Hermes | ✅ | ✅ | 复用 ACP 常驻路径；模型列表来自 Hermes 配置或 CLI/provider 检测 |
> | OpenCode | ✅ | ✅ | 进程常驻；`session/new` 报 "No models available"（本地未配置 provider，不影响常驻判断） |
>
> **结论**：Slock 文档中 Cursor "每次重启"、Gemini "turn 结束终止"的描述与当前版本实测不符，可能为早期版本行为或主动选择。WM 的目标实现应覆盖 Claude、Codex、Cursor、Gemini、Hermes、OpenCode 六类 runtime；其中 OpenCode 需要先补齐 shared protocol、daemon adapter、model detection、server validation 和 web selector。

## 六、系统提示词构建

### WM Daemon

- 构建在 `workspace/agent-workspace.ts` 的 `buildSystemPrompt()`
- 内容：agent 身份、平台上下文、wm CLI 命令列表、记忆规则、启动序列、消息模型、协作规则
- 通过文件写入 `workspace/.wm/system-prompt.md`，传给 runtime adapter

### Slock Daemon

- 构建在 driver 内部的 `buildSystemPrompt()` / `buildCliTransportSystemPrompt()`
- 内容：agent 身份、workspace 路径、通信指令（MCP 工具前缀）、runtime 特定行为说明、任务工作流、协作礼仪
- Claude 特有：gated steering 行为说明、stdin notification 解释
- 通过 `--system-prompt-file` 传给 Claude CLI

### 差异

WM 的系统提示词不包含 runtime 进程行为说明（因为进程不常驻）。Slock 的提示词明确告诉 agent "你的进程会一直运行，新消息通过 stdin 到达"，让 agent 理解自己的运行模式。

## 七、活动追踪与健康监控

### WM Daemon

- `ActivityTracker` 转换 RuntimeEvent → ActivityEntry
- 通过 `agent:activity` WebSocket 消息上报
- 状态：starting / working / idle / offline / error
- 无心跳机制（依赖 WebSocket 连接状态）
- 无运行时卡死检测

### Slock Daemon

- 每 15 秒发送 activity heartbeat（无论 idle 还是 working）
- 运行时卡死检测：30 分钟无 runtime event → 诊断 + 可能重启
- gated steering 状态追踪：outstandingToolUses、compacting、phase
- 详细的 OpenTelemetry-style tracing（span/event 级别）
- 本地 trace 文件轮转（5MB/5min/8 files），支持上传到服务端

## 八、连接管理

### WM Daemon

- WebSocket 到 Server，断线指数退避重连（1s → 30s）
- 收到 1008 "machine removed" 永久断开
- 断线时 running agent 继续执行但消息可能丢失
- 无连接健康检测（无 watchdog）

### Slock Daemon

- WebSocket 到 Slock API，断线指数退避重连（1s → 30s）
- **70 秒无消息 watchdog**：强制断开重连，防止僵死连接
- 断线时 agent 继续本地运行
- 支持代理（proxy）配置

## 九、对在线 Agent 方向的影响

基于以上对比，要实现"agent 一直在线"的目标，WM Daemon 需要在以下方面向 Slock 看齐：

### 必须改造

1. **进程常驻**：Claude、Codex、Cursor、Gemini、Hermes、OpenCode runtime 全部支持常驻运行，turn 结束不销毁进程
2. **RuntimeSession 状态机**：daemon 以 agent 为单位持有 adapter/process/client，状态区分 starting、busy、idle、stopping、error
3. **idle 投递复用进程**：idle 状态消息直接进入已有 runtime，不重新 spawn；busy 状态第一版仍排队到 turn 边界处理
4. **真实 stop/reset**：stop、reset workspace、delete agent 必须 abort 当前 turn 并 destroy 本地 runtime process，再更新 Server 状态
5. **OpenCode 接入**：补齐 `RuntimeId`、capability detection、model detection、adapter registry、Server 校验、Web 创建入口和 API scenario
6. **连接健康检测**：增加 inbound watchdog，防止僵死连接

### 建议改造

7. **心跳机制**：定期上报 activity heartbeat，增强状态可见性
8. **卡死检测**：busy runtime 长时间无 event 时触发诊断和恢复，idle runtime 不因无事件被误杀
9. **MCP 通信桥**：将 wm CLI 迁移为 MCP server，消除 shell 调用开销
10. **gated steering**：实现 Claude 的安全边界投递，支持 turn 中消息追加；该项依赖常驻进程稳定后单独推进

### 可选改造

11. **tracing**：增加 span 级别追踪，便于线上诊断
12. **trace 上传**：本地 trace 文件轮转 + 上传能力
13. **代理支持**：WebSocket 连接支持 HTTP proxy

### 不需要改造

- 工作区结构（两者类似，WM 更完整）
- 技能扫描（WM 已实现）
- 基本消息协议（结构类似）
