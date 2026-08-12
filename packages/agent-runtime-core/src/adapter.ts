import type { ExecutionBackend } from "./execution-backend";

export type RuntimeId = string;
export type RuntimePermissionMode = "default" | "full_access";
export type RuntimeSessionScope =
  | { type: "channel"; id: string }
  | { type: "dm"; id: string }
  | { type: "external"; id: string };

export interface RuntimePermissionRequest {
  kind: "command" | "file_change" | "permission" | "session" | "unknown";
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimePermissionDecision {
  action: "approve" | "reject";
  metadata?: Record<string, unknown>;
}

export type RuntimeRunStatus =
  | "ok"
  | "not_installed"
  | "not_logged_in"
  | "unsupported_version"
  | "timeout"
  | "runtime_error";

export interface RuntimeRunInput {
  agentId: string;
  cwd: string;
  runtimeCwd?: string;
  prompt: string;
  systemPrompt: string;
  systemPromptPath: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: RuntimePermissionMode;
  env?: NodeJS.ProcessEnv;
  executionBackend?: ExecutionBackend;
  runtimeSessionId?: string;
  runtimeSessionScope?: RuntimeSessionScope;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void;
  requestPermission?: (request: RuntimePermissionRequest) => Promise<RuntimePermissionDecision>;
}

export interface RuntimeStartInput {
  agentId: string;
  agentName?: string;
  cwd: string;
  runtimeCwd?: string;
  systemPrompt: string;
  systemPromptPath: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: RuntimePermissionMode;
  env?: NodeJS.ProcessEnv;
  executionBackend?: ExecutionBackend;
  runtimeSessionId?: string;
  runtimeSessionScope?: RuntimeSessionScope;
  timeoutMs?: number;
  onEvent?: (event: RuntimeEvent) => void;
  requestPermission?: (request: RuntimePermissionRequest) => Promise<RuntimePermissionDecision>;
}

export interface RuntimePromptInput {
  prompt: string;
  /** User-authored text for runtimes whose dashboard separates visible chat from execution context. */
  displayPrompt?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface RuntimeEvent {
  type: string;
  content?: string;
  data?: unknown;
  silent?: boolean;
}

export interface RuntimeRunResult {
  status: RuntimeRunStatus;
  finalMessage: string;
  runtimeSessionId?: string;
  events: RuntimeEvent[];
  errorMessage?: string;
}

export interface RuntimeAdapter {
  readonly runtime: RuntimeId;
  run(input: RuntimeRunInput): Promise<RuntimeRunResult>;
}

export interface PersistentRuntimeAdapter {
  readonly runtime: RuntimeId;
  readonly alive: boolean;
  readonly pid?: number;
  start(input: RuntimeStartInput): Promise<void>;
  prompt(input: RuntimePromptInput): Promise<RuntimeRunResult>;
  destroy(reason?: string): Promise<void> | void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export function isPersistentRuntimeAdapter(
  adapter: RuntimeAdapter | PersistentRuntimeAdapter
): adapter is PersistentRuntimeAdapter {
  const candidate = adapter as Partial<PersistentRuntimeAdapter>;
  return typeof candidate.start === "function"
    && typeof candidate.prompt === "function"
    && typeof candidate.destroy === "function";
}
