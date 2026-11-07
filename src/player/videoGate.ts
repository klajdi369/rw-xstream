/*
 * Optional ("Skip damaged video frames" in Settings): check every video frame
 * with the browser's own decoder before the player gets it.
 *
 * Some providers relay channels with damaged video now and then. Chrome
 * decodes with ffmpeg's strictest error checking, so a single damaged frame
 * fails the whole <video> and the stream has to be reconnected. Here each
 * frame is first decoded by a WebCodecs VideoDecoder (same decoder, same
 * settings) and only handed on once it decoded. When the check decoder
 * fails, the frames it hadn't confirmed are dropped along with everything up
 * to the next keyframe — the picture holds for a moment while sound goes on —
 * and the join repairs start afresh at that keyframe, as if we had just
 * tuned in (the player's decoder fills the gap the same way it does then).
 *
 * Costs a second software decode of the video (about 40% of a core for a
 * 1080i channel), hence off by default.
 */

import { JoinFixer, VideoSample } from './joinFixer';
import { H264SliceInfo, PictureInfo } from './h264JoinRepair';

export type GateSample = VideoSample & { dts?: number };

interface DecoderLike {
  state: string;
  configure(c: unknown): void;
  decode(c: unknown): void;
  close(): void;
}

interface Pending { idx: number; sample: GateSample; info: PictureInfo | null }

const hex = (b: number) => b.toString(16).padStart(2, '0');

/** AVCDecoderConfigurationRecord for one SPS/PPS pair. */
function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]);
  out.set(sps, 8);
  let o = 8 + sps.length;
  out.set([1, pps.length >> 8, pps.length & 0xff], o);
  out.set(pps, o + 3);
  return out;
}

export class VideoGate {
  private fixer = new JoinFixer();
  private readonly slices = new H264SliceInfo();
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private decoder: DecoderLike | null = null;
  private pending: Pending[] = [];
  private seq = 0;
  private maxOut = -1;
  private outputsSinceOpen = 0;
  private failuresWithoutOutput = 0;
  /** After damage: drop everything until the next keyframe. */
  private skipping = false;
  private disabled = false;
  private lastReleased: PictureInfo | null = null;
  /** When the oldest unconfirmed sample went in (0: none waiting). */
  private waitingSince = 0;
  private dropped = 0;
  private lastReport = 0;
  /** Samples waiting to go through intake (new ones, or ones to re-check). */
  private incoming: GateSample[] = [];
  private draining = false;
  private passOut: GateSample[] = [];
  /** Index of the last sample the check decoder has taken off its queue. */
  private reached = -1;
  /** Index of the last sample submitted to the current check decoder. */
  private submitted = -1;

  constructor(private readonly release: (samples: GateSample[]) => void) {}

  static available(): boolean {
    const g = globalThis as { VideoDecoder?: unknown; EncodedVideoChunk?: unknown };
    return typeof g.VideoDecoder === 'function' && typeof g.EncodedVideoChunk === 'function';
  }

  /** Feed a parameter set (SPS/PPS NAL, header byte included). */
  learn(nal: Uint8Array | null | undefined) {
    if (!nal || nal.length < 4) return;
    const type = nal[0] & 0x1f;
    if (type === 7) this.sps = nal.slice();
    if (type === 8) this.pps = nal.slice();
    this.fixer.learn(nal);
    this.slices.learn(nal);
  }

  /** New samples from the demuxer, in decoding order. */
  push(samples: GateSample[]) {
    this.incoming.push(...samples);
    this.drain();
  }

  private drain() {
    if (this.draining) return; // onError() during intake queues more work
    this.draining = true;
    try {
      while (this.incoming.length) this.intake(this.incoming.shift()!);
    } finally {
      this.draining = false;
    }
    if (this.passOut.length) {
      const out = this.passOut;
      this.passOut = [];
      this.release(out);
    }
  }

  private intake(s: GateSample) {
    for (const u of s.units) if (u.type === 7 || u.type === 8) this.learn(u.data.subarray(4));

    if (this.skipping) {
      if (!s.isKeyframe) { this.dropped++; return; }
      // Resume here as if we had just tuned in.
      this.skipping = false;
      this.fixer = new JoinFixer();
      this.fixer.learn(this.sps);
      this.fixer.learn(this.pps);
    }

    const one = { samples: [s as VideoSample], length: s.length };
    this.fixer.process(one);
    if (!one.samples.length) return; // dropped by the join repairs

    if (this.disabled) { this.passOut.push(s); return; }
    if (!this.decoder) {
      this.decoder = this.open();
      if (!this.decoder) { this.disable(this.passOut); this.passOut.push(s); return; }
    }

    const idx = this.seq++;
    if (!this.pending.length) this.waitingSince = Date.now();
    this.pending.push({ idx, sample: s, info: this.slices.info(s.units.map((u) => u.data.subarray(4))) });
    try {
      const data = new Uint8Array(s.units.reduce((n, u) => n + u.data.length, 0));
      let o = 0;
      for (const u of s.units) { data.set(u.data, o); o += u.data.length; }
      const G = globalThis as unknown as { EncodedVideoChunk: new (i: unknown) => unknown };
      this.decoder.decode(new G.EncodedVideoChunk({ type: s.isKeyframe ? 'key' : 'delta', timestamp: idx, data }));
      this.submitted = idx;
    } catch (e) {
      this.onError(e);
      return;
    }

    // Nothing confirmed for a long time: the check isn't working here.
    // (Time, not count: a provider sends seconds of video in one burst at
    // connect, and the decoder works through it asynchronously.)
    if (this.pending.length && Date.now() - this.waitingSince > 4000) {
      console.warn('[MPEGTS] video check produced no frames; turning it off');
      this.disable(this.passOut);
    }
  }

