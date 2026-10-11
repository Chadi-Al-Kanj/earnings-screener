/**
 * Vercel Edge Function — the deployed stand-in for serve.ps1.
 *
 * Neither the SEC nor Yahoo sends CORS headers, so the page cannot call them
 * directly from the browser. vercel.json rewrites /yahoo here, which keeps
 * index.html byte-identical to the copy that runs against the local server.
 *
 * Static files are served by Vercel itself; this handles only the proxy.
 */

export const config = { runtime: 'edge' };

const ALLOWED = new Set([
  'data.sec.gov',
  'www.sec.gov',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The SEC rejects requests whose User-Agent does not look like contact details -
// a normal browser UA gets a flat 403. Put your own name and email here.
const SEC_UA = 'Earnings Screener contact@example.com';

// Cached per isolate. Each cold isolate pays one cheap handshake; a stale crumb
// comes back as 401 and is rebuilt on the spot.
let session = null;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Yahoo's analyst-estimate endpoint answers 401 without a session cookie plus a
 * matching crumb token. Price and chart data need neither.
 */
async function newSession() {
  // Expected to 404 — requested only for the Set-Cookie it returns.
  const seed = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });

  let cookie = '';
  if (typeof seed.headers.getSetCookie === 'function') {
    cookie = seed.headers.getSetCookie().map(c => c.split(';')[0].trim()).join('; ');
  } else {
    const raw = seed.headers.get('set-cookie') || '';
    cookie = raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/)
                .map(c => c.split(';')[0].trim())
                .filter(Boolean)
                .join('; ');
  }
  if (!cookie) return null;

  const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie },
  });
  const crumb = (await res.text()).trim();
  if (!crumb || crumb.length > 64 || crumb.includes('<')) return null;
  return { cookie, crumb };
}

function withCrumb(url, crumb) {
  if (/[?&]crumb=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(crumb);
}

async function fetchEstimates(target) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session) session = await newSession();
    if (!session) break;

    const res = await fetch(withCrumb(target, session.crumb), {
      headers: { 'User-Agent': UA, 'Cookie': session.cookie, 'Accept': 'application/json' },
    });
    if (res.ok) return res;
    session = null;              // almost always a stale crumb; rebuild and retry once
  }
  return null;
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
      },
    });
  }

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return json({ error: 'missing url parameter' }, 400);

  let host;
  try {
    host = new URL(target).hostname;
  } catch {
    return json({ error: 'malformed url' }, 400);
  }
  if (!ALLOWED.has(host)) return json({ error: 'host not allowed: ' + host }, 403);

  try {
    let upstream;
    if (target.includes('quoteSummary')) {
      upstream = await fetchEstimates(target);
      if (!upstream) return json({ error: 'estimates unavailable' }, 502);
    } else {
      upstream = await fetch(target, {
        headers: {
          'User-Agent': host.endsWith('sec.gov') ? SEC_UA : UA,
          'Accept': 'application/json,text/plain,*/*',
        },
      });
    }

    if (!upstream.ok) return json({ error: 'upstream ' + upstream.status }, upstream.status);

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'access-control-allow-origin': '*',
        // Filings change quarterly; a short edge cache spares the upstreams
        // without ever showing a stale quarter.
        'cache-control': 'public, max-age=900',
      },
    });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}
