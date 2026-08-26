import React from 'react';

type Props = {
  title: string;
  subtitle: string;
  hidden: boolean;
  onOpenSettings: () => void;
  onOpenGuide: () => void;
  keyIndicator?: string;
  epg?: {
    nowTitle: string;
    nowTime: string;
    progress: number;
    next: string;
    source: 'external' | 'default';
  } | null;
};

export function Hud({ title, subtitle, hidden, onOpenSettings, onOpenGuide, keyIndicator, epg }: Props) {
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
        <kbd>OK</kbd> channel list<br />
        <kbd>&#x2191;</kbd> <kbd>&#x2193;</kbd> prev / next<br />
        <kbd>CH+</kbd> <kbd>CH&#x2212;</kbd> jump 8<br />
        <kbd>0</kbd>&ndash;<kbd>9</kbd> go to number<br />
        <kbd>Blue</kbd> / <kbd>Pause</kbd> set order<br />
        <kbd>Green</kbd> / <kbd>Guide</kbd> TV guide<br />
        <kbd>Red</kbd> / <kbd>Menu</kbd> settings<br />
        <span className="hintDim">In list: <kbd>/</kbd> or <kbd>&#x2191;</kbd> search &middot; <kbd>&#x2190;</kbd><kbd>&#x2192;</kbd> panels</span>
        <div className="hudButtons">
          <button id="guideBtn" onClick={onOpenGuide}>TV Guide</button>
          <button id="settingsBtn" onClick={onOpenSettings}>Settings</button>
        </div>
      </div>
    </div>
  );
}
