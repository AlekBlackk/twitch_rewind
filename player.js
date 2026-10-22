import { findLivePlaylist, getBroadcasts, parseLogin, searchChannels } from "./twitch.js";
import { createLiveChat, createVodChat, noChat } from "./chat.js";
import { getSavedBroadcasts, getWatchedChannels, unwatchChannel, watchChannel } from "./saved.js";
import { loadEmotes } from "./emotes.js";
import { buildMasterPlaylist, findQualities, SOURCE } from "./quality.js";
import { ICONS } from "./icons.js";

const $ = (id) => document.getElementById(id);
const [status, browse, list, watch, back, video, chatList, search, period, sort] =
  ["status", "browse", "list", "watch", "back", "video", "chat", "search", "period", "sort"].map($);
const [stage, playButton, muteButton, volume, seek, timeLabel, goLive, qualityWrap, qualityButton, qualityMenu, fullscreenButton] =
  ["stage", "play", "mute", "volume", "seek", "time", "go-live", "quality-wrap", "quality", "quality-menu", "fullscreen"].map($);

// The window starts on the channel of the Twitch tab (the overlay passes it in the URL); any other
// channel is opened by typing its name.
const pageLogin = parseLogin(new URLSearchParams(location.search).get("channel") ?? "");
let login = pageLogin;
let trackLogin = false; // whether `login` is looked after: set by typing a name, not by the Twitch tab
let broadcasts = [];
let hls = null;
let masterUrl = null; // blob URL of the master playlist built for the current broadcast
let activeLevel = -1; // quality level being played
let chat = null;
let current = null;
let lastShownId; // last chat message rendered, to skip re-rendering an unchanged chat
let emotes = new Map(); // third-party emote name -> image URL, filled in after the channel loads
let emotesRequested = false;

setView(readSetting("view") ?? "grid");
$("channel").value = login ?? "";
showList();
renderWatched();

// Typing a channel opens it and, once it loads, starts looking after it (see saved.js).
$("channel-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const typed = parseLogin($("channel").value);
  if (typed) openChannel(typed, true);
  else status.textContent = "Введите ник канала или ссылку на него";
});

// Suggestions while typing: Twitch's channel search, asked once the typing pauses.
const SUGGEST_DELAY_MS = 250;
const MIN_SUGGEST_LENGTH = 2;
let suggestTimer;
$("channel").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(showSuggestions, SUGGEST_DELAY_MS);
});

async function showSuggestions() {
  const typed = parseLogin($("channel").value);
  if (!typed || typed.length < MIN_SUGGEST_LENGTH) return $("channel-suggestions").replaceChildren();
  try {
    const channels = await searchChannels(typed);
    if (parseLogin($("channel").value) !== typed) return; // typing went on: a newer search is coming
    $("channel-suggestions").replaceChildren(...channels.map(({ login: name, displayName }) => {
      const option = document.createElement("option");
      option.value = name;
      option.label = displayName;
      return option;
    }));
  } catch {
    // suggestions are a convenience: the name can still be typed in full
  }
}

function openChannel(channel, track) {
  $("channel").value = login = channel;
  trackLogin = track;
  emotes = new Map(); // emotes belong to the channel
  emotesRequested = false;
  broadcasts = [];
  list.replaceChildren();
  showList();
  renderWatched();
}

$("page-channel").addEventListener("click", () => openChannel(pageLogin, false));

async function renderWatched() {
  const channels = await getWatchedChannels();
  // a way back to the channel of the Twitch tab, which is not in the list unless it is watched
  const pageButton = $("page-channel");
  pageButton.hidden = !pageLogin || pageLogin === login || channels.includes(pageLogin);
  pageButton.textContent = `← ${pageLogin}`;
  $("watched-label").hidden = !channels.length;
  $("watched-row").hidden = pageButton.hidden && !channels.length;
  $("watched").replaceChildren(...channels.map((channel) => {
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.textContent = channel;
    open.addEventListener("click", () => openChannel(channel, true));
    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.title = remove.ariaLabel = `Перестать отслеживать ${channel}`;
    remove.addEventListener("click", async () => {
      await unwatchChannel(channel);
      if (channel === login) trackLogin = false; // reloading the list must not add it back
      renderWatched();
    });
    item.append(open, remove);
    return item;
  }));
}

