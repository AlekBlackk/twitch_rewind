// The speech model (Whisper) is downloaded once, from Hugging Face, and kept in the origin private file
// system. Chrome cannot put a file of hundreds of megabytes into the Cache API (it fails with "Unexpected
// internal error") and the model has files of over a gigabyte, so transformers.js is given this cache instead.
// A write that is interrupted leaves an empty file (the data is only committed when the stream closes), so an
// empty file counts as missing: otherwise the model would be taken for downloaded and never fetched again.

export const MODEL = "onnx-community/whisper-large-v3-turbo";
export const MODEL_SIZE_GB = 1.6;

// The two big files, which are the model; the small ones (config, tokenizer) come in a second.
const WEIGHTS = ["onnx/encoder_model_fp16.onnx", "onnx/decoder_model_merged_fp16.onnx"];

const fileNameOf = (key) => key.replace(/[^\w.-]/g, "_");
const urlOf = (file) => `https://huggingface.co/${MODEL}/resolve/main/${file}`;

/** The stored file, or throws when there is none or it is empty. */
async function storedFile(directory, name) {
  const file = await (await directory.getFileHandle(name)).getFile();
  if (!file.size) throw new Error("empty file");
  return file;
}

/** The `match` and `put` of the Web Cache API, which is what transformers.js asks of a custom cache. */
export const modelCache = {
  async match(key) {
    try {
      const file = await storedFile(await navigator.storage.getDirectory(), fileNameOf(key));
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
    storedFile(directory, fileNameOf(urlOf(file))).then(() => true, () => false)));
  return found.every(Boolean);
}
