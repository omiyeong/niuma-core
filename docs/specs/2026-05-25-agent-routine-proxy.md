# Agent Routine / 代理职责规格

## 一句话定义

代理是某个 Human 授权给某个 Agent 的常驻职责。

它不是传统工作流，也不是一次性聊天任务。用户表达的是“以后这类事情你替我盯着、判断、处理”，平台把这份授权固化成可运行、可暂停、可审计的 routine。

第一版只实现飞书消息代理，但字段模型必须能扩展到 GitHub issue、邮件、日历、告警、Webhook 和平台事件。

## 为什么不叫工作流

工作流的心智是用户搭流程：

```text
trigger -> node -> node -> agent -> action
```

代理的心智是用户任命职责：

```text
某个人 -> 授权某个 agent -> 长期负责某类外部事件 -> 按边界处理
```

前台产品不应强调节点画布，而应强调：

- 代表谁
- 谁执行
- 监听什么
- 多久检查一次
- 能自动做什么
- 哪些必须确认
- 最近做了什么

底层可以有 trigger、schedule、policy、state，但这些是实现细节。

## 产品入口

### Web 展示

Web 上统一叫“代理”。

Human 详情页新增代理列表：

```text
张三
├─ 飞书消息代理
│  Agent: kimi-01
│  状态: 运行中
│  策略: 草稿待确认
│  频率: 5 分钟
│  最近运行: 2 分钟前
│
└─ GitHub issue 代理
   Agent: codex-01
   状态: 暂未启用
```

同一个代理也应能在 Agent 详情页反向展示：

```text
kimi-01 的代理职责
├─ 代表 张三 处理飞书消息
```

Human 视角回答“我有哪些分身在工作”。Agent 视角回答“这个 agent 被授权做哪些长期职责”。

### 创建入口

第一版不优先做 Web 工作流编辑器。主入口是 Agent 对话：

```text
我要让你监控我的飞书消息，并帮我完成答复，待我在平台确认后就发送。
```

Agent 识别这是创建代理职责，调用 routine skill 生成草案。用户确认后，平台创建 routine。

Web 后续可以提供表单编辑，但它应该是职责配置表单，不是节点画布。

## 标准数据模型

Routine 是通用模型。飞书只是第一种 routine type。

```ts
type RoutineStatus = "draft" | "enabled" | "paused" | "error" | "archived";

interface AgentRoutine {
  id: string;
  space_id: string;

  owner_human_id: string;
  agent_id: string;
  created_by_human_id: string;

  name: string;
  type: RoutineType;
  status: RoutineStatus;
  description?: string;

  trigger: RoutineTrigger;
  schedule?: RoutineSchedule;
  source: RoutineSource;
  instruction: RoutineInstruction;
  policy: RoutinePolicy;
  output: RoutineOutput;
  state: RoutineState;

  created_at: number;
  updated_at: number;
}
```

### Type

```ts
type RoutineType =
  | "feishu_message_proxy"
  | "github_issue_triage"
  | "email_reply_draft"
  | "calendar_followup"
  | "alert_triage"
  | "webhook_handler";
```

第一版只启用 `feishu_message_proxy`。其他类型只作为字段设计边界，不实现。

### Trigger

```ts
interface RoutineTrigger {
  kind: "poll" | "webhook" | "event" | "manual";
  source: "feishu" | "github" | "email" | "calendar" | "alert" | "platform" | "webhook";
}
```

飞书第一版：

```ts
{
  kind: "poll",
  source: "feishu"
}
```

### Schedule

```ts
interface RoutineSchedule {
  interval_seconds?: number;
  lookback_seconds?: number;
  timezone?: string;
  quiet_hours?: Array<{ start: string; end: string }>;
}
```

飞书第一版继续使用 interval 轮询。默认值：

```ts
interval_seconds = 300
lookback_seconds = interval_seconds + 60
```

### Source

```ts
interface RoutineSource {
  account_ref?: string;
  binding_human_id?: string;
  filters?: Record<string, unknown>;
}
```

