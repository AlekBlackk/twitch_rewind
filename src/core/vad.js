// Which parts of the audio are speech. Whisper is given only those: on music, noise and silence it makes up
// phrases, and a 30 second chunk cut in the middle of a phrase gets glued to its neighbour wrongly.
// The speech probability of each frame comes from Silero VAD (see whisper-worker.js); this file turns the
// probabilities into segments, which are recognized one by one: the result for a phrase then does not depend on
// which neighbours it shares a 30 second piece with, and so not on where a window of the broadcast happens to begin.
import { SAMPLE_RATE } from "./audio.js";

export const FRAME_SAMPLES = 512; // what Silero VAD takes at 16 kHz...
export const CONTEXT_SAMPLES = 64; // ...with the last 64 samples before the frame in front of it (v5 was trained so, and hears badly without)
const FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE;

const SPEECH_STARTS = 0.5; // probability: speech starts above it and goes on until it falls below SPEECH_ENDS
const SPEECH_ENDS = 0.35;
const MIN_SPEECH_SECONDS = 0.25; // shorter sounds are clicks, not words
const MIN_SILENCE_SECONDS = 2; // shorter pauses stay inside the speech: cut into short bits, a voice under music is lost
const PADDING_SECONDS = 0.4; // the VAD is late to hear a word start and early to lose its tail
const MAX_SEGMENT_SECONDS = 30; // what Whisper takes at once
const MIN_PAUSE_SECONDS = 1; // the pause between segments that is a real one: segments cut out of long speech touch each other

/** What the VAD is asked for frame number `frame` of `audio`: the context before the frame, then the frame. */
export function vadInput(audio, frame) {
  const input = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
  const from = frame * FRAME_SAMPLES - CONTEXT_SAMPLES; // negative for the first frame, whose context is silence
  input.set(audio.subarray(Math.max(0, from), (frame + 1) * FRAME_SAMPLES), Math.max(0, -from));
  return input;
}

/** Speech as [{ start, end }] seconds, a segment being speech with no pause of 2 s or more, and none longer than 30 s. */
export function speechSegments(probabilities, totalSeconds) {
  const spans = [];
  let start = null;
  probabilities.forEach((probability, i) => {
    if (start === null && probability >= SPEECH_STARTS) start = i * FRAME_SECONDS;
    else if (start !== null && probability < SPEECH_ENDS) {
      spans.push({ start, end: i * FRAME_SECONDS });
      start = null;
    }
  });
  if (start !== null) spans.push({ start, end: probabilities.length * FRAME_SECONDS });

  const joined = [];
  for (const span of spans) {
    const last = joined.at(-1);
    if (last && span.start - last.end < MIN_SILENCE_SECONDS) last.end = span.end;
    else joined.push({ ...span });
  }
  return joined
    .filter(({ start: from, end }) => end - from >= MIN_SPEECH_SECONDS)
    .map(({ start: from, end }) => ({ start: Math.max(0, from - PADDING_SECONDS), end: Math.min(totalSeconds, end + PADDING_SECONDS) }))
    .flatMap((segment) => splitLong(segment, probabilities));
}

// A segment longer than the model takes is cut where the voice is weakest within the last 10 seconds it may hold.
function splitLong({ start, end }, probabilities) {
  const pieces = [];
  while (end - start > MAX_SEGMENT_SECONDS) {
    const last = Math.min(Math.floor((start + MAX_SEGMENT_SECONDS) / FRAME_SECONDS), probabilities.length - 1);
    let cut = Math.floor((start + MAX_SEGMENT_SECONDS - 10) / FRAME_SECONDS);
    for (let frame = cut; frame <= last; frame++) if (probabilities[frame] < probabilities[cut]) cut = frame;
    pieces.push({ start, end: cut * FRAME_SECONDS });
    start = cut * FRAME_SECONDS;
  }
  pieces.push({ start, end });
  return pieces;
}

/** The middles of the pauses between `segments` (and before the first, after the last): the places a phrase is surely not cut. */
export function pauseMiddles(segments, totalSeconds) {
  const edges = [0, ...segments.flatMap(({ start, end }) => [start, end]), totalSeconds];
  const middles = [];
  for (let i = 0; i < edges.length; i += 2) {
    if (edges[i + 1] - edges[i] >= MIN_PAUSE_SECONDS) middles.push((edges[i] + edges[i + 1]) / 2);
  }
  return middles;
}
