import React from 'react';
import { longGuideDate, programmeDuration } from '../../epg/model';
import type { EpgProgramme, EpgSchedule } from '../../epg/types';
import type { Channel } from '../../types/player';
import { fmtTime } from '../../utils';

type Props = {
  channel?: Channel;
  schedule?: EpgSchedule;
  programme?: EpgProgramme;
  onWatch: () => void;
};

export function EpgGuideDetails({ channel, schedule, programme, onWatch }: Props) {
  const title = programme?.title || (
    channel ? (schedule ? 'No programme information' : 'Loading guide…') : 'No channel selected'
  );

  return (
    <footer className="guideDetails">
      <div className="guideDetailsMain">
        <div className="guideDetailMeta">
          <span>{channel?.name || 'Select a channel'}</span>
          {schedule?.source && schedule.source !== 'none' && (
            <span className={`guideSource ${schedule.source}`}>
              {schedule.source === 'external' ? 'Open EPG' : 'Provider'}{schedule.stale ? ' · stale' : ''}
            </span>
          )}
          {programme?.category && <span>{programme.category}</span>}
        </div>
        <strong className="guideDetailTitle">{title}</strong>
        <div className="guideDescription">
          {programme?.description || 'Programme details are not supplied for this listing.'}
        </div>
      </div>

      <div className="guideDetailsTime">
        {programme && (
          <>
            <strong>{longGuideDate(programme.start)}</strong>
            <span>{fmtTime(programme.start)} – {fmtTime(programme.end)} · {programmeDuration(programme)}</span>
          </>
        )}
        {channel && <button type="button" tabIndex={-1} onClick={onWatch}>OK · Watch channel</button>}
      </div>

      <div className="guideRemoteHelp">
        <span><kbd>↑</kbd><kbd>↓</kbd> channels</span>
        <span><kbd>←</kbd><kbd>→</kbd> programmes</span>
        <span><kbd>CH±</kbd> page</span>
        <span><kbd>Yellow</kbd> now</span>
        <span><kbd>Blue</kbd> refresh</span>
        <span><kbd>Back</kbd> close</span>
      </div>
    </footer>
  );
}
