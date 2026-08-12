import crypto from "node:crypto";
import type {
  PersistentRuntimeAdapter,
  RuntimeEvent,
  RuntimePromptInput,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeRunStatus,
  RuntimeStartInput,
} from "./adapter";
import {
  AutoClawGatewayClient,
  AutoClawGatewayError,
  type AutoClawGatewayEvent,
  type AutoClawGatewayOptions,
} from "./autoclaw-gateway-client";
import {
  AutoClawDashboardClient,
  AutoClawDashboardError,
  type AutoClawDashboardOptions,
} from "./autoclaw-dashboard-client";

interface AgentAcceptedResult {
  runId?: string;
  status?: string;
  sessionKey?: string;
}

interface AgentWaitResult {
  runId?: string;
  status?: "ok" | "timeout" | "error" | "pending";
  error?: string;
}

interface ChatHistoryResult {
  sessionKey?: string;
  messages?: unknown[];
}

const AGENT_HUB_SESSION_PREFIX = "agent:main:agenthub:feishu:hub-";
export interface AutoClawAdapterOptions extends AutoClawGatewayOptions, AutoClawDashboardOptions {
  clientFactory?: (options: AutoClawGatewayOptions) => AutoClawGatewayClient;
  dashboardClientFactory?: (options: AutoClawDashboardOptions) => AutoClawDashboardClient;
  dashboardPersistDelayMs?: number;
  sessionKeyResolver?: (runtimeSessionId: string | undefined) => string;
  originChannel?: string;
  turnSystemPromptBuilder?: (baseSystemPrompt: string, executionPrompt: string) => string;
  platformReplyCommand?: string;
}

export class AutoClawAdapter implements PersistentRuntimeAdapter {
  readonly runtime = "autoclaw" as const;
  private readonly client: AutoClawGatewayClient;
  private readonly dashboardClient: AutoClawDashboardClient;
  private startInput?: RuntimeStartInput;
  private sessionKey?: string;
  private started = false;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;

  constructor(private readonly options: AutoClawAdapterOptions = {}) {
    this.client = options.clientFactory?.(options) ?? new AutoClawGatewayClient(options);
    this.dashboardClient = options.dashboardClientFactory?.(options) ?? new AutoClawDashboardClient(options);
  }

