import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface EmployeePrepareInput {
  employeeId: string;
  workspaceDir: string;
  runtime?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeSpawnInput {
  command: string;
  args: string[];
  cwd: string;
  workspaceDir?: string;
  runtime?: string;
  env?: NodeJS.ProcessEnv;
  employeeId: string;
  stdio?: "pipe" | "ignore" | "ignore-stdin";
  detached?: boolean;
}

export interface ExecutionBackend {
  readonly kind: "host" | "container";
  prepareEmployee(input: EmployeePrepareInput): Promise<void>;
  spawnRuntime(input: RuntimeSpawnInput): ChildProcessWithoutNullStreams;
  destroyEmployee(employeeId: string): Promise<void>;
}

export class HostBackend implements ExecutionBackend {
  readonly kind = "host" as const;

  async prepareEmployee(_input: EmployeePrepareInput): Promise<void> {
    // Host mode uses the existing local workspace directly.
  }

  spawnRuntime(input: RuntimeSpawnInput): ChildProcessWithoutNullStreams {
    return spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: stdioFor(input.stdio),
      detached: input.detached ?? process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
  }

  async destroyEmployee(_employeeId: string): Promise<void> {
    // Host mode has no per-employee container to clean up.
  }
}

function stdioFor(stdio: RuntimeSpawnInput["stdio"]): ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"] {
  if (stdio === "ignore") return ["ignore", "ignore", "ignore"];
  if (stdio === "ignore-stdin") return ["ignore", "pipe", "pipe"];
  return ["pipe", "pipe", "pipe"];
}

const defaultHostBackend = new HostBackend();

export function hostBackend(): ExecutionBackend {
  return defaultHostBackend;
}
