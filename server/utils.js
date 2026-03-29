export function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

export function passthroughHeaders(headers) {
  const out = {};
  const allowed = ['accept', 'user-agent', 'cache-control', 'pragma', 'range'];
  for (const key of allowed) {
    if (headers[key]) out[key] = headers[key];
  }
  return out;
}

export function rewritePlaylist(body, sourceUrl, host, cookie = '') {
  const base = new URL(sourceUrl);
  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      try {
        const absolute = new URL(trimmed, base).toString();
        const cookieQ = cookie ? `&cookie=${encodeURIComponent(cookie)}` : '';
        return `/proxy?url=${encodeURIComponent(absolute)}&deint=1&host=${encodeURIComponent(host)}${cookieQ}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}
