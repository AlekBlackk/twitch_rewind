import { test } from "node:test";
import assert from "node:assert/strict";
import { compileKeywords, findMatches, findMoments } from "../src/core/keywords.js";

const matches = (list, text) => findMatches(compileKeywords(list), text);

test("a word is found in any case, with е and ё alike", () => {
  assert.deepEqual(matches("Ёлка", "Новогодняя елка стоит"), [[11, 15]]);
});

test("a part of a word finds every word containing it, and the whole word is the match", () => {
  assert.deepEqual(matches("дом", "я с домик, на доме и Дома"), [[4, 9], [14, 18], [21, 25]]);
  assert.deepEqual(matches("донат", "задонатил и донатом"), [[0, 9], [12, 19]]); // the root is not at the start
  assert.deepEqual(matches("дом", "карта"), []);
});

test("a * is accepted and means nothing", () => {
  assert.deepEqual(matches("дом*", "на доме"), [[3, 7]]);
});

test("a phrase is found whatever punctuation is between its words", () => {
  assert.deepEqual(matches("тест на беременность", "Это тест, на беременность!"), [[4, 25]]);
});

test("overlapping matches of several keywords are merged", () => {
  assert.deepEqual(matches("кот\nкот спит", "кот спит"), [[0, 8]]);
});

test("lines without a letter match nothing", () => {
  assert.deepEqual(compileKeywords("\n  \n*\n"), []);
  assert.deepEqual(matches("a.b", "axb a.b"), [[4, 7]]); // special characters are taken literally
});

test("findMoments keeps the lines with a keyword and their ranges", () => {
  const lines = [{ at: 1, text: "привет" }, { at: 70, text: "Спасибо за донаты" }];
  assert.deepEqual(findMoments(lines, compileKeywords("донат")), [{ at: 70, text: "Спасибо за донаты", ranges: [[11, 17]] }]);
  assert.deepEqual(findMoments(lines, []), []);
});

test("a keyword in a long line is placed where in the line it is said", () => {
  const line = { at: 100, end: 120, text: "раз два три четыре пять домик шесть семь" }; // "домик" is at 24 of 40 characters
  assert.equal(findMoments([line], compileKeywords("домик"))[0].at, 112);
  const first = { ...line, text: "домик раз два три четыре пять шесть семь" };
  assert.equal(findMoments([first], compileKeywords("домик"))[0].at, 100);
  assert.equal(findMoments([{ ...line, end: null }], compileKeywords("домик"))[0].at, 100); // no end: the start of the line
});
