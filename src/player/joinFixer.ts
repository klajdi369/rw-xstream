/*
 * The join repairs for one decoder session: drop the leading pictures of the
 * first keyframe and rewrite reference-marking commands that name pictures
 * the decoder never received (see mpegtsJoinFix.ts and h264JoinRepair.ts).
 */

import { H264JoinRepair } from './h264JoinRepair';

export interface NalUnit { type: number; data: Uint8Array } // data: 4-byte length + NAL
export interface VideoSample {
  units: NalUnit[];
  length: number;
  isKeyframe: boolean;
  pts: number;
}
export interface VideoTrack { samples: VideoSample[]; length: number }

/** Drops the leading pictures of the first keyframe. */
export class LeadingPictureFilter {
  /** pts of the keyframe we started on; null until it arrives. */
  private startPts: number | null = null;
  done = false;
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

    // Report once the first GOP is over and the count is final.
    if (!this.announced && this.leading.done) {
      this.announced = true;
      if (this.leading.dropped) {
        console.info(`[MPEGTS] dropped ${this.leading.dropped} undecodable picture(s) at stream start`);
      }
    }
    if (!changed) return;
    const dropped = new Set(fresh.filter((s) => !keep.has(s)));
    track.samples = track.samples.filter((s) => !dropped.has(s));
    track.length = track.samples.reduce((n, s) => n + s.length, 0);
  }
}

