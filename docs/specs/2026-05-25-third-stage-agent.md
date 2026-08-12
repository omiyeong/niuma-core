# 第三阶段 Agent：从聊天工具到常驻工作角色

## 一句话判断

Agent 不是一个被打开的工具，而是一个被授权的工作角色。

第三阶段 Agent 的核心变化，不是模型更强，也不是聊天框更好，而是 Agent 的存在方式变了：从用户主动打开、主动提问、主动派活，变成在真实工作流中常驻、接收事件、按权限边界主动处理。

## 三个阶段

### 第一阶段：Chat Agent

代表形态是 ChatGPT 式聊天框。

用户打开对话窗口，输入问题，AI 给出回答。核心交互是 prompt，核心价值是语言理解、知识问答、内容生成和思考辅助。这个阶段里，AI 是一个被动的对话对象。

判断标准：

- 用户必须主动打开入口。
- 用户必须明确提出问题。
- AI 的主要产物是回答，而不是完成外部动作。

### 第二阶段：Work Agent

代表形态是 Claude Code、Codex、Cursor Agent 等执行型 agent。

用户仍然主动发起任务，但 agent 不再只是回答，而是能读文件、改代码、运行命令、安装依赖、调用工具、操作浏览器或虚拟电脑。AI 从“给建议”进化成“完成任务”。

判断标准：

- 用户主动派发任务。
- Agent 拥有本地或远程执行环境。
- Agent 能直接改变文件、系统、代码库或外部服务状态。
- 人主要负责提出目标、确认风险和验收结果。

### 第三阶段：Ambient Agent / Event Agent

代表形态是常驻 agent、OpenClaw 类本地 agent、Claude Code 高阶多 agent 工作流，以及我们正在做的 daemon + 飞书代办。

Agent 不再只等人来问，而是作为一个被授权的工作角色，常驻在用户或团队的工作流中。它监听事件源，读取上下文，判断是否需要处理，能处理就处理，不能处理就升级给人。

判断标准：

- Agent 有长期身份、owner、职责、workspace、memory 和权限边界。
- Agent 通过事件源被唤醒，而不只通过聊天框被唤醒。
- Agent 能主动创建任务、草拟回复、检查异常、升级风险。
- 高风险动作进入 inbox，由人确认后继续执行。
- 所有动作可追踪、可审计、可回放。

## 第三阶段的关键能力

### 1. Identity

Agent 必须从“一次会话”变成“一个角色”。

它需要稳定的身份：名字、职责、owner、所属 space、绑定的 machine、默认 runtime、权限模式、可监听的入口和可操作的资源范围。

没有身份，agent 只是一次 prompt；有身份，agent 才能承担持续职责。

### 2. Event Gateway

第三阶段的入口不是单一聊天框，而是事件网关。

事件可以来自：

- 平台 Channel / DM / Thread。
- 飞书消息、群聊、审批和日历。
- GitHub issue、PR、CI、release。
- Linear、Jira、客户工单、邮件。
- 文件变化、日志、告警、定时任务。

事件网关负责把外部事件转成平台内部可审计的任务、消息或 inbox item。

### 3. Context Store

常驻 agent 必须有持续上下文。

上下文至少包括：

- Agent 的长期记忆和职责说明。
- 最近处理过的消息、任务和失败记录。
- 已读/已处理的外部 message id，避免重复处理。
- 当前等待用户确认的事项。
- 与其他 agent 或 human 的协作 thread。

上下文不能只依赖模型上下文窗口，必须落到可恢复的 storage 中。

### 4. Policy / Permission

第三阶段不是让 agent 无限制自治。

合理口径是：

- 低风险动作自动执行。
- 中风险动作先草拟，再进入 inbox。
- 高风险动作必须请求确认。
- 不支持结构化权限事件的 runtime，不能伪装成支持确认闭环。

权限系统不是附属功能，而是第三阶段 agent 能被信任的前提。

### 5. Action Runtime

第三阶段并不替代第二阶段 agent，而是把第二阶段 agent 放进常驻运行时。

底层执行仍然可以是：

- Codex
- Claude Code
- Kimi
- Gemini
- Cursor Agent
- OpenCode
- 未来其他 runtime

平台的价值在于把这些 runtime 包装成稳定角色：能被唤醒、能接收事件、能执行动作、能回写状态、能被审计。

### 6. Audit / Feedback

主动 agent 必须可审计。

平台需要记录：

- 为什么被唤醒。
- 使用了哪些输入和上下文。
- 调用了哪些工具。
- 做了哪些外部动作。
- 哪些动作经过了用户确认。
- 最终结果是什么。

如果 agent 做事不可追踪，第三阶段就会变成黑箱自动化。

