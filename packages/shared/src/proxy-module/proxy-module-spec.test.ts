import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProxyModuleSpec, ProxyModuleTrigger } from "../protocol";

test("ProxyModuleSpec has only name/description/trigger after refactor", () => {
  const spec: ProxyModuleSpec = {
    kind: "proxy_module",
    version: 1,
    name: "demo",
    description: "demo proxy",
    trigger: { type: "interval", interval_seconds: 180 },
  };
  assert.equal(spec.name, "demo");
  assert.equal((spec as Record<string, unknown>).connectors, undefined);
  assert.equal((spec as Record<string, unknown>).policy, undefined);
  assert.equal((spec as Record<string, unknown>).limits, undefined);
  assert.equal((spec as Record<string, unknown>).module, undefined);
  assert.equal((spec as Record<string, unknown>).entry, undefined);
});

test("ProxyModuleTrigger allows event without interval_seconds", () => {
  const t: ProxyModuleTrigger = { type: "event" };
  assert.equal(t.type, "event");
});

import { validateProxyModuleSpec, normalizeProxyModuleSpec } from "./proxy-module-spec";

test("validateProxyModuleSpec accepts minimal valid spec", () => {
  const result = validateProxyModuleSpec({
    kind: "proxy_module",
    version: 1,
    name: "demo",
    description: "demo proxy",
    trigger: { type: "interval", interval_seconds: 180 },
  });
  assert.equal(result.ok, true);
});

test("validateProxyModuleSpec rejects interval < 30", () => {
  const result = validateProxyModuleSpec({
    kind: "proxy_module", version: 1, name: "d", description: "d",
    trigger: { type: "interval", interval_seconds: 10 },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(";"), /interval_seconds/);
});

test("validateProxyModuleSpec rejects event with interval_seconds", () => {
  const result = validateProxyModuleSpec({
    kind: "proxy_module", version: 1, name: "d", description: "d",
    trigger: { type: "event", interval_seconds: 60 } as unknown,
  });
  assert.equal(result.ok, false);
});

test("validateProxyModuleSpec rejects unknown fields like connectors", () => {
  const result = validateProxyModuleSpec({
    kind: "proxy_module", version: 1, name: "d", description: "d",
    trigger: { type: "interval", interval_seconds: 60 },
    connectors: [{ type: "feishu_messages" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(";"), /unknown field|connectors/);
});

test("normalizeProxyModuleSpec strips nothing extra on already-valid spec", () => {
  const spec = normalizeProxyModuleSpec({
    kind: "proxy_module", version: 1, name: "d", description: "d",
    trigger: { type: "interval", interval_seconds: 180 },
  });
  assert.equal(Object.keys(spec).length, 5);
});

test("validateProxyModuleSpec rejects name longer than 60 chars", () => {
  const longName = "x".repeat(61);
  const result = validateProxyModuleSpec({
    kind: "proxy_module", version: 1, name: longName, description: "d",
    trigger: { type: "interval", interval_seconds: 60 },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(";"), /name must be <= 60/);
});

test("validateProxyModuleSpec rejects non-object input", () => {
  for (const bad of [null, "string", 42, [], true]) {
    const result = validateProxyModuleSpec(bad);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});
