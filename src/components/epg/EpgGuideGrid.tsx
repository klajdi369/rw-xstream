import React from 'react';
import {
  HALF_HOUR_SECONDS,
  HOUR_SECONDS,
  channelKey,
  programmePosition,
  programmesInWindow,
} from '../../epg/model';
import type { EpgProgramme, EpgSchedule } from '../../epg/types';
import { useVirtualWindow } from '../../hooks/useVirtualWindow';
import type { Channel } from '../../types/player';
import { cx, fmtTime } from '../../utils';

const GUIDE_ROW_HEIGHT = 76;
const GUIDE_ROW_OVERSCAN = 3;

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

type RowProps = {
  channel: Channel;
  channelIndex: number;
  schedule?: EpgSchedule;
  playing: boolean;
  selectedChannel: boolean;
  selectedProgrammeStart: number | null;
  windowStart: number;
  windowEnd: number;
  now: number;
  nowPosition: number;
  showNowLine: boolean;
  onSelectChannel: (index: number) => void;
  onSelectProgramme: (channelIndex: number, programme: EpgProgramme) => void;
  onWatch: (channel: Channel) => void;
};

const EpgGuideRow = React.memo(function EpgGuideRow({
  channel,
  channelIndex,
  schedule,
  playing,
  selectedChannel,
  selectedProgrammeStart,
  windowStart,
  windowEnd,
  now,
  nowPosition,
  showNowLine,
  onSelectChannel,
  onSelectProgramme,
  onWatch,
}: RowProps) {
  const programmes = React.useMemo(
    () => programmesInWindow(schedule, windowStart, windowEnd),
    [schedule, windowEnd, windowStart],
  );

  return (
    <div
      id={`guide-channel-${channelIndex}`}
      className={cx(
        'guideRow',
        channelIndex % 2 === 1 && 'even',
        selectedChannel && 'selectedChannel',
      )}
      onClick={() => onSelectChannel(channelIndex)}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx('guideChannel', playing && 'playing')}
        onClick={(event) => {
          event.stopPropagation();
          onSelectChannel(channelIndex);
        }}
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
          const selected = selectedChannel && selectedProgrammeStart === programme.start;
          const startTime = fmtTime(programme.start);
          const endTime = fmtTime(programme.end);

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
              title={`${startTime} – ${endTime}  ${programme.title}`}
            >
              <strong>{programme.title}</strong>
              <span>{startTime} – {endTime}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

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
  const handlersRef = React.useRef({ onSelectChannel, onSelectProgramme, onWatch });
  React.useLayoutEffect(() => {
    handlersRef.current = { onSelectChannel, onSelectProgramme, onWatch };
  }, [onSelectChannel, onSelectProgramme, onWatch]);

  const selectChannel = React.useCallback((index: number) => {
    handlersRef.current.onSelectChannel(index);
  }, []);
  const selectProgramme = React.useCallback((channelIndex: number, programme: EpgProgramme) => {
    handlersRef.current.onSelectProgramme(channelIndex, programme);
  }, []);
  const watch = React.useCallback((channel: Channel) => {
    handlersRef.current.onWatch(channel);
  }, []);

  const {
    containerRef,
    firstIndex,
    lastIndex,
    beforeHeight,
    afterHeight,
    onScroll,
  } = useVirtualWindow({
    itemCount: channels.length,
    selectedIndex: selectedChannelIndex,
    itemHeight: GUIDE_ROW_HEIGHT,
    overscan: GUIDE_ROW_OVERSCAN,
  });
  const timeSlots = React.useMemo(() => Array.from(
    { length: (windowEnd - windowStart) / HALF_HOUR_SECONDS },
    (_, index) => windowStart + index * HALF_HOUR_SECONDS,
  ), [windowEnd, windowStart]);
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

      <div className="guideRows" ref={containerRef} onScroll={onScroll}>
        <div className="guideRowsSpacer" aria-hidden="true" style={{ height: `${beforeHeight}px` }} />
        {channels.slice(firstIndex, lastIndex + 1).map((channel, offset) => {
          const channelIndex = firstIndex + offset;
          const key = channelKey(channel);
          const selectedChannel = channelIndex === selectedChannelIndex;

          return (
            <EpgGuideRow
              key={key}
              channel={channel}
              channelIndex={channelIndex}
              schedule={schedules.get(key)}
              playing={key === playingId}
              selectedChannel={selectedChannel}
              selectedProgrammeStart={selectedChannel ? selectedProgramme?.start ?? null : null}
              windowStart={windowStart}
              windowEnd={windowEnd}
              now={now}
              nowPosition={nowPosition}
              showNowLine={showNowLine}
              onSelectChannel={selectChannel}
              onSelectProgramme={selectProgramme}
              onWatch={watch}
            />
          );
        })}
        <div className="guideRowsSpacer" aria-hidden="true" style={{ height: `${afterHeight}px` }} />
      </div>
    </div>
  );
}