  async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    try {
      await this.start(input);
      return await this.prompt({
        prompt: input.prompt,
        displayPrompt: input.prompt,
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
      });
    } finally {
      await this.destroy("compat run complete");
    }
  }

  async start(input: RuntimeStartInput): Promise<void> {
    if (input.executionBackend?.kind === "container") {
      throw new Error("AutoClaw is a desktop runtime and only supports host execution");
    }
    this.startInput = input;
    await this.dashboardClient.health();
    await this.client.connect(["operator.read", "operator.write", "operator.admin"]);
    this.sessionKey = (this.options.sessionKeyResolver ?? resolveAgentHubAutoClawSessionKey)(input.runtimeSessionId);
    this.started = true;
    input.onEvent?.({
      type: "runtime_started",
      data: { runtime: this.runtime, gatewayVersion: this.client.serverVersion, sessionKey: this.sessionKey },
    });
  }

  async prompt(input: RuntimePromptInput): Promise<RuntimeRunResult> {
    const startInput = this.startInput;
    const events: RuntimeEvent[] = [];
    if (!startInput || !this.started || !this.client.connected || !this.sessionKey) {
      return {
        status: "runtime_error",
        finalMessage: "",
        runtimeSessionId: this.sessionKey,
        events,
        errorMessage: "AutoClaw runtime is not started",
      };
    }

    const timeoutMs = input.timeoutMs ?? startInput.timeoutMs ?? 300_000;
    const idempotencyKey = crypto.randomUUID();
    let runId: string = idempotencyKey;
    const removeListener = this.client.onEvent((event) => {
      const mapped = mapGatewayEvent(event, runId);
      if (!mapped) return;
      events.push(mapped);
      startInput.onEvent?.(mapped);
    });
    const abort = () => {
      void this.client.request("chat.abort", { sessionKey: this.sessionKey, runId }, 5_000).catch(() => undefined);
    };
    input.abortSignal?.addEventListener("abort", abort, { once: true });

    try {
      const beforeHistory = await this.client.request<ChatHistoryResult>(
        "chat.history",
        { sessionKey: this.sessionKey, limit: 50 },
        15_000,
      );
      const displayPrompt = input.displayPrompt?.trim() || input.prompt.trim();
      const origin = {
        source: "app",
        clientType: "app",
        senderClientType: "app",
        channel: this.options.originChannel ?? "agenthub",
        sessionKey: this.sessionKey,
        agentId: "main",
        crossEndUserText: displayPrompt,
      };
      const turnSystemPrompt = (this.options.turnSystemPromptBuilder ?? buildAgentHubTurnSystemPrompt)(
        startInput.systemPrompt,
        input.prompt,
      );
      const accepted = await this.client.request<AgentAcceptedResult>("agent", {
        sessionKey: this.sessionKey,
        agentId: "main",
        message: displayPrompt,
        extraSystemPrompt: turnSystemPrompt,
        ...(startInput.model && startInput.model !== "default" ? { model: startInput.model } : {}),
        ...(startInput.reasoningEffort && startInput.reasoningEffort !== "default"
          ? { thinking: startInput.reasoningEffort }
          : {}),
        idempotencyKey,
        autoclawOrigin: origin,
      }, 120_000);
      runId = accepted.runId?.trim() || idempotencyKey;
      this.sessionKey = accepted.sessionKey?.trim() || this.sessionKey;
      events.push({ type: "task_delivered", content: displayPrompt, data: { runId } });

      const wait = await this.client.request<AgentWaitResult>(
        "agent.wait",
        { runId, timeoutMs },
        timeoutMs + 2_000,
      );
      if (wait.status !== "ok") {
        return {
          status: wait.status === "timeout" || wait.status === "pending" ? "timeout" : "runtime_error",
          finalMessage: "",
          runtimeSessionId: this.sessionKey,
          events,
          errorMessage: wait.error || `AutoClaw agent run ended with status ${wait.status ?? "unknown"}`,
        };
      }

      const history = await this.client.request<ChatHistoryResult>(
        "chat.history",
        { sessionKey: this.sessionKey, limit: 50 },
        15_000,
      );
      const currentTurnMessages = messagesAddedAfter(beforeHistory.messages ?? [], history.messages ?? []);
      const platformReply = extractSuccessfulPlatformReply(currentTurnMessages);
      const runtimeFinal = extractLatestAssistantText(currentTurnMessages);
      const runtimeReply = isNoReply(runtimeFinal) ? "" : runtimeFinal;
      const finalMessage = this.options.platformReplyCommand
        ? platformReply || runtimeReply
        : runtimeReply || platformReply;
      if (!finalMessage) {
        return {
          status: "runtime_error",
          finalMessage: "",
          runtimeSessionId: this.sessionKey,
          events,
          errorMessage: "AutoClaw run completed without an assistant message",
        };
      }
      // AutoClaw's Dashboard systemPrompt path uses chat.inject, which only
      // appends an assistant note and does not affect the model. The real turn
      // therefore runs through Gateway agent + extraSystemPrompt. Persist a
      // cleaned snapshot here so the Dashboard still shows only user-authored
      // text and the resulting answer.
      const persistDelayMs = this.options.dashboardPersistDelayMs ?? 3_000;
      if (persistDelayMs > 0) await delay(persistDelayMs);
      const dashboardMessages = toDashboardMessages(history.messages ?? [], displayPrompt);
      appendAssistantReplyIfMissing(
        dashboardMessages,
        this.options.platformReplyCommand ? platformReply : finalMessage,
      );
      const saved = await this.dashboardClient.invoke<{ ok?: boolean; error?: string }>(
        "chatHistory",
        "save",
        [this.sessionKey, JSON.stringify(dashboardMessages)],
        15_000,
      );
      if (saved?.ok === false) {
        throw new AutoClawDashboardError(
          saved.error || `AutoClaw failed to persist Dashboard history for ${this.sessionKey}`,
          "REMOTE_ERROR",
        );
      }
      if (platformReply && this.options.platformReplyCommand) {
        const platformSentEvent: RuntimeEvent = {
          type: "platform_message_sent",
          content: platformReply,
          data: {
            command: this.options.platformReplyCommand,
            status: "completed",
            exitCode: 0,
          },
          silent: true,
        };
        events.push(platformSentEvent);
        startInput.onEvent?.(platformSentEvent);
      }
      const resultEvent: RuntimeEvent = { type: "assistant_result", content: finalMessage, data: { runId } };
      events.push(resultEvent);
      startInput.onEvent?.(resultEvent);
      return { status: "ok", finalMessage, runtimeSessionId: this.sessionKey, events };
    } catch (error) {
      return {
        status: classifyAutoClawError(error),
        finalMessage: "",
        runtimeSessionId: this.sessionKey,
        events,
        errorMessage: formatAutoClawError(error),
      };
    } finally {
      removeListener();
      input.abortSignal?.removeEventListener("abort", abort);
    }
  }

  get alive(): boolean {
    return this.started && this.client.connected;
  }

  get pid(): number | undefined {
    return undefined;
  }

  async destroy(_reason?: string): Promise<void> {
    const wasStarted = this.started;
    this.started = false;
    await this.client.close();
    if (wasStarted) this.onExit?.(0, null);
  }

}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveAgentHubAutoClawSessionKey(runtimeSessionId: string | undefined): string {
  const value = runtimeSessionId?.trim();
  if (value?.startsWith(AGENT_HUB_SESSION_PREFIX) && value.length > AGENT_HUB_SESSION_PREFIX.length) {
    return value;
  }
  return `${AGENT_HUB_SESSION_PREFIX}${crypto.randomUUID()}`;
}

