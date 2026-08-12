import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AI_EMPLOYEE_BASE_TEMPLATE,
  AI_EMPLOYEE_TEMPLATE_SKILLS,
  AI_EMPLOYEE_TEMPLATES,
  AI_EMPLOYEE_TONE_LABELS,
  defaultAIEmployeeProfile,
  getPublicAIEmployeeTemplateCatalog,
  aiEmployeeToneLabel,
} from "./protocol";

test("feishu_customer_service template declares lark skills", () => {
  const skills = AI_EMPLOYEE_TEMPLATE_SKILLS.feishu_customer_service;
  assert.deepEqual(skills, ["reference-index-builder", "lark-shared", "lark-im", "lark-wiki", "lark-doc", "lark-drive", "lark-sheets"]);
});

test("feishu_ai_employee template declares collaboration defaults", () => {
  const template = AI_EMPLOYEE_TEMPLATES.feishu_ai_employee;
  assert.equal(template.name, "飞书助理");
  assert.equal(template.requiresSandbox, true);
  assert.equal(template.defaultToolPolicy, undefined);
  assert.ok(template.defaultSkills.includes("lark-im"));
  assert.ok(template.defaultProfile.role.includes("团队协作助手"));
  assert.ok(template.defaultProfile.work_rules.includes("飞书群聊"));
  assert.ok(template.specialFields.some((field) => field.key === "reply_sink" && field.defaultValue === "direct_reply"));
  assert.equal(template.specialFields.some((field) => field.key === "personal_agent_trigger"), false);
});

test("defaultAIEmployeeProfile leaves feishu customer service role and rules empty", () => {
  const p = defaultAIEmployeeProfile("feishu_customer_service");
  assert.equal(p.role, "");
  assert.equal(p.work_rules, "");
  assert.ok(p.tone in AI_EMPLOYEE_TONE_LABELS);
});

test("aiEmployeeToneLabel maps every tone to a chinese label", () => {
  for (const tone of Object.keys(AI_EMPLOYEE_TONE_LABELS) as Array<keyof typeof AI_EMPLOYEE_TONE_LABELS>) {
    assert.ok(aiEmployeeToneLabel(tone).length > 0);
  }
  assert.equal(aiEmployeeToneLabel("professional_concise"), AI_EMPLOYEE_TONE_LABELS.professional_concise);
});

test("AI employee template definitions expose standard and template fields", () => {
  const standardKeys = AI_EMPLOYEE_BASE_TEMPLATE.standardFields.map((field) => field.key);
  assert.deepEqual(standardKeys, ["name", "role", "work_rules", "tone", "runtime", "model", "permission_mode"]);
  assert.equal(AI_EMPLOYEE_BASE_TEMPLATE.standardFields.find((field) => field.key === "work_rules")?.required, true);

  const feishu = AI_EMPLOYEE_TEMPLATES.feishu_customer_service;
  assert.equal(feishu.key, "feishu_customer_service");
  assert.ok(feishu.defaultSkills.includes("lark-im"));
  assert.ok(feishu.specialFields.some((field) => field.key === "feishu_app_id" && field.control === "text"));
  assert.ok(feishu.specialFields.some((field) => field.key === "feishu_app_secret" && field.control === "password" && field.secret === true));
  assert.ok(feishu.specialFields.some((field) => field.key === "reply_sink" && field.control === "select"));
  assert.deepEqual(feishu.defaultToolPolicy, {
    lark: {
      driveSearch: {
        mode: "work_rule_sources_only",
        allowedFolderTokens: [],
      },
      imSend: {
        mode: "controlled_by_reply_sink",
      },
    },
    webSearch: {
      mode: "allowed_after_source_miss",
    },
  });
});

test("public AI employee template catalog hides secret fields but keeps labels and options", () => {
  const catalog = getPublicAIEmployeeTemplateCatalog();
  const feishu = catalog.find((item) => item.key === "feishu_customer_service");
  assert.ok(feishu);
  assert.equal(feishu.defaultProfile.role, "");
  assert.equal(feishu.defaultProfile.work_rules, "");
  assert.equal(feishu.standardFields.find((field) => field.key === "work_rules")?.required, true);
  assert.ok(feishu.standardFields.some((field) => field.key === "tone" && field.control === "select" && field.options?.length));
  assert.ok(feishu.specialFields.some((field) => field.key === "reply_sink" && field.control === "select" && field.options?.some((option) => option.value === "direct_reply")));
  const secretField = feishu.specialFields.find((field) => field.key === "feishu_app_secret");
  assert.ok(secretField);
  assert.equal(secretField.configVisibility, "masked");
  assert.equal("secret" in secretField, false);
  assert.equal("defaultToolPolicy" in feishu, false);

  const collaboration = catalog.find((item) => item.key === "feishu_ai_employee");
  assert.ok(collaboration);
  assert.equal(collaboration.name, "飞书助理");
  assert.equal(collaboration.requiresSandbox, true);
  assert.ok(collaboration.defaultProfile.role.includes("团队协作助手"));
  assert.ok(collaboration.defaultProfile.work_rules.includes("飞书群聊"));
  assert.equal("defaultToolPolicy" in collaboration, false);
  assert.ok(collaboration.specialFields.some((field) => field.key === "reply_sink" && field.defaultValue === "direct_reply"));
  assert.equal(collaboration.specialFields.some((field) => field.key === "personal_agent_trigger"), false);
});

test("feishu customer service template declares separated setup steps and permission groups", () => {
  const feishu = AI_EMPLOYEE_TEMPLATES.feishu_customer_service;
  assert.deepEqual(feishu.setupSteps, [
    "credential_check",
    "permission_inspector",
    "bot_capability",
    "platform_permissions",
    "connection_check",
    "user_auth",
  ]);
  assert.deepEqual(feishu.permissionGroups?.inspector.scopes, [
    "admin:app.info:readonly",
    "application:application:self_manage",
  ]);
  assert.ok(feishu.permissionGroups?.business_user_auth.scopes.includes("offline_access"));
  assert.ok(feishu.permissionGroups?.business_user_auth.scopes.includes("space:document:retrieve"));
  assert.deepEqual(feishu.permissionGroups?.bot_messaging.scopes, [
    "im:message.p2p_msg:readonly",
    "im:message.group_at_msg:readonly",
    "im:message.group_at_msg.include_bot:readonly",
    "im:message:send_as_bot",
  ]);

  const publicFeishu = getPublicAIEmployeeTemplateCatalog().find((item) => item.key === "feishu_customer_service");
  assert.ok(publicFeishu?.permissionGroups?.inspector.scopes.includes("admin:app.info:readonly"));
  assert.ok(publicFeishu?.setupSteps?.includes("platform_permissions"));
});
