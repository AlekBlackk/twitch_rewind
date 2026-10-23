// The clip window (a modal like Twitch's): a looping preview of the chosen part, two handles to trim it,
// a title (which becomes the file name) and the save button. The timeline shows the two minutes from the
// player's position on, with the clip at its start.
import { ICONS } from "./icons.js";
import { clipFileName, clipFragments, fetchClip, moveEdge, shiftRange, storedUrl } from "./clip.js";

const TIMELINE_SECONDS = 120;
const DEFAULT_CLIP_SECONDS = 5;
const KEY_STEP_SECONDS = 1;

const $ = (id) => document.getElementById(id);
const [dialog, form, preview, track, selection, playhead, times, title, message, saveButton, playButton, muteButton] =
  ["clip-dialog", "clip-form", "clip-video", "clip-range", "clip-selection", "clip-playhead", "clip-times", "clip-title", "clip-message", "clip-save", "clip-play", "clip-mute"].map($);

let previewHls = null;
let fragments = [];
let bounds; // {min, max}: the part of the broadcast the timeline shows
let range; // {from, to}: the chosen part

export function openClipEditor({ sourceUrl, fragments: all, anchor, end, volume, muted }) {
  fragments = all;
  // near the end of the recording the timeline starts earlier so that it still has its full length
  bounds = { min: Math.min(anchor, Math.max(0, end - TIMELINE_SECONDS)) };
  bounds.max = Math.min(end, bounds.min + TIMELINE_SECONDS);
  range = { from: bounds.min, to: Math.min(bounds.min + DEFAULT_CLIP_SECONDS, bounds.max) };
  title.value = message.textContent = "";
  saveButton.disabled = false;

  previewHls = new Hls({
    capLevelToPlayerSize: true, // the preview is small: no need for the source quality
    startPosition: range.from,
    xhrSetup: (xhr, url) => xhr.open("GET", storedUrl(url)),
  });
  previewHls.loadSource(sourceUrl);
  previewHls.attachMedia(preview);
  preview.volume = volume;
  preview.muted = muted;
  preview.play().catch(() => {});

  render();
  renderControls();
  dialog.showModal();
  title.focus();
}

dialog.addEventListener("close", () => {
  previewHls?.destroy();
  previewHls = null;
  preview.removeAttribute("src");
});

function renderControls() {
  playButton.innerHTML = ICONS[preview.paused ? "play" : "pause"];
  playButton.ariaLabel = preview.paused ? "Играть" : "Пауза";
  muteButton.innerHTML = ICONS[preview.muted || preview.volume === 0 ? "muted" : "volume"];
  muteButton.ariaLabel = preview.muted ? "Включить звук" : "Выключить звук";
}

const togglePlay = () => (preview.paused ? preview.play().catch(() => {}) : preview.pause());
playButton.addEventListener("click", togglePlay);
preview.addEventListener("click", togglePlay);
muteButton.addEventListener("click", () => (preview.muted = !preview.muted));
for (const name of ["play", "pause", "volumechange"]) preview.addEventListener(name, renderControls);

$("clip-close").addEventListener("click", () => dialog.close());
$("clip-cancel").addEventListener("click", () => dialog.close());

// The preview plays the chosen part over and over.
preview.addEventListener("timeupdate", () => {
  if (!previewHls) return;
  if (preview.currentTime >= range.to || preview.currentTime < range.from - 1) preview.currentTime = range.from;
  renderPlayhead();
});

const percent = (time) => `${((time - bounds.min) / (bounds.max - bounds.min)) * 100}%`;

function render() {
  selection.style.left = percent(range.from);
  selection.style.width = `${((range.to - range.from) / (bounds.max - bounds.min)) * 100}%`;
  // both ends in one format: the hour is shown when the timeline reaches it
  const clock = (seconds) => new Date(seconds * 1000).toISOString().slice(bounds.max >= 3600 ? 11 : 14, 19);
  times.textContent = `${Math.round(range.to - range.from)} с · ${clock(range.from)} – ${clock(range.to)}`;
  renderPlayhead();
}

