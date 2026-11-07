/*
 * Find AAC frames the browser's decoder would reject, using the browser's
 * own decoder (WebCodecs AudioDecoder).
 *
 * Damaged frames can look perfectly well-formed from the outside — the
 * damage is in the Huffman-coded spectral data — and Chrome's ffmpeg-based
 * decoder, run with strict error checking, then fails the whole <video>.
 * WebCodecs goes through the same decoder with the same settings, so a frame
 * it rejects is exactly a frame that would have killed playback.
 */

/* global AudioDecoder, EncodedAudioChunk */

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export interface AdtsConfig {
  objectType: number;
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig. */
  description: Uint8Array;
}

/** Stream configuration from an ADTS header at `o`. */
export function adtsConfig(d: Uint8Array, o: number): AdtsConfig | null {
  const objectType = (d[o + 2] >> 6) + 1;
  const sfi = (d[o + 2] >> 2) & 15;
  const channels = ((d[o + 2] & 1) << 2) | (d[o + 3] >> 6);
  if (sfi >= SAMPLE_RATES.length || !channels) return null;
  const description = new Uint8Array([(objectType << 3) | (sfi >> 1), ((sfi & 1) << 7) | (channels << 3)]);
  return { objectType, sampleRate: SAMPLE_RATES[sfi], channels, description };
}

type DecoderLike = {
  state: string;
  configure(c: unknown): void;
  decode(c: unknown): void;
  flush(): Promise<void>;
  close(): void;
};

export class AacValidator {
  private decoder: DecoderLike | null = null;
  private outputs = 0;
  private failed = false;
  private disabled = false;
  private checked = 0;
  private rejected = 0;

  constructor(private readonly config: AdtsConfig) {}

  static available(): boolean {
    return typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder === 'function'
      && typeof (globalThis as { EncodedAudioChunk?: unknown }).EncodedAudioChunk === 'function';
  }

  get enabled() { return !this.disabled; }

  private open(): DecoderLike {
    const G = globalThis as unknown as { AudioDecoder: new (init: unknown) => DecoderLike };
    this.failed = false;
    const dec = new G.AudioDecoder({
      output: (a: { close(): void }) => { this.outputs++; a.close(); },
      error: () => { this.failed = true; },
    });
    dec.configure({
      codec: `mp4a.40.${this.config.objectType}`,
      sampleRate: this.config.sampleRate,
      numberOfChannels: this.config.channels,
      description: this.config.description,
    });
    return dec;
  }

  /**
   * Decode raw AAC frames (ADTS header stripped); resolves to one verdict per
   * frame (true = decodes). Calls must not overlap.
   */
  async check(frames: Uint8Array[]): Promise<boolean[]> {
    const ok = frames.map(() => true);
    if (this.disabled || !frames.length) return ok;
    const EAC = (globalThis as unknown as { EncodedAudioChunk: new (i: unknown) => unknown }).EncodedAudioChunk;
    let i = 0;
    while (i < frames.length) {
      if (!this.decoder || this.decoder.state === 'closed') {
        try {
          this.decoder = this.open();
        } catch (e) {
          console.warn('[MPEGTS] AAC validation unavailable', e);
          this.disabled = true;
          return frames.map(() => true);
        }
      }
      const start = i;
      this.outputs = 0;
      for (; i < frames.length; i++) {
        this.decoder.decode(new EAC({ type: 'key', timestamp: i, data: frames[i] }));
      }
      try { await this.decoder.flush(); } catch { /* reported through `failed` */ }
      if (!this.failed) break;
      // The decoder stopped at the first frame that produced no output.
      const bad = start + this.outputs;
      if (bad >= frames.length) break;
      ok[bad] = false;
      this.rejected++;
      i = bad + 1;
      try { this.decoder.close(); } catch { /* already closed */ }
      this.decoder = null;
    }
    this.checked += frames.length;
    // Rejecting most frames means our configuration is wrong, not the
    // stream: stop judging rather than mute the channel.
    if (this.checked >= 50 && this.rejected > this.checked / 4) {
      this.disabled = true;
      console.warn('[MPEGTS] AAC validation disabled: rejected too many frames');
      return frames.map(() => true);
    }
    return ok;
  }

  close() {
    try { this.decoder?.close(); } catch { /* noop */ }
    this.decoder = null;
    this.disabled = true;
  }
}
