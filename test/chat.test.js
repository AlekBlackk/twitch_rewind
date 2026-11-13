import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleMessages } from "../src/core/chat.js";

const at = (...times) => times.map((time, i) => ({ id: String(i), at: time }));

test("visibleMessages returns the messages sent up to the given second", () => {
  const messages = at(1, 2, 2, 5, 9);
  assert.deepEqual(visibleMessages(messages, 2).map((m) => m.id), ["0", "1", "2"]);
  assert.deepEqual(visibleMessages(messages, 100).map((m) => m.id), ["0", "1", "2", "3", "4"]);
});

test("visibleMessages is empty before the first message and for no messages", () => {
  assert.deepEqual(visibleMessages(at(5, 6), 4), []);
  assert.deepEqual(visibleMessages([], 4), []);
});

test("visibleMessages keeps only the newest 150", () => {
  const messages = at(...Array.from({ length: 400 }, (_, i) => i));
  const shown = visibleMessages(messages, 299);
  assert.equal(shown.length, 150);
  assert.equal(shown[0].id, "150");
  assert.equal(shown.at(-1).id, "299");
});
