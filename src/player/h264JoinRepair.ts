/*
 * Make an H.264 stream decodable by Chrome when we join it mid-GOP.
 *
 * Broadcast H.264 (1080i/576i re-streamed from satellite/cable) often has no
 * IDR frames at all — only I-pictures — and uses explicit memory management
 * (MMCO) commands in every reference picture to evict old reference
 * pictures from the decoder's buffer. When we tune in, the pictures those
 * commands name were sent before we joined, so the first second or so of
 * commands point at pictures the decoder never had.
 *
 * ffmpeg normally logs "mmco: unref short failure" and carries on, but Chrome
 * runs it with AV_EF_EXPLODE (media/ffmpeg/ffmpeg_common.cc), which turns that
 * into a hard error: PIPELINE_ERROR_DECODE "Failed to send video packet for
 * decoding" a few frames in — one frame on screen, then nothing.
 *
 * The repair: model ffmpeg's short-term reference list from the join point
 * (including the placeholder frames ffmpeg invents for the missing history)
 * and, in each slice header, point MMCO "unmark" commands whose target isn't
 * there at a placeholder instead — the encoder used them to free a slot, so
 * a slot still gets freed and the list never overflows (also fatal). Nothing
 * but dec_ref_pic_marking() changes. Once the placeholders are gone and the
 * second keyframe has passed, every command names a real picture and the
 * repair switches itself off. Anything it doesn't understand (long-term
 * references, slice groups, MVC) switches it off too, leaving the stream
 * as it was.
 *
 * Verified against real 1080i/576i channels with `ffmpeg -err_detect explode`
 * (what Chrome runs) and in Chromium: unrepaired they fail on the first
 * pictures after the join; repaired they decode without errors.
 */

/* ---- Bit-level helpers -------------------------------------------------- */

/** NAL payload without emulation-prevention bytes (00 00 03 → 00 00). */
function toRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    zeros = b === 0 ? zeros + 1 : 0;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/** Re-insert emulation-prevention bytes. */
function toEbsp(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

class BitReader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  bit(): number {
    const byte = this.pos >> 3;
    if (byte >= this.buf.length) throw new RangeError('read past end');
    const v = (this.buf[byte] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 31) throw new RangeError('bad exp-golomb');
    }
    return (2 ** zeros - 1) + this.bits(zeros);
  }

  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private n = 0;

  bit(b: number) {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
  }

  bits(count: number, v: number) {
    for (let i = count - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1);
  }

  ue(v: number) {
    const x = v + 1;
    const len = Math.floor(Math.log2(x));
    this.bits(len, 0);
    this.bits(len + 1, x);
  }

  /** Copy bits [from, to) of `src`. */
  copy(src: Uint8Array, from: number, to: number) {
    for (let p = from; p < to; p++) this.bit((src[p >> 3] >> (7 - (p & 7))) & 1);
  }

  get aligned() { return this.n === 0; }

  bytesOut(): Uint8Array { return Uint8Array.from(this.bytes); }

  pushBytes(src: Uint8Array) {
    if (this.n !== 0) throw new Error('not byte aligned');
    for (const b of src) this.bytes.push(b);
  }
}

/* ---- Parameter sets ----------------------------------------------------- */

interface Sps {
  chromaArrayType: number;
  separateColourPlane: boolean;
  log2MaxFrameNum: number;
  pocType: number;
  log2MaxPocLsb: number;
  deltaPicOrderAlwaysZero: boolean;
  maxNumRefFrames: number;
  frameMbsOnly: boolean;
}

