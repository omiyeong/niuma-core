import type { RuntimeRunResult } from "./adapter";

export function classifyProtocolError(error: unknown): RuntimeRunResult["status"] {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("enoent") || message.includes("not found")) return "not_installed";
  if (
    message.includes("auth")
    || message.includes("login")
    || message.includes("api key")
    || message.includes("401")
  ) {
    return "not_logged_in";
  }
  if (message.includes("timeout") || message.includes("aborted") || message.includes("abort")) {
    return "timeout";
  }
  return "runtime_error";
}

export function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
