const DEFAULT_POLL_MINUTES = 1;
let lastNotified = [];

function normalizeNotificationList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value].filter(Boolean);
}

function isAlreadyNotified(uid) {
  return lastNotified.includes(uid);
}

function markNotified(uid) {
  if (!uid || isAlreadyNotified(uid)) return;
  lastNotified.push(uid);
  chrome.storage.local.set({ lastNotified: lastNotified });
}

function removeNotification(uid) {
  if (!uid) return;
  lastNotified = lastNotified.filter((v) => v !== uid);
  chrome.storage.local.set({ lastNotified: lastNotified });
}

function clearNotificationCache() {
  lastNotified = [];
  chrome.storage.local.set({ lastNotified: [] });
}

// restore lastNotified from storage so we don't re-notify the same event repeatedly across restarts
chrome.storage.local.get(['lastNotified'], (res) => { if (res && res.lastNotified) lastNotified = normalizeNotificationList(res.lastNotified); });

chrome.runtime.onInstalled.addListener((details) => {
  if (details && (details.reason === 'install' || details.reason === 'update')) {
    clearNotificationCache();
  }

  chrome.storage.local.get(["icalUrl", "pollMinutes"], (res) => {
    if (!res.pollMinutes) chrome.storage.local.set({ pollMinutes: DEFAULT_POLL_MINUTES });
    if (!res.icalUrl) chrome.storage.local.set({ icalUrl: "" });
    // Always poll every 1 minute so events are never missed due to alarm timing.
    // pollMinutes only controls the notification window, not the check frequency.
    chrome.alarms.create("poll", { periodInMinutes: 1 });
  });
});

chrome.storage.local.get(['lastNotified'], (res) => {
  lastNotified = normalizeNotificationList(res.lastNotified);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll") checkCalendar();
});

// Open local config UI when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL('options.html');
  chrome.tabs.create({ url });
});

function isMeetUrl(url) {
  if (!url) return false;
  return /^https:\/\/meet\.google\.com\//i.test(url);
}

async function checkCalendar() {
  const { icalUrl, pollMinutes, meetOnly } = await getStorage(["icalUrl", "pollMinutes", "meetOnly"]);
  console.debug('checkCalendar running', { icalUrl, pollMinutes, meetOnly, now: new Date().toString() });
  // Always try Google Calendar API first (token must be available via dynamic OAuth)
  try {
    const events = await fetchGoogleCalendarEvents();
    handleEventsFromApi(events, pollMinutes || DEFAULT_POLL_MINUTES, meetOnly);
    return;
  } catch (e) {
    console.warn('Google API failed or no token, falling back to iCal:', e);
  }
  if (!icalUrl) return;

  try {
    const res = await fetch(icalUrl);
    if (!res.ok) return;
    const text = await res.text();
    const events = parseICSEvents(text);
    const now = new Date();
    const pending = [];

    for (const ev of events) {
      const start = ev.start;
      const msUntil = start - now;
      console.debug('ICS event', { uid: ev.uid, summary: ev.summary, start: start.toString(), msUntil });
      if (msUntil <= (pollMinutes || DEFAULT_POLL_MINUTES) * 60 * 1000 && msUntil >= -60 * 1000) {
        if (meetOnly && !isMeetUrl(ev.link)) {
          continue;
        }
        if (!isAlreadyNotified(ev.uid)) {
          pending.push({ uid: ev.uid, start, summary: ev.summary, link: ev.link });
        }
      }
    }
    if (pending.length) {
      for (const item of pending) markNotified(item.uid);
      triggerIncoming(pending);
    }
  } catch (e) {
    console.error("Failed to fetch/parse ical", e);
  }
}