interface Pps {
  spsId: number;
  cabac: boolean;
  bottomFieldPicOrderPresent: boolean;
  sliceGroups: number;
  numRefIdxL0Default: number;
  numRefIdxL1Default: number;
  weightedPred: boolean;
  weightedBipredIdc: number;
  deblockingFilterControlPresent: boolean;
  redundantPicCntPresent: boolean;
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function parseSps(rbsp: Uint8Array): { id: number; sps: Sps } {
  const r = new BitReader(rbsp);
  r.bits(8); // NAL header
  const profileIdc = r.bits(8);
  r.bits(16); // constraint flags + level_idc
  const id = r.ue();
  let chromaFormatIdc = 1;
  let separateColourPlane = false;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.bit() === 1;
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) { // seq_scaling_matrix_present_flag
      const lists = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) {
        if (!r.bit()) continue;
        const size = i < 6 ? 16 : 64;
        let last = 8;
        let next = 8;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          if (next !== 0) last = next;
        }
      }
    }
  }
  const log2MaxFrameNum = r.ue() + 4;
  const pocType = r.ue();
  let log2MaxPocLsb = 0;
  let deltaPicOrderAlwaysZero = false;
  if (pocType === 0) {
    log2MaxPocLsb = r.ue() + 4;
  } else if (pocType === 1) {
    deltaPicOrderAlwaysZero = r.bit() === 1;
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  const maxNumRefFrames = r.ue();
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  r.ue(); // pic_width_in_mbs_minus1
  r.ue(); // pic_height_in_map_units_minus1
  const frameMbsOnly = r.bit() === 1;
  return {
    id,
    sps: {
      chromaArrayType: separateColourPlane ? 0 : chromaFormatIdc,
      separateColourPlane,
      log2MaxFrameNum,
      pocType,
      log2MaxPocLsb,
      deltaPicOrderAlwaysZero,
      maxNumRefFrames,
      frameMbsOnly,
    },
  };
}

function parsePps(rbsp: Uint8Array): { id: number; pps: Pps } {
  const r = new BitReader(rbsp);
  r.bits(8); // NAL header
  const id = r.ue();
  const spsId = r.ue();
  const cabac = r.bit() === 1;
  const bottomFieldPicOrderPresent = r.bit() === 1;
  const sliceGroups = r.ue() + 1;
  if (sliceGroups > 1) {
    // FMO (Baseline only) — we don't parse slice group maps; the caller bails.
    return {
      id,
      pps: {
        spsId, cabac, bottomFieldPicOrderPresent, sliceGroups,
        numRefIdxL0Default: 0, numRefIdxL1Default: 0, weightedPred: false,
        weightedBipredIdc: 0, deblockingFilterControlPresent: false, redundantPicCntPresent: false,
      },
    };
  }
  const numRefIdxL0Default = r.ue() + 1;
  const numRefIdxL1Default = r.ue() + 1;
  const weightedPred = r.bit() === 1;
  const weightedBipredIdc = r.bits(2);
  r.se(); // pic_init_qp_minus26
  r.se(); // pic_init_qs_minus26
  r.se(); // chroma_qp_index_offset
  const deblockingFilterControlPresent = r.bit() === 1;
  r.bit(); // constrained_intra_pred_flag
  const redundantPicCntPresent = r.bit() === 1;
  return {
    id,
    pps: {
      spsId, cabac, bottomFieldPicOrderPresent, sliceGroups, numRefIdxL0Default,
      numRefIdxL1Default, weightedPred, weightedBipredIdc, deblockingFilterControlPresent,
      redundantPicCntPresent,
    },
  };
}

/* ---- Slice header ------------------------------------------------------- */

interface Mmco { op: number; diff?: number; longTermPicNum?: number; longTermFrameIdx?: number; maxLongTermFrameIdxPlus1?: number }

interface SliceHeader {
  firstMb: number;
  frameNum: number;
  field: boolean;
  bottom: boolean;
  idr: boolean;
  refIdc: number;
  /** Bit range of dec_ref_pic_marking() in the RBSP (non-IDR reference pictures). */
  markStart: number;
  markEnd: number;
  adaptive: boolean;
  mmcos: Mmco[];
  /** Bit position where slice_data() begins (before CABAC alignment). */
  headerEnd: number;
  cabac: boolean;
  sps: Sps;
}

const SLICE_P = 0, SLICE_B = 1, SLICE_I = 2, SLICE_SP = 3, SLICE_SI = 4;

function skipRefPicListModification(r: BitReader) {
  if (!r.bit()) return; // ref_pic_list_modification_flag
  for (;;) {
    const idc = r.ue();
    if (idc === 3) return;
    if (idc > 5) throw new Error('bad modification_of_pic_nums_idc');
    r.ue(); // abs_diff_pic_num_minus1 / long_term_pic_num / abs_diff_view_idx_minus1
  }
}

function skipPredWeightTable(r: BitReader, chromaArrayType: number, l0: number, l1: number, isB: boolean) {
  r.ue(); // luma_log2_weight_denom
  if (chromaArrayType !== 0) r.ue(); // chroma_log2_weight_denom
  for (const count of isB ? [l0, l1] : [l0]) {
    for (let i = 0; i < count; i++) {
      if (r.bit()) { r.se(); r.se(); } // luma weight/offset
      if (chromaArrayType !== 0 && r.bit()) { r.se(); r.se(); r.se(); r.se(); }
    }
  }
}

