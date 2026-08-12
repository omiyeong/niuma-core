# Slock Agent Adapter 完整分析

> 日期：2026-05-15
>
> 目的：反编译并分析本机 Slock daemon 的 agent adapter 实现，明确哪些逻辑可以直接借鉴到 WM Daemon，哪些是我们当前实现偏离导致 Claude/Hermes/长时运行问题的根因。

## 结论

Slock 的关键不是“给每个 runtime 硬套同一种实现”，而是给每个 runtime 显式声明 driver 能力：

- Claude / Codex / Kimi 是真正的常驻 runtime：进程不随 turn 销毁，后续消息通过 stdin 或 JSON-RPC 送入。
- Cursor / Gemini / Copilot / OpenCode 在 Slock 中更偏 per-turn/session-resume 模型：Slock 支持它们，但不等于全部都是长期存活进程。
- Claude 的实现可以直接参考 Slock：Claude CLI `stream-json` 持久进程 + stdin JSON message + gated delivery。
- Hermes 不在 Slock 支持列表里，必须自己写；当前 WM 的 Hermes ACP adapter 用 `--model` 传参是错的，本机 Hermes CLI 实际接受 `-m/--provider` 这套参数。
- WM 现有 adapter 太依赖一个通用 ACP 抽象，缺少 Slock 那种 runtime-specific driver metadata，导致模型参数、生命周期、状态恢复、busy delivery 都很难准确。

本机 Slock daemon 包来源：

- package: `@slock-ai/daemon@0.47.0`
- path: `/Users/lexi/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon`
- 主要 bundle: `dist/chunk-77TJIZSE.js`

## Runtime 支持矩阵

Slock 当前 `RUNTIMES` 支持：

| Runtime | Binary | Slock display | Slock 状态 | WM 当前状态 |
|---------|--------|---------------|------------|-------------|
| Claude | `claude` | Claude Code | 支持，常驻 stream-json | 已接入，但参数/状态流不完整 |
| Codex | `codex` | Codex CLI | 支持，app-server 常驻 | 已接入，方向基本一致 |
| Kimi | `kimi` | Kimi CLI | 支持，wire protocol 常驻 | 未接入 |
| Copilot | `copilot` | Copilot CLI | 支持，per-turn | 未接入 |
| Cursor | `cursor-agent` | Cursor CLI | 支持，per-turn print | 已接入 ACP，和 Slock 不同 |
| Gemini | `gemini` | Gemini CLI | 支持，per-turn stream-json | 已接入 ACP，和 Slock 不同 |
| OpenCode | `opencode` | OpenCode | 支持，run/session 模型 | 已新增 ACP，但和 Slock 不同 |
| Hermes | `hermes` | 无 | 不支持 | WM 自研，当前有参数问题 |

用户截图里 Slock 检测到的 runtime 是 Claude Code、Codex CLI、Cursor CLI、Gemini CLI、OpenCode；Kimi 和 Copilot 未安装。这说明 Slock 的 runtime detection 是 binary-first，检测已安装 CLI，而不是前端硬编码 runtime 卡片。

## Slock Driver 抽象

Slock 每个 adapter 都导出一个 driver 对象，核心字段包括：

```ts
{
  id,
  displayName,
  binaryNames,
  lifecycle,
  communication,
  session,
  capabilities,
  model,
  spawn(),
  encodeStdinMessage?(),
  parseStdoutEvent?(),
  detectModels?()
}
```

关键设计点：

- `lifecycle` 决定进程模型：persistent、per_turn、是否 defer spawn、turn end 是否终止。
- `communication` 决定 agent 如何和平台通信：Slock CLI、MCP runtime actions、两者组合。
- `session` 决定上下文恢复方式：resume、fresh、resume_or_fresh。
- `model.toLaunchSpec()` 负责把平台 model id 映射成真实 CLI 参数。
- driver 自己决定 stdout/stderr 解析、stdin 消息格式、busy delivery 策略。

WM 当前的问题是：`AcpAdapter` 统一把 model 追加成 `--model <id>`，并默认所有 ACP runtime 都能按 `session/prompt` 多轮复用。这对 Cursor/Gemini/OpenCode/Hermes 不一定成立，也已经在 Hermes 上直接出错。

