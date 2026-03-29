import React from 'react';

interface OrderPromptProps {
  open: boolean;
  digits: string;
  target: { streamId: string; name: string; catId: string } | null;
  error: string;
}

export function OrderPrompt({ open, digits, target, error }: OrderPromptProps) {
  return (
    <div id="orderPrompt" className={open ? 'show' : ''}>
      <div className={`orderCard${error ? ' hasError' : ''}`}>
        <div className="orderTitle">Set channel order</div>
        <div className="orderName">{target?.name || 'Channel'}</div>
        <div className={`orderDigits${error ? ' hasError' : ''}`}>{digits || '—'}</div>
        <div className="orderHelp">Use number keys, OK to save (empty = no change), Back to edit</div>
        {error && <div className="orderErr">{error}</div>}
      </div>
    </div>
  );
}
