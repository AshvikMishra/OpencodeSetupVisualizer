/**
 * A minimal DOM/browser stub, sufficient to execute the template's inline script
 * inside node:vm and call its render*() and detail() functions.
 *
 * The template only ever does a handful of DOM things:
 *   - getElementById(...).textContent / .innerHTML / .hidden / .style
 *   - document.createElement('textarea')
 *   - document.addEventListener
 *   - querySelectorAll(...) -> iterable of stubs
 *   - window.lucide.createIcons(), matchMedia, navigator.clipboard
 */
import * as vm from 'node:vm';

class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this._html = '';
    this.textContent = '';
    this.hidden = false;
    this.style = makeStyle();
    this.classList = makeClassList();
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    this.scrollTop = 0;
    this._listeners = new Map();
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener() {}
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  select() {}
  focus() {}
  click() {}
  setSelectionRange() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  insertAdjacentHTML(_pos, html) { this._html += html; }
  dispatchEvent() {}
  contains() { return false; }
  cloneNode() { return new El(this.tagName); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
  scrollIntoView() {}
  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = v; }
}

function makeStyle() {
  return new Proxy({}, { get: () => '', set: () => true });
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    contains: c => set.has(c),
    toString: () => [...set].join(' '),
  };
}

const DOC_IDS = [
  'sections', 'filters', 'empty', 'hdrMeta', 'snapStamp', 'drawer',
  'dwBody', 'dwTitle', 'dwKind', 'dwChips', 'scrim', 'dwClose', 'toast', 'q',
  'vGrid', 'vGraph', 'btnRefresh',
];

/** Ids the template actually queries — verified against template source. */
const GLOBALS = [
  'SNAPSHOT', 'ENTITIES', 'S', 'CATS', 'SCOPE', 'STATUS',
  'detail', 'render', 'openDrawer', 'closeDrawer', 'setView',
  'renderOverview', 'renderAgents', 'renderMcps', 'renderSkills', 'renderPlugins',
  'renderProviders', 'renderContext', 'renderConfig', 'renderWarnings',
  'renderProject', 'renderGraph', 'renderCommands', 'renderAutomation',
  'tok', 'kb', 'esc', 'matches', 'statusChip',
];

export function createBrowserStub() {
  const byId = new Map();
  for (const id of DOC_IDS) byId.set(id, new El('div'));

  const body = new El('body');
  const documentStub = {
    documentElement: new El('html'),
    body,
    activeElement: null,
    listeners: new Map(),
    getElementById: id => byId.get(id) || null,
    createElement: tag => new El(tag),
    createTextNode: t => ({ textContent: t }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    removeEventListener() {},
    execCommand: () => true,
    clipboardWrites: [],
  };

  const windowStub = {
    lucide: { createIcons: () => {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    scrollTo() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };

  const navigatorStub = {
    clipboard: { writeText: async t => { documentStub.clipboardWrites.push(t); } },
    userAgent: 'node-test',
  };

  return { documentStub, windowStub, navigatorStub, byId, body };
}

/**
 * Execute an injected HTML page in a vm context and return its globals plus the
 * DOM stubs, so a test can assert on what would have been rendered.
 */
export function runTemplate(html) {
  const { documentStub, windowStub, navigatorStub, byId } = createBrowserStub();

  const m = /<script>\n([\s\S]*?)\n<\/script>/.exec(html);
  if (!m) throw new Error('could not locate the main inline script block');
  const code = m[1];

  const names = GLOBALS.join(', ');
  const factory = new vm.Script(
    `(function(){ ${code}\n; return { ${names} }; })()`,
    { filename: 'template-inline.js' }
  );

  const context = vm.createContext({
    document: documentStub,
    window: windowStub,
    navigator: navigatorStub,
    matchMedia: windowStub.matchMedia,
    lucide: windowStub.lucide,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, URL, Intl,
  });
  context.globalThis = context;

  const api = factory.runInContext(context);
  return { api, documentStub, windowStub, navigatorStub, byId };
}
