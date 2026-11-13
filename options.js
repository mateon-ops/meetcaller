function isMeetUrl(url) {
  if (!url) return false;
  const value = String(url).trim();
  return /^https:\/\/meet\.google\.com\//i.test(value);
}

function normalizeDriveAudioUrl(rawUrl) {
  if (!rawUrl) return '';
  const value = rawUrl.trim();
  if (!value) return '';
  if (value.startsWith('data:audio/')) return value;

  try {
    const url = new URL(value);
    if (url.hostname.includes('drive.google.com')) {
      if (url.pathname.includes('/folders/')) {
        return '';
      }
      const fileMatch = value.match(/\/file\/d\/([^/]+)/) || value.match(/[?&]id=([^&]+)/) || value.match(/\/d\/([^/]+)/);
      if (fileMatch && fileMatch[1]) {
        return `https://drive.google.com/uc?export=download&id=${fileMatch[1]}`;
      }
    }
    return value;
  } catch (e) {
    return value;
  }
}

function readAudioFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve('');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('No se pudo leer el audio seleccionado.'));
    reader.readAsDataURL(file);
  });
}

async function ensureDefaultRingtone() {
  const { ringtoneUrl } = await new Promise((res) => chrome.storage.local.get(['ringtoneUrl'], res));
  if (ringtoneUrl && ringtoneUrl.trim()) return ringtoneUrl;

  const defaultUrl = chrome.runtime.getURL('default-ringtone.wav');
  await chrome.storage.local.set({ ringtoneUrl: defaultUrl });
  return defaultUrl;
}

async function loadConfig() {
  const cfg = await new Promise((res) => chrome.storage.local.get(['pollMinutes', 'clientId', 'ringtoneUrl', 'meetOnly'], res));
  document.getElementById('pollMinutes').value = cfg.pollMinutes || 1;
  document.getElementById('meetOnly').checked = !!cfg.meetOnly;
  document.getElementById('clientId').value = cfg.clientId || '';
  // Do NOT prefill clientSecret for safety; leave blank
  if (!cfg.ringtoneUrl || !cfg.ringtoneUrl.trim()) {
    try {
      await ensureDefaultRingtone();
    } catch (e) {
      console.warn('No se pudo inicializar el ringtone por defecto', e);
    }
  }
  updateAuthStatus();
}

async function saveConfig(silent = false) {
  const pollMinutes = Number(document.getElementById('pollMinutes').value) || 1;
  const meetOnly = document.getElementById('meetOnly').checked;
  const clientId = (document.getElementById('clientId') && document.getElementById('clientId').value) ? document.getElementById('clientId').value.trim() : '';
  const clientSecret = (document.getElementById('clientSecret') && document.getElementById('clientSecret').value) ? document.getElementById('clientSecret').value : '';
  const fileInput = document.getElementById('ringtoneFile');

  const existing = await new Promise((res) => chrome.storage.local.get(['ringtoneUrl'], res));
  let ringtoneUrl = existing.ringtoneUrl || '';

  if (fileInput && fileInput.files && fileInput.files[0]) {
    try {
      ringtoneUrl = await readAudioFileAsDataUrl(fileInput.files[0]);
    } catch (error) {
      alert(error.message || 'No se pudo leer el archivo de audio.');
      return;
    }
  }

  const storeObj = { pollMinutes, ringtoneUrl, meetOnly };
  if (clientId) storeObj.clientId = clientId;
  if (clientSecret) storeObj.clientSecret = clientSecret;
  await chrome.storage.local.set(storeObj);
  if (fileInput) fileInput.value = '';
  if (!silent) {
    alert('Guardado en la extensión');
  }
}

async function updateAuthStatus() {
  const el = document.getElementById('authStatus');
  try {
    const connected = await hasGoogleSession();
    el.textContent = connected ? 'Conectado' : 'No conectado';
    return;
  } catch (e) {
    console.warn('Error checking session', e);
    el.textContent = 'No conectado';
  }
}

function parseFragment(url) {
  const idx = url.indexOf('#');
  if (idx === -1) return {};
  const frag = url.substring(idx + 1);
  return Object.fromEntries(new URLSearchParams(frag));
}

// PKCE helpers
function base64UrlEncode(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let str = '';
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const enc = new TextEncoder();
  const data = enc.encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(hash);
}

