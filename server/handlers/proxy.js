import { Readable } from 'node:stream';
import { send, passthroughHeaders, rewritePlaylist } from '../utils.js';
import { proxyViaFfmpeg, transcodeFromUrl } from '../ffmpeg.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export async function handleProxy(req, res, url, PORT) {
  const target = url.searchParams.get('url');
  const deint = url.searchParams.get('deint') !== '0';
  const host = url.searchParams.get('host') || `${req.headers.host ?? `127.0.0.1:${PORT}`}`;
  const cookieFromQuery = url.searchParams.get('cookie') || '';

  if (!target) return send(res, 400, 'text/plain; charset=utf-8', 'Missing url');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'Invalid url');
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return send(res, 400, 'text/plain; charset=utf-8', 'Unsupported protocol');
  }

  try {
    const hdrs = passthroughHeaders(req.headers);
    if (cookieFromQuery) hdrs.cookie = cookieFromQuery;
    if (!hdrs['user-agent']) hdrs['user-agent'] = DEFAULT_USER_AGENT;
    delete hdrs.origin;
    delete hdrs.referer;

    const doFetch = () => fetch(targetUrl, { method: 'GET', headers: { ...hdrs }, redirect: 'follow' });

    let upstream = await doFetch();

    // Retry 403 with backoff — IPTV providers sometimes keep previous
    // HLS sessions alive briefly and reject immediate reconnects.
    for (const delayMs of [1200, 2200]) {
      if (upstream.status !== 403) break;
      try { await upstream.text(); } catch { /* drain body */ }
      console.warn(`[PROXY] got 403, retrying after ${delayMs}ms… ${targetUrl}`);
      await new Promise((r) => setTimeout(r, delayMs));
      upstream = await doFetch();
    }

    if (!upstream.ok) {
      let preview = '';
      try { preview = (await upstream.text()).slice(0, 180); } catch { /* noop */ }
      console.warn(`[PROXY] upstream ${upstream.status} ${targetUrl} final=${upstream.url} preview=${preview.split('\n').join(' ')}`);
      return send(res, upstream.status, 'text/plain; charset=utf-8', `Upstream HTTP ${upstream.status}`);
    }

    const ctype = upstream.headers.get('content-type') || '';
    const getSetCookie = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
    const cookieParts = (Array.isArray(getSetCookie) ? getSetCookie : []).map((line) => String(line).split(';')[0]).filter(Boolean);
    const stickyCookie = cookieParts.join('; ');
    const isPlaylist = ctype.includes('mpegurl') || targetUrl.pathname.endsWith('.m3u8');
    const isTs = ctype.includes('video/mp2t') || targetUrl.pathname.endsWith('.ts');

    if (isPlaylist) {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, targetUrl.toString(), host, stickyCookie);
      console.log(`[PROXY] playlist ok ${targetUrl} cookie=${stickyCookie ? 'yes' : 'no'}`);
      res.writeHead(200, {
        'Content-Type': 'application/x-mpegURL',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(rewritten);
    }

    if (!upstream.body) {
      return send(res, 502, 'text/plain; charset=utf-8', 'Empty upstream body');
    }

    const body = Readable.fromWeb(upstream.body);

    if (isTs && deint) {
      return proxyViaFfmpeg(body, res);
    }

    res.writeHead(200, {
      'Content-Type': ctype || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
    body.pipe(res);
  } catch (err) {
    send(res, 502, 'text/plain; charset=utf-8', `Proxy error: ${err?.message || String(err)}`);
  }
}

export async function handleProxyTranscode(res, url) {
  const target = url.searchParams.get('url');
  if (!target) return send(res, 400, 'text/plain; charset=utf-8', 'Missing url');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'Invalid url');
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return send(res, 400, 'text/plain; charset=utf-8', 'Unsupported protocol');
  }

  transcodeFromUrl(targetUrl.toString(), res);
}
