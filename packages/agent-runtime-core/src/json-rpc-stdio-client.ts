import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { ExecutionBackend } from "./execution-backend";
import { hostBackend } from "./execution-backend";

export type JsonRpcId = number | string;

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

export interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export interface JsonRpcStdioClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  employeeId?: string;
  executionBackend?: ExecutionBackend;
  onNotification: (notification: JsonRpcNotification) => void;
  onServerRequest?: (request: JsonRpcServerRequest) => Promise<unknown>;
  onStderr?: (text: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class JsonRpcStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: readline.Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private started = false;
  private exitEmitted = false;

  constructor(private readonly options: JsonRpcStdioClientOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.exitEmitted = false;
    this.child = (this.options.executionBackend ?? hostBackend()).spawnRuntime({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd ?? process.cwd(),
      env: this.options.env ?? process.env,
      employeeId: this.options.employeeId ?? "json-rpc-runtime",
      detached: process.platform !== "win32",
    });

    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.options.onStderr?.(text);
    });

    this.child.on("error", (error) => {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      this.child = null;
      this.started = false;
    });

    this.child.on("exit", (code, signal) => {
      this.rejectPending(new Error(`Process exited code=${code} signal=${signal}`));
      this.child = null;
      this.started = false;
      this.emitExit(code, signal);
    });

    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new Error("JSON-RPC client not started"));
    }

    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  destroy(): void {
    this.rejectPending(new Error("Client destroyed"));
    this.lines?.close();
    this.lines = null;
    killProcessTree(this.child);
    this.child = null;
    this.started = false;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  get alive(): boolean {
    return this.isRunning;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const packet = message as {
      id?: JsonRpcId;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };

    if (packet.id !== undefined && !packet.method) {
      const pending = this.pending.get(packet.id);
      if (!pending) return;
      this.pending.delete(packet.id);
      if (packet.error) {
        pending.reject(new Error(packet.error.message ?? "JSON-RPC request failed"));
      } else {
        pending.resolve(packet.result);
      }
      return;
    }

    if (packet.id !== undefined && packet.method) {
      const request = {
        id: packet.id,
        method: packet.method,
        params: packet.params,
      };
      const handler = this.options.onServerRequest;
      if (!handler) {
        this.sendResponse(packet.id, {});
        return;
      }
      handler(request)
        .then((result) => this.sendResponse(packet.id!, result))
        .catch((error) =>
          this.sendError(packet.id!, error instanceof Error ? error : new Error(String(error)))
        );
      return;
    }

    if (packet.method) {
      this.options.onNotification({
        method: packet.method,
        params: packet.params,
      });
    }
  }

  private sendResponse(id: JsonRpcId, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private sendError(id: JsonRpcId, error: Error): void {
    this.child?.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error.message },
      })}\n`
    );
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.options.onExit?.(code, signal);
  }
}

function killProcessTree(child: ChildProcessWithoutNullStreams | null): void {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    if (child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    child.kill();
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          if (!child.killed) process.kill(-child.pid!, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }, 5000).unref();
      return;
    } catch {
      // Fall through to direct child kill for runtimes that did not get a group.
    }
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 5000).unref();
}
