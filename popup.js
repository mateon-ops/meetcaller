function params() {
  const s = location.search.substring(1);
  return Object.fromEntries(new URLSearchParams(s));
}

const p = params();
const eventsContainer = document.getElementById('eventsContainer');

const events = (() => {
  const raw = p.events || '[]';
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
})();

function renderEventCard(event, index) {
  const card = document.createElement('div');
  card.className = 'call-card';
  const title = document.createElement('div');
  title.className = 'call-title';
  title.textContent = event.title || 'Incoming meeting';

  const time = document.createElement('div');
  time.className = 'call-time';
  try {
    const dt = new Date(event.start);
    time.textContent = isNaN(dt) ? 'Sin horario' : dt.toLocaleString();
  } catch (e) {
    time.textContent = 'Sin horario';
  }

  const linkWrap = document.createElement('div');
  linkWrap.className = 'call-link';
  if (event.url) {
    const a = document.createElement('a');
    a.href = event.url;
    a.textContent = event.url;
    a.target = '_blank';
    linkWrap.appendChild(a);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';

  const stopAudioAndClose = () => {
    chrome.runtime.sendMessage({ type: 'stop-audio' });
    window.close();
  };

  const resolveCard = () => {
    card.remove();
    if (!eventsContainer.children.length) {
      stopAudioAndClose();
    }
  };

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'btn-accept';
  acceptBtn.textContent = 'Atender';
  acceptBtn.addEventListener('click', () => {
    if (event.url) chrome.tabs.create({ url: event.url });
    resolveCard();
  });

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn-reject';
  rejectBtn.textContent = 'Rechazar';
  rejectBtn.addEventListener('click', () => {
    if (event.uid) chrome.runtime.sendMessage({ type: 'dismiss-event', uid: event.uid });
    resolveCard();
  });

  window.addEventListener('beforeunload', () => {
    chrome.runtime.sendMessage({ type: 'stop-audio' });
  });

  actions.appendChild(acceptBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(title);
  card.appendChild(time);
  card.appendChild(linkWrap);
  card.appendChild(actions);
  return card;
}

if (!events.length) {
  const fallback = document.createElement('div');
  fallback.className = 'call-title';
  fallback.textContent = 'Incoming meeting';
  eventsContainer.appendChild(fallback);
} else {
  for (let i = 0; i < events.length; i++) {
    eventsContainer.appendChild(renderEventCard(events[i], i));
  }
}
