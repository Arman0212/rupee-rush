// Optional sounds, synthesised with WebAudio (no files). Muted by default.
import { storage } from './dom.js';

const KEY = 'rr:sound';

export function createSound(toggleButton) {
  let enabled = storage.get(KEY) === 'on';
  let ctx = null;

  const audio = () => {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };

  function tone(freq, { at = 0, duration = 0.12, type = 'sine', volume = 0.15 } = {}) {
    const ac = audio();
    if (!ac) return;
    const start = ac.currentTime + at;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + duration);
  }

  const sounds = {
    dice: () => [0, 0.07, 0.15].forEach((at, i) => tone(180 + i * 40, { at, duration: 0.05, type: 'square', volume: 0.06 })),
    cash: () => { tone(880, { duration: 0.1 }); tone(1320, { at: 0.08, duration: 0.16 }); },
    bid: () => { tone(660, { duration: 0.07, type: 'triangle' }); tone(990, { at: 0.06, duration: 0.09, type: 'triangle' }); },
    trade: () => { tone(523, { duration: 0.12 }); tone(659, { at: 0.1, duration: 0.12 }); tone(784, { at: 0.2, duration: 0.2 }); },
    jail: () => { tone(160, { duration: 0.35, type: 'sawtooth', volume: 0.08 }); tone(120, { at: 0.18, duration: 0.4, type: 'sawtooth', volume: 0.08 }); },
  };

  function paint() {
    toggleButton.setAttribute('aria-pressed', String(enabled));
    toggleButton.setAttribute('aria-label', enabled ? 'Sound on' : 'Sound off');
    toggleButton.title = enabled ? 'Sound on (click to mute)' : 'Sound off (click to unmute)';
    toggleButton.firstElementChild.textContent = enabled ? '🔊' : '🔇';
  }

  toggleButton.addEventListener('click', () => {
    enabled = !enabled;
    storage.set(KEY, enabled ? 'on' : 'off');
    paint();
    if (enabled) sounds.cash();
  });
  paint();

  return { play: (name) => { if (enabled && sounds[name]) sounds[name](); } };
}
