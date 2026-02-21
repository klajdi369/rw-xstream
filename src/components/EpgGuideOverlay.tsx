import React from 'react';

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
  loading: boolean;
  rows: GuideRow[];
  slots: number[];
  selectedRow: number;
  selectedSlot: number;
  onClose: () => void;
};

const SLOT_WIDTH = 210;

function fmtSlot(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function EpgGuideOverlay({ open, loading, rows, slots, selectedRow, selectedSlot, onClose }: Props) {
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
                const left = ((p.start - start) / total) * (slots.length * SLOT_WIDTH);
                const width = Math.max(80, ((p.end - p.start) / total) * (slots.length * SLOT_WIDTH));
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
