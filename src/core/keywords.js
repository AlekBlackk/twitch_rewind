// Keyword search in the recognized speech. The list has one word or phrase per line. A word is found by
// any part of it ("дом" finds "домик" and "на доме"), the whole word is then what is highlighted.
// The cost is that a short part also finds unrelated words ("кот" finds "который").

// Whisper writes "е" and "ё" at random, and the case of a word depends on its place in the sentence.
const normalize = (text) => text.toLowerCase().replaceAll("ё", "е");

const LETTER = "[\\p{L}\\p{N}]";
const NOT_LETTER = "[^\\p{L}\\p{N}]";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toPattern(line) {
  const words = normalize(line).split(/\s+/).map((word) => escapeRegExp(word.replaceAll("*", ""))).filter(Boolean);
  // the words of a phrase may be told apart by any punctuation
  return new RegExp(`${LETTER}*${words.join(`${NOT_LETTER}+`)}${LETTER}*`, "gu");
}

/** The list typed by the user as matchers; lines without a letter (an empty one, a lone "*") are skipped. */
export function compileKeywords(text) {
  return text.split("\n")
    .map((line) => line.trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .map((line) => toPattern(line));
}

/** The [start, end) ranges of `text` where a keyword is found, in order and not overlapping. */
export function findMatches(keywords, text) {
  const normalized = normalize(text);
  const found = keywords.flatMap((pattern) => [...normalized.matchAll(pattern)].map((m) => [m.index, m.index + m[0].length]));
  const merged = [];
  for (const range of found.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

// A line can be many seconds of speech, so its start is not when the word was said. Words come at an even
// pace, which puts the first keyword near its real time; the line's start stands in for a line without an end
// (the ones recognized before the end was kept).
const spokenAt = ({ at, end, text }, index) => (end > at ? at + (index / text.length) * (end - at) : at);

/** The transcript lines that contain a keyword: `at` is when the first one was said, `ranges` are to highlight. */
export function findMoments(lines, keywords) {
  if (!keywords.length) return [];
  return lines.flatMap((line) => {
    const ranges = findMatches(keywords, line.text);
    return ranges.length ? [{ ...line, at: spokenAt(line, ranges[0][0]), ranges }] : [];
  });
}
