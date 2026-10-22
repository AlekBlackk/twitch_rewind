// Twitch data access: the channel's broadcasts, their DVR playlists and chat replay.
// DVR playlist URL: https://{server}.cloudfront.net/{sha1(base)[0:20]}_{base}/chunked/index-dvr.m3u8,
// where base = {login}_{streamId}_{stream start in unix seconds}. Twitch writes it during the
// broadcast even when the VOD is not published; videos expose the same path in their preview URL.

import { twitchEmoteUrl } from "./emotes.js";

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // public client id of the Twitch web player

// Backup for when discoverServers() fails: Twitch's CDN servers change over time (d3stzm2eumvgb4 was
// missing from the other extension's copy, d2vi6trrdongqn appeared later), so a fixed list goes stale.
const FALLBACK_SERVERS = [
  // the 7 in use on 2026-10-19 (seen in ~800 live streams and recent VODs), the rest are older ones
  "d3fi1amfgojobc", "d3stzm2eumvgb4", "dgeft87wbj63p", "d3vd9lfkzbru3h", "d1m7jfoe9zdc1j", "d2vi6trrdongqn", "d2nvs31859zcd8",
  "d1g1f25tn8m2e6", "d1mhjrowxxagfy", "d1oca24q5dwo6d", "d1w2poirtb3as9",
  "d1xhnb4ptk05mw", "d1ymi26ma8va5x", "d2aba1wr3818hz", "d2dylwb3shzel1", "d2e2de1etea730",
  "d2um2qdswy1tb0", "d2vjef5jvl6bfs", "d2xmjdvx03ij56", "d36nr0u3xmc4mm", "d3aqoihi2n8ty8",
  "d3c27h4odz752x", "d6d4ismr40iw", "d6tizftlrpuof", "ddacn6pr5v0tl", "dqrpb9wgowsf5",
  "ds0h3roq6wcgc", "dykkng5hnh52u", "d2v02itv0y9u9t", "d1mjs7qzzz669v",
];

const CHANNEL_QUERY = `query($login: String!) {
  user(login: $login) {
    id
    stream { id createdAt previewImageURL(width: 320, height: 180) }
    videos(first: 100, type: ARCHIVE) { edges { node {
      id title lengthSeconds status animatedPreviewURL previewThumbnailURL(width: 320, height: 180)
    } } }
  }
}`;

const COMMENTS_QUERY = `query($id: ID!, $offset: Int!) {
  video(id: $id) { comments(contentOffsetSeconds: $offset) { edges { node {
    id createdAt contentOffsetSeconds commenter { displayName }
    message { userColor fragments { text emote { emoteID } } }
  } } } }
}`;

async function gql(query, variables, retry = true) {
  const res = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-ID": CLIENT_ID },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Twitch API ответил ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.[0].message === "service error" && retry) {
    // seen at random on Twitch's side; the same request goes through a moment later
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return gql(query, variables, false);
  }
  if (errors) throw new Error(`Twitch API: ${errors[0].message}`);
  return data;
}

// Accepts "name", "twitch.tv/name" or a full channel URL.
export function parseLogin(input) {
  const login = input.trim().toLowerCase().replace(/^.*twitch\.tv\//, "").split(/[/?#]/)[0];
  return /^[a-z0-9_]{1,25}$/.test(login) ? login : null;
}

export async function dvrPath(login, streamId, startedAt) {
  const base = `${login}_${streamId}_${Math.floor(startedAt / 1000)}`;
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(base));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 20)}_${base}`;
}

// "https://{server}.cloudfront.net/{hash}_{login}_{streamId}_{start}/storyboards/..." -> its parts
export function parsePreviewUrl(url) {
  const match = url?.match(/^https:\/\/(\w+)\.cloudfront\.net\/(\w{20}_\w+_(\d+)_(\d+))\//);
  return match && {
    server: match[1],
    playlistUrl: `https://${match[1]}.cloudfront.net/${match[2]}/chunked/index-dvr.m3u8`,
    streamId: match[3],
    startedAt: Number(match[4]) * 1000,
  };
}

/** The channel's id and its broadcasts, newest first. The live one comes first and has `live: true`. */
export async function getBroadcasts(login) {
  const { user } = await gql(CHANNEL_QUERY, { login });
  if (!user) throw new Error("Канал не найден");

  const broadcasts = user.videos.edges.flatMap(({ node }) => {
    const preview = parsePreviewUrl(node.animatedPreviewURL);
    if (!preview) return []; // still processing: no playlist yet
    const live = node.status === "RECORDING" && preview.streamId === user.stream?.id;
    return [{
      videoId: node.id,
      title: node.title,
      // a recording VOD has only a placeholder thumbnail, the stream preview is the real picture
      thumbnail: live ? user.stream.previewImageURL : node.previewThumbnailURL,
      duration: node.lengthSeconds,
      live,
      ...preview,
    }];
  });

  if (user.stream && !broadcasts.some((b) => b.live)) {
    // Live without a published VOD: the playlist URL has to be found by hashing (see findLivePlaylist).
    const startedAt = Date.parse(user.stream.createdAt);
    broadcasts.unshift({
      videoId: null,
      title: "Текущий эфир (без записи)",
      thumbnail: user.stream.previewImageURL,
      duration: Math.floor((Date.now() - startedAt) / 1000),
      live: true,
      streamId: user.stream.id,
      startedAt,
      knownServers: broadcasts.map((b) => b.server),
    });
  }
  return { channelId: user.id, broadcasts };
}

