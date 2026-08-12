import { createHash } from "node:crypto";
import type {
  PersistentRuntimeAdapter,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimePromptInput,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeStartInput,
} from "./adapter";
import {
  classifyProtocolError,
  withTimeout,
} from "./protocol-utils";
import {
  JsonRpcStdioClient,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
  type JsonRpcStdioClientOptions,
} from "./json-rpc-stdio-client";

const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const MAX_EARLY_TURN_IDS = 64;
const MAX_EARLY_NOTIFICATIONS_PER_TURN = 256;

export interface CodexJsonRpcClient {
  start(): void;
  request(method: string, params?: unknown): Promise<unknown>;
  destroy(): void;
  readonly isRunning?: boolean;
  readonly alive?: boolean;
  readonly pid?: number;
}

export type CodexClientFactory = (
  options: JsonRpcStdioClientOptions
) => CodexJsonRpcClient;

export interface CodexAdapterOptions {
  defaultSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  fullAccessSandbox?: "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request";
}

const DEFAULT_CODEX_CLIENT_FACTORY: CodexClientFactory = (options) =>
  new JsonRpcStdioClient(options);

interface ActiveCodexTurn {
  runInput: RuntimeRunInput;
  events: RuntimeEvent[];
  appendMessage(text: string): void;
  setFinalMessage(text: string): void;
  resolveTurnCompleted(completion: CodexTurnCompletion): void;
  rejectTurn(error: Error): void;
}

interface CodexTurnCompletion {
  status?: string;
  error?: {
    message?: string;
    additionalDetails?: string | null;
  } | null;
}

export class CodexAdapter implements RuntimeAdapter, PersistentRuntimeAdapter {
  readonly runtime = "codex" as const;
  private host: CodexSharedHost | null = null;
  private threadId: string | undefined;
  private startInput: RuntimeStartInput | null = null;
  private activeTurn: ActiveCodexTurn | null = null;
  private activeTurnId: string | undefined;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;

  constructor(
    private readonly clientFactory: CodexClientFactory = DEFAULT_CODEX_CLIENT_FACTORY,
    private readonly options: CodexAdapterOptions = {},
  ) {}