function handleEventsFromApi(items, pollMinutes, meetOnly) {
  const now = new Date();
  const pending = [];
  for (const it of items) {
    const start = new Date(it.start.dateTime || it.start.date);
    const msUntil = start - now;
    console.debug('API event', { id: it.id, summary: it.summary, start: start.toString(), msUntil });
    const uid = it.id || (it.htmlLink || it.summary);
    if (msUntil <= (pollMinutes || DEFAULT_POLL_MINUTES) * 60 * 1000 && msUntil >= -60 * 1000) {
      const link = (it.hangoutLink || (it.conferenceData && it.conferenceData.entryPoints && it.conferenceData.entryPoints[0] && it.conferenceData.entryPoints[0].uri) || it.htmlLink);
      if (meetOnly && !isMeetUrl(link)) {
        continue;
      }
      if (!isAlreadyNotified(uid)) {
        pending.push({ uid, start, summary: it.summary || '(No title)', link });
      }
    }
  }
  if (pending.length) {
    for (const item of pending) markNotified(item.uid);
    triggerIncoming(pending);
  }
}

function fetchGoogleCalendarEvents() {
  return new Promise(async (resolve, reject) => {
    try {
      let clientId = '';
      try {
        const serverBase = 'http://localhost:4200';
        const conf = await fetch(`${serverBase}/auth/config`);
        if (conf.ok) {
          const cj = await conf.json();
          if (cj && cj.clientId) clientId = cj.clientId;
        }
      } catch (e) {
        console.warn('Server config fetch failed', e);
      }

      if (!clientId) {
        const s = await getStorage(['clientId']);
        clientId = s.clientId || '';
      }

      let token = null;
      if (clientId) {
        try {
          const serverBase = 'http://localhost:4200';
          const resp = await fetch(`${serverBase}/auth/token?clientId=${encodeURIComponent(clientId)}`);
          if (resp.ok) {
            const j = await resp.json();
            if (j && j.ok && j.token && j.token.access_token) token = j.token.access_token;
          }
        } catch (e) {
          console.warn('Failed to get token from server', e);
        }
      }

      if (!token) {
        // fallback to chrome.identity only if manifest oauth2.client_id is set
        const manifestClient = (chrome.runtime.getManifest && chrome.runtime.getManifest().oauth2 && chrome.runtime.getManifest().oauth2.client_id) || '';
        if (!manifestClient || manifestClient.includes('REPLACE_WITH')) {
          return reject(new Error('No valid oauth2.client_id in manifest and no server token available'));
        }

        token = await new Promise((res, rej) => {
          chrome.identity.getAuthToken({ interactive: false }, (t) => {
            if (chrome.runtime.lastError || !t) {
              chrome.identity.getAuthToken({ interactive: true }, (freshToken) => {
                if (chrome.runtime.lastError || !freshToken) return rej(chrome.runtime.lastError || new Error('No token'));
                res(freshToken);
              });
              return;
            }
            res(t);
          });
        });
      }

      const now = new Date();
      const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1).toISOString();
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return reject(new Error('Google Calendar API error: ' + res.status));
      const j = await res.json();
      resolve(j.items || []);
    } catch (e) {
      reject(e);
    }
  });
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

function triggerIncoming(eventOrList) {
  const list = Array.isArray(eventOrList) ? eventOrList : [eventOrList];
  const safeList = list.filter(Boolean).map((event) => ({
    uid: event.uid || `${event.summary || 'event'}-${Date.now()}-${Math.random()}`,
    title: event.summary || event.title || 'Incoming meeting',
    url: event.link || event.url || '',
    start: event.start ? ((event.start instanceof Date) ? event.start.toISOString() : String(event.start)) : ''
  }));

  if (!safeList.length) return;

  chrome.storage.local.get(['ringtoneUrl'], async (store) => {
    const ringtoneUrl = normalizeDriveAudioUrl(store.ringtoneUrl || '');
    console.debug('triggerIncoming ringtone', { hasUrl: !!ringtoneUrl, startsWithData: ringtoneUrl.startsWith('data:audio/') });
    try {
      await ensureOffscreen();
      chrome.runtime.sendMessage({ type: 'play-audio', ringtoneUrl, loop: true });
    } catch (e) {
      console.warn('Unable to play ringtone', e);
    }
  });

  const features = { type: "popup", width: 460, height: 340 };
  const payload = encodeURIComponent(JSON.stringify(safeList));
  chrome.windows.create({ url: `popup.html?events=${payload}` , width: features.width, height: features.height, focused: true, type: features.type }, () => {});
}

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
    const summary = summaryMatch ? decodeICSEscapes(summaryMatch[1].trim()) : "(No title)";

    const descMatch = v.match(/DESCRIPTION:(.+)/s);
    const desc = descMatch ? decodeICSEscapes(descMatch[1].trim()) : "";

    // try location too
    const locMatch = v.match(/LOCATION:(.+)/);
    const location = locMatch ? decodeICSEscapes(locMatch[1].trim()) : "";

    const link = findMeetingLink(v) || findMeetingLink(desc) || findMeetingLink(location) || null;

    events.push({ uid, start: dt, summary, desc, location, link });
  }
  return events;
}

