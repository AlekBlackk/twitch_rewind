import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_SAMPLES, FRAME_SAMPLES, pauseMiddles, speechSegments, vadInput } from "../src/core/vad.js";

// 31.25 frames a second: a probability for every 32 ms
const FRAME = 0.032;
const frames = (...spans) => spans.flatMap(([count, probability]) => Array(count).fill(probability));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < FRAME + 1e-9, `${actual} is not near ${expected}`);

test("speechSegments finds the speech with a little padding", () => {
  // 1 s of silence, 2 s of speech, 1 s of silence
  const [segment, ...rest] = speechSegments(frames([31, 0.01], [63, 0.9], [31, 0.01]), 4.1);
  assert.equal(rest.length, 0);
  near(segment.start, 1 - 0.4);
  near(segment.end, 3 + 0.4);
});

test("a short pause stays inside the phrase, a long one splits it, a click is not speech", () => {
  const probabilities = frames([10, 0], [31, 0.9], [40, 0], [31, 0.9], [10, 0]); // a pause of 1.3 s
  assert.equal(speechSegments(probabilities, 5).length, 1);
  assert.equal(speechSegments(frames([10, 0], [31, 0.9], [80, 0], [31, 0.9], [10, 0]), 6).length, 2); // 2.6 s
  assert.equal(speechSegments(frames([10, 0], [4, 0.9], [10, 0]), 1).length, 0); // 0.13 s
});

test("speech that never pauses is cut at its weakest point before the model's limit", () => {
  const probabilities = frames([30 * 31, 0.9]); // 30 s...
  probabilities.push(...frames([30 * 31, 0.9])); // ...and 30 s more
  probabilities[Math.round(25 / FRAME)] = 0.4; // the weakest voice, at 25 s
  const segments = speechSegments(probabilities, 60);
  assert.ok(segments.length >= 2);
  for (const { start, end } of segments) assert.ok(end - start <= 30 + 1e-9);
  near(segments[0].end, 25);
  assert.equal(segments[1].start, segments[0].end);
});

test("vadInput puts the 64 samples before the frame in front of it, silence before the first frame", () => {
  const audio = Float32Array.from({ length: FRAME_SAMPLES * 3 }, (_, i) => i + 1);
  const first = vadInput(audio, 0);
  assert.equal(first.length, CONTEXT_SAMPLES + FRAME_SAMPLES);
  assert.ok(first.subarray(0, CONTEXT_SAMPLES).every((sample) => sample === 0));
  assert.deepEqual([...first.subarray(CONTEXT_SAMPLES, CONTEXT_SAMPLES + 2)], [1, 2]);

  const second = vadInput(audio, 1);
  assert.deepEqual([...second.subarray(0, 2)], [FRAME_SAMPLES - CONTEXT_SAMPLES + 1, FRAME_SAMPLES - CONTEXT_SAMPLES + 2]);
  assert.equal(second[CONTEXT_SAMPLES - 1], FRAME_SAMPLES); // the last sample of the previous frame
  assert.equal(second[CONTEXT_SAMPLES], FRAME_SAMPLES + 1); // the first one of this frame
  assert.equal(second.at(-1), FRAME_SAMPLES * 2);
});

test("pauseMiddles gives the middles of the real pauses, not of the cuts inside long speech", () => {
  const segments = [{ start: 2, end: 10 }, { start: 14, end: 20 }, { start: 20, end: 30 }, { start: 30.5, end: 40 }];
  // before the first (0–2), between the 1st and 2nd (10–14); 20|20 touch; 30|30.5 is too short; after the last (40–45)
  assert.deepEqual(pauseMiddles(segments, 45), [1, 12, 42.5]);
  assert.deepEqual(pauseMiddles([], 10), [5]);
});
