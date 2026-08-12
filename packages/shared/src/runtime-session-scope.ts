import type { RuntimeSessionScope } from "./protocol";

export type ExternalScopeSource = "feishu" | "mail" | "routine" | "webhook" | "system";

// 生成的 id 仅作不透明 key 使用，消费方禁止按 ":" 解析其内部结构。
export function externalScope(source: ExternalScopeSource, sessionKey: string): RuntimeSessionScope {
  const key = sessionKey.trim();
  return { type: "external", id: `${source}:${key || "default"}` };
}
