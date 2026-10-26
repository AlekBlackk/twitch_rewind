// Speech recognition in a worker, so the page stays responsive: Whisper large-v3-turbo on the GPU (WebGPU),
// and Silero VAD on the processor, which tells the speech in the audio from music, noise and silence.
// Messages in:  { id, type: "load" } | { id, type: "transcribe", audio: Float32Array (16 kHz), language }
// Messages out: { type: "progress", loaded, total } while the model downloads, then { id, result } or { id, error }.
import { AutoModel, env, pipeline, Tensor } from "../../vendor/transformers.bundle.min.js";
import { SAMPLE_RATE } from "../core/audio.js";
import { MODEL, modelCache } from "../core/model-cache.js";
import { FRAME_SAMPLES, speechSegments } from "../core/vad.js";

const VAD_MODEL = "onnx-community/silero-vad"; // 2 MB

env.useCustomCache = true;
env.customCache = modelCache;
env.allowLocalModels = false;
// The runtime is part of the extension (vendor/): remote code is not allowed. The cache would import it
// from a blob: URL, which the extension's content security policy forbids.
env.useWasmCache = false;
const runtime = new URL("../../vendor/ort-wasm-simd-threaded.asyncify", import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = { mjs: `${runtime}.mjs`, wasm: `${runtime}.wasm` };
env.backends.onnx.wasm.numThreads = 1; // the page is not cross-origin isolated, so there are no threads to use anyway

// Subtitle credits that Whisper writes from its training data over noise and music ("Субтитры сделал DimaTorzok")
const INVENTED = /субтитры\s+(?:сделал|создавал|делал|подогнал|добавил)\S*\s+\S+|редактор субтитров\s+\S+\s+\S+(?:\s+корректор\s+\S+\s+\S+)?/gi;

let recognizer = null;
let vad = null;

async function load() {
  if (!navigator.gpu) throw new Error("WebGPU недоступен: включите аппаратное ускорение в настройках Chrome");
  const files = new Map(); // file -> { loaded, total }
  const progress_callback = ({ status, file, loaded, total }) => {
    if (status !== "progress") return;
    files.set(file, { loaded, total });
    const sum = (key) => [...files.values()].reduce((all, f) => all + f[key], 0);
    postMessage({ type: "progress", loaded: sum("loaded"), total: sum("total") });
  };
  recognizer ??= await pipeline("automatic-speech-recognition", MODEL, { device: "webgpu", dtype: "fp16", progress_callback });
  // The VAD is a small recurrent model asked once per frame: on the processor, that is faster than a trip to the GPU each time.
  vad ??= await AutoModel.from_pretrained(VAD_MODEL, { config: { model_type: "custom" }, dtype: "fp32", device: "wasm", progress_callback });
}

/** The probability of speech in every frame of `audio`. */
async function speechProbabilities(audio) {
  const rate = new Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  let state = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const probabilities = new Float32Array(Math.floor(audio.length / FRAME_SAMPLES));
  for (let frame = 0; frame < probabilities.length; frame++) {
    const input = new Tensor("float32", audio.slice(frame * FRAME_SAMPLES, (frame + 1) * FRAME_SAMPLES), [1, FRAME_SAMPLES]);
    const { output, stateN } = await vad({ input, sr: rate, state });
    state = stateN;
    probabilities[frame] = output.data[0];
  }
  return probabilities;
}

/**
 * The speech of `audio` as [{ timestamp: [start, end], text }], in seconds from its start.
 * Only speech goes to Whisper, a stretch of it at a time: it starts and ends between phrases, so nothing is cut, and
 * the library's gluing of overlapping chunks (which once joined phrases from different places into one line) is not needed.
 */
async function transcribe({ audio, language }) {
  const lines = [];
  for (const { start, end } of speechSegments(await speechProbabilities(audio), audio.length / SAMPLE_RATE)) {
    const speech = audio.slice(Math.round(start * SAMPLE_RATE), Math.round(end * SAMPLE_RATE));
    const { chunks } = await recognizer(speech, { language, task: "transcribe", return_timestamps: true });
    for (const { timestamp, text } of chunks) {
      const cleaned = text.replace(INVENTED, "").replace(/\s{2,}/g, " ").trim();
      // Whisper repeats a phrase over music and noise: the same line twice in a row is dropped
      if (cleaned && cleaned !== lines.at(-1)?.text) {
        lines.push({ timestamp: [start + timestamp[0], timestamp[1] === null ? null : start + timestamp[1]], text: cleaned });
      }
    }
  }
  return lines;
}

onmessage = async ({ data: { id, type, ...request } }) => {
  try {
    postMessage({ id, result: type === "load" ? await load() : await transcribe(request) });
  } catch (error) {
    postMessage({ id, error: error.message ?? String(error) });
  }
};
