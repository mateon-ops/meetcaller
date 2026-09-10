importScripts('google-auth.js');

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
    // If the iCal URL points to calendar.google.com, try using the Calendar API
    let events = [];
    let usedApi = false;
    try {
      const u = new URL(icalUrl);
      if (u.hostname.includes('calendar.google.com')) {
        const m = u.pathname.match(/\/calendar\/ical\/([^/]+)\//);
        if (m && m[1]) {
          const calendarId = decodeURIComponent(m[1]);
          try {
            const items = await fetchGoogleEventsForCalendarId(calendarId);
            // map API items to the same shape used by parseICSEvents
            events = (items || []).map(it => ({ uid: it.id, start: new Date(it.start.dateTime || it.start.date), summary: it.summary || '(No title)', desc: it.description || '', location: it.location || '', link: it.hangoutLink || (it.conferenceData && it.conferenceData.entryPoints && it.conferenceData.entryPoints[0] && it.conferenceData.entryPoints[0].uri) || it.htmlLink || '' }));
            usedApi = true;
          } catch (e) {
            console.warn('Calendar API fetch for calendarId failed, falling back to iCal fetch', e);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to parse icalUrl, will try raw fetch', e);
    }

    if (!usedApi) {
      const res = await fetch(icalUrl);
      if (!res.ok) return;
      const text = await res.text();
      const parsed = parseICSEvents(text);
      events = parsed;
    }
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
      // Use the extension's token handling which prefers stored refresh tokens,
      // then server fallback, then chrome.identity.
      const token = await getGoogleAccessToken({ interactive: false });

      const now = new Date();
      const timeMin = now.toISOString();
      const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=100`, { headers: { Authorization: `Bearer ${token}` } });
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

// Keep the service worker alive while the offscreen ringtone is playing.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ringtone-keepalive') return;
});

// Relay stop-audio so the offscreen document always receives it, even after the
// service worker was idle (~30s) and the popup is about to close.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'stop-audio') {
    if (!msg.forwarded) {
      chrome.runtime.sendMessage({ type: 'stop-audio', forwarded: true }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
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

