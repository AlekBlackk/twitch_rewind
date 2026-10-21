// Chat synced to playback. Message `at` = seconds since the broadcast start, same clock as video.currentTime.
import { getComments } from "./twitch.js";
import { twitchEmoteUrl } from "./emotes.js";

const MAX_SHOWN = 150;

const visible = (messages, seconds) => messages.filter((m) => m.at <= seconds).slice(-MAX_SHOWN);

// Replay chat of a VOD (also while it is still recording). Twitch only serves it by offset
// (cursor paging needs an integrity token), ~1 minute per request, so it is loaded as playback moves.
// `onUpdate` is called when new messages arrive, so a paused player still shows them.
export function createVodChat(videoId, onUpdate) {
  let messages = [];
  let loadedFrom = Infinity;
  let loadedTo = -Infinity;
  let pending = null; // the in-flight request: { offset }
  let nextPollAt = 0; // follow-up pages at most every 3 s, which also polls the live edge

  async function load(offset, isSeek) {
    const request = (pending = { offset });
    try {
      const page = await getComments(videoId, offset);
      if (pending !== request) return; // a newer seek replaced this request
      const known = new Set(isSeek ? [] : messages.map((m) => m.id));
      messages = (isSeek ? [] : messages).concat(page.filter((m) => !known.has(m.id)));
      if (isSeek) loadedFrom = offset;
      loadedTo = Math.max(offset, page.at(-1)?.at ?? offset);
      onUpdate();
    } catch {
      // chat is secondary: a failed page must not break playback, the next tick retries
    } finally {
      if (pending === request) pending = null;
      nextPollAt = Date.now() + 3000;
    }
  }

  return {
    messagesAt(seconds) {
      const outsideLoaded = seconds < loadedFrom || seconds > loadedTo + 120;
      if (outsideLoaded) {
        // start a bit earlier so the chat shows what led up to this moment
        const offset = Math.max(0, seconds - 30);
        if (!pending || Math.abs(pending.offset - offset) > 120) load(offset, true);
      } else if (!pending && Date.now() >= nextPollAt && seconds > loadedTo - 20) {
        load(loadedTo, false);
      }
      return visible(messages, seconds);
    },
    emptyHint: "Сообщений пока нет",
    close() {},
  };
}

// An ended broadcast without a VOD (saved by the extension): Twitch keeps no chat for it.
export const noChat = {
  messagesAt: () => [],
  emptyHint: "У сохранённого эфира чата нет: Twitch не хранит его без записи",
  close() {},
};

// Live chat of a broadcast without a VOD. Twitch keeps no history for it: older messages come
// from the recent-messages service (the last ~800 of the channel), newer ones from IRC.
export function createLiveChat(login, startedAt, onUpdate) {
  let messages = [];

  getRecentMessages(login).then(
    (lines) => {
      const known = new Set(messages.map((m) => m.id));
      const backlog = lines.map((line) => parseIrcMessage(line, startedAt)).filter((m) => m && !known.has(m.id));
      messages = [...backlog, ...messages].sort((a, b) => a.at - b.at);
      onUpdate();
    },
    () => {}, // the backlog is optional: live messages still arrive
  );

  const socket = new WebSocket("wss://irc-ws.chat.twitch.tv");
  socket.onopen = () => {
    socket.send("CAP REQ :twitch.tv/tags");
    socket.send(`NICK justinfan${Math.floor(Math.random() * 100000)}`); // anonymous read-only login
    socket.send(`JOIN #${login}`);
  };
  socket.onmessage = ({ data }) => {
    for (const line of data.split("\r\n")) {
      if (line.startsWith("PING")) socket.send("PONG :tmi.twitch.tv");
      const message = parseIrcMessage(line, startedAt);
      if (message) messages.push(message);
    }
    onUpdate();
  };
  return {
    messagesAt: (seconds) => visible(messages, seconds),
    emptyHint: "Чата за этот момент нет: у эфиров без записи доступны только последние ~800 сообщений до открытия окна и всё, что пишут после",
    close: () => socket.close(),
  };
}

// Third-party service (recent-messages.robotty.de) that keeps the last ~800 messages of any channel.
async function getRecentMessages(login) {
  const res = await fetch(`https://recent-messages.robotty.de/api/v2/recent-messages/${login}`);
  if (!res.ok) throw new Error(`recent-messages ответил ${res.status}`);
  return (await res.json()).messages ?? [];
}

export function parseIrcMessage(line, startedAt) {
  // A one-word message comes without the ":" before it.
  const match = line.match(/^@(\S+) :(\w+)!\S+ PRIVMSG #\w+ :?(.*)$/);
  if (!match) return null;
  const tags = Object.fromEntries(match[1].split(";").map((tag) => {
    const eq = tag.indexOf("=");
    return eq < 0 ? [tag, ""] : [tag.slice(0, eq), tag.slice(eq + 1)];
  }));
  const sentAt = Number(tags["tmi-sent-ts"]);
  return {
    id: tags.id,
    at: (sentAt - startedAt) / 1000,
    sentAt,
    author: tags["display-name"] || match[2],
    color: tags.color || null,
    parts: splitByEmotes(match[3], tags.emotes),
  };
}

// Twitch's own emotes come as "id:start-end,start-end/id2:start-end", positions counted in characters.
function splitByEmotes(text, emotesTag) {
  if (!emotesTag) return [{ text }];
  const chars = Array.from(text);
  const spans = emotesTag.split("/").flatMap((entry) => {
    const [id, ranges] = entry.split(":");
    return ranges.split(",").map((range) => {
      const [start, end] = range.split("-").map(Number);
      return { id, start, end };
    });
  }).sort((a, b) => a.start - b.start);

  const parts = [];
  let position = 0;
  for (const { id, start, end } of spans) {
    if (start > position) parts.push({ text: chars.slice(position, start).join("") });
    parts.push({ emote: twitchEmoteUrl(id), name: chars.slice(start, end + 1).join("") });
    position = end + 1;
  }
  if (position < chars.length) parts.push({ text: chars.slice(position).join("") });
  return parts;
}