// ---- Window: the overlay (in the Twitch page) moves and resizes the iframe on our messages.

function toOverlay(message) {
  // The parent checks our origin; the messages carry nothing private, so any target origin is fine.
  parent.postMessage({ type: "twitch-rewind", ...message }, "*");
}

function dragToOverlay(handle, action) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    handle.setPointerCapture(event.pointerId);
    // Screen coordinates: the iframe itself moves while dragging, its own coordinates would drift.
    let lastX = event.screenX;
    let lastY = event.screenY;
    const onMove = (move) => {
      toOverlay({ action, dx: move.screenX - lastX, dy: move.screenY - lastY });
      lastX = move.screenX;
      lastY = move.screenY;
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("lostpointercapture", () => handle.removeEventListener("pointermove", onMove), { once: true });
  });
}

dragToOverlay($("titlebar"), "move");
dragToOverlay($("resize"), "resize");
$("close").addEventListener("click", () => toOverlay({ action: "close" }));

// Minimized, only the title bar stays; the overlay shrinks the iframe to the height measured here.
$("minimize").addEventListener("click", () => {
  const minimized = document.body.classList.toggle("minimized");
  $("minimize").textContent = minimized ? "▢" : "—";
  $("minimize").title = $("minimize").ariaLabel = minimized ? "Развернуть" : "Свернуть";
  toOverlay({ action: "minimize", height: minimized ? Math.ceil(document.body.getBoundingClientRect().height) : null });
});

// ---- Broadcast list

async function showList() {
  stop();
  watch.hidden = back.hidden = true;
  browse.hidden = false;
  if (!login) {
    status.textContent = "Введите ник канала";
    return;
  }
  const requested = login;
  status.textContent = `${login}: загружаю эфиры…`;
  try {
    const channel = await getBroadcasts(requested);
    const listed = new Set(channel.broadcasts.map((b) => b.streamId));
    const saved = await getSavedBroadcasts(requested, listed);
    if (login !== requested) return; // another channel was typed in meanwhile
    broadcasts = [...channel.broadcasts, ...saved];
    // Only a channel typed in by hand is looked after: the background worker saves its live broadcasts.
    // Opening a channel from the Twitch page just shows the list.
    if (trackLogin) watchChannel(requested).then(renderWatched);
    renderList();
    if (!emotesRequested) {
      emotesRequested = true; // emote sets are loaded once per channel
      loadEmotes(channel.channelId).then((loaded) => {
        if (login !== requested) return;
        emotes = loaded;
        lastShownId = undefined; // show the chat again with the emotes
        renderChat();
      });
    }
  } catch (error) {
    if (login === requested) status.textContent = `${requested}: ${error.message}`;
  }
}

function renderList() {
  const query = search.value.trim().toLowerCase();
  const since = period.value ? Date.now() - Number(period.value) * 86400000 : 0;
  const compare = {
    new: (a, b) => b.startedAt - a.startedAt,
    old: (a, b) => a.startedAt - b.startedAt,
    long: (a, b) => b.duration - a.duration,
  }[sort.value];
  const shown = broadcasts
    .filter((b) => b.startedAt >= since && b.title.toLowerCase().includes(query))
    .sort(compare);
  list.replaceChildren(...shown.map(renderItem));
  status.textContent = shown.length
    ? `${login}: ${shown.length} из ${broadcasts.length} эфиров`
    : `${login}: ничего не найдено`;
}

