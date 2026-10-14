// A small set of original line icons, drawn for this game (24×24, stroke = currentColor).
// icon('copy') returns an <svg> element; decorative by default (aria-hidden).

const PATHS = {
  copy: 'M9 9h10v11H9z M5 15V4h10',
  sound: 'M4 9v6h4l5 4V5L8 9z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9v6h4l5 4V5L8 9z M17 9l5 6 M22 9l-5 6',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14 M12 17.2v.1',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4z M10 20.5a2 2 0 0 0 4 0',
  bellOff: 'M6 16V11a6 6 0 0 1 9.5-4.9 M18 11v5l2 2H8 M10 20.5a2 2 0 0 0 4 0 M3 3l18 18',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  leave: 'M14 4h5v16h-5 M10 8l-4 4 4 4 M6 12h10',
  dice: 'M5 5h14v14H5z M9 9h.01 M15 15h.01 M15 9h.01 M9 15h.01 M12 12h.01',
  buy: 'M4 11l8-6 8 6 M6 10v9h12v-9 M10 19v-5h4v5',
  skip: 'M6 6l8 6-8 6z M17 6v12',
  pass: 'M6 6l12 12 M18 6L6 18',
  end: 'M5 12h11 M12 7l5 5-5 5 M20 5v14',
  key: 'M14 10a4 4 0 1 0-3.9 4.9L11 16h2v2h2v2h3v-3l-4.1-4.1A4 4 0 0 0 14 10z',
  card: 'M7 3h10v18H7z M10 8h4 M10 12h4',
  coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9 8h6 M9 11h6 M10 8c3 0 3 5 0 5l4 4',
  palette: 'M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3.5 3H16a2 2 0 0 0-1.5 3.3A2 2 0 0 1 12 21z M7.5 11h.01 M10 7h.01 M14.5 7h.01',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  play: 'M7 5l12 7-12 7z',
  trade: 'M4 8h13l-3-3 M20 16H7l3 3',
  plus: 'M12 5v14 M5 12h14',
  kick: 'M6 6l12 12 M18 6L6 18',
  robot: 'M12 3v3 M12 3h.01 M6 6h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z M9 11h.01 M15 11h.01 M9.5 15h5 M2 11v3 M22 11v3',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 18, label } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `icon icon-${name}`);
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PATHS[name] || PATHS.help);
  svg.append(path);
  return svg;
}

/** Replace a button's icon in place (for toggles like sound and theme). */
export function setIcon(button, name) {
  const old = button.querySelector('svg.icon, [data-icon]');
  const next = icon(name);
  next.dataset.icon = name;
  if (old) old.replaceWith(next);
  else button.prepend(next);
}
