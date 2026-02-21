import React from 'react';
import { Channel } from '../types/player';

export type GuideProgram = {
  title: string;
  start: number;
  end: number;
};

export type GuideRow = {
  streamId: string;
  name: string;
  programs: GuideProgram[];
};

type Props = {
  open: boolean;
  channels: Channel[];
  selectedChannelIndex: number;
  fetchShortEpg: (streamId: string | number, limit?: number) => Promise<any>;
  onPlayChannel: (streamId: string) => void;
  onClose: () => void;
};

const SLOT_WIDTH = 210;
const SLOT_SECONDS = 1800;
const SLOT_COUNT = 8;

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function parseTs(value: any) {
  const s = value == null ? '' : String(value).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function decodePossiblyBase64Utf8(value: any) {
  const raw = value == null ? '' : String(value);
  if (!raw) return '';

  const looksBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.replace(/\s+/g, '').length % 4 === 0;
  if (looksBase64) {
    try {
      const bin = atob(raw.replace(/\s+/g, ''));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      // noop
    }
  }

  if (raw.includes('Ã') || raw.includes('Â')) {
    try {
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0) & 0xff);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      // noop
    }
  }

  return raw;
}

function fmtSlot(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function EpgGuideOverlay({ open, channels, selectedChannelIndex, fetchShortEpg, onPlayChannel, onClose }: Props) {
  const requestRef = React.useRef(0);
  const [loading, setLoading] = React.useState(false);
  const [rows, setRows] = React.useState<GuideRow[]>([]);
  const [selectedRow, setSelectedRow] = React.useState(0);
  const [selectedSlot, setSelectedSlot] = React.useState(1);
  const [startTs, setStartTs] = React.useState(0);

  const slots = React.useMemo(() => {
    const base = startTs || (Math.floor(Date.now() / SLOT_SECONDS) * SLOT_SECONDS);
    return Array.from({ length: SLOT_COUNT }, (_, i) => base + (i * SLOT_SECONDS));
  }, [startTs]);

  React.useEffect(() => {
    if (!open) return;
    const base = Math.floor(Date.now() / SLOT_SECONDS) * SLOT_SECONDS;
    setStartTs(base);
    setSelectedSlot(1);
    setSelectedRow(clamp(selectedChannelIndex, 0, Math.max(0, channels.length - 1)));
  }, [channels.length, open, selectedChannelIndex]);

  const loadRows = React.useCallback(async () => {
    if (!open) return;
    if (!channels.length) {
      setRows([]);
      setLoading(false);
      return;
    }

    const reqId = requestRef.current + 1;
    requestRef.current = reqId;
    setLoading(true);

    const from = clamp(selectedChannelIndex - 10, 0, Math.max(0, channels.length - 1));
    const to = clamp(from + 40, 0, channels.length);
    const scoped = channels.slice(from, to);

    const nextRows = await Promise.all(scoped.map(async (ch) => {
      try {
        const data: any = await fetchShortEpg(ch.stream_id, 12);
        const list: any[] = data?.epg_listings || data?.Epg_listings || data?.listings || [];
        const programs = list
          .map((e: any) => ({
            title: decodePossiblyBase64Utf8(e.title ?? e.name ?? e.programme_title ?? ''),
            start: parseTs(e.start_timestamp ?? e.start ?? e.start_ts ?? e.begin ?? e.from),
            end: parseTs(e.stop_timestamp ?? e.end_timestamp ?? e.end ?? e.stop ?? e.to),
          }))
          .filter((e: any) => e.start > 0 && e.end > e.start)
          .sort((a: any, b: any) => a.start - b.start);

        return {
          streamId: String(ch.stream_id),
          name: ch.name || 'Channel',
          programs,
        };
      } catch {
        return {
          streamId: String(ch.stream_id),
          name: ch.name || 'Channel',
          programs: [],
        };
      }
    }));

    if (reqId !== requestRef.current) return;
    setRows(nextRows);
    setLoading(false);
    setSelectedRow(clamp(selectedChannelIndex - from, 0, Math.max(0, nextRows.length - 1)));
  }, [channels, fetchShortEpg, open, selectedChannelIndex, slots]);

  React.useEffect(() => {
    if (!open) return;
    void loadRows();
  }, [loadRows, open]);

  React.useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      const k = String(e.key || '').toLowerCase();

      if (e.key === 'Escape' || e.key === 'Backspace' || k === 'g' || k === 'guide' || k === 'epg') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedRow((v) => clamp(v - 1, 0, Math.max(0, rows.length - 1)));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedRow((v) => clamp(v + 1, 0, Math.max(0, rows.length - 1)));
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (selectedSlot <= 0) setStartTs((v) => v - SLOT_SECONDS);
        else setSelectedSlot((v) => clamp(v - 1, 0, SLOT_COUNT - 1));
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (selectedSlot >= SLOT_COUNT - 1) setStartTs((v) => v + SLOT_SECONDS);
        else setSelectedSlot((v) => clamp(v + 1, 0, SLOT_COUNT - 1));
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && rows[selectedRow]) {
        e.preventDefault();
        onPlayChannel(rows[selectedRow].streamId);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPlayChannel, open, rows, selectedRow, selectedSlot]);

  const start = slots[0] || 0;
  const end = slots[slots.length - 1] || start;
  const total = Math.max(1, end - start);

  return (
    <div id="epgGuide" className={open ? 'show' : ''}>
      <div className="epgGuideHead">
        <div className="epgGuideTitle">EPG Guide</div>
        <div className="epgGuideHint">↑/↓ channels · ←/→ time · OK play · Back close</div>
        <button className="epgClose" onClick={onClose}>Close</button>
      </div>
      <div className="epgTimeline">
        <div className="epgChanHead">Channel</div>
        <div className="epgSlots">
          {slots.map((ts, i) => (
            <div className={`epgSlot ${i === selectedSlot ? 'sel' : ''}`} key={ts}>{fmtSlot(ts)}</div>
          ))}
        </div>
      </div>
      <div className="epgRows">
        {rows.map((row, rowIdx) => (
          <div className={`epgRow ${rowIdx === selectedRow ? 'sel' : ''}`} key={row.streamId}>
            <div className="epgChanName">{row.name}</div>
            <div className="epgCells">
              {row.programs.length ? row.programs.map((p, idx) => {
                if (p.end < start || p.start > end + SLOT_SECONDS) return null;
                const clippedStart = Math.max(p.start, start);
                const clippedEnd = Math.min(p.end, end + SLOT_SECONDS);
                const left = ((clippedStart - start) / total) * (slots.length * SLOT_WIDTH);
                const width = Math.max(80, ((clippedEnd - clippedStart) / total) * (slots.length * SLOT_WIDTH));
                return (
                  <div
                    key={`${row.streamId}-${idx}-${p.start}`}
                    className="epgProg"
                    style={{ left: `${left}px`, width: `${width}px` }}
                    title={`${p.title} (${fmtSlot(p.start)}-${fmtSlot(p.end)})`}
                  >
                    <div className="epgProgTitle">{p.title || 'No title'}</div>
                    <div className="epgProgTime">{fmtSlot(p.start)} - {fmtSlot(p.end)}</div>
                  </div>
                );
              }) : <div className="epgNoData">No EPG data</div>}
            </div>
          </div>
        ))}
        {loading && <div className="epgLoading">Loading guide…</div>}
      </div>
    </div>
  );
}