function renderItem(broadcast) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  const thumb = document.createElement(broadcast.thumbnail ? "img" : "div");
  thumb.className = "thumb";
  if (broadcast.thumbnail) thumb.src = broadcast.thumbnail;
  const title = document.createElement("strong");
  title.textContent = broadcast.title;
  const meta = document.createElement("span");
  const date = new Date(broadcast.startedAt).toLocaleString("ru", { dateStyle: "medium", timeStyle: "short" });
  meta.textContent = broadcast.live
    ? `● В ЭФИРЕ · с ${date}`
    : `${date} · ${formatTime(broadcast.duration)}${broadcast.saved ? " · сохранён расширением" : ""}`;
  meta.classList.toggle("live", broadcast.live);
  button.append(thumb, title, meta);
  button.addEventListener("click", () => open(broadcast));
  item.append(button);
  return item;
}

search.addEventListener("input", renderList);
period.addEventListener("change", renderList);
sort.addEventListener("change", renderList);

$("view").addEventListener("click", (event) => {
  const view = event.target.dataset.view;
  if (!view) return;
  setView(view);
  writeSetting("view", view);
});

function setView(view) {
  list.className = view;
  for (const button of $("view").children) button.setAttribute("aria-pressed", button.dataset.view === view);
}

// localStorage is only a convenience here: it may be unavailable, the default view is fine then.
function readSetting(key) {
  try {
    return localStorage.getItem(`twitch-rewind:${key}`);
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(`twitch-rewind:${key}`, value);
  } catch {}
}

// ---- Player and chat

async function open(broadcast) {
  current = broadcast;
  browse.hidden = true;
  watch.hidden = back.hidden = false;
  goLive.hidden = !broadcast.live;
  status.textContent = broadcast.playlistUrl ? broadcast.title : "Ищу запись эфира…";
  try {
    const playlistUrl = broadcast.playlistUrl ?? (await findLivePlaylist(login, broadcast));
    const qualities = await findQualities(playlistUrl);
    if (current !== broadcast) return; // the user went back while the playlist was being found
    status.textContent = broadcast.title;
    play(qualities);
    if (broadcast.videoId) chat = createVodChat(broadcast.videoId, renderChat);
    else if (broadcast.saved) chat = noChat;
    else chat = createLiveChat(login, broadcast.startedAt, renderChat);
  } catch (error) {
    status.textContent = error.message;
  }
}

function play(qualities) {
  // With several qualities hls.js gets a master playlist built from them (quality switching, "Auto").
  masterUrl = qualities.length > 1
    ? URL.createObjectURL(new Blob([buildMasterPlaylist(qualities)], { type: "application/vnd.apple.mpegurl" }))
    : null;
  hls = new Hls({
    // Finished VODs list muted parts as "N-unmuted.ts" while the file is stored as "N-muted.ts".
    xhrSetup: (xhr, fragUrl) => xhr.open("GET", fragUrl.replace("-unmuted.", "-muted.")),
  });
  // A live DVR playlist is an EVENT playlist without ENDLIST: hls.js starts at the live edge,
  // keeps reloading it, and the whole broadcast from its start stays seekable.
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (data.fatal) status.textContent = `Ошибка воспроизведения: ${data.details}`;
  });
  hls.on(Hls.Events.MANIFEST_PARSED, setUpQuality);
  hls.on(Hls.Events.LEVEL_SWITCHED, (_, { level }) => {
    activeLevel = level;
    renderQuality();
  });
  hls.loadSource(masterUrl ?? qualities[0].url);
  hls.attachMedia(video);
  video.play().catch(() => {}); // autoplay may be blocked: then the user presses play
}

function stop() {
  current = null;
  hls?.destroy();
  hls = null;
  if (masterUrl) URL.revokeObjectURL(masterUrl);
  masterUrl = null;
  qualityWrap.hidden = true;
  chat?.close();
  chat = null;
  lastShownId = undefined;
  video.removeAttribute("src");
  chatList.replaceChildren();
}

back.addEventListener("click", showList);

const seekBy = (seconds) => {
  video.currentTime = Math.max(0, video.currentTime + seconds);
};

