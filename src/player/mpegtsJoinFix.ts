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
