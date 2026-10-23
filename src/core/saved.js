// Broadcasts remembered by the extension. Twitch writes the DVR of every live stream on its CDN
// (the sample checked kept it for 2+ hours after the end, with no VOD), but nothing links to it
// once the stream is over and the start time cannot be recovered afterwards. So while a watched
// channel is live, its playlist URL is saved here: no video is stored, only ~300 bytes per broadcast
// in chrome.storage.local. Records are one key each, so the player and the background worker never
// overwrite each other's writes.

import { findLivePlaylist, getLiveStreams } from "./twitch.js";

const CHANNELS_KEY = "watched"; // not "channels": that older list held every channel merely opened
const PREFIX = "saved:";
const GONE_STATUSES = [403, 404, 410]; // what the CDN answers for a playlist Twitch has deleted

export async function getWatchedChannels() {
  const { [CHANNELS_KEY]: channels = [] } = await chrome.storage.local.get(CHANNELS_KEY);
  return channels;
}

/** Channels to look after: those whose name was typed into the player window. */
export async function watchChannel(login) {
  const channels = await getWatchedChannels();
  if (!channels.includes(login)) await chrome.storage.local.set({ [CHANNELS_KEY]: [...channels, login] });
}

// Already saved broadcasts of the channel stay: only new ones stop being saved.
export async function unwatchChannel(login) {
  const channels = await getWatchedChannels();
  await chrome.storage.local.set({ [CHANNELS_KEY]: channels.filter((channel) => channel !== login) });
}

/** Saves the playlist of every watched channel that is live and not saved yet. Run from the background worker. */
export async function pollChannels() {
  const channels = await getWatchedChannels();
  if (!channels.length) return;
  // shortcut: all channels in one request, fine for dozens; split into chunks if the list grows
  const live = await getLiveStreams(channels);
  const have = await chrome.storage.local.get(live.map((stream) => PREFIX + stream.streamId));
  for (const stream of live) {
    if (have[PREFIX + stream.streamId]) continue;
    try {
      const playlistUrl = await findLivePlaylist(stream.login, { ...stream, knownServers: [] });
      await chrome.storage.local.set({ [PREFIX + stream.streamId]: { ...stream, playlistUrl } });
    } catch {
      // shortcut: a stream Twitch writes no DVR for is searched again (~40 requests) on every poll;
      // remember the failure if that ever matters.
    }
  }
}

export const playlistDuration = (playlist) =>
  [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, [, seconds]) => sum + Number(seconds), 0);

// A playlist the CDN no longer has is `gone`; an unreachable one (offline, 5xx) is kept as it is.
async function checkPlaylist(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { gone: GONE_STATUSES.includes(res.status) };
    return { duration: playlistDuration(await res.text()) };
  } catch {
    return {};
  }
}

/**
 * The channel's saved broadcasts that Twitch no longer lists (`knownStreamIds` are the listed ones).
 * Checks each playlist: the ones deleted from the CDN are forgotten, the rest get their length.
 * shortcut: records of broadcasts that still have a VOD are never removed (~300 bytes each).
 */
export async function getSavedBroadcasts(login, knownStreamIds) {
  const all = await chrome.storage.local.get(null);
  const records = Object.entries(all).filter(([key, record]) =>
    key.startsWith(PREFIX) && record.login === login && !knownStreamIds.has(record.streamId));
  const checked = await Promise.all(records.map(async ([key, record]) => ({ key, record, ...(await checkPlaylist(record.playlistUrl)) })));

  const gone = checked.filter((c) => c.gone).map((c) => c.key);
  if (gone.length) await chrome.storage.local.remove(gone);
  return checked.filter((c) => !c.gone).map(({ record, duration = 0 }) => ({
    videoId: null,
    title: record.title || "Эфир без записи",
    thumbnail: null,
    duration,
    live: false,
    saved: true,
    streamId: record.streamId,
    startedAt: record.startedAt,
    playlistUrl: record.playlistUrl,
  }));
}