function parseSliceHeader(rbsp: Uint8Array, spsMap: Map<number, Sps>, ppsMap: Map<number, Pps>): SliceHeader | null {
  const r = new BitReader(rbsp);
  r.bit(); // forbidden_zero_bit
  const refIdc = r.bits(2);
  const nalType = r.bits(5);
  const idr = nalType === 5;
  const firstMb = r.ue();
  const sliceType = r.ue() % 5;
  const pps = ppsMap.get(r.ue());
  if (!pps || pps.sliceGroups > 1) return null;
  const sps = spsMap.get(pps.spsId);
  if (!sps) return null;
  if (sps.separateColourPlane) r.bits(2);
  const frameNum = r.bits(sps.log2MaxFrameNum);
  let field = false;
  let bottom = false;
  if (!sps.frameMbsOnly) {
    field = r.bit() === 1;
    if (field) bottom = r.bit() === 1;
  }
  if (idr) r.ue(); // idr_pic_id
  if (sps.pocType === 0) {
    r.bits(sps.log2MaxPocLsb);
    if (pps.bottomFieldPicOrderPresent && !field) r.se();
  }
  if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) {
    r.se();
    if (pps.bottomFieldPicOrderPresent && !field) r.se();
  }
  if (pps.redundantPicCntPresent) r.ue();
  const isB = sliceType === SLICE_B;
  if (isB) r.bit(); // direct_spatial_mv_pred_flag
  let l0 = pps.numRefIdxL0Default;
  let l1 = pps.numRefIdxL1Default;
  if (sliceType === SLICE_P || sliceType === SLICE_SP || isB) {
    if (r.bit()) { // num_ref_idx_active_override_flag
      l0 = r.ue() + 1;
      if (isB) l1 = r.ue() + 1;
    }
  }
  if (nalType === 20 || nalType === 21) return null; // MVC
  if (sliceType !== SLICE_I && sliceType !== SLICE_SI) {
    skipRefPicListModification(r);
    if (isB) skipRefPicListModification(r);
  }
  if ((pps.weightedPred && (sliceType === SLICE_P || sliceType === SLICE_SP))
    || (pps.weightedBipredIdc === 1 && isB)) {
    skipPredWeightTable(r, sps.chromaArrayType, l0, l1, isB);
  }
  let markStart = -1;
  let markEnd = -1;
  let adaptive = false;
  const mmcos: Mmco[] = [];
  if (refIdc !== 0) {
    if (idr) {
      r.bit(); // no_output_of_prior_pics_flag
      r.bit(); // long_term_reference_flag
    } else {
      markStart = r.pos;
      adaptive = r.bit() === 1;
      if (adaptive) {
        for (;;) {
          const op = r.ue();
          if (op === 0) break;
          if (op > 6) throw new Error('bad mmco');
          const m: Mmco = { op };
          if (op === 1 || op === 3) m.diff = r.ue();
          if (op === 2) m.longTermPicNum = r.ue();
          if (op === 3 || op === 6) m.longTermFrameIdx = r.ue();
          if (op === 4) m.maxLongTermFrameIdxPlus1 = r.ue();
          mmcos.push(m);
        }
      }
      markEnd = r.pos;
    }
  }
  if (pps.cabac && sliceType !== SLICE_I && sliceType !== SLICE_SI) r.ue(); // cabac_init_idc
  r.se(); // slice_qp_delta
  if (sliceType === SLICE_SP || sliceType === SLICE_SI) {
    if (sliceType === SLICE_SP) r.bit(); // sp_for_switch_flag
    r.se(); // slice_qs_delta
  }
  if (pps.deblockingFilterControlPresent) {
    if (r.ue() !== 1) { r.se(); r.se(); }
  }
  return {
    firstMb, frameNum, field, bottom, idr, refIdc,
    markStart, markEnd, adaptive, mmcos, headerEnd: r.pos, cabac: pps.cabac, sps,
  };
}