export function buildAgentHubTurnSystemPrompt(baseSystemPrompt: string, executionPrompt: string): string {
  return [
    baseSystemPrompt.trim(),
    "Agent Hub execution context for this turn (hidden from the visible user message; do not quote it):",
    executionPrompt.trim(),
  ].filter(Boolean).join("\n\n");
}

function isPlatformInitializationPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith("Start this platform-created agent session.");
}

function isNoReply(text: string): boolean {
  return text.trim().toUpperCase() === "NO_REPLY";
}

function messageIdentity(value: unknown): string | undefined {
  const message = asRecord(value);
  if (!message) return undefined;
  const openClaw = asRecord(message.__openclaw);
  const id = [message.id, message.responseId, message.toolCallId, openClaw?.id]
    .find((candidate) => typeof candidate === "string" && candidate.trim());
  if (typeof id === "string") return `${String(message.role)}:${id}`;
  if (typeof message.timestamp === "number") return `${String(message.role)}:${message.timestamp}:${extractText(message.content) ?? ""}`;
  return undefined;
}

function messagesAddedAfter(before: unknown[], after: unknown[]): unknown[] {
  const identities = new Set(before.map(messageIdentity).filter((value): value is string => Boolean(value)));
  const added = after.filter((message) => {
    const identity = messageIdentity(message);
    return !identity || !identities.has(identity);
  });
  if (added.length > 0) return added;
  return after.length >= before.length ? after.slice(before.length) : after;
}

function classifyAutoClawError(error: unknown): RuntimeRunStatus {
  if (error instanceof AutoClawDashboardError) return "runtime_error";
  if (error instanceof AutoClawGatewayError) {
    if (error.pairingRequired || error.code === "NOT_AUTHENTICATED") return "not_logged_in";
    if (error.code === "TIMEOUT") return "timeout";
    if (error.code === "CONNECTION_CLOSED" || error.code === "NOT_CONNECTED") return "runtime_error";
  }
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (text.includes("not found") || text.includes("econnrefused")) return "not_installed";
  if (text.includes("timeout")) return "timeout";
  return "runtime_error";
}

function formatAutoClawError(error: unknown): string {
  if (error instanceof AutoClawDashboardError && error.code === "NOT_READY") {
    return `${error.message}. Quit AutoClaw and relaunch it with AUTOCLAW_WEB_BRIDGE=1 so remote conversations can be registered in the AutoClaw Dashboard.`;
  }
  if (error instanceof AutoClawGatewayError && error.pairingRequired) {
    return "AutoClaw is installed, but this daemon is not paired for agent execution. Open the AutoClaw Gateway Control UI at http://127.0.0.1:18789 and approve the NiuMa daemon device request.";
  }
  return error instanceof Error ? error.message : String(error);
}

function mapGatewayEvent(event: AutoClawGatewayEvent, runId: string): RuntimeEvent | undefined {
  if (event.event !== "agent") return undefined;
  const payload = asRecord(event.payload);
  if (typeof payload?.runId === "string" && payload.runId !== runId) return undefined;
  const stream = typeof payload?.stream === "string" ? payload.stream : "agent";
  const data = asRecord(payload?.data);
  const content = extractText(data);
  return {
    type: `autoclaw_${stream}`,
    content,
    data: payload,
    silent: stream !== "assistant",
  };
}