## Slock 通用 AgentProcessManager 语义

Slock daemon 的 runtime manager 有几个可以直接借鉴的行为。

### Start Queue

Slock 有全局 start queue：

- `agentsStarting`: 防止同一 agent 重复启动。
- `queuedAgentStarts`: 启动中收到的消息先入队。
- `maxConcurrentStarts`: 默认 5。
- `minStartIntervalMs`: 默认 500ms。

这解决两个问题：

- start-all 或大量 mention 时不会同时冷启动所有 runtime。
- 同一 agent 在 starting 阶段不会被重复 spawn。

### Workspace 初始化

Slock 每个 agent workspace 在 daemon data dir 下按 agent id 隔离，初始化包括：

- `MEMORY.md`
- `notes/`
- `.slock/agent-token`
- `.slock/slock`
- runtime-specific system prompt / MCP config / agent file

对 WM 的对应要求：

- workspace 目录必须使用 stable unique id，而不是 display name。
- display name 只能用于 UI mention 和人类可读展示。
- daemon 初始化 workspace 后才能让 server/web 显示 workspace 可浏览。

### 状态流

Slock 的状态不是 server 猜出来的，而是 daemon 根据真实 process/session 状态上报：

- starting: 进入启动队列或正在 spawn。
- working: runtime 已开始处理 turn。
- idle/online: process 存活，但没有当前 turn。
- offline/inactive: stop、crash、machine disconnect、无 runnable config。
- error: runtime 参数错误、登录失败、resume 失败等。

关键点是 process close 必须立即收敛状态：

- clean exit 但可恢复：缓存 config/session，标记 online/idle。
- crash 或参数错误：清 running，清 idle config，发送 inactive/error。
- explicit stop：取消 queued start，清 running 和 idle cache，晚到事件不能把状态刷回 running。

这正对应我们之前遇到的“stop 后一秒又 running”“diagnostic 显示 running 但 pid 为空”一类问题。

### Busy Delivery

Slock 不把所有 runtime 的 busy 消息都当成一样：

| Runtime 类型 | Busy 中收到消息 | 策略 |
|--------------|----------------|------|
| Claude | 可能破坏 signed thinking blocks | gated delivery，等安全边界再写 stdin |
| Codex | app-server 支持 steering | JSON-RPC `turn/steer` |
| 无 stdin/steer runtime | 不能实时投递 | queue，turn end 后新 turn |

WM 现在可以第一版继续“busy 排队到 turn 边界”，但需要把这个做成 driver capability，不要伪装成所有 runtime 都可实时投递。

## Claude Driver 详细分析

Slock 的 Claude 是最值得直接复用的实现。

### Lifecycle

Claude driver 声明：

- `kind: "persistent"`
- `stdin: "gated"`
- `inFlightWake: "queue"`
- `recovery: "resume_or_fresh"`
- `communication.chat: "slock_cli"`
- `communication.runtimeControl: "mcp_runtime_actions"`

也就是说 Claude 进程常驻，idle 时 stdin 直投，busy 时不乱写 stdin，而是等待 stream-json 安全边界。

### CLI 参数

Slock Claude spawn 的参数语义：

```text
claude
  --allow-dangerously-skip-permissions
  --dangerously-skip-permissions
  --verbose
  --permission-mode bypassPermissions
  --output-format stream-json
  --input-format stream-json
  --model <model>
  --disallowed-tools EnterPlanMode,ExitPlanMode,ScheduleWakeup,CronCreate,CronList,CronDelete
  --system-prompt-file <workspace>/.slock/claude-system-prompt.md
  --mcp-config <workspace>/.slock/claude-mcp-config.json
  --strict-mcp-config
  [--resume <sessionId>]
```

WM 当前 `ClaudePersistentAdapter` 只传：

```text
--input-format stream-json
--output-format stream-json
--system-prompt-file <path>
[--model]
[--dangerously-skip-permissions]
[--resume]
```

差异：