function randomString(length = 64) {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(v => ('0' + v.toString(16)).slice(-2)).join('').slice(0, length);
}

async function ensureGoogleToken({ interactive = false } = {}) {
  const cfg = await new Promise((res) => chrome.storage.local.get(['clientId', 'clientSecret', 'accessToken', 'tokenExpiry', 'refreshToken'], res));
  const clientId = (cfg.clientId || '').trim();
  const clientSecret = cfg.clientSecret || '';
  const accessToken = cfg.accessToken || '';
  const tokenExpiry = Number(cfg.tokenExpiry || 0);
  const refreshToken = cfg.refreshToken || '';

  if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 15000) {
    return accessToken;
  }

  if (clientId && refreshToken) {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret || '',
        refresh_token: refreshToken
      });

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });

      const tokenJson = await res.json();
      if (!res.ok) {
        const detail = tokenJson.error_description || tokenJson.error || 'Refresh token failed';
        throw new Error(detail);
      }

      const expiresIn = Math.max(30, Number(tokenJson.expires_in) || 3600);
      const newAccessToken = tokenJson.access_token;
      await chrome.storage.local.set({
        accessToken: newAccessToken,
        tokenExpiry: Date.now() + expiresIn * 1000,
        clientId,
        clientSecret: clientSecret || cfg.clientSecret || ''
      });

      return newAccessToken;
    } catch (e) {
      console.warn('Google refresh token failed in UI flow:', e);
    }
  }

  if (!clientId) {
    throw new Error('No hay Client ID configurado en la UI. Ingresalo en la configuración de MeetCaller.');
  }

  throw new Error('No hay sesión de Google activa. Iniciá sesión desde la UI de MeetCaller.');
}

async function googleSignIn() {
  // Determine effective clientId (stored or manifest)
  const storedCfg = await new Promise((res) => chrome.storage.local.get(['clientId'], res));
  let clientId = storedCfg.clientId || '';
  if (!clientId) clientId = (chrome.runtime.getManifest && chrome.runtime.getManifest().oauth2 && chrome.runtime.getManifest().oauth2.client_id) || '';
  if (!clientId) { alert('No hay Client ID configurado localmente ni en el manifest'); return; }
  const redirectUri = chrome.identity.getRedirectURL('oauth2');
  const scope = encodeURIComponent('https://www.googleapis.com/auth/calendar.readonly');

  // PKCE
  const codeVerifier = randomString(64);
  const codeChallenge = await sha256(codeVerifier);

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&access_type=offline&prompt=consent&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;

  // store verifier temporarily
  await chrome.storage.local.set({ pkce_verifier: codeVerifier });

  chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectedTo) => {
    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message || '';
      alert('Auth failed: ' + msg);
      if (msg.toLowerCase().includes('bad client id') || msg.toLowerCase().includes('invalid client')) {
        document.getElementById('authStatus').textContent = 'Error: bad client id — revisá que el Client ID exista y que la redirect URL registrada coincida (usa "Mostrar redirect URL").';
      }
      return;
    }
    try {
      const urlObj = new URL(redirectedTo);
      const code = urlObj.searchParams.get('code');
      const error = urlObj.searchParams.get('error');
      if (error) {
        alert('OAuth error: ' + error);
        return;
      }
      if (!code) {
        alert('No se obtuvo authorization code');
        return;
      }

      const stored = await new Promise((res) => chrome.storage.local.get(['pkce_verifier'], res));
      const codeVerifierStored = stored.pkce_verifier;
      if (!codeVerifierStored) {
        alert('Missing PKCE verifier');
        return;
      }

      // Exchange code locally (extension) to obtain refresh_token
      try {
        await exchangeGoogleAuthCode({ clientId, code, redirectUri, codeVerifier: codeVerifierStored, clientSecret: (document.getElementById('clientSecret') && document.getElementById('clientSecret').value) || undefined });
      } catch (ex) {
        alert('Exchange failed: ' + (ex && ex.message ? ex.message : JSON.stringify(ex)));
        return;
      }

      // Clear verifier
      await chrome.storage.local.remove(['pkce_verifier']);
      // Persist clientId and clientSecret values set in the form
      const toSave = {};
      if (clientId) toSave.clientId = clientId;
      const cs = (document.getElementById('clientSecret') && document.getElementById('clientSecret').value) || '';
      if (cs) toSave.clientSecret = cs;
      if (Object.keys(toSave).length) await chrome.storage.local.set(toSave);

      updateAuthStatus();
      alert('Autenticado correctamente.');
    } catch (e) {
      console.error(e);
      alert('OAuth exchange error: ' + e.message);
    }
  });
}

