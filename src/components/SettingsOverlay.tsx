import React from 'react';
import { PROFILE_KEY_PREFIX, readConnectionProfiles } from '../connectionProfiles';
import type { Credentials } from '../connectionProfiles';
import { clamp, normServer } from '../utils';
import type { DiagnosticEntry } from '../hooks/usePlaybackDiagnostics';
import { PlaybackDiagnostics } from './PlaybackDiagnostics';

type PlaybackSettings = {
  fmt: string;
  epgUrl: string;
  remember: boolean;
  useProxy: boolean;
  rememberProxyMode: boolean;
  checkVideo: boolean;
  debugPlayback: boolean;
};

type Props = PlaybackSettings & {
  open: boolean;
  connecting: boolean;
  credentials: Credentials;
  diagnostics: DiagnosticEntry[];
  message: string;
  isError?: boolean;
  progress?: number;
  onCredentialsChange: (credentials: Credentials) => void;
  onChange: (patch: Partial<PlaybackSettings>) => void;
  onConnect: () => void;
  onClear: () => void;
  onClose: () => void;
};

// The panel is one linear list of focusable rows so it can be driven entirely
// by a remote: ↑/↓ move the highlight, OK edits a field / flips a toggle /
// presses a button, Back closes.
enum Row {
  Profiles,
  LoadProfile,
  DeleteProfile,
  Server,
  Format,
  Username,
  Password,
  ProfileName,
  SaveProfile,
  GuideUrl,
  Remember,
  Proxy,
  RememberProxy,
  CheckVideo,
  Debug,
  Connect,
  Clear,
}

