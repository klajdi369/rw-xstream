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

import { JoinFixer, VideoTrack } from './joinFixer';
import { VideoGate, GateSample } from './videoGate';
import { checkAdtsPayload, AdtsRun } from './adtsSanitizer';
import { AacValidator, adtsConfig } from './aacValidator';

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

export interface JoinFixOptions {
  /** Check video frames with WebCodecs and skip damaged ones (videoGate.ts). */
  checkVideo?: boolean;
}

/** The video track and its samples as the demuxer hands them on. */
type DemuxerVideo = { video_track_?: VideoTrack };

function hookController(controller: ControllerLike | undefined, options: JoinFixOptions): boolean {
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
    // The demuxer consumes the first SPS/PPS before it produces any
    // samples, so they're only in its metadata.
    const paramSets = () => {
      const meta = demuxer.video_metadata_;
      return [meta?.sps?.data?.subarray(4), meta?.pps?.data?.subarray(4)];
    };

    if (options.checkVideo && VideoGate.available()) {
      hookGate(demuxer, forward, paramSets);
      return;
    }

    const fixer = new JoinFixer();
    demuxer.onDataAvailable = (audio, video) => {
      if (video?.samples?.length) {
        try {
          paramSets().forEach((n) => fixer.learn(n));
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
 * Route video through the VideoGate: new samples are taken out of the track
 * and come back (to the same track, then on to the remuxer) once checked —
 * synchronously when nothing needs waiting, otherwise a little later.
 */
function hookGate(demuxer: DemuxerLike & DemuxerVideo, forward: DataCallback, paramSets: () => (Uint8Array | undefined)[]) {
  const handedOn = new WeakSet<object>();
  let inCallback = false;
  let dead = false;
  let videoStarted = false;

  const gate = new VideoGate((samples: GateSample[]) => {
    const track = demuxer.video_track_;
    if (dead || !track) return;
    for (const s of samples) {
      handedOn.add(s);
      track.samples.push(s);
      track.length += s.length;
    }
    videoStarted = true;
    if (!inCallback) {
      try { forward(null, track); } catch (e) { console.warn('[MPEGTS] video hand-on failed', e); }
    }
  });

  const destroy = demuxer.destroy;
  if (typeof destroy === 'function') {
    demuxer.destroy = function (this: DemuxerLike) {
      dead = true;
      gate.close();
      destroy.call(this);
    };
  }

  demuxer.onDataAvailable = (audio, video) => {
    if (video?.samples?.length) {
      const fresh = video.samples.filter((s) => !handedOn.has(s));
      if (fresh.length) {
        video.samples = video.samples.filter((s) => handedOn.has(s));
        video.length = video.samples.reduce((n, s) => n + s.length, 0);
        inCallback = true;
        try {
          paramSets().forEach((n) => gate.learn(n));
          gate.push(fresh as GateSample[]);
        } catch (e) {
          console.warn('[MPEGTS] video check failed', e);
        } finally {
          inCallback = false;
        }
      }
    }
    // mpegts.js fixes its timestamp base on the first segment it remuxes;
    // hold audio until there is video too, or video could start before it.
    if (!videoStarted) {
      if (video?.samples?.length) videoStarted = true;
      else return;
    }
    forward(audio, video);
  };
}

/**
 * Install the join fix on an mpegts.js player. Call after createPlayer() and
 * before load(). Returns false if the player's internals aren't what we
 * expect (nothing is changed then).
 */
export function installJoinFix(player: unknown, options: JoinFixOptions = {}): boolean {
  const engine = (player as { _player_engine?: EngineLike } | null)?._player_engine;
  if (!engine || typeof engine.load !== 'function') return false;
  if (engine.__joinFix) return true;
  engine.__joinFix = true;

  // The engine creates its transmuxer in load(), possibly deferred until the
  // MediaSource opens (it then calls this.load() itself), so hook every load.
  const load = engine.load;
  engine.load = function (this: EngineLike) {
    load.call(this);
    if (this._transmuxer && !hookController(this._transmuxer._controller, options)) {
      console.warn('[MPEGTS] join fix unavailable for this mpegts.js version');
    }
  };
  if (options.checkVideo && !VideoGate.available()) {
    console.warn('[MPEGTS] video check needs WebCodecs, which this browser lacks');
  }
  return true;
}
