import React from 'react';

const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'OK',
  Escape: 'ESC',
  Backspace: 'BACK',
  ' ': 'SPACE',
  PageUp: 'CH+',
  PageDown: 'CH-',
  ChannelUp: 'CH+',
  ChannelDown: 'CH-',
  MediaTrackPrevious: 'CH+',
  MediaTrackNext: 'CH-',
};

export function useKeyIndicator() {
  const [keyIndicator, setKeyIndicator] = React.useState('');
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showKeyIndicator = React.useCallback((key: string) => {
    const normalized = key === 'Spacebar' ? ' ' : key;
    const display = KEY_LABELS[normalized] || normalized;
    setKeyIndicator(display);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setKeyIndicator(''), 900);
  }, []);

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { keyIndicator, showKeyIndicator };
}
