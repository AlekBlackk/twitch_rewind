import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWindowAudio } from "../src/player/transcriber.js";

const bytesOf = (...values) => Uint8Array.from(values);
const signal = new AbortController().signal;

// What the page has: a server with `files`, and a decoder that "decodes" a file into its bytes as samples,
// except the files named in `broken`. `decoded` collects what the decoder was given.
function usePage(files, broken = []) {
  const decoded = [];
  globalThis.fetch = async (url) => (url in files
    ? new Response(files[url])
    : new Response("", { status: 404 }));
  globalThis.OfflineAudioContext = class {
    async decodeAudioData(buffer) {
      const bytes = new Uint8Array(buffer);
      decoded.push([...bytes]);
      if (broken.includes(bytes[0])) throw new DOMException("cannot decode", "EncodingError");
      return { numberOfChannels: 1, length: bytes.length, getChannelData: () => Float32Array.from(bytes) };
    }
  };
  return decoded;
}

// 3 s of audio at 16 kHz is too long to write out: the window is 4 samples, one per second
test("an fMP4 segment is decoded with its init segment in front of it", async () => {
  const decoded = usePage({ "https://cdn/init.mp4": bytesOf(1, 2), "https://cdn/0.mp4": bytesOf(9, 8, 7) });
  const audio = await loadWindowAudio({ start: 0, end: 0.001, segments: [{ url: "https://cdn/0.mp4", init: "https://cdn/init.mp4", start: 0, duration: 0.001 }] }, signal);
  assert.deepEqual(decoded, [[1, 2, 9, 8, 7]]);
  assert.deepEqual([...audio.subarray(0, 5)], [1, 2, 9, 8, 7]);
});

test("the init segment is fetched once for all the segments that follow it", async () => {
  let fetched = 0;
  usePage({ "https://cdn/init.mp4": bytesOf(1), "https://cdn/0.mp4": bytesOf(5), "https://cdn/1.mp4": bytesOf(6) });
  const fetchOnce = globalThis.fetch;
  globalThis.fetch = (url) => (url.endsWith("init.mp4") && fetched++, fetchOnce(url));
  const init = "https://cdn/init.mp4";
  await loadWindowAudio({ start: 0, end: 0.002, segments: [
    { url: "https://cdn/0.mp4", init, start: 0, duration: 0.001 },
    { url: "https://cdn/1.mp4", init, start: 0.001, duration: 0.001 },
  ] }, signal);
  assert.equal(fetched, 1);
});

test("a segment that cannot be decoded stays silent, but a window where none can is an error", async () => {
  usePage({ "https://cdn/0.mp4": bytesOf(9, 9), "https://cdn/1.mp4": bytesOf(5, 5) }, [9]);
  const one = { url: "https://cdn/0.mp4", init: null, start: 0, duration: 0.001 };
  const two = { url: "https://cdn/1.mp4", init: null, start: 0.001, duration: 0.001 };
  const audio = await loadWindowAudio({ start: 0, end: 0.002, segments: [one, two] }, signal);
  assert.deepEqual([...audio.subarray(0, 18)], [...new Array(16).fill(0), 5, 5]);
  await assert.rejects(loadWindowAudio({ start: 0, end: 0.001, segments: [one] }, signal), /не смог декодировать/);
});
