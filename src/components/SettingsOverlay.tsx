import React from 'react';
import { clamp } from '../utils';

type Props = {
  open: boolean;
  server: string;
  user: string;
  pass: string;
  fmt: string;
  epgUrl: string;
  remember: boolean;
  useProxy: boolean;
  rememberProxyMode: boolean;
  checkVideo: boolean;
  message: string;
  isError?: boolean;
  progress?: number;
  onChange: (patch: Record<string, any>) => void;
  onConnect: () => void;
  onClear: () => void;
  onClose: () => void;
};

// The panel is one linear list of focusable rows so it can be driven entirely
// by a remote: ↑/↓ move the highlight, OK edits a field / flips a toggle /
// presses a button, Back closes.
const ITEM_COUNT = 11; // server, fmt, user, pass, EPG, + 4 toggles, + Connect, Clear

export function SettingsOverlay(props: Props) {
  const {
    open, server, user, pass, fmt, epgUrl, remember, useProxy, rememberProxyMode, checkVideo,
    message, isError, progress, onChange, onConnect, onClear, onClose,
  } = props;

  const [sel, setSel] = React.useState(0);

  // Options that only matter together with another one are greyed out (and
  // ignore OK/clicks) when it's off; their saved value is kept for later.
  // - Proxy memory decides between direct and proxy per channel: proxy off,
  //   nothing to decide.
  // - The video check works on direct TS (format "ts"); m3u8 plays through
  //   hls.js, and the proxy's ffmpeg output is clean already.
  const proxyMemoryOff = !useProxy;
  const checkVideoOff = fmt !== 'ts';
  const cardRef = React.useRef<HTMLDivElement>(null);
  const inputRefs = React.useRef<(HTMLInputElement | null)[]>([]);

  React.useEffect(() => { if (open) setSel(0); }, [open]);

  // Keep the highlighted row in view as it moves.
  React.useEffect(() => {
    if (!open) return;
    cardRef.current?.querySelector(`[data-sel="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, open]);

  const activate = React.useCallback((i: number) => {
    switch (i) {
      case 0: case 1: case 2: case 3: case 4:
        inputRefs.current[i]?.focus();
        break;
      case 5: onChange({ remember: !remember }); break;
      case 6: onChange({ useProxy: !useProxy }); break;
      case 7: if (!proxyMemoryOff) onChange({ rememberProxyMode: !rememberProxyMode }); break;
      case 8: if (!checkVideoOff) onChange({ checkVideo: !checkVideo }); break;
      case 9: onConnect(); break;
      case 10: onClear(); break;
    }
  }, [onChange, onConnect, onClear, remember, useProxy, rememberProxyMode, checkVideo, proxyMemoryOff, checkVideoOff]);

  // The listener reads the latest state through a ref and stays registered
  // for as long as the panel is open. Re-registering it on every render lost
  // keys: App re-renders in the middle of a keydown (its key indicator), and a
  // listener removed and re-added during an event never sees that event — so
  // OK on a toggle row did nothing.
  const latest = React.useRef({ sel, activate, onClose });
  latest.current = { sel, activate, onClose };

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // While a field is focused for typing, its own onKeyDown handles exit keys.
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      const { sel: current, activate: run, onClose: close } = latest.current;
      if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); setSel((v) => clamp(v + 1, 0, ITEM_COUNT - 1)); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); setSel((v) => clamp(v - 1, 0, ITEM_COUNT - 1)); return; }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(current); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Inside a text field: leave back to row navigation without the field
  // swallowing the keystroke.
  const fieldKey = (e: React.KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.blur(); setSel(clamp(i + 1, 0, ITEM_COUNT - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.currentTarget.blur(); setSel(clamp(i - 1, 0, ITEM_COUNT - 1)); }
  };

  const selClass = (i: number) => (sel === i ? 'setSel' : '');
  const setRef = (i: number) => (el: HTMLInputElement | null) => { inputRefs.current[i] = el; };

  return (
    <div id="settingsOverlay" className={open ? 'show' : ''}>
      <div id="settingsCard" ref={cardRef}>
        <h2>Settings</h2>
        <p className="sub">↑ / ↓ move · OK to edit or toggle · Back to close.</p>
        <div className="row2">
          <div className={`field ${selClass(0)}`} data-sel={0}>
            <label>Server URL</label>
            <input ref={setRef(0)} value={server} onKeyDown={(e) => fieldKey(e, 0)} onChange={(e) => onChange({ server: e.target.value })} placeholder="http://server:8080" />
          </div>
          <div className={`field ${selClass(1)}`} data-sel={1}>
            <label>Format</label>
            <input ref={setRef(1)} value={fmt} onKeyDown={(e) => fieldKey(e, 1)} onChange={(e) => onChange({ fmt: e.target.value })} placeholder="m3u8 or ts" />
          </div>
        </div>
        <div className="row2">
          <div className={`field ${selClass(2)}`} data-sel={2}>
            <label>Username</label>
            <input ref={setRef(2)} value={user} onKeyDown={(e) => fieldKey(e, 2)} onChange={(e) => onChange({ user: e.target.value })} placeholder="username" />
          </div>
          <div className={`field ${selClass(3)}`} data-sel={3}>
            <label>Password</label>
            <input ref={setRef(3)} type="password" value={pass} onKeyDown={(e) => fieldKey(e, 3)} onChange={(e) => onChange({ pass: e.target.value })} placeholder="password" />
          </div>
        </div>

        <div className={`field ${selClass(4)}`} data-sel={4}>
          <label>XMLTV guide URL <span className="fieldHint">Leave blank to use provider EPG only</span></label>
          <input ref={setRef(4)} value={epgUrl} onKeyDown={(e) => fieldKey(e, 4)} onChange={(e) => onChange({ epgUrl: e.target.value })} placeholder="https://example.com/guide.xml" />
        </div>

        <div className={`toggleRow ${selClass(5)}`} data-sel={5} onClick={() => { setSel(5); onChange({ remember: !remember }); }}>
          <div>
            <div className="tLabel">Remember last channel</div>
            <div className="tDesc">Resume the last watched channel and category on startup</div>
          </div>
          <label className="toggle" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={remember} onChange={(e) => onChange({ remember: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>

        <div className={`toggleRow ${selClass(6)}`} data-sel={6} onClick={() => { setSel(6); onChange({ useProxy: !useProxy }); }}>
          <div>
            <div className="tLabel">Use local proxy + deinterlace</div>
            <div className="tDesc">Route through /proxy and ffmpeg for interlaced channels</div>
          </div>
          <label className="toggle" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={useProxy} onChange={(e) => onChange({ useProxy: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>

        <div className={`toggleRow ${selClass(7)} ${proxyMemoryOff ? 'disabled' : ''}`} data-sel={7} aria-disabled={proxyMemoryOff} onClick={() => { setSel(7); activate(7); }}>
          <div>
            <div className="tLabel">Remember proxy mode per channel</div>
            <div className="tDesc">{proxyMemoryOff
              ? 'Only used with the proxy on'
              : 'Reset after 6 successful loads or on complete playback failure'}</div>
          </div>
          <label className="toggle" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={rememberProxyMode && !proxyMemoryOff} disabled={proxyMemoryOff} onChange={(e) => onChange({ rememberProxyMode: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>

        <div className={`toggleRow ${selClass(8)} ${checkVideoOff ? 'disabled' : ''}`} data-sel={8} aria-disabled={checkVideoOff} onClick={() => { setSel(8); activate(8); }}>
          <div>
            <div className="tLabel">Skip damaged video frames</div>
            <div className="tDesc">{checkVideoOff
              ? 'Only works with format "ts"'
              : 'Check each frame before showing it, so a damaged one is skipped instead of reconnecting. Uses extra CPU (around 40% of a core for an HD channel)'}</div>
          </div>
          <label className="toggle" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={checkVideo && !checkVideoOff} disabled={checkVideoOff} onChange={(e) => onChange({ checkVideo: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>
        {(progress !== undefined && progress > 0) && (
          <div className="progBar"><div className="progFill" style={{ width: `${progress}%` }} /></div>
        )}
        <div className="settActions">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className={`btn btnP ${selClass(9)}`} data-sel={9} onClick={onConnect}>Connect</button>
            <button className={`btn btnD ${selClass(10)}`} data-sel={10} onClick={onClear}>Clear Saved</button>
          </div>
          {message && <div className={`msg ${isError ? 'err' : 'ok'}`}>{message}</div>}
        </div>
      </div>
    </div>
  );
}
