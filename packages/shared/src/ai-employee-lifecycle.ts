import type { AIEmployeeActivity, AIEmployeeDaemonState, AIEmployeeLifecycle } from "./protocol";

/**
 * Server-owned authoritative runtime/provisioning lifecycle of an AI employee.
 * Orthogonal to {@link AIEmployeeActivity} (momentary work) and to business
 * status (enablement). UIs render from `(lifecycle, activity)` instead of
 * reconciling daemon_state / legacy presentation strings.
 */
export type { AIEmployeeLifecycle } from "./protocol";

export interface AIEmployeeLifecycleInput {
  /** Whether the owning machine's daemon is connected. */
  machineOnline: boolean;
  /** Raw daemon-reported state (daemon -> Server internal signal). */
  daemonState: AIEmployeeDaemonState;
  /** Momentary activity while lifecycle is active. */
  activity: AIEmployeeActivity;
  /** Structured signal that the workspace has been initialized. */
  workspaceReady: boolean;
  /** Server-orchestrated transient that has no daemon_state equivalent. */
  pendingTransition?: "stopping";
}

export function computeAIEmployeeLifecycle(input: AIEmployeeLifecycleInput): AIEmployeeLifecycle {
  if (!input.machineOnline) return "offline";
  if (input.pendingTransition === "stopping") return "stopping";

  switch (input.daemonState) {
    case "applying_profile":
      return "applying_profile";
    case "restarting_fresh":
      return "restarting";
    case "initializing":
      return "starting";
    case "profile_update_failed":
      return "error";
    case "active":
    case "wakeable":
      return "active";
    case "inactive":
      return input.workspaceReady ? "ready" : "not_provisioned";
    case "unavailable":
    default:
      return "not_provisioned";
  }
}
