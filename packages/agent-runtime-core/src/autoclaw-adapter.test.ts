import assert from "node:assert/strict";
import { AutoClawAdapter } from "./autoclaw-adapter";
import type { AutoClawDashboardClient } from "./autoclaw-dashboard-client";
import type { AutoClawGatewayClient } from "./autoclaw-gateway-client";

async function main(): Promise<void> {
  let mainRunComplete = false;
  const gatewayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let savedDashboardMessages: Array<Record<string, unknown>> | undefined;

  const gateway = {
    connected: true,
    serverVersion: "test-gateway",
    connect: async () => ({}),
    close: async () => undefined,
    onEvent: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      gatewayCalls.push({ method, params });
      if (method === "chat.history") {
        const messages = mainRunComplete
          ? [
            { role: "user", content: "这条记录标题是什么？" },
            { role: "assistant", content: "真实记录标题" },
          ]
          : [];
        return { sessionKey: params.sessionKey, messages };
      }
      if (method === "agent") {
        return { runId: "main-run", sessionKey: params.sessionKey };
      }
      if (method === "agent.wait") {
        if (params.runId === "main-run") mainRunComplete = true;
        return { runId: params.runId, status: "ok" };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    },
  } as unknown as AutoClawGatewayClient;

  const dashboard = {
    health: async () => undefined,
    invoke: async (namespace: string, method: string, args: unknown[]) => {
      if (namespace === "chatHistory" && method === "save") {
        savedDashboardMessages = JSON.parse(String(args[1])) as Array<Record<string, unknown>>;
        return { ok: true };
      }
      throw new Error(`unexpected dashboard method: ${namespace}.${method}`);
    },
  } as unknown as AutoClawDashboardClient;

  const adapter = new AutoClawAdapter({
    clientFactory: () => gateway,
    dashboardClientFactory: () => dashboard,
    dashboardPersistDelayMs: 0,
    sessionKeyResolver: () => "agent:main:agenthub:feishu:hub-test",
  });
  await adapter.start({
    agentId: "agent-test",
    cwd: "/tmp/agent-test",
    systemPrompt: "Read the exact Skill file at /private/agent-test/agent-records/SKILL.md.",
    systemPromptPath: "",
    permissionMode: "default",
  });
  const result = await adapter.prompt({
    prompt: "canonical execution context",
    displayPrompt: "这条记录标题是什么？",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.finalMessage, "真实记录标题");
  const actualTurn = gatewayCalls.find((call) => call.method === "agent");
  assert.ok(actualTurn);
  assert.equal(actualTurn.params.message, "这条记录标题是什么？");
  assert.match(String(actualTurn.params.extraSystemPrompt), /agent-records\/SKILL\.md/);
  assert.match(String(actualTurn.params.extraSystemPrompt), /canonical execution context/);
  assert.equal(
    (actualTurn.params.autoclawOrigin as Record<string, unknown>).crossEndUserText,
    "这条记录标题是什么？",
  );
  assert.equal(gatewayCalls.filter((call) => call.method === "agent").length, 1);
  assert.deepEqual(savedDashboardMessages?.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "这条记录标题是什么？" },
    { role: "assistant", content: "真实记录标题" },
  ]);
  assert.doesNotMatch(JSON.stringify(savedDashboardMessages), /agent_hub_trusted_context|agent-records|canonical execution context/);
  await adapter.destroy();
  console.log("AutoClaw adapter hidden system prompt tests passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
