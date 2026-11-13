import React from 'react';
import { formatDiagnosticEntry } from '../hooks/usePlaybackDiagnostics';
import type { DiagnosticEntry } from '../hooks/usePlaybackDiagnostics';

export function PlaybackDiagnostics({ entries, onPlayer = false }: { entries: DiagnosticEntry[]; onPlayer?: boolean }) {
  return (
    <section className={`playbackDiagnostics${onPlayer ? ' onPlayer' : ''}`} aria-label="Playback diagnostics" aria-live="polite">
      <h3>Playback diagnostics</h3>
      {entries.length ? (
        <ul>
          {entries.slice(-6).map(({ id, level, message, elapsedMs, count }) => (
            <li key={id} className={level === 'error' ? 'error' : ''}>
              <span className="diagnosticTime">+{(elapsedMs / 1000).toFixed(1)}s</span>
              <span>{message}</span>{count > 1 && <span> ×{count}</span>}
            </li>
          ))}
        </ul>
      ) : <p>Connect or tune to a channel to see diagnostics.</p>}
    </section>
  );
}

export function PlaybackDebugReport({ entries, environment, onBack }: {
  entries: DiagnosticEntry[];
  environment: string[];
  onBack: () => void;
}) {
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = React.useState('');
  const [deviceResults, setDeviceResults] = React.useState<string[]>([]);
  const [testing, setTesting] = React.useState(false);
  const report = ['Playback diagnostics', ...environment, '', 'On-device media test',
    ...(deviceResults.length ? deviceResults : [testing ? 'Running…' : 'Select Run device test to measure this browser.']),
    '', 'Event timeline',
    ...(entries.length ? entries.map(formatDiagnosticEntry) : ['Connect or tune to a channel to capture events.']),
  ].join('\n');

  React.useLayoutEffect(() => {
    const field = textRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollTop = field.scrollHeight;
  }, []);

  const testDevice = async () => {
    setTesting(true);
    setDeviceResults([]);
    setMessage('Testing this browser…');
    try {
      const { runDeviceMediaTest } = await import('../player/deviceMediaTest');
      setDeviceResults(await runDeviceMediaTest());
      setMessage('Device test complete.');
      if (textRef.current) textRef.current.scrollTop = 0;
    } catch {
      setMessage('Device test could not run.');
    } finally {
      setTesting(false);
    }
  };

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        setMessage('Report copied.');
        return;
      }
    } catch { /* Try the clipboard fallback on TV browsers and local HTTP. */ }
    const field = textRef.current;
    if (!field) return;
    const scrollTop = field.scrollTop;
    field.focus();
    field.select();
    try {
      if (document.execCommand('copy')) {
        field.setSelectionRange(0, 0);
        field.scrollTop = scrollTop;
        setMessage('Report copied.');
        return;
      }
    } catch { /* Keep the text selected so it can be copied manually. */ }
    setMessage('Report selected. Use your browser’s copy command.');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const field = textRef.current;
    if (!field) return;
    switch (event.key) {
      case 'Escape': case 'Backspace': case 'BrowserBack':
        event.preventDefault();
        onBack();
        break;
      case 'ArrowUp': case 'ArrowDown': case 'PageUp': case 'PageDown': {
        if (event.target !== field) break;
        event.preventDefault();
        const distance = event.key.startsWith('Page') ? field.clientHeight : 56;
        field.scrollTop += event.key.endsWith('Up') ? -distance : distance;
        break;
      }
      case 'Enter':
        if (event.target === field) {
          event.preventDefault();
          void copy();
        }
        break;
      case 'ArrowLeft': case 'ArrowRight': {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('textarea, button:not(:disabled)'));
        const current = controls.indexOf(event.target as HTMLElement);
        if (current < 0) break;
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        controls[(current + step + controls.length) % controls.length].focus();
        break;
      }
    }
  };

  return (
    <div className="playbackDebugReport" onKeyDown={onKeyDown}>
      <h2>Playback debug report</h2>
      <p className="sub">↑ / ↓ scroll · ← / → choose control · OK to select · Back to settings.</p>
      <textarea ref={textRef} aria-label="Debug report text" value={report} readOnly rows={18} />
      <div className="settActions">
        <button type="button" className="btn btnP" aria-disabled={testing} onClick={() => { if (!testing) void testDevice(); }}>
          {testing ? 'Running device test…' : 'Run device test'}
        </button>
        <button type="button" className="btn" onClick={copy}>Copy report</button>
        <button type="button" className="btn" onClick={onBack}>Back to settings</button>
        <span className="msg ok" role="status">{message}</span>
      </div>
    </div>
  );
}
