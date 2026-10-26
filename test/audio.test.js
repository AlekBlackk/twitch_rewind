import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInThisContext } from "node:vm";
import { adtsFromTs } from "../src/core/audio.js";

test("adtsFromTs takes the AAC stream out of an MPEG-TS segment", async () => {
  runInThisContext(await readFile(new URL("../vendor/mux.min.js", import.meta.url), "utf8")); // sets globalThis.muxjs, as in the page
  const adts = adtsFromTs(await readFile(new URL("./fixtures/sample.ts", import.meta.url)));
  assert.ok(adts.length > 0);
  // every ADTS frame starts with 12 set bits
  assert.equal(adts[0], 0xff);
  assert.equal(adts[1] & 0xf0, 0xf0);
});

test("adtsFromTs gives nothing for a segment without audio", () => {
  const empty = new Uint8Array(188 * 3).fill(0xff);
  for (let packet = 0; packet < 3; packet++) empty[packet * 188] = 0x47;
  assert.equal(adtsFromTs(empty).length, 0);
});
