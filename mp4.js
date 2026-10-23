// Turns a fragmented MP4 (an init segment and parts made of moof + mdat boxes) into a plain one:
// everything about the samples in one moov box at the start, the samples after it in one mdat.
// Players seek in plain files exactly; VLC does not in fragmented ones (and shows no picture before the
// first seek). The samples are moved as they are, nothing is re-encoded.
// shortcut: no edit list, so a track that starts later than the others (44 ms measured, audio against
// video) starts at 0 like them; add an elst box if that offset ever needs to be kept.

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function* boxesOf(bytes, from = 0, to = bytes.length) {
  const view = viewOf(bytes);
  for (let at = from; at + 8 <= to;) {
    const size = view.getUint32(at);
    if (size < 8) return; // 64-bit and open-ended sizes do not occur in HLS parts
    yield { type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), at, body: at + 8, end: at + size };
    at += size;
  }
}

const childrenOf = (bytes, parent) => [...boxesOf(bytes, parent?.body, parent?.end)];
const first = (bytes, parent, type) => childrenOf(bytes, parent).find((child) => child.type === type);
const slice = (bytes, box) => bytes.subarray(box.at, box.end);

const concat = (arrays) => {
  const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let at = 0;
  for (const array of arrays) {
    out.set(array, at);
    at += array.length;
  }
  return out;
};
const u32 = (...values) => {
  const out = new Uint8Array(values.length * 4);
  values.forEach((value, i) => viewOf(out).setUint32(i * 4, value >>> 0));
  return out;
};
const ascii = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const box = (type, ...content) => {
  const body = concat(content);
  return concat([u32(body.length + 8), ascii(type), body]);
};
const fullBox = (type, version, ...content) => box(type, u32(version << 24), ...content);

// Where the fields sit in version 0 and version 1 boxes, counted from the start of the box.
const TIMESCALE = [20, 28]; // mvhd, mdhd
const HEADER_DURATION = [24, 32]; // mvhd, mdhd
const TRACK_ID = [20, 28]; // tkhd
const TRACK_DURATION = [28, 36]; // tkhd
const fieldAt = (bytes, [v0, v1]) => (bytes[8] === 1 ? v1 : v0);
const readField = (bytes, offsets) => viewOf(bytes).getUint32(fieldAt(bytes, offsets));

function withDuration(bytes, offsets, value) {
  const copy = bytes.slice();
  if (copy[8] === 1) viewOf(copy).setBigUint64(fieldAt(copy, offsets), BigInt(value));
  else viewOf(copy).setUint32(fieldAt(copy, offsets), value);
  return copy;
}

/** The samples of each track, and the "chunks" (one per trun) in the order they come in the parts. */
function readFragments(parts, defaultsByTrack) {
  const tracks = new Map(); // track id -> {samples, chunks}
  const chunks = [];
  for (const bytes of parts) {
    const view = viewOf(bytes);
    for (const moof of childrenOf(bytes).filter((b) => b.type === "moof")) {
      for (const traf of childrenOf(bytes, moof).filter((b) => b.type === "traf")) {
        let track;
        let defaults;
        let next = moof.at; // data offsets count from the start of the moof
        for (const b of childrenOf(bytes, traf)) {
          if (b.type === "tfhd") {
            const flags = view.getUint32(b.at + 8) & 0xffffff;
            const id = view.getUint32(b.at + 12);
            defaults = { ...defaultsByTrack.get(id) };
            // after the fixed fields: an optional base offset (ignored) and the sample description index
            let cursor = b.at + 16 + (flags & 0x1 ? 8 : 0) + (flags & 0x2 ? 4 : 0);
            for (const [flag, name] of [[0x8, "duration"], [0x10, "size"], [0x20, "flags"]]) {
              if (!(flags & flag)) continue;
              defaults[name] = view.getUint32(cursor);
              cursor += 4;
            }
            if (!tracks.has(id)) tracks.set(id, { samples: [], chunks: [] });
            track = tracks.get(id);
          } else if (b.type === "trun") {
            const signedOffsets = view.getUint8(b.at + 8) === 1;
            const flags = view.getUint32(b.at + 8) & 0xffffff;
            const count = view.getUint32(b.at + 12);
            let cursor = b.at + 16;
            const read = (flag, fallback, signed = false) => {
              if (!(flags & flag)) return fallback;
              cursor += 4;
              return signed ? view.getInt32(cursor - 4) : view.getUint32(cursor - 4);
            };
            const start = flags & 0x1 ? moof.at + read(0x1, 0, true) : next;
            const firstFlags = read(0x4, null);
            let size = 0;
            for (let i = 0; i < count; i++) {
              const sample = {
                duration: read(0x100, defaults.duration),
                size: read(0x200, defaults.size),
                flags: read(0x400, i === 0 && firstFlags !== null ? firstFlags : defaults.flags),
                offset: read(0x800, 0, signedOffsets), // composition time offset
              };
              track.samples.push({ ...sample, sync: !(sample.flags & 0x10000) });
              size += sample.size;
            }
            const chunk = { count, data: bytes.subarray(start, start + size) };
            track.chunks.push(chunk);
            chunks.push(chunk);
            next = start + size;
          }
        }
      }
    }
  }
  return { tracks, chunks };
}