  async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    try {
      await this.start(input);
      return await this.prompt({
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
      });
    } finally {
      await this.destroy("compat run complete");
    }
  }

  async start(input: RuntimeStartInput): Promise<void> {
    try {
      if (this.host && this.alive && this.threadId) return;
      this.startInput = input;
      this.threadId = undefined;
      this.host = CodexSharedHostPool.acquire(input, this.clientFactory, this);
      this.host.setStderrSink(this, input.onEvent);
      await this.host.ensureStarted(input);

      emit([], this.startInputAsRunInput(""), { type: "runtime_started", data: { runtime: "codex" } });

      if (input.runtimeSessionId) {
        await withTimeout(
          this.host.request("thread/resume", {
            threadId: input.runtimeSessionId,
            cwd: codexRuntimeCwd(input),
            ...codexPermissionOptions(input.permissionMode, this.options),
            approvalsReviewer: "user",
            developerInstructions: input.systemPrompt,
            model: input.model && input.model !== "default" ? input.model : undefined,
            config: codexReasoningConfig(input.reasoningEffort),
            excludeTurns: true,
            persistExtendedHistory: true,
          }),
          input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
          "Codex thread resume timeout"
        );
        this.threadId = input.runtimeSessionId;
      } else {
        const response = (await withTimeout(
          this.host.request("thread/start", {
            cwd: codexRuntimeCwd(input),
            ...codexPermissionOptions(input.permissionMode, this.options),
            approvalsReviewer: "user",
            developerInstructions: input.systemPrompt,
            model: input.model && input.model !== "default" ? input.model : undefined,
            config: codexReasoningConfig(input.reasoningEffort),
            persistExtendedHistory: true,
            serviceName: "agent-runtime-core",
          }),
          input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
          "Codex thread start timeout"
        )) as { thread?: { id?: string } };
        this.threadId = response.thread?.id;
        if (!this.threadId) throw new Error("Codex thread/start returned no thread id");
      }
    } catch (error) {
      this.destroy("start failed");
      throw error;
    }
  }

  async prompt(input: RuntimePromptInput): Promise<RuntimeRunResult> {
    const events: RuntimeEvent[] = [];
    let finalMessage = "";
    let turnId: string | undefined;
    let resolveTurnCompleted: ((completion: CodexTurnCompletion) => void) | undefined;
    const turnCompleted = new Promise<CodexTurnCompletion>((resolve) => {
      resolveTurnCompleted = resolve;
    });
    let rejectTurn: ((reason: Error) => void) | undefined;
    const turnFailed = new Promise<never>((_, reject) => {
      rejectTurn = reject;
    });
    const host = this.host;
    const threadId = this.threadId;
    const startInput = this.startInput;
    let turnCancelled = false;
    let rejectAborted: ((reason: Error) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const abortHandler = () => {
      if (turnCancelled) return;
      turnCancelled = true;
      if (this.activeTurnId) host?.interruptTurn(threadId ?? "", this.activeTurnId);
      rejectAborted?.(new Error("Runtime aborted"));
    };

    if (!host || !this.alive || !threadId || !startInput) {
      return {
        status: "runtime_error",
        finalMessage,
        events,
        errorMessage: "Codex persistent runtime is not started",
      };
    }

    const runInput = this.startInputAsRunInput(input.prompt, input);
    try {
      if (input.abortSignal?.aborted) throw new Error("Runtime aborted");
      input.abortSignal?.addEventListener("abort", abortHandler, { once: true });
      const turnTimeoutMs = input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const turnDeadline = Date.now() + turnTimeoutMs;
      this.activeTurn = {
        runInput,
        events,
        appendMessage: (text) => {
          finalMessage += text;
        },
        setFinalMessage: (text) => {
          finalMessage = text;
        },
        resolveTurnCompleted: (completion) => resolveTurnCompleted?.(completion),
        rejectTurn: (error) => rejectTurn?.(error),
      };

      const turnStarted = withTimeout(
        host.startTurn(
          this,
          {
            threadId,
            cwd: codexRuntimeCwd(startInput),
            ...codexPermissionOptions(startInput.permissionMode, this.options),
            approvalsReviewer: "user",
            input: [{ type: "text", text: input.prompt, text_elements: [] }],
          },
          {
            threadId,
            isCancelled: () => turnCancelled,
            onTurnId: (nextTurnId) => {
              turnId = nextTurnId;
              this.activeTurnId = nextTurnId;
            },
          }
        ),
        turnTimeoutMs,
        "Codex turn timeout"
      );
      await (input.abortSignal
        ? Promise.race([turnStarted, aborted, turnFailed])
        : Promise.race([turnStarted, turnFailed]));
      emit(events, runInput, { type: "task_delivered", content: input.prompt });

      const turnCompletion = withTimeout(
        turnCompleted,
        Math.max(1, turnDeadline - Date.now()),
        "Codex turn timeout"
      );
      const completion = await (input.abortSignal
        ? Promise.race([turnCompletion, aborted, turnFailed])
        : Promise.race([turnCompletion, turnFailed]));
      const completionStatus = completion.status ?? (completion.error ? "failed" : "completed");
      emit(events, runInput, {
        type: "turn_finished",
        data: { threadId, turnId, status: completionStatus, error: completion.error ?? null },
      });

      if (completionStatus !== "completed") {
        return {
          status: "runtime_error",
          finalMessage,
          runtimeSessionId: threadId,
          events,
          errorMessage: codexTurnErrorMessage(completionStatus, completion.error),
        };
      }

      return {
        status: "ok",
        finalMessage,
        runtimeSessionId: threadId,
        events,
      };
    } catch (error) {
      turnCancelled = true;
      if (error instanceof Error && error.message === "Codex turn timeout") {
        if (this.activeTurnId) host.interruptTurn(threadId, this.activeTurnId);
        this.destroy("turn timeout");
      }
      return {
        status: classifyProtocolError(error),
        finalMessage,
        runtimeSessionId: threadId,
        events,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      input.abortSignal?.removeEventListener("abort", abortHandler);
      this.activeTurn = null;
      host?.clearTurn(this, turnId ?? this.activeTurnId);
      this.activeTurnId = undefined;
    }
  }

  get alive(): boolean {
    return Boolean(this.host?.alive);
  }

  get pid(): number | undefined {
    return this.host?.pid;
  }

  destroy(_reason?: string): void {
    this.activeTurn = null;
    this.host?.clearTurn(this, this.activeTurnId);
    this.host?.release(this);
    this.host = null;
    this.threadId = undefined;
    this.activeTurnId = undefined;
  }

  routeNotification(notification: JsonRpcNotification): void {
    const active = this.activeTurn;
    if (!active) return;
    this.handleNotification(notification, active.events, active.runInput, {
      appendMessage: active.appendMessage,
      setFinalMessage: active.setFinalMessage,
    });
    if (notification.method === "turn/completed") {
      active.resolveTurnCompleted(codexTurnCompletion(notification));
    }
  }

  handleHostExit(host: CodexSharedHost, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.host !== host) return;
    this.activeTurn?.rejectTurn(new Error(`Codex app-server exited code=${code ?? "-"} signal=${signal ?? "-"}`));
    this.host = null;
    this.threadId = undefined;
    this.activeTurnId = undefined;
    host.release(this);
  }

  private startInputAsRunInput(prompt: string, input: Partial<RuntimePromptInput> = {}): RuntimeRunInput {
    const startInput = this.startInput;
    if (!startInput) {
      throw new Error("Codex persistent runtime is not started");
    }
    return {
      ...startInput,
      prompt,
      timeoutMs: input.timeoutMs ?? startInput.timeoutMs,
      abortSignal: input.abortSignal,
    };
  }

  private handleNotification(
    notification: JsonRpcNotification,
    events: RuntimeEvent[],
    input: RuntimeRunInput,
    final: { appendMessage(text: string): void; setFinalMessage(text: string): void }
  ): void {
    const params = notification.params as Record<string, unknown> | undefined;
    switch (notification.method) {
      case "item/agentMessage/delta": {
        const delta = String(params?.delta ?? "");
        if (delta) {
          final.appendMessage(delta);
          emit(events, input, {
            type: "assistant_delta",
            content: delta,
            data: params,
          });
        }
        break;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = String(params?.delta ?? "");
        if (delta) {
          emit(events, input, {
            type: "thinking_delta",
            content: delta,
            data: params,
          });
        }
        break;
      }
      case "item/started": {
        emit(events, input, { type: "tool_start", data: params });
        break;
      }
      case "item/completed": {
        const item = params?.item as Record<string, unknown> | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          final.setFinalMessage(item.text);
          emit(events, input, {
            type: "assistant_result",
            content: item.text,
            data: item,
          });
        } else {
          emit(events, input, { type: "tool_result", data: params });
        }
        break;
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        emit(events, input, {
          type: "tool_progress",
          content: String(params?.delta ?? ""),
          data: params,
        });
        break;
      }
      case "thread/tokenUsage/updated": {
        emit(events, input, { type: "usage_update", data: params });
        break;
      }
      default: {
        events.push({ type: notification.method, data: params });
      }
    }
  }

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<unknown> {
    // Codex app-server approval + workspace sandbox currently blocks agent-local
    // platform wrapper commands from reaching the daemon/server proxy. Match the
    // Slock-style runner for now: do not bridge Codex approvals to platform Inbox.
    // Other runtime adapters keep their own permission behavior.
    return autoDecisionForCodexRequest(request.method, true);
  }
}