export function extractLatestAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role !== "assistant") continue;
    const text = extractText(message.content);
    if (text) return text;
  }
  return "";
}

export function extractSuccessfulPlatformReply(messages: unknown[]): string {
  const commands = new Map<string, string>();
  for (const value of messages) {
    const message = asRecord(value);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const blockValue of message.content) {
      const block = asRecord(blockValue);
      const args = asRecord(block?.arguments);
      const callId = typeof block?.id === "string"
        ? block.id
        : typeof block?.toolCallId === "string" ? block.toolCallId : undefined;
      const command = typeof args?.command === "string" ? args.command : undefined;
      if (block?.type === "toolCall" && block.name === "exec" && callId && command && isPlatformMessageSendCommand(command)) {
        commands.set(callId, command);
      }
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const command = commands.get(message.toolCallId);
    if (!command) continue;
    const output = extractText(message.content) ?? "";
    if (!/^Message sent to\s/m.test(output)) continue;
    const reply = extractMessageTextFromCommand(command);
    if (reply) return reply;
  }
  return "";
}

function isPlatformMessageSendCommand(command: string): boolean {
  return /(?:^|[\s/])(?:\.wm\/)?wm\s+message\s+send(?:\s|$)/.test(command);
}

function extractMessageTextFromCommand(command: string): string | undefined {
  const textOption = extractCommandOptionValue(command, "text") ?? extractCommandOptionValue(command, "content");
  if (textOption?.trim()) return textOption.trim();
  const heredoc = command.match(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n([\s\S]*?)\n\1(?:['"])?(?:\s|$)/);
  return heredoc?.[2]?.trim() || undefined;
}

function extractCommandOptionValue(command: string, option: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)--${option}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s"']+))`);
  const match = command.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function toDashboardMessages(messages: unknown[], fallbackUserPrompt?: string): Array<Record<string, unknown>> {
  const normalized = messages.flatMap((value, index) => {
    const message = asRecord(value);
    if (message?.role !== "user" && message?.role !== "assistant") return [];
    const rawContent = extractText(message.content);
    const content = message.role === "user" ? extractUserAuthoredRequest(rawContent) : rawContent;
    if (!content) return [];
    if (message.role === "user" && isPlatformInitializationPrompt(content)) return [];
    if (message.role === "assistant" && (content === "Startup complete" || isNoReply(content))) return [];
    if (message.role === "assistant" && content.startsWith("[system-prompt]")) return [];
    const openClawMeta = asRecord(message.__openclaw);
    const id = [message.id, message.responseId, openClawMeta?.id]
      .find((candidate) => typeof candidate === "string" && candidate.trim()) as string | undefined;
    return [{
      id: id || crypto.randomUUID(),
      role: message.role,
      content,
      timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now() + index,
    }];
  });
  if (fallbackUserPrompt?.trim() && !normalized.some((message) => message.role === "user")) {
    const firstTimestamp = normalized.find((message) => typeof message.timestamp === "number")?.timestamp;
    normalized.unshift({
      id: crypto.randomUUID(),
      role: "user",
      content: fallbackUserPrompt.trim(),
      timestamp: typeof firstTimestamp === "number" ? firstTimestamp - 1 : Date.now(),
    });
  }
  return normalized;
}

function appendAssistantReplyIfMissing(messages: Array<Record<string, unknown>>, reply: string): void {
  const text = reply.trim();
  if (!text) return;
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (messages.slice(lastUserIndex + 1).some((message) => message.role === "assistant" && message.content === text)) return;
  const lastTimestamp = messages.reduce((max, message) => typeof message.timestamp === "number" ? Math.max(max, message.timestamp) : max, Date.now());
  messages.push({ id: crypto.randomUUID(), role: "assistant", content: text, timestamp: lastTimestamp + 1 });
}

function extractUserAuthoredRequest(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const blocks = [...content.matchAll(
    /(?:^|\n)<<<AUTOCLAW_USER_AUTHORED_REQUEST_START>>>\r?\n([\s\S]*?)\r?\n<<<AUTOCLAW_USER_AUTHORED_REQUEST_END>>>(?=\n|$)/g,
  )];
  if (blocks.length === 0) return content;
  return blocks.at(-1)?.[1]?.trim() || undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const text = value.map((item) => extractText(item)).filter(Boolean).join("\n").trim();
    return text || undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["text", "content", "delta", "message"]) {
    const text = extractText(record[key]);
    if (text) return text;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
