/*
 * Make live MPEG-TS channels decodable in Chrome when we join mid-stream.
 *
 * Since late 2026 Chrome decodes H.264 in software with ffmpeg's strictest
 * error checking (AV_EF_EXPLODE; the kStrictFFmpegCodecs kill switch was
 * removed), so any decoding error is fatal: PIPELINE_ERROR_DECODE "Failed to
 * send video packet for decoding". Broadcast channels re-streamed from
 * satellite/cable — typically 1080i/576i with open GOPs and often no IDR
 * frames at all — always produce such errors right after we tune in, because
 * their first pictures refer to pictures sent before we joined. Result: one
 * frame on screen, then "Cannot play this stream". (The proxy works because
 * it re-encodes.)
 *
 * Two repairs, both only for the first GOP or so:
 *  1. Drop the "leading pictures" of the keyframe we start on: B-pictures that
 *     come after it in decoding order but are shown before it, and predict
 *     from the previous GOP we never received.
 *  2. Rewrite memory-management commands that name pictures we never
 *     received (see h264JoinRepair.ts).
 *
 * mpegts.js doesn't expose its demuxer, so this reaches into the player's
 * internals (MSEPlayer → PlayerEngineMainThread → Transmuxer →
 * TransmuxingController → TSDemuxer). Only the main-thread engine
 * (enableWorker: false) is supported; if those internals change the hook just
 * isn't installed and playback behaves as before.
 */

import { H264JoinRepair } from './h264JoinRepair';
import { checkAdtsPayload, AdtsRun } from './adtsSanitizer';
import { AacValidator, adtsConfig } from './aacValidator';

interface NalUnit { type: number; data: Uint8Array } // data: 4-byte length + NAL
interface VideoSample {
  units: NalUnit[];
  length: number;
  isKeyframe: boolean;
  pts: number;
}
interface VideoTrack { samples: VideoSample[]; length: number }

/** Drops the leading pictures of the first keyframe. */
export class LeadingPictureFilter {
  /** pts of the keyframe we started on; null until it arrives. */
  private startPts: number | null = null;
  private done = false;
  dropped = 0;

  /** Returns the samples to keep (all of them once past the first GOP). */
  filter(samples: VideoSample[]): VideoSample[] {
    if (this.done) return samples;
    const kept: VideoSample[] = [];
    for (const s of samples) {
      if (this.done) { kept.push(s); continue; }
      if (s.isKeyframe) {
        if (this.startPts === null) this.startPts = s.pts;
        else if (s.pts > this.startPts) this.done = true; // next GOP: references are in place
        kept.push(s);
      } else if (this.startPts === null || s.pts < this.startPts) {
        this.dropped++; // before the first keyframe, or a leading picture of it
      } else {
        kept.push(s);
      }
    }
    return kept;
  }
}

/** Both repairs over a demuxer's video track, applied once per sample. */
export class JoinFixer {
  private readonly leading = new LeadingPictureFilter();
  private readonly repair = new H264JoinRepair();
  /** Samples already processed (the remuxer may leave one in the track). */
  private readonly seen = new WeakSet<VideoSample>();
  private announced = false;

  learn(nal: Uint8Array | null | undefined) { this.repair.learn(nal); }

  process(track: VideoTrack) {
    const fresh = track.samples.filter((s) => !this.seen.has(s));
    if (!fresh.length) return;
    const keep = new Set(this.leading.filter(fresh));
    let changed = keep.size !== fresh.length;

    for (const s of fresh) {
      this.seen.add(s);
      if (!keep.has(s) || !this.repair.isActive) continue;
      if (s.isKeyframe) this.repair.keyframe();
      for (const unit of s.units) {
        const nal = unit.data.subarray(4);
        const fixed = this.repair.nal(nal);
        if (fixed === nal) continue;
        const data = new Uint8Array(4 + fixed.length);
        new DataView(data.buffer).setUint32(0, fixed.length);
        data.set(fixed, 4);
        s.length += data.length - unit.data.length;
        unit.data = data;
        changed = true;
      }
    }

    if (!changed) return;
    if (!this.announced && this.leading.dropped) {
      this.announced = true;
      console.info(`[MPEGTS] dropped ${this.leading.dropped} undecodable picture(s) at stream start`);
    }
    const dropped = new Set(fresh.filter((s) => !keep.has(s)));
    track.samples = track.samples.filter((s) => !dropped.has(s));
    track.length = track.samples.reduce((n, s) => n + s.length, 0);
  }
}