async function googleSignOut() {
  try {
    await revokeGoogleSession();
  } catch (e) {
    console.warn('Revoke local session failed', e);
  }
  // Also clear clientSecret locally for safety
  await chrome.storage.local.remove(['clientSecret', 'accessToken', 'tokenExpiry', 'refreshToken']);
  updateAuthStatus();
  alert('Desconectado');
}

let eventsVisible = false;

async function showEvents() {
  const out = document.getElementById('events');
  const btn = document.getElementById('test');

  if (eventsVisible) {
    // hide
    out.style.display = 'none';
    out.innerHTML = '';
    btn.textContent = 'Ver eventos';
    eventsVisible = false;
    return;
  }

  // show and load
  out.style.display = '';
  out.innerHTML = 'Cargando...';
  btn.textContent = 'Ocultar eventos';
  eventsVisible = true;

  let apiEvents = [];
  let apiSuccess = false;

  try {
    // Always try Google API first
    const token = await ensureGoogleToken({ interactive: false });
    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1).toISOString();
    const apiRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`, { headers: { Authorization: `Bearer ${token}` } });
    if (apiRes.ok) {
      const j = await apiRes.json();
      apiEvents = j.items || [];
      apiSuccess = true;
    } else {
      console.warn('Google API returned error status:', apiRes.status);
    }
  } catch (e) {
    console.warn('Google Calendar API request failed:', e);
    // Update auth status to be clean/clear
    updateAuthStatus();
  }

  if (!apiSuccess) {
    out.innerHTML = 'No se pudieron cargar los eventos de Google Calendar. Iniciá sesión y revisá la configuración OAuth.';
    return;
  }

  if (!apiEvents.length) {
    out.innerHTML = 'No hay eventos hoy.';
    return;
  }
  out.innerHTML = '';
  const nowMs = Date.now();
  for (const e of apiEvents) {
    const start = new Date(e.start.dateTime || e.start.date || '');
    const link = e.hangoutLink || e.htmlLink || '';
    const div = document.createElement('div');
    div.className = 'event';
    if (!isNaN(start) && start.getTime() < nowMs) {
      div.style.opacity = '0.5';
    }
    div.innerHTML = `<div><strong>${e.summary || '(No title)'}</strong> — ${isNaN(start) ? 'sin hora' : start.toLocaleString()}</div>${link ? `<div><a href="${link}" target="_blank">${link}</a></div>` : ''}`;
    out.appendChild(div);
  }
}

// ---- Countdown to next meeting ----
let countdownIntervalId = null;
let nextMeetingTime = null;   // Date of the next meeting start
let nextMeetingName = '';     // Title of the next meeting

function formatCountdown(msLeft) {
  if (msLeft <= 0) return '0 seg';
  const totalSecs = Math.floor(msLeft / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function tickCountdown() {
  const valueEl = document.getElementById('countdownValue');
  const nameEl  = document.getElementById('countdownEventName');
  if (!valueEl) return;

  if (!nextMeetingTime) {
    valueEl.textContent = '—';
    if (nameEl) nameEl.textContent = '';
    return;
  }

  // Read pollMinutes live so it reflects any unsaved changes in the input
  const pollMinutes = Number(document.getElementById('pollMinutes').value) || 1;

  // background.js fires when msUntilMeeting <= pollMinutes * 60 * 1000
  // so we count down to that trigger moment: meetingStart - pollMinutes
  const alertTime = nextMeetingTime.getTime() - pollMinutes * 60 * 1000;
  const msLeft = alertTime - Date.now();

  if (nameEl) nameEl.textContent = nextMeetingName;

  if (msLeft <= 0) {
    valueEl.textContent = '¡Ahora!';
    return;
  }

  valueEl.textContent = formatCountdown(msLeft);
}

async function refreshNextMeeting() {
  try {
    const { meetOnly } = await new Promise((res) => chrome.storage.local.get(['meetOnly'], res));
    const now = new Date();
    const futureLimit = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    let items = [];

    // 1. Try Google Calendar API
    try {
      const token = await ensureGoogleToken({ interactive: false });
      const timeMin = now.toISOString();
      const timeMax = futureLimit.toISOString();
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=50`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const j = await res.json();
        const apiItems = j.items || [];
        items = apiItems
          .filter(e => e.start && (e.start.dateTime || e.start.date))
          .map(e => ({
            time: new Date(e.start.dateTime || e.start.date),
            name: e.summary || '(Sin título)',
            meetUrl: resolveGoogleEventLink(e)
          }));
      }
    } catch (e) {
      console.warn('Google Calendar API request failed while refreshing countdown:', e);
    }

    // pick the soonest future event, but when meetOnly is enabled only consider Meet events
    const upcoming = items
      .filter(e => {
        if (!(e && e.time instanceof Date) || isNaN(e.time)) return false;
        if (e.time <= now) return false;
        const meetUrl = typeof e.meetUrl === 'string' ? e.meetUrl : (e.meetUrl && e.meetUrl.then ? '' : '');
        return !meetOnly || isMeetUrl(meetUrl);
      })
      .sort((a, b) => a.time - b.time);

    if (upcoming.length) {
      nextMeetingTime = upcoming[0].time;
      nextMeetingName = upcoming[0].name;
    } else {
      nextMeetingTime = null;
      nextMeetingName = '';
    }
  } catch (e) {
    console.warn('refreshNextMeeting error', e);
  }
}

