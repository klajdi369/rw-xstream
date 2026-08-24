import React from 'react';

type Props = {
  title: string;
  subtitle: string;
  hidden: boolean;
  onOpenSettings: () => void;
  onOpenVod?: () => void;
  keyIndicator?: string;
  epg?: {
    nowTitle: string;
    nowTime: string;
    progress: number;
    next: string;
    source: 'external' | 'default';
  } | null;
};

export function Hud({ title, subtitle, hidden, onOpenSettings, onOpenVod, keyIndicator, epg }: Props) {
  return (
    <div id="hud" className={hidden ? 'hide' : ''}>
      <div className="hudInfo">
        <div className="hudTitle">{title}</div>
        <div className="hudSub">{subtitle}</div>
        <div id="epgBlock" className={epg ? 'show' : ''}>
          <div className="epgNow">
            <span className="epgNowTitle">{epg?.nowTitle ?? ''}</span>
            <span className="epgTime">{epg?.nowTime ?? ''}</span>
            <span className={`epgSrc ${epg?.source === 'external' ? 'external' : 'default'}`}>
              {epg?.source === 'external' ? 'EXT' : 'DEF'}
            </span>
          </div>
          <div className="epgBar"><div className="epgBarFill" style={{ width: `${epg?.progress ?? 0}%` }} /></div>
          <div className="epgNext">{epg?.next ?? ''}</div>
        </div>
      </div>
      <div id="keyIndicator" className={keyIndicator ? 'show' : ''}>{keyIndicator || ''}</div>
      <div className="hudHint">
        <kbd>OK</kbd> open list<br />
        <kbd>&#x2191;</kbd> <kbd>&#x2193;</kbd> prev / next<br />
        <kbd>&#x2190;</kbd> categories<br />
        <kbd>Back</kbd> close<br />
        <kbd>Red</kbd> / <kbd>V</kbd> movies<br />
        {onOpenVod && <button id="vodBtn" onClick={onOpenVod}>Movies</button>}
        <button id="settingsBtn" onClick={onOpenSettings}>Settings</button>
      </div>
    </div>
  );
}
