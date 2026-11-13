export const PROXY_MODES = ['off', 'fallback', 'always'] as const;
export type ProxyMode = typeof PROXY_MODES[number];

export function readProxyMode(saved: Record<string, unknown>): ProxyMode {
  const mode = saved.proxyMode;
  if (mode === 'off' || mode === 'fallback' || mode === 'always') return mode;
  return saved.useProxy === true ? 'fallback' : 'off';
}
