import assert from "node:assert/strict";
import { validateProxySpecV1 } from "./proxy-spec";

const baseSpec = {
  version: 1,
  name: "客户群价格咨询代理",
  owner_human_id: "admin",
  ai_employee_id: "codex-01",
  source: {
    type: "feishu_message",
    scope: "chat",
    chat_refs: [{ kind: "chat_name", value: "客户群" }],
  },
  focus: {
    description: "客户询问价格、套餐、报价、折扣、购买方式时处理",
    examples: ["多少钱", "有没有优惠"],
  },
  context: [{ type: "text", title: "标准报价", value: "基础版 99 元/月" }],
  action: { type: "draft_reply", destination: "inbox" },
  policy: {
    approval_required: "always",
    ask_user_when: ["涉及折扣", "信息不确定"],
    forbidden_actions: ["未经确认直接发送飞书消息"],
  },
};

{
  const result = validateProxySpecV1(baseSpec);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.spec.source.type, "feishu_message");
    assert.equal(result.spec.action.destination, "inbox");
  }
}

{
  const result = validateProxySpecV1({
    ...baseSpec,
    source: { ...baseSpec.source, group_mentions_only: true },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.spec.source.group_mentions_only, true);
}

{
  const result = validateProxySpecV1({
    ...baseSpec,
    source: { ...baseSpec.source, group_mentions_only: "yes" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join("\n"), /group_mentions_only/);
}

{
  const result = validateProxySpecV1({ ...baseSpec, source: { type: "github_issue" } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join("\n"), /source.type/);
}

{
  const result = validateProxySpecV1({
    ...baseSpec,
    policy: { ...baseSpec.policy, approval_required: "never" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join("\n"), /approval_required/);
}

{
  const result = validateProxySpecV1({
    ...baseSpec,
    action: { type: "send_reply", destination: "feishu" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join("\n"), /action/);
}
