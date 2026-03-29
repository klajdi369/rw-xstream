import React from 'react';

interface UseHudOptions {
  sidebarOpen: boolean;
  settingsOpen: boolean;
}

export function useHud({ sidebarOpen, settingsOpen }: UseHudOptions) {
  const [hudTitle, setHudTitle] = React.useState('IPTV Player');
  const [hudSub, setHudSub] = React.useState('Press OK to open channel list');
  const [hudHidden, setHudHidden] = React.useState(true);
  const hudTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const wakeHud = React.useCallback(() => {
    setHudHidden(false);
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    if (!sidebarOpen && !settingsOpen) {
      hudTimerRef.current = setTimeout(() => setHudHidden(true), 3500);
    }
  }, [settingsOpen, sidebarOpen]);

  React.useEffect(() => {
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    if (!sidebarOpen && !settingsOpen && !hudHidden) {
      hudTimerRef.current = setTimeout(() => setHudHidden(true), 1800);
    }
  }, [hudHidden, settingsOpen, sidebarOpen]);

  React.useEffect(() => {
    return () => {
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    };
  }, []);

  return { hudTitle, setHudTitle, hudSub, setHudSub, hudHidden, wakeHud };
}