/** Rebuild a slice NAL with a different dec_ref_pic_marking(). */
function rewriteMarking(rbsp: Uint8Array, h: SliceHeader, mmcos: Mmco[]): Uint8Array {
  const w = new BitWriter();
  w.copy(rbsp, 0, h.markStart);
  w.bit(1); // adaptive_ref_pic_marking_mode_flag
  for (const m of mmcos) {
    w.ue(m.op);
    if (m.op === 1 || m.op === 3) w.ue(m.diff!);
    if (m.op === 2) w.ue(m.longTermPicNum!);
    if (m.op === 3 || m.op === 6) w.ue(m.longTermFrameIdx!);
    if (m.op === 4) w.ue(m.maxLongTermFrameIdxPlus1!);
  }
  w.ue(0); // end of commands
  w.copy(rbsp, h.markEnd, h.headerEnd);

  if (h.cabac) {
    // slice_data() starts byte-aligned after cabac_alignment_one_bit.
    while (!w.aligned) w.bit(1);
    w.pushBytes(rbsp.subarray(Math.ceil(h.headerEnd / 8)));
    return w.bytesOut();
  }
  // CAVLC: shift the rest of the slice, then redo rbsp_trailing_bits.
  let last = rbsp.length * 8 - 1;
  while (last >= h.headerEnd && !((rbsp[last >> 3] >> (7 - (last & 7))) & 1)) last--;
  w.copy(rbsp, h.headerEnd, last); // everything before the stop bit
  w.bit(1);
  while (!w.aligned) w.bit(0);
  return w.bytesOut();
}

/* ---- Reference list model ----------------------------------------------- */

/*
 * A model of ffmpeg's short-term reference list (libavcodec/h264_refs.c,
 * h264_slice.c), which is what Chrome decodes with. It has to match ffmpeg,
 * not the spec: when decoding starts on a non-IDR picture ffmpeg invents
 * "gap" frames for the missing history, and those are what the stream's
 * commands then hit or miss.
 */

const TOP = 1;
const BOTTOM = 2;
const FRAME = 3;

interface RefEntry {
  frameNum: number;
  /** Which fields are still marked as reference (TOP | BOTTOM). */
  ref: number;
  /** Invented by ffmpeg for a frame_num gap (what we may evict freely). */
  gap: boolean;
}

export class H264JoinRepair {
  private readonly sps = new Map<number, Sps>();
  private readonly pps = new Map<number, Pps>();
  /** ffmpeg's h->short_ref: newest first. */
  private refs: RefEntry[] = [];
  private prevFrameNum = -1;
  /** ffmpeg's h->first_field: the last picture was a first field. */
  private firstField: { frameNum: number; structure: number } | null = null;
  /** Commands (dec_ref_pic_marking) decided for the current picture. */
  private marking: { adaptive: boolean; mmcos: Mmco[] } | null = null;
  private keyframesSeen = 0;
  private repaired = 0;
  private active = true;
  private failed = false;

  get isActive() { return this.active && !this.failed; }

  /** Feed a parameter set (SPS/PPS NAL, header byte included). */
  learn(nal: Uint8Array | null | undefined) {
    if (!nal || nal.length < 2) return;
    const type = nal[0] & 0x1f;
    try {
      if (type === 7) { const p = parseSps(toRbsp(nal)); this.sps.set(p.id, p.sps); }
      if (type === 8) { const p = parsePps(toRbsp(nal)); this.pps.set(p.id, p.pps); }
    } catch { /* ignore malformed parameter sets */ }
  }

  /**
   * Call at every keyframe sample. After the second one, once the invented
   * frames are gone, every command names a real picture and we stop.
   */
  keyframe() {
    this.keyframesSeen++;
    this.maybeFinish();
  }

  private maybeFinish() {
    if (!this.active || this.keyframesSeen < 2 || this.refs.some((e) => e.gap)) return;
    this.active = false;
    if (this.repaired) {
      console.info(`[MPEGTS] repaired ${this.repaired} reference-marking command(s) after joining the stream`);
    }
  }

  /**
   * Process one NAL unit (header byte included, emulation prevention intact).
   * Returns the NAL to use instead — the same array when nothing changed.
   */
  nal(nal: Uint8Array): Uint8Array {
    if (!this.isActive || nal.length < 2) return nal;
    const type = nal[0] & 0x1f;
    if (type === 7 || type === 8) { this.learn(nal); return nal; }
    if (type !== 1 && type !== 5) return nal;

    try {
      const rbsp = toRbsp(nal);
      const h = parseSliceHeader(rbsp, this.sps, this.pps);
      if (!h) throw new Error('slice references an unknown parameter set');
      if (h.firstMb === 0 || !this.marking) this.marking = this.picture(h);
      if (h.refIdc === 0 || h.idr) return nal;

      const want = this.marking;
      const same = want.adaptive === h.adaptive
        && want.mmcos.length === h.mmcos.length
        && want.mmcos.every((m, i) => m.op === h.mmcos[i].op && m.diff === h.mmcos[i].diff);
      if (same) return nal;
      return toEbsp(rewriteMarking(rbsp, h, want.mmcos));
    } catch (e) {
      // Anything we don't understand: stop touching the stream.
      this.failed = true;
      console.warn('[MPEGTS] reference-marking repair disabled', e);
      return nal;
    }
  }

