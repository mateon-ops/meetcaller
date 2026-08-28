function parseICSEvents(icsText) {
  const events = [];
  const vevents = icsText.split(/BEGIN:VEVENT/).slice(1);
  for (const v of vevents) {
    const uidMatch = v.match(/UID:(.+)/);
    const uid = uidMatch ? uidMatch[1].trim() : Math.random().toString(36).slice(2);
    const dtMatch = v.match(/DTSTART(?:;TZID=[^:]+)?:([^\r\n]+)/);
    if (!dtMatch) continue;
    const dt = parseICSTime(dtMatch[1].trim());
    const summaryMatch = v.match(/SUMMARY:(.+)/);
    const summary = summaryMatch ? summaryMatch[1].trim() : '(No title)';
    const descMatch = v.match(/DESCRIPTION:(.+)/s);
    const desc = descMatch ? descMatch[1].trim() : '';
    const locMatch = v.match(/LOCATION:(.+)/);
    const location = locMatch ? locMatch[1].trim() : '';
    const link = findMeetingLink(v) || findMeetingLink(desc) || findMeetingLink(location) || null;
    events.push({ uid, start: dt.toISOString(), summary, desc, location, link });
  }
  return events;
}

function findMeetingLink(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function isMeetUrl(url) {
  if (!url) return false;
  return /^https:\/\/meet\.google\.com\//i.test(url);
}

function parseICSTime(s) {
  const z = s.endsWith('Z');
  const clean = s.replace(/\s+/g, '');
  const parts = clean.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!parts) return new Date(clean);
  const [_, Y, M, D, h, m, sec] = parts;
  const iso = `${Y}-${M}-${D}T${h}:${m}:${sec}${z ? 'Z' : ''}`;
  return new Date(iso);
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
  const cfg = await new Promise((res) => chrome.storage.local.get(['icalUrl', 'pollMinutes', 'clientId', 'ringtoneUrl', 'meetOnly'], res));
  document.getElementById('icalUrl').value = cfg.icalUrl || '';
  document.getElementById('pollMinutes').value = cfg.pollMinutes || 1;
  document.getElementById('clientId').value = cfg.clientId || '';
  document.getElementById('meetOnly').checked = !!cfg.meetOnly;
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
  const icalUrl = document.getElementById('icalUrl').value.trim();
  const pollMinutes = Number(document.getElementById('pollMinutes').value) || 1;
  const clientId = document.getElementById('clientId').value.trim();
  const meetOnly = document.getElementById('meetOnly').checked;
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

  await chrome.storage.local.set({ icalUrl, pollMinutes, clientId, ringtoneUrl, meetOnly });
  if (fileInput) fileInput.value = '';
  if (!silent) {
    alert('Guardado en la extensión');
  }
}

async function updateAuthStatus() {
  const s = await new Promise((res) => chrome.storage.local.get(['accessToken', 'tokenExpiry'], res));
  const el = document.getElementById('authStatus');
  if (s && s.accessToken) {
    const exp = s.tokenExpiry ? new Date(s.tokenExpiry) : null;
    const expired = isTokenExpired(s.tokenExpiry);
    el.textContent = expired
      ? 'Token expirado. Haz clic en “Iniciar sesión con Google” para revalidar la sesión.'
      : `Conectado. Token expira: ${exp ? exp.toLocaleString() : 'desconocido'}`;
  } else {
    el.textContent = 'No conectado';
  }
}

function parseFragment(url) {
  const idx = url.indexOf('#');
  if (idx === -1) return {};
  const frag = url.substring(idx + 1);
  return Object.fromEntries(new URLSearchParams(frag));
}

function isTokenExpired(tokenExpiry) {
  if (!tokenExpiry) return true;
  return Date.now() >= Number(tokenExpiry) - 60 * 1000;
}

async function ensureGoogleToken({ interactive = false } = {}) {
  const s = await new Promise((res) => chrome.storage.local.get(['accessToken', 'tokenExpiry'], res));
  if (s.accessToken && !isTokenExpired(s.tokenExpiry)) {
    return s.accessToken;
  }

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        const message = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Token no disponible';
        if (!interactive) {
          chrome.identity.getAuthToken({ interactive: true }, (freshToken) => {
            if (chrome.runtime.lastError || !freshToken) {
              const msg = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'La sesión de Google caducó.';
              reject(new Error(msg));
              return;
            }
            const expiry = Date.now() + 55 * 60 * 1000;
            chrome.storage.local.set({ accessToken: freshToken, tokenExpiry: expiry });
            resolve(freshToken);
          });
          return;
        }
        reject(new Error(message));
        return;
      }

      const expiry = Date.now() + 55 * 60 * 1000;
      chrome.storage.local.set({ accessToken: token, tokenExpiry: expiry });
      resolve(token);
    });
  });
}

