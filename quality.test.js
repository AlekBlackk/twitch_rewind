import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMasterPlaylist, findQualities, parseQuality } from "./quality.js";

test("parseQuality reads height and fps, ignores the source and audio names", () => {
  assert.deepEqual(parseQuality("720p60"), { height: 720, fps: 60 });
  assert.equal(parseQuality("chunked"), null);
  assert.equal(parseQuality("audio_only"), null);
});

test("buildMasterPlaylist orders levels by bit rate and puts the source on top", () => {
  const master = buildMasterPlaylist([
    { name: "chunked", url: "https://x/chunked/index-dvr.m3u8" },
    { name: "360p30", url: "https://x/360p30/index-dvr.m3u8" },
    { name: "720p60", url: "https://x/720p60/index-dvr.m3u8" },
  ]);
  const names = [...master.matchAll(/NAME="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["360p30", "720p60", "chunked"]);
  assert.match(master, /RESOLUTION=1280x720,NAME="720p60"\nhttps:\/\/x\/720p60\/index-dvr\.m3u8/);
  assert.ok(master.startsWith("#EXTM3U"));
});

test("findQualities keeps the source when the URL has no known shape or nothing else answers", async (t) => {
  assert.deepEqual(await findQualities("https://x/other.m3u8"), [{ name: "chunked", url: "https://x/other.m3u8" }]);

  t.mock.method(globalThis, "fetch", async (url) =>
    url.includes("/480p30/") ? { ok: true, text: async () => "#EXTINF:2.0,\n0.ts" } : { ok: false });
  const found = await findQualities("https://x/abc/chunked/index-dvr.m3u8");
  assert.deepEqual(found.map((q) => q.name), ["chunked", "480p30"]);
});
