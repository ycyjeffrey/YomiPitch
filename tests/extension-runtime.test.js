import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Minimal, self-contained DOM mock for testing content.js and popup.js in Node VM contexts.
 */
function createMockDom() {
  const elementsById = new Map();

  class MockClassList {
    constructor(el) {
      this._el = el;
    }
    _set() {
      return new Set((this._el.className || '').split(/\s+/).filter(Boolean));
    }
    _sync(set) {
      this._el.className = [...set].join(' ');
    }
    add(...names) {
      const s = this._set();
      for (const n of names) if (n) s.add(n);
      this._sync(s);
    }
    remove(...names) {
      const s = this._set();
      for (const n of names) s.delete(n);
      this._sync(s);
    }
    toggle(name, force) {
      const s = this._set();
      const shouldHave = force === undefined ? !s.has(name) : Boolean(force);
      if (shouldHave) s.add(name);
      else s.delete(name);
      this._sync(s);
      return shouldHave;
    }
    contains(name) {
      return this._set().has(name);
    }
  }

  class MockElement {
    constructor(tagName) {
      this.nodeType = 1;
      this.tagName = String(tagName).toUpperCase();
      this._id = '';
      this.className = '';
      this._textContent = '';
      this.type = '';
      this.value = '';
      this.checked = false;
      this.hidden = false;
      this.style = {};
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
      this.shadowRoot = null;
      this.listeners = new Map();
      this.classList = new MockClassList(this);
      this._rect = { left: 100, top: 100, right: 168, bottom: 128, width: 68, height: 28 };
    }

    get id() {
      return this._id;
    }
    set id(val) {
      if (this._id && elementsById.get(this._id) === this) {
        elementsById.delete(this._id);
      }
      this._id = String(val || '');
      if (this._id) {
        elementsById.set(this._id, this);
      }
    }

    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this._textContent + this.children.map((c) => c.textContent).join('');
    }
    set textContent(val) {
      this._textContent = String(val ?? '');
      this.children = [];
    }

    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === documentElement || cur === body) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    setAttribute(name, val) {
      const v = String(val);
      this.attributes.set(name, v);
      if (name === 'id') this.id = v;
      if (name === 'class') this.className = v;
      if (name.startsWith('data-')) {
        const camel = name
          .slice(5)
          .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = v;
      }
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    get firstChild() {
      return this.children[0] || null;
    }

    appendChild(child) {
      if (child.parentNode) {
        child.parentNode.children = child.parentNode.children.filter((c) => c !== child);
      }
      child.parentNode = this;
      this.children.push(child);
      if (child._id) elementsById.set(child._id, child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      if (child._id && elementsById.get(child._id) === child) {
        elementsById.delete(child._id);
      }
      return child;
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
      }
      if (this._id && elementsById.get(this._id) === this) {
        elementsById.delete(this._id);
      }
    }

    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    attachShadow() {
      const sr = new MockElement('#shadow-root');
      this.shadowRoot = sr;
      return sr;
    }

    getBoundingClientRect() {
      const width =
        Number.parseFloat(this.style.width) ||
        (this.className.includes('card') ? 320 : this._rect.width);
      const height =
        Number.parseFloat(this.style.height) ||
        (this.className.includes('card') ? 160 : this._rect.height);
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      return { left, top, right: left + width, bottom: top + height, width, height };
    }

    focus() {}
    select() {}

    closest(selector) {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        let cur = this;
        while (cur) {
          if (cur.classList?.contains(cls)) return cur;
          cur = cur.parentNode;
        }
      }
      return null;
    }

    addEventListener(type, fn, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ fn, options });
    }

    removeEventListener(type, fn) {
      if (!this.listeners.has(type)) return;
      this.listeners.set(
        type,
        this.listeners.get(type).filter((entry) => entry.fn !== fn)
      );
    }

    dispatchEvent(event) {
      const evt = {
        target: this,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
        composedPath: () => [this],
        ...event,
      };
      for (const { fn } of this.listeners.get(evt.type) || []) {
        fn(evt);
      }
      return evt;
    }

    queryAll(predicate, out = []) {
      for (const child of this.children) {
        if (predicate(child)) out.push(child);
        child.queryAll(predicate, out);
      }
      return out;
    }
  }

  const documentElement = new MockElement('html');
  const body = new MockElement('body');
  documentElement.appendChild(body);

  const docListeners = new Map();
  const winListeners = new Map();

  let selectionState = {
    text: '',
    isCollapsed: true,
    rangeCount: 0,
    rect: { left: 120, top: 200, right: 180, bottom: 224, width: 60, height: 24 },
    anchorNode: body,
  };

  const document = {
    documentElement,
    body,
    activeElement: body,
    createElement: (tag) => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    getElementById: (id) => elementsById.get(id) || null,
    addEventListener(type, fn, options) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push({ fn, options });
    },
    removeEventListener(type, fn) {
      if (!docListeners.has(type)) return;
      docListeners.set(
        type,
        docListeners.get(type).filter((entry) => entry.fn !== fn)
      );
    },
    dispatchEvent(event) {
      const evt = {
        target: body,
        preventDefault() {},
        stopPropagation() {},
        composedPath: () => [event.target || body, body, documentElement],
        ...event,
      };
      for (const { fn } of [...(docListeners.get(evt.type) || [])]) {
        fn(evt);
      }
    },
  };

  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    document,
    setTimeout,
    clearTimeout,
    getSelection: () => ({
      isCollapsed: selectionState.isCollapsed,
      rangeCount: selectionState.rangeCount,
      anchorNode: selectionState.anchorNode,
      toString: () => selectionState.text,
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ ...selectionState.rect }),
        getClientRects: () => [{ ...selectionState.rect }],
      }),
    }),
    addEventListener(type, fn, options) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push({ fn, options });
    },
    removeEventListener(type, fn) {
      if (!winListeners.has(type)) return;
      winListeners.set(
        type,
        winListeners.get(type).filter((entry) => entry.fn !== fn)
      );
    },
    dispatchEvent(event) {
      const evt = { target: window, ...event };
      for (const { fn } of [...(winListeners.get(evt.type) || [])]) {
        fn(evt);
      }
    },
  };
  window.top = window;

  return {
    MockElement,
    document,
    window,
    docListeners,
    winListeners,
    setSelection(next) {
      selectionState = {
        ...selectionState,
        ...next,
        isCollapsed: !next.text,
        rangeCount: next.text ? 1 : 0,
      };
    },
  };
}

test('All extension JavaScript files pass strict syntax validation (node --check)', () => {
  const jsFiles = [
    'src/shared/pitch.js',
    'src/shared/deinflect.js',
    'src/shared/lookup.js',
    'src/shared/ai-engine.js',
    'src/shared/feedback-learner.js',
    'src/shared/dict-loader.js',
    'src/background/service-worker.js',
    'src/offscreen/offscreen.js',
    'src/content/content.js',
    'src/popup/popup.js',
  ];

  for (const rel of jsFiles) {
    const abs = path.join(ROOT, rel);
    execFileSync(process.execPath, ['--check', abs]);
  }
});

