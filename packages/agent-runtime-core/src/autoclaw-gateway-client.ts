import crypto from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const PROTOCOL_VERSION = 4;
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";
const identityLoads = new Map<string, Promise<DeviceIdentity>>();

interface DeviceIdentity {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

interface DeviceAuthRecord {
  deviceToken: string;
  scopes: string[];
}

interface GatewayErrorShape {
  code?: string;
  message?: string;
  details?: unknown;
}

interface GatewayResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: GatewayErrorShape;
}

export interface AutoClawGatewayEvent {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
}

export interface AutoClawGatewayOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  gatewayUrl?: string;
  stateDir?: string;
  daemonStateDir?: string;
  connectTimeoutMs?: number;
  clientDisplayName?: string;
  clientVersion?: string;
}

export interface AutoClawGatewayHello {
  server?: { version?: string; connId?: string };
  auth?: { deviceToken?: string; role?: string; scopes?: string[] };
  features?: { methods?: string[]; events?: string[] };
}

export class AutoClawGatewayError extends Error {
  constructor(message: string, readonly code?: string, readonly details?: unknown) {
    super(message);
    this.name = "AutoClawGatewayError";
  }

  get pairingRequired(): boolean {
    const text = `${this.code ?? ""} ${this.message}`.toLowerCase();
    return text.includes("pair") || text.includes("device") && text.includes("scope");
  }
}

export class AutoClawGatewayClient {
  private socket?: WebSocket;
  private requestSequence = 0;
  private hello?: AutoClawGatewayHello;
  private readonly pending = new Map<string, {
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<(event: AutoClawGatewayEvent) => void>();

  constructor(private readonly options: AutoClawGatewayOptions = {}) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && Boolean(this.hello);
  }

  get serverVersion(): string | undefined {
    return this.hello?.server?.version;
  }

