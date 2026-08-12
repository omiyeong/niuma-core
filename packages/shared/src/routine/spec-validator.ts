import type { RoutineSpec, RoutineStep } from "../protocol";

export type RoutineSpecValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

const REGISTERED_PRIMITIVES = new Set(["http_request", "filter", "dedupe", "foreach", "wake_agent"]);
const SECRET_KEY_PATTERN = /(?:client_secret|app_secret|password|token|access_token|refresh_token|secret)/i;
const APPROVAL_WORD_PATTERN = /确认|审批|批准|approve|approval/i;
const VAR_REF_PATTERN = /\$\{([^}]+)\}/g;
const FORBIDDEN_HEADER_PATTERN = /^cookie$/i;

export function validateRoutineSpec(input: unknown): RoutineSpecValidationResult {
  const errors: string[] = [];
  const spec = objectValue(input);
  if (!spec) return { ok: false, errors: ["spec must be an object"] };

  validateTrigger(spec.trigger, errors);
  validateAuth(spec.auth, errors);
  const steps = Array.isArray(spec.steps) ? spec.steps : undefined;
  if (!steps || steps.length === 0) {
    errors.push("steps must contain at least one step");
  } else {
    validateSteps(steps, errors);
  }
  validateInstructionPolicySeparation(spec, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

function validateTrigger(value: unknown, errors: string[]): void {
  const trigger = objectValue(value);
  if (!trigger) {
    errors.push("trigger must be an object");
    return;
  }
  if (trigger.kind !== "schedule" && trigger.kind !== "event") errors.push("trigger.kind must be schedule or event");
  if (trigger.kind === "event") return;
  const interval = Number(trigger.interval_seconds);
  if (!Number.isInteger(interval) || interval < 60 || interval > 86400) {
    errors.push("trigger.interval_seconds must be an integer between 60 and 86400");
  }
}

function validateAuth(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  const auth = objectValue(value);
  if (!auth) {
    errors.push("auth must be an object");
    return;
  }
  if (typeof auth.ref !== "string" || auth.ref.trim() === "") {
    errors.push("auth.ref must be a non-empty string");
  }
  for (const key of Object.keys(auth)) {
    if (key !== "ref" || SECRET_KEY_PATTERN.test(key)) {
      if (SECRET_KEY_PATTERN.test(key)) errors.push(`auth must not embed secret field ${key}`);
    }
  }
}

function validateSteps(rawSteps: unknown[], errors: string[]): void {
  const seen = new Set<string>();
  const completed = new Set<string>();
  for (const raw of rawSteps) {
    validateStep(raw, { errors, seen, completed, inForeach: false });
  }
}

function validateStep(
  raw: unknown,
  context: { errors: string[]; seen: Set<string>; completed: Set<string>; inForeach: boolean },
): void {
  const step = objectValue(raw) as (RoutineStep | undefined);
  if (!step) {
    context.errors.push("step must be an object");
    return;
  }
  if (typeof step.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(step.id)) {
    context.errors.push("step.id must be a valid identifier");
    return;
  }
  if (context.seen.has(step.id)) context.errors.push(`duplicate step id ${step.id}`);
  context.seen.add(step.id);
  if (!REGISTERED_PRIMITIVES.has(String(step.primitive))) {
    context.errors.push(`step ${step.id} uses unregistered primitive ${String(step.primitive)}`);
  }
  if (step.primitive === "http_request") validateHttpRequestSecurity(step, context.errors);
  if (step.primitive === "foreach") {
    if (context.inForeach) context.errors.push(`nested foreach is not allowed at step ${step.id}`);
    const input = objectValue(step.input);
    validateVarRefs(input ? omitKey(input, "do") : step.input, context.completed, context.errors, step.id);
    const childSteps = Array.isArray(input?.do) ? input.do : Array.isArray(step.do) ? step.do : undefined;
    if (childSteps) {
      const childCompleted = new Set(context.completed);
      for (const child of childSteps) {
        validateStep(child, {
          errors: context.errors,
          seen: context.seen,
          completed: childCompleted,
          inForeach: true,
        });
        if (objectValue(child)?.id) childCompleted.add(String(objectValue(child)?.id));
      }
    }
  } else {
    validateVarRefs(step.input, context.completed, context.errors, step.id);
  }
  context.completed.add(step.id);
}

function validateVarRefs(value: unknown, completedSteps: Set<string>, errors: string[], stepId: string): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(VAR_REF_PATTERN)) {
      const path = match[1]?.trim() ?? "";
      if (!path.startsWith("steps.")) continue;
      const referencedStep = path.split(".")[1];
      if (!referencedStep || !completedSteps.has(referencedStep)) {
        errors.push(`step ${stepId} references non-previous step ${referencedStep || path}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateVarRefs(item, completedSteps, errors, stepId);
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  for (const item of Object.values(object)) validateVarRefs(item, completedSteps, errors, stepId);
}

function validateInstructionPolicySeparation(spec: Record<string, unknown>, errors: string[]): void {
  const instruction = objectValue(spec.instruction);
  const handlingRules = Array.isArray(instruction?.handling_rules) ? instruction.handling_rules : [];
  for (const rule of handlingRules) {
    if (typeof rule === "string" && APPROVAL_WORD_PATTERN.test(rule)) {
      errors.push("instruction.handling_rules must not duplicate approval policy semantics");
      return;
    }
  }
}

function validateHttpRequestSecurity(step: RoutineStep, errors: string[]): void {
  const input = objectValue(step.input);
  if (!input) return;
  const url = typeof input.url === "string" ? input.url : undefined;
  if (url && !url.includes("${")) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") errors.push(`step ${step.id} http_request.url must use https`);
      if (isForbiddenHost(parsed.hostname)) errors.push(`step ${step.id} http_request.url must not target private or loopback hosts`);
    } catch {
      errors.push(`step ${step.id} http_request.url is invalid`);
    }
  }
  const headers = objectValue(input.headers);
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (FORBIDDEN_HEADER_PATTERN.test(key)) errors.push(`step ${step.id} http_request.headers must not include Cookie`);
    }
  }
}

function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function omitKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
