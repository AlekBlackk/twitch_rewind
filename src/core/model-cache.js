// The speech model (Whisper) is downloaded once, from Hugging Face, and kept in the origin private file
// system. Chrome cannot put a file of hundreds of megabytes into the Cache API (it fails with "Unexpected
// internal error") and the model has files of over a gigabyte, so transformers.js is given this cache instead.
// A file is written whole or not at all: an interrupted download leaves nothing behind.

export const MODEL = "onnx-community/whisper-large-v3-turbo";
export const MODEL_SIZE_GB = 1.6;

// The two big files, which are the model; the small ones (config, tokenizer) come in a second.
const WEIGHTS = ["onnx/encoder_model_fp16.onnx", "onnx/decoder_model_merged_fp16.onnx"];

const fileNameOf = (key) => key.replace(/[^\w.-]/g, "_");
const urlOf = (file) => `https://huggingface.co/${MODEL}/resolve/main/${file}`;

/** The `match` and `put` of the Web Cache API, which is what transformers.js asks of a custom cache. */
export const modelCache = {
  async match(key) {
    try {
      const directory = await navigator.storage.getDirectory();
      const file = await (await directory.getFileHandle(fileNameOf(key))).getFile();
      return new Response(file.stream(), { headers: { "content-length": String(file.size) } });
    } catch {
      return undefined; // not downloaded yet
    }
  },
  async put(key, response) {
    const directory = await navigator.storage.getDirectory();
    const handle = await directory.getFileHandle(fileNameOf(key), { create: true });
    await response.body.pipeTo(await handle.createWritable());
  },
};

/** Whether the model is already on this computer, so that using it needs no download. */
export async function isModelDownloaded(files = WEIGHTS) {
  const directory = await navigator.storage.getDirectory();
  const found = await Promise.all(files.map((file) =>
    directory.getFileHandle(fileNameOf(urlOf(file))).then(() => true, () => false)));
  return found.every(Boolean);
}
