let audioCtx = null;
let gainNode = null;
let remoteAudio = null;
let isLooping = false;
let ringPatternTimer = null;
let oscillator = null;
let oscillatorGain = null;
let keepalivePort = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'play-audio') playTone(msg.ringtoneUrl || '', { loop: msg.loop !== false });
  if (msg.type === 'stop-audio') stopTone();
});

function keepServiceWorkerAlive(active) {
  if (active) {
    if (keepalivePort) return;
    try {
      keepalivePort = chrome.runtime.connect({ name: 'ringtone-keepalive' });
      keepalivePort.onDisconnect.addListener(() => {
        keepalivePort = null;
      });
    } catch (e) {}
    return;
  }
  if (!keepalivePort) return;
  try {
    keepalivePort.disconnect();
  } catch (e) {}
  keepalivePort = null;
}

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    audioCtx = new AudioCtx();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(audioCtx.destination);
  }
  return audioCtx;
}

function playTone(ringtoneUrl = '', { loop = true } = {}) {
  stopTone();
  keepServiceWorkerAlive(true);

  if (ringtoneUrl) {
    const audio = new Audio(ringtoneUrl);
    remoteAudio = audio;
    audio.preload = 'auto';
    audio.volume = 1;
    audio.loop = !!loop;
    audio.muted = false;
    audio.addEventListener('ended', () => {
      if (!isLooping || remoteAudio !== audio) return;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    });
    isLooping = true;
    audio.play().catch((err) => {
      console.warn('Audio play() rejected for ringtone', err);
      setTimeout(() => {
        if (!isLooping || remoteAudio !== audio) return;
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }, 500);
    });
    return;
  }

  const ctx = ensureAudioContext();
  if (!ctx || !gainNode) return;

  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }

  isLooping = true;
  oscillator = ctx.createOscillator();
  oscillatorGain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = 880;
  oscillatorGain.gain.value = 0;
  oscillatorGain.connect(ctx.destination);
  oscillator.connect(oscillatorGain);
  oscillator.start();

  const now = ctx.currentTime;
  oscillatorGain.gain.setValueAtTime(0.0001, now);
  oscillatorGain.gain.linearRampToValueAtTime(0.12, now + 0.06);

  const ringPattern = () => {
    if (!isLooping || !oscillator) return;
    const nextFreq = oscillator.frequency.value === 880 ? 640 : 880;
    oscillator.frequency.linearRampToValueAtTime(nextFreq, ctx.currentTime + 0.45);
    ringPatternTimer = setTimeout(ringPattern, 900);
  };

  ringPatternTimer = setTimeout(ringPattern, 900);
}

function stopTone() {
  isLooping = false;
  keepServiceWorkerAlive(false);

  if (ringPatternTimer) {
    clearTimeout(ringPatternTimer);
    ringPatternTimer = null;
  }

  if (remoteAudio) {
    const audio = remoteAudio;
    remoteAudio = null;
    audio.loop = false;
    audio.onended = null;
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute('src');
      audio.src = '';
      audio.load();
    } catch (e) {}
  }

  if (oscillator) {
    try {
      oscillator.stop();
    } catch (e) {}
    oscillator = null;
  }

  if (oscillatorGain) {
    try {
      oscillatorGain.gain.setValueAtTime(0, audioCtx ? audioCtx.currentTime : 0);
    } catch (e) {}
    oscillatorGain = null;
  }

  if (gainNode) {
    gainNode.gain.value = 0;
  }
}

window.addEventListener('beforeunload', () => stopTone());
window.addEventListener('message', (e) => {
  if (e.data === 'play') playTone(e.data.ringtoneUrl || '', { loop: e.data.loop !== false });
  if (e.data === 'stop') stopTone();
});
