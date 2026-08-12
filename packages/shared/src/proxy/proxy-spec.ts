export type ProxySpecV1 = {
  version: 1;
  name: string;
  owner_human_id: string;
  ai_employee_id: string;
  source: FeishuMessageProxySource;
  focus: ProxyFocus;
  context: ProxyContext[];
  action: ProxyAction;
  policy: ProxyPolicy;
};

export type FeishuMessageProxySource = {
  type: "feishu_message";
  scope: "dm" | "chat" | "both";
  group_mentions_only?: boolean;
  chat_refs?: Array<{
    kind: "chat_id" | "chat_name";
    value: string;
  }>;
};

export type ProxyFocus = {
  description: string;
  examples?: string[];
};

export type ProxyContext = {
  type: "text" | "url" | "file";
  title?: string;
  value: string;
};

export type ProxyAction = {
  type: "draft_reply";
  destination: "inbox";
};

export type ProxyPolicy = {
  approval_required: "always";
  ask_user_when: string[];
  forbidden_actions: string[];
};

export type ProxySpecValidationResult =
  | { ok: true; spec: ProxySpecV1 }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

export function validateProxySpecV1(value: unknown): ProxySpecValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["spec must be an object"] };

  if (value.version !== 1) errors.push("version must be 1");
  if (!nonEmptyString(value.name)) errors.push("name must be a non-empty string");
  if (!nonEmptyString(value.owner_human_id)) errors.push("owner_human_id must be a non-empty string");
  if (!nonEmptyString(value.ai_employee_id)) errors.push("ai_employee_id must be a non-empty string");

  const source = value.source;
  if (!isRecord(source)) {
    errors.push("source must be an object");
  } else {
    if (source.type !== "feishu_message") errors.push("source.type must be feishu_message");
    if (source.scope !== "dm" && source.scope !== "chat" && source.scope !== "both") {
      errors.push("source.scope must be dm, chat, or both");
    }
    if ((source.scope === "chat" || source.scope === "both") && !Array.isArray(source.chat_refs)) {
      errors.push("source.chat_refs is required for chat or both scope");
    }
    if (source.group_mentions_only !== undefined && typeof source.group_mentions_only !== "boolean") {
      errors.push("source.group_mentions_only must be a boolean");
    }
    if (Array.isArray(source.chat_refs)) {
      for (const [index, ref] of source.chat_refs.entries()) {
        if (!isRecord(ref)) {
          errors.push(`source.chat_refs[${index}] must be an object`);
          continue;
        }
        if (ref.kind !== "chat_id" && ref.kind !== "chat_name") {
          errors.push(`source.chat_refs[${index}].kind must be chat_id or chat_name`);
        }
        if (!nonEmptyString(ref.value)) errors.push(`source.chat_refs[${index}].value must be a non-empty string`);
      }
    }
  }

  const focus = value.focus;
  if (!isRecord(focus)) {
    errors.push("focus must be an object");
  } else {
    if (!nonEmptyString(focus.description)) errors.push("focus.description must be a non-empty string");
    if (focus.examples !== undefined && !stringArray(focus.examples)) {
      errors.push("focus.examples must be an array of non-empty strings");
    }
  }

  if (!Array.isArray(value.context)) {
    errors.push("context must be an array");
  } else {
    for (const [index, item] of value.context.entries()) {
      if (!isRecord(item)) {
        errors.push(`context[${index}] must be an object`);
        continue;
      }
      if (item.type !== "text" && item.type !== "url" && item.type !== "file") {
        errors.push(`context[${index}].type must be text, url, or file`);
      }
      if (item.title !== undefined && typeof item.title !== "string") {
        errors.push(`context[${index}].title must be a string`);
      }
      if (!nonEmptyString(item.value)) errors.push(`context[${index}].value must be a non-empty string`);
    }
  }

  const action = value.action;
  if (!isRecord(action)) {
    errors.push("action must be an object");
  } else {
    if (action.type !== "draft_reply") errors.push("action.type must be draft_reply");
    if (action.destination !== "inbox") errors.push("action.destination must be inbox");
  }

  const policy = value.policy;
  if (!isRecord(policy)) {
    errors.push("policy must be an object");
  } else {
    if (policy.approval_required !== "always") errors.push("policy.approval_required must be always");
    if (!stringArray(policy.ask_user_when)) errors.push("policy.ask_user_when must be an array of non-empty strings");
    if (!stringArray(policy.forbidden_actions)) errors.push("policy.forbidden_actions must be an array of non-empty strings");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: value as ProxySpecV1 };
}