function renderPlayhead() {
  // The preview may sit a moment before the chosen start while it loads or seeks: the line stays on the clip.
  const time = Math.min(Math.max(preview.currentTime, range.from), range.to);
  playhead.style.setProperty("--progress", (time - range.from) / (range.to - range.from));
}

function moveHandle(edge, time) {
  range = moveEdge(range, edge, time, bounds);
  // the preview jumps to what the handle shows: the start, or the last seconds before the end
  preview.currentTime = edge === "from" ? range.from : Math.max(range.from, range.to - 2);
  render(); // after the seek: a paused preview fires no timeupdate to move the line
}

// Selected text would start a native drag from the handles: it cancels the pointer events and the handle stops.
track.addEventListener("dragstart", (event) => event.preventDefault());

// While `element` is dragged, calls what `begin(grabbedTime)` returns with the time under the pointer
// (and the pointer event).
function dragOnTrack(element, accepts, begin) {
  element.addEventListener("pointerdown", (event) => {
    if (!accepts(event)) return;
    element.setPointerCapture(event.pointerId);
    const timeAt = ({ clientX }) => {
      const { left, width } = track.getBoundingClientRect();
      return bounds.min + Math.min(1, Math.max(0, (clientX - left) / width)) * (bounds.max - bounds.min);
    };
    const drag = begin(timeAt(event));
    const onMove = (move) => drag(timeAt(move), move);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("lostpointercapture", () => element.removeEventListener("pointermove", onMove), { once: true });
  });
}

// Dragging the chosen part itself moves the whole clip along the timeline.
dragOnTrack(selection, (event) => event.target === selection, (grabbed) => {
  const start = range;
  return (time) => {
    range = shiftRange(start, time - grabbed, bounds);
    preview.currentTime = range.from;
    render();
  };
});

// The white line can be dragged between the handles to look at any moment of the clip.
dragOnTrack(playhead, () => true, () => (_, { clientX }) => {
  const inner = { from: $("clip-from").getBoundingClientRect().right, to: $("clip-to").getBoundingClientRect().left };
  const progress = Math.min(1, Math.max(0, (clientX - inner.from) / (inner.to - inner.from)));
  // short of the very end: the preview loops back to the start there
  preview.currentTime = range.from + Math.min(progress * (range.to - range.from), range.to - range.from - 0.1);
  renderPlayhead();
});

for (const handle of [$("clip-from"), $("clip-to")]) {
  const edge = handle.id === "clip-from" ? "from" : "to";
  dragOnTrack(handle, () => true, () => (time) => moveHandle(edge, time));
  handle.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -KEY_STEP_SECONDS, ArrowRight: KEY_STEP_SECONDS }[event.key];
    if (!step) return;
    event.preventDefault();
    moveHandle(edge, range[edge] + step);
  });
}

// "Save as" window of the browser: the extension page may not open a file picker itself (it is a frame of twitch.tv).
async function saveWithDialog(blob, fileName) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: fileName, saveAs: true });
    // the browser reads the blob after the dialog is answered: free it once the download is over
    const onChanged = (change) => {
      if (change.id !== id || !change.state || change.state.current === "in_progress") return;
      chrome.downloads.onChanged.removeListener(onChanged);
      URL.revokeObjectURL(url);
    };
    chrome.downloads.onChanged.addListener(onChanged);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const parts = clipFragments(fragments, range.from, range.to);
  saveButton.disabled = true;
  message.textContent = "Скачиваю клип…";
  try {
    const clip = await fetchClip(parts);
    await saveWithDialog(clip, clipFileName(title.value));
    message.textContent = "Клип сохранён";
  } catch (error) {
    // closing the "save as" window is not a failure
    message.textContent = /cancel/i.test(error.message) ? "Сохранение отменено" : `Клип не создан: ${error.message}`;
  }
  saveButton.disabled = false;
});
