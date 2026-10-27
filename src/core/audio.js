// Audio of an HLS segment as the samples speech recognition wants: 16 kHz, one channel.
// Segments are MPEG-TS on some channels: mux.js (vendor/mux.min.js, loaded by the page) takes the AAC out of them,
// the browser decodes it and resamples it. On other channels they are fMP4, which the browser decodes as it is
// once the init segment is put in front of the part.

export const SAMPLE_RATE = 16000;

/** The AAC (ADTS) stream of an MPEG-TS segment, empty when the segment has no audio. */
export function adtsFromTs(bytes) {
  const { TransportPacketStream, TransportParseStream, ElementaryStream } = globalThis.muxjs.mp2t;
  const packets = new TransportPacketStream();
  const elementary = packets.pipe(new TransportParseStream()).pipe(new ElementaryStream());
  const frames = [];
  elementary.on("data", (pes) => {
    if (pes.type === "audio") frames.push(pes.data);
  });
  packets.push(bytes);
  packets.flush();

  const adts = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) {
    adts.set(frame, at);
    at += frame.length;
  }
  return adts;
}

const MPEG_TS_SYNC_BYTE = 0x47;

/**
 * @param {Uint8Array} bytes a segment; `init` is the init segment its playlist names, when the segment is fMP4
 * @returns {Promise<Float32Array>} the samples of the segment; throws when the browser cannot decode it
 */
export async function decodeSegment(bytes, init = null) {
  if (bytes[0] === MPEG_TS_SYNC_BYTE) return decodeAudio(adtsFromTs(bytes));
  const whole = new Uint8Array((init?.length ?? 0) + bytes.length);
  if (init) whole.set(init);
  whole.set(bytes, init?.length ?? 0);
  return decodeAudio(whole);
}

/** @returns {Promise<Float32Array>} the samples of audio the browser can decode (an ADTS stream, fMP4); `bytes` is not kept */
export async function decodeAudio(bytes) {
  // The context only sets the rate the decoded audio is resampled to.
  const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(bytes.buffer);
  if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const samples = decoded.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / decoded.numberOfChannels;
  }
  return mono;
}
