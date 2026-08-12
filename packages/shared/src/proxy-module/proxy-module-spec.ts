import type { ProxyModuleSpec, ProxyModuleTrigger } from "../protocol";

export type ProxyModuleSpecValidationResult =
  | { ok: true; spec: ProxyModuleSpec }
  | { ok: false; errors: string[] };

const ALLOWED_FIELDS = new Set(["kind", "version", "name", "description", "trigger"]);
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86_400;
const MAX_NAME_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 500;

export function normalizeProxyModuleSpec(input: unknown): ProxyModuleSpec {
  const result = validateProxyModuleSpec(input);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.spec;
}

export function validateProxyModuleSpec(input: unknown): ProxyModuleSpecValidationResult {
  const errors: string[] = [];
  const raw = objectValue(input);
  if (!raw) return { ok: false, errors: ["proxy module spec must be an object"] };

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) errors.push(`unknown field: ${key}`);
  }
  if (raw.kind !== "proxy_module") errors.push("kind must be proxy_module");
  if (raw.version !== 1) errors.push("version must be 1");

  const name = stringValue(raw.name);
  if (!name) errors.push("name is required");
  else if (name.length > MAX_NAME_LENGTH) errors.push(`name must be <= ${MAX_NAME_LENGTH} chars`);

  const description = stringValue(raw.description);
  if (!description) errors.push("description is required");
  else if (description.length > MAX_DESCRIPTION_LENGTH) errors.push(`description must be <= ${MAX_DESCRIPTION_LENGTH} chars`);

  const trigger = normalizeTrigger(raw.trigger, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: { kind: "proxy_module", version: 1, name, description, trigger } };
}

export function isProxyModuleSpec(input: unknown): input is ProxyModuleSpec {
  return objectValue(input)?.kind === "proxy_module";
}

/** @deprecated connectors are no longer part of ProxyModuleSpec; this shim is a no-op */
export function redactProxyModuleSpec(spec: ProxyModuleSpec): ProxyModuleSpec {
  return spec;
}

function normalizeTrigger(value: unknown, errors: string[]): ProxyModuleTrigger {
  const trigger = objectValue(value);
  if (!trigger) {
    errors.push("trigger must be an object");
    return { type: "interval", interval_seconds: 180 };
  }
  if (trigger.type === "event") {
    if ("interval_seconds" in trigger) errors.push("event trigger must not include interval_seconds");
    return { type: "event" };
  }
  if (trigger.type !== "interval") {
    errors.push("trigger.type must be interval or event");
    return { type: "interval", interval_seconds: 180 };
  }
  const interval = Number(trigger.interval_seconds);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
    errors.push(`interval_seconds must be integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`);
    return { type: "interval", interval_seconds: 180 };
  }
  return { type: "interval", interval_seconds: interval };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