/* ---- Hooking into mpegts.js internals ---------------------------------- */

type DataCallback = (audio: unknown, video: VideoTrack | null) => void;

interface DemuxerLike {
  onDataAvailable?: DataCallback;
  video_metadata_?: { sps?: { data?: Uint8Array }; pps?: { data?: Uint8Array } };
  parseADTSAACPayload?: (data: Uint8Array, pts: number | undefined) => void;
  aac_last_incomplete_data_?: Uint8Array | null;
  audio_init_segment_dispatched_?: boolean;
  dispatchAudioMediaSegment?: () => void;
  destroy?: () => void;
}

/** Join consecutive frames back into runs (a gap starts a new run). */
function regroup(frames: { frameIndex: number; bytes: Uint8Array }[]): AdtsRun[] {
  const groups: { frameIndex: number; parts: Uint8Array[] }[] = [];
  let next = -1;
  for (const f of frames) {
    if (f.frameIndex !== next) groups.push({ frameIndex: f.frameIndex, parts: [] });
    groups[groups.length - 1].parts.push(f.bytes);
    next = f.frameIndex + 1;
  }
  return groups.map((g) => {
    const data = new Uint8Array(g.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of g.parts) { data.set(p, o); o += p.length; }
    return { frameIndex: g.frameIndex, data };
  });
}

/**
 * Drop damaged AAC frames before mpegts.js parses them: first frames whose
 * length doesn't chain to the next frame (adtsSanitizer.ts), then — where
 * WebCodecs is available — frames the browser's own decoder rejects
 * (aacValidator.ts). The validation is asynchronous, so each PES packet is
 * handed to mpegts.js a few milliseconds later than it would have been, in
 * order; the frames kept keep their own timestamps.
 */
