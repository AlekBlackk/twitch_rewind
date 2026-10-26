import { test } from "node:test";
import assert from "node:assert/strict";
import { speechSegments } from "../src/core/vad.js";

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