class CodexSharedHost {
  private client: CodexJsonRpcClient | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly adapters = new Set<CodexAdapter>();
  private readonly turnOwners = new Map<string, CodexAdapter>();
  private readonly pendingTurnOwners = new Set<CodexAdapter>();
  private readonly earlyTurnNotifications = new Map<string, JsonRpcNotification[]>();
  private readonly stderrSinks = new Map<CodexAdapter, RuntimeStartInput["onEvent"]>();
  private released = false;

  constructor(
    readonly key: string,
    private readonly factory: CodexClientFactory,
    private readonly onEmpty: (host: CodexSharedHost) => void
  ) {}

  addAdapter(adapter: CodexAdapter): void {
    this.adapters.add(adapter);
  }

  setStderrSink(adapter: CodexAdapter, sink: RuntimeStartInput["onEvent"]): void {
    this.stderrSinks.set(adapter, sink);
  }

  async ensureStarted(input: RuntimeStartInput): Promise<void> {
    if (this.client && this.alive && this.initializePromise) {
      await this.initializePromise;
      return;
    }
    let client!: CodexJsonRpcClient;
    client = this.factory({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      cwd: input.cwd,
      env: input.env,
      employeeId: input.agentId,
      executionBackend: input.executionBackend,
      onNotification: (notification) => this.routeNotification(notification),
      onServerRequest: async (request) => autoDecisionForCodexRequest(request.method, true),
      onStderr: (text) => this.routeStderr(text),
      onExit: (code, signal) => {
        if (this.client !== client) return;
        const adapters = [...this.adapters];
        this.client = null;
        this.initializePromise = null;
        for (const adapter of adapters) adapter.handleHostExit(this, code, signal);
        for (const adapter of adapters) adapter.onExit?.(code, signal);
      },
    });
    this.client = client;
    client.start();
    this.initializePromise = withTimeout(
      client.request("initialize", {
        clientInfo: {
          name: "agent-runtime-core",
          title: "Agent Runtime Core",
          version: "0.0.1",
        },
        capabilities: { experimentalApi: true },
      }),
      10000,
      "Codex initialize timeout"
    ).then(() => undefined);
    await this.initializePromise;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.client || !this.alive) throw new Error("Codex shared app-server is not started");
    return this.client.request(method, params);
  }

  async startTurn(
    adapter: CodexAdapter,
    params: unknown,
    options: {
      threadId: string;
      isCancelled(): boolean;
      onTurnId(turnId: string | undefined): void;
    }
  ): Promise<unknown> {
    try {
      if (options.isCancelled()) throw new Error("Runtime aborted");
      this.pendingTurnOwners.add(adapter);
      const response = (await this.request("turn/start", params)) as { turn?: { id?: string } } | undefined;
      const turnId = response?.turn?.id;
      if (options.isCancelled()) {
        if (turnId) this.earlyTurnNotifications.delete(turnId);
        this.interruptTurn(options.threadId, turnId);
        return response;
      }
      options.onTurnId(turnId);
      this.bindTurn(adapter, turnId);
      return response;
    } finally {
      this.pendingTurnOwners.delete(adapter);
    }
  }

  interruptTurn(threadId: string, turnId: string | undefined): void {
    const client = this.client;
    if (!client || !this.alive || !threadId || !turnId) return;
    try {
      void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    } catch {
      // The turn is already aborting; a closed client needs no further action.
    }
  }

  private bindTurn(adapter: CodexAdapter, turnId: string | undefined): void {
    this.pendingTurnOwners.delete(adapter);
    if (!turnId) return;
    this.turnOwners.set(turnId, adapter);
    const earlyNotifications = this.earlyTurnNotifications.get(turnId);
    this.earlyTurnNotifications.delete(turnId);
    for (const notification of earlyNotifications ?? []) {
      adapter.routeNotification(notification);
    }
  }

  clearTurn(adapter: CodexAdapter, turnId: string | undefined): void {
    this.pendingTurnOwners.delete(adapter);
    if (turnId && this.turnOwners.get(turnId) === adapter) {
      this.turnOwners.delete(turnId);
    }
    if (turnId) this.earlyTurnNotifications.delete(turnId);
  }

  release(adapter: CodexAdapter): void {
    this.adapters.delete(adapter);
    this.stderrSinks.delete(adapter);
    this.pendingTurnOwners.delete(adapter);
    for (const [turnId, owner] of [...this.turnOwners.entries()]) {
      if (owner === adapter) this.turnOwners.delete(turnId);
    }
    if (this.adapters.size > 0) return;
    this.destroy();
    this.onEmpty(this);
  }

  get alive(): boolean {
    return Boolean(this.client && (this.client.alive ?? this.client.isRunning ?? true));
  }

  get pid(): number | undefined {
    return this.client?.pid;
  }

  destroy(): void {
    if (this.released) return;
    this.released = true;
    this.client?.destroy();
    this.client = null;
    this.turnOwners.clear();
    this.pendingTurnOwners.clear();
    this.earlyTurnNotifications.clear();
    this.initializePromise = null;
  }

  private routeNotification(notification: JsonRpcNotification): void {
    const turnId = codexNotificationTurnId(notification);
    const owner = turnId ? this.turnOwners.get(turnId) : undefined;
    if (owner) {
      owner.routeNotification(notification);
      return;
    }
    if (turnId) {
      if (this.pendingTurnOwners.size > 0) {
        let earlyNotifications = this.earlyTurnNotifications.get(turnId);
        if (!earlyNotifications) {
          if (this.earlyTurnNotifications.size >= MAX_EARLY_TURN_IDS) {
            const oldestTurnId = this.earlyTurnNotifications.keys().next().value;
            if (oldestTurnId) this.earlyTurnNotifications.delete(oldestTurnId);
          }
          earlyNotifications = [];
        }
        if (earlyNotifications.length >= MAX_EARLY_NOTIFICATIONS_PER_TURN) {
          earlyNotifications.shift();
        }
        earlyNotifications.push(notification);
        this.earlyTurnNotifications.set(turnId, earlyNotifications);
      }
      return;
    }
    if (this.pendingTurnOwners.size === 1) {
      for (const pending of this.pendingTurnOwners) {
        pending.routeNotification(notification);
        return;
      }
    }
    const activeOwners = new Set(this.turnOwners.values());
    if (!turnId && activeOwners.size === 1) {
      for (const active of activeOwners) {
        active.routeNotification(notification);
        return;
      }
    }
  }

  private routeStderr(text: string): void {
    const filtered = filterCodexStderr(text);
    if (!filtered) return;
    for (const sink of this.stderrSinks.values()) {
      sink?.({ type: "runtime_stderr", content: filtered });
    }
  }
}

