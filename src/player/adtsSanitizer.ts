/*
 * Drop damaged AAC frames before they reach the browser.
 *
 * Some providers relay channels with damaged audio baked in: now and then an
 * ADTS frame is followed by a few hundred bytes of junk, so its length field
 * no longer leads to the next frame. mpegts.js trusts the length and hands
 * the garbled frame to the browser, and Chrome — which decodes with ffmpeg's
 * strictest error checking since late 2026 — fails the whole pipeline on it
 * (PIPELINE_ERROR_DECODE "Failed to send audio packet for decoding"): the
 * picture stops and the stream has to be reconnected, every few seconds on a
 * bad channel.
 *
 * Within a PES packet, a good frame's length lands exactly on the next
 * frame's syncword (or on the end of the packet). Frames that don't, and the
 * junk around them, are dropped — a few tens of milliseconds of silence
 * instead of a reset. The frames that are kept keep their own timestamps.
 */

export interface AdtsRun {
  /** Index of the run's first frame among the frames of the packet. */
  frameIndex: number;
  data: Uint8Array;
}

export interface AdtsCheck {
  runs: AdtsRun[];
  /** Frames dropped. */
  dropped: number;
  /** Bytes outside any frame. */
  junk: number;
}

const isSync = (d: Uint8Array, o: number) => o + 1 < d.length && d[o] === 0xff && (d[o + 1] & 0xf6) === 0xf0;

/** Fields every frame of one stream shares (profile, sample rate, channels). */
const configOf = (d: Uint8Array, o: number) => ((d[o + 2] & 0xfd) << 8) | (d[o + 3] & 0xc0);

// Scalefactor bands per window for each sampling-frequency index (ISO 14496-3).
const NUM_SWB_LONG = [41, 41, 47, 49, 49, 51, 47, 47, 43, 43, 43, 40, 40];
const NUM_SWB_SHORT = [12, 12, 12, 14, 14, 14, 15, 15, 15, 15, 15, 15, 15];

class Bits {
  private pos: number;
  constructor(private readonly d: Uint8Array, start: number, private readonly end: number) { this.pos = start * 8; }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >> 3 >= this.end) throw new RangeError('overread');
      v = (v << 1) | ((this.d[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
}

/**
 * Parse the start of an AAC-LC raw_data_block the way ffmpeg does and report
 * whether it would be rejected: the first SCE/CPE's ics_info and the first
 * channel's section data (band types and lengths — no Huffman decoding
 * needed). That's where damaged frames fail ("Number of bands (46) exceeds
 * limit (42)", invalid band type, prediction in LC, reserved M/S mode...).
 */
function plausibleRawData(d: Uint8Array, o: number, end: number): boolean {
  const headerLength = (d[o + 1] & 1) ? 7 : 9;
  const sfi = (d[o + 2] >> 2) & 15;
  const channels = ((d[o + 2] & 1) << 2) | (d[o + 3] >> 6);
  if (sfi >= NUM_SWB_LONG.length) return false;
  try {
    const r = new Bits(d, o + headerLength, end);
    const id = r.read(3);
    // DSE (ancillary data) / FIL may come first; not worth parsing.
    if (id === 4 || id === 6) return true;
    // Mono/stereo streams carry SCE / CPE; anything else first is garbage.
    if (id !== 0 && id !== 1) return channels !== 1 && channels !== 2;
    r.read(4); // element_instance_tag

    let short = false;
    let maxSfb = 0;
    let groups = 1;
    const icsInfo = () => {
      if (r.read(1)) return false; // ics_reserved_bit
      const windowSequence = r.read(2);
      r.read(1); // window_shape
      short = windowSequence === 2;
      if (short) {
        maxSfb = r.read(4);
        const grouping = r.read(7);
        groups = 1;
        for (let b = 6; b >= 0; b--) if (!((grouping >> b) & 1)) groups++;
        return maxSfb <= NUM_SWB_SHORT[sfi];
      }
      maxSfb = r.read(6);
      if (r.read(1)) return false; // predictor_data_present: not allowed in AAC-LC
      return maxSfb <= NUM_SWB_LONG[sfi];
    };

    let commonWindow = false;
    if (id === 1) { // CPE
      commonWindow = r.read(1) === 1;
      if (commonWindow) {
        if (!icsInfo()) return false;
        const msMaskPresent = r.read(2);
        if (msMaskPresent === 3) return false; // reserved
        if (msMaskPresent === 1) for (let i = 0; i < groups * maxSfb; i++) r.read(1);
      }
    }
    // individual_channel_stream of the first channel
    r.read(8); // global_gain
    if (!commonWindow && !icsInfo()) return false;
    const sectBits = short ? 3 : 5;
    const esc = (1 << sectBits) - 1;
    for (let g = 0; g < groups; g++) {
      let k = 0;
      while (k < maxSfb) {
        if (r.read(4) === 12) return false; // reserved band type
        let incr;
        do {
          incr = r.read(sectBits);
          k += incr;
          if (k > maxSfb) return false; // "Number of bands exceeds limit"
        } while (incr === esc);
      }
    }
    return true;
  } catch {
    return false; // ran past the end of the frame
  }
}

/**
 * Check the ADTS frames of one PES payload. Returns null when the packet is
 * clean (use it as is), otherwise the runs of good frames to keep.
 *
 * `continuation`: the previous packet ended with an incomplete frame, so this
 * one starts with its rest — leave such packets to mpegts.js.
 */
export function checkAdtsPayload(data: Uint8Array, continuation = false): AdtsCheck | null {
  if (continuation && !isSync(data, 0)) return null;
  let first = 0;
  while (first < data.length && !isSync(data, first)) first++;
  if (first + 4 > data.length) return null; // no frame here at all
  const config = configOf(data, first);
  const runs: AdtsRun[] = [];
  let runStart = -1;
  let runFrame = 0;
  let frame = 0;
  let dropped = 0;
  let junk = first;
  let o = first;

  const closeRun = (end: number) => {
    if (runStart >= 0) runs.push({ frameIndex: runFrame, data: data.subarray(runStart, end) });
    runStart = -1;
  };

  while (o < data.length) {
    if (!isSync(data, o)) {
      const from = o;
      while (o < data.length && !isSync(data, o)) o++;
      junk += o - from;
      continue;
    }
    if (o + 7 > data.length) { // header cut off: let mpegts.js carry it over
      if (runStart < 0) { runStart = o; runFrame = frame; }
      break;
    }
    const len = ((data[o + 3] & 3) << 11) | (data[o + 4] << 3) | (data[o + 5] >> 5);
    const end = o + len;
    const lastInPacket = end >= data.length;
    const good = len > 9
      && configOf(data, o) === config
      && (lastInPacket || isSync(data, end))
      // A frame continued in the next packet can't be fully checked yet.
      && (end > data.length || plausibleRawData(data, o, end));

    if (good) {
      if (runStart < 0) { runStart = o; runFrame = frame; }
      frame++;
      if (lastInPacket) break; // complete, or continued in the next packet
      o = end;
    } else {
      closeRun(o);
      dropped++;
      frame++;
      o++; // resync from the next byte
      while (o < data.length && !isSync(data, o)) { o++; junk++; }
    }
  }
  if (!dropped && !junk) return null;
  closeRun(data.length);
  return { runs, dropped, junk };
}
