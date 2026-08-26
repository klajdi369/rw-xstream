import React from 'react';
import type { GuideLoadState } from '../../epg/types';
import { shortGuideDate } from '../../epg/model';
import { fmtTime } from '../../utils';

type Props = {
  categoryName: string;
  windowStart: number;
  windowEnd: number;
  loadState: GuideLoadState;
  channelsWithData: number;
  onPreviousDay: () => void;
  onNextDay: () => void;
  onNow: () => void;
  onRefresh: () => void;
  onClose: () => void;
};

export function EpgGuideHeader({
  categoryName,
  windowStart,
  windowEnd,
  loadState,
  channelsWithData,
  onPreviousDay,
  onNextDay,
  onNow,
  onRefresh,
  onClose,
}: Props) {
  const status = loadState.loading
    ? `Loading ${loadState.loaded}/${loadState.total}`
    : `${channelsWithData}/${loadState.total} channels ready`;

  return (
    <>
      <header className="guideHeader">
        <div className="guideIdentity">
          <div className="guideEyebrow">{categoryName || 'Live channels'}</div>
          <h1>TV Guide</h1>
          <div className="guideQuickHelp">
            <span><kbd>↑↓</kbd> channel</span>
            <span><kbd>←→</kbd> programme</span>
            <span><kbd>OK</kbd> watch</span>
            <span><kbd>Back</kbd> close</span>
          </div>
        </div>

        <div className="guideDateControls" aria-label="Guide date controls">
          <button type="button" onClick={onPreviousDay} aria-label="Previous day">&#x2039;</button>
          <button type="button" className="guideDateButton" onClick={onNow}>
            <span>{shortGuideDate(windowStart)}</span>
            <small>{fmtTime(windowStart)} – {fmtTime(windowEnd)}</small>
          </button>
          <button type="button" onClick={onNextDay} aria-label="Next day">&#x203a;</button>
          <button type="button" className="guideLiveButton" onClick={onNow}>
            <span /> Now
          </button>
        </div>

        <div className="guideActions">
          <div className="guideCoverage" role="status" aria-live="polite">{status}</div>
          <button type="button" onClick={onRefresh} disabled={loadState.loading} aria-label="Refresh guide">Refresh</button>
          <button type="button" className="guideClose" onClick={onClose} aria-label="Close guide">&#x2715;</button>
        </div>
      </header>

      <div className="guideLoadBar" aria-hidden="true">
        <div
          className={loadState.loading ? 'loading' : ''}
          style={{ width: `${loadState.total ? (loadState.loaded / loadState.total) * 100 : 0}%` }}
        />
      </div>
    </>
  );
}
