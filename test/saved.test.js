import { test } from "node:test";
import assert from "node:assert/strict";
import { getSavedBroadcasts, getWatchedChannels, playlistDuration, pollChannels, unwatchChannel, watchChannel } from "../src/core/saved.js";
import { dvrPath, getLiveStreams } from "../src/core/twitch.js";

const STARTED = "2026-10-21T08:00:00Z";
const PLAYLIST = "#EXTM3U\n#EXTINF:2.000,\na.ts\n#EXTINF:10.500,\nb.ts\n#EXT-X-ENDLIST";

// In-memory chrome.storage.local
function mockStorage(t, initial = {}) {
  const data = { ...initial };
  const pick = (keys) => (keys == null ? { ...data } : Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, data[k]])));
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (items) => void Object.assign(data, items),
        remove: async (keys) => void [keys].flat().forEach((k) => delete data[k]),
      },
    },
  };
  t.after(() => delete globalThis.chrome);
  return data;
}

// Twitch API and CDN: `cdn` maps a playlist URL to its answer, everything else on the CDN is 404.
function mockNetwork(t, { live = [], cdn = {} }) {
  const user = (login) => live.includes(login)
    ? { login, stream: { id: `id_${login}`, createdAt: STARTED }, broadcastSettings: { title: `Title ${login}` } }
    : null;
  return t.mock.method(globalThis, "fetch", async (url, init) => {
    if (typeof url === "string" && url.includes("gql.twitch.tv")) {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("streams(first")) return { ok: true, json: async () => ({ data: { streams: { edges: [] } } }) };
      const data = Object.fromEntries(Object.entries(variables).map(([key, login]) => [`u${key.slice(1)}`, user(login)]));
      return { ok: true, json: async () => ({ data }) };
    }
    const answer = cdn[url];
    if (answer instanceof Error) throw answer;
    return answer ?? { ok: false, status: 404 };
  });
}

const playlistAnswer = { ok: true, text: async () => PLAYLIST };
const dvrUrl = async (login, server = "d3fi1amfgojobc") =>
  `https://${server}.cloudfront.net/${await dvrPath(login, `id_${login}`, Date.parse(STARTED))}/chunked/index-dvr.m3u8`;

test("playlistDuration sums the segment lengths", () => {
  assert.equal(playlistDuration(PLAYLIST), 12.5);
  assert.equal(playlistDuration(""), 0);
});

test("getLiveStreams returns only the live channels of a batch, ignoring unknown ones", async (t) => {
  mockNetwork(t, { live: ["alice"] });
  assert.deepEqual(await getLiveStreams(["alice", "bob", "nosuchuser"]), [
    { login: "alice", streamId: "id_alice", startedAt: Date.parse(STARTED), title: "Title alice" },
  ]);
});

test("watchChannel adds a channel once", async (t) => {
  const data = mockStorage(t);
  await watchChannel("alice");
  await watchChannel("alice");
  await watchChannel("bob");
  assert.deepEqual(data.watched, ["alice", "bob"]);
});

test("pollChannels saves the playlist of a live channel once, and skips a stream without a DVR", async (t) => {
  const data = mockStorage(t, { watched: ["alice", "bob"] });
  const fetched = mockNetwork(t, { live: ["alice", "bob"], cdn: { [await dvrUrl("alice")]: playlistAnswer } });

  await pollChannels();
  assert.deepEqual(Object.keys(data).sort(), ["saved:id_alice", "watched"]);
  assert.deepEqual(data["saved:id_alice"], {
    login: "alice", streamId: "id_alice", startedAt: Date.parse(STARTED), title: "Title alice", playlistUrl: await dvrUrl("alice"),
  });

  // second poll: alice is saved already, bob still has no DVR and is searched again
  fetched.mock.resetCalls();
  await pollChannels();
  const urls = fetched.mock.calls.map(({ arguments: [url] }) => String(url));
  assert.ok(urls.some((url) => url.includes("_id_bob_")));
  assert.ok(!urls.some((url) => url.includes("_id_alice_")));
});

test("getSavedBroadcasts lists saved broadcasts with their length and drops the deleted ones", async (t) => {
  const record = (login, playlistUrl) => ({ login, streamId: `id_${login}`, startedAt: 1, title: "", playlistUrl });
  const data = mockStorage(t, {
    watched: ["alice"],
    "saved:id_alice": record("alice", "https://cdn/alice.m3u8"),
    "saved:id_gone": { ...record("alice", "https://cdn/gone.m3u8"), streamId: "id_gone" },
    "saved:id_offline": { ...record("alice", "https://cdn/offline.m3u8"), streamId: "id_offline" },
    "saved:id_listed": { ...record("alice", "https://cdn/listed.m3u8"), streamId: "id_listed" },
    "saved:id_other": record("bob", "https://cdn/bob.m3u8"),
  });
  mockNetwork(t, {
    cdn: {
      "https://cdn/alice.m3u8": playlistAnswer,
      "https://cdn/gone.m3u8": { ok: false, status: 403 },
      "https://cdn/offline.m3u8": new Error("offline"),
    },
  });

  const saved = await getSavedBroadcasts("alice", new Set(["id_listed"]));
  assert.deepEqual(saved.map((b) => [b.streamId, b.duration, b.title]), [
    ["id_alice", 12.5, "Эфир без записи"],
    ["id_offline", 0, "Эфир без записи"],
  ]);
  assert.ok(saved.every((b) => b.saved && !b.live && b.videoId === null));
  assert.equal("saved:id_gone" in data, false); // deleted from the CDN: forgotten
  assert.equal("saved:id_offline" in data, true); // only unreachable: kept
  assert.equal("saved:id_other" in data, true); // another channel: untouched
});

test("unwatchChannel removes only that channel and keeps its saved broadcasts", async (t) => {
  const data = mockStorage(t, { watched: ["alice", "bob"], "saved:id_alice": { login: "alice" } });
  await unwatchChannel("alice");
  assert.deepEqual(data.watched, ["bob"]);
  assert.ok("saved:id_alice" in data);
  assert.deepEqual(await getWatchedChannels(), ["bob"]);
});
