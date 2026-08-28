async function loadConfig() {
  try {
    const r = await fetch('/config.json');
    const j = await r.json();
    document.getElementById('icalUrl').value = j.icalUrl || '';
    document.getElementById('pollMinutes').value = j.pollMinutes || 1;
  } catch (e) {
    console.error(e);
  }
}

async function saveConfig() {
  const icalUrl = document.getElementById('icalUrl').value.trim();
  const pollMinutes = Number(document.getElementById('pollMinutes').value) || 1;
  await fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ icalUrl, pollMinutes }) });
  alert('Guardado');
}

async function showEvents() {
  const out = document.getElementById('events');
  out.innerHTML = 'Cargando...';
  try {
    const r = await fetch('/events');
    const j = await r.json();
    if (j.error) { out.innerHTML = '<b>Error:</b> ' + j.error; return; }
    if (!j.events || !j.events.length) { out.innerHTML = 'No hay eventos.'; return; }
    out.innerHTML = '';
    for (const e of j.events) {
      const div = document.createElement('div');
      div.className = 'event';
      div.innerHTML = `<div><strong>${e.summary}</strong> — ${new Date(e.start).toLocaleString()}</div>${e.link ? `<div><a href="${e.link}" target="_blank">${e.link}</a></div>` : ''}`;
      out.appendChild(div);
    }
  } catch (e) {
    out.innerHTML = 'Error: ' + e.message;
  }
}

document.getElementById('save').addEventListener('click', saveConfig);
document.getElementById('test').addEventListener('click', showEvents);

loadConfig();