class CodexSharedHostPool {
  private static readonly hosts = new Map<string, CodexSharedHost>();
  private static readonly factoryIds = new WeakMap<CodexClientFactory, number>();
  private static nextFactoryId = 1;

  static acquire(input: RuntimeStartInput, factory: CodexClientFactory, adapter: CodexAdapter): CodexSharedHost {
    const key = this.keyFor(input, factory);
    let host = this.hosts.get(key);
    if (!host) {
      host = new CodexSharedHost(key, factory, (emptyHost) => {
        if (this.hosts.get(emptyHost.key) === emptyHost) this.hosts.delete(emptyHost.key);
      });
      this.hosts.set(key, host);
    }
    host.addAdapter(adapter);
    return host;
  }

  private static keyFor(input: RuntimeStartInput, factory: CodexClientFactory): string {
    let factoryId = this.factoryIds.get(factory);
    if (!factoryId) {
      factoryId = this.nextFactoryId;
      this.nextFactoryId += 1;
      this.factoryIds.set(factory, factoryId);
    }
    const backend = input.executionBackend?.kind ?? "host";
    return [
      `factory:${factoryId}`,
      `agent:${input.agentId}`,
      `cwd:${input.cwd}`,
      `runtimeCwd:${input.runtimeCwd ?? ""}`,
      `backend:${backend}`,
      `env:${codexRuntimeEnvIdentity(input.env ?? process.env)}`,
    ].join("|");
  }
}