  close() {
    try { this.decoder?.close(); } catch { /* noop */ }
    this.decoder = null;
    this.disabled = true;
    this.pending = [];
  }

  private disable(into: GateSample[]) {
    this.disabled = true;
    try { this.decoder?.close(); } catch { /* noop */ }
    this.decoder = null;
    into.push(...this.pending.map((p) => p.sample));
    this.pending = [];
  }

  private open(): DecoderLike | null {
    if (!this.sps || !this.pps) return null;
    const G = globalThis as unknown as { VideoDecoder: new (init: unknown) => DecoderLike };
    this.outputsSinceOpen = 0;
    try {
      const dec = new G.VideoDecoder({
        output: (frame: { timestamp: number; close(): void }) => {
          const idx = frame.timestamp;
          frame.close();
          if (dec !== this.decoder) return;
          this.outputsSinceOpen++;
          this.failuresWithoutOutput = 0;
          if (idx > this.maxOut) this.maxOut = idx;
          if (idx > this.reached) this.reached = idx;
          this.releaseConfirmed();
        },
        error: (e: unknown) => { if (dec === this.decoder) this.onError(e); },
      }) as DecoderLike & { decodeQueueSize: number; ondequeue: (() => void) | null };
      // How far the decoder has got: what it has taken off its queue.
      dec.ondequeue = () => {
        if (dec === this.decoder) this.reached = Math.max(this.reached, this.submitted - dec.decodeQueueSize);
      };
      dec.configure({
        codec: `avc1.${hex(this.sps[1])}${hex(this.sps[2])}${hex(this.sps[3])}`,
        description: avcC(this.sps, this.pps),
        // The player's decoder for these streams is ffmpeg in software; check
        // with the same one. Not optimizeForLatency: that makes ffmpeg decode
        // on one thread, which can't keep up with 1080i in real time on many
        // machines — frames then trickle out and playback stalls.
        hardwareAcceleration: 'prefer-software',
      });
      return dec;
    } catch (e) {
      console.warn('[MPEGTS] video check unavailable', e);
      return null;
    }
  }

  /**
   * A frame has come out of the check decoder: every sample up to its decode
   * index decoded. Hand those on — but never the first field of a frame
   * without its second field, so a later cut always falls between frames.
   */
  private releaseConfirmed() {
    let n = 0;
    let prev = this.lastReleased;
    while (n < this.pending.length && this.pending[n].idx <= this.maxOut) {
      const cur = this.pending[n].info;
      const second = !!(cur?.field && prev?.field && prev.frameNum === cur.frameNum && prev.bottom !== cur.bottom);
      if (cur?.field && !second) {
        const next = this.pending[n + 1];
        if (!next || next.idx > this.maxOut) break; // wait for its partner
      }
      prev = cur;
      n++;
    }
    if (!n) return;
    this.lastReleased = prev;
    const out = this.pending.splice(0, n).map((p) => p.sample);
    this.waitingSince = Date.now();
    this.release(out);
  }

  private onError(e: unknown) {
    try { this.decoder?.close(); } catch { /* already closed */ }
    this.decoder = null;
    if (!this.outputsSinceOpen && ++this.failuresWithoutOutput >= 3) {
      // Never decodes anything here: our configuration, not the stream.
      console.warn('[MPEGTS] video check keeps failing; turning it off', e);
      const out: GateSample[] = [];
      this.disable(out);
      if (out.length) this.release(out);
      return;
    }
    // The damaged sample is one the decoder had already taken: at most
    // `reached`. Samples queued behind it were never decoded — after a
    // connect burst that can be many seconds of video — so keep those from
    // the first keyframe past that point and check them again with a fresh
    // decoder; drop only the stretch in between.
    const from = this.pending.findIndex((p) => p.idx > Math.max(this.reached, this.maxOut) && p.sample.isKeyframe);
    const recheck = from < 0 ? [] : this.pending.slice(from).map((p) => p.sample);
    this.dropped += from < 0 ? this.pending.length : from;
    this.pending = [];
    this.lastReleased = null;
    this.skipping = true;
    this.reached = -1;
    this.submitted = -1;
    this.incoming.unshift(...recheck);
    // From the decoder's error callback: work through them now. (From inside
    // intake, drain() is already running and picks them up next.)
    queueMicrotask(() => this.drain());
    const now = Date.now();
    if (now - this.lastReport > 5000) {
      this.lastReport = now;
      console.info(`[MPEGTS] damaged video: skipping to the next keyframe (${this.dropped} frames skipped so far)`);
    }
  }
}
