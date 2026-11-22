/**
 * YomiPitch Content Script
 *
 * Provides:
 *   1. Shadow-DOM floating action pill (`読み`) near highlighted Japanese Kanji text.
 *   2. Crisp Shadow-DOM reading & pitch accent intonation card on pill click or right-click context menu.
 *   3. Safe DOM construction (`createElement` + `textContent` / SVG — zero `innerHTML` injection).
 */

(() => {
  if (window.__yomiPitchInitialized) {
    return;
  }
  window.__yomiPitchInitialized = true;

  const KANJI_RE = /[\p{Script=Han}々〆ヵヶ]/u;
  const MAX_SELECTION_CHARS = 60;
  const MAX_CONTEXT_SIDE_CHARS = 100;
  const VIEWPORT_MARGIN = 10;
  const OFFSET_GAP = 8;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const BLOCK_TAGS = new Set([
    'P',
    'LI',
    'DIV',
    'ARTICLE',
    'SECTION',
    'TD',
    'TH',
    'BLOCKQUOTE',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'DD',
    'DT',
    'PRE',
    'MAIN',
    'BODY',
  ]);
  const SKIP_TAGS = new Set(['RT', 'RP', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  let showFloatingButton = true;
  let hostEl = null;
  let shadowRoot = null;
  let rootContainer = null;
  let currentMode = 'hidden'; // 'hidden' | 'pill' | 'card'
  let activeSelectionText = '';
  let activeSelectionDetails = null;
  let activeCardRequest = null;
  let anchorRect = null;
  let selectionTimer = null;
  let lookupRequestId = 0;
  let feedbackOperationId = 0;
  let contextInvalidated = false;

  function isExtensionContextValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  // Load initial setting and subscribe to live updates
  if (isExtensionContextValid() && chrome.storage?.sync) {
    try {
      chrome.storage.sync.get({ showFloatingButton: true }, (items) => {
        try {
          if (!isExtensionContextValid()) {
            return;
          }
          if (!chrome.runtime?.lastError && items) {
            showFloatingButton = Boolean(items.showFloatingButton);
            if (!showFloatingButton && currentMode === 'pill') {
              dismissUI();
            }
          }
        } catch {
          // Ignore invalidated context during async storage callback
        }
      });

      chrome.storage.onChanged?.addListener((changes, areaName) => {
        if (areaName === 'sync' && changes.showFloatingButton) {
          showFloatingButton = Boolean(changes.showFloatingButton.newValue);
          if (!showFloatingButton && currentMode === 'pill') {
            dismissUI();
          }
        }
      });
    } catch {
      contextInvalidated = true;
    }
  }

  const SHADOW_STYLES = `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", "Meiryo", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    .yp-surface {
      --yp-bg: #ffffff;
      --yp-bg-subtle: #f8fafc;
      --yp-bg-hover: #f1f5f9;
      --yp-text: #0f172a;
      --yp-text-muted: #64748b;
      --yp-border: rgba(15, 23, 42, 0.12);
      --yp-accent: #4f46e5;
      --yp-accent-soft: rgba(79, 70, 229, 0.1);
      --yp-pitch: #e11d48;
      --yp-tie-bg: #fef3c7;
      --yp-tie-text: #92400e;
      --yp-shadow: 0 12px 32px -4px rgba(15, 23, 42, 0.18), 0 4px 12px -2px rgba(15, 23, 42, 0.08);
      color: var(--yp-text);
      pointer-events: auto;
      position: fixed;
      user-select: none;
      -webkit-user-select: none;
    }

    @media (prefers-color-scheme: dark) {
      .yp-surface {
        --yp-bg: #1e1f2e;
        --yp-bg-subtle: #27293d;
        --yp-bg-hover: #32354e;
        --yp-text: #f8fafc;
        --yp-text-muted: #94a3b8;
        --yp-border: rgba(248, 250, 252, 0.14);
        --yp-accent: #818cf8;
        --yp-accent-soft: rgba(129, 140, 248, 0.16);
        --yp-pitch: #fb7185;
        --yp-tie-bg: rgba(251, 191, 36, 0.18);
        --yp-tie-text: #fde68a;
        --yp-shadow: 0 14px 36px -4px rgba(0, 0, 0, 0.55), 0 4px 14px -2px rgba(0, 0, 0, 0.35);
      }
    }

    @keyframes yp-pop {
      from {
        opacity: 0;
        transform: translateY(3px) scale(0.97);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .yp-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      padding: 0 11px 0 9px;
      border-radius: 999px;
      border: 1px solid var(--yp-border);
      background: var(--yp-bg);
      color: var(--yp-text);
      box-shadow: var(--yp-shadow);
      cursor: pointer;
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
      line-height: 1;
      animation: yp-pop 120ms cubic-bezier(0.16, 1, 0.3, 1);
      transition: transform 120ms ease, border-color 120ms ease, background-color 120ms ease;
    }

    .yp-pill:hover {
      background: var(--yp-bg-subtle);
      border-color: var(--yp-accent);
      transform: translateY(-1px);
    }

    .yp-pill:active {
      transform: translateY(0);
    }

    .yp-pill-icon {
      width: 14px;
      height: 14px;
      color: var(--yp-pitch);
      flex-shrink: 0;
    }

    .yp-card {
      width: max-content;
      min-width: 240px;
      max-width: min(380px, calc(100vw - 20px));
      max-height: min(440px, calc(100vh - 20px));
      overflow-y: auto;
      background: var(--yp-bg);
      border: 1px solid var(--yp-border);
      border-radius: 14px;
      box-shadow: var(--yp-shadow);
      padding: 12px 14px;
      animation: yp-pop 140ms cubic-bezier(0.16, 1, 0.3, 1);
      user-select: text;
      -webkit-user-select: text;
    }

    .yp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-bottom: 8px;
      margin-bottom: 10px;
      border-bottom: 1px solid var(--yp-border);
    }

    .yp-header-left {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    .yp-surface-word {
      font-size: 15px;
      font-weight: 700;
      color: var(--yp-text);
      word-break: break-all;
    }

    .yp-tag {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 600;
      background: var(--yp-accent-soft);
      color: var(--yp-accent);
      white-space: nowrap;
    }

    .yp-tag-tie {
      background: var(--yp-tie-bg);
      color: var(--yp-tie-text);
    }

    .yp-close-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--yp-text-muted);
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      flex-shrink: 0;
    }

    .yp-close-btn:hover {
      background: var(--yp-bg-hover);
      color: var(--yp-text);
    }

    .yp-readings-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .yp-reading-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      border-radius: 10px;
      background: var(--yp-bg-subtle);
      border: 1px solid transparent;
    }

    .yp-reading-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .yp-reading-left {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .yp-reading-plain {
      font-size: 23px;
      font-weight: 700;
      line-height: 1.3;
      letter-spacing: 0.03em;
      color: var(--yp-text);
    }

    /* Visual pitch accent mora contour */
    .yp-mora-row {
      display: inline-flex;
      align-items: flex-end;
      padding-top: 5px;
      font-size: 23px;
      font-weight: 700;
      line-height: 1.25;
      color: var(--yp-text);
    }

    .yp-mora {
      position: relative;
      display: inline-block;
      padding: 2px 1.5px 0;
      border-top: 2.5px solid transparent;
    }

    .yp-mora-high {
      border-top-color: var(--yp-pitch);
    }

    .yp-mora-rise::before {
      content: "";
      position: absolute;
      left: -1.5px;
      top: -2.5px;
      width: 2.5px;
      height: 8px;
      background: var(--yp-pitch);
      border-radius: 1px;
    }

    .yp-mora-drop::after {
      content: "";
      position: absolute;
      right: -1.5px;
      top: -2.5px;
      width: 2.5px;
      height: 11px;
      background: var(--yp-pitch);
      border-radius: 1px;
    }

    .yp-pitch-badges {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }

    .yp-pitch-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 6px;
      border-radius: 6px;
      border: 1px solid var(--yp-border);
      background: var(--yp-bg);
      color: var(--yp-pitch);
      font-size: 11.5px;
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      cursor: default;
    }

    .yp-pitch-badge-interactive {
      cursor: pointer;
    }

    .yp-pitch-badge-active {
      border-color: var(--yp-pitch);
      background: rgba(225, 29, 72, 0.08);
    }

    .yp-pitch-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--yp-text-muted);
      font-family: inherit;
    }

    .yp-pitch-none {
      color: var(--yp-text-muted);
      font-weight: 500;
      font-family: inherit;
      font-size: 11px;
    }

    .yp-trunc-note {
      margin-top: 6px;
      font-size: 11px;
      color: var(--yp-text-muted);
    }

    .yp-actions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
    }

    .yp-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 26px;
      padding: 0 7px;
      border-radius: 6px;
      border: 1px solid var(--yp-border);
      background: var(--yp-bg);
      color: var(--yp-text-muted);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 120ms ease;
    }

    .yp-icon-btn:hover {
      color: var(--yp-text);
      border-color: var(--yp-accent);
      background: var(--yp-bg-hover);
    }

    .yp-icon-btn-copied {
      color: #16a34a;
      border-color: #16a34a;
    }

    .yp-base-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      font-size: 11.5px;
      color: var(--yp-text-muted);
      padding-top: 4px;
      border-top: 1px dashed var(--yp-border);
    }

    .yp-mora-row-mini {
      font-size: 12.5px;
      font-weight: 600;
      padding-top: 2px;
    }

    .yp-mora-row-mini .yp-mora {
      border-top-width: 2px;
      padding: 1px 1px 0;
    }

    .yp-mora-row-mini .yp-mora-rise::before {
      width: 2px;
      height: 5px;
      top: -2px;
      left: -1px;
    }

    .yp-mora-row-mini .yp-mora-drop::after {
      width: 2px;
      height: 7px;
      top: -2px;
      right: -1px;
    }

    .yp-segments {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--yp-border);
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .yp-segments-title {
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--yp-text-muted);
    }

    .yp-segments-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .yp-seg-chip {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 4px 8px;
      border-radius: 8px;
      background: var(--yp-bg-subtle);
      border: 1px solid var(--yp-border);
    }

    .yp-seg-top {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11.5px;
      color: var(--yp-accent);
      font-weight: 600;
    }

    .yp-seg-surface {
      font-size: 13px;
      font-weight: 700;
      color: var(--yp-text);
    }

    .yp-empty {
      font-size: 13px;
      color: var(--yp-text-muted);
      padding: 4px 2px;
    }

    .yp-tag-ai {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.14), rgba(14, 165, 233, 0.14));
      color: var(--yp-accent);
      border: 1px solid rgba(79, 70, 229, 0.22);
    }

    .yp-tag-learned {
      background: rgba(16, 185, 129, 0.14);
      color: #059669;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    @media (prefers-color-scheme: dark) {
      .yp-tag-learned {
        background: rgba(16, 185, 129, 0.2);
        color: #6ee7b7;
        border-color: rgba(110, 231, 183, 0.32);
      }
    }

    .yp-feedback-wrap {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--yp-border);
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .yp-feedback-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 6px;
    }

    .yp-feedback-bar-left {
      display: inline-flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }

    .yp-feedback-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 25px;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid var(--yp-border);
      background: var(--yp-bg-subtle);
      color: var(--yp-text-muted);
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 120ms ease;
    }

    .yp-feedback-btn:hover {
      color: var(--yp-accent);
      border-color: var(--yp-accent);
      background: var(--yp-accent-soft);
    }

    .yp-feedback-undo-btn:hover {
      color: var(--yp-pitch);
      border-color: var(--yp-pitch);
      background: rgba(225, 29, 72, 0.08);
    }

    .yp-feedback-toast {
      font-size: 11px;
      font-weight: 600;
      color: #059669;
    }

    @media (prefers-color-scheme: dark) {
      .yp-feedback-toast {
        color: #6ee7b7;
      }
    }

    .yp-feedback-form {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 9px;
      border-radius: 9px;
      background: var(--yp-bg-subtle);
      border: 1px solid var(--yp-border);
    }

    .yp-feedback-form[hidden],
    .yp-feedback-error[hidden] {
      display: none !important;
    }

    .yp-feedback-hint {
      font-size: 11px;
      color: var(--yp-text-muted);
    }

    .yp-feedback-inputs {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .yp-feedback-input,
    .yp-feedback-pitch-input {
      height: 30px;
      padding: 0 8px;
      border-radius: 7px;
      border: 1px solid var(--yp-border);
      background: var(--yp-bg);
      color: var(--yp-text);
      font-family: inherit;
      font-size: 13px;
      outline: none;
      user-select: text;
      -webkit-user-select: text;
    }

    .yp-feedback-input {
      flex: 1;
      min-width: 120px;
    }

    .yp-feedback-pitch-input {
      width: 82px;
      font-size: 12px;
    }

    .yp-feedback-input:focus,
    .yp-feedback-pitch-input:focus {
      border-color: var(--yp-accent);
      box-shadow: 0 0 0 2px var(--yp-accent-soft);
    }

    .yp-feedback-controls {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
    }

    .yp-feedback-save-btn {
      height: 27px;
      padding: 0 10px;
      border: none;
      border-radius: 6px;
      background: var(--yp-accent);
      color: #ffffff;
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
    }

    .yp-feedback-save-btn:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .yp-feedback-cancel-btn {
      height: 27px;
      padding: 0 8px;
      border: 1px solid var(--yp-border);
      border-radius: 6px;
      background: var(--yp-bg);
      color: var(--yp-text-muted);
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
    }

    .yp-feedback-error {
      font-size: 11px;
      color: var(--yp-pitch);
      font-weight: 600;
    }

    .yp-kanji-details {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--yp-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .yp-kd-row {
      display: flex;
      align-items: baseline;
      gap: 7px;
      flex-wrap: wrap;
    }

    .yp-kd-label {
      font-size: 10.5px;
      font-weight: 700;
      color: var(--yp-text-muted);
      min-width: 68px;
      flex-shrink: 0;
    }

    .yp-kd-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      flex: 1;
    }

    .yp-kd-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 6px;
      border-radius: 6px;
      background: var(--yp-bg-subtle);
      border: 1px solid var(--yp-border);
      font-size: 12px;
      font-weight: 600;
      color: var(--yp-text);
    }

    .yp-kd-pitch {
      font-size: 10.5px;
      font-weight: 700;
      color: var(--yp-pitch);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .yp-card-footer {
      margin-top: 9px;
      padding-top: 6px;
      border-top: 1px solid var(--yp-border);
      display: flex;
      justify-content: flex-end;
      font-size: 10px;
      color: var(--yp-text-muted);
    }

    .yp-attr-link {
      color: var(--yp-text-muted);
      text-decoration: none;
    }

    .yp-attr-link:hover {
      color: var(--yp-accent);
      text-decoration: underline;
    }
  `;

  function ensureHost() {
    if (hostEl && document.documentElement.contains(hostEl)) {
      return;
    }
    hostEl = document.createElement('div');
    hostEl.setAttribute('data-yomipitch-root', 'true');
    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = SHADOW_STYLES;
    shadowRoot.appendChild(styleEl);

    rootContainer = document.createElement('div');
    shadowRoot.appendChild(rootContainer);

    (document.body || document.documentElement).appendChild(hostEl);
  }

  function clearContainer() {
    if (!rootContainer) return;
    while (rootContainer.firstChild) {
      rootContainer.removeChild(rootContainer.firstChild);
    }
  }

  function dismissUI() {
    ++lookupRequestId;
    ++feedbackOperationId;
    currentMode = 'hidden';
    activeSelectionText = '';
    activeSelectionDetails = null;
    activeCardRequest = null;
    anchorRect = null;
    clearContainer();
  }

  function showNoticeCard(messageText, rect) {
    ensureHost();
    clearContainer();
    currentMode = 'card';
    anchorRect = rect;

    const card = document.createElement('div');
    card.className = 'yp-surface yp-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'YomiPitch notice');

    const header = document.createElement('div');
    header.className = 'yp-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'yp-header-left';

    const title = document.createElement('span');
    title.className = 'yp-surface-word';
    title.textContent = 'YomiPitch';
    headerLeft.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'yp-close-btn';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => dismissUI());

    header.appendChild(headerLeft);
    header.appendChild(closeBtn);
    card.appendChild(header);

    const msg = document.createElement('div');
    msg.className = 'yp-empty';
    msg.textContent = messageText;
    card.appendChild(msg);

    rootContainer.appendChild(card);
    positionElementNearSelection(card, rect);
  }

  function isEditableTarget(node) {
    if (!node) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return true;
    }
    return Boolean(el.isContentEditable);
  }

  function findBlockAncestor(node) {
    let cur = node?.nodeType === 1 ? node : node?.parentElement || node?.parentNode || null;
    while (cur && cur.nodeType === 1) {
      if (BLOCK_TAGS.has(String(cur.tagName || '').toUpperCase())) {
        return cur;
      }
      cur = cur.parentElement || cur.parentNode || null;
    }
    return document.body || document.documentElement || null;
  }

  function hasSkippedDescendant(root) {
    if (!root) return false;
    if (typeof root.querySelector === 'function') {
      return Boolean(root.querySelector('rt, rp, script, style, noscript, template, [data-yomipitch-root]'));
    }
    const children = root.childNodes || root.children || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child || child.nodeType !== 1) continue;
      if (
        SKIP_TAGS.has(String(child.tagName || '').toUpperCase()) ||
        child.getAttribute?.('data-yomipitch-root') === 'true' ||
        hasSkippedDescendant(child)
      ) {
        return true;
      }
    }
    return false;
  }

  function nodeContains(root, target) {
    if (!root || !target) return false;
    if (typeof root.contains === 'function') {
      return root.contains(target);
    }
    let cur = target;
    while (cur) {
      if (cur === root) return true;
      cur = cur.parentNode || cur.parentElement || null;
    }
    return false;
  }

  /**
   * Walks `blockEl` in document order while skipping `<rt>`/`<rp>` ruby annotations and scripts,
   * partitioning clean text into `{ beforeText, selectedText, afterText }` around `range`.
   */
  function extractCleanPartsFromDom(blockEl, range) {
    const beforeParts = [];
    const selectedParts = [];
    const afterParts = [];
    let state = 'before'; // 'before' | 'inside' | 'after'

    function visit(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        const val = node.nodeValue ?? node.textContent ?? '';
        const isStart = node === range.startContainer;
        const isEnd = node === range.endContainer;
        if (isStart && isEnd) {
          beforeParts.push(val.slice(0, range.startOffset));
          selectedParts.push(val.slice(range.startOffset, range.endOffset));
          afterParts.push(val.slice(range.endOffset));
          state = 'after';
        } else if (isStart) {
          beforeParts.push(val.slice(0, range.startOffset));
          selectedParts.push(val.slice(range.startOffset));
          state = 'inside';
        } else if (isEnd) {
          selectedParts.push(val.slice(0, range.endOffset));
          afterParts.push(val.slice(range.endOffset));
          state = 'after';
        } else if (state === 'before') {
          beforeParts.push(val);
        } else if (state === 'inside') {
          selectedParts.push(val);
        } else {
          afterParts.push(val);
        }
        return;
      }

      if (node.nodeType === 1) {
        const children = node.childNodes || node.children || [];
        for (let i = 0; i <= children.length; i++) {
          if (node === range.startContainer && range.startOffset === i) {
            state = 'inside';
          }
          if (node === range.endContainer && range.endOffset === i) {
            state = 'after';
          }
          if (i < children.length) {
            const child = children[i];
            if (!child) continue;
            if (
              child.nodeType === 1 &&
              (SKIP_TAGS.has(String(child.tagName || '').toUpperCase()) ||
                child.getAttribute?.('data-yomipitch-root') === 'true')
            ) {
              if (nodeContains(child, range.startContainer)) {
                state = 'inside';
              }
              if (nodeContains(child, range.endContainer)) {
                state = 'after';
              }
              continue;
            }
            visit(child);
          }
        }
      }
    }

    visit(blockEl);
    return {
      beforeText: beforeParts.join(''),
      selectedText: selectedParts.join(''),
      afterText: afterParts.join(''),
    };
  }

  function trimSentenceWindow(beforeRaw, selectedTrimmed, afterRaw) {
    // Trim `beforeRaw` to after the last sentence terminator / line break
    let beforeSlice = beforeRaw;
    const beforeBoundaryRe = /[。！？!?\n\r]/gu;
    let lastMatchEnd = 0;
    let m;
    while ((m = beforeBoundaryRe.exec(beforeSlice)) !== null) {
      lastMatchEnd = m.index + m[0].length;
    }
    if (lastMatchEnd > 0) {
      beforeSlice = beforeSlice.slice(lastMatchEnd);
    }
    if (beforeSlice.length > MAX_CONTEXT_SIDE_CHARS) {
      let cut = beforeSlice.length - MAX_CONTEXT_SIDE_CHARS;
      const code = beforeSlice.charCodeAt(cut);
      if (code >= 0xdc00 && code <= 0xdfff) {
        cut += 1;
      }
      beforeSlice = beforeSlice.slice(cut);
    }

    // Trim `afterRaw` up to the first sentence terminator / line break
    let afterSlice = afterRaw;
    const afterBoundaryMatch = /[。！？!?\n\r]/u.exec(afterSlice);
    if (afterBoundaryMatch) {
      const ch = afterBoundaryMatch[0];
      const includePunct = ch !== '\n' && ch !== '\r';
      afterSlice = afterSlice.slice(
        0,
        afterBoundaryMatch.index + (includePunct ? ch.length : 0)
      );
    }
    if (afterSlice.length > MAX_CONTEXT_SIDE_CHARS) {
      let cut = MAX_CONTEXT_SIDE_CHARS;
      const code = afterSlice.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        cut -= 1;
      }
      afterSlice = afterSlice.slice(0, cut);
    }

    const contextText = beforeSlice + selectedTrimmed + afterSlice;
    const contextStart = beforeSlice.length;
    const contextEnd = contextStart + selectedTrimmed.length;

    if (contextText.slice(contextStart, contextEnd) !== selectedTrimmed) {
      return { contextText: '', contextStart: -1, contextEnd: -1 };
    }
    return { contextText, contextStart, contextEnd };
  }

  /**
   * Extracts clean selection text AND surrounding webpage sentence context (excluding `<rt>`/`<rp>`).
   */
  function extractSelectionAndContext(sel) {
    const fallbackRaw = sel.toString();
    const fallbackTrimmed = fallbackRaw.trim();
    if (!sel.rangeCount) {
      return { text: fallbackTrimmed, contextText: '', contextStart: -1, contextEnd: -1 };
    }

    const range = sel.getRangeAt(0);
    if (!range || !range.startContainer || !range.endContainer) {
      return { text: fallbackTrimmed, contextText: '', contextStart: -1, contextEnd: -1 };
    }

    const ancestor = range.commonAncestorContainer || range.startContainer;
    const blockEl = findBlockAncestor(ancestor);
    if (!blockEl || !nodeContains(blockEl, range.startContainer)) {
      return { text: fallbackTrimmed, contextText: '', contextStart: -1, contextEnd: -1 };
    }

    let beforeText = '';
    let selectedRaw = fallbackRaw;
    let afterText = '';

    try {
      if (hasSkippedDescendant(blockEl) || typeof document.createRange !== 'function') {
        const parts = extractCleanPartsFromDom(blockEl, range);
        if (parts.selectedText) {
          beforeText = parts.beforeText;
          selectedRaw = parts.selectedText;
          afterText = parts.afterText;
        }
      } else {
        const beforeRange = document.createRange();
        beforeRange.selectNodeContents(blockEl);
        beforeRange.setEnd(range.startContainer, range.startOffset);
        beforeText = beforeRange.toString();

        selectedRaw = range.toString() || fallbackRaw;

        const afterRange = document.createRange();
        afterRange.selectNodeContents(blockEl);
        afterRange.setStart(range.endContainer, range.endOffset);
        afterText = afterRange.toString();
      }
    } catch {
      return { text: fallbackTrimmed, contextText: '', contextStart: -1, contextEnd: -1 };
    }

    const leadWs = /^\s+/u.exec(selectedRaw)?.[0] || '';
    const rest = selectedRaw.slice(leadWs.length);
    const trailWs = /\s+$/u.exec(rest)?.[0] || '';
    const trimmed = trailWs ? rest.slice(0, rest.length - trailWs.length) : rest;
    if (!trimmed) {
      return { text: '', contextText: '', contextStart: -1, contextEnd: -1 };
    }

    const win = trimSentenceWindow(beforeText + leadWs, trimmed, trailWs + afterText);
    return {
      text: trimmed,
      contextText: win.contextText,
      contextStart: win.contextStart,
      contextEnd: win.contextEnd,
    };
  }

  function getSelectionDetails(allowNonKanji = false) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      return null;
    }
    if (isEditableTarget(sel.anchorNode) || isEditableTarget(document.activeElement)) {
      return null;
    }

    const extracted = extractSelectionAndContext(sel);
    const raw = extracted.text;
    if (!raw) {
      return null;
    }
    const codePoints = Array.from(raw);
    if (!allowNonKanji && (codePoints.length > MAX_SELECTION_CHARS || !KANJI_RE.test(raw))) {
      return null;
    }

    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect?.();
    if ((!rect || (rect.width === 0 && rect.height === 0)) && range.getClientRects?.().length > 0) {
      rect = range.getClientRects()[0];
    }
    const normalizedRect =
      !rect || (rect.width === 0 && rect.height === 0)
        ? null
        : {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
          };

    return {
      text: raw,
      contextText: extracted.contextText,
      contextStart: extracted.contextStart,
      contextEnd: extracted.contextEnd,
      rect: normalizedRect,
    };
  }

  /**
   * Positions a floating element near `rect` without overlapping the selected text itself,
   * clamped strictly within viewport bounds. Falls back to top-right toast if `rect` is null.
   */
  function positionElementNearSelection(el, rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Measure natural size first
    el.style.left = '0px';
    el.style.top = '0px';
    const box = el.getBoundingClientRect();
    const w = box.width || 120;
    const h = box.height || 36;

    if (!rect) {
      el.style.left = `${Math.max(VIEWPORT_MARGIN, vw - w - 16)}px`;
      el.style.top = '16px';
      return;
    }

    // Prefer placing above selection; if insufficient room above, place below selection
    let top = rect.top - h - OFFSET_GAP;
    if (top < VIEWPORT_MARGIN) {
      top = rect.bottom + OFFSET_GAP;
    }
    if (top + h > vh - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN);
    }

    let left = rect.left;
    if (left + w > vw - VIEWPORT_MARGIN) {
      left = vw - w - VIEWPORT_MARGIN;
    }
    left = Math.max(VIEWPORT_MARGIN, left);

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function createSvgIcon(paths, viewBox = '0 0 24 24', className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (className) {
      svg.setAttribute('class', className);
    }
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  function renderMoraContourElement(contour, isMini = false) {
    const row = document.createElement('span');
    row.className = isMini ? 'yp-mora-row yp-mora-row-mini' : 'yp-mora-row';
    if (contour.tooltip) {
      row.title = contour.tooltip;
    }

    contour.morae.forEach((mora, idx) => {
      const span = document.createElement('span');
      const classes = ['yp-mora'];
      if (mora.high) {
        classes.push('yp-mora-high');
        if (idx > 0 && !contour.morae[idx - 1].high) {
          classes.push('yp-mora-rise');
        }
      }
      if (mora.dropAfter) {
        classes.push('yp-mora-drop');
      }
      span.className = classes.join(' ');
      span.textContent = mora.text;
      row.appendChild(span);
    });

    return row;
  }

  async function copyText(text, btn) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch {
        copied = false;
      }
    }

    if (copied && btn) {
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('yp-icon-btn-copied');
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove('yp-icon-btn-copied');
      }, 1300);
    }
  }

  function speakJapanese(text) {
    if (!('speechSynthesis' in window) || !text) {
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'ja-JP';
      utter.rate = 0.95;
      const voices = window.speechSynthesis.getVoices?.() || [];
      const jaVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('ja'));
      if (jaVoice) {
        utter.voice = jaVoice;
      }
      window.speechSynthesis.speak(utter);
    } catch {
      // Ignore speech synthesis errors on unsupported platforms
    }
  }

  function showPill(details) {
    if (!showFloatingButton) {
      return;
    }
    const { text, rect } = details;
    ensureHost();
    clearContainer();
    currentMode = 'pill';
    activeSelectionText = text;
    activeSelectionDetails = details;
    anchorRect = rect;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'yp-surface yp-pill';
    btn.setAttribute('aria-label', `Show reading for ${text}`);

    // Pitch-step icon + 読み label
    const icon = createSvgIcon(['M3 16h5V8h9v8', 'M17 16h4'], '0 0 24 24', 'yp-pill-icon');
    const label = document.createElement('span');
    label.textContent = '読み';

    btn.appendChild(icon);
    btn.appendChild(label);

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const liveDetails = getSelectionDetails();
      const effectiveDetails =
        liveDetails && liveDetails.text === text ? liveDetails : activeSelectionDetails || details;
      const liveRect = effectiveDetails?.rect || anchorRect;
      anchorRect = liveRect;
      triggerLookupFromPill(effectiveDetails, liveRect, label);
    });

    rootContainer.appendChild(btn);
    positionElementNearSelection(btn, rect);
  }

  function handleContextInvalidated(rect, showNotice = false) {
    contextInvalidated = true;
    clearTimeout(selectionTimer);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('selectionchange', onSelectionChange);
    if (showNotice) {
      ++lookupRequestId;
      showNoticeCard('Extension updated — please refresh this page', rect);
    } else {
      dismissUI();
    }
  }

  function triggerLookupFromPill(details, rect, labelEl) {
    const text = details?.text || '';
    if (contextInvalidated || !isExtensionContextValid()) {
      handleContextInvalidated(rect, true);
      return;
    }

    const reqId = ++lookupRequestId;
    if (labelEl) {
      labelEl.textContent = '…';
    }

    const requestPayload = {
      text,
      contextText: details?.contextText || '',
      contextStart: typeof details?.contextStart === 'number' ? details.contextStart : -1,
      contextEnd: typeof details?.contextEnd === 'number' ? details.contextEnd : -1,
    };

    try {
      chrome.runtime.sendMessage(
        {
          type: 'LOOKUP_KANJI',
          ...requestPayload,
          saveLast: true,
        },
        (response) => {
          if (reqId !== lookupRequestId) {
            return;
          }
          if (!isExtensionContextValid()) {
            handleContextInvalidated(getSelectionDetails()?.rect || rect, true);
            return;
          }
          const targetRect = getSelectionDetails()?.rect || rect;
          if (chrome.runtime?.lastError || !response?.ok) {
            const errMsg = chrome.runtime?.lastError?.message || '';
            if (/context invalidated/i.test(errMsg)) {
              handleContextInvalidated(targetRect, true);
              return;
            }
            showCard(
              {
                query: text,
                normalized: text,
                found: false,
                hasKanji: KANJI_RE.test(text),
                matchType: 'none',
                isTied: false,
                readings: [],
                segments: [],
              },
              targetRect,
              requestPayload
            );
            return;
          }
          showCard(response.result, targetRect, requestPayload);
        }
      );
    } catch {
      handleContextInvalidated(rect, true);
    }
  }

  function buildReadingRow(cand) {
    const item = document.createElement('div');
    item.className = 'yp-reading-item';

    const main = document.createElement('div');
    main.className = 'yp-reading-main';

    const left = document.createElement('div');
    left.className = 'yp-reading-left';

    const contours = Array.isArray(cand.pitchContours) ? cand.pitchContours : [];
    let readingDisplayHolder = document.createElement('span');

    if (contours.length > 0) {
      readingDisplayHolder.appendChild(renderMoraContourElement(contours[0], false));
      left.appendChild(readingDisplayHolder);

      const badgeGroup = document.createElement('span');
      badgeGroup.className = 'yp-pitch-badges';

      contours.forEach((c, idx) => {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className =
          'yp-pitch-badge' +
          (contours.length > 1 ? ' yp-pitch-badge-interactive' : '') +
          (idx === 0 ? ' yp-pitch-badge-active' : '');
        const baseTooltip = c.tooltip || `${c.pitch}: ${c.labelJa}`;
        badge.title =
          cand.pitchScope === 'standalone'
            ? `Standalone word accent (${baseTooltip}) — compound pitch may shift in context`
            : baseTooltip;
        badge.textContent =
          cand.pitchScope === 'standalone' ? `standalone [${c.pitch}]` : `[${c.pitch}]`;

        const patSpan = document.createElement('span');
        patSpan.className = 'yp-pitch-label';
        patSpan.textContent = c.labelJa;
        badge.appendChild(patSpan);

        if (contours.length > 1) {
          badge.addEventListener('click', () => {
            while (readingDisplayHolder.firstChild) {
              readingDisplayHolder.removeChild(readingDisplayHolder.firstChild);
            }
            readingDisplayHolder.appendChild(renderMoraContourElement(c, false));
            Array.from(badgeGroup.children).forEach((b, bIdx) => {
              b.classList.toggle('yp-pitch-badge-active', bIdx === idx);
            });
          });
        }

        badgeGroup.appendChild(badge);
      });

      left.appendChild(badgeGroup);
    } else {
      const plain = document.createElement('span');
      plain.className = 'yp-reading-plain';
      plain.textContent = cand.reading;
      left.appendChild(plain);

      if (!cand.base) {
        const noPitchBadge = document.createElement('span');
        noPitchBadge.className = 'yp-pitch-badge yp-pitch-none';
        noPitchBadge.title = 'No pitch accent entry recorded for this form';
        noPitchBadge.textContent = 'Intonation: —';
        left.appendChild(noPitchBadge);
      }
    }

    main.appendChild(left);

    // Copy + Speech synthesis action buttons
    const actions = document.createElement('div');
    actions.className = 'yp-actions';

    if ('speechSynthesis' in window) {
      const speakBtn = document.createElement('button');
      speakBtn.type = 'button';
      speakBtn.className = 'yp-icon-btn';
      speakBtn.title = 'Listen (ja-JP)';
      speakBtn.setAttribute('aria-label', `Listen to ${cand.reading}`);
      speakBtn.textContent = '🔊';
      speakBtn.addEventListener('click', () => speakJapanese(cand.reading));
      actions.appendChild(speakBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'yp-icon-btn';
    copyBtn.title = 'Copy reading';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      void copyText(cand.reading, copyBtn);
    });
    actions.appendChild(copyBtn);

    main.appendChild(actions);
    item.appendChild(main);

    // Base dictionary form & pitch accent metadata for conjugated words
    if (cand.base) {
      const meta = document.createElement('div');
      meta.className = 'yp-base-meta';

      const baseContours = cand.base.pitchContours || [];
      const basePitches = cand.base.pitches || [];
      const hasOwnPitch = contours.length > 0 || (cand.pitches?.length || 0) > 0;

      if (!hasOwnPitch && (baseContours.length > 0 || basePitches.length > 0)) {
        const baseLabel = document.createElement('span');
        baseLabel.textContent = `Intonation: base form ${cand.base.surface}`;
        meta.appendChild(baseLabel);

        if (baseContours.length > 0) {
          meta.appendChild(renderMoraContourElement(baseContours[0], true));
          for (const bc of baseContours) {
            const bBadge = document.createElement('span');
            bBadge.className = 'yp-pitch-badge';
            bBadge.title = bc.tooltip || `${bc.pitch}: ${bc.labelJa}`;
            bBadge.textContent = `[${bc.pitch}]`;
            meta.appendChild(bBadge);
          }
        } else {
          for (const p of basePitches) {
            const bBadge = document.createElement('span');
            bBadge.className = 'yp-pitch-badge';
            bBadge.textContent = `[${p}]`;
            meta.appendChild(bBadge);
          }
        }
      } else if (!hasOwnPitch) {
        const baseLabel = document.createElement('span');
        baseLabel.textContent = `Base: ${cand.base.surface} (${cand.base.reading})`;
        meta.appendChild(baseLabel);

        const noPitchBadge = document.createElement('span');
        noPitchBadge.className = 'yp-pitch-badge yp-pitch-none';
        noPitchBadge.textContent = 'Intonation: —';
        meta.appendChild(noPitchBadge);
      } else {
        const baseLabel = document.createElement('span');
        baseLabel.textContent = `Base: ${cand.base.surface}`;
        meta.appendChild(baseLabel);

        if (baseContours.length > 0) {
          meta.appendChild(renderMoraContourElement(baseContours[0], true));
          for (const bc of baseContours) {
            const bBadge = document.createElement('span');
            bBadge.className = 'yp-pitch-badge';
            bBadge.title = bc.tooltip || `${bc.pitch}: ${bc.labelJa}`;
            bBadge.textContent = `[${bc.pitch}]`;
            meta.appendChild(bBadge);
          }
        } else {
          const baseRead = document.createElement('span');
          baseRead.textContent = `(${cand.base.reading})`;
          meta.appendChild(baseRead);
        }
      }

      if (cand.base.ruleLabel) {
        const ruleTag = document.createElement('span');
        ruleTag.className = 'yp-tag';
        ruleTag.textContent = cand.base.ruleLabel;
        meta.appendChild(ruleTag);
      }

      item.appendChild(meta);
    }

    return item;
  }

  function buildKanjiDetailsSection(result) {
    const kd = result.kanjiDetails;
    if (!kd) return null;

    const kun = Array.isArray(kd.kun) ? kd.kun : [];
    const on = Array.isArray(kd.on) ? kd.on : [];
    const allWords = Array.isArray(kd.allWords) ? kd.allWords : [];
    const topReading = result.readings?.[0]?.reading || '';
    const extraWords = result.hasContext
      ? allWords.filter(([r]) => r && r !== topReading)
      : [];

    if (kun.length === 0 && on.length === 0 && extraWords.length === 0) {
      return null;
    }

    const wrap = document.createElement('div');
    wrap.className = 'yp-kanji-details';

    if (extraWords.length > 0) {
      const row = document.createElement('div');
      row.className = 'yp-kd-row';
      const label = document.createElement('span');
      label.className = 'yp-kd-label';
      label.textContent = 'Other words';
      row.appendChild(label);

      const chips = document.createElement('div');
      chips.className = 'yp-kd-chips';
      for (const [r, pitches] of extraWords) {
        const chip = document.createElement('span');
        chip.className = 'yp-kd-chip';
        chip.textContent = r;
        if (Array.isArray(pitches) && pitches.length > 0) {
          const pSpan = document.createElement('span');
          pSpan.className = 'yp-kd-pitch';
          pSpan.textContent = `[${pitches.join(',')}]`;
          chip.appendChild(pSpan);
        }
        chips.appendChild(chip);
      }
      row.appendChild(chips);
      wrap.appendChild(row);
    }

    if (kun.length > 0) {
      const row = document.createElement('div');
      row.className = 'yp-kd-row';
      const label = document.createElement('span');
      label.className = 'yp-kd-label';
      label.textContent = '訓読み (Kun)';
      row.appendChild(label);

      const chips = document.createElement('div');
      chips.className = 'yp-kd-chips';
      for (const k of kun) {
        const chip = document.createElement('span');
        chip.className = 'yp-kd-chip';
        chip.textContent = k;
        chips.appendChild(chip);
      }
      row.appendChild(chips);
      wrap.appendChild(row);
    }

    if (on.length > 0) {
      const row = document.createElement('div');
      row.className = 'yp-kd-row';
      const label = document.createElement('span');
      label.className = 'yp-kd-label';
      label.textContent = '音読み (On)';
      row.appendChild(label);

      const chips = document.createElement('div');
      chips.className = 'yp-kd-chips';
      for (const o of on) {
        const chip = document.createElement('span');
        chip.className = 'yp-kd-chip';
        chip.textContent = o;
        chips.appendChild(chip);
      }
      row.appendChild(chips);
      wrap.appendChild(row);
    }

    return wrap;
  }

  function buildFeedbackSection(result, requestMeta, card, statusToast = '') {
    const surface = String(result.normalized || result.query || requestMeta?.text || '').trim();
    if (!surface || (!result.hasKanji && !KANJI_RE.test(surface))) {
      return null;
    }

    const wrap = document.createElement('div');
    wrap.className = 'yp-feedback-wrap';

    const bar = document.createElement('div');
    bar.className = 'yp-feedback-bar';

    const barLeft = document.createElement('div');
    barLeft.className = 'yp-feedback-bar-left';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'yp-feedback-btn';
    toggleBtn.textContent = result.learnedFromFeedback
      ? '✎ Edit taught reading'
      : '✎ Wrong reading? Teach AI';
    barLeft.appendChild(toggleBtn);

    if (result.learnedFromFeedback && result.feedbackEntryId) {
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'yp-feedback-btn yp-feedback-undo-btn';
      undoBtn.title = 'Forget this taught reading and revert to base model';
      undoBtn.textContent = '↺ Undo';
      undoBtn.addEventListener('click', () => {
        if (contextInvalidated || !isExtensionContextValid()) {
          handleContextInvalidated(anchorRect, true);
          return;
        }
        undoBtn.disabled = true;
        undoBtn.textContent = '…';
        const opId = ++feedbackOperationId;
        chrome.runtime.sendMessage(
          {
            type: 'REMOVE_FEEDBACK',
            id: result.feedbackEntryId,
            lookupRequest: requestMeta,
            saveLast: true,
          },
          (res) => {
            if (opId !== feedbackOperationId || currentMode !== 'card') {
              return;
            }
            if (res?.ok && res.result) {
              showCard(res.result, anchorRect, requestMeta, 'Reverted to default reading');
            } else {
              undoBtn.disabled = false;
              undoBtn.textContent = '↺ Undo';
            }
          }
        );
      });
      barLeft.appendChild(undoBtn);
    }

    bar.appendChild(barLeft);

    if (statusToast) {
      const toast = document.createElement('span');
      toast.className = 'yp-feedback-toast';
      toast.textContent = statusToast;
      bar.appendChild(toast);
    }

    wrap.appendChild(bar);

    const form = document.createElement('form');
    form.className = 'yp-feedback-form';
    form.hidden = true;
    form.autocomplete = 'off';

    const hint = document.createElement('div');
    hint.className = 'yp-feedback-hint';
    hint.textContent = `Correct reading for 「${surface}」 (hiragana / katakana):`;
    form.appendChild(hint);

    const inputsRow = document.createElement('div');
    inputsRow.className = 'yp-feedback-inputs';

    const topCand = result.readings?.[0] || null;
    const currentReading = topCand?.reading || '';

    const readingInput = document.createElement('input');
    readingInput.type = 'text';
    readingInput.className = 'yp-feedback-input';
    readingInput.maxLength = 120;
    readingInput.placeholder = 'e.g. つきおうじ';
    readingInput.setAttribute('aria-label', `Correct reading for ${surface}`);
    readingInput.value = currentReading;
    inputsRow.appendChild(readingInput);

    const pitchInput = document.createElement('input');
    pitchInput.type = 'text';
    pitchInput.className = 'yp-feedback-pitch-input';
    pitchInput.maxLength = 16;
    pitchInput.placeholder = 'Pitch (opt)';
    pitchInput.title = 'Optional pitch accent number (e.g. 0, 1, 2, 3)';
    pitchInput.setAttribute('aria-label', 'Optional pitch accent number');
    if (result.learnedFromFeedback && Array.isArray(topCand?.pitches) && topCand.pitches.length > 0) {
      pitchInput.value = topCand.pitches.join(',');
    }
    inputsRow.appendChild(pitchInput);

    form.appendChild(inputsRow);

    const errorEl = document.createElement('div');
    errorEl.className = 'yp-feedback-error';
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;
    form.appendChild(errorEl);

    const controls = document.createElement('div');
    controls.className = 'yp-feedback-controls';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'yp-feedback-cancel-btn';
    cancelBtn.textContent = 'Cancel';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'yp-feedback-save-btn';
    saveBtn.textContent = 'Save & Learn';

    controls.appendChild(cancelBtn);
    controls.appendChild(saveBtn);
    form.appendChild(controls);

    const closeForm = () => {
      form.hidden = true;
      errorEl.hidden = true;
      errorEl.textContent = '';
      positionElementNearSelection(card, anchorRect);
    };

    const openForm = () => {
      form.hidden = false;
      errorEl.hidden = true;
      errorEl.textContent = '';
      positionElementNearSelection(card, anchorRect);
      readingInput.focus();
      readingInput.select?.();
    };

    toggleBtn.addEventListener('click', () => {
      if (form.hidden) {
        openForm();
      } else {
        closeForm();
      }
    });

    cancelBtn.addEventListener('click', () => closeForm());

    // Isolate keyboard events from host-page hotkeys and guard Japanese IME composition
    const stopHostShortcuts = (e) => {
      e.stopPropagation();
    };
    form.addEventListener('keypress', stopHostShortcuts);
    form.addEventListener('keyup', stopHostShortcuts);
    form.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) {
        if (e.key === 'Enter') {
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeForm();
      }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (contextInvalidated || !isExtensionContextValid()) {
        handleContextInvalidated(anchorRect, true);
        return;
      }

      const rawReading = readingInput.value.trim();
      if (!rawReading) {
        errorEl.textContent = 'Please enter a reading in hiragana or katakana.';
        errorEl.hidden = false;
        return;
      }

      errorEl.hidden = true;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Learning…';
      const opId = ++feedbackOperationId;

      chrome.runtime.sendMessage(
        {
          type: 'SUBMIT_FEEDBACK',
          feedback: {
            surface: requestMeta?.text || result.query || surface,
            normSurface: result.normalized || surface,
            reading: rawReading,
            pitches: pitchInput.value.trim(),
            contextText: requestMeta?.contextText || '',
            contextStart: typeof requestMeta?.contextStart === 'number' ? requestMeta.contextStart : -1,
            contextEnd: typeof requestMeta?.contextEnd === 'number' ? requestMeta.contextEnd : -1,
            previousReading: currentReading,
          },
          lookupRequest: requestMeta,
          saveLast: true,
        },
        (res) => {
          if (opId !== feedbackOperationId || currentMode !== 'card') {
            return;
          }
          if (!res?.ok) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save & Learn';
            errorEl.textContent = res?.error || 'Could not save reading feedback.';
            errorEl.hidden = false;
            positionElementNearSelection(card, anchorRect);
            return;
          }
          if (res.result) {
            showCard(res.result, anchorRect, requestMeta, 'Learned! AI updated ✨');
          } else {
            closeForm();
          }
        }
      );
    });

    wrap.appendChild(form);
    return wrap;
  }

  function showCard(result, rect, requestMeta = null, statusToast = '') {
    ensureHost();
    clearContainer();
    ++feedbackOperationId;
    currentMode = 'card';
    anchorRect = rect;
    const effectiveMeta = requestMeta || activeCardRequest || {
      text: result.query || result.normalized || activeSelectionText || '',
      contextText: activeSelectionDetails?.contextText || '',
      contextStart:
        typeof activeSelectionDetails?.contextStart === 'number'
          ? activeSelectionDetails.contextStart
          : -1,
      contextEnd:
        typeof activeSelectionDetails?.contextEnd === 'number'
          ? activeSelectionDetails.contextEnd
          : -1,
    };
    activeCardRequest = effectiveMeta;

    const card = document.createElement('div');
    card.className = 'yp-surface yp-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Kanji reading and pitch accent');

    // Header
    const header = document.createElement('div');
    header.className = 'yp-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'yp-header-left';

    const surfaceWord = document.createElement('span');
    surfaceWord.className = 'yp-surface-word';
    surfaceWord.textContent = result.normalized || result.query || '';
    headerLeft.appendChild(surfaceWord);

    if (result.learnedFromFeedback) {
      const learnedTag = document.createElement('span');
      learnedTag.className = 'yp-tag yp-tag-learned';
      learnedTag.title = 'Adapted from your reading feedback';
      learnedTag.textContent = 'Learned ✨';
      headerLeft.appendChild(learnedTag);
    }

    if (result.matchType === 'unalignable-context') {
      const irrTag = document.createElement('span');
      irrTag.className = 'yp-tag yp-tag-tie';
      irrTag.title = 'Part of an irregular whole-word compound (jukujikun) whose Kanji cannot be split';
      irrTag.textContent = 'Irregular Compound';
      headerLeft.appendChild(irrTag);
    } else if (result.matchType === 'ai-context') {
      const aiCtxTag = document.createElement('span');
      aiCtxTag.className = 'yp-tag yp-tag-ai';
      aiCtxTag.title = 'Disambiguated from surrounding webpage sentence by ONNX Neural AI';
      aiCtxTag.textContent = 'AI Context';
      headerLeft.appendChild(aiCtxTag);
    } else if (result.matchType === 'ai') {
      const aiTag = document.createElement('span');
      aiTag.className = 'yp-tag yp-tag-ai';
      aiTag.title = 'Predicted by ONNX Neural AI furigana model';
      aiTag.textContent = 'AI';
      headerLeft.appendChild(aiTag);
    } else if (result.matchType === 'single-kanji') {
      const skTag = document.createElement('span');
      skTag.className = 'yp-tag';
      skTag.title = 'Isolated single Kanji — showing all standalone, Kun, and On readings';
      skTag.textContent = 'Single Kanji · All Readings';
      headerLeft.appendChild(skTag);
    } else if (result.isTied) {
      const tieTag = document.createElement('span');
      tieTag.className = 'yp-tag yp-tag-tie';
      tieTag.title = 'Multiple readings share the exact same top likelihood score';
      tieTag.textContent = 'Equal likelihood';
      headerLeft.appendChild(tieTag);
    } else if (result.matchType === 'deinflected') {
      const conjTag = document.createElement('span');
      conjTag.className = 'yp-tag';
      conjTag.textContent = 'Conjugated';
      headerLeft.appendChild(conjTag);
    } else if (result.matchType === 'segmented') {
      const segTag = document.createElement('span');
      segTag.className = 'yp-tag';
      segTag.textContent = 'Phrase';
      headerLeft.appendChild(segTag);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'yp-close-btn';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => dismissUI());

    header.appendChild(headerLeft);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // Body
    const hasReadings = Array.isArray(result.readings) && result.readings.length > 0;
    const kdSection = buildKanjiDetailsSection(result);
    const hasEnclosing = Boolean(result.enclosingCompound?.reading);

    if (!result.found || (!hasReadings && !kdSection && !hasEnclosing)) {
      const empty = document.createElement('div');
      empty.className = 'yp-empty';
      empty.textContent = result.hasKanji
        ? 'No dictionary reading found for this selection.'
        : 'Select text containing Japanese Kanji to view its reading.';
      card.appendChild(empty);
    } else {
      if (hasEnclosing) {
        const ec = result.enclosingCompound;
        const note = document.createElement('div');
        note.className = 'yp-trunc-note';
        note.textContent = `In context, part of irregular compound 「${ec.surface}」 (cannot split per-Kanji):`;
        card.appendChild(note);

        const list = document.createElement('div');
        list.className = 'yp-readings-list';
        list.appendChild(buildReadingRow(ec));
        card.appendChild(list);
      }

      if (hasReadings) {
        const list = document.createElement('div');
        list.className = 'yp-readings-list';
        for (const cand of result.readings) {
          list.appendChild(buildReadingRow(cand));
        }
        card.appendChild(list);
      }

      if (result.tiesTruncated) {
        const truncNote = document.createElement('div');
        truncNote.className = 'yp-trunc-note';
        truncNote.textContent = 'Showing first 32 tied combinations';
        card.appendChild(truncNote);
      }

      if (kdSection) {
        card.appendChild(kdSection);
      }

      // Per-segment breakdown for compounds & multi-word phrases
      if (Array.isArray(result.segments) && result.segments.length > 0) {
        const segSection = document.createElement('div');
        segSection.className = 'yp-segments';

        const segTitle = document.createElement('div');
        segTitle.className = 'yp-segments-title';
        segTitle.textContent = 'Breakdown';
        segSection.appendChild(segTitle);

        const segGrid = document.createElement('div');
        segGrid.className = 'yp-segments-grid';

        for (const seg of result.segments) {
          const chip = document.createElement('div');
          chip.className = 'yp-seg-chip';

          if (seg.isKanji && seg.candidates?.length > 0) {
            const topRow = document.createElement('div');
            topRow.className = 'yp-seg-top';

            const primary = seg.candidates[0];
            if (primary.pitchContours?.length > 0) {
              topRow.appendChild(renderMoraContourElement(primary.pitchContours[0], true));
              const pBadge = document.createElement('span');
              pBadge.textContent = `[${primary.pitchContours.map((c) => c.pitch).join(',')}]`;
              topRow.appendChild(pBadge);
            } else {
              const rSpan = document.createElement('span');
              rSpan.textContent = seg.candidates.map((c) => c.reading).join(' / ');
              topRow.appendChild(rSpan);
              if (primary.base?.pitches?.length > 0) {
                const bSpan = document.createElement('span');
                bSpan.title = `Base: ${primary.base.surface} (${primary.base.reading})`;
                bSpan.textContent = `base [${primary.base.pitches.join(',')}]`;
                topRow.appendChild(bSpan);
              }
            }
            chip.appendChild(topRow);
          }

          const surf = document.createElement('div');
          surf.className = 'yp-seg-surface';
          surf.textContent = seg.surface;
          chip.appendChild(surf);

          segGrid.appendChild(chip);
        }

        segSection.appendChild(segGrid);
        card.appendChild(segSection);
      }
    }

    const feedbackSection = buildFeedbackSection(result, effectiveMeta, card, statusToast);
    if (feedbackSection) {
      card.appendChild(feedbackSection);
    }

    // Horse Models Community License v2.0 attribution footer
    const footer = document.createElement('div');
    footer.className = 'yp-card-footer';
    const attrLink = document.createElement('a');
    attrLink.className = 'yp-attr-link';
    attrLink.href = 'https://2008-horse.com/licensing/';
    attrLink.target = '_blank';
    attrLink.rel = 'noopener noreferrer';
    attrLink.textContent = 'Powered by Horse Models';
    footer.appendChild(attrLink);
    card.appendChild(footer);

    rootContainer.appendChild(card);
    positionElementNearSelection(card, rect);
  }

  function scheduleSelectionCheck() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      if (contextInvalidated || !isExtensionContextValid()) {
        handleContextInvalidated(null, false);
        return;
      }
      const details = getSelectionDetails();
      if (!details) {
        ++lookupRequestId;
        if (currentMode === 'pill') {
          dismissUI();
        }
        return;
      }
      if (details.text !== activeSelectionText) {
        ++lookupRequestId;
      }
      if (currentMode === 'card' && details.text === activeSelectionText) {
        return;
      }
      showPill(details);
    }, 35);
  }

  function onMouseUp(e) {
    if (hostEl && typeof e.composedPath === 'function' && e.composedPath().includes(hostEl)) {
      return;
    }
    scheduleSelectionCheck();
  }

  function onKeyUp(e) {
    if (hostEl && typeof e.composedPath === 'function' && e.composedPath().includes(hostEl)) {
      return;
    }
    if (e.key === 'Escape') {
      if (currentMode !== 'hidden') {
        dismissUI();
      }
      return;
    }
    if (!contextInvalidated && (e.shiftKey || (typeof e.key === 'string' && e.key.startsWith('Arrow')))) {
      scheduleSelectionCheck();
    }
  }

  function onMouseDown(e) {
    if (currentMode === 'hidden') {
      return;
    }
    if (hostEl && typeof e.composedPath === 'function' && e.composedPath().includes(hostEl)) {
      return;
    }
    dismissUI();
  }

  function onSelectionChange() {
    const sel = window.getSelection();
    const details = sel && !sel.isCollapsed ? getSelectionDetails(true) : null;
    const currentText = details?.text || (sel && !sel.isCollapsed ? sel.toString().trim() : '');
    if (currentText !== activeSelectionText) {
      ++lookupRequestId;
    }
    if (currentMode === 'pill' && !currentText) {
      dismissUI();
    }
  }

  function onScrollOrResize(e) {
    if (currentMode === 'hidden' || !rootContainer?.firstChild) {
      return;
    }
    if (hostEl && typeof e?.composedPath === 'function' && e.composedPath().includes(hostEl)) {
      return;
    }
    const live = getSelectionDetails();
    if (live?.rect) {
      anchorRect = live.rect;
      positionElementNearSelection(rootContainer.firstChild, anchorRect);
    } else if (currentMode === 'pill') {
      dismissUI();
    } else if (currentMode === 'card' && anchorRect) {
      positionElementNearSelection(rootContainer.firstChild, anchorRect);
    }
  }

  // Event listeners
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
  window.addEventListener('resize', onScrollOrResize, { passive: true });

  // Runtime messaging (Context menu card trigger & Popup active selection query)
  if (isExtensionContextValid() && chrome.runtime?.onMessage) {
    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message.type !== 'string') {
          return false;
        }

        if (message.type === 'GET_SELECTION') {
          const details = getSelectionDetails(true);
          if (details) {
            sendResponse({
              selectionText: details.text,
              contextText: details.contextText || '',
              contextStart: typeof details.contextStart === 'number' ? details.contextStart : -1,
              contextEnd: typeof details.contextEnd === 'number' ? details.contextEnd : -1,
            });
          } else {
            const sel = window.getSelection()?.toString().trim() || '';
            sendResponse({
              selectionText: sel,
              contextText: '',
              contextStart: -1,
              contextEnd: -1,
            });
          }
          return false;
        }

        if (message.type === 'SHOW_READING_CARD' && message.result) {
          ++lookupRequestId;
          const details = getSelectionDetails();
          activeSelectionText = message.text || details?.text || '';
          const reqMeta = message.lookupRequest || {
            text: activeSelectionText,
            contextText: details?.contextText || '',
            contextStart: typeof details?.contextStart === 'number' ? details.contextStart : -1,
            contextEnd: typeof details?.contextEnd === 'number' ? details.contextEnd : -1,
          };
          showCard(message.result, details?.rect || null, reqMeta);
          sendResponse({ ok: true });
          return false;
        }

        return false;
      });
    } catch {
      contextInvalidated = true;
    }
  }
})();