/** [count, value] for each run of equal values. */
function runs(values) {
  const out = [];
  for (const value of values) {
    if (out.length && out.at(-1)[1] === value) out.at(-1)[0]++;
    else out.push([1, value]);
  }
  return out;
}

function sampleTable(sampleDescription, { samples, chunks }) {
  const durations = runs(samples.map((s) => s.duration));
  const table = [sampleDescription, fullBox("stts", 0, u32(durations.length), ...durations.map((run) => u32(...run)))];
  if (!samples.every((s) => s.sync)) {
    const syncs = samples.flatMap((s, i) => (s.sync ? [i + 1] : []));
    table.push(fullBox("stss", 0, u32(syncs.length, ...syncs)));
  }
  if (samples.some((s) => s.offset)) {
    const offsets = runs(samples.map((s) => s.offset));
    table.push(fullBox("ctts", samples.some((s) => s.offset < 0) ? 1 : 0, u32(offsets.length), ...offsets.map((run) => u32(...run))));
  }
  let firstChunk = 1;
  const perChunk = runs(chunks.map((chunk) => chunk.count)).map(([chunkCount, samplesPerChunk]) => {
    const entry = u32(firstChunk, samplesPerChunk, 1);
    firstChunk += chunkCount;
    return entry;
  });
  table.push(
    fullBox("stsc", 0, u32(perChunk.length), ...perChunk),
    fullBox("stsz", 0, u32(0, samples.length, ...samples.map((s) => s.size))),
    fullBox("stco", 0, u32(chunks.length, ...chunks.map((chunk) => chunk.position))),
  );
  return box("stbl", ...table);
}

// `parent` with the children whose type is in `replace` made by it (a function of the child's box)
const rebuild = (init, parent, replace) =>
  box(parent.type, ...childrenOf(init, parent).map((child) => replace[child.type]?.(child) ?? slice(init, child)));

/** @returns {Blob} a plain MP4 made of `init` (the ftyp and moov of a fragmented file) and its `parts` */
export function toPlainMp4(init, parts) {
  const moov = first(init, null, "moov");
  const defaults = new Map(); // track id -> defaults of its samples, from the trex boxes
  const mvex = first(init, moov, "mvex");
  for (const trex of mvex ? childrenOf(init, mvex).filter((b) => b.type === "trex") : []) {
    const view = viewOf(init);
    defaults.set(view.getUint32(trex.at + 12), {
      duration: view.getUint32(trex.at + 20), size: view.getUint32(trex.at + 24), flags: view.getUint32(trex.at + 28),
    });
  }
  const { tracks, chunks } = readFragments(parts, defaults);

  const mvhd = first(init, moov, "mvhd");
  const movieScale = readField(slice(init, mvhd), TIMESCALE);
  // per track: its samples, and its length in the timescale of the track and of the movie
  const info = new Map();
  for (const trak of childrenOf(init, moov).filter((b) => b.type === "trak")) {
    const id = readField(slice(init, first(init, trak, "tkhd")), TRACK_ID);
    const mdhd = first(init, first(init, trak, "mdia"), "mdhd");
    const scale = readField(slice(init, mdhd), TIMESCALE);
    const track = tracks.get(id);
    const length = track.samples.reduce((sum, s) => sum + s.duration, 0);
    info.set(trak.at, { track, length, movieLength: Math.round((length / scale) * movieScale) });
  }
  const movieLength = Math.max(...[...info.values()].map((i) => i.movieLength));

  const buildMoov = (mdatStart) => {
    let position = mdatStart;
    for (const chunk of chunks) {
      chunk.position = position;
      position += chunk.data.length;
    }
    return rebuild(init, moov, {
      mvex: () => new Uint8Array(0), // marks a fragmented file
      mvhd: (child) => withDuration(slice(init, child), HEADER_DURATION, movieLength),
      trak: (trak) => {
        const { track, length, movieLength: trackMovieLength } = info.get(trak.at);
        return rebuild(init, trak, {
          tkhd: (child) => withDuration(slice(init, child), TRACK_DURATION, trackMovieLength),
          mdia: (mdia) => rebuild(init, mdia, {
            mdhd: (child) => withDuration(slice(init, child), HEADER_DURATION, length),
            minf: (minf) => rebuild(init, minf, {
              stbl: (stbl) => sampleTable(slice(init, first(init, stbl, "stsd")), track),
            }),
          }),
        });
      },
    });
  };

  const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isomiso2mp41"));
  const mdatSize = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  const moovSize = buildMoov(0).length; // positions change the numbers in the tables, not the size
  const mdatHeader = concat([u32(mdatSize + 8), ascii("mdat")]);
  const moovBytes = buildMoov(ftyp.length + moovSize + mdatHeader.length);
  return new Blob([ftyp, moovBytes, mdatHeader, ...chunks.map((chunk) => chunk.data)], { type: "video/mp4" });
}
