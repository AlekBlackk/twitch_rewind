// Moments of a broadcast where the speech has one of the user's keywords (a voiced donation, say):
// the panel next to the chat with the keyword list, the recognition switch and the list of timecodes,
// and the ticks over the seek bar. The speech is recognized by transcriber.js.
import { compileKeywords, findMoments } from "../core/keywords.js";
import { isModelDownloaded, MODEL_SIZE_GB } from "../core/model-cache.js";
import { emptyTranscript, loadTranscript, saveTranscript, TRANSCRIPT_VERSION } from "../core/transcript.js";
import { createTranscriber } from "./transcriber.js";

const $ = (id) => document.getElementById(id);

const PRE_ROLL_SECONDS = 5; // a voiced donation is announced by a picture a moment before it is read
const TYPING_DELAY_MS = 300;
const MARKS_REDRAW_SHARE = 0.005; // the ticks move when the bar grows by this share (a live bar grows all the time)
const MB = 1e6;
const modelSize = `${MODEL_SIZE_GB.toLocaleString("ru")} ГБ`;

export function createMoments({ video, readSetting, writeSetting, formatTime }) {
  const tabs = { chat: $("tab-chat"), moments: $("tab-moments") };
  const [chat, pane, keywordsInput, languageSelect, toggle, reset, status, list, marks, count] =
    ["chat", "moments", "keywords", "moments-language", "moments-toggle", "moments-reset", "moments-status", "moments-list", "seek-marks", "moments-count"].map($);

  keywordsInput.value = readSetting("keywords") ?? "";
  languageSelect.value = readSetting("language") ?? "russian";

  let broadcast = null;
  let playlistUrl = null;
  let transcript = emptyTranscript();
  let audioLength = 0; // seconds of audio the broadcast has so far, known once recognition has looked
  let keywords = compileKeywords(keywordsInput.value);
  let moments = [];
  let transcriber = null;
  let controller = null; // of the running recognition; set from its start until it has really finished
  let loading = null; // { loaded, total } while the model downloads
  let failure = null;
  let finished = false;
  let modelPresent = true; // false when the model has to be downloaded: the button then says so, and asks nothing else
  let marksDrawn = { moments: null, duration: 0 };
  let barLength = 0; // seconds the seek bar is long, as the player last said

  // ---- Tabs

  function selectTab(name) {
    for (const [tabName, tab] of Object.entries(tabs)) tab.setAttribute("aria-selected", tabName === name);
    chat.hidden = name !== "chat";
    pane.hidden = name !== "moments";
    if (name === "chat") chat.scrollTop = chat.scrollHeight; // the chat kept filling while it was hidden
  }
  for (const [name, tab] of Object.entries(tabs)) tab.addEventListener("click", () => selectTab(name));

  // ---- Keywords

  let typingTimer;
  keywordsInput.addEventListener("input", () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      writeSetting("keywords", keywordsInput.value);
      keywords = compileKeywords(keywordsInput.value);
      refresh();
    }, TYPING_DELAY_MS);
  });
  languageSelect.addEventListener("change", () => writeSetting("language", languageSelect.value));

  // ---- Rendering

  function refresh() {
    moments = findMoments(transcript.lines, keywords);
    list.replaceChildren(...moments.map(renderMoment));
    count.textContent = moments.length ? ` (${moments.length})` : "";
    renderMarks(barLength); // the player only redraws the bar while it plays
    renderStatus();
    renderToggle();
  }

  function renderMoment({ at, text, ranges }) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const time = document.createElement("time");
    time.textContent = formatTime(at);
    const words = document.createElement("span");
    words.append(...highlight(text, ranges));
    button.append(time, words);
    button.addEventListener("click", () => {
      video.currentTime = Math.max(0, at - PRE_ROLL_SECONDS);
    });
    item.append(button);
    return item;
  }

  function highlight(text, ranges) {
    const nodes = [];
    let position = 0;
    for (const [start, end] of ranges) {
      const mark = document.createElement("mark");
      mark.textContent = text.slice(start, end);
      nodes.push(text.slice(position, start), mark);
      position = end;
    }
    nodes.push(text.slice(position));
    return nodes;
  }

  function renderStatus() {
    if (!broadcast) return;
    const recognized = Math.min(transcript.doneTo, audioLength || transcript.doneTo);
    if (failure) {
      status.textContent = `Ошибка: ${failure}`;
    } else if (loading) {
      status.textContent = loading.total
        ? `Загрузка модели: ${Math.round((loading.loaded / loading.total) * 100)}% (${Math.round(loading.loaded / MB)} из ${Math.round(loading.total / MB)} МБ). Это один раз, потом модель берётся из кэша браузера`
        : "Готовлю модель распознавания…";
    } else if (finished) {
      status.textContent = `Эфир распознан целиком (${formatTime(recognized)}), фраз: ${transcript.lines.length}`;
    } else if (!transcript.doneTo) {
      status.textContent = controller
        ? "Начинаю…"
        : "Речь пока не распознавалась. Она распознаётся на видеокарте, пока открыто окно, и сохраняется для этого эфира";
    } else {
      status.textContent = `Распознано до ${formatTime(recognized)}${audioLength ? ` из ${formatTime(audioLength)}` : ""}, фраз: ${transcript.lines.length}`;
    }
    if (!failure && !loading && transcript.doneTo && transcript.version !== TRANSCRIPT_VERSION) {
      status.textContent += ". Эта расшифровка сделана старой версией распознавания и местами ошибается: нажмите «Заново»";
    }
    if (!modelPresent && !controller) {
      status.textContent += `. Для распознавания один раз скачивается модель Whisper (${modelSize}, с huggingface.co), дальше она хранится в браузере`;
    }
  }

  function renderToggle() {
    const stopping = controller?.signal.aborted;
    const idle = modelPresent ? "Распознавать речь" : `Скачать модель (${modelSize}) и распознавать`;
    toggle.textContent = stopping ? "Останавливаю…" : controller ? "Остановить" : idle;
    toggle.disabled = !broadcast || stopping; // a restart has to wait until the stopped run is over, or both would work on one window
    reset.hidden = !transcript.doneTo;
    reset.disabled = Boolean(controller);
  }

  // Erasing hours of recognized speech takes two clicks: the first one only asks.
  const RESET_CONFIRM_MS = 4000;
  let resetTimer;
  function disarmReset() {
    clearTimeout(resetTimer);
    reset.textContent = "Заново";
  }
  reset.addEventListener("click", async () => {
    if (reset.textContent === "Заново") {
      reset.textContent = "Точно стереть?";
      resetTimer = setTimeout(disarmReset, RESET_CONFIRM_MS);
      return;
    }
    disarmReset();
    const job = broadcast;
    await saveTranscript(job.streamId, emptyTranscript());
    if (broadcast !== job) return;
    transcript = emptyTranscript();
    audioLength = 0;
    finished = false;
    refresh();
  });

  /** The ticks of the moments over the seek bar, which is `duration` seconds long. */
  function renderMarks(duration) {
    barLength = duration;
    if (marksDrawn.moments === moments && Math.abs(duration - marksDrawn.duration) <= duration * MARKS_REDRAW_SHARE) return;
    marksDrawn = { moments, duration };
    marks.replaceChildren(...(duration > 0 ? moments.filter(({ at }) => at <= duration).map(({ at }) => {
      const tick = document.createElement("i");
      tick.style.left = `${(at / duration) * 100}%`;
      return tick;
    }) : []));
  }

  // ---- Recognition

  toggle.addEventListener("click", () => {
    if (!controller) start();
    else controller.abort();
    renderToggle();
  });

  async function start() {
    const job = broadcast;
    const own = (controller = new AbortController());
    transcriber ??= createTranscriber();
    failure = null;
    finished = false;
    renderStatus();
    renderToggle();
    try {
      await transcriber.run({
        playlistUrl,
        streamId: job.streamId,
        ended: !job.live,
        language: languageSelect.value,
        signal: own.signal,
        onLoading: (progress) => {
          loading = progress;
          renderStatus();
        },
        onProgress: (updated, length) => {
          if (broadcast !== job) return;
          const grown = updated.lines.length !== transcript.lines.length;
          transcript = updated;
          audioLength = length;
          if (grown) refresh();
          else renderStatus();
        },
      });
      finished = !own.signal.aborted;
    } catch (error) {
      if (!own.signal.aborted) failure = error.message;
    } finally {
      const downloaded = await isModelDownloaded().catch(() => true); // the run may have just downloaded it
      if (broadcast === job) {
        modelPresent = downloaded;
        loading = controller = null;
        refresh();
      }
    }
  }

  // ---- The broadcast being watched

  async function open(next, url) {
    broadcast = next;
    playlistUrl = url;
    // when the check itself fails (no file system access), the model is assumed to be there: the run will tell
    const [stored, downloaded] = await Promise.all([loadTranscript(next.streamId), isModelDownloaded().catch(() => true)]);
    if (broadcast !== next) return; // the user went back while it was read
    transcript = stored;
    modelPresent = downloaded;
    refresh();
  }

  function close() {
    controller?.abort();
    transcriber?.close();
    transcriber = null;
    controller = null;
    broadcast = playlistUrl = null;
    transcript = emptyTranscript();
    audioLength = 0;
    loading = failure = null;
    finished = false;
    moments = [];
    list.replaceChildren();
    marks.replaceChildren();
    marksDrawn = { moments: null, duration: 0 };
    barLength = 0;
    count.textContent = "";
    status.textContent = "";
    renderToggle();
  }

  renderToggle();
  return { open, close, renderMarks };
}
