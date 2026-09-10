const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

function meetCallerStorageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function meetCallerStorageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function meetCallerStorageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function manifestOAuthClientId() {
  const id = chrome.runtime.getManifest()?.oauth2?.client_id || '';
  if (!id || id.includes('REPLACE_WITH')) return '';
  return id;
}

async function cacheServerClientId() {
  // No server-based client ID retrieval.
  return '';
}

async function resolveGoogleClientId() {
  const stored = await meetCallerStorageGet(['clientId']);
  if (stored.clientId) return stored.clientId;
  throw new Error('No hay Client ID configurado en la UI. Ingresalo en la configuración de MeetCaller.');
}

async function googleTokenRequest(fields) {
  const params = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => {
    if (value) params.append(key, value);
  });
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    const detail = tokenJson.error_description || tokenJson.error || JSON.stringify(tokenJson);
    throw new Error(detail);
  }
  return tokenJson;
}

async function persistGoogleTokens(clientId, tokenJson) {
  const expiry = Date.now() + Math.max(30, Number(tokenJson.expires_in) || 3600) * 1000;
  const patch = {
    clientId,
    accessToken: tokenJson.access_token,
    tokenExpiry: expiry
  };
  if (tokenJson.refresh_token) patch.refreshToken = tokenJson.refresh_token;
  await meetCallerStorageSet(patch);
  return tokenJson.access_token;
}

async function refreshGoogleAccessToken() {
  const { clientId, clientSecret, refreshToken } = await meetCallerStorageGet(['clientId', 'clientSecret', 'refreshToken']);
  if (!clientId || !refreshToken) return null;
  const tokenJson = await googleTokenRequest({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret || undefined,
    refresh_token: refreshToken
  });
  return persistGoogleTokens(clientId, tokenJson);
}

async function exchangeGoogleAuthCode({ clientId, code, redirectUri, codeVerifier, clientSecret }) {
  const tokenJson = await googleTokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret || undefined,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });
  const access = await persistGoogleTokens(clientId, tokenJson);
  // If a clientSecret was provided (user supplied), persist it locally for refresh calls
  if (clientSecret) {
    try { await meetCallerStorageSet({ clientSecret }); } catch (e) { /* ignore */ }
  }
  return access;
}

// server token endpoint removed — no-op kept for compatibility
// (no function exported)

function tryChromeIdentityToken(interactive) {
  return Promise.resolve(null);
}

async function getGoogleAccessToken({ interactive = false } = {}) {
  const stored = await meetCallerStorageGet(['accessToken', 'tokenExpiry', 'refreshToken', 'clientId']);
  if (stored.accessToken && stored.tokenExpiry && Date.now() < stored.tokenExpiry - 15000) {
    return stored.accessToken;
  }

  if (stored.refreshToken) {
    try {
      const refreshed = await refreshGoogleAccessToken();
      if (refreshed) return refreshed;
    } catch (e) {
      console.warn('Local Google token refresh failed', e);
    }
  }

  const clientId = stored.clientId || await resolveGoogleClientId();
  if (clientId) {
    throw new Error('No hay sesión de Google activa. Iniciá sesión desde la UI de MeetCaller.');
  }

  throw new Error('No hay sesión de Google. Abrí la configuración de MeetCaller e iniciá sesión.');
}

async function hasGoogleSession() {
  try {
    await getGoogleAccessToken({ interactive: false });
    return true;
  } catch (e) {
    return false;
  }
}

async function revokeGoogleSession() {
  const { accessToken, refreshToken, clientId } = await meetCallerStorageGet(['accessToken', 'refreshToken', 'clientId']);
  const tokenToRevoke = refreshToken || accessToken;
  if (tokenToRevoke) {
    try {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(tokenToRevoke)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } catch (e) {}
  }
  try {
    if (clientId) {
      // previously would call server to revoke stored refresh token; server removed
    }
  } catch (e) {}
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    if (!token || chrome.runtime.lastError) return;
    chrome.identity.removeCachedAuthToken({ token }, () => {});
  });
  await meetCallerStorageRemove(['accessToken', 'tokenExpiry', 'refreshToken', 'pkce_verifier']);
}

// Fetch events for a specific calendarId using the Google Calendar API.
// Returns an array of event objects (same shape as API items).
async function fetchGoogleEventsForCalendarId(calendarId, { timeMin, timeMax, maxResults } = {}) {
  if (!calendarId) throw new Error('missing calendarId');
  const token = await getGoogleAccessToken({ interactive: false });
  const now = new Date();
  const tMin = timeMin || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const tMax = timeMax || new Date(now.getFullYear(), now.getMonth(), now.getDate()+1).toISOString();
  const mr = maxResults || 250;
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(tMin)}&timeMax=${encodeURIComponent(tMax)}&singleEvents=true&orderBy=startTime&maxResults=${mr}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('Google Calendar API error: ' + res.status + ' ' + txt);
  }
  const j = await res.json();
  return j.items || [];
}
