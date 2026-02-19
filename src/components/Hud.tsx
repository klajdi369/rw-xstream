import React from 'react';

type Props = {
  title: string;
  subtitle: string;
  hidden: boolean;
  onOpenSettings: () => void;
};

export function Hud({ title, subtitle, hidden, onOpenSettings }: Props) {
  return (
    <div id="hud" className={hidden ? 'hide' : ''}>
      <div className="hudInfo">
        <div className="hudTitle">{title}</div>
        <div className="hudSub">{subtitle}</div>
      </div>
      <div className="hudHint">
        OK — open list<br />↑ ↓ — prev / next<br />← — categories<br />Back — close<br />
        <button id="settingsBtn" onClick={onOpenSettings}>⚙ Settings</button>
      </div>
    </div>
  );
}
