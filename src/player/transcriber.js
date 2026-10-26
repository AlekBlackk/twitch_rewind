// Recognizes the speech of a broadcast window by window (see transcript.js) and keeps the result.
// The audio comes from the lightest rendition of the DVR, which is a few hundred kilobytes per
// minute (a 6 hour stream is ~300 MB), is decoded here and recognized by whisper-worker.js on the GPU.
import { adtsFromTs, decodeAudio, SAMPLE_RATE } from "../core/audio.js";
import { storedUrl } from "../core/clip.js";
import {
  addLines, endOf, LIVE_WINDOW_SECONDS, loadTranscript, parseAudioPlaylist, saveTranscript, TAIL_SECONDS, WINDOW_SECONDS,
  windowSegments,
} from "../core/transcript.js";

const AUDIO_RENDITIONS = ["audio_only", "160p30", "chunked"]; // the first that exists
const LIVE_POLL_MS = 15000;
const SILENCE_LEVEL = 0.001; // RMS below this is not speech: no need to run the model on it (and it would invent words)

async function fetchWithRetry(url, signal, read) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Twitch ответил ${response.status}`);
      return await read(response);
    } catch (error) {
      if (signal.aborted || attempt) throw error;
    }
  }
}

async function findAudioPlaylist(playlistUrl, signal) {
  const base = playlistUrl.match(/^(.+)\/chunked\/index-dvr\.m3u8$/)?.[1];
  for (const name of base ? AUDIO_RENDITIONS : []) {
    const url = `${base}/${name}/index-dvr.m3u8`;
    const text = await fetch(url, { signal }).then((r) => (r.ok ? r.text() : ""), () => "");
    if (text.includes("#EXTINF")) return url;
  }
  if (signal.aborted) throw signal.reason;
  return playlistUrl;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
});

const isSilent = (samples) => Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length) < SILENCE_LEVEL;

// The samples of the window, each segment at its place. A segment that cannot be decoded stays silent.
async function loadWindowAudio({ start, end, segments }, signal) {
  const audio = new Float32Array(Math.ceil((end - start) * SAMPLE_RATE));
  await Promise.all(segments.map(async (segment) => {
    const bytes = await fetchWithRetry(storedUrl(segment.url), signal, async (r) => new Uint8Array(await r.arrayBuffer()));
    const adts = adtsFromTs(bytes);
    const samples = adts.length ? await decodeAudio(adts).catch(() => null) : null;
    if (!samples) return;
    const offset = Math.round((segment.start - start) * SAMPLE_RATE);
    audio.set(samples.subarray(0, audio.length - offset), offset);
  }));
  return audio;
}

export function createTranscriber() {
  let worker = null;
  let nextId = 0;
  const pending = new Map();
  let onLoadProgress = () => {};

  const ask = (message, transfer = []) => {
    worker ??= startWorker();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id }, transfer);
    });
  };

  function startWorker() {
    const created = new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
    created.onmessage = ({ data }) => {
      if (data.type === "progress") return onLoadProgress(data);
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    created.onerror = (event) => {
      for (const request of pending.values()) request.reject(new Error(event.message || "ошибка воркера"));
      pending.clear();
    };
    return created;
  }

  return {
    /**
     * Recognizes the broadcast from where it stopped last time until its end; on a live one, keeps
     * waiting for more audio. Returns when the broadcast is done or `signal` aborts.
     * `onLoading({ loaded, total })` reports the model download, `onProgress(transcript, total)` each recognized window.
     */
    async run({ playlistUrl, streamId, ended, language, signal, onLoading, onProgress }) {
      onLoadProgress = onLoading;
      const audioUrl = await findAudioPlaylist(playlistUrl, signal);
      let modelLoaded = false; // loaded when a window needs it: a broadcast that is done, or silent, never does
      let transcript = await loadTranscript(streamId);
      while (!signal.aborted) {
        const text = await fetchWithRetry(audioUrl, signal, (r) => r.text());
        const { segments, ended: playlistEnded } = parseAudioPlaylist(text, audioUrl);
        const total = endOf(segments);
        const finished = ended || playlistEnded;
        const from = transcript.doneTo;
        onProgress(transcript, total);
        if (finished && from >= total) return;

        const length = total - from >= WINDOW_SECONDS + TAIL_SECONDS ? WINDOW_SECONDS : LIVE_WINDOW_SECONDS;
        if (!finished && total - from < length + TAIL_SECONDS) {
          await sleep(LIVE_POLL_MS, signal); // the audio of the next window is not there yet
          continue;
        }
        const window = windowSegments(segments, from, length);
        const audio = await loadWindowAudio(window, signal);
        if (signal.aborted) return;
        let chunks = [];
        if (audio.length && !isSilent(audio)) {
          if (!modelLoaded) {
            onLoading({ loaded: 0, total: 0 });
            await ask({ type: "load" });
            onLoading(null);
            modelLoaded = true;
          }
          chunks = await ask({ type: "transcribe", audio, language: language || undefined }, [audio.buffer]);
        }
        transcript = addLines(transcript, chunks, window.start, from, from + length);
        await saveTranscript(streamId, transcript);
      }
    },

    close() {
      worker?.terminate();
      worker = null;
      for (const request of pending.values()) request.reject(new Error("распознавание остановлено"));
      pending.clear();
    },
  };
}