function codexRuntimeEnvIdentity(env: NodeJS.ProcessEnv): string {
  const entries = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function autoDecisionForCodexRequest(method: string, approved: boolean): unknown {
  if (method === "item/permissions/requestApproval") {
    return approved
      ? { permissions: {}, scope: "turn" }
      : { permissions: null, scope: "turn" };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: approved ? "approved" : "denied" };
  }
  if (method === "item/commandExecution/requestApproval") {
    return { decision: approved ? "accept" : "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: approved ? "accept" : "reject" };
  }
  if (isApprovalLikeRequest(method)) {
    return { decision: approved ? "accept" : "decline" };
  }
  return {};
}

function isApprovalLikeRequest(method: string): boolean {
  return /approval|permission/i.test(method);
}

function codexPermissionOptions(
  permissionMode: RuntimeRunInput["permissionMode"],
  options: CodexAdapterOptions,
): { approvalPolicy: string; sandbox: string } {
  return {
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: permissionMode === "full_access"
      ? options.fullAccessSandbox ?? "danger-full-access"
      : options.defaultSandbox ?? "workspace-write",
  };
}

function emit(events: RuntimeEvent[], input: RuntimeRunInput, event: RuntimeEvent): void {
  events.push(event);
  input.onEvent?.(event);
}

function codexReasoningConfig(reasoningEffort: string | undefined): { model_reasoning_effort: string } | undefined {
  const value = reasoningEffort?.trim();
  if (!value || value === "default") return undefined;
  return { model_reasoning_effort: value };
}

function codexRuntimeCwd(input: Pick<RuntimeStartInput, "cwd" | "runtimeCwd">): string {
  return input.runtimeCwd ?? input.cwd;
}

function codexNotificationTurnId(notification: JsonRpcNotification): string | undefined {
  const params = notification.params as Record<string, unknown> | undefined;
  const direct = params?.turnId ?? params?.turn_id;
  if (typeof direct === "string" && direct) return direct;
  const turn = params?.turn as Record<string, unknown> | undefined;
  if (typeof turn?.id === "string" && turn.id) return turn.id;
  const item = params?.item as Record<string, unknown> | undefined;
  const itemTurn = item?.turn as Record<string, unknown> | undefined;
  const itemDirect = item?.turnId ?? item?.turn_id;
  if (typeof itemDirect === "string" && itemDirect) return itemDirect;
  if (typeof itemTurn?.id === "string" && itemTurn.id) return itemTurn.id;
  return undefined;
}

function codexTurnCompletion(notification: JsonRpcNotification): CodexTurnCompletion {
  const params = notification.params as Record<string, unknown> | undefined;
  const turn = params?.turn as Record<string, unknown> | undefined;
  const error = turn?.error && typeof turn.error === "object"
    ? turn.error as Record<string, unknown>
    : undefined;
  return {
    status: typeof turn?.status === "string" ? turn.status : undefined,
    error: error
      ? {
          message: typeof error.message === "string" ? error.message : undefined,
          additionalDetails: typeof error.additionalDetails === "string" ? error.additionalDetails : undefined,
        }
      : null,
  };
}

function codexTurnErrorMessage(
  status: string,
  error: CodexTurnCompletion["error"]
): string {
  const message = error?.message?.trim();
  const details = error?.additionalDetails?.trim();
  if (message && details) return `${message}: ${details}`;
  return message || details || `Codex turn ${status}`;
}

export function filterCodexStderr(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => !isNoisyCodexStderrLine(line));
  return lines.join("\n").trim();
}

function isNoisyCodexStderrLine(line: string): boolean {
  const normalized = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!normalized) return true;
  return (
    /codex_core::util.*(?:ReasoningSummaryDelta|ReasoningSummaryPartAdded|OutputTextDelta) without active item/.test(normalized) ||
    /codex_app_server.*Codex could not find bubblewrap/.test(normalized)
  );
}
