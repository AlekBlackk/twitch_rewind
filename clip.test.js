import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInThisContext } from "node:vm";
import { clipFileName, clipFragments, fetchClip, moveEdge, shiftRange, storedUrl } from "./clip.js";

const fragments = [0, 10, 20, 30].map((start) => ({ start, duration: 10, url: `https://x/${start}.ts` }));

test("clipFragments takes the segments overlapping the range", () => {
  assert.deepEqual(clipFragments(fragments, 12, 25).map((f) => f.start), [10, 20]);
  assert.deepEqual(clipFragments(fragments, 10, 20).map((f) => f.start), [10]); // touching edges do not count
  assert.deepEqual(clipFragments(fragments, 50, 60), []);
});

test("storedUrl points muted parts at the stored file", () => {
  assert.equal(storedUrl("https://x/5-unmuted.ts"), "https://x/5-muted.ts");
  assert.equal(storedUrl("https://x/5.ts"), "https://x/5.ts");
});

const sampleTs = await readFile(new URL("./fixtures/sample.ts", import.meta.url));

const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const arrayBufferOf = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);

test("fetchClip makes a plain MP4 from MPEG-TS segments and fails on a bad answer", async (t) => {
  runInThisContext(await readFile(new URL("./vendor/mux.min.js", import.meta.url), "utf8")); // sets globalThis.muxjs, as in the page
  t.mock.method(globalThis, "fetch", async (url) =>
    url.endsWith("bad.ts") ? { ok: false, status: 403 } : { ok: true, arrayBuffer: async () => arrayBufferOf(sampleTs) });
  const clip = await bytesOf(await fetchClip([{ url: "https://x/a.ts" }, { url: "https://x/b.ts" }]));
  const text = latin1(clip);
  assert.equal(text.slice(4, 8), "ftyp");
  assert.ok(text.indexOf("moov") < text.indexOf("mdat"), "the index comes before the samples");
  for (const box of ["stts", "stss", "stsz", "stco"]) assert.ok(text.includes(box), box);
  assert.ok(!text.includes("moof") && !text.includes("mvex"), "not fragmented");
  // two segments of the sample: the sample table counts the samples of both
  const sampleCount = (bytes) => new DataView(bytes.buffer).getUint32(latin1(bytes).indexOf("stsz") + 12);
  const single = await bytesOf(await fetchClip([{ url: "https://x/a.ts" }]));
  assert.equal(sampleCount(clip) > sampleCount(single), true);
  await assert.rejects(fetchClip([{ url: "https://x/bad.ts" }]), /403/);
});

test("fetchClip reads fragmented MP4 segments with an init segment", async (t) => {
  const transmuxer = new globalThis.muxjs.mp4.Transmuxer();
  const pieces = [];
  transmuxer.on("data", ({ initSegment, data }) => pieces.push({ initSegment, data }));
  transmuxer.push(new Uint8Array(sampleTs));
  transmuxer.flush();
  const files = { "https://x/init.mp4": pieces[0].initSegment, "https://x/1.m4s": pieces[0].data };
  t.mock.method(globalThis, "fetch", async (url) => ({ ok: true, arrayBuffer: async () => arrayBufferOf(files[url]) }));
  const clip = await bytesOf(await fetchClip([{ url: "https://x/1.m4s", initSegment: { url: "https://x/init.mp4" } }]));
  const fromTs = await bytesOf(await (async () => {
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, arrayBuffer: async () => arrayBufferOf(sampleTs) }));
    return fetchClip([{ url: "https://x/a.ts" }]);
  })());
  assert.deepEqual(clip, fromTs);
});

test("moveEdge keeps the clip between 5 and 60 seconds inside the bounds", () => {
  const bounds = { min: 100, max: 220 };
  const range = { from: 150, to: 180 };
  assert.deepEqual(moveEdge(range, "from", 160, bounds), { from: 160, to: 180 });
  assert.deepEqual(moveEdge(range, "from", 179, bounds), { from: 175, to: 180 }); // at least 5 s
  assert.deepEqual(moveEdge(range, "from", 0, bounds), { from: 120, to: 180 }); // at most 60 s
  assert.deepEqual(moveEdge({ from: 105, to: 140 }, "from", 0, bounds), { from: 100, to: 140 }); // not before the bounds
  assert.deepEqual(moveEdge(range, "to", 152, bounds), { from: 150, to: 155 });
  assert.deepEqual(moveEdge(range, "to", 999, bounds), { from: 150, to: 210 });
  assert.deepEqual(moveEdge({ from: 190, to: 200 }, "to", 999, bounds), { from: 190, to: 220 });
});

test("shiftRange moves the clip as a whole and stops at the bounds", () => {
  const bounds = { min: 100, max: 220 };
  assert.deepEqual(shiftRange({ from: 150, to: 180 }, 10, bounds), { from: 160, to: 190 });
  assert.deepEqual(shiftRange({ from: 150, to: 180 }, -999, bounds), { from: 100, to: 130 });
  assert.deepEqual(shiftRange({ from: 150, to: 180 }, 999, bounds), { from: 190, to: 220 });
});

test("clipFileName replaces characters a file name cannot have", () => {
  assert.equal(clipFileName("  Ace 1/3: wow?  "), "Ace 1_3_ wow_.mp4");
});
