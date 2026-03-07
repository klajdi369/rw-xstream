import React from 'react';

export function useToast() {
  const [channelToast, setChannelToast] = React.useState('');
  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = React.useCallback((text: string) => {
    setChannelToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setChannelToast(''), 2500);
  }, []);

  React.useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  return { channelToast, showToast };
}
