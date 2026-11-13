// Frame preview over the seek bar, like Twitch's: hovering the bar shows the frame at that moment.
// Twitch's storyboard images exist only for some VODs, so the frame comes from a second, muted video
// that plays the lowest quality and is moved to the hovered moment. Its playlist is fetched when the
// broadcast opens (the long one of a many-hours stream is the slowest part of the first hover); segments
// only while the bar is hovered. Every frame shown is kept, so hovering the same place again is instant.
import { storedUrl } from "../core/clip.js";

const PREVIEW_BUFFER_SECONDS = 2; // a frame is needed, not playback: keep the download to about one segment
const SEEK_TIMEOUT_MS = 4000; // a seek that takes longer is stuck (a failed segment): the preview is started anew
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 108;
const CACHE_STEP_SECONDS = 2; // frames closer than this look the same on a bar this small
const CACHE_LIMIT = 300; // ~80 KB each

export function createSeekPreview({ seek, formatTime }) {
  const box = document.getElementById("seek-preview");
  const frame = box.querySelector("video");
  const picture = box.querySelector("canvas");
  const timeLabel = box.querySelector("span");
  const wrap = seek.parentElement;
  const context = picture.getContext("2d");

  let sourceUrl = null;
  let hls = null;
  let target = null; // moment to show; while a seek is running the newest hover waits here
  let seekTarget = null; // moment the running seek was started for
  let seeking = false;
  let seekTimer;
  const cache = new Map(); // step number -> ImageData

  const stepOf = (seconds) => Math.floor(seconds / CACHE_STEP_SECONDS);

  function open(url) {
    sourceUrl = url;
    start({ preload: true });
  }

  function close() {
    hls?.destroy();
    hls = null;
    sourceUrl = target = null;
    seeking = false;
    clearTimeout(seekTimer);
    cache.clear();
    frame.removeAttribute("src");
    box.hidden = true;
  }

  function start({ preload = false } = {}) {
    hls = new Hls({
      startPosition: target ?? 0,
      maxBufferLength: PREVIEW_BUFFER_SECONDS,
      maxMaxBufferLength: PREVIEW_BUFFER_SECONDS,
      xhrSetup: (xhr, url) => xhr.open("GET", storedUrl(url)),
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const lowest = hls.levels.reduce((low, level, i) => (level.bitrate < hls.levels[low].bitrate ? i : low), 0);
      hls.currentLevel = lowest;
    });
    if (preload) {
      // With the playlist in hand there is nothing more to download until the bar is hovered.
      hls.once(Hls.Events.LEVEL_LOADED, () => {
        if (box.hidden) hls.stopLoad();
      });
    }
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) restart();
    });
    hls.loadSource(sourceUrl);
    hls.attachMedia(frame);
  }

  // Without this a single seek that never finishes would keep `seeking` set, and the frame would stay
  // the same for the whole bar.
  function restart() {
    hls?.destroy();
    hls = null;
    seeking = false;
    clearTimeout(seekTimer);
    if (sourceUrl && !box.hidden) start();
  }

  // Draws the video's current frame as the picture for `at` and keeps it. A frame that arrives late
  // (the mouse has moved on) is kept but must not replace one the bar already has.
  function paint(at) {
    if (target === null || !cache.has(stepOf(target))) context.drawImage(frame, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(stepOf(at), context.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT));
  }

  // One seek at a time: moving the mouse fast would otherwise queue a download for every pixel.
  function showFrame() {
    if (target === null || cache.has(stepOf(target))) return;
    // before its first frame the video has nothing to show or seek in (and would never report "seeked")
    if (seeking || frame.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    // hls.js starts the video at the first hovered moment: no seek is needed, the frame is already there
    if (Math.abs(frame.currentTime - target) < 0.5) return paint(target);
    seeking = true;
    seekTarget = target;
    frame.currentTime = target;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(restart, SEEK_TIMEOUT_MS);
  }
  frame.addEventListener("loadeddata", showFrame);
  frame.addEventListener("seeked", () => {
    seeking = false;
    clearTimeout(seekTimer);
    paint(seekTarget);
    showFrame();
  });

  wrap.addEventListener("pointermove", (event) => {
    const length = Number(seek.max);
    if (!sourceUrl || !(length > 0)) return;
    const bar = seek.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (event.clientX - bar.left) / bar.width));
    target = share * length;

    if (!hls) start();
    else if (box.hidden) hls.startLoad(target);
    const cached = cache.get(stepOf(target));
    if (cached) context.putImageData(cached, 0, 0);
    box.hidden = false;
    timeLabel.textContent = formatTime(target);
    // centred on the pointer, but kept inside the bar
    const half = box.offsetWidth / 2;
    const x = Math.min(bar.width - half, Math.max(half, event.clientX - bar.left));
    box.style.left = `${x}px`;
    showFrame();
  });

  wrap.addEventListener("pointerleave", () => {
    box.hidden = true;
    clearTimeout(seekTimer);
    seeking = false;
    hls?.stopLoad(); // a live playlist would otherwise keep being reloaded
  });

  return { open, close };
}
