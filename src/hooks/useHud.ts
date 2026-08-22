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
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    // While the sidebar/settings overlay is open it owns the screen; a visible
    // HUD would only sit under the backdrop and swallow clicks. Keep it hidden.
    if (sidebarOpen || settingsOpen) {
      setHudHidden(true);
      return;
    }
    setHudHidden(false);
    hudTimerRef.current = setTimeout(() => setHudHidden(true), 3500);
  }, [settingsOpen, sidebarOpen]);

  // Hide the HUD the moment an overlay opens (it may have been awake).
  React.useEffect(() => {
    if (sidebarOpen || settingsOpen) setHudHidden(true);
  }, [sidebarOpen, settingsOpen]);

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