test('Service worker safely registers context menu, handles LOOKUP_KANJI, and forwards frameId on contextMenu click', async () => {
  const createdMenus = [];
  let removeAllCalls = 0;
  let installedListener = null;
  let startupListener = null;
  let messageListener = null;
  let clickedListener = null;
  const tabSendCalls = [];
  const executeScriptCalls = [];
  let failFirstSend = false;

  const dictBuffer = fs.readFileSync(path.join(ROOT, 'data', 'dict.json.gz'));
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('data/dict.json.gz')) {
      return new Response(dictBuffer, { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test-id/${p}`,
      onInstalled: {
        addListener: (fn) => {
          installedListener = fn;
        },
      },
      onStartup: {
        addListener: (fn) => {
          startupListener = fn;
        },
      },
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
    },
    contextMenus: {
      removeAll: (cb) => {
        removeAllCalls += 1;
        createdMenus.length = 0;
        cb?.();
      },
      create: (props, cb) => {
        if (createdMenus.some((m) => m.id === props.id)) {
          throw new Error(`Duplicate context menu ID: ${props.id}`);
        }
        createdMenus.push(props);
        cb?.();
      },
      onClicked: {
        addListener: (fn) => {
          clickedListener = fn;
        },
      },
    },
    storage: {
      sync: {
        get: async () => ({}),
        set: async () => {},
      },
      local: {
        set: async () => {},
      },
    },
    tabs: {
      sendMessage: async (tabId, payload, options) => {
        tabSendCalls.push({ tabId, payload, options });
        if (failFirstSend) {
          failFirstSend = false;
          throw new Error('Receiving end does not exist');
        }
      },
    },
    scripting: {
      executeScript: async (opts) => {
        executeScriptCalls.push(opts);
      },
    },
  };

  try {
    const swModule = await import('../src/background/service-worker.js');
    assert.equal(typeof installedListener, 'function');
    assert.equal(typeof startupListener, 'function');
    assert.equal(typeof messageListener, 'function');
    assert.equal(typeof clickedListener, 'function');

    // Simulate rapid install + multiple MV3 worker restarts concurrently
    installedListener();
    startupListener();
    startupListener();
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(removeAllCalls, 3);
    assert.equal(createdMenus.length, 1);
    assert.equal(createdMenus[0].id, swModule.CONTEXT_MENU_ID);
    assert.equal(createdMenus[0].title, 'Read Kanji: 「%s」');
    assert.deepEqual(createdMenus[0].contexts, ['selection']);

    // Test LOOKUP_KANJI runtime message handler
    const response = await new Promise((resolve) => {
      const keepChannelOpen = messageListener(
        { type: 'LOOKUP_KANJI', text: '市場' },
        {},
        resolve
      );
      assert.equal(keepChannelOpen, true);
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.found, true);
    assert.equal(response.result.isTied, true);
    assert.deepEqual(
      response.result.readings.map((r) => r.reading),
      ['いちば', 'しじょう']
    );

    // Test context menu click inside an iframe (frameId = 5) with injection fallback
    failFirstSend = true;
    clickedListener(
      {
        menuItemId: swModule.CONTEXT_MENU_ID,
        selectionText: '居た',
        frameId: 5,
      },
      { id: 77 }
    );
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(tabSendCalls.length, 3);
    assert.equal(tabSendCalls[0].tabId, 77);
    assert.deepEqual(tabSendCalls[0].options, { frameId: 5 });
    assert.equal(tabSendCalls[0].payload.type, 'GET_SELECTION');
    assert.equal(tabSendCalls[1].payload.type, 'GET_SELECTION');
    assert.equal(tabSendCalls[2].payload.type, 'SHOW_READING_CARD');
    assert.equal(tabSendCalls[2].payload.result.readings[0].reading, 'いた');

    assert.equal(executeScriptCalls.length, 1);
    assert.deepEqual(executeScriptCalls[0], {
      target: { tabId: 77, frameIds: [5] },
      files: ['src/content/content.js'],
    });
    assert.deepEqual(tabSendCalls[2].options, { frameId: 5 });
  } finally {
    globalThis.fetch = origFetch;
    delete globalThis.chrome;
  }
});

test('Service worker serializes ensureOffscreenDocument() and routes LOOKUP_KANJI + contextMenu context through Offscreen AI', async () => {
  let createDocumentCalls = 0;
  let hasOffscreenDoc = false;
  const offscreenLookups = [];
  let messageListener = null;
  let clickedListener = null;
  const tabMessages = [];

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test-id/${p}`,
      getContexts: async () =>
        hasOffscreenDoc
          ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://test-id/src/offscreen/offscreen.html' }]
          : [],
      sendMessage: async (msg) => {
        if (msg?.target === 'offscreen' && msg.type === 'OFFSCREEN_LOOKUP') {
          offscreenLookups.push(msg.payload);
          return {
            ok: true,
            result: {
              query: msg.payload.text,
              normalized: msg.payload.text,
              found: true,
              hasKanji: true,
              matchType: msg.payload.contextText ? 'ai-context' : 'ai',
              aiPowered: true,
              isTied: false,
              readings: [{ reading: 'ひとけ', pitches: [0], pitchContours: [] }],
              segments: [],
            },
          };
        }
        return { ok: false };
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS' },
      createDocument: async () => {
        createDocumentCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        hasOffscreenDoc = true;
      },
    },
    contextMenus: {
      removeAll: (cb) => cb?.(),
      create: (_props, cb) => cb?.(),
      onClicked: {
        addListener: (fn) => {
          clickedListener = fn;
        },
      },
    },
    storage: {
      sync: { get: async () => ({}), set: async () => {} },
      local: { set: async () => {} },
    },
    tabs: {
      sendMessage: async (tabId, payload, options) => {
        tabMessages.push({ tabId, payload, options });
        if (payload?.type === 'GET_SELECTION') {
          return {
            selectionText: '人気',
            contextText: '人気がない夜道を歩く',
            contextStart: 0,
            contextEnd: 2,
          };
        }
        return { ok: true };
      },
    },
    scripting: {
      executeScript: async () => {},
    },
  };

  try {
    const sw = await import('../src/background/service-worker.js?offscreen=1');

    // Concurrent calls to ensureOffscreenDocument must only call createDocument ONCE
    await Promise.all([
      sw.ensureOffscreenDocument(),
      sw.ensureOffscreenDocument(),
      sw.ensureOffscreenDocument(),
    ]);
    assert.equal(createDocumentCalls, 1);

    // Subsequent lookup reuses existing offscreen context without recreating
    const lookupRes = await new Promise((resolve) => {
      messageListener(
        {
          type: 'LOOKUP_KANJI',
          text: '人気',
          contextText: '人気がない夜道を歩く',
          contextStart: 0,
          contextEnd: 2,
        },
        {},
        resolve
      );
    });
    assert.equal(createDocumentCalls, 1);
    assert.equal(lookupRes.ok, true);
    assert.equal(lookupRes.result.matchType, 'ai-context');
    assert.equal(lookupRes.result.readings[0].reading, 'ひとけ');

    // Context menu click queries GET_SELECTION context and passes it to offscreen AI
    clickedListener(
      { menuItemId: sw.CONTEXT_MENU_ID, selectionText: '人気', frameId: 0 },
      { id: 42 }
    );
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(offscreenLookups.length, 2);
    assert.deepEqual(offscreenLookups[1], {
      text: '人気',
      contextText: '人気がない夜道を歩く',
      contextStart: 0,
      contextEnd: 2,
    });
    const cardMsg = tabMessages.find((m) => m.payload.type === 'SHOW_READING_CARD');
    assert.ok(cardMsg);
    assert.equal(cardMsg.payload.result.readings[0].reading, 'ひとけ');
  } finally {
    delete globalThis.chrome;
  }
});

test('Service worker awaits in-flight offscreen load even when context appears early and discards stale concurrent contextMenu lookups', async () => {
  let offscreenListenerReady = false;
  let contextVisible = false;
  let clickedListener = null;
  let messageListener = null;
  const shownCards = [];
  const savedLookups = [];
  const pendingOffscreenResolvers = [];

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test-id/${p}`,
      getContexts: async () =>
        contextVisible
          ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://test-id/src/offscreen/offscreen.html' }]
          : [],
      sendMessage: async (msg) => {
        if (msg?.target === 'offscreen' && msg.type === 'OFFSCREEN_LOOKUP') {
          if (!offscreenListenerReady) {
            return undefined; // Simulates sending before offscreen script finishes loading
          }
          return await new Promise((resolve) => {
            pendingOffscreenResolvers.push({ text: msg.payload.text, resolve });
          });
        }
        return { ok: false };
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS' },
      createDocument: async () => {
        // Context becomes visible BEFORE offscreen script finishes initial load
        contextVisible = true;
        await new Promise((r) => setTimeout(r, 30));
        offscreenListenerReady = true;
      },
    },
    contextMenus: {
      removeAll: (cb) => cb?.(),
      create: (_props, cb) => cb?.(),
      onClicked: {
        addListener: (fn) => {
          clickedListener = fn;
        },
      },
    },
    storage: {
      sync: { get: async () => ({}), set: async () => {} },
      local: {
        set: async (obj) => {
          if (obj.lastLookup) savedLookups.push(obj.lastLookup.result);
        },
      },
    },
    tabs: {
      sendMessage: async (_tabId, payload) => {
        if (payload?.type === 'GET_SELECTION') {
          return { selectionText: '', contextText: '', contextStart: -1, contextEnd: -1 };
        }
        if (payload?.type === 'SHOW_READING_CARD') {
          shownCards.push(payload.result);
        }
        return { ok: true };
      },
    },
    scripting: { executeScript: async () => {} },
  };

  try {
    const sw = await import('../src/background/service-worker.js?offscreenRace=1');

    // Start lookup 1 (triggers createDocument -> contextVisible=true immediately while loading)
    const p1 = new Promise((resolve) => {
      messageListener({ type: 'LOOKUP_KANJI', text: '怪物' }, {}, resolve);
    });
    // Wait 5ms so contextVisible === true while createDocument is still in-flight
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(contextVisible, true);
    assert.equal(offscreenListenerReady, false);

    // Concurrent lookup 2 must still await in-flight createDocument instead of bypassing it
    const p2 = new Promise((resolve) => {
      messageListener({ type: 'LOOKUP_KANJI', text: '市場' }, {}, resolve);
    });

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(pendingOffscreenResolvers.length, 2);
    for (const item of pendingOffscreenResolvers.splice(0)) {
      item.resolve({
        ok: true,
        result: {
          query: item.text,
          normalized: item.text,
          found: true,
          hasKanji: true,
          matchType: 'ai',
          readings: [{ reading: item.text === '怪物' ? 'かいぶつ' : 'いちば', pitches: [0], pitchContours: [] }],
          segments: [],
        },
      });
    }
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.result.readings[0].reading, 'かいぶつ');
    assert.equal(r2.result.readings[0].reading, 'いちば');

    // Concurrent context-menu clicks: click 1 ('古い') finishes AFTER click 2 ('新しい')
    clickedListener({ menuItemId: sw.CONTEXT_MENU_ID, selectionText: '古い', frameId: 0 }, { id: 9 });
    clickedListener({ menuItemId: sw.CONTEXT_MENU_ID, selectionText: '新しい', frameId: 0 }, { id: 9 });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(pendingOffscreenResolvers.length, 2);

    // Resolve newer request ('新しい') FIRST, then slower older request ('古い') SECOND
    const firstPending = pendingOffscreenResolvers[0];
    const secondPending = pendingOffscreenResolvers[1];
    secondPending.resolve({
      ok: true,
      result: { query: '新しい', normalized: '新しい', found: true, hasKanji: true, readings: [{ reading: 'あたらしい', pitches: [4], pitchContours: [] }], segments: [] },
    });
    await new Promise((r) => setTimeout(r, 15));
    firstPending.resolve({
      ok: true,
      result: { query: '古い', normalized: '古い', found: true, hasKanji: true, readings: [{ reading: 'ふるい', pitches: [2], pitchContours: [] }], segments: [] },
    });
    await new Promise((r) => setTimeout(r, 15));

    // Only '新しい' should be shown and remain as lastLookup — stale '古い' must be discarded
    assert.equal(shownCards.length, 1);
    assert.equal(shownCards[0].readings[0].reading, 'あたらしい');
    assert.equal(savedLookups.at(-1).readings[0].reading, 'あたらしい');
  } finally {
    delete globalThis.chrome;
  }
});

test('Content script extracts sentence context excluding <rt>/<rp> ruby tags and renders kanjiDetails + Horse Models attribution', async () => {
  const contentSource = fs.readFileSync(path.join(ROOT, 'src/content/content.js'), 'utf8');
  const dom = createMockDom();

  // Build `<p><ruby>株式<rt>かぶしき</rt></ruby><ruby>市場<rp>(</rp><rt>しじょう</rt><rp>)</rp></ruby>の動向を見る。次の文。</p>`
  const mkText = (val) => {
    const t = {
      nodeType: 3,
      nodeValue: val,
      textContent: val,
      parentNode: null,
      getAttribute: () => null,
      queryAll: () => [],
    };
    return t;
  };
  const append = (parent, child) => {
    child.parentNode = parent;
    child.parentElement = parent;
    parent.children.push(child);
    parent.childNodes = parent.children;
    return child;
  };

  const p = dom.document.createElement('p');
  dom.document.body.appendChild(p);
  dom.document.body.childNodes = dom.document.body.children;

  const ruby1 = append(p, dom.document.createElement('ruby'));
  append(ruby1, mkText('株式'));
  const rt1 = append(ruby1, dom.document.createElement('rt'));
  append(rt1, mkText('かぶしき'));

  const ruby2 = append(p, dom.document.createElement('ruby'));
  const targetTextNode = append(ruby2, mkText('市場'));
  const rpOpen = append(ruby2, dom.document.createElement('rp'));
  append(rpOpen, mkText('('));
  const rt2 = append(ruby2, dom.document.createElement('rt'));
  append(rt2, mkText('しじょう'));
  const rpClose = append(ruby2, dom.document.createElement('rp'));
  append(rpClose, mkText(')'));

  append(p, mkText('の動向を見る。次の文。'));

  let capturedLookupMsg = null;
  let onMessageListener = null;

  dom.window.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: targetTextNode,
    toString: () => '市場(しじょう)',
    getRangeAt: () => ({
      commonAncestorContainer: ruby2,
      startContainer: targetTextNode,
      startOffset: 0,
      endContainer: targetTextNode,
      endOffset: 2,
      getBoundingClientRect: () => ({ left: 100, top: 140, right: 150, bottom: 164, width: 50, height: 24 }),
      getClientRects: () => [{ left: 100, top: 140, right: 150, bottom: 164, width: 50, height: 24 }],
    }),
  });

  const chrome = {
    runtime: {
      id: 'test-ext-id',
      lastError: null,
      sendMessage: (msg, cb) => {
        capturedLookupMsg = msg;
        cb({
          ok: true,
          result: {
            found: true,
            query: '年',
            normalized: '年',
            matchType: 'single-kanji',
            isSingleKanji: true,
            hasContext: false,
            isTied: false,
            readings: [
              { reading: 'とし', pitches: [2], pitchContours: [] },
              { reading: 'ねん', pitches: [1], pitchContours: [] },
            ],
            kanjiDetails: {
              kun: ['とし'],
              on: ['ネン'],
            },
            segments: [],
          },
        });
      },
      onMessage: {
        addListener: (fn) => {
          onMessageListener = fn;
        },
      },
    },
    storage: {
      sync: { get: (_d, cb) => cb({ showFloatingButton: true }) },
      onChanged: { addListener: () => {} },
    },
  };

  vm.runInNewContext(contentSource, {
    window: dom.window,
    document: dom.document,
    Node: { ELEMENT_NODE: 1 },
    chrome,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
  });

  // Verify GET_SELECTION strips `<rt>`/`<rp>` and trims at sentence boundary `。`
  let getSelResp = null;
  onMessageListener({ type: 'GET_SELECTION' }, {}, (res) => {
    getSelResp = res;
  });
  assert.deepEqual(
    { ...getSelResp },
    {
      selectionText: '市場',
      contextText: '株式市場の動向を見る。',
      contextStart: 2,
      contextEnd: 4,
    }
  );
  assert.equal(getSelResp.contextText.slice(getSelResp.contextStart, getSelResp.contextEnd), '市場');

  // Trigger mouseup -> pill click -> verify LOOKUP_KANJI receives clean context AND card renders Kun/On + attribution
  dom.document.dispatchEvent({ type: 'mouseup' });
  await new Promise((r) => setTimeout(r, 55));

  const host = dom.document.body.queryAll((el) => el.getAttribute('data-yomipitch-root') === 'true')[0];
  const pills = host.shadowRoot.queryAll((el) => el.classList.contains('yp-pill'));
  assert.equal(pills.length, 1);
  pills[0].dispatchEvent({ type: 'click' });

  assert.equal(capturedLookupMsg.text, '市場');
  assert.equal(capturedLookupMsg.contextText, '株式市場の動向を見る。');
  assert.equal(capturedLookupMsg.contextStart, 2);
  assert.equal(capturedLookupMsg.contextEnd, 4);

  const cards = host.shadowRoot.queryAll((el) => el.classList.contains('yp-card'));
  assert.equal(cards.length, 1);
  const cardText = cards[0].textContent;
  assert.match(cardText, /Single Kanji · All Readings/);
  assert.match(cardText, /訓読み \(Kun\)/);
  assert.match(cardText, /音読み \(On\)/);
  assert.match(cardText, /ネン/);
  assert.match(cardText, /Powered by Horse Models/);

  // Verify Kun-only single Kanji (`喰`, readings: []) renders kanjiDetails instead of "No dictionary reading found"
  onMessageListener(
    {
      type: 'SHOW_READING_CARD',
      text: '喰',
      result: {
        found: true,
        hasKanji: true,
        query: '喰',
        normalized: '喰',
        matchType: 'single-kanji',
        isSingleKanji: true,
        readings: [],
        kanjiDetails: { kun: ['く.う', 'く.らう'], on: [] },
        segments: [],
      },
    },
    {},
    () => {}
  );
  const kuuCardText = host.shadowRoot.queryAll((el) => el.classList.contains('yp-card'))[0].textContent;
  assert.doesNotMatch(kuuCardText, /No dictionary reading found/);
  assert.match(kuuCardText, /く\.う/);

  // Verify irregular compound (`今` in `今日`) renders enclosingCompound (`きょう`) cleanly
  onMessageListener(
    {
      type: 'SHOW_READING_CARD',
      text: '今',
      result: {
        found: true,
        hasKanji: true,
        query: '今',
        normalized: '今',
        matchType: 'unalignable-context',
        unalignable: true,
        isSingleKanji: true,
        hasContext: true,
        readings: [],
        enclosingCompound: {
          surface: '今日',
          reading: 'きょう',
          pitches: [1],
          pitchContours: [],
        },
        kanjiDetails: { allWords: [['いま', [1]]], kun: ['いま'], on: ['コン', 'キン'] },
        segments: [],
      },
    },
    {},
    () => {}
  );
  const irrCardText = host.shadowRoot.queryAll((el) => el.classList.contains('yp-card'))[0].textContent;
  assert.match(irrCardText, /Irregular Compound/);
  assert.match(irrCardText, /今日/);
  assert.match(irrCardText, /きょう/);
});

test('Content script ignores in-flight LOOKUP_KANJI responses after dismiss or selection change, repositions on capture scroll, and renders pitch notes', async () => {
  const contentSource = fs.readFileSync(path.join(ROOT, 'src/content/content.js'), 'utf8');
  const dom = createMockDom();

  const pendingCallbacks = [];
  const chrome = {
    runtime: {
      id: 'test-ext-id',
      lastError: null,
      sendMessage: (_msg, cb) => {
        pendingCallbacks.push(cb);
      },
      onMessage: {
        addListener: () => {},
      },
    },
    storage: {
      sync: {
        get: (_defaults, cb) => cb({ showFloatingButton: true }),
      },
      onChanged: {
        addListener: () => {},
      },
    },
  };

  vm.runInNewContext(contentSource, {
    window: dom.window,
    document: dom.document,
    Node: { ELEMENT_NODE: 1 },
    chrome,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
  });

  // Verify scroll listener is registered with capture: true so nested scrollable containers work
  const scrollListeners = dom.winListeners.get('scroll') || [];
  assert.equal(scrollListeners.length, 1);
  assert.equal(scrollListeners[0].options?.capture, true);

  // 1. Highlight supplementary Kanji word 𠮷野家 -> floating pill appears
  dom.setSelection({
    text: '𠮷野家',
    rect: { left: 100, top: 150, right: 172, bottom: 174, width: 72, height: 24 },
  });
  dom.document.dispatchEvent({ type: 'mouseup' });
  await new Promise((r) => setTimeout(r, 55));

  const host = dom.document.body.queryAll((el) => el.getAttribute('data-yomipitch-root') === 'true')[0];
  assert.ok(host, 'Shadow host must be mounted after selecting Kanji');
  let pills = host.shadowRoot.queryAll((el) => el.classList.contains('yp-pill'));
  assert.equal(pills.length, 1);

  // Move selection rect (e.g. nested container scroll) -> capture scroll updates pill position
  const initialTop = pills[0].style.top;
  dom.setSelection({
    text: '𠮷野家',
    rect: { left: 100, top: 260, right: 172, bottom: 284, width: 72, height: 24 },
  });
  dom.window.dispatchEvent({ type: 'scroll' });
  assert.notEqual(pills[0].style.top, initialTop, 'Capture scroll must reposition visible pill');

  // 2. Click pill -> triggers LOOKUP_KANJI #1, then dismiss with Escape BEFORE response arrives
  pills[0].dispatchEvent({ type: 'click' });
  assert.equal(pendingCallbacks.length, 1);

  dom.document.dispatchEvent({ type: 'keyup', key: 'Escape' });
  assert.equal(
    host.shadowRoot.queryAll((el) => el.classList.contains('yp-card')).length,
    0,
    'Escape must dismiss UI immediately'
  );

  // Late response for dismissed lookup arrives -> must NOT reopen card!
  pendingCallbacks.shift()({
    ok: true,
    result: {
      found: true,
      query: '𠮷野家',
      normalized: '𠮷野家',
      matchType: 'exact',
      isTied: false,
      readings: [{ reading: 'よしのや', pitches: [0], pitchContours: [] }],
    },
  });
  assert.equal(
    host.shadowRoot.queryAll((el) => el.classList.contains('yp-card')).length,
    0,
    'Late LOOKUP_KANJI callback after dismissUI() must be ignored'
  );

  // 2b. Highlight 市場, click pill -> triggers LOOKUP_KANJI #2, then user changes selection BEFORE response arrives
  dom.setSelection({
    text: '市場',
    rect: { left: 110, top: 150, right: 170, bottom: 174, width: 60, height: 24 },
  });
  dom.document.dispatchEvent({ type: 'mouseup' });
  await new Promise((r) => setTimeout(r, 55));
  pills = host.shadowRoot.queryAll((el) => el.classList.contains('yp-pill'));
  pills[0].dispatchEvent({ type: 'click' });
  assert.equal(pendingCallbacks.length, 1);

  // Selection changes to 食べた while 市場 lookup is still in flight
  dom.setSelection({
    text: '食べた',
    rect: { left: 140, top: 180, right: 200, bottom: 204, width: 60, height: 24 },
  });
  dom.document.dispatchEvent({ type: 'mouseup' });
  await new Promise((r) => setTimeout(r, 55));

  // Late response for stale 市場 lookup arrives -> must NOT render 市場 card!
  pendingCallbacks.shift()({
    ok: true,
    result: {
      found: true,
      query: '市場',
      normalized: '市場',
      matchType: 'exact',
      isTied: true,
      readings: [{ reading: 'いちば', pitches: [3], pitchContours: [] }],
    },
  });
  assert.equal(
    host.shadowRoot.queryAll((el) => el.classList.contains('yp-card') && /いちば/.test(el.textContent)).length,
    0,
    'Late LOOKUP_KANJI callback after selection changed text must be ignored'
  );

  // 3. Dismiss any active UI, highlight 食べた, click pill, and verify selected-form pitch note + tiesTruncated note render
  dom.document.dispatchEvent({ type: 'keyup', key: 'Escape' });
  dom.setSelection({
    text: '食べた',
    rect: { left: 140, top: 180, right: 200, bottom: 204, width: 60, height: 24 },
  });
  dom.document.dispatchEvent({ type: 'mouseup' });
  await new Promise((r) => setTimeout(r, 55));

  pills = host.shadowRoot.queryAll((el) => el.classList.contains('yp-pill'));
  assert.equal(pills.length, 1);
  pills[0].dispatchEvent({ type: 'click' });
  assert.equal(pendingCallbacks.length, 1);

  pendingCallbacks.shift()({
    ok: true,
    result: {
      found: true,
      query: '食べた',
      normalized: '食べた',
      matchType: 'deinflected',
      isTied: false,
      tiesTruncated: true,
      readings: [
        {
          reading: 'たべた',
          pitches: [],
          pitchContours: [],
          pitchUnavailableReason: 'inflected',
          base: {
            surface: '食べる',
            reading: 'たべる',
            pitches: [2],
            pitchContours: [
              {
                pitch: 2,
                labelJa: '中高',
                risesOnParticle: false,
                morae: [
                  { text: 'た', high: false, dropAfter: false },
                  { text: 'べ', high: true, dropAfter: true },
                  { text: 'る', high: false, dropAfter: false },
                ],
              },
            ],
            ruleLabel: 'past (-ta)',
          },
        },
      ],
    },
  });

  const cards = host.shadowRoot.queryAll((el) => el.classList.contains('yp-card'));
  assert.equal(cards.length, 1);
  const cardText = cards[0].textContent;
  assert.match(cardText, /Intonation: base form 食べる/);
  assert.match(cardText, /\[2\]/);
  assert.match(cardText, /Showing first 32 tied combinations/);
});

test('Content script handles invalidated chrome.runtime.id gracefully on pill click without throwing', async () => {
  const contentSource = fs.readFileSync(path.join(ROOT, 'src/content/content.js'), 'utf8');
  const dom = createMockDom();

  const chrome = {
    runtime: {
      id: 'valid-at-load',
      lastError: null,
      sendMessage: () => {
        throw new Error('Extension context invalidated.');
      },
      onMessage: {
        addListener: () => {},
      },
    },
    storage: {
      sync: {
        get: (_defaults, cb) => cb({ showFloatingButton: true }),
      },
      onChanged: {
        addListener: () => {},
      },
    },
  };

  vm.runInNewContext(contentSource, {
    window: dom.window,
    document: dom.document,
    Node: { ELEMENT_NODE: 1 },
    chrome,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
  });

  dom.setSelection({
    text: '振った',
    rect: { left: 100, top: 150, right: 160, bottom: 174, width: 60, height: 24 },
  });
  dom.document.dispatchEvent({ type: 'mouseup' });
  await new Promise((r) => setTimeout(r, 55));

  const host = dom.document.body.queryAll((el) => el.getAttribute('data-yomipitch-root') === 'true')[0];
  const pills = host.shadowRoot.queryAll((el) => el.classList.contains('yp-pill'));
  assert.equal(pills.length, 1);

  // Simulate extension reload invalidating chrome.runtime.id right before user clicks pill
  chrome.runtime.id = undefined;
  assert.doesNotThrow(() => {
    pills[0].dispatchEvent({ type: 'click' });
  });

  const cards = host.shadowRoot.queryAll((el) => el.classList.contains('yp-card'));
  assert.equal(cards.length, 1);
  assert.match(cards[0].textContent, /Extension updated — please refresh this page/);
});

test('Popup guards against startup vs user-typing races, out-of-order lookups, and detects iframe selections', async () => {
  function mountPopupDom() {
    const dom = createMockDom();
    const mk = (tag, id) => {
      const el = dom.document.createElement(tag);
      el.id = id;
      dom.document.body.appendChild(el);
      return el;
    };
    const formEl = mk('form', 'lookup-form');
    const inputEl = mk('input', 'kanji-input');
    const clearBtn = mk('button', 'clear-btn');
    clearBtn.hidden = true;
    const samplesView = mk('div', 'samples-view');
    const sampleChips = mk('div', 'sample-chips');
    samplesView.appendChild(sampleChips);
    const resultContainer = mk('div', 'result-container');
    resultContainer.hidden = true;
    const toggleEl = mk('input', 'floating-pill-toggle');
    toggleEl.checked = true;
    return { dom, formEl, inputEl, clearBtn, samplesView, resultContainer, toggleEl };
  }

  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  const savedChrome = globalThis.chrome;
  const savedNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  function installGlobals(dom, chrome) {
    globalThis.window = dom.window;
    globalThis.document = dom.document;
    globalThis.chrome = chrome;
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async () => {} } },
      configurable: true,
      writable: true,
    });
  }

  try {
    // Case A: Iframe selection detection via executeScript(allFrames: true) + pitch clarity rendering
    {
      const { dom, inputEl, resultContainer } = mountPopupDom();
      let executeScriptArgs = null;

      const chrome = {
        tabs: {
          query: async () => [{ id: 12 }],
          sendMessage: async () => ({ selectionText: '' }),
        },
        scripting: {
          executeScript: async (opts) => {
            executeScriptArgs = opts;
            return [
              { frameId: 0, result: '' },
              { frameId: 3, result: '食べた' },
            ];
          },
        },
        storage: {
          sync: { get: async () => ({ showFloatingButton: true }), set: async () => {} },
          local: { get: async () => ({}) },
        },
        runtime: {
          sendMessage: async (msg) => ({
            ok: true,
            result: {
              found: true,
              query: msg.text,
              normalized: msg.text,
              matchType: 'deinflected',
              isTied: false,
              tiesTruncated: true,
              readings: [
                {
                  reading: 'たべた',
                  pitches: [],
                  pitchContours: [],
                  pitchUnavailableReason: 'inflected',
                  base: {
                    surface: '食べる',
                    reading: 'たべる',
                    pitches: [2],
                    pitchContours: [],
                    ruleLabel: 'past (-ta)',
                  },
                },
              ],
            },
          }),
        },
      };

      installGlobals(dom, chrome);
      await import('../src/popup/popup.js?case=a');
      await new Promise((r) => setTimeout(r, 25));

      assert.equal(executeScriptArgs?.target?.tabId, 12);
      assert.equal(executeScriptArgs?.target?.allFrames, true);
      assert.equal(inputEl.value, '食べた');
      assert.match(resultContainer.textContent, /Intonation: base form 食べる/);
      assert.match(resultContainer.textContent, /\[2\]/);
      assert.match(resultContainer.textContent, /Showing first 32 tied combinations/);
    }

    // Case B: User types while startup tab selection is slow + out-of-order performLookup responses
    {
      const { dom, formEl, inputEl, resultContainer } = mountPopupDom();
      let resolveTabDetection;
      const lookupResolvers = [];

      const chrome = {
        tabs: {
          query: async () => [{ id: 99 }],
          sendMessage: async () => ({ selectionText: '' }),
        },
        scripting: {
          executeScript: () =>
            new Promise((resolve) => {
              resolveTabDetection = resolve;
            }),
        },
        storage: {
          sync: { get: async () => ({ showFloatingButton: true }), set: async () => {} },
          local: { get: async () => ({ lastLookup: { text: '古い', ts: Date.now() } }) },
        },
        runtime: {
          sendMessage: (msg) =>
            new Promise((resolve) => {
              lookupResolvers.push({ text: msg.text, resolve });
            }),
        },
      };

      installGlobals(dom, chrome);
      await import('../src/popup/popup.js?case=b');
      await new Promise((r) => setTimeout(r, 10));

      // User begins typing and submits two lookups BEFORE startup detection resolves
      inputEl.value = '振った';
      inputEl.dispatchEvent({ type: 'input' });
      formEl.dispatchEvent({ type: 'submit' });

      inputEl.value = '居た';
      inputEl.dispatchEvent({ type: 'input' });
      formEl.dispatchEvent({ type: 'submit' });

      assert.equal(lookupResolvers.length, 2);
      assert.equal(lookupResolvers[0].text, '振った');
      assert.equal(lookupResolvers[1].text, '居た');

      // Now resolve startup iframe detection late -> must NOT overwrite inputEl.value ('居た')!
      resolveTabDetection([{ frameId: 0, result: '怪物' }]);
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(inputEl.value, '居た');
      assert.equal(
        lookupResolvers.length,
        2,
        'Startup lookup must abort when user already interacted'
      );

      // Resolve lookup #2 ('居た') FIRST, then resolve stale lookup #1 ('振った') SECOND
      lookupResolvers[1].resolve({
        ok: true,
        result: {
          found: true,
          query: '居た',
          normalized: '居た',
          matchType: 'deinflected',
          isTied: false,
          readings: [
            {
              reading: 'いた',
              pitches: [],
              pitchContours: [],
              pitchUnavailableReason: 'inflected',
              base: { surface: '居る', reading: 'いる', pitches: [], pitchContours: [] },
            },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.match(resultContainer.textContent, /いた/);
      assert.match(resultContainer.textContent, /Intonation: —/);

      lookupResolvers[0].resolve({
        ok: true,
        result: {
          found: true,
          query: '振った',
          normalized: '振った',
          matchType: 'deinflected',
          isTied: false,
          readings: [{ reading: 'ふった', pitches: [], pitchContours: [] }],
        },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.match(resultContainer.textContent, /いた/);
      assert.doesNotMatch(
        resultContainer.textContent,
        /ふった/,
        'Out-of-order earlier lookup response must be ignored'
      );
    }
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = savedChrome;
    if (savedNavigatorDesc) Object.defineProperty(globalThis, 'navigator', savedNavigatorDesc);
  }
});

test('Offscreen document decompresses all 3 gzip assets + ONNX model and serves OFFSCREEN_LOOKUP', async () => {
  let offscreenListener = null;
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const rel = String(url).replace('chrome-extension://test-id/', '');
    const buf = fs.readFileSync(path.join(ROOT, rel));
    return new Response(buf, { status: 200 });
  };

  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test-id/${p}`,
      onMessage: {
        addListener: (fn) => {
          offscreenListener = fn;
        },
      },
    },
  };

  try {
    const offscreenMod = await import('../src/offscreen/offscreen.js');
    assert.equal(typeof offscreenListener, 'function');

    // Messages not targeted at 'offscreen' must be ignored
    assert.equal(offscreenListener({ type: 'LOOKUP_KANJI', text: '市場' }, {}, () => {}), false);

    // OFFSCREEN_LOOKUP with contextual polyphone
    const ctxResp = await new Promise((resolve) => {
      const asyncKeepOpen = offscreenListener(
        {
          target: 'offscreen',
          type: 'OFFSCREEN_LOOKUP',
          payload: {
            text: '人気',
            contextText: '人気がない夜道を歩く',
            contextStart: 0,
            contextEnd: 2,
          },
        },
        {},
        resolve
      );
      assert.equal(asyncKeepOpen, true);
    });

    assert.equal(ctxResp.ok, true);
    assert.equal(ctxResp.result.matchType, 'ai-context');
    assert.equal(ctxResp.result.readings[0].reading, 'ひとけ');
    assert.deepEqual(ctxResp.result.readings[0].pitches, [0]);

    // OFFSCREEN_LOOKUP with １６年前
    const numResp = await new Promise((resolve) => {
      offscreenListener(
        {
          target: 'offscreen',
          type: 'OFFSCREEN_LOOKUP',
          payload: { text: '１６年前' },
        },
        {},
        resolve
      );
    });
    assert.equal(numResp.ok, true);
    assert.equal(numResp.result.readings[0].reading, 'じゅうろくねんまえ');

    const res = await offscreenMod.getOffscreenResources();
    if (res?.annotator?.dispose) {
      await res.annotator.dispose();
    }
  } finally {
    globalThis.fetch = origFetch;
    delete globalThis.chrome;
  }
});