  private find(frameNum: number) { return this.refs.find((e) => e.frameNum === frameNum); }

  private unmark(entry: RefEntry, structure: number) {
    entry.ref &= structure ^ FRAME;
    if (!entry.ref) this.refs = this.refs.filter((e) => e !== entry);
  }

  /** First slice of a picture: update the model, return its (repaired) marking. */
  private picture(h: SliceHeader): { adaptive: boolean; mmcos: Mmco[] } {
    const sps = h.sps;
    const maxFrameNum = 2 ** sps.log2MaxFrameNum;
    const refCount = sps.maxNumRefFrames;
    const structure = h.field ? (h.bottom ? BOTTOM : TOP) : FRAME;
    const zext = (v: number) => ((v % maxFrameNum) + maxFrameNum) % maxFrameNum;

    if (h.idr) {
      this.refs = [];
      this.prevFrameNum = h.frameNum;
      this.firstField = h.field ? { frameNum: h.frameNum, structure } : null;
      this.refs.unshift({ frameNum: h.frameNum, ref: structure, gap: false });
      return { adaptive: false, mmcos: [] };
    }

    // h264_field_start(): shorten long frame_num gaps…
    if (h.frameNum !== this.prevFrameNum) {
      let unwrapPrev = this.prevFrameNum;
      if (unwrapPrev > h.frameNum) unwrapPrev -= maxFrameNum;
      if (h.frameNum - unwrapPrev > refCount) {
        unwrapPrev = h.frameNum - refCount - 1;
        if (unwrapPrev < 0) unwrapPrev += maxFrameNum;
        this.prevFrameNum = unwrapPrev;
      }
    }
    // …then invent the missing frames (only when not expecting a second field).
    while (!this.firstField && h.frameNum !== this.prevFrameNum
      && h.frameNum !== (this.prevFrameNum + 1) % maxFrameNum) {
      if (this.refs.length && this.refs.length >= refCount) this.refs.pop(); // sliding window
      this.prevFrameNum = (this.prevFrameNum + 1) % maxFrameNum;
      this.addCurrent(this.prevFrameNum, structure, true, false);
      this.afterMarking(this.prevFrameNum, refCount, zext);
    }

    // Is this the second field of the previous picture?
    let second = false;
    if (this.firstField) {
      second = h.field && structure !== this.firstField.structure && this.firstField.frameNum === h.frameNum;
    }
    this.firstField = h.field && !second ? { frameNum: h.frameNum, structure } : null;

    let result = { adaptive: h.adaptive, mmcos: h.mmcos };
    if (h.refIdc !== 0) {
      if (!h.adaptive) {
        // Sliding window, skipped for the second field of a reference pair.
        const curHasRef = second && this.refs[0]?.frameNum === h.frameNum;
        if (this.refs.length && this.refs.length >= refCount && !(h.field && second && curHasRef)) {
          this.refs.pop();
        }
      } else {
        result = { adaptive: true, mmcos: this.repairCommands(h, structure, maxFrameNum) };
      }
      this.addCurrent(h.frameNum, structure, false, second);

      // ffmpeg errors out if the list is now too long; evict invented frames.
      while (this.refs.length > Math.max(refCount, 1)) {
        const victim = [...this.refs].reverse().find((e) => e.gap);
        if (!victim) throw new Error('reference list overflow with no invented frame to evict');
        this.refs = this.refs.filter((e) => e !== victim);
        result = {
          adaptive: true,
          mmcos: [...result.mmcos, ...this.unmarkCommands(victim, h, structure, maxFrameNum)],
        };
        this.repaired++;
      }
      this.afterMarking(h.frameNum, refCount, zext);
    }
    this.prevFrameNum = h.frameNum;
    return result;
  }

