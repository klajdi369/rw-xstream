import type { DiagnosticEntry } from '../hooks/usePlaybackDiagnostics';

export function PlaybackDiagnostics({ entries, onPlayer = false }: { entries: DiagnosticEntry[]; onPlayer?: boolean }) {
  return (
    <section className={`playbackDiagnostics${onPlayer ? ' onPlayer' : ''}`} aria-label="Playback diagnostics" aria-live="polite">
      <h3>Playback diagnostics</h3>
      {entries.length ? (
        <ul>
          {entries.map(({ id, level, message }) => (
            <li key={id} className={level === 'error' ? 'error' : ''}>{message}</li>
          ))}
        </ul>
      ) : <p>Connect or tune to a channel to see diagnostics.</p>}
    </section>
  );
}
