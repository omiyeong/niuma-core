import assert from "node:assert/strict";
import { externalScope } from "./runtime-session-scope";

assert.deepEqual(externalScope("feishu", "oc_abc123"), { type: "external", id: "feishu:oc_abc123" });
assert.deepEqual(externalScope("routine", "rt_1"), { type: "external", id: "routine:rt_1" });
assert.deepEqual(externalScope("feishu", "  "), { type: "external", id: "feishu:default" });
assert.deepEqual(externalScope("feishu", ""), { type: "external", id: "feishu:default" });
assert.deepEqual(externalScope("feishu", " oc_x "), { type: "external", id: "feishu:oc_x" });
assert.deepEqual(externalScope("feishu", "a:b"), { type: "external", id: "feishu:a:b" });
console.log("runtime-session-scope ok");
