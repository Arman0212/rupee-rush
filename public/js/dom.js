// Tiny DOM helpers. Text always goes in through textContent, never innerHTML.

/**
 * el('button', { className: 'btn', text: 'Go', attrs: { 'aria-label': 'Go' }, on: { click } }, child, …)
 * Strings among the children become text nodes.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  const { className, text, attrs, dataset, on, style, ...rest } = props;
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  if (dataset) Object.assign(node.dataset, dataset);
  if (style) for (const [k, v] of Object.entries(style)) node.style.setProperty(k, v);
  if (on) for (const [event, fn] of Object.entries(on)) node.addEventListener(event, fn);
  Object.assign(node, rest);
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replace a node's children in one go. */
export function render(node, ...children) {
  clear(node);
  for (const child of children.flat()) if (child) node.append(child);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
export const prefersReducedMotion = () => reduceMotionQuery.matches;

/** Safe localStorage: private windows and blocked storage must never break the app. */
export const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};