$("controls").addEventListener("click", (event) => {
  const seek = event.target.dataset.seek;
  if (seek) seekBy(Number(seek));
});

// ---- Controls (the video has no native ones: they are drawn over it like Twitch's)

const ARROW_SEEK_SECONDS = 10;
const AT_LIVE_SECONDS = 15; // closer to the edge of the recording than this counts as "live"
const HIDE_CONTROLS_MS = 3000;

const setIcon = (button, name) => {
  button.innerHTML = ICONS[name];
};
const seekableEnd = () => (video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.duration || 0);
const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
const toggleFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen());

function toggleMute() {
  if (video.muted || video.volume === 0) {
    video.muted = false;
    if (video.volume === 0) video.volume = 0.5;
  } else {
    video.muted = true;
  }
}

// Capture phase: the keys act on the player wherever the focus is inside it (a focused slider
// would otherwise move by one second).
document.addEventListener("keydown", (event) => {
  const shortcuts = {
    ArrowLeft: () => seekBy(-ARROW_SEEK_SECONDS),
    ArrowRight: () => seekBy(ARROW_SEEK_SECONDS),
    " ": togglePlay,
    k: togglePlay,
    m: toggleMute,
    f: toggleFullscreen,
  };
  const action = shortcuts[event.key];
  const typing = event.target.matches("input:not([type=range]), select");
  const onButton = event.key === " " && event.target.closest("button"); // the space bar presses the button
  if (!action || typing || onButton || watch.hidden || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  event.stopPropagation();
  action();
}, true);

playButton.addEventListener("click", togglePlay);
video.addEventListener("click", togglePlay);
video.addEventListener("dblclick", toggleFullscreen);
muteButton.addEventListener("click", toggleMute);
fullscreenButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  setIcon(fullscreenButton, document.fullscreenElement ? "exitFullscreen" : "fullscreen");
});

video.addEventListener("play", renderPlayButton);
video.addEventListener("pause", renderPlayButton);
function renderPlayButton() {
  setIcon(playButton, video.paused ? "play" : "pause");
  playButton.setAttribute("aria-label", video.paused ? "Играть" : "Пауза");
  showControls();
}

const savedVolume = parseFloat(readSetting("volume"));
video.volume = savedVolume >= 0 && savedVolume <= 1 ? savedVolume : 1;
volume.addEventListener("input", () => {
  video.volume = Number(volume.value);
  video.muted = video.volume === 0;
});
function renderVolume() {
  const silent = video.muted || video.volume === 0;
  setIcon(muteButton, silent ? "muted" : "volume");
  volume.value = silent ? 0 : video.volume;
}
video.addEventListener("volumechange", () => {
  renderVolume();
  writeSetting("volume", video.volume);
});
setIcon(playButton, "play");
setIcon(fullscreenButton, "fullscreen");
renderVolume();

// Seek bar: while it is dragged the video's own position must not move it back.
let scrubbing = false;
seek.addEventListener("pointerdown", () => (scrubbing = true));
addEventListener("pointerup", () => (scrubbing = false));
seek.addEventListener("input", () => {
  video.currentTime = Number(seek.value);
});

