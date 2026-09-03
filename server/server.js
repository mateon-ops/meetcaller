const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
// Load .env configuration (CLIENT_ID and CLIENT_SECRET) from server directory
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const port = 4200;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');

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

// Helper to read/write tokens storage
function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE)); } catch (e) { return {}; }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// If CLIENT_ID and CLIENT_SECRET are provided via .env, store them securely
try {
  const envClient = process.env.CLIENT_ID;
  const envSecret = process.env.CLIENT_SECRET;
  if (envClient && envSecret) {
    const tokens = loadTokens();
    tokens[envClient] = tokens[envClient] || {};
    tokens[envClient].client_secret = envSecret;
    saveTokens(tokens);
    console.log('Loaded client_secret for CLIENT_ID from .env');
  }
} catch (e) {
  console.warn('Failed to load CLIENT_SECRET from .env', e);
}

// Exchange authorization code for tokens (expects PKCE flow)
app.post('/auth/exchange', async (req, res) => {
  try {
    const { clientId, code, redirectUri, codeVerifier } = req.body || {};
    if (!clientId || !code || !redirectUri || !codeVerifier) return res.status(400).json({ error: 'missing params' });

    const tokens = loadTokens();
    const existing = tokens[clientId] || {};
    const clientSecret = req.body.clientSecret || existing.client_secret;

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('client_id', clientId);
    if (clientSecret) params.append('client_secret', clientSecret);
    params.append('redirect_uri', redirectUri);
    params.append('code_verifier', codeVerifier);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return res.status(400).json({ error: tokenJson });

    // store refresh_token and client_secret if present
    tokens[clientId] = tokens[clientId] || {};
    if (tokenJson.refresh_token) tokens[clientId].refresh_token = tokenJson.refresh_token;
    if (clientSecret) tokens[clientId].client_secret = clientSecret;
    tokens[clientId].last = Date.now();
    saveTokens(tokens);

    res.json({ ok: true, result: tokenJson });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Return an access token using stored refresh_token
app.get('/auth/token', async (req, res) => {
  try {
    const clientId = req.query.clientId;
    if (!clientId) return res.status(400).json({ error: 'missing clientId' });
    const tokens = loadTokens();
    const entry = tokens[clientId];
    if (!entry || !entry.refresh_token) return res.status(404).json({ error: 'no refresh_token for clientId' });

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', clientId);
    if (entry.client_secret) params.append('client_secret', entry.client_secret);
    params.append('refresh_token', entry.refresh_token);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return res.status(400).json({ error: tokenJson });

    res.json({ ok: true, token: tokenJson });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check status for a clientId (whether refresh_token exists)
app.get('/auth/status', (req, res) => {
  const clientId = req.query.clientId;
  if (!clientId) return res.status(400).json({ error: 'missing clientId' });
  const tokens = loadTokens();
  const entry = tokens[clientId];
  res.json({ ok: true, hasRefresh: !!(entry && entry.refresh_token) });
});

// Return configured clientId from .env or stored tokens (first one)
app.get('/auth/config', (req, res) => {
  try {
    // prefer explicit env CLIENT_ID
    const envClient = process.env.CLIENT_ID;
    if (envClient) return res.json({ ok: true, clientId: envClient });
    const tokens = loadTokens();
    const keys = Object.keys(tokens || {});
    if (keys.length) return res.json({ ok: true, clientId: keys[0] });
    res.json({ ok: true, clientId: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Revoke and remove stored refresh_token for clientId
app.post('/auth/revoke', async (req, res) => {
  try {
    const { clientId } = req.body || {};
    if (!clientId) return res.status(400).json({ error: 'missing clientId' });
    const tokens = loadTokens();
    const entry = tokens[clientId];
    if (entry && entry.refresh_token) {
      try {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(entry.refresh_token), { method: 'POST' });
      } catch (e) {
        // ignore
      }
    }
    delete tokens[clientId];
    saveTokens(tokens);
    res.json({ ok: true });
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
