import React from 'react';
import { Channel } from '../types/player';
import { EpgProgramme, EpgSchedule } from '../hooks/useEpg';
import { clamp, fmtTime } from '../utils';

type Props = {
  open: boolean;
  channels: Channel[];
  playingId: string | null;
  initialChannelId?: string | null;
  categoryName: string;
  loadSchedule: (
    streamId: string | number,
    epgChannelId?: string | null,
    channelName?: string,
    force?: boolean,
  ) => Promise<EpgSchedule>;
  onTune: (channel: Channel) => void;
  onClose: () => void;
};

const HALF_HOUR = 30 * 60;
const HOUR = 60 * 60;
const VIEW_SECONDS = 4 * HOUR;
const LOAD_WORKERS = 6;
const GUIDE_REFRESH_MS = 10 * 60 * 1000;

function channelKey(channel: Channel) {
  return String(channel.stream_id);
}

function liveWindowStart() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / HALF_HOUR) * HALF_HOUR - HALF_HOUR;
}

function shiftLocalDay(timestamp: number, amount: number) {
  const date = new Date(timestamp * 1000);
  date.setDate(date.getDate() + amount);
  return Math.floor(date.getTime() / 1000);
}

function fullDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function longDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function durationLabel(programme: EpgProgramme) {
  const mins = Math.max(1, Math.round((programme.end - programme.start) / 60));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function programmeAt(schedule: EpgSchedule | undefined, target: number) {
  if (!schedule?.programmes.length) return undefined;
  return schedule.programmes.find((programme) => programme.start <= target && programme.end > target)
    || schedule.programmes.find((programme) => programme.start > target);
}

export function EpgGuide({
  open,
  channels,
  playingId,
  initialChannelId,
  categoryName,
  loadSchedule,
  onTune,
  onClose,
}: Props) {
  const [schedules, setSchedules] = React.useState<Map<string, EpgSchedule>>(new Map());
  const [selectedChannel, setSelectedChannel] = React.useState(0);
  const [selectedProgrammeStart, setSelectedProgrammeStart] = React.useState<number | null>(null);
  const [windowStart, setWindowStart] = React.useState(liveWindowStart);
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000));
  const [loadedCount, setLoadedCount] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [reloadVersion, setReloadVersion] = React.useState(0);
  const forceReloadRef = React.useRef<number | null>(null);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());

  const requestedInitialIndex = React.useMemo(() => {
    const wanted = String(initialChannelId || playingId || '');
    const found = channels.findIndex((channel) => channelKey(channel) === wanted);
    return found >= 0 ? found : 0;
  }, [channels, initialChannelId, playingId]);

  React.useEffect(() => {
    if (!open) return;
    setSelectedChannel(requestedInitialIndex);
    setSelectedProgrammeStart(null);
    setWindowStart(liveWindowStart());
    setNow(Math.floor(Date.now() / 1000));
  }, [open, requestedInitialIndex]);

  // Fetch the highlighted channel first, then fan out with a small concurrency
  // cap. The backend already shares its XMLTV fetch, while this keeps the
  // browser and provider fallback from receiving a burst of every channel at once.
  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const force = forceReloadRef.current === reloadVersion;
    const priority = channels
      .map((channel, index) => ({ channel, distance: Math.abs(index - requestedInitialIndex), index }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .map(({ channel }) => channel);

    const currentKeys = new Set(priority.map(channelKey));
    if (force) setSchedules(new Map());
    else {
      setSchedules((previous) => new Map(
        Array.from(previous).filter(([key]) => currentKeys.has(key)),
      ));
    }
    setLoadedCount(0);
    setLoading(priority.length > 0);
    let cursor = 0;
    let completed = 0;

    const worker = async () => {
      while (!cancelled) {
        const channel = priority[cursor];
        cursor += 1;
        if (!channel) return;

        const schedule = await loadSchedule(
          channel.stream_id,
          channel.epg_channel_id,
          channel.name,
          force,
        );
        if (cancelled) return;

        setSchedules((previous) => {
          const next = new Map(previous);
          next.set(channelKey(channel), schedule);
          return next;
        });
        completed += 1;
        setLoadedCount(completed);
      }
    };

    const workers = Array.from(
      { length: Math.min(LOAD_WORKERS, priority.length) },
      () => worker(),
    );
    void Promise.all(workers).then(() => {
      if (cancelled) return;
      setLoading(false);
      if (forceReloadRef.current === reloadVersion) forceReloadRef.current = null;
    });

    return () => { cancelled = true; };
  }, [channels, loadSchedule, open, reloadVersion, requestedInitialIndex]);

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const currentChannel = channels[selectedChannel];
  const currentSchedule = currentChannel ? schedules.get(channelKey(currentChannel)) : undefined;
  const selectedProgramme = React.useMemo(() => {
    if (!currentSchedule?.programmes.length) return undefined;
    if (selectedProgrammeStart !== null) {
      const exact = currentSchedule.programmes.find((programme) => programme.start === selectedProgrammeStart);
      if (exact) return exact;
    }
    return programmeAt(currentSchedule, now);
  }, [currentSchedule, now, selectedProgrammeStart]);

  const revealProgramme = React.useCallback((programme: EpgProgramme) => {
    setSelectedProgrammeStart(programme.start);
    setWindowStart((previous) => {
      if (programme.start < previous) return Math.floor(programme.start / HALF_HOUR) * HALF_HOUR;
      if (programme.end > previous + VIEW_SECONDS) {
        return Math.floor((programme.end - VIEW_SECONDS + HALF_HOUR) / HALF_HOUR) * HALF_HOUR;
      }
      return previous;
    });
  }, []);

  const chooseChannel = React.useCallback((index: number, targetTime?: number) => {
    const nextIndex = clamp(index, 0, Math.max(0, channels.length - 1));
    setSelectedChannel(nextIndex);
    const nextChannel = channels[nextIndex];
    const target = targetTime ?? selectedProgramme?.start ?? now;
    const programme = nextChannel ? programmeAt(schedules.get(channelKey(nextChannel)), target) : undefined;
    setSelectedProgrammeStart(programme?.start ?? null);
  }, [channels, now, schedules, selectedProgramme]);

  const moveProgramme = React.useCallback((direction: -1 | 1) => {
    if (!currentSchedule?.programmes.length) {
      setWindowStart((previous) => previous + direction * (2 * HOUR));
      return;
    }

    const programmes = currentSchedule.programmes;
    const selectedIndex = selectedProgramme
      ? programmes.findIndex((programme) => programme.start === selectedProgramme.start)
      : -1;
    const nextIndex = selectedIndex >= 0 ? selectedIndex + direction : (direction > 0 ? 0 : programmes.length - 1);
    const next = programmes[nextIndex];
    if (next) revealProgramme(next);
    else setWindowStart((previous) => previous + direction * (2 * HOUR));
  }, [currentSchedule, revealProgramme, selectedProgramme]);

  const jumpToTime = React.useCallback((target: number) => {
    setWindowStart(Math.floor(target / HALF_HOUR) * HALF_HOUR - (target === now ? HALF_HOUR : 0));
    const programme = programmeAt(currentSchedule, target);
    setSelectedProgrammeStart(programme?.start ?? null);
  }, [currentSchedule, now]);

  const refresh = React.useCallback(() => {
    setReloadVersion((previous) => {
      const next = previous + 1;
      forceReloadRef.current = next;
      return next;
    });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(refresh, GUIDE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  React.useEffect(() => {
    if (!open || !currentChannel) return;
    rowRefs.current.get(channelKey(currentChannel))?.scrollIntoView({ block: 'nearest' });
  }, [currentChannel, open, selectedChannel]);

  React.useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      const guideKeys = ['Guide', 'Epg', 'EPG', 'ColorF1Green', 'Green', 'g', 'G'];
      if (event.key === 'Escape' || event.key === 'Backspace' || guideKeys.includes(event.key)) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        chooseChannel(selectedChannel - 1);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        chooseChannel(selectedChannel + 1);
        return;
      }
      if (event.key === 'PageUp' || event.key === 'ChannelUp') {
        event.preventDefault();
        chooseChannel(selectedChannel - 8);
        return;
      }
      if (event.key === 'PageDown' || event.key === 'ChannelDown') {
        event.preventDefault();
        chooseChannel(selectedChannel + 8);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveProgramme(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveProgramme(1);
        return;
      }
      if (event.key === 'Home' || event.key === 'ColorF2Yellow' || event.key === 'Yellow') {
        event.preventDefault();
        jumpToTime(now);
        return;
      }
      if (event.key === 'r' || event.key === 'R' || event.key === 'BrowserRefresh') {
        event.preventDefault();
        refresh();
        return;
      }
      if ((event.key === 'Enter' || event.key === ' ') && currentChannel) {
        event.preventDefault();
        onTune(currentChannel);
        onClose();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chooseChannel, currentChannel, jumpToTime, moveProgramme, now, onClose, onTune, open, refresh, selectedChannel]);

  if (!open) return null;

  const windowEnd = windowStart + VIEW_SECONDS;
  const timeSlots = Array.from({ length: VIEW_SECONDS / HALF_HOUR }, (_, index) => windowStart + index * HALF_HOUR);
  const nowPosition = ((now - windowStart) / VIEW_SECONDS) * 100;
  const progress = channels.length ? Math.round((loadedCount / channels.length) * 100) : 0;
  const schedulesWithData = channels.filter((channel) => (
    (schedules.get(channelKey(channel))?.programmes.length || 0) > 0
  )).length;
  const hasNowLine = now >= windowStart && now <= windowEnd;

  return (
    <section id="epgGuide" role="dialog" aria-modal="true" aria-label="TV guide">
      <header className="guideHeader">
        <div className="guideIdentity">
          <div className="guideEyebrow">{categoryName || 'Live channels'}</div>
          <h1>TV Guide</h1>
        </div>

        <div className="guideDateControls" aria-label="Guide date controls">
          <button type="button" onClick={() => jumpToTime(shiftLocalDay(windowStart, -1))} aria-label="Previous day">&#x2039;</button>
          <button type="button" className="guideDateButton" onClick={() => jumpToTime(now)}>
            <span>{fullDate(windowStart)}</span>
            <small>{fmtTime(windowStart)} – {fmtTime(windowEnd)}</small>
          </button>
          <button type="button" onClick={() => jumpToTime(shiftLocalDay(windowStart, 1))} aria-label="Next day">&#x203a;</button>
          <button type="button" className="guideLiveButton" onClick={() => jumpToTime(now)}>
            <span /> Now
          </button>
        </div>

        <div className="guideActions">
          <div className="guideCoverage" title={`${schedulesWithData} channels have schedule data`}>
            {loading ? `${loadedCount}/${channels.length}` : `${schedulesWithData}/${channels.length}`} channels
          </div>
          <button type="button" onClick={refresh} disabled={loading} aria-label="Refresh guide">Refresh</button>
          <button type="button" className="guideClose" onClick={onClose} aria-label="Close guide">&#x2715;</button>
        </div>
      </header>

      <div className="guideLoadBar" aria-hidden="true">
        <div className={loading ? 'loading' : ''} style={{ width: `${loading ? progress : 100}%` }} />
      </div>

      {channels.length === 0 ? (
        <div className="guideEmpty">
          <strong>No channels to show</strong>
          <span>Connect to a provider and load a channel category first.</span>
        </div>
      ) : (
        <div className="guideTable">
          <div className="guideTimelineHeader">
            <div className="guideChannelHeading">Channel</div>
            <div className="guideTimes">
              {timeSlots.map((time) => (
                <div key={time} className={time % HOUR === 0 ? 'hour' : ''}>
                  <span>{fmtTime(time)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="guideRows">
            {channels.map((channel, channelIndex) => {
              const key = channelKey(channel);
              const schedule = schedules.get(key);
              const visible = schedule?.programmes.filter((programme) => (
                programme.end > windowStart && programme.start < windowEnd
              )) || [];
              const isSelectedChannel = channelIndex === selectedChannel;
              const isPlaying = key === playingId;

              return (
                <div
                  key={key}
                  ref={(node) => {
                    if (node) rowRefs.current.set(key, node);
                    else rowRefs.current.delete(key);
                  }}
                  className={`guideRow ${isSelectedChannel ? 'selectedChannel' : ''}`}
                  onClick={() => chooseChannel(channelIndex)}
                >
                  <button
                    type="button"
                    className={`guideChannel ${isPlaying ? 'playing' : ''}`}
                    onClick={() => chooseChannel(channelIndex)}
                    onDoubleClick={() => { onTune(channel); onClose(); }}
                  >
                    <span className="guideChannelNumber">{channelIndex + 1}</span>
                    <span className="guideChannelMark">{String(channel.name || '?').trim().charAt(0).toUpperCase()}</span>
                    <span className="guideChannelName">{channel.name || 'Channel'}</span>
                    {isPlaying && <span className="guidePlayingDot" title="Playing" />}
                  </button>

                  <div className="guideTrack">
                    {hasNowLine && <div className="guideNowLine" style={{ left: `${nowPosition}%` }}><span /></div>}
                    {!schedule && (
                      <div className="guideRowState loading"><span />Loading schedule…</div>
                    )}
                    {schedule && visible.length === 0 && (
                      <div className={`guideRowState ${schedule.error ? 'error' : ''}`}>
                        {schedule.error ? 'Guide unavailable' : 'No programme information'}
                      </div>
                    )}
                    {visible.map((programme) => {
                      const clippedStart = Math.max(programme.start, windowStart);
                      const clippedEnd = Math.min(programme.end, windowEnd);
                      const left = ((clippedStart - windowStart) / VIEW_SECONDS) * 100;
                      const width = ((clippedEnd - clippedStart) / VIEW_SECONDS) * 100;
                      const isLive = programme.start <= now && programme.end > now;
                      const isPast = programme.end <= now;
                      const isSelected = isSelectedChannel && selectedProgramme?.start === programme.start;

                      return (
                        <button
                          type="button"
                          key={`${programme.start}:${programme.title}`}
                          className={`guideProgramme ${isLive ? 'live' : ''} ${isPast ? 'past' : ''} ${isSelected ? 'selected' : ''}`}
                          style={{ left: `${left}%`, width: `max(${width}%, 3px)` }}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedChannel(channelIndex);
                            revealProgramme(programme);
                          }}
                          onDoubleClick={() => { onTune(channel); onClose(); }}
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
      )}

      <footer className="guideDetails">
        <div className="guideDetailsMain">
          <div className="guideDetailMeta">
            <span>{currentChannel?.name || 'Select a channel'}</span>
            {currentSchedule?.source && currentSchedule.source !== 'none' && (
              <span className={`guideSource ${currentSchedule.source}`}>
                {currentSchedule.source === 'external' ? 'Open EPG' : 'Provider'}{currentSchedule.stale ? ' · stale' : ''}
              </span>
            )}
            {selectedProgramme?.category && <span>{selectedProgramme.category}</span>}
          </div>
          <strong className="guideDetailTitle">
            {selectedProgramme?.title || (
              currentChannel ? (currentSchedule ? 'No programme information' : 'Loading schedule…') : 'No channel selected'
            )}
          </strong>
          <div className="guideDescription">
            {selectedProgramme?.description || 'Programme details will appear here when supplied by the guide.'}
          </div>
        </div>
        <div className="guideDetailsTime">
          {selectedProgramme && (
            <>
              <strong>{longDate(selectedProgramme.start)}</strong>
              <span>{fmtTime(selectedProgramme.start)} – {fmtTime(selectedProgramme.end)} · {durationLabel(selectedProgramme)}</span>
            </>
          )}
          {currentChannel && (
            <button type="button" onClick={() => { onTune(currentChannel); onClose(); }}>
              Watch channel
            </button>
          )}
        </div>
        <div className="guideRemoteHelp">
          <span><kbd>↑</kbd><kbd>↓</kbd> channels</span>
          <span><kbd>←</kbd><kbd>→</kbd> programmes</span>
          <span><kbd>OK</kbd> watch</span>
          <span><kbd>Yellow</kbd> now</span>
          <span><kbd>Green</kbd> close</span>
        </div>
      </footer>
    </section>
  );
}