goLive.addEventListener("click", () => {
  if (hls?.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
});

function renderTime() {
  const end = seekableEnd();
  seek.max = end;
  if (!scrubbing) seek.value = video.currentTime;

  if (current?.live) {
    // Distance to the newest part of the recording, which itself runs ~30 s behind the real broadcast
    // (hls.latency would count that too and never reach "live").
    const behind = Math.max(0, (hls?.liveSyncPosition ?? 0) - video.currentTime);
    const atLive = behind < AT_LIVE_SECONDS;
    timeLabel.textContent = formatTime(video.currentTime);
    goLive.classList.toggle("at-live", atLive);
    goLive.textContent = atLive ? "В эфире" : `К эфиру (−${formatTime(behind)})`;
  } else {
    timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(end)}`;
  }
}

video.addEventListener("timeupdate", () => {
  renderTime();
  renderChat();
});
video.addEventListener("durationchange", renderTime);

// Controls fade out after a few seconds without the mouse, while playing.
let hideTimer;
function showControls() {
  stage.classList.remove("idle");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!video.paused && qualityMenu.hidden) stage.classList.add("idle");
  }, HIDE_CONTROLS_MS);
}
stage.addEventListener("pointermove", showControls);
stage.addEventListener("pointerdown", showControls);

// ---- Quality: "Auto" plus the levels of the master playlist; the choice is remembered

const levelName = (level) => (level.name === SOURCE ? "Источник" : level.name);

function setUpQuality() {
  const saved = readSetting("quality");
  const savedLevel = hls.levels.findIndex((level) => level.name === saved);
  qualityWrap.hidden = hls.levels.length < 2;
  if (savedLevel >= 0) {
    hls.currentLevel = savedLevel;
  } else {
    // Auto starts from the best level: it has no bandwidth measurement yet and would begin at the worst
    hls.startLevel = hls.levels.reduce((best, level, i) => (level.bitrate > hls.levels[best].bitrate ? i : best), 0);
  }
  renderQuality();
}

function renderQuality() {
  if (!hls || hls.levels.length < 2) return;
  const auto = hls.autoLevelEnabled;
  const playing = hls.levels[activeLevel];
  setIcon(qualityButton, "settings");
  qualityButton.append(auto ? `Авто${playing ? ` · ${levelName(playing)}` : ""}` : levelName(hls.levels[hls.currentLevel]));

  const best = hls.levels.map((level, index) => ({ level, index })).sort((a, b) => b.level.bitrate - a.level.bitrate);
  const entry = (label, index) =>
    `<li><button role="menuitemradio" data-level="${index}" aria-checked="${index === -1 ? auto : !auto && hls.currentLevel === index}">${label}</button></li>`;
  // level names come from the master playlist built here, but are escaped anyway
  qualityMenu.innerHTML = [entry("Авто", -1), ...best.map(({ level, index }) => entry(escapeHtml(levelName(level)), index))].join("");
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

qualityButton.addEventListener("click", () => {
  qualityMenu.hidden = !qualityMenu.hidden;
  showControls();
});
qualityMenu.addEventListener("click", (event) => {
  const item = event.target.closest("button");
  if (!item || !hls) return;
  const level = Number(item.dataset.level);
  hls.currentLevel = level; // -1 turns "Auto" on
  writeSetting("quality", level < 0 ? "auto" : hls.levels[level].name);
  qualityMenu.hidden = true;
  renderQuality();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) qualityMenu.hidden = true;
});

function renderChat() {
  if (!chat) return;
  const messages = chat.messagesAt(video.currentTime);
  const shownId = messages.at(-1)?.id ?? "empty";
  if (shownId === lastShownId) return;
  lastShownId = shownId;
  if (messages.length) {
    chatList.replaceChildren(...messages.map(renderMessage));
  } else {
    const hint = document.createElement("li");
    hint.className = "hint";
    hint.textContent = chat.emptyHint;
    chatList.replaceChildren(hint);
  }
  chatList.scrollTop = chatList.scrollHeight;
}

function renderMessage({ author, color, sentAt, at, parts }) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date(sentAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
  time.title = `${formatTime(at)} от начала эфира`;
  const name = document.createElement("b");
  name.textContent = `${author}: `;
  name.style.color = color ?? "#bf94ff";
  item.append(time, name, ...parts.flatMap(renderPart));
  return item;
}

function emoteImage(url, name) {
  const image = document.createElement("img");
  image.className = "emote";
  image.src = url;
  image.alt = image.title = name;
  return image;
}

// Text is split on spaces: a word equal to a 7TV/BTTV/FFZ emote name is shown as its image.
function renderPart(part) {
  if (part.emote) return [emoteImage(part.emote, part.name)];
  return part.text.split(/(\s+)/).map((word) => (emotes.has(word) ? emoteImage(emotes.get(word), word) : word));
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}
