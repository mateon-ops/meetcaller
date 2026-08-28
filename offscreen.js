let audioCtx = null;
let gainNode = null;
let remoteAudio = null;
let isLooping = false;
let ringPatternTimer = null;
let oscillator = null;
let oscillatorGain = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'play-audio') playTone(msg.ringtoneUrl || '', { loop: msg.loop !== false });
  if (msg.type === 'stop-audio') stopTone();
});

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

  if (ringtoneUrl) {
    remoteAudio = new Audio(ringtoneUrl);
    remoteAudio.preload = 'auto';
    remoteAudio.volume = 1;
    remoteAudio.loop = !!loop;
    remoteAudio.muted = false;
    remoteAudio.addEventListener('ended', () => {
      if (!isLooping || !remoteAudio) return;
      remoteAudio.currentTime = 0;
      remoteAudio.play().catch(() => {});
    });
    isLooping = true;
    remoteAudio.play().catch((err) => {
      console.warn('Audio play() rejected for ringtone', err);
      setTimeout(() => {
        if (!remoteAudio) return;
        remoteAudio.currentTime = 0;
        remoteAudio.play().catch(() => {});
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

  if (ringPatternTimer) {
    clearTimeout(ringPatternTimer);
    ringPatternTimer = null;
  }

  if (remoteAudio) {
    remoteAudio.pause();
    remoteAudio.currentTime = 0;
    remoteAudio = null;
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