function startCountdown() {
  if (countdownIntervalId) return;
  refreshNextMeeting();
  // refresh event list every minute, tick every second
  setInterval(refreshNextMeeting, 60 * 1000);
  countdownIntervalId = setInterval(tickCountdown, 1000);
  tickCountdown();
}

function resolveGoogleEventLink(event) {
  if (!event) return '';
  return event.hangoutLink ||
    (event.conferenceData && event.conferenceData.entryPoints && event.conferenceData.entryPoints[0] && event.conferenceData.entryPoints[0].uri) ||
    event.htmlLink ||
    '';
}

async function init() {
  document.getElementById('googleSignIn').addEventListener('click', googleSignIn);
  document.getElementById('googleSignOut').addEventListener('click', googleSignOut);
  document.getElementById('save').addEventListener('click', () => saveConfig(false));
  document.getElementById('test').addEventListener('click', showEvents);
  document.getElementById('simulateCall').addEventListener('click', async () => {
    const summary = 'Llamada de prueba';
    const event = { uid: 'sim-' + Date.now(), start: new Date().toISOString(), summary, link: '' };
    let { ringtoneUrl } = await new Promise((res) => chrome.storage.local.get(['ringtoneUrl'], res));
    if (!ringtoneUrl || !ringtoneUrl.trim()) {
      ringtoneUrl = chrome.runtime.getURL('default-ringtone.mp3');
      await chrome.storage.local.set({ ringtoneUrl });
    }
    const cleanUrl = ringtoneUrl || '';

    chrome.runtime.sendMessage({ type: 'play-audio', ringtoneUrl: cleanUrl, loop: true });
    chrome.runtime.sendMessage({ type: 'simulate-incoming', event });
  });

  // Auto-save changes immediately to update the countdown in real-time
  document.getElementById('meetOnly').addEventListener('change', () => saveConfig(true));
  document.getElementById('pollMinutes').addEventListener('input', () => saveConfig(true));
  await loadConfig();
  startCountdown();
}

document.addEventListener('DOMContentLoaded', init);

// Sync UI in real-time when storage changes elsewhere
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.pollMinutes) document.getElementById('pollMinutes').value = changes.pollMinutes.newValue || 1;
  if (changes.meetOnly) document.getElementById('meetOnly').checked = !!changes.meetOnly.newValue;

  refreshNextMeeting();

  const out = document.getElementById('events');
  const notice = document.createElement('div');
  notice.style.color = 'green';
  notice.textContent = 'Configuración actualizada';
  out.insertBefore(notice, out.firstChild);
  setTimeout(() => { if (notice.parentNode) notice.parentNode.removeChild(notice); }, 1500);
});