飞书第一版：

```ts
{
  binding_human_id: owner_human_id,
  filters: {
    include_chats: [],
    exclude_chats: [],
    include_group_chats: true,
    include_direct_chats: true
  }
}
```

飞书绑定流程后续可以优化成二维码授权：用户说“绑定飞书 CLI”，平台弹二维码，用户扫码授权完成绑定。第一版不强制完成这件事，仍可沿用现有 app id / app secret / OAuth 方式。

### Instruction

```ts
interface RoutineInstruction {
  goal: string;
  scope: string;
  handling_rules: string[];
  escalation_rules: string[];
}
```

飞书代理示例：

```ts
{
  goal: "监控飞书消息并生成回复草稿",
  scope: "只处理需要 owner 本人回复的消息",
  handling_rules: [
    "忽略机器人、自发消息、系统消息",
    "判断消息是否需要 owner 回复",
    "需要回复时结合平台上下文生成草稿",
    "同一 feishu_message_id 只能处理一次"
  ],
  escalation_rules: [
    "所有飞书发送动作必须进入平台确认",
    "涉及承诺、权限、价格、合同、删除、生产操作时必须等待 owner 确认"
  ]
}
```

### Policy

```ts
interface RoutinePolicy {
  action_mode: "draft_only" | "auto_low_risk" | "manual_only";
  approval_required_for: string[];
  forbidden_actions: string[];
  max_runs_per_hour?: number;
  max_items_per_run?: number;
  max_thread_turns?: number;
  dedupe_key?: string;
}
```

飞书第一版固定为：

```ts
{
  action_mode: "draft_only",
  approval_required_for: ["send_external_message"],
  forbidden_actions: ["direct_send_without_approval"],
  max_items_per_run: 20,
  dedupe_key: "feishu_message_id"
}
```

第一版不允许 agent 直接发送飞书消息。发送必须由 inbox 草稿确认触发。

### Output

```ts
interface RoutineOutput {
  primary: "inbox" | "external_reply" | "platform_thread" | "task";
  inbox_type?: "feishu_draft" | "confirmation_request" | "permission_request";
  audit_channel_id?: string;
}
```

飞书第一版：

```ts
{
  primary: "inbox",
  inbox_type: "feishu_draft"
}
```

### State

```ts
interface RoutineState {
  last_run_at?: number;
  last_success_at?: number;
  last_error?: string;
  consecutive_failures: number;
  cursor?: Record<string, unknown>;
  dedupe?: Record<string, unknown>;
}
```

飞书代理需要记录：

- chat watermark
- 已处理 message id
- chat session id
- 连续失败次数

这些 state 属于 routine，不应散落在 prompt 或临时文件里。Daemon 可以保留本地 cache，但 Server 侧必须有可恢复的状态 owner。

## Routine Skill

Routine skill 是让 agent 创建和维护代理职责的能力。

它不是飞书 skill，也不是执行 routine 的调度器。它负责把自然语言委托转换成结构化 RoutineSpec，并调用平台命令创建或更新 routine。

### Skill 职责

1. 识别用户是否在创建、修改、暂停、恢复代理职责。
2. 判断 routine type。
3. 检查必要条件，例如飞书绑定、目标 agent、runtime 是否支持。
4. 缺参数时向用户反问。
5. 生成代理职责草案。
6. 等用户确认。
7. 调用平台命令创建或更新 routine。

### 平台命令草案

```bash
wm routine create --spec <json>
wm routine list
wm routine get --id <id>
wm routine update --id <id> --spec <json>
wm routine pause --id <id>
wm routine resume --id <id>
wm routine archive --id <id>
```

第一版可以只实现 create/list/get/pause/resume/archive。update 可以后置。

### 创建确认草案

用户说：

```text
我要让你监控我的飞书消息，并帮我完成答复，待我在平台确认后就发送。
```

Agent 应生成：