- 缺 `--verbose`。本机日志已出现 `--output-format=stream-json requires --verbose`，这是当前 Claude 失败的直接原因。
- full access 参数不完整，Slock 同时传 `--allow-dangerously-skip-permissions`、`--dangerously-skip-permissions`、`--permission-mode bypassPermissions`。
- 缺 disallowed tools，Claude 可能进入 PlanMode / cron 等不符合平台控制面的状态。
- 缺 MCP runtime-actions bridge；当前 WM 只能让 agent shell 调 `.wm/wm`，不像 Slock 能通过 MCP 工具直接通信。
- 缺完整 gated delivery，busy 阶段直接写 stdin 可能和 Claude stream-json thinking/tool blocks 冲突。

### stdin 消息格式

Slock 不用 `--print` 做 Claude 常驻。它启动 stream-json 进程后，向 stdin 写 JSON 行：

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "..." }]
  },
  "session_id": "optional-session-id"
}
```

WM 的方向是对的，也是在 stdin 写 stream-json user message；问题在启动参数和状态解析不完整。

### stdout 解析

Slock 解析 Claude stream-json event：

- `system:init`
- `assistant` text/thinking/tool_use
- `user` tool_result
- `result` success/error
- `turn_end`
- compact boundary/status

WM 需要确保：

- `turn_end` 一定 resolve 当前 prompt。
- `result` error 不被吞掉。
- `session_id` 被保存为 runtimeSessionId。
- process exit 比 prompt timeout 更早时，不应该等到 timeout；应该立即失败并上报参数错误。

### Gated Delivery

Slock 对 Claude busy delivery 做了 runtime-specific gate。原因是 Claude stream-json 在 signed thinking block 或 tool batch 中途写入新 user message，可能破坏协议边界。

WM 第一阶段可以不做 turn 中实时注入，但必须做到：

- idle 状态可以 stdin 投递。
- busy 状态排队，不直接写 stdin。
- turn_end 后复用同一 Claude process 继续处理 queued message。
- 后续要做实时 steering 时，必须按 Slock 的 gated 机制做，而不是直接写。

## Codex Driver 详细分析

Slock Codex 和 WM 当前方向比较接近，都是 app-server JSON-RPC。

### Slock 实现

Slock 启动：

```text
codex app-server --listen stdio://
  -c mcp_servers.chat.command="node"
  -c mcp_servers.chat.args=[chat-bridge.js, ...]
  -c mcp_servers.chat.enabled=true
  -c mcp_servers.chat.required=true
```

然后通过 JSON-RPC：

- initialize
- thread/create 或 thread/resume
- turn/start
- turn/steer

启动参数里会传：

- `cwd`
- `model`
- `approvalPolicy: "never"`
- `sandbox: "danger-full-access"`
- `developerInstructions` / standing prompt
- MCP chat bridge config

### 对 WM 的启发

WM Codex adapter 已经是最接近 Slock 的部分。需要重点补齐：

- model detection 不应固定 `gpt-5.5`。Codex CLI 实际可以选择模型，应从 Codex config/cache/CLI 能力读取。
- persistent adapter 不应每个 turn destroy client。
- busy 时如果 app-server 支持 steer，应作为后续增强；第一版至少 queue 到当前 turn end。
- prompt 里必须强调通过平台 message/thread 协作，不要用本地状态代替其他 agent 回答。

## Cursor Driver 详细分析

Slock Cursor 不是 ACP 常驻，而是 CLI print 模式 per-turn。

### Slock 实现

Slock spawn：

```text
cursor-agent
  --print
  --output-format stream-json
  --yolo
  --approve-mcps
  --trust
  [--model <model>]
  [--resume <sessionId>]
  <prompt>
```

特点：

- 每次具体消息 spawn 一个 process。
- 输出 stream-json。
- session id 用于 resume。
- MCP 通过 `.cursor/mcp.json` 配置。
- 不通过 stdin 做后续消息实时投递。

### 模型检测

Slock 读取 `cursor-agent models` 输出。本机截图显示 Cursor 有 18 个模型，包括 Composer、GPT-5.5、Codex 5.3、GPT-5.4、Gemini 3.1 Pro 等。

WM 之前显示 Cursor 只能换 Claude sonnet / GPT-5.5，说明我们的检测结果来自 fallback 或脏数据，不是本机 Cursor CLI 实际模型列表。

对 WM 的要求：

- `cursor-agent models` stdout/stderr 都要解析。
- 如果遇到 workspace trust prompt，测试/检测时要使用受信目录或明确返回检测失败，不能用假模型。
- Server 保存 machine metadata 时要区分检测时间、source、error。
- Web 只能显示 daemon 上报的真实 list；没有 list 就 disabled default。

## Gemini Driver 详细分析

Slock Gemini 用 Gemini CLI stream-json per-turn，不是当前 WM 的 ACP 常驻路径。

### Slock 实现

Slock spawn：

```text
gemini
  --output-format stream-json
  --yolo
  -p ""
  [--model <model>]
  [--resume <sessionId>]
