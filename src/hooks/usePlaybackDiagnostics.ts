import React from 'react';

const DEBUG_KEY = 'xtream_playback_debug';
const MAX_ENTRIES = 6;

export type DiagnosticEntry = {
  id: number;
  level: 'info' | 'error';
  message: string;
};

export type ReportDiagnostic = (message: string, level?: DiagnosticEntry['level']) => void;

// Raw exception messages can contain URLs, including stream credentials.
export function diagnosticErrorName(error: unknown) {
  const name = (error as { name?: string } | null)?.name;
  switch (name) {
    case 'AbortError':
    case 'InvalidStateError':
    case 'NetworkError':
    case 'NotAllowedError':
    case 'NotSupportedError':
    case 'QuotaExceededError':
    case 'ReferenceError':
    case 'SecurityError':
    case 'SyntaxError':
    case 'TimeoutError':
    case 'TypeError':
      return name;
    default:
      return 'Error';
  }
}

export function diagnosticHttpStatus(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? `HTTP ${value}`
    : '';
}

export function usePlaybackDiagnostics() {
  const [enabled, setEnabled] = React.useState(() => {
    try { return localStorage.getItem(DEBUG_KEY) === '1'; } catch { return false; }
  });
  const enabledRef = React.useRef(enabled);
  const [entries, setEntries] = React.useState<DiagnosticEntry[]>([]);
  const nextId = React.useRef(0);

  const setDebugEnabled = React.useCallback((value: boolean) => {
    enabledRef.current = value;
    setEnabled(value);
    if (!value) setEntries([]);
    try { localStorage.setItem(DEBUG_KEY, value ? '1' : '0'); } catch { /* storage unavailable */ }
  }, []);

  const reportDiagnostic = React.useCallback<ReportDiagnostic>((message, level = 'info') => {
    if (!enabledRef.current) return;
    const entry = { id: ++nextId.current, level, message };
    setEntries((current) => {
      const last = current[current.length - 1];
      if (last?.message === message && last.level === level) return current;
      return [...current.slice(-(MAX_ENTRIES - 1)), entry];
    });
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    const onError = (event: ErrorEvent) => reportDiagnostic(`Browser error (${diagnosticErrorName(event.error)})`, 'error');
    const onRejection = (event: PromiseRejectionEvent) => reportDiagnostic(`Unexpected player error (${diagnosticErrorName(event.reason)})`, 'error');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [enabled, reportDiagnostic]);

  return { enabled, entries, setDebugEnabled, reportDiagnostic };
}
