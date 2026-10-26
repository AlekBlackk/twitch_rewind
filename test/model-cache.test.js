import { test } from "node:test";
import assert from "node:assert/strict";
import { isModelDownloaded } from "../src/core/model-cache.js";

// A directory of the origin private file system that holds `names`.
function useFiles(names) {
  const directory = {
    getFileHandle: async (name) => {
      if (!names.includes(name)) throw new DOMException("not found", "NotFoundError");
      return {};
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: { storage: { getDirectory: async () => directory } }, configurable: true });
}

const prefix = "https___huggingface.co_onnx-community_whisper-large-v3-turbo_resolve_main_onnx_";
const encoder = `${prefix}encoder_model_fp16.onnx`;
const decoder = `${prefix}decoder_model_merged_fp16.onnx`;

test("isModelDownloaded needs both big files of the model", async () => {
  useFiles([encoder, decoder, `${prefix}other.onnx`]);
  assert.equal(await isModelDownloaded(), true);
  useFiles([encoder]);
  assert.equal(await isModelDownloaded(), false);
  useFiles([]);
  assert.equal(await isModelDownloaded(), false);
});
