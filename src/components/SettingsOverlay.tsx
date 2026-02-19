import React from 'react';

type Props = {
  open: boolean;
  server: string;
  user: string;
  pass: string;
  fmt: string;
  remember: boolean;
  useProxy: boolean;
  message: string;
  onChange: (patch: Record<string, any>) => void;
  onConnect: () => void;
  onClear: () => void;
};

export function SettingsOverlay(props: Props) {
  const { open, server, user, pass, fmt, remember, useProxy, message, onChange, onConnect, onClear } = props;

  return (
    <div id="settingsOverlay" className={open ? 'show' : ''}>
      <div id="settingsCard">
        <h2>⚙ Settings</h2>
        <p className="sub">Connection settings and preferences. Press Back / Esc to close without saving.</p>
        <div className="row2">
          <div className="field"><label>Server URL</label><input value={server} onChange={(e) => onChange({ server: e.target.value })} /></div>
          <div className="field"><label>Format</label><input value={fmt} onChange={(e) => onChange({ fmt: e.target.value })} /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Username</label><input value={user} onChange={(e) => onChange({ user: e.target.value })} /></div>
          <div className="field"><label>Password</label><input type="password" value={pass} onChange={(e) => onChange({ pass: e.target.value })} /></div>
        </div>
        <div className="toggleRow">
          <div>
            <div className="tLabel">Remember last channel</div>
            <div className="tDesc">Automatically resume the last watched channel on startup</div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={remember} onChange={(e) => onChange({ remember: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>

        <div className="toggleRow">
          <div>
            <div className="tLabel">Use local proxy + deinterlace</div>
            <div className="tDesc">Fixes black-screen interlaced channels by routing through /proxy and ffmpeg</div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={useProxy} onChange={(e) => onChange({ useProxy: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>
        <div className="settActions">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btnP" onClick={onConnect}>Connect</button>
            <button className="btn btnD" onClick={onClear}>Clear Saved</button>
          </div>
          <div className="msg">{message}</div>
        </div>
      </div>
    </div>
  );
}