test('Feedback flow end-to-end: Service Worker <-> Offscreen persistence, Shadow-DOM IME-safe feedback UI, and Popup Learned drawer', async () => {
  // 1. Service Worker <-> Offscreen SUBMIT_FEEDBACK / GET_FEEDBACK_LIST / REMOVE_FEEDBACK / CLEAR_FEEDBACK
  let messageListener = null;
  const localStore = {};
  const offscreenCalls = [];

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test-id/${p}`,
      getContexts: async () => [
        {
          contextType: 'OFFSCREEN_DOCUMENT',
          documentUrl: 'chrome-extension://test-id/src/offscreen/offscreen.html',
        },
      ],
      sendMessage: async (msg) => {
        offscreenCalls.push(msg);
        if (msg?.target === 'offscreen' && msg.type === 'OFFSCREEN_RECORD_FEEDBACK') {
          if (msg.feedback.reading === 'INVALID_ROMAJI') {
            return { ok: false, error: 'Reading must be in hiragana or katakana.' };
          }
          const entry = {
            id: 'fb_moon_prince',
            surface: msg.feedback.surface,
            normSurface: msg.feedback.normSurface || msg.feedback.surface,
            reading: 'つきおうじ',
            pitches: [3],
            contextBefore: '',
            contextAfter: '',
            isContextualPolyphone: false,
            previousReading: 'げつおうじ',
            updatedAt: Date.now(),
            count: 1,
          };
          const state = {
            version: 1,
            entries: [entry],
            weights: { 'WORD:月王子@0': { つき: 2.5 } },
          };
          return {
            ok: true,
            entry,
            state,
            entries: [entry],
            syncedRevision: msg.nextRevision,
            result: {
              query: '月王子',
              normalized: '月王子',
              found: true,
              hasKanji: true,
              learnedFromFeedback: true,
              feedbackEntryId: 'fb_moon_prince',
              matchType: 'ai',
              readings: [{ reading: 'つきおうじ', pitches: [3], pitchContours: [] }],
              segments: [],
            },
          };
        }
        if (msg?.target === 'offscreen' && msg.type === 'OFFSCREEN_REMOVE_FEEDBACK') {
          return {
            ok: true,
            removed: true,
            state: { version: 1, entries: [], weights: {} },
            entries: [],
            syncedRevision: msg.nextRevision,
            result: {
              query: '月王子',
              normalized: '月王子',
              found: true,
              hasKanji: true,
              learnedFromFeedback: false,
              matchType: 'ai',
              readings: [{ reading: 'げつおうじ', pitches: [], pitchContours: [] }],
              segments: [],
            },
          };
        }
        if (msg?.target === 'offscreen' && msg.type === 'OFFSCREEN_CLEAR_FEEDBACK') {
          return {
            ok: true,
            state: { version: 1, entries: [], weights: {} },
            entries: [],
            syncedRevision: msg.nextRevision,
            result: null,
          };
        }
        return { ok: false };
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS' },
      createDocument: async () => {},
    },
    contextMenus: {
      removeAll: (cb) => cb?.(),
      create: (_props, cb) => cb?.(),
      onClicked: { addListener: () => {} },
    },
    storage: {
      sync: { get: async () => ({}), set: async () => {} },
      local: {
        get: async (key) => (typeof key === 'string' ? { [key]: localStore[key] } : { ...localStore }),
        set: async (obj) => {
          Object.assign(localStore, obj);
        },
      },
    },
    tabs: { sendMessage: async () => ({ ok: true }) },
    scripting: { executeScript: async () => {} },
  };

  try {
    await import('../src/background/service-worker.js?feedbackTest=1');

    // Validation error from offscreen must surface cleanly without falling back or crashing
    const badRes = await new Promise((resolve) => {
      messageListener(
        {
          type: 'SUBMIT_FEEDBACK',
          feedback: { surface: '月王子', reading: 'INVALID_ROMAJI' },
        },
        {},
        resolve
      );
    });
    assert.equal(badRes.ok, false);
    assert.match(badRes.error, /hiragana or katakana/i);

    // Valid feedback persists to chrome.storage.local and returns updated reading immediately
    const goodRes = await new Promise((resolve) => {
      messageListener(
        {
          type: 'SUBMIT_FEEDBACK',
          feedback: { surface: '月王子', normSurface: '月王子', reading: 'つきおうじ', pitches: '3' },
          lookupRequest: { text: '月王子', contextText: '', contextStart: -1, contextEnd: -1 },
        },
        {},
        resolve
      );
    });
    assert.equal(goodRes.ok, true);
    assert.equal(goodRes.result.learnedFromFeedback, true);
    assert.equal(goodRes.result.readings[0].reading, 'つきおうじ');
    assert.equal(localStore.userFeedbackState?.entries?.length, 1);

    const listRes = await new Promise((resolve) => {
      messageListener({ type: 'GET_FEEDBACK_LIST' }, {}, resolve);
    });
    assert.equal(listRes.ok, true);
    assert.equal(listRes.entries.length, 1);
    assert.equal(listRes.entries[0].reading, 'つきおうじ');

    const undoRes = await new Promise((resolve) => {
      messageListener(
        {
          type: 'REMOVE_FEEDBACK',
          id: 'fb_moon_prince',
          lookupRequest: { text: '月王子', contextText: '', contextStart: -1, contextEnd: -1 },
        },
        {},
        resolve
      );
    });
    assert.equal(undoRes.ok, true);
    assert.equal(undoRes.result.readings[0].reading, 'げつおうじ');
    assert.equal(localStore.userFeedbackState?.entries?.length, 0);
  } finally {
    delete globalThis.chrome;
  }

  // 2. Content script Shadow-DOM feedback UI: stopPropagation on host shortcuts, IME composition Enter guard, submit & undo
  const contentSource = fs.readFileSync(path.join(ROOT, 'src/content/content.js'), 'utf8');
  const dom = createMockDom();
  let onMessageListener = null;
  const sentRuntimeMsgs = [];

  const chromeMock = {
    runtime: {
      id: 'test-ext-id',
      lastError: null,
      sendMessage: (msg, cb) => {
        sentRuntimeMsgs.push(msg);
        if (msg.type === 'SUBMIT_FEEDBACK') {
          cb({
            ok: true,
            result: {
              found: true,
              hasKanji: true,
              query: '月王子',
              normalized: '月王子',
              learnedFromFeedback: true,
              feedbackEntryId: 'fb_1',
              matchType: 'ai-context',
              readings: [{ reading: 'つきおうじ', pitches: [3], pitchContours: [] }],
              segments: [],
            },
          });
          return;
        }
        if (msg.type === 'REMOVE_FEEDBACK') {
          cb({
            ok: true,
            result: {
              found: true,
              hasKanji: true,
              query: '月王子',
              normalized: '月王子',
              learnedFromFeedback: false,
              matchType: 'ai-context',
              readings: [{ reading: 'げつおうじ', pitches: [], pitchContours: [] }],
              segments: [],
            },
          });
        }
      },
      onMessage: {
        addListener: (fn) => {
          onMessageListener = fn;
        },
      },
    },
    storage: {
      sync: { get: (_d, cb) => cb({ showFloatingButton: true }) },
      onChanged: { addListener: () => {} },
    },
  };

  vm.runInNewContext(contentSource, {
    window: dom.window,
    document: dom.document,
    Node: { ELEMENT_NODE: 1 },
    chrome: chromeMock,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
  });

  // Open card via SHOW_READING_CARD with context metadata
  onMessageListener(
    {
      type: 'SHOW_READING_CARD',
      text: '月王子',
      lookupRequest: {
        text: '月王子',
        contextText: '月王子の剣',
        contextStart: 0,
        contextEnd: 3,
      },
      result: {
        found: true,
        hasKanji: true,
        query: '月王子',
        normalized: '月王子',
        matchType: 'ai-context',
        readings: [{ reading: 'げつおうじ', pitches: [], pitchContours: [] }],
        segments: [],
      },
    },
    {},
    () => {}
  );

  const host = dom.document.body.queryAll((el) => el.getAttribute('data-yomipitch-root') === 'true')[0];
  let card = host.shadowRoot.queryAll((el) => el.classList.contains('yp-card'))[0];
  assert.match(card.textContent, /Wrong reading\? Teach AI/);

  // Open feedback form, simulate selection collapsing when input focuses, verify IME Enter is guarded and stopPropagation fires
  const teachBtn = card.queryAll((el) => el.classList.contains('yp-feedback-btn'))[0];
  teachBtn.dispatchEvent({ type: 'click' });
  dom.setSelection({ text: '' });
  dom.document.dispatchEvent({ type: 'selectionchange' });

  const form = card.queryAll((el) => el.classList.contains('yp-feedback-form'))[0];
  assert.equal(form.hidden, false);

  let stopped = false;
  let prevented = false;
  form.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    isComposing: true,
    stopPropagation: () => {
      stopped = true;
    },
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(stopped, true, 'Feedback input keydown must stopPropagation to protect host-page hotkeys');
  assert.equal(prevented, true, 'IME composition Enter must prevent premature form submission');

  const readingInput = card.queryAll((el) => el.classList.contains('yp-feedback-input'))[0];
  const pitchInput = card.queryAll((el) => el.classList.contains('yp-feedback-pitch-input'))[0];
  readingInput.value = 'つきおうじ';
  pitchInput.value = '3';
  form.dispatchEvent({ type: 'submit' });

  assert.equal(sentRuntimeMsgs.length, 1);
  assert.equal(sentRuntimeMsgs[0].type, 'SUBMIT_FEEDBACK');
  assert.equal(sentRuntimeMsgs[0].feedback.reading, 'つきおうじ');
  assert.equal(sentRuntimeMsgs[0].feedback.contextText, '月王子の剣');

  // Card re-renders immediately with Learned ✨ badge and Undo button
  card = host.shadowRoot.queryAll((el) => el.classList.contains('yp-card'))[0];
  assert.match(card.textContent, /Learned ✨/);
  assert.match(card.textContent, /つきおうじ/);

  const undoBtn = card.queryAll((el) => el.classList.contains('yp-feedback-undo-btn'))[0];
  assert.ok(undoBtn);
  undoBtn.dispatchEvent({ type: 'click' });
  card = host.shadowRoot.queryAll((el) => el.classList.contains('yp-card'))[0];
  assert.match(card.textContent, /げつおうじ/);
});

test('Service worker fallback learner, storage failure rollback, and Offscreen monotonic revision guard', async () => {
  const dictPath = path.join(ROOT, 'data/dict.json.gz');
  const dictBytes = fs.readFileSync(dictPath);
  const origFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(dictBytes, { status: 200 });

  let messageListener = null;
  const localStore = {
    userFeedbackState: {
      version: 1,
      revision: 7,
      entries: [],
      weights: {},
    },
  };
  let failNextSet = false;

  // 1. Service Worker WITHOUT Offscreen APIs: fallback `lookupKanji` receives `{ feedbackLearner }` and propagates storage errors
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test-id/${p}`,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
    },
    contextMenus: {
      removeAll: (cb) => cb?.(),
      create: (_props, cb) => cb?.(),
      onClicked: { addListener: () => {} },
    },
    storage: {
      sync: { get: async () => ({}), set: async () => {} },
      local: {
        get: async (key) => (typeof key === 'string' ? { [key]: localStore[key] } : { ...localStore }),
        set: async (obj) => {
          if (failNextSet) {
            failNextSet = false;
            throw new Error('QUOTA_BYTES quota exceeded');
          }
          Object.assign(localStore, obj);
        },
      },
    },
    tabs: { sendMessage: async () => ({ ok: true }) },
    scripting: { executeScript: async () => {} },
  };

  try {
    await import('../src/background/service-worker.js?fallbackFeedback=1');

    // Storage write error must return ok: false and NOT commit unpersisted state
    failNextSet = true;
    const failedSave = await new Promise((resolve) => {
      messageListener(
        {
          type: 'SUBMIT_FEEDBACK',
          feedback: { surface: '月王子', reading: 'つきおうじ', pitches: '3' },
          lookupRequest: { text: '月王子' },
        },
        {},
        resolve
      );
    });
    assert.equal(failedSave.ok, false);
    assert.match(failedSave.error, /QUOTA_BYTES/);
    assert.equal(localStore.userFeedbackState.entries.length, 0);

    // Subsequent valid save increments persisted revision from 7 -> 8 and fallback lookup returns learned reading!
    const okSave = await new Promise((resolve) => {
      messageListener(
        {
          type: 'SUBMIT_FEEDBACK',
          feedback: { surface: '月王子', reading: 'つきおうじ', pitches: '3' },
          lookupRequest: { text: '月王子' },
        },
        {},
        resolve
      );
    });
    assert.equal(okSave.ok, true);
    assert.equal(localStore.userFeedbackState.revision, 8);
    assert.equal(okSave.result.learnedFromFeedback, true);
    assert.equal(okSave.result.readings[0].reading, 'つきおうじ');

    const fallbackLookup = await new Promise((resolve) => {
      messageListener({ type: 'LOOKUP_KANJI', text: '月王子' }, {}, resolve);
    });
    assert.equal(fallbackLookup.ok, true);
    assert.equal(fallbackLookup.result.learnedFromFeedback, true);
    assert.equal(fallbackLookup.result.readings[0].reading, 'つきおうじ');
  } finally {
    delete globalThis.chrome;
    globalThis.fetch = origFetch;
  }

  // 2. Offscreen monotonic revision guard: a stale lookup carrying an older `feedbackRevision` never clobbers newer learned state
  let offscreenListener = null;
  globalThis.fetch = async (url) => {
    const rel = String(url).replace('chrome-extension://test-id/', '');
    return new Response(fs.readFileSync(path.join(ROOT, rel)), { status: 200 });
  };
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test-id/${p}`,
      onMessage: {
        addListener: (fn) => {
          offscreenListener = fn;
        },
      },
    },
  };

  try {
    const offscreenMod = await import('../src/offscreen/offscreen.js?revGuard=1');
    const recRes = await new Promise((resolve) => {
      offscreenListener(
        {
          target: 'offscreen',
          type: 'OFFSCREEN_RECORD_FEEDBACK',
          feedback: { surface: '月王子', reading: 'つきおうじ', pitches: '3' },
          nextRevision: 10,
        },
        {},
        resolve
      );
    });
    assert.equal(recRes.ok, true);
    assert.equal(recRes.syncedRevision, 10);

    // Send a stale lookup carrying revision 4 + empty feedbackState -> must be ignored!
    const staleLookup = await new Promise((resolve) => {
      offscreenListener(
        {
          target: 'offscreen',
          type: 'OFFSCREEN_LOOKUP',
          payload: { text: '月王子' },
          feedbackRevision: 4,
          feedbackState: { version: 1, revision: 4, entries: [], weights: {} },
        },
        {},
        resolve
      );
    });
    assert.equal(staleLookup.ok, true);
    assert.equal(staleLookup.syncedRevision, 10);
    assert.equal(staleLookup.result.readings[0].reading, 'つきおうじ');

    // Clean up learned entry in shared singleton
    await new Promise((resolve) => {
      offscreenListener(
        { target: 'offscreen', type: 'OFFSCREEN_CLEAR_FEEDBACK', nextRevision: 11 },
        {},
        resolve
      );
    });
    const res = await offscreenMod.getOffscreenResources();
    if (res?.annotator?.dispose) {
      await res.annotator.dispose();
    }
  } finally {
    globalThis.fetch = origFetch;
    delete globalThis.chrome;
  }
});


