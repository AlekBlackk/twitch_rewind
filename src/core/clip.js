// A clip is cut from the HLS segments of the current quality: the parts are downloaded and put into
// an MP4 file without re-encoding, so the clip starts and ends on a segment boundary.
import { toPlainMp4 } from "./mp4.js";

export const MIN_CLIP_SECONDS = 5;
export const MAX_CLIP_SECONDS = 60;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** `range` ({from, to}) with one edge moved to `time`, kept inside `bounds` and the allowed clip length. */
export function moveEdge(range, edge, time, bounds) {
  if (edge === "from") {
    const earliest = Math.max(bounds.min, range.to - MAX_CLIP_SECONDS);
    return { from: clamp(time, earliest, range.to - MIN_CLIP_SECONDS), to: range.to };
  }
  const latest = Math.min(bounds.max, range.from + MAX_CLIP_SECONDS);
  return { from: range.from, to: clamp(time, range.from + MIN_CLIP_SECONDS, latest) };
}

/** `range` moved by `seconds`, keeping its length and staying inside `bounds`. */
export function shiftRange({ from, to }, seconds, bounds) {
  const shift = clamp(seconds, bounds.min - from, bounds.max - to);
  return { from: from + shift, to: to + shift };
}

/** The clip title as a file name: characters Windows does not allow in names are replaced. */
export const clipFileName = (title) => `${title.trim().replace(/[\/:*?"<>|]+/g, "_")}.mp4`;

/** The segments that overlap [start, end] seconds of the broadcast. */
export function clipFragments(fragments, start, end) {
  return fragments.filter((fragment) => fragment.start < end && fragment.start + fragment.duration > start);
}

// Finished VODs list muted parts as "N-unmuted.ts" while the file is stored as "N-muted.ts".
export const storedUrl = (url) => url.replace("-unmuted.", "-muted.");

async function fetchBytes(url) {
  const response = await fetch(storedUrl(url));
  if (!response.ok) throw new Error(`Twitch ответил ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// mux.js (vendor/mux.min.js, loaded by the page) repackages MPEG-TS into fragmented MP4 (toPlainMp4 finishes).
function transmux(parts) {
  const transmuxer = new globalThis.muxjs.mp4.Transmuxer();
  const mp4 = [];
  transmuxer.on("data", ({ initSegment, data }) => {
    if (!mp4.length) mp4.push(initSegment);
    mp4.push(data);
  });
  // one segment at a time: the video and audio of the clip then alternate in the file, as players expect
  for (const part of parts) {
    transmuxer.push(part);
    transmuxer.flush();
  }
  if (!mp4.length) throw new Error("в записи нет видео");
  return { init: mp4[0], parts: mp4.slice(1) };
}

const MPEG_TS_SYNC_BYTE = 0x47;

/** The segments `fragments` (hls.js fragments, in order) as one MP4 file. */
export async function fetchClip(fragments) {
  const [init, ...parts] = await Promise.all([
    fragments[0].initSegment ? fetchBytes(fragments[0].initSegment.url) : null,
    ...fragments.map((fragment) => fetchBytes(fragment.url)),
  ]);
  // Segments are .ts on some channels and fMP4 (an init segment and the parts) on others.
  if (parts[0][0] === MPEG_TS_SYNC_BYTE) {
    const fragmented = transmux(parts);
    return toPlainMp4(fragmented.init, fragmented.parts);
  }
  return toPlainMp4(init, parts);
}