export function SettingsOverlay(props: Props) {
  const {
    open, connecting, credentials, fmt, epgUrl, remember, useProxy, rememberProxyMode, checkVideo, debugPlayback, diagnostics,
    message, isError, progress, onChange, onCredentialsChange, onConnect, onClear, onClose,
  } = props;

  const { server, user, pass } = credentials;
  const [sel, setSel] = React.useState(Row.Server);
  const [profiles, setProfiles] = React.useState(readConnectionProfiles);
  const [selectedName, setSelectedName] = React.useState('');
  const [profileName, setProfileName] = React.useState('');
  const [profileStatus, setProfileStatus] = React.useState({ text: '', error: false });
  const selectedProfile = profiles.find(({ name }) => name === selectedName);
  const updatingProfile = profiles.some(({ name }) => name === profileName.trim());

  // Options that only matter together with another one are greyed out (and
  // ignore OK/clicks) when it's off; their saved value is kept for later.
  // - Proxy memory decides between direct and proxy per channel: proxy off,
  //   nothing to decide.
  // - The video check works on direct TS (format "ts"); m3u8 plays through
  //   hls.js, and the proxy's ffmpeg output is clean already.
  const proxyMemoryOff = !useProxy;
  const checkVideoOff = fmt !== 'ts';
  const cardRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    if (!open) return;
    const savedProfiles = readConnectionProfiles();
    setProfiles(savedProfiles);
    setSel(savedProfiles.length ? Row.Profiles : Row.Server);
    setProfileStatus({ text: '', error: false });
    cardRef.current?.focus({ preventScroll: true });

    const syncProfiles = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(PROFILE_KEY_PREFIX)) {
        setProfiles(readConnectionProfiles());
      }
    };
    window.addEventListener('storage', syncProfiles);
    return () => window.removeEventListener('storage', syncProfiles);
  }, [open]);

  const saveProfile = () => {
    const name = profileName.trim();
    if (!name || !server.trim() || !user.trim() || !pass) {
      setProfileStatus({ text: 'Enter a profile name, server URL, username, and password.', error: true });
      return;
    }

    try {
      new URL(normServer(server));
    } catch {
      setProfileStatus({ text: 'Enter a valid server URL.', error: true });
      return;
    }

    try {
      localStorage.setItem(PROFILE_KEY_PREFIX + name, JSON.stringify(credentials));
      setProfiles(readConnectionProfiles());
      setSelectedName(name);
      setProfileStatus({ text: 'Profile saved.', error: false });
    } catch {
      setProfileStatus({ text: 'Could not save this profile in browser storage.', error: true });
    }
  };

  const loadProfile = () => {
    if (!selectedProfile) return;
    const { name, ...savedCredentials } = selectedProfile;
    onCredentialsChange(savedCredentials);
    setProfileName(name);
    setProfileStatus({ text: 'Profile loaded. Select Connect to use it.', error: false });
  };

  const deleteProfile = () => {
    if (!selectedProfile) return;
    try {
      localStorage.removeItem(PROFILE_KEY_PREFIX + selectedProfile.name);
      setProfiles(readConnectionProfiles());
      setSelectedName('');
      if (profileName.trim() === selectedProfile.name) setProfileName('');
      setProfileStatus({ text: 'Profile deleted.', error: false });
    } catch {
      setProfileStatus({ text: 'Could not delete this profile from browser storage.', error: true });
    }
  };

  // Keep the highlighted row in view as it moves.
  React.useEffect(() => {
    if (!open) return;
    cardRef.current?.querySelector(`[data-sel="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, open]);

  // The listener reads the latest state through a ref and stays registered
  // for as long as the panel is open. Re-registering it on every render lost
  // keys: App re-renders in the middle of a keydown (its key indicator), and a
  // listener removed and re-added during an event never sees that event — so
  // OK on a toggle row did nothing.
  const latest = React.useRef({ sel, onClose });
  latest.current = { sel, onClose };

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // While a field is focused for typing, its own onKeyDown handles exit keys.
      if (e.defaultPrevented) return;
      const target = e.target;
      if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;

      const { sel: current, onClose: close } = latest.current;
      if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); setSel((v) => clamp(v + 1, Row.Profiles, Row.Clear)); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); setSel((v) => clamp(v - 1, Row.Profiles, Row.Clear)); return; }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const row = cardRef.current?.querySelector<HTMLElement>(`[data-sel="${current}"]`);
        const input = row?.querySelector<HTMLElement>('input:not([type="checkbox"]), select');
        if (input) input.focus();
        else row?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Inside a text field: leave back to row navigation without the field
  // swallowing the keystroke.
  const fieldKey = (e: React.KeyboardEvent<HTMLInputElement>, row: Row) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.blur(); setSel(clamp(row + 1, Row.Profiles, Row.Clear)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.currentTarget.blur(); setSel(clamp(row - 1, Row.Profiles, Row.Clear)); }
  };

  const selClass = (row: Row) => (sel === row ? 'setSel' : '');

  return (
    <div id="settingsOverlay" className={open ? 'show' : ''}>
      <div id="settingsCard" ref={cardRef} tabIndex={-1} onFocus={(e) => {
        const row = e.target.closest<HTMLElement>('[data-sel]');
        if (row) setSel(Number(row.dataset.sel));
      }}>
        <h2>Settings</h2>
        <p className="sub">↑ / ↓ move · OK to select · Back to close.</p>
        {debugPlayback && <PlaybackDiagnostics entries={diagnostics} />}
        <div className="profileActions">
          <div className={`field ${selClass(Row.Profiles)}`} data-sel={Row.Profiles}>
            <label htmlFor="connectionProfile">Saved profile</label>
            <select id="connectionProfile" value={selectedProfile?.name ?? ''} disabled={!profiles.length || connecting}
              onChange={(e) => setSelectedName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== 'Escape') return;
                e.preventDefault();
                e.currentTarget.blur();
                if (e.key === 'Enter' && selectedProfile) setSel(Row.LoadProfile);
              }}>
              <option value="">{profiles.length ? 'Choose a profile' : 'No saved profiles'}</option>
              {profiles.map(({ name }) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <button className={`btn ${selClass(Row.LoadProfile)}`} data-sel={Row.LoadProfile}
            disabled={!selectedProfile || connecting} onClick={loadProfile}>Load Profile</button>
          <button className={`btn btnD ${selClass(Row.DeleteProfile)}`} data-sel={Row.DeleteProfile}
            disabled={!selectedProfile || connecting} onClick={deleteProfile}>Delete Profile</button>
        </div>
        <div className="row2">
          <div className={`field ${selClass(Row.Server)}`} data-sel={Row.Server}>
            <label htmlFor="connectionServer">Server URL</label>
            <input id="connectionServer" value={server} onKeyDown={(e) => fieldKey(e, Row.Server)} onChange={(e) => onCredentialsChange({ ...credentials, server: e.target.value })} placeholder="http://server:8080" />
          </div>
          <div className={`field ${selClass(Row.Format)}`} data-sel={Row.Format}>
            <label htmlFor="streamFormat">Format</label>
            <input id="streamFormat" value={fmt} onKeyDown={(e) => fieldKey(e, Row.Format)} onChange={(e) => onChange({ fmt: e.target.value })} placeholder="m3u8 or ts" />
          </div>
        </div>
        <div className="row2">
          <div className={`field ${selClass(Row.Username)}`} data-sel={Row.Username}>
            <label htmlFor="connectionUsername">Username</label>
            <input id="connectionUsername" value={user} onKeyDown={(e) => fieldKey(e, Row.Username)} onChange={(e) => onCredentialsChange({ ...credentials, user: e.target.value })} placeholder="username" />
          </div>
          <div className={`field ${selClass(Row.Password)}`} data-sel={Row.Password}>
            <label htmlFor="connectionPassword">Password</label>
            <input id="connectionPassword" type="password" value={pass} onKeyDown={(e) => fieldKey(e, Row.Password)} onChange={(e) => onCredentialsChange({ ...credentials, pass: e.target.value })} placeholder="password" />
          </div>
        </div>
        <div className="profileActions">
          <div className={`field ${selClass(Row.ProfileName)}`} data-sel={Row.ProfileName}>
            <label htmlFor="connectionProfileName">Profile name</label>
            <input id="connectionProfileName" value={profileName} onKeyDown={(e) => fieldKey(e, Row.ProfileName)} onChange={(e) => setProfileName(e.target.value)} />
          </div>
          <button className={`btn ${selClass(Row.SaveProfile)}`} data-sel={Row.SaveProfile} disabled={connecting}
            onClick={saveProfile}>{updatingProfile ? 'Update Profile' : 'Save Profile'}</button>
        </div>
        <div role="status" className={`profileStatus msg ${profileStatus.error ? 'err' : 'ok'}`}>{profileStatus.text}</div>

        <div className={`field ${selClass(Row.GuideUrl)}`} data-sel={Row.GuideUrl}>
          <label htmlFor="xmltvUrl">XMLTV guide URL <span className="fieldHint">Leave blank to use provider EPG only</span></label>
          <input id="xmltvUrl" value={epgUrl} onKeyDown={(e) => fieldKey(e, Row.GuideUrl)} onChange={(e) => onChange({ epgUrl: e.target.value })} placeholder="https://example.com/guide.xml" />
        </div>

        <div className={`toggleRow ${selClass(Row.Remember)}`} data-sel={Row.Remember} onClick={() => { setSel(Row.Remember); onChange({ remember: !remember }); }}>
          <div>
            <div className="tLabel">Remember last channel</div>
            <div className="tDesc">Resume the last watched channel and category on startup</div>
          </div>
          <label className="toggle" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={remember} onChange={(e) => onChange({ remember: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>

        <div className={`toggleRow ${selClass(Row.Proxy)}`} data-sel={Row.Proxy} onClick={() => { setSel(Row.Proxy); onChange({ useProxy: !useProxy }); }}>
          <div>
            <div className="tLabel">Use local proxy + deinterlace</div>
            <div className="tDesc">Route through /proxy and ffmpeg for interlaced channels</div>
          </div>
          <label className="toggle" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={useProxy} onChange={(e) => onChange({ useProxy: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>

        <div className={`toggleRow ${selClass(Row.RememberProxy)} ${proxyMemoryOff ? 'disabled' : ''}`} data-sel={Row.RememberProxy} aria-disabled={proxyMemoryOff}
          onClick={() => { setSel(Row.RememberProxy); if (!proxyMemoryOff) onChange({ rememberProxyMode: !rememberProxyMode }); }}>
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

        <div className={`toggleRow ${selClass(Row.CheckVideo)} ${checkVideoOff ? 'disabled' : ''}`} data-sel={Row.CheckVideo} aria-disabled={checkVideoOff}
          onClick={() => { setSel(Row.CheckVideo); if (!checkVideoOff) onChange({ checkVideo: !checkVideo }); }}>
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

        <div className={`toggleRow ${selClass(Row.Debug)}`} data-sel={Row.Debug}
          onClick={() => { setSel(Row.Debug); onChange({ debugPlayback: !debugPlayback }); }}>
          <div>
            <div id="playbackDebugLabel" className="tLabel">Playback debug</div>
            <div className="tDesc">Show connection and video errors on screen.</div>
          </div>
          <label className="toggle" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" aria-labelledby="playbackDebugLabel" checked={debugPlayback} onChange={(e) => onChange({ debugPlayback: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>
        {(progress !== undefined && progress > 0) && (
          <div className="progBar"><div className="progFill" style={{ width: `${progress}%` }} /></div>
        )}
        <div className="settActions">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className={`btn btnP ${selClass(Row.Connect)}`} data-sel={Row.Connect} disabled={connecting} onClick={onConnect}>Connect</button>
            <button className={`btn btnD ${selClass(Row.Clear)}`} data-sel={Row.Clear} disabled={connecting} onClick={onClear}>Clear Last Connection</button>
          </div>
          {message && <div className={`msg ${isError ? 'err' : 'ok'}`}>{message}</div>}
        </div>
      </div>
    </div>
  );
}