function hookAudio(demuxer: DemuxerLike) {
  const parse = demuxer.parseADTSAACPayload;
  if (typeof parse !== 'function') return;
  let queue: Promise<void> = Promise.resolve();
  let validator: AacValidator | null | undefined;
  let dead = false;
  let droppedTotal = 0;
  let lastReport = 0;

  const destroy = demuxer.destroy;
  if (typeof destroy === 'function') {
    demuxer.destroy = function (this: DemuxerLike) {
      dead = true;
      validator?.close();
      destroy.call(this);
    };
  }

  const report = (n: number) => {
    droppedTotal += n;
    const now = Date.now();
    if (now - lastReport > 5000) {
      lastReport = now;
      console.info(`[MPEGTS] dropped damaged audio frames (${droppedTotal} so far)`);
    }
  };

  const handle = async (data: Uint8Array, pts: number | undefined, validate: boolean) => {
    if (dead) return;
    const continuation = !!demuxer.aac_last_incomplete_data_;
    const check = checkAdtsPayload(data, continuation);
    if (!check && continuation) { parse.call(demuxer, data, pts); return; }
    let runs: AdtsRun[] = check ? check.runs : [{ frameIndex: 0, data }];
    let dropped = check ? check.dropped : 0;
    const first = runs[0]?.data;
    if (!first || first.length < 7) { parse.call(demuxer, data, pts); return; }
    const config = adtsConfig(first, 0);

    if (validator === undefined) validator = config && AacValidator.available() ? new AacValidator(config) : null;
    if (validate && validator?.enabled) {
      // Split the runs into frames; validate the complete ones.
      const frames: { frameIndex: number; bytes: Uint8Array; complete: boolean }[] = [];
      for (const run of runs) {
        let o = 0;
        let idx = run.frameIndex;
        while (o + 7 <= run.data.length) {
          const len = ((run.data[o + 3] & 3) << 11) | (run.data[o + 4] << 3) | (run.data[o + 5] >> 5);
          if (len < 7) break;
          const complete = o + len <= run.data.length;
          frames.push({ frameIndex: idx++, bytes: run.data.subarray(o, Math.min(o + len, run.data.length)), complete });
          if (!complete) break;
          o += len;
        }
      }
      const complete = frames.filter((f) => f.complete);
      const verdicts = await validator.check(complete.map((f) => f.bytes.subarray((f.bytes[1] & 1) ? 7 : 9)));
      if (dead) return;
      const bad = new Set(complete.filter((_, i) => !verdicts[i]));
      if (bad.size) {
        dropped += bad.size;
        runs = regroup(frames.filter((f) => !bad.has(f)));
      }
    }

    if (dropped) report(dropped);
    if (!check && !dropped) { parse.call(demuxer, data, pts); return; }
    const frameTicks = config ? (1024 * 90000) / config.sampleRate : 0;
    for (const run of runs) {
      parse.call(demuxer, run.data, pts === undefined ? undefined : pts + run.frameIndex * frameTicks);
    }
  };

  let pending = 0;
  const failed = (e: unknown) => { if (!dead) console.warn('[MPEGTS] audio check failed', e); };
  demuxer.parseADTSAACPayload = (data, pts) => {
    if (!pending && !demuxer.audio_init_segment_dispatched_) {
      // Until mpegts.js has set up the audio track, handle packets right
      // away (structural checks only): delaying the audio init segment makes
      // Chrome initialise the media pipeline without it.
      handle(data, pts, false).catch(failed);
      return;
    }
    const copy = data.slice();
    pending++;
    queue = queue
      .then(() => handle(copy, pts, true))
      // mpegts.js hands parsed samples on at the end of each chunk it reads;
      // ours arrive after that, so hand them on ourselves.
      .then(() => { if (!dead) demuxer.dispatchAudioMediaSegment?.(); })
      .catch(failed)
      .finally(() => { pending--; });
  };
}
interface ControllerLike {
  _demuxer?: DemuxerLike;
  _setupTSDemuxerRemuxer?: (probe: unknown) => void;
  __joinFix?: boolean;
}
interface EngineLike {
  load?: () => void;
  _transmuxer?: { _controller?: ControllerLike } | null;
  __joinFix?: boolean;
}

function hookController(controller: ControllerLike | undefined): boolean {
  if (!controller || typeof controller._setupTSDemuxerRemuxer !== 'function') return false;
  if (controller.__joinFix) return true;
  controller.__joinFix = true;

  const setup = controller._setupTSDemuxerRemuxer;
  controller._setupTSDemuxerRemuxer = function (this: ControllerLike, probe: unknown) {
    setup.call(this, probe);
    const demuxer = this._demuxer;
    const forward = demuxer?.onDataAvailable;
    if (!demuxer || typeof forward !== 'function') return;

    hookAudio(demuxer);
    const fixer = new JoinFixer();
    demuxer.onDataAvailable = (audio, video) => {
      if (video?.samples?.length) {
        try {
          // The demuxer consumes the first SPS/PPS before it produces any
          // samples, so they're only in its metadata.
          const meta = demuxer.video_metadata_;
          fixer.learn(meta?.sps?.data?.subarray(4));
          fixer.learn(meta?.pps?.data?.subarray(4));
          fixer.process(video);
        } catch (e) {
          console.warn('[MPEGTS] join fix failed', e);
        }
      }
      forward(audio, video);
    };
  };
  return true;
}

/**
 * Install the join fix on an mpegts.js player. Call after createPlayer() and
 * before load(). Returns false if the player's internals aren't what we
 * expect (nothing is changed then).
 */
export function installJoinFix(player: unknown): boolean {
  const engine = (player as { _player_engine?: EngineLike } | null)?._player_engine;
  if (!engine || typeof engine.load !== 'function') return false;
  if (engine.__joinFix) return true;
  engine.__joinFix = true;

  // The engine creates its transmuxer in load(), possibly deferred until the
  // MediaSource opens (it then calls this.load() itself), so hook every load.
  const load = engine.load;
  engine.load = function (this: EngineLike) {
    load.call(this);
    if (this._transmuxer && !hookController(this._transmuxer._controller)) {
      console.warn('[MPEGTS] join fix unavailable for this mpegts.js version');
    }
  };
  return true;
}
