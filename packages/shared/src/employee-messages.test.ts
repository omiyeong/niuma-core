import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaemonMsg_AIEmployeeSkillInject, DaemonMsg_AIEmployeeStart } from "./protocol";

test("AI employee daemon messages carry AI employee + skill + feishu binding", () => {
  const inject: DaemonMsg_AIEmployeeSkillInject = {
    type: "ai_employee:skill:inject",
    requestId: "r1",
    aiEmployeeId: "a1",
    skills: ["lark-im"],
    feishu: { app_id: "cli_x", app_secret: "s" },
  };
  assert.equal(inject.type, "ai_employee:skill:inject");
});

test("AI employee start config carries unified work context", () => {
  const start: DaemonMsg_AIEmployeeStart = {
    type: "ai_employee:start",
    aiEmployeeId: "ai_emp_1",
    machineId: "machine_1",
    config: {
      id: "ai_emp_1",
      name: "via",
      runtime: "codex",
      model: "gpt-5",
      reasoningEffort: "medium",
      permissionMode: "default",
      workspace: "/tmp/wm-ai-employee",
      token: "secret",
      serverUrl: "http://127.0.0.1:8920",
      aiEmployeeWorkContext: {
        role: "飞书客服",
        workRules: "根据飞书文档 https://example.feishu.cn/drive/folder/example 回答",
      },
    },
  };
  assert.equal(start.type, "ai_employee:start");
  assert.equal(start.config.aiEmployeeWorkContext?.workRules?.includes("feishu.cn"), true);
  assert.equal("knowledgeSources" in (start.config.aiEmployeeWorkContext ?? {}), false);
});