```text
即将创建代理：飞书消息代理

代表谁：张三
执行 Agent：kimi-01
监听来源：张三的飞书消息
频率：每 5 分钟
处理方式：读取新消息，判断是否需要回复，生成回复草稿
发送策略：必须在平台确认后发送
禁止：未经确认直接回复飞书
去重：按飞书 message_id
记录：写入 inbox、activity 和 run audit

确认创建吗？
```

用户确认后才创建。Routine 是长期授权，不允许 agent 静默创建。

## Daemon 执行模型

当前飞书代办逻辑在 daemon 中硬编码：

```text
feishu:delegation:start
  -> 写 token / 注入 lark skill
  -> setInterval
  -> fetchFeishuCandidates
  -> buildFeishuChatWakeMessage
  -> enqueueStart(agent)
```

Routine 化后应变成：

```text
routine:start
  -> 按 routine.type 选择 executor
  -> 准备 source token / wrapper / skill
  -> 按 trigger/schedule 拉事件
  -> 标准化事件
  -> 构造 routine wake message
  -> 唤醒 agent
```

第一版可以保留内部 Feishu executor，不急着做插件化 executor。协议层先从 `feishu:delegation:*` 收敛到 `routine:*`，或先让 routine 包一层兼容现有 delegation 实现。

## 飞书第一版行为

`feishu_message_proxy` 的第一版行为保持保守：

1. Daemon 定时读取最近窗口内的飞书消息。
2. 过滤机器人、自发消息、系统消息、已处理 message id。
3. 按 chat 分组唤醒 agent。
4. Agent 判断哪些消息需要回复。
5. Agent 只创建 `feishu_draft` inbox item。
6. 用户在平台确认后，平台/daemon 执行单次发送。
7. 发送完成后写回 sent message id。
8. 不允许 scheduled tick 直接发送飞书消息。

## Web 第一版

Human 详情页新增代理列表。

每个代理显示：

- 名称
- 执行 Agent
- 状态
- 类型
- 频率
- 策略
- 最近运行
- 连续失败次数
- 操作：暂停、恢复、归档、查看详情

代理详情显示：

- 基础信息
- 监听来源
- 处理规则
- 确认策略
- 最近 runs
- 最近 inbox 草稿
- 最近错误

第一版创建仍可以通过 agent 对话完成；Web 可以只展示和管理。

## 与现有 human_delegations 的关系

现有 `human_delegations` 是 `feishu_message_proxy` 的特化版本：

```text
human_id
delegate_agent_id
medium = feishu
enabled
interval_seconds
last_wake_at
last_success_at
feishu_channel_id
```

迁移方向：

```text
human_delegations -> agent_routines
```

第一版实现可以选择两条路：

1. 保留 `human_delegations` 表，新增 routine API 时内部映射到它。
2. 新增 `agent_routines` 表，把现有 delegation 迁移为 routine。

推荐第二条。否则后续 GitHub/email/calendar 会继续被 Feishu 命名拖住。

## 不做什么

第一版明确不做：

- 不做节点画布。
- 不做通用 workflow builder。
- 不做多个 trigger 组合。
- 不做自动直接发送飞书消息。
- 不做 GitHub/email/calendar/webhook 的真实 executor。
- 不做跨 agent 自动委托。
- 不让不支持飞书代理的 runtime 出现在可选执行 agent 列表里。
- 不把 app id / secret 展示给不该看到的人。

## 成功标准

第一版完成后，应满足：

1. 用户可以通过 agent 对话创建一个飞书消息代理。
2. 创建前会展示结构化职责草案，并等待用户确认。
3. Human 详情页能看到代理列表。
4. 代理能使用现有飞书绑定和 daemon 轮询能力。
5. Daemon 按 routine 配置唤醒 agent。
6. Agent 只生成 inbox 草稿，不直接发送。
7. 用户确认后只发送一条飞书回复。
8. Routine 的运行、失败、草稿、发送结果都可审计。
9. 字段模型不被飞书绑死，可扩展到后续事件源。