  async connect(scopes: string[] = ["operator.read", "operator.write"]): Promise<AutoClawGatewayHello> {
    if (this.connected && scopes.every((scope) => this.hello?.auth?.scopes?.includes(scope))) {
      return this.hello!;
    }
    await this.close();
    const identity = await this.loadOrCreateIdentity();
    const gatewayToken = await this.readGatewayToken();
    const storedAuth = await this.readDeviceAuth();
    const authToken = storedAuth?.deviceToken ?? gatewayToken;
    if (!authToken) {
      throw new AutoClawGatewayError("AutoClaw Gateway token not found", "NOT_AUTHENTICATED");
    }

    const timeoutMs = this.options.connectTimeoutMs ?? 10_000;
    return await new Promise<AutoClawGatewayHello>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        this.socket?.close();
        finishReject(new AutoClawGatewayError("AutoClaw Gateway connection timed out", "TIMEOUT"));
      }, timeoutMs);
      const socket = new WebSocket(this.gatewayUrl());
      this.socket = socket;
      socket.on("message", (data) => {
        let frame: unknown;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (isGatewayEvent(frame) && frame.event === "connect.challenge") {
          const nonce = readString((frame.payload as Record<string, unknown> | undefined)?.nonce);
          if (!nonce) {
            finishReject(new AutoClawGatewayError("AutoClaw Gateway challenge did not include a nonce", "INVALID_CHALLENGE"));
            return;
          }
          const signedAt = Date.now();
          const publicKey = rawPublicKeyBase64Url(identity.publicKeyPem);
          const payload = buildDeviceAuthPayload({
            deviceId: identity.deviceId,
            scopes,
            signedAt,
            token: authToken,
            nonce,
          });
          const signature = crypto.sign(null, Buffer.from(payload), identity.privateKeyPem).toString("base64url");
          const id = this.nextRequestId();
          const responseTimer = setTimeout(() => {
            this.pending.delete(id);
            finishReject(new AutoClawGatewayError("AutoClaw Gateway handshake timed out", "TIMEOUT"));
          }, timeoutMs);
          this.pending.set(id, {
            resolve: (value) => {
              const hello = value as AutoClawGatewayHello;
              this.hello = hello;
              void this.storeDeviceAuth(hello.auth).catch(() => undefined);
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(hello);
              }
            },
            reject: finishReject,
            timer: responseTimer,
          });
          socket.send(JSON.stringify({
            type: "req",
            id,
            method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: CLIENT_ID,
                displayName: this.options.clientDisplayName ?? "NiuMa daemon",
                version: this.options.clientVersion ?? "niuma-daemon",
                platform: process.platform,
                mode: CLIENT_MODE,
              },
              role: "operator",
              scopes,
              auth: storedAuth?.deviceToken
                ? { deviceToken: storedAuth.deviceToken }
                : { token: gatewayToken },
              device: {
                id: identity.deviceId,
                publicKey,
                signature,
                signedAt,
                nonce,
              },
            },
          }));
          return;
        }
        this.handleFrame(frame);
      });
      socket.on("error", (error) => finishReject(error));
      socket.on("close", () => {
        this.hello = undefined;
        this.flushPending(new AutoClawGatewayError("AutoClaw Gateway connection closed", "CONNECTION_CLOSED"));
        finishReject(new AutoClawGatewayError("AutoClaw Gateway connection closed during handshake", "CONNECTION_CLOSED"));
      });
    });
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.connected || !this.socket) {
      throw new AutoClawGatewayError("AutoClaw Gateway is not connected", "NOT_CONNECTED");
    }
    const id = this.nextRequestId();
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AutoClawGatewayError(`AutoClaw Gateway request timed out: ${method}`, "TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.socket!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  onEvent(listener: (event: AutoClawGatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.hello = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
      setTimeout(resolve, 500).unref?.();
    });
  }

  private handleFrame(frame: unknown): void {
    if (isGatewayResponse(frame)) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(new AutoClawGatewayError(
          frame.error?.message ?? "AutoClaw Gateway request failed",
          frame.error?.code,
          frame.error?.details,
        ));
      }
      return;
    }
    if (isGatewayEvent(frame)) {
      for (const listener of this.listeners) listener(frame);
    }
  }

  private flushPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `wm-${Date.now()}-${this.requestSequence}`;
  }

  private gatewayUrl(): string {
    const raw = this.options.gatewayUrl ?? this.env().AUTOCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
    return raw.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  }

  private stateDir(): string {
    return this.options.stateDir ?? this.env().AUTOCLAW_STATE_DIR ?? path.join(this.homeDir(), ".openclaw-autoclaw");
  }

  private daemonStateDir(): string {
    return this.options.daemonStateDir ?? this.env().AUTOCLAW_DAEMON_STATE_DIR ?? path.join(this.homeDir(), ".wm", "autoclaw");
  }

  private homeDir(): string {
    return this.options.homeDir ?? os.homedir();
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private async readGatewayToken(): Promise<string | undefined> {
    return readFile(path.join(this.stateDir(), ".gateway-token"), "utf8")
      .then((value) => value.trim() || undefined)
      .catch(() => undefined);
  }

  private async loadOrCreateIdentity(): Promise<DeviceIdentity> {
    const filePath = path.join(this.daemonStateDir(), "identity.json");
    const existingLoad = identityLoads.get(filePath);
    if (existingLoad) return existingLoad;
    const load = this.readOrCreateIdentity(filePath).finally(() => {
      if (identityLoads.get(filePath) === load) identityLoads.delete(filePath);
    });
    identityLoads.set(filePath, load);
    return load;
  }

  private async readOrCreateIdentity(filePath: string): Promise<DeviceIdentity> {
    const existing = await readJson<DeviceIdentity>(filePath);
    if (existing?.version === 1 && existing.deviceId && existing.publicKeyPem && existing.privateKeyPem) {
      return existing;
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const identity: DeviceIdentity = {
      version: 1,
      deviceId: fingerprintPublicKey(publicKeyPem),
      publicKeyPem,
      privateKeyPem,
      createdAtMs: Date.now(),
    };
    await writePrivateJson(filePath, identity);
    return identity;
  }

  private async readDeviceAuth(): Promise<DeviceAuthRecord | undefined> {
    const record = await readJson<DeviceAuthRecord>(path.join(this.daemonStateDir(), "device-auth.json"));
    return record?.deviceToken ? record : undefined;
  }

  private async storeDeviceAuth(auth: AutoClawGatewayHello["auth"]): Promise<void> {
    if (!auth?.deviceToken) return;
    await writePrivateJson(path.join(this.daemonStateDir(), "device-auth.json"), {
      deviceToken: auth.deviceToken,
      scopes: auth.scopes ?? [],
    } satisfies DeviceAuthRecord);
  }
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  scopes: string[];
  signedAt: number;
  token: string;
  nonce: string;
}): string {
  return [
    "v3",
    params.deviceId,
    CLIENT_ID,
    CLIENT_MODE,
    "operator",
    params.scopes.join(","),
    String(params.signedAt),
    params.token,
    params.nonce,
    process.platform.toLowerCase(),
    "",
  ].join("|");
}

function rawPublicKeyBase64Url(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return Buffer.from(der).subarray(-32).toString("base64url");
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(Buffer.from(rawPublicKeyBase64Url(publicKeyPem), "base64url")).digest("hex");
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  return readFile(filePath, "utf8").then((value) => JSON.parse(value) as T).catch(() => undefined);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isGatewayResponse(value: unknown): value is GatewayResponseFrame {
  return Boolean(value) && typeof value === "object" && (value as { type?: unknown }).type === "res"
    && typeof (value as { id?: unknown }).id === "string";
}

function isGatewayEvent(value: unknown): value is AutoClawGatewayEvent {
  return Boolean(value) && typeof value === "object" && (value as { type?: unknown }).type === "event"
    && typeof (value as { event?: unknown }).event === "string";
}

export function autoClawStateDir(options: Pick<AutoClawGatewayOptions, "env" | "homeDir" | "stateDir"> = {}): string {
  return options.stateDir ?? options.env?.AUTOCLAW_STATE_DIR ?? path.join(options.homeDir ?? os.homedir(), ".openclaw-autoclaw");
}

export function autoClawGatewayUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTOCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
}