```

prompt 通过 stdin 送入。

环境上，Slock 会处理 workspace trust：

```text
GEMINI_CLI_TRUST_WORKSPACE=true
```

### 模型语义

本机 Gemini CLI UI 显示 `/model` 可选：

- Auto (Gemini 3)
- Auto (Gemini 2.5)
- Manual (gemini-3.1-pro-preview)

并提示可用 `--model` 在启动时指定模型。

所以“Gemini 不能选模型”的早期结论不完整。更准确的结论是：

- Gemini CLI 支持启动参数 `--model`。
- 但可枚举模型列表未必有稳定非交互 API。
- 如果 daemon 能通过配置/inspect/命令稳定拿到列表，可以显示；拿不到就 disabled default。
- 不能硬编码假列表。

## OpenCode Driver 详细分析

Slock 支持 OpenCode，但不是 ACP adapter。

### Slock 实现

Slock spawn：

```text
opencode run
  --format json
  --dangerously-skip-permissions
  --pure
  --dir <workspace>
  [--model <model>]
  --agent slock
  [--session <sessionId>]
  -- <turnPrompt>
```

它通过 `OPENCODE_CONFIG_CONTENT` 注入配置，合并用户 opencode config、Slock agent 定义、MCP chat bridge。

特点：

- Slock 设置了版本 gate，要求 OpenCode >= 1.14.30。
- 生命周期偏 per-turn / turn-end terminate。
- session id 用于 resume。
- model detection 走 `opencode models`。

### 对 WM 的要求

如果 WM 目标是“OpenCode 也支持长时运行”，不能简单说“参考 Slock 就能常驻”。Slock 的 OpenCode 支持更像 session-resume per-turn。WM 有两个选择：

1. Slock parity：用 `opencode run` per-turn + session resume，稳定优先。
2. WM persistent target：继续探索 ACP/stdio 常驻，但要用长时运行测试证明 pid/session 多轮存活。

当前产品已经在推进“所有 runtime 长时运行”，因此文档和测试必须明确：OpenCode 的 WM 行为是产品增强，不是 Slock 原样。

## Kimi 和 Copilot

Slock 支持 Kimi 和 Copilot，但当前 WM 尚未列入用户这轮必须支持范围。

### Kimi

Slock Kimi 是常驻 wire protocol：

```text
kimi
  --wire
  --yolo
  --agent-file <agentFile>
  --mcp-config-file <mcpConfig>
  --session <sessionId>
  [--model <model>]
```

它写 `.slock-kimi-agent.yaml`、`.slock-kimi-mcp.json`，通过 JSON-RPC/wire 做 initialize 和 prompt/steer。

### Copilot

Slock Copilot 是 per-turn：

```text
copilot
  --output-format json
  --allow-all-tools
  --allow-all-paths
  --additional-mcp-config @<path>
  -p <prompt>
  [--model <model>]
  [--effort <effort>]
  [--resume=<sessionId>]
```

如果后续 WM 要补 Kimi/Copilot，应按 Slock driver 单独实现，不要塞进通用 ACP adapter。

## Hermes 现状与必须自研点

Hermes 不在 Slock adapter 列表中，所以只能根据本机 CLI 行为做。

### 当前 WM 问题

WM 当前 Hermes adapter：

```ts
new AcpAdapter({
  runtime: "hermes",
  command: "hermes",
  args: ["acp", "--accept-hooks"],
})
```

通用 ACP adapter 会在有 model 时追加：

```text
--model <model>
```

本机日志已经证明这是错的：

```text
hermes: error: unrecognized arguments: --model deepseek-v4-flash
```

本机 `hermes model` UI 显示：

- Current model: `deepseek-v4-flash`
- Active provider: `custom:llm-gateway.example.com`
- provider 里可 fetch 到 11 个模型
- Hermes CLI usage 显示模型参数是 `-m MODEL`，并支持 `--provider PROVIDER`

### Hermes 模型策略

Hermes 配置可能是：

```yaml
custom_providers:
  - name: Internal LLM Gateway
    base_url: https://llm-gateway.example.com/v1
    api_key: ...
    model: deepseek-v4-flash
