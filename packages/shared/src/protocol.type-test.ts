import type { AIEmployeeMemorySnapshotFile, DaemonMsg_AIEmployeeResetWorkspaceResult } from "./protocol";

type Assert<T extends true> = T;
type IsAssignable<Candidate, Target> = [Candidate] extends [Target] ? true : false;
type Chunk = { index: 0; content: "记忆"; byteLength: 6; hash: "chunk-hash" };

type _ValidLegacy = Assert<IsAssignable<{
  path: "MEMORY.md";
  content: "legacy";
  hash: "file-hash";
}, AIEmployeeMemorySnapshotFile>>;

type _ValidV2 = Assert<IsAssignable<{
  path: "MEMORY.md";
  byteLength: 6;
  chunks: [Chunk];
  hash: "file-hash";
}, AIEmployeeMemorySnapshotFile>>;

// @ts-expect-error a snapshot with neither legacy content nor v2 chunks is incomplete
type _MissingPayloadMustFail = Assert<IsAssignable<{
  path: "MEMORY.md";
  hash: "file-hash";
}, AIEmployeeMemorySnapshotFile>>;

// @ts-expect-error byteLength without chunks is neither a complete legacy nor v2 snapshot
type _ByteLengthWithoutChunksMustFail = Assert<IsAssignable<{
  path: "MEMORY.md";
  content: "partial";
  byteLength: 7;
  hash: "file-hash";
}, AIEmployeeMemorySnapshotFile>>;

// @ts-expect-error chunks without byteLength is neither a complete legacy nor v2 snapshot
type _ChunksWithoutByteLengthMustFail = Assert<IsAssignable<{
  path: "MEMORY.md";
  chunks: [Chunk];
  hash: "file-hash";
}, AIEmployeeMemorySnapshotFile>>;

// @ts-expect-error a successful reset must identify the persisted memory generation
type _SuccessfulResetWithoutGenerationMustFail = Assert<IsAssignable<{
  type: "ai_employee:reset-workspace/result";
  requestId: "request";
  aiEmployeeId: "employee";
  ok: true;
}, DaemonMsg_AIEmployeeResetWorkspaceResult>>;
