import assert from "node:assert/strict";
import { validateRoutineSpec } from "./spec-validator";

const validSpec = {
  trigger: { kind: "schedule", interval_seconds: 300 },
  auth: { ref: "feishu:user_1" },
  steps: [
    { id: "fetch", primitive: "http_request", input: { method: "GET", url: "https://example.test" } },
    { id: "filter", primitive: "filter", input: { items: "${steps.fetch.body.items}", expression: "item.type == 'x'" } },
  ],
};

assert.deepEqual(validateRoutineSpec(validSpec), { ok: true });
assert.deepEqual(validateRoutineSpec({ ...validSpec, trigger: { kind: "event" } }), { ok: true });

assert.equal(validateRoutineSpec({ ...validSpec, trigger: { kind: "webhook", interval_seconds: 300 } }).ok, false);
assert.equal(validateRoutineSpec({ ...validSpec, trigger: { kind: "schedule", interval_seconds: 30 } }).ok, false);
assert.equal(validateRoutineSpec({ ...validSpec, steps: [] }).ok, false);
assert.equal(validateRoutineSpec({ ...validSpec, auth: { ref: "x", client_secret: "secret" } }).ok, false);
assert.equal(validateRoutineSpec({
  ...validSpec,
  instruction: { handling_rules: ["必须确认后发送"] },
}).ok, false);
assert.equal(validateRoutineSpec({
  ...validSpec,
  steps: [
    { id: "a", primitive: "http_request", input: {} },
    { id: "a", primitive: "filter", input: {} },
  ],
}).ok, false);
assert.equal(validateRoutineSpec({
  ...validSpec,
  steps: [
    { id: "a", primitive: "http_request", input: { url: "${steps.missing.body}" } },
  ],
}).ok, false);
assert.equal(validateRoutineSpec({
  ...validSpec,
  steps: [
    {
      id: "loop",
      primitive: "foreach",
      input: {
        items: "${steps.fetch.body.items}",
        do: [{ id: "nested", primitive: "foreach", input: { items: [], do: [] } }],
      },
    },
  ],
}).ok, false);

console.info("spec-validator tests passed");