async function googleSignIn() {
  const clientId = document.getElementById('clientId').value.trim();
  if (!clientId) { alert('Pega el Client ID primero'); return; }
  await chrome.storage.local.set({ clientId });
  const redirectUri = chrome.identity.getRedirectURL('oauth2');
  const scope = encodeURIComponent('https://www.googleapis.com/auth/calendar.readonly');
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&prompt=consent`;
  chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectedTo) => {
    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message || '';
      alert('Auth failed: ' + msg);
      if (msg.toLowerCase().includes('bad client id') || msg.toLowerCase().includes('invalid client')) {
        document.getElementById('authStatus').textContent = 'Error: bad client id — revisá que el Client ID exista y que la redirect URL registrada coincida (usa "Mostrar redirect URL").';
      }
      return;
    }
    const parts = parseFragment(redirectedTo);
    if (parts.access_token) {
      const expiry = parts.expires_in ? Date.now() + Math.min(Number(parts.expires_in), 55 * 60) * 1000 : Date.now() + 55 * 60 * 1000;
      await chrome.storage.local.set({ accessToken: parts.access_token, tokenExpiry: expiry });
      updateAuthStatus();
      alert('Autenticación OK');
    } else if (parts.error) {
      const msg = parts.error_description || parts.error;
      console.error('OAuth error fragment:', parts);
      alert('OAuth error: ' + msg);
      document.getElementById('authStatus').textContent = 'Auth error: ' + msg;
    } else {
      alert('No se obtuvo access_token');
    }
  });
}

async function googleSignOut() {
  const s = await new Promise((res) => chrome.storage.local.get(['accessToken'], res));
  if (s && s.accessToken) {
    // revoke token
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${s.accessToken}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch (e) { console.warn('Revoke failed', e); }
  }
  await chrome.storage.local.remove(['accessToken', 'tokenExpiry']);
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
    let token = await ensureGoogleToken({ interactive: false });
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
    console.warn('Google API failed or no token, falling back to iCal:', e);
    // Update auth status to be clean/clear
    updateAuthStatus();
  }

  try {
    if (apiSuccess) {
      out.innerHTML = '';
      if (!apiEvents.length) {
        out.innerHTML = 'No hay eventos hoy.';
        return;
      }
      for (const e of apiEvents) {
        const start = new Date(e.start.dateTime || e.start.date || '');
        const link = e.hangoutLink || e.htmlLink || '';
        const div = document.createElement('div');
        div.className = 'event';
        div.innerHTML = `<div><strong>${e.summary || '(No title)'}</strong> — ${isNaN(start) ? 'sin hora' : start.toLocaleString()}</div>${link ? `<div><a href="${link}" target="_blank">${link}</a></div>` : ''}`;
        out.appendChild(div);
      }
      return;
    }

    // fallback to iCal (Google API did not succeed)
    const icalUrl = document.getElementById('icalUrl').value.trim();
    if (!icalUrl) {
      out.innerHTML = 'Ingresá una iCal URL válida o inicia sesión con Google.';
      return;
    }
    const r = await fetch(icalUrl);
    if (!r.ok) {
      out.innerHTML = 'No se pudo descargar el archivo .ics';
      return;
    }
    const txt = await r.text();
    const events = parseICSEvents(txt);
    if (!events.length) {
      out.innerHTML = 'No hay eventos.';
      return;
    }
    out.innerHTML = '';
    for (const e of events) {
      const div = document.createElement('div');
      div.className = 'event';
      div.innerHTML = `<div><strong>${e.summary}</strong> — ${new Date(e.start).toLocaleString()}</div>${e.link ? `<div><a href="${e.link}" target="_blank">${e.link}</a></div>` : ''}`;
      out.appendChild(div);
    }
  } catch (e) {
    out.innerHTML = 'Error: ' + e.message;
    console.error(e);
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
    const { meetOnly, icalUrl } = await new Promise((res) => chrome.storage.local.get(['meetOnly', 'icalUrl'], res));
    const now = new Date();
    let items = [];
    let apiSuccess = false;

    // 1. Try Google Calendar API
    try {
      let token = await ensureGoogleToken({ interactive: false });
      const timeMin = now.toISOString();
      const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=20`,
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
            meetUrl: e.hangoutLink || ''
          }));
        apiSuccess = true;
      }
    } catch (e) {
      console.debug('Google API token/request failed, falling back to iCal for countdown:', e);
    }

    // 2. Try iCal fallback if Google API failed
    if (!apiSuccess && icalUrl) {
      try {
        const r = await fetch(icalUrl);
        if (r.ok) {
          const txt = await r.text();
          const parsed = parseICSEvents(txt);
          items = parsed.map(e => ({
            time: new Date(e.start),
            name: e.summary || '(Sin título)',
            meetUrl: e.link || ''
          }));
        }
      } catch (e) {
        console.warn('Failed to fetch iCal for countdown:', e);
      }
    }

    // pick the soonest future event, filtering by Meet URL if meetOnly is set
    const upcoming = items
      .filter(e => {
        if (e.time <= now) return false;
        if (meetOnly && !isMeetUrl(e.meetUrl)) return false;
        return true;
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

function init() {
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
  document.getElementById('icalUrl').addEventListener('input', () => saveConfig(true));

  loadConfig();
  startCountdown();
}

document.addEventListener('DOMContentLoaded', init);

// Sync UI in real-time when storage changes elsewhere
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.icalUrl) document.getElementById('icalUrl').value = changes.icalUrl.newValue || '';
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
