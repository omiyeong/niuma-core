import assert from "node:assert/strict";
import {
  buildAgentHubTurnSystemPrompt,
  resolveAgentHubAutoClawSessionKey,
} from "./autoclaw-adapter";
import { classifyProtocolError } from "./protocol-utils";

const first = resolveAgentHubAutoClawSessionKey(undefined);
assert.match(first, /^agent:main:agenthub:feishu:hub-/);
assert.equal(resolveAgentHubAutoClawSessionKey(first), first);

const niumaSession = "agent:main:niuma:feishu:wm-legacy";
assert.notEqual(resolveAgentHubAutoClawSessionKey(niumaSession), niumaSession);

const prompt = buildAgentHubTurnSystemPrompt("base rules", "hidden execution details");
assert.match(prompt, /Agent Hub execution context/);
assert.doesNotMatch(prompt, /NiuMa|\.wm\/wm/);

assert.equal(classifyProtocolError(new Error("authentication required")), "not_logged_in");
assert.equal(classifyProtocolError(new Error("turn timeout")), "timeout");

console.log("agent runtime core tests passed");
