import { test } from "node:test";
import assert from "node:assert/strict";
import { addLines, emptyTranscript, endOf, parseAudioPlaylist, windowEnd, windowSegments } from "../src/core/transcript.js";

const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10.000,
0.ts
#EXTINF:10.000,
1.ts
#EXTINF:4.500,
2-unmuted.ts
`;
const url = "https://cdn.example/path/audio_only/index-dvr.m3u8";

test("parseAudioPlaylist gives the start of every segment and whether the playlist ended", () => {
  const { segments, ended } = parseAudioPlaylist(playlist, url);
  assert.deepEqual(segments.map((s) => [s.url, s.start, s.duration]), [
    ["https://cdn.example/path/audio_only/0.ts", 0, 10],
    ["https://cdn.example/path/audio_only/1.ts", 10, 10],
    ["https://cdn.example/path/audio_only/2-unmuted.ts", 20, 4.5],
  ]);
  assert.equal(ended, false);
  assert.equal(parseAudioPlaylist(`${playlist}#EXT-X-ENDLIST`, url).ended, true);
  assert.equal(endOf(segments), 24.5);
});

const segments = Array.from({ length: 100 }, (_, i) => ({ url: `${i}.ts`, start: i * 10, duration: 10 }));

test("windowSegments covers the window with a lead-in and a tail", () => {
  const window = windowSegments(segments, 300, 60);
  // lead-in 5 s: the segment before 300 is needed; tail 15 s: the segments up to 375 s
  assert.deepEqual([window.segments[0].start, window.segments.at(-1).start], [290, 370]);
  assert.deepEqual([window.start, window.end], [290, 380]);
});

test("windowSegments at the end of the audio is shorter, and empty past it", () => {
  assert.equal(windowSegments(segments, 980, 300).end, 1000);
  assert.deepEqual(windowSegments(segments, 2000, 300), { start: 2000, end: 2000, segments: [] });
});

test("addLines takes the chunks starting inside the window and counts their time from the window start", () => {
  const chunks = [
    { timestamp: [2, 8], text: " before " }, // 292 s: the lead-in, the previous window has it
    { timestamp: [10, 20], text: " first " }, // 300 s
    { timestamp: [64, 70], text: " last " }, // 354 s
    { timestamp: [70, 80], text: " in the next window " }, // 360 s
    { timestamp: [30, 31], text: "  " }, // nothing said
  ];
  chunks[2].timestamp[1] = null; // a phrase cut by the end of the audio has no end
  const result = addLines({ version: 7, doneTo: 300, lines: [{ at: 1, end: 2, text: "old" }] }, chunks, 290, 300, 360);
  assert.deepEqual(result, {
    version: 7, // the version of the transcript is not changed by lines added to it
    doneTo: 360,
    lines: [{ at: 1, end: 2, text: "old" }, { at: 300, end: 310, text: "first" }, { at: 354, end: null, text: "last" }],
  });
});

test("windowEnd moves the end of a window to the pause nearest to it", () => {
  // the window starts at 290 s: pauses at 290 + 5, 290 + 12, 290 + 60 s; it should end at 360 s
  assert.equal(windowEnd([5, 12, 60], 290, 300, 360), 350);
  assert.equal(windowEnd([5, 12, 68], 290, 300, 360), 358);
  assert.equal(windowEnd([5, 12, 64], 290, 300, 360), 354);
});

test("windowEnd is the nominal end without a pause to use, and never goes back to the start", () => {
  assert.equal(windowEnd([], 290, 300, 360), 360);
  assert.equal(windowEnd([5, 10], 290, 300, 360), 360); // pauses in the lead-in, before the window
  assert.equal(windowEnd([85], 290, 300, 360), 360); // 375 s is past the middle of the tail
});

test("a phrase on the edge of a window is found once, however the next window cuts the speech", () => {
  // window 1 [0, 300): the speech "…донат Вася" runs 299–305 s, then a pause at 307
  const first = { chunks: [{ timestamp: [299, 305], text: "спасибо за донат Вася" }], pauses: [307.5] };
  const end = windowEnd(first.pauses, 0, 0, 300);
  assert.equal(end, 307.5); // the phrase is the window's, although it starts before 300 and ends after it
  let transcript = addLines(emptyTranscript(), first.chunks, 0, 0, end);

  // window 2 starts at 307.5 - 5 and cuts the same speech differently: its phrase starts at 299.6 and is before `from`
  transcript = addLines(transcript, [{ timestamp: [4.6, 9], text: "спасибо за донат Вася" }, { timestamp: [12, 14], text: "дальше" }], 302.5, end, 600);
  assert.deepEqual(transcript.lines.map((line) => line.text), ["спасибо за донат Вася", "дальше"]);
});
