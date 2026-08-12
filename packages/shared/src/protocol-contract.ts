import type {
  RuntimeKind,
  AppGetHistoryPayload,
  AppInterruptPayload,
  AppListPathsPayload,
  AppListSessionsPayload,
  AppListAgentCommandsPayload,
  AppRunCommandPayload,
  AppGetSessionStatusPayload,
  BridgeAgentCommandsPayload,
  BridgeHeartbeatPayload,
  BridgeCommandResultPayload,
  AppSendMessagePayload,
  BridgePathListPayload,
  BridgeSessionStatusPayload,
  BridgeSessionHistoryPayload,
  BridgeSessionInitPayload,
  BridgeSessionListPayload,
  MessageType,
} from "./protocol";

const agent: RuntimeKind = "codex";
const pathMessage: MessageType = "app:list_paths";
const pathReply: MessageType = "bridge:path_list";
const commandListMessage: MessageType = "app:list_agent_commands";
const commandListReply: MessageType = "bridge:agent_commands";
const runCommandMessage: MessageType = "app:run_command";
const commandResultReply: MessageType = "bridge:command_result";
const sessionStatusReply: MessageType = "bridge:session_status";

const sendPayload: AppSendMessagePayload = {
  agent,
  cwd: "~/project",
  text: "hello",
  attachments: [
    {
      type: "image",
      mime_type: "image/jpeg",
      data_base64: "ZmFrZQ==",
      filename: "photo.jpg",
      width: 1024,
      height: 768,
    },
  ],
};

const interruptPayload: AppInterruptPayload = {
  agent: "claude",
  session_id: "session-id",
};

const listSessionsPayload: AppListSessionsPayload = {
  agent,
  cwd: "~/project",
  limit: 10,
};

const historyPayload: AppGetHistoryPayload = {
  agent,
  session_id: "session-id",
};

const listPathsPayload: AppListPathsPayload = {
  path: "~",
};

const listCommandsPayload: AppListAgentCommandsPayload = {
  agent,
  session_id: "session-id",
};

const runCommandPayload: AppRunCommandPayload = {
  agent,
  session_id: "session-id",
  cwd: "~/project",
  command: "/status",
};

const getStatusPayload: AppGetSessionStatusPayload = {
  agent,
  session_id: "session-id",
};

const heartbeatPayload: BridgeHeartbeatPayload = {
  bridge_id: "mac-mini",
  name: "Mac mini",
  ai_employees: ["claude", "codex"],
  active_session_count: 2,
  running_session_count: 1,
};

const initPayload: BridgeSessionInitPayload = {
  agent,
  session_id: "session-id",
  cwd: "~/project",
  directory_name: "project",
  repo_root: "~/project",
  git_branch: "develop",
  model: "codex",
  reasoning: "medium",
  context_window: 128000,
  context_used: 12000,
  context_left_percent: 91,
  tools: [],
  permission_mode: "default",
  is_resume: false,
};

const statusPayload: BridgeSessionStatusPayload = {
  agent,
  session_id: "session-id",
  run_state: "running",
  last_activity_at: Date.now(),
  current_turn_id: "turn-id",
  status_label: "Thinking",
  model: "codex",
  reasoning: "medium",
  context_window: 128000,
  context_used: 12000,
  context_left_percent: 91,
  cwd: "~/project",
  directory_name: "project",
  repo_root: "~/project",
  git_branch: "develop",
};

const sessionListPayload: BridgeSessionListPayload = {
  sessions: [
    {
      agent,
      session_id: "session-id",
      summary: "summary",
      title: "AI title",
      last_modified: Date.now(),
      last_used_at: Date.now(),
      cwd: "~/project",
      absolute_cwd: "/Users/example/project",
      directory_name: "project",
      repo_root: "/Users/example/project",
      git_branch: "develop",
      turn_count: 4,
      metadata_state: "ready",
    },
  ],
};

const commandList: BridgeAgentCommandsPayload = {
  agent,
  session_id: "session-id",
  commands: [
    {
      name: "/status",
      description: "Show current session status",
      executable: true,
    },
    {
      name: "/compact",
      description: "Not available through Codex app-server",
      executable: false,
      unsupported_reason: "unsupported_by_provider",
    },
  ],
};

const commandResult: BridgeCommandResultPayload = {
  agent,
  session_id: "session-id",
  command: "/status",
  status: "success",
  message: "codex · Context 91% left",
  status_payload: statusPayload,
};

const historyReply: BridgeSessionHistoryPayload = {
  agent,
  session_id: "session-id",
  items: [],
};

const pathList: BridgePathListPayload = {
  path: "/Users/example",
  parent: "/Users",
  directories: [{ name: "project", path: "/Users/example/project" }],
};

void [
  pathMessage,
  pathReply,
  commandListMessage,
  commandListReply,
  runCommandMessage,
  commandResultReply,
  sessionStatusReply,
  sendPayload,
  interruptPayload,
  listSessionsPayload,
  historyPayload,
  listPathsPayload,
  listCommandsPayload,
  runCommandPayload,
  getStatusPayload,
  heartbeatPayload,
  initPayload,
  statusPayload,
  sessionListPayload,
  commandList,
  commandResult,
  historyReply,
  pathList,
];