/**
 * The channel's broadcasts of the last 60 days, newest first, as the stats site sullygnome knows them.
 * Twitch lists only broadcasts with a VOD, but the DVR of a deleted one may still be on the CDN;
 * sullygnome gives the stream id and start time its playlist path is built from (older ones are gone).
 * shortcut: a start time rounded to the minute (rare) builds a wrong path, so that playlist is not found;
 * the Twitch VOD Downloader tries all 60 seconds, do the same if it matters.
 */
export async function getPastStreams(login) {
  const page = await fetch(`https://sullygnome.com/channel/${login}/streams`).then((r) => r.text());
  const channelId = /(?<=PageInfo.{1,1000}?"id":)\d+/.exec(page)?.[0];
  if (!channelId) throw new Error("sullygnome не знает этот канал");
  const res = await fetch(`https://sullygnome.com/api/tables/channeltables/streams/90/${channelId}/%20/1/1/desc/0/100`);
  if (!res.ok) throw new Error(`sullygnome ответил ${res.status}`);
  const { data } = await res.json();
  const since = Date.now() - 60 * 86400000;
  return data
    .map((row) => ({ streamId: String(row.streamId), startedAt: Date.parse(row.startDateTime), duration: Math.max(0, row.length) * 60 }))
    .filter((stream) => stream.startedAt >= since);
}

/** Channels matching the typed text, best match first: the suggestions of the name field. */
export async function searchChannels(text) {
  const { searchUsers } = await gql(
    `query($q: String!) { searchUsers(userQuery: $q, first: 8) { edges { node { login displayName } } } }`,
    { q: text },
  );
  return searchUsers.edges.map(({ node }) => node);
}

/** Of `logins`, the channels live right now: stream id, start and title. One request for all of them. */
export async function getLiveStreams(logins) {
  const params = logins.map((_, i) => `$l${i}: String!`).join(", ");
  const users = logins.map((_, i) =>
    `u${i}: user(login: $l${i}) { login stream { id createdAt } broadcastSettings { title } }`).join("\n");
  const data = await gql(`query(${params}) { ${users} }`, Object.fromEntries(logins.map((login, i) => [`l${i}`, login])));
  return Object.values(data).flatMap((user) => (user?.stream ? [{
    login: user.login,
    streamId: user.stream.id,
    startedAt: Date.parse(user.stream.createdAt),
    title: user.broadcastSettings?.title,
  }] : []));
}

/** CDN servers in use right now, read from the previews of the first page of live streams (one request). */
export async function discoverServers() {
  const { streams } = await gql(`{ streams(first: 30) { edges { node { archiveVideo { animatedPreviewURL } } } } }`);
  const servers = streams.edges.map(({ node }) => parsePreviewUrl(node.archiveVideo?.animatedPreviewURL)?.server);
  return [...new Set(servers.filter(Boolean))];
}

export async function findLivePlaylist(login, { streamId, startedAt, knownServers }) {
  const path = await dvrPath(login, streamId, startedAt);
  const currentServers = await discoverServers().catch(() => []); // the lists below still work without it
  const urls = [...new Set([...knownServers, ...currentServers, ...FALLBACK_SERVERS])]
    .map((server) => `https://${server}.cloudfront.net/${path}/chunked/index-dvr.m3u8`);
  // All servers at once (one by one took ~12 s); the order keeps the channel's own server first.
  const found = await Promise.all(urls.map(async (url) => {
    // Segments are .ts on some channels and fMP4 on others, so look for any segment entry.
    const playlist = await fetch(url).then((r) => (r.ok ? r.text() : ""), () => "");
    return playlist.includes("#EXTINF") ? url : null;
  }));
  const url = found.find(Boolean);
  if (!url) throw new Error("Запись этого эфира не найдена — перемотка недоступна");
  return url;
}

/** ~1 minute of chat replay starting near `offset` seconds into the video. */
export async function getComments(videoId, offset) {
  const { video } = await gql(COMMENTS_QUERY, { id: videoId, offset: Math.max(0, Math.floor(offset)) });
  return (video?.comments?.edges ?? []).map(({ node }) => ({
    id: node.id,
    at: node.contentOffsetSeconds,
    sentAt: Date.parse(node.createdAt),
    author: node.commenter?.displayName ?? "",
    color: node.message.userColor,
    // third-party emotes arrive as plain text: they are matched by name when the message is shown
    parts: node.message.fragments.map((f) =>
      f.emote ? { emote: twitchEmoteUrl(f.emote.emoteID), name: f.text } : { text: f.text }),
  }));
}
