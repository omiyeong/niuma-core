import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDeliveredMessage,
  type AIEmployeeMemorySnapshotFile,
  type DeliveredMessage,
} from "./protocol";

const chunkedMemorySnapshotFile = {
  path: "MEMORY.md",
  byteLength: 6,
  hash: "file-hash",
  chunks: [{ index: 0, content: "记忆", byteLength: 6, hash: "chunk-hash" }],
} satisfies AIEmployeeMemorySnapshotFile;

test("AIEmployeeMemorySnapshotFile reserves negotiated v2 payloads without duplicated content", () => {
  assert.equal("content" in chunkedMemorySnapshotFile, false);
  assert.equal(chunkedMemorySnapshotFile.chunks[0]?.index, 0);
  assert.equal(chunkedMemorySnapshotFile.byteLength, 6);
});

function deliveredMessage(overrides: Partial<DeliveredMessage> = {}): DeliveredMessage {
  return {
    target: "#all",
    message_id: "msg-attachment",
    seq: 1,
    timestamp: "2026-06-22T00:00:00.000Z",
    sender_type: "human",
    sender_name: "admin",
    content: "看这张图",
    ...overrides,
  };
}

test("formatDeliveredMessage includes materialized attachment local path", () => {
  const rendered = formatDeliveredMessage(deliveredMessage({
    attachments: [{
      id: "att-image",
      filename: "pasted-image.png",
      mime_type: "image/png",
      size: 1234,
      local_path: "/tmp/agent/.wm/attachments/msg-attachment/pasted-image.png",
    }],
  }));

  assert.match(rendered, /pasted-image\.png/);
  assert.match(rendered, /local:\/tmp\/agent\/\.wm\/attachments\/msg-attachment\/pasted-image\.png/);
  assert.match(rendered, /type:image\/png/);
  assert.doesNotMatch(rendered, /use wm attachment view to download/);
});

test("formatDeliveredMessage keeps attachment download fallback when not materialized", () => {
  const rendered = formatDeliveredMessage(deliveredMessage({
    attachments: [{
      id: "att-file",
      filename: "brief.pdf",
      download_error: "HTTP 404",
    }],
  }));

  assert.match(rendered, /brief\.pdf/);
  assert.match(rendered, /download_error:HTTP 404/);
  assert.match(rendered, /use wm attachment view to download/);
});
