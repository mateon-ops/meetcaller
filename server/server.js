const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
const port = 4200;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.get('/config.json', (req, res) => {
  if (fs.existsSync(CONFIG_FILE)) {
    res.sendFile(CONFIG_FILE);
  } else {
    res.json({ icalUrl: '', pollMinutes: 1 });
  }
});

app.post('/config', async (req, res) => {
  const { icalUrl, pollMinutes } = req.body || {};
  const cfg = { icalUrl: icalUrl || '', pollMinutes: Number(pollMinutes) || 1 };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  res.json({ ok: true });
});

app.get('/events', async (req, res) => {
  try {
    const cfg = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE)) : { icalUrl: '' };
    if (!cfg.icalUrl) return res.status(400).json({ error: 'no icalUrl configured' });
    const r = await fetch(cfg.icalUrl);
    const txt = await r.text();
    const events = parseICSEvents(txt);
    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log(`MeetCaller config server running at http://localhost:${port}`));

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

function parseICSTime(s) {
  const z = s.endsWith('Z');
  const clean = s.replace(/\s+/g, '');
  const parts = clean.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!parts) return new Date(clean);
  const [_, Y, M, D, h, m, sec] = parts;
  const iso = `${Y}-${M}-${D}T${h}:${m}:${sec}${z ? 'Z' : ''}`;
  return new Date(iso);
}