## 我们当前产品的位置

我是牛马不是“多 agent 聊天平台”，而是“给每个人和每个团队配置常驻工作角色的平台”。

当前架构已经具备第三阶段雏形：

```text
Human / External System
        ↓
Event Gateway: Channel、DM、Thread、飞书、定时器、Webhook
        ↓
Workspace Server: 身份、权限、任务、Inbox、审计、路由
        ↓
WM Daemon: 常驻执行器、本机 workspace、runtime adapter
        ↓
Runtime Agent: Codex / Claude / Kimi / Gemini / others
        ↓
Action: 回复消息、改文件、跑命令、创建任务、请求确认
```

Server 是状态 owner，Daemon 是本机 executor，Runtime Agent 是具体执行脑。这个边界和第三阶段判断一致。

## 飞书代办为什么重要

飞书代办虽然是一个小场景，但它验证的是第三阶段最核心的链路：

```text
外部消息
  -> daemon 常驻监听/轮询
  -> agent 读取上下文
  -> 生成回复草稿或执行动作
  -> inbox 确认
  -> 回写飞书
  -> 平台留下审计记录
```

它证明 agent 可以不依赖用户打开平台提问，而是接入真实工作流，在用户授权边界内主动工作。

这不是“飞书机器人功能”，而是“常驻工作角色”的第一个具体表面。

## 两个核心场景

### 场景一：A 找 B / B-agent 协作升级

A 或 A-agent 在平台找 B-agent。B-agent 先查自己的 workspace、memory、历史 thread 和本地上下文。

如果 B-agent 能回答，就直接通过平台 thread 回复。如果不能回答，或者需要真人权限，就通过 B 的飞书找 B 真人，再把 B 的回复汇总回平台。

这个场景验证：

- Agent 优先解决，不默认打扰真人。
- Agent 解决不了时能升级到真人。
- 外部飞书只是升级渠道，不替代平台 thread。
- 协作过程可追踪。

### 场景二：B 飞书代理模式

B 授权 B-agent 代管飞书消息。Daemon 定时或事件驱动唤醒 B-agent，B-agent 拉取最近飞书消息，结合本地上下文判断如何处理。

能直接处理的，生成回复草稿或在授权后发送；不确定或高风险的，进入平台 inbox 等待确认。

这个场景验证：

- Agent 可以常驻处理外部消息。
- Server 不直接处理业务语义，只保存绑定、状态、任务和审计。
- Daemon 和 runtime 承担真实处理。
- Inbox 是主动 agent 的安全边界。

## 产品原则

1. Agent 是工作角色，不是聊天窗口。
2. Chat 是入口之一，不是产品本体。
3. Event Gateway 比单一 composer 更重要。
4. 默认主动，但必须分级授权。
5. 低风险自动做，高风险问人。
6. 外部系统从哪里来，就优先回到哪里去。
7. 所有主动行为都必须可审计。
8. 不把 runtime 能力伪装成平台能力。
9. Server 管状态，Daemon 管执行，Runtime 管思考和动作。
10. 用户不是被 agent 替代，而是给 agent 授权、设边界、做裁决。

## 后续讨论问题

下一阶段需要继续明确：

- 一个 agent 的职责边界如何定义？
- 一个 agent 应该监听哪些事件源？
- 哪些动作默认自动执行，哪些必须进 inbox？
- Agent 主动工作后，如何避免噪音和打扰？
- 多 agent 之间如何协作，如何防止循环聊天？
- 外部系统消息如何去重、归因和回放？
- 用户如何看到 agent 今天主动做了什么？
- 团队空间里，谁能授权 agent 接入哪些系统？
- Agent 的 memory 应该分哪些层：个人、项目、space、machine、runtime？
- 如何把飞书代办扩展到 GitHub、CI、邮件、日历和工单？

## 外部参考

- OpenClaw 被描述为运行在本地硬件上的 agent，连接文件、终端、浏览器和消息应用，并通过用户已有聊天表面控制：<https://www.techradar.com/pro/what-is-openclaw>
- O'Reilly 对 OpenClaw 的观察强调 persistent memory 和 agent 成为 workflow 的 active participant：<https://www.oreilly.com/radar/what-openclaw-reveals-about-the-next-phase-of-ai-agents/>
- Claude Code 创作者工作流的报道显示，高阶用户已经在使用多 agent、长期运行和异步工作方式：<https://tech.yahoo.com/articles/claude-codes-creator-says-setup-091701435.html>
- Axios 对 agent 竞赛的观察强调企业需要明确限制 agent 能访问的系统和任务边界：<https://www.axios.com/2026/03/23/openclaw-agents-nvidia-anthropic-perplexity>

