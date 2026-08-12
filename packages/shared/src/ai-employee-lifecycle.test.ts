import assert from "node:assert/strict";
import { test } from "node:test";
import { computeAIEmployeeLifecycle, type AIEmployeeLifecycleInput } from "./ai-employee-lifecycle";

function input(overrides: Partial<AIEmployeeLifecycleInput>): AIEmployeeLifecycleInput {
  return {
    machineOnline: true,
    daemonState: "inactive",
    activity: "idle",
    workspaceReady: false,
    ...overrides,
  };
}

test("machine offline overrides everything", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ machineOnline: false, daemonState: "active" })), "offline");
});

test("pending stop transition reports stopping while machine online", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "active", pendingTransition: "stopping" })), "stopping");
});

test("daemon initializing maps to starting", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "initializing" })), "starting");
});

test("applying_profile maps to applying_profile", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "applying_profile" })), "applying_profile");
});

test("restarting_fresh maps to restarting", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "restarting_fresh" })), "restarting");
});

test("profile_update_failed maps to error", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "profile_update_failed" })), "error");
});

test("active daemon maps to active", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "active" })), "active");
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "wakeable" })), "active");
});

test("inactive with ready workspace maps to ready", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "inactive", workspaceReady: true })), "ready");
});

test("inactive without ready workspace maps to not_provisioned", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "inactive", workspaceReady: false })), "not_provisioned");
});

test("unavailable daemon while machine online maps to not_provisioned", () => {
  assert.equal(computeAIEmployeeLifecycle(input({ daemonState: "unavailable" })), "not_provisioned");
});

console.log("ai-employee-lifecycle tests defined");
