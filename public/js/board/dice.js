// Two dice drawn with CSS pips. roll() tumbles briefly, then lands on the real values.
import { el, sleep, prefersReducedMotion } from '../dom.js';

const ROLL_MS = 520;
const FLICK_MS = 80;

export function createDice(host) {
  const dice = [0, 1].map(() => {
    const node = el('span', { className: 'die', dataset: { value: '1' } });
    for (let i = 0; i < 9; i++) node.append(el('span', { className: 'pip' }));
    return node;
  });
  host.append(...dice);
  host.setAttribute('role', 'img');

  function show([a, b]) {
    dice[0].dataset.value = String(a);
    dice[1].dataset.value = String(b);
    host.setAttribute('aria-label', `Dice show ${a} and ${b}`);
    host.classList.toggle('doubles', a === b);
  }

  return {
    show,
    async roll(values) {
      if (prefersReducedMotion() || document.hidden) {
        show(values);
        return;
      }
      host.classList.add('rolling');
      const end = performance.now() + ROLL_MS;
      while (performance.now() < end) {
        dice.forEach((d) => { d.dataset.value = String(1 + Math.floor(Math.random() * 6)); });
        await sleep(FLICK_MS);
      }
      host.classList.remove('rolling');
      show(values);
    },
  };
}