```

这类配置只声明默认 model，不一定列出所有 provider 模型。Hermes CLI 可以联网 fetch provider models，但这会依赖 provider 可用性和 api key。

建议策略：

1. 默认安全路径：只从 config 读取 active/default model，显示为唯一 selectable model。
2. 增强路径：调用 `hermes model` 或等价非交互命令获取 provider models；如果命令没有稳定 machine-readable 输出，则只在检测成功时展示，失败时回退默认 model。
3. 启动参数：不要用 `--model`。优先实测 `hermes acp -m <model>` 是否支持；如果 ACP 子命令不支持 `-m`，则需要用 env/config 临时注入或改用 Hermes 非 ACP runtime path。
4. provider 选择：如果模型来自 custom provider，启动时需要带 `--provider custom:<name-normalized>` 或按 Hermes CLI 实测格式传入。

Hermes 必须写独立 adapter，不应继续复用默认 `modelArgs(... "--model")`。

## WM 当前实现差异

### 1. 通用 ACP 抽象过度

当前 `AcpAdapter` 默认：

- command + args
- initialize
- session/new 或 session/load
- session/prompt
- model 统一追加 `--model`

这个抽象适合“真的 ACP-compatible 且参数兼容”的 runtime，但不适合：

- Hermes：模型参数不是 `--model`。
- OpenCode：Slock 用 `opencode run`，不是 `opencode acp`。
- Cursor/Gemini：Slock 用 stream-json/per-turn CLI，WM 用 ACP，行为已不一致。

应该改成：

- `modelArgs` 从 adapter config 函数化：`buildArgs(input) => string[]`。
- 每个 runtime 显式声明 lifecycle 和 model launch spec。
- 每个 runtime 单测覆盖真实 CLI args。

### 2. Claude 参数不完整

当前 Claude 失败直接暴露在日志里：

```text
--output-format=stream-json requires --verbose
Claude stream-json session timed out
```

修复不是只加一个 `--verbose`。要完整对齐 Slock：

- `--verbose`
- `--permission-mode bypassPermissions`
- `--allow-dangerously-skip-permissions`
- `--dangerously-skip-permissions`
- disallowed tools
- system prompt file
- MCP config 或至少 WM wrapper command prompt 对齐
- process early exit 立即 fail，不等 prompt timeout
- busy delivery queue/gate

### 3. 状态收敛不够强

长时运行测试里 Claude/Hermes 已经出现：

- start 返回后实际 process 很快退出。
- diagnostic 里 pid 为空或状态不一致。
- server/web 可能还显示 idle/running。

需要：

- `onExit` 立刻更新 runtime session state。
- 如果 process 在 start window 内退出，start API 应返回失败或明确 runtime_error。
- diagnostic 必须区分 `running_process_missing`、`last_exit_code`、`last_stderr`。
- stop 后旧 launch event 不得恢复 running。

### 4. 模型列表来源不可信

之前 UI 出现：

- Codex 被固定 `gpt-5.5`，但 Codex CLI 实际可选模型。
- Cursor 显示 Claude sonnet / GPT-5.5，和本机 `cursor-agent models` 不一致。
- Hermes 显示 kimi 模型，但本机 Hermes provider 是自建网关/deepseek。

这说明 machine metadata 里存在 fallback、旧缓存或错误 parser 结果。

必须做到：

- runtime model result 带 `source`、`detectedAt`、`error`、`selectable`。
- Web 只显示当前 machine 最新 detection result。
- detection 失败时显示失败原因，不用其它 runtime 的 fallback。
- 创建 agent 时 server 重新校验 model 属于对应 runtime result，不能只信前端。

## 建议实现路线

### Phase 1: Adapter Capability Metadata

新增 driver metadata，而不是继续扩张 `AcpAdapter`：

```ts
interface RuntimeDriverCapability {
  runtime: RuntimeId;
  lifecycle: "persistent" | "per_turn";
  stdinDelivery: "none" | "direct" | "gated";
  busyDelivery: "queue" | "steer" | "gated";
  terminateOnTurnEnd: boolean;
  supportsResume: boolean;
  modelLaunch: "none" | "fixed" | "flag" | "custom";
}
```

Server/Web 可以基于 capability 展示更真实的信息：

- 支持长时运行
- 支持 busy delivery
- 模型是否 selectable
- 是否需要 provider/auth/trust

### Phase 2: Claude 对齐 Slock

优先修 Claude，因为它最明确、Slock 可直接参考：

- 改 `claudeCliArgs()` 对齐 Slock 参数。
- 确保不使用 one-shot `--print`。
- start 后等待 first `system:init` 或 runtime_started；如果 process 提前退出，立即失败。
- prompt 写 stream-json user message。
- busy 消息先 queue 到 turn_end；后续再实现 Slock gated delivery。
- 单测用 fake Claude process 覆盖：
  - args 包含 `--verbose`
  - 两轮 prompt 复用同 pid
  - early stderr + exit 不等待 timeout
  - stop kill process

### Phase 3: Hermes 独立 Adapter

Hermes 不能再直接继承默认 `AcpAdapter`。

需要先实测并固化：

- `hermes acp -m <model>` 是否有效。
- `hermes acp --provider <provider> -m <model>` 是否有效。
- Hermes ACP 是否支持多轮 `session/prompt` 长时运行。

实现：

- `HermesAdapter` 自己构建 args。
- detection 读取 config 的 provider/model。
- 可选增强调用 Hermes model list 命令。
- launch payload 保存 `{ provider?, model }`，而不是只有 model string。
- 单测覆盖 `custom_providers[].model`、`models[]`、provider-qualified model。

### Phase 4: Cursor/Gemini/OpenCode 明确策略

这里要先做产品决策：

- 如果目标是 Slock parity：Cursor/Gemini/OpenCode 用 per-turn/session-resume，稳定性优先。
- 如果目标是 WM long-running all runtimes：保留 ACP 常驻探索，但要承认这是 WM 自己的增强，不是 Slock 现成实现。

无论选哪条，都必须：

- 每个 runtime 有真实 CLI args 单测。
- 每个 runtime 有 5 分钟短 soak。
- 每个 runtime 有模型检测 test。
- diagnostic 记录 pid/session/launch/model/cwd。

### Phase 5: Long-running Acceptance

短测要求：

- 支持 runtime：Codex、Claude、Cursor、Gemini、Hermes、OpenCode。
- 每个 agent 启动后每 60 秒发一条 message，持续 5 分钟。
- 验证：
  - pid 是否符合 lifecycle 预期。
  - workspace 目录唯一且正确。
  - daemon log 有 launchId/model/cwd/pid。
  - server 状态 working -> idle 不回弹。
  - stop 后 pid 消失。

长测要求：

- 每 5 分钟发一条 message，持续 1 小时。
- 验证内存、pid、lastRuntimeEventAt、message delivery、thread reply、diagnostic。

注意：如果某 runtime 按 Slock 语义是 per-turn，那么验收不能要求 pid 一小时不变；要验收 session continuity 和消息可持续处理。只有 WM 明确选择“全 runtime 常驻”时，才要求 pid 不变。

## 文档对后续实现的硬约束

1. Claude 直接按 Slock stream-json 常驻实现，不再走 SDK one-shot 作为主路径。
2. Hermes 单独实现，不再用默认 `--model` 参数。
3. runtime model list 必须来自 daemon 当前检测结果，不能跨 runtime fallback。
4. workspace path 必须以 unique id 隔离，display name 只用于 UI 和 mention。
5. adapter state 必须由 daemon process/session 事实驱动，server 不猜 runtime 是否 alive。
6. 如果 WM 选择“所有 runtime 长时运行”，必须在设计文档里明确这是超出 Slock parity 的产品增强，并用 soak test 证明。

