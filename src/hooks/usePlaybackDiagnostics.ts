import React from 'react';
import { readPlaybackEnvironment } from '../player/playbackDiagnostics';

const DEBUG_KEY = 'xtream_playback_debug';
const MAX_ENTRIES = 100;

export type DiagnosticEntry = {
  id: number;
  level: 'info' | 'error';
  message: string;
  elapsedMs: number;
  count: number;
};

export type ReportDiagnostic = (message: string, level?: DiagnosticEntry['level']) => void;

export function formatDiagnosticEntry({ level, elapsedMs, count, message }: DiagnosticEntry) {
  const repeats = count > 1 ? ` ×${count}` : '';
  return `+${(elapsedMs / 1000).toFixed(1)}s  ${level === 'error' ? 'Error · ' : ''}${message}${repeats}`;
}

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
  const startedAt = React.useRef(performance.now());
  const [entries, setEntries] = React.useState<DiagnosticEntry[]>([]);
  const environment = React.useMemo(() => enabled ? readPlaybackEnvironment() : [], [enabled]);
  const nextId = React.useRef(0);

  const setDebugEnabled = React.useCallback((value: boolean) => {
    if (value && !enabledRef.current) startedAt.current = performance.now();
    enabledRef.current = value;
    setEnabled(value);
    if (!value) setEntries([]);
    try { localStorage.setItem(DEBUG_KEY, value ? '1' : '0'); } catch { /* storage unavailable */ }
  }, []);

  const reportDiagnostic = React.useCallback<ReportDiagnostic>((message, level = 'info') => {
    if (!enabledRef.current) return;
    const entry = { id: ++nextId.current, level, message, elapsedMs: performance.now() - startedAt.current, count: 1 };
    setEntries((current) => {
      const last = current[current.length - 1];
      if (last?.message === message && last.level === level) {
        return [...current.slice(0, -1), { ...last, count: last.count + 1 }];
      }
      return [...current.slice(-(MAX_ENTRIES - 1)), entry];
    });
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    const onError = (event: ErrorEvent) => reportDiagnostic(`Browser error (${diagnosticErrorName(event.error)})`, 'error');
    const onRejection = (event: PromiseRejectionEvent) => reportDiagnostic(`Unexpected player error (${diagnosticErrorName(event.reason)})`, 'error');
    const onOnline = () => reportDiagnostic('Browser reports network online.');
    const onOffline = () => reportDiagnostic('Browser reports network offline.', 'error');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [enabled, reportDiagnostic]);

  return { enabled, entries, environment, setDebugEnabled, reportDiagnostic };
}
