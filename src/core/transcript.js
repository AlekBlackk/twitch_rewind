// The speech of a broadcast, recognized from its audio and kept per broadcast, so the keywords can be
// changed (or the window reopened) without recognizing the same hours again.
//   transcript = { version, doneTo: seconds recognized so far, lines: [{ at: seconds, end: seconds (null if unknown), text }] }
// A line is a phrase as the model delimited it.
// Audio is cut into windows. A window is recognized with a lead-in before it and a tail after it, so no
// phrase is cut at its edges; a line belongs to the window it starts in.

// What recognized the transcript: raise it when the recognition gets better and old transcripts should be redone.
// 2: the speech is found first (vad.js); before, lines could be glued from different places and invented over noise.
export const TRANSCRIPT_VERSION = 2;

export const emptyTranscript = () => ({ version: TRANSCRIPT_VERSION, doneTo: 0, lines: [] });

export const WINDOW_SECONDS = 300; // while catching up: the model works on long windows without pauses
export const LIVE_WINDOW_SECONDS = 60; // near the live edge: shorter, so the moments show up sooner
export const LEAD_SECONDS = 5;
export const TAIL_SECONDS = 15;

const PREFIX = "transcript:";

/** The segments of a media playlist, each with its start in seconds from the broadcast start. */
export function parseAudioPlaylist(text, playlistUrl) {
  const segments = [];
  let start = 0;
  let duration = null;
  for (const line of text.split("\n").map((l) => l.trim())) {
    const extinf = /^#EXTINF:([\d.]+)/.exec(line);
    if (extinf) {
      duration = Number(extinf[1]);
    } else if (line && !line.startsWith("#") && duration !== null) {
      segments.push({ url: new URL(line, playlistUrl).href, start, duration });
      start += duration;
      duration = null;
    }
  }
  return { segments, ended: text.includes("#EXT-X-ENDLIST") };
}

export const endOf = (segments) => (segments.length ? segments.at(-1).start + segments.at(-1).duration : 0);

/** The window of `length` seconds from `from`, with the segments that cover it, its lead-in and its tail. */
export function windowSegments(segments, from, length) {
  const covered = segments.filter((s) => s.start + s.duration > from - LEAD_SECONDS && s.start < from + length + TAIL_SECONDS);
  return { start: covered[0]?.start ?? from, end: covered.length ? endOf(covered) : from, segments: covered };
}

/**
 * `transcript` with the lines of a recognized window. `chunks` are what the model gave ({ timestamp: [start, end], text },
 * the time counted from the window's `windowStart`); only those starting in [from, to) are taken.
 */
export function addLines(transcript, chunks, windowStart, from, to) {
  const lines = chunks
    .map(({ timestamp, text }) => ({
      at: windowStart + timestamp[0],
      end: timestamp[1] === null ? null : windowStart + timestamp[1],
      text: text.trim(),
    }))
    .filter(({ at, text }) => text && at >= from && at < to);
  return { ...transcript, doneTo: to, lines: [...transcript.lines, ...lines] }; // the version stays: new lines do not make old ones better
}

export async function loadTranscript(streamId) {
  const { [PREFIX + streamId]: stored } = await chrome.storage.local.get(PREFIX + streamId);
  return stored ?? emptyTranscript();
}

export const saveTranscript = (streamId, transcript) => chrome.storage.local.set({ [PREFIX + streamId]: transcript });
