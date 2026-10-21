// Twitch serves every quality as its own playlist next to the source one:
//   .../chunked/index-dvr.m3u8 (source), .../720p60/index-dvr.m3u8, ...
// A DVR has no master playlist, so the playlists that exist are probed and listed in a master
// built here: hls.js then gives quality switching and "Auto" on its own.

export const SOURCE = "chunked";

// shortcut: other source resolutions (936p, 900p...) are only reachable as "chunked";
// add them to the probe if a channel is found whose source has no match here.
const NAMES = [SOURCE, ...[1440, 1080, 720, 480, 360, 160].flatMap((height) => [60, 30].map((fps) => `${height}p${fps}`))];

export function parseQuality(name) {
  const match = /^(\d+)p(\d+)$/.exec(name);
  return match && { height: Number(match[1]), fps: Number(match[2]) };
}

// Rough bit rate (fitted to a real broadcast: 720p60 is ~3.3 Mbit/s): hls.js only needs the order
// and a ballpark to choose levels for "Auto".
const estimateBandwidth = ({ height, fps }) => Math.round(height * height * fps * 0.105);

/** @param {{name: string, url: string}[]} qualities */
export function buildMasterPlaylist(qualities) {
  const levels = qualities.map(({ name, url }) => {
    const quality = parseQuality(name);
    return {
      name,
      url,
      bandwidth: quality ? estimateBandwidth(quality) : 0,
      resolution: quality && `${Math.round((quality.height * 16) / 9)}x${quality.height}`,
    };
  });
  // The source is not re-encoded, so it is heavier than the best transcode (9.1 vs 7.7 Mbit/s measured).
  const top = Math.max(0, ...levels.map((level) => level.bandwidth));
  for (const level of levels) if (level.name === SOURCE) level.bandwidth = top ? Math.round(top * 1.2) : 8_000_000;

  const entries = levels
    .sort((a, b) => a.bandwidth - b.bandwidth)
    .map((l) => `#EXT-X-STREAM-INF:BANDWIDTH=${l.bandwidth}${l.resolution ? `,RESOLUTION=${l.resolution}` : ""},NAME="${l.name}"\n${l.url}`);
  return `#EXTM3U\n${entries.join("\n")}\n`;
}

/** The qualities of the broadcast whose source playlist is `playlistUrl`; at least the source itself. */
export async function findQualities(playlistUrl) {
  const base = playlistUrl.match(/^(.+)\/chunked\/index-dvr\.m3u8$/)?.[1];
  const source = { name: SOURCE, url: playlistUrl };
  if (!base) return [source];

  const found = await Promise.all(NAMES.map(async (name) => {
    const url = `${base}/${name}/index-dvr.m3u8`;
    if (name === SOURCE) return source;
    const playlist = await fetch(url).then((r) => (r.ok ? r.text() : ""), () => "");
    return playlist.includes("#EXTINF") ? { name, url } : null;
  }));
  return found.filter(Boolean);
}
