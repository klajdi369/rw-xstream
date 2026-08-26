import React from 'react';
import {
  HALF_HOUR_SECONDS,
  HOUR_SECONDS,
  channelKey,
  programmePosition,
  programmesInWindow,
} from '../../epg/model';
import type { EpgProgramme, EpgSchedule } from '../../epg/types';
import type { Channel } from '../../types/player';
import { cx, fmtTime } from '../../utils';

type Props = {
  channels: Channel[];
  schedules: Map<string, EpgSchedule>;
  playingId: string | null;
  selectedChannelIndex: number;
  selectedProgramme?: EpgProgramme;
  windowStart: number;
  windowEnd: number;
  now: number;
  onSelectChannel: (index: number) => void;
  onSelectProgramme: (channelIndex: number, programme: EpgProgramme) => void;
  onWatch: (channel: Channel) => void;
};

export function EpgGuideGrid({
  channels,
  schedules,
  playingId,
  selectedChannelIndex,
  selectedProgramme,
  windowStart,
  windowEnd,
  now,
  onSelectChannel,
  onSelectProgramme,
  onWatch,
}: Props) {
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());

  React.useEffect(() => {
    const channel = channels[selectedChannelIndex];
    if (channel) rowRefs.current.get(channelKey(channel))?.scrollIntoView({ block: 'nearest' });
  }, [channels, selectedChannelIndex]);

  const timeSlots = Array.from(
    { length: (windowEnd - windowStart) / HALF_HOUR_SECONDS },
    (_, index) => windowStart + index * HALF_HOUR_SECONDS,
  );
  const nowPosition = ((now - windowStart) / (windowEnd - windowStart)) * 100;
  const showNowLine = now >= windowStart && now <= windowEnd;

  return (
    <div className="guideTable">
      <div className="guideTimelineHeader">
        <div className="guideChannelHeading">Channel</div>
        <div className="guideTimes">
          {timeSlots.map((time) => (
            <div key={time} className={time % HOUR_SECONDS === 0 ? 'hour' : ''}>
              <span>{fmtTime(time)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="guideRows">
        {channels.map((channel, channelIndex) => {
          const key = channelKey(channel);
          const schedule = schedules.get(key);
          const programmes = programmesInWindow(schedule, windowStart, windowEnd);
          const selectedChannel = channelIndex === selectedChannelIndex;
          const playing = key === playingId;

          return (
            <div
              key={key}
              id={`guide-channel-${channelIndex}`}
              ref={(node) => {
                if (node) rowRefs.current.set(key, node);
                else rowRefs.current.delete(key);
              }}
              className={cx('guideRow', selectedChannel && 'selectedChannel')}
              onClick={() => onSelectChannel(channelIndex)}
            >
              <button
                type="button"
                tabIndex={-1}
                className={cx('guideChannel', playing && 'playing')}
                onClick={() => onSelectChannel(channelIndex)}
                onDoubleClick={() => onWatch(channel)}
              >
                <span className="guideChannelNumber">{channelIndex + 1}</span>
                <span className="guideChannelMark">{String(channel.name || '?').trim().charAt(0).toUpperCase()}</span>
                <span className="guideChannelName">{channel.name || 'Channel'}</span>
                {playing && <span className="guidePlayingDot" title="Playing" />}
              </button>

              <div className="guideTrack">
                {showNowLine && <div className="guideNowLine" style={{ left: `${nowPosition}%` }}><span /></div>}
                {!schedule && <div className="guideRowState loading"><span />Loading guide…</div>}
                {schedule && programmes.length === 0 && (
                  <div className={cx('guideRowState', schedule.error && 'error')}>
                    {schedule.error ? 'Guide unavailable' : 'No listings at this time'}
                  </div>
                )}
                {programmes.map((programme) => {
                  const position = programmePosition(programme, windowStart, windowEnd);
                  const live = programme.start <= now && programme.end > now;
                  const past = programme.end <= now;
                  const selected = selectedChannel && selectedProgramme?.start === programme.start;

                  return (
                    <button
                      type="button"
                      tabIndex={-1}
                      id={`guide-programme-${channelIndex}-${programme.start}`}
                      key={`${programme.start}:${programme.title}`}
                      className={cx('guideProgramme', live && 'live', past && 'past', selected && 'selected')}
                      style={{ left: `${position.left}%`, width: `max(${position.width}%, 3px)` }}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectProgramme(channelIndex, programme);
                      }}
                      onDoubleClick={() => onWatch(channel)}
                      title={`${fmtTime(programme.start)} – ${fmtTime(programme.end)}  ${programme.title}`}
                    >
                      <strong>{programme.title}</strong>
                      <span>{fmtTime(programme.start)} – {fmtTime(programme.end)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
