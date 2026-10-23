// Emote images for the chat: Twitch's own (by id) and third-party ones (7TV, BTTV, FFZ) matched by name.

export const twitchEmoteUrl = (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;

const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null), () => null);

// shortcut: 7TV zero-width emotes (overlays on the previous emote) are shown as ordinary ones;
// upgrade: stack them via CSS when `emote.data.flags & 256`.
const sevenTv = (emotes) =>
  (emotes ?? []).map((e) => [e.name, `https:${e.data.host.url}/2x.webp`]);
const bttv = (emotes) =>
  (emotes ?? []).map((e) => [e.code, `https://cdn.betterttv.net/emote/${e.id}/2x.webp`]);
const ffz = (emotes) =>
  (emotes ?? []).map((e) => [e.code, e.images["2x"] ?? e.images["1x"]]);

/** Map of emote name -> image URL, for the channel plus the global sets. Missing services are skipped. */
export async function loadEmotes(channelId) {
  const [sevenChannel, sevenGlobal, bttvChannel, bttvGlobal, ffzChannel, ffzGlobal] = await Promise.all([
    getJson(`https://7tv.io/v3/users/twitch/${channelId}`),
    getJson("https://7tv.io/v3/emote-sets/global"),
    getJson(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`),
    getJson("https://api.betterttv.net/3/cached/emotes/global"),
    getJson(`https://api.betterttv.net/3/cached/frankerfacez/users/twitch/${channelId}`),
    getJson("https://api.betterttv.net/3/cached/frankerfacez/emotes/global"),
  ]);
  // Later entries win a name clash: 7TV over BTTV over FFZ, the channel's own over the global ones.
  return new Map([
    ...ffz(ffzGlobal),
    ...ffz(ffzChannel),
    ...bttv(bttvGlobal),
    ...bttv(bttvChannel?.channelEmotes),
    ...bttv(bttvChannel?.sharedEmotes),
    ...sevenTv(sevenGlobal?.emotes),
    ...sevenTv(sevenChannel?.emote_set?.emotes),
  ]);
}
