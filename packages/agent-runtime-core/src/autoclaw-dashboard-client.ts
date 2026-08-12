export interface AutoClawDashboardOptions {
  dashboardUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface DashboardEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

export class AutoClawDashboardError extends Error {
  constructor(message: string, readonly code: "NOT_READY" | "REQUEST_FAILED" | "REMOTE_ERROR") {
    super(message);
    this.name = "AutoClawDashboardError";
  }
}

export class AutoClawDashboardClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AutoClawDashboardOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(timeoutMs = 3_000): Promise<void> {
    const response = await this.fetchJson<DashboardEnvelope<unknown>>("/health", { method: "GET" }, timeoutMs)
      .catch((error) => {
        throw new AutoClawDashboardError(
          `AutoClaw Dashboard bridge is not ready at ${this.baseUrl()}: ${error instanceof Error ? error.message : String(error)}`,
          "NOT_READY",
        );
      });
    if (!response.ok) {
      throw new AutoClawDashboardError(
        `AutoClaw Dashboard bridge is not ready at ${this.baseUrl()}`,
        "NOT_READY",
      );
    }
  }

  async invoke<T>(namespace: string, method: string, args: unknown[] = [], timeoutMs = 30_000): Promise<T> {
    const path = `/api/electron/${encodeURIComponent(namespace)}/${encodeURIComponent(method)}`;
    const envelope = await this.fetchJson<DashboardEnvelope<T>>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args }),
    }, timeoutMs);
    if (!envelope.ok) {
      throw new AutoClawDashboardError(
        envelope.error || `AutoClaw Dashboard request failed: ${namespace}.${method}`,
        "REMOTE_ERROR",
      );
    }
    return envelope.data as T;
  }

  private async fetchJson<T>(pathname: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl()}${pathname}`, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => undefined) as T | undefined;
      if (!response.ok) {
        const error = (payload as DashboardEnvelope<unknown> | undefined)?.error;
        throw new AutoClawDashboardError(
          error || `AutoClaw Dashboard returned HTTP ${response.status}`,
          "REQUEST_FAILED",
        );
      }
      if (payload === undefined) {
        throw new AutoClawDashboardError("AutoClaw Dashboard returned an empty response", "REQUEST_FAILED");
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  private baseUrl(): string {
    return (this.options.dashboardUrl
      ?? this.options.env?.AUTOCLAW_DASHBOARD_URL
      ?? process.env.AUTOCLAW_DASHBOARD_URL
      ?? "http://127.0.0.1:29100").replace(/\/$/, "");
  }
}

export function autoClawDashboardUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AUTOCLAW_DASHBOARD_URL ?? "http://127.0.0.1:29100").replace(/\/$/, "");
}
