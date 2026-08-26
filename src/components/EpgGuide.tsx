import React from 'react';
import { GUIDE_PAGE_SIZE, channelKey, shiftLocalDay } from '../epg/model';
import { guideRemoteAction } from '../epg/remote';
import type { EpgProgramme, LoadEpgSchedule } from '../epg/types';
import type { Channel } from '../types/player';
import { EpgGuideDetails } from './epg/EpgGuideDetails';
import { EpgGuideGrid } from './epg/EpgGuideGrid';
import { EpgGuideHeader } from './epg/EpgGuideHeader';
import { useGuideNavigation } from './epg/useGuideNavigation';
import { useGuideSchedules } from './epg/useGuideSchedules';

type Props = {
  open: boolean;
  channels: Channel[];
  playingId: string | null;
  initialChannelId?: string | null;
  categoryName: string;
  loadSchedule: LoadEpgSchedule;
  onTune: (channel: Channel) => void;
  onClose: () => void;
};

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
  const guideRef = React.useRef<HTMLElement>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);

  const initialIndex = React.useMemo(() => {
    const preferredId = String(initialChannelId || playingId || '');
    const index = channels.findIndex((channel) => channelKey(channel) === preferredId);
    return index >= 0 ? index : 0;
  }, [channels, initialChannelId, playingId]);

  const { schedules, loadState, refresh } = useGuideSchedules({
    open,
    channels,
    priorityIndex: initialIndex,
    loadSchedule,
  });
  const navigation = useGuideNavigation({ open, channels, schedules, initialIndex });
  const channelsWithData = React.useMemo(() => channels.filter((channel) => (
    (schedules.get(channelKey(channel))?.programmes.length || 0) > 0
  )).length, [channels, schedules]);

  // The guide is one remote-controlled focus surface. Moving focus here avoids
  // the browser activating whichever sidebar/HUD button happened to be focused
  // before the overlay opened. Restore that focus after the guide closes.
  React.useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => guideRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  const watch = React.useCallback((channel?: Channel) => {
    if (!channel) return;
    onTune(channel);
    onClose();
  }, [onClose, onTune]);

  const handleRemoteKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const action = guideRemoteAction(event.nativeEvent);
    if (!action) return;

    // Preserve normal keyboard activation for the header's tabbable controls.
    // Remote focus normally stays on the guide surface; this branch is for
    // keyboard/mouse users who explicitly focused a button inside it.
    if (
      action === 'watch'
      && event.target !== event.currentTarget
      && event.target instanceof HTMLElement
      && event.target.tabIndex >= 0
    ) return;

    event.preventDefault();
    event.stopPropagation();

    switch (action) {
      case 'close': onClose(); break;
      case 'channel-up': navigation.moveChannel(-1); break;
      case 'channel-down': navigation.moveChannel(1); break;
      case 'page-up': navigation.moveChannel(-GUIDE_PAGE_SIZE); break;
      case 'page-down': navigation.moveChannel(GUIDE_PAGE_SIZE); break;
      case 'programme-left': navigation.moveProgramme(-1); break;
      case 'programme-right': navigation.moveProgramme(1); break;
      case 'watch': watch(navigation.selectedChannel); break;
      case 'now': navigation.jumpToNow(); break;
      case 'refresh': if (!loadState.loading) refresh(); break;
    }
  };

  if (!open) return null;

  const activeDescendant = navigation.selectedProgramme
    ? `guide-programme-${navigation.selectedChannelIndex}-${navigation.selectedProgramme.start}`
    : `guide-channel-${navigation.selectedChannelIndex}`;

  return (
    <section
      id="epgGuide"
      ref={guideRef}
      role="dialog"
      aria-modal="true"
      aria-label="TV guide"
      aria-activedescendant={activeDescendant}
      tabIndex={0}
      onKeyDown={handleRemoteKey}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          window.requestAnimationFrame(() => guideRef.current?.focus());
        }
      }}
    >
      <EpgGuideHeader
        categoryName={categoryName}
        windowStart={navigation.windowStart}
        windowEnd={navigation.windowEnd}
        loadState={loadState}
        channelsWithData={channelsWithData}
        onPreviousDay={() => navigation.jumpToTime(shiftLocalDay(navigation.windowStart, -1))}
        onNextDay={() => navigation.jumpToTime(shiftLocalDay(navigation.windowStart, 1))}
        onNow={navigation.jumpToNow}
        onRefresh={refresh}
        onClose={onClose}
      />

      {channels.length ? (
        <EpgGuideGrid
          channels={channels}
          schedules={schedules}
          playingId={playingId}
          selectedChannelIndex={navigation.selectedChannelIndex}
          selectedProgramme={navigation.selectedProgramme}
          windowStart={navigation.windowStart}
          windowEnd={navigation.windowEnd}
          now={navigation.now}
          onSelectChannel={navigation.selectChannel}
          onSelectProgramme={(channelIndex: number, programme: EpgProgramme) => {
            navigation.selectChannel(channelIndex, programme.start);
            navigation.revealProgramme(programme);
            guideRef.current?.focus();
          }}
          onWatch={watch}
        />
      ) : (
        <div className="guideEmpty">
          <strong>No channels to show</strong>
          <span>Connect to a provider and load a channel category first.</span>
        </div>
      )}

      <EpgGuideDetails
        channel={navigation.selectedChannel}
        schedule={navigation.selectedSchedule}
        programme={navigation.selectedProgramme}
        onWatch={() => watch(navigation.selectedChannel)}
      />
    </section>
  );
}