function decodeICSEscapes(s) {
  return s.replace(/\\n/g, "\n").replace(/\,/, ",");
}

function findMeetingLink(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function parseICSTime(s) {
  // Examples: 20260826T153000Z or 20260826T153000
  const z = s.endsWith("Z");
  const clean = s.replace(/\s+/g, "");
  const parts = clean.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!parts) return new Date(clean);
  const [_, Y, M, D, h, m, sec] = parts;
  const iso = `${Y}-${M}-${D}T${h}:${m}:${sec}${z ? 'Z' : ''}`;
  return new Date(iso);
}

function ensureOffscreen() {
  // chrome.offscreen.hasDocument() returns a Promise<boolean> so await it.
  return (async () => {
    try {
      const has = await chrome.offscreen.hasDocument();
      if (has) return;
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: "Reproducir timbre de llamada localmente"
      });
    } catch (e) {
      // In some environments offscreen may not be available; rethrow to let caller handle.
      console.error('ensureOffscreen error', e);
      throw e;
    }
  })();
}

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

// message handling: stop audio when popup signals
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'stop-audio') {
    if (sender && sender.tab) {
      chrome.runtime.sendMessage({ type: 'stop-audio' });
    }
    return true;
  }
  if (msg?.type === 'dismiss-event') {
    const uid = msg.uid;
    // Removed removeNotification(uid) so that rejected events stay in lastNotified and don't pop up again
    sendResponse({ ok: true, uid });
    return true;
  }
  if (msg?.type === 'simulate-incoming') {
    try {
      const ev = msg.event || { uid: 'sim-' + Date.now(), summary: 'Llamada de prueba', link: '' };
      // ensure we set a uid and start if missing
      if (!ev.uid) ev.uid = 'sim-' + Date.now();
      triggerIncoming(ev);
      sendResponse({ ok: true });
    } catch (e) {
      console.error('simulate-incoming failed', e);
      sendResponse({ ok: false, error: e && e.message });
    }
    return true;
  }
});

// Notify when configuration changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // If pollMinutes changes, update the alarm period and re-evaluate all events
  // from scratch with the new threshold (clear cache so nothing is silently skipped).
  if (changes.pollMinutes) {
    // Do NOT change the alarm period — always poll every 1 minute.
    // pollMinutes only controls the notification window size.
    clearNotificationCache();  // ← events may now be within the new window; allow re-notification
    checkCalendar();
  }
  if (!changes.icalUrl && !changes.pollMinutes) return;
  const title = 'MeetCaller';
  const message = 'Configuración guardada';
  const opt = {
    type: 'basic',
    title,
    message,
    iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIW2NgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII='
  };
  if (chrome.notifications && chrome.notifications.create) chrome.notifications.create(opt, () => {});
});

// Ensure alarm exists on startup (e.g. after reload)
chrome.runtime.onStartup.addListener(async () => {
  clearNotificationCache();
  // Always poll every 1 minute regardless of pollMinutes.
  try { chrome.alarms.create('poll', { periodInMinutes: 1 }); } catch (e) { console.warn('Failed to create alarm on startup', e); }
});

// Run an initial calendar check when the service worker starts (helpful during development/reload)
checkCalendar();