  /** Execute the picture's MMCOs on the model, redirecting the ones that would fail. */
  private repairCommands(h: SliceHeader, structure: number, maxFrameNum: number): Mmco[] {
    const maxPicNum = h.field ? 2 * maxFrameNum : maxFrameNum;
    const currPicNum = h.field ? 2 * h.frameNum + 1 : h.frameNum;
    const out: Mmco[] = [];
    for (const m of h.mmcos) {
      if (m.op !== 1) throw new Error(`unsupported mmco ${m.op}`);
      const picNum = (currPicNum - m.diff! - 1) & (maxPicNum - 1);
      const fn = h.field ? picNum >> 1 : picNum;
      const target = h.field ? ((picNum & 1) ? structure : structure ^ FRAME) : FRAME;
      const entry = this.find(fn);
      if (entry) {
        this.unmark(entry, target);
        out.push(m);
        continue;
      }
      // The named picture was sent before we joined. The encoder used this
      // command to free a slot, so free one of ffmpeg's invented frames.
      this.repaired++;
      const victim = [...this.refs].reverse().find((e) => e.gap);
      if (!victim) continue; // nothing to free: drop the command
      const cmds = this.unmarkCommands(victim, h, structure, maxFrameNum, target);
      out.push(cmds[0]);
      this.unmark(victim, h.field ? this.structureOf(cmds[0], h, structure, maxPicNum) : FRAME);
    }
    return out;
  }

  /** Field structure an MMCO1 command addresses (for field pictures). */
  private structureOf(m: Mmco, h: SliceHeader, structure: number, maxPicNum: number) {
    const picNum = (2 * h.frameNum + 1 - m.diff! - 1) & (maxPicNum - 1);
    return (picNum & 1) ? structure : structure ^ FRAME;
  }

  /** MMCO1 commands that unmark `victim` (preferring field `prefer`). */
  private unmarkCommands(victim: RefEntry, h: SliceHeader, structure: number, maxFrameNum: number, prefer?: number): Mmco[] {
    const maxPicNum = h.field ? 2 * maxFrameNum : maxFrameNum;
    const currPicNum = h.field ? 2 * h.frameNum + 1 : h.frameNum;
    const diffFor = (picNum: number) => ((currPicNum - picNum - 1) % maxPicNum + maxPicNum) % maxPicNum;
    if (!h.field) return [{ op: 1, diff: diffFor(victim.frameNum) }];
    const fields = [TOP, BOTTOM].filter((s) => victim.ref & s);
    if (prefer && fields.includes(prefer)) fields.sort((a) => (a === prefer ? -1 : 1));
    return fields.map((s) => ({ op: 1, diff: diffFor(2 * victim.frameNum + (s === structure ? 1 : 0)) }));
  }

  /** ffmpeg's "current_ref_assigned == 0" path: put the picture on the list. */
  private addCurrent(frameNum: number, structure: number, gap: boolean, second: boolean) {
    if (second && this.refs[0]?.frameNum === frameNum) {
      this.refs[0].ref |= structure;
      return;
    }
    this.refs = this.refs.filter((e) => e.frameNum !== frameNum);
    this.refs.unshift({ frameNum, ref: structure, gap });
  }

  /** Drop invented frames more than max_num_ref_frames behind (ffmpeg does). */
  private afterMarking(frameNum: number, refCount: number, zext: (v: number) => number) {
    this.refs = this.refs.filter((e) => !(e.gap && zext(frameNum - e.frameNum) > refCount));
  }
}

/* ---- Picture structure of a sample -------------------------------------- */

export interface PictureInfo { frameNum: number; field: boolean; bottom: boolean }

/** Reads frame_num / field parity from slice headers (for pairing fields). */
export class H264SliceInfo {
  private readonly sps = new Map<number, Sps>();
  private readonly pps = new Map<number, Pps>();

  learn(nal: Uint8Array | null | undefined) {
    if (!nal || nal.length < 2) return;
    const type = nal[0] & 0x1f;
    try {
      if (type === 7) { const p = parseSps(toRbsp(nal)); this.sps.set(p.id, p.sps); }
      if (type === 8) { const p = parsePps(toRbsp(nal)); this.pps.set(p.id, p.pps); }
    } catch { /* ignore */ }
  }

  /** Structure of the first slice among `nals`; null if unknown. */
  info(nals: Uint8Array[]): PictureInfo | null {
    for (const nal of nals) {
      if (nal.length < 2) continue;
      const type = nal[0] & 0x1f;
      if (type === 7 || type === 8) { this.learn(nal); continue; }
      if (type !== 1 && type !== 5) continue;
      try {
        const h = parseSliceHeader(toRbsp(nal.subarray(0, 512)), this.sps, this.pps);
        return h ? { frameNum: h.frameNum, field: h.field, bottom: h.bottom } : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}
