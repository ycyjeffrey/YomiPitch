/**
 * Manifest V3 Background Service Worker (YomiPitch v2.0)
 *
 * Responsibilities:
 *   1. Manages the Chrome MV3 Offscreen Document (`src/offscreen/offscreen.html`) hosting the
 *      INT8 ONNX Neural AI furigana engine + Kanjium/JMdict pitch assets without race conditions.
 *   2. Registers the right-click context menu `"Read Kanji: 「%s」"` safely without duplicate-ID errors,
 *      extracting webpage sentence context from the clicked frame before AI inference.
 *   3. Responds to lookup messages from content scripts and the toolbar popup, falling back to
 *      in-worker dictionary lookup when Offscreen APIs are unavailable.
 */

import { createCachedDictLoader } from '../shared/dict-loader.js';
import { lookupKanji } from '../shared/lookup.js';
import { FeedbackLearner, FEEDBACK_STORAGE_KEY } from '../shared/feedback-learner.js';

export const CONTEXT_MENU_ID = 'yomipitch-read-kanji';
export const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
export const DEFAULT_SETTINGS = Object.freeze({
  showFloatingButton: true,
});

const getDict = createCachedDictLoader(async () => {
  const dictUrl = chrome.runtime.getURL('data/dict.json.gz');
  const response = await fetch(dictUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch dictionary asset (${response.status})`);
  }
  return response.body;
});

const workerFeedbackLearner = new FeedbackLearner();
let feedbackHydratedPromise = null;
let persistedFeedbackState = null;
let feedbackRevision = 0;
let offscreenConfirmedRevision = -1;
let feedbackMutationChain = Promise.resolve();

let menuSetupChain = Promise.resolve();
let creatingOffscreenPromise = null;
let latestContextMenuLookupGen = 0;
const frameLookupGenMap = new Map();

async function ensureFeedbackLoaded({ strict = false } = {}) {
  if (!feedbackHydratedPromise) {
    feedbackHydratedPromise = (async () => {
      let loaded = null;
      if (typeof chrome !== 'undefined' && typeof chrome.storage?.local?.get === 'function') {
        const stored = await chrome.storage.local.get(FEEDBACK_STORAGE_KEY);
        loaded = stored?.[FEEDBACK_STORAGE_KEY] || null;
      }
      persistedFeedbackState = loaded;
      const storedRev = Number(loaded?.revision);
      if (Number.isInteger(storedRev) && storedRev > feedbackRevision) {
        feedbackRevision = storedRev;
      }
      await workerFeedbackLearner.loadState(persistedFeedbackState);
      return persistedFeedbackState;
    })();
  }
  try {
    return await feedbackHydratedPromise;
  } catch (err) {
    feedbackHydratedPromise = null;
    if (strict) {
      throw err;
    }
    return persistedFeedbackState;
  }
}

async function rollbackOffscreenFeedbackIfNeeded() {
  if (!chrome.offscreen?.createDocument) return;
  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'OFFSCREEN_SYNC_FEEDBACK',
      state: persistedFeedbackState,
      revision: feedbackRevision,
      force: true,
    });
    offscreenConfirmedRevision = feedbackRevision;
  } catch {
    offscreenConfirmedRevision = -1;
  }
}

async function persistFeedbackState(nextState, nextRevision) {
  const stampedState =
    nextState && typeof nextState === 'object'
      ? { ...nextState, revision: nextRevision }
      : nextState;

  if (typeof chrome !== 'undefined' && typeof chrome.storage?.local?.set === 'function') {
    await chrome.storage.local.set({
      [FEEDBACK_STORAGE_KEY]: stampedState,
    });
  }

  persistedFeedbackState = stampedState;
  feedbackRevision = nextRevision;
  await workerFeedbackLearner.loadState(stampedState);
}

function runFallbackLookup(payload, dict) {
  return lookupKanji(payload.text, dict, {
    feedbackLearner: workerFeedbackLearner,
    contextText: payload.contextText,
    contextStart: payload.contextStart,
    contextEnd: payload.contextEnd,
  });
}

function enqueueFeedbackMutation(taskFn) {
  const run = feedbackMutationChain.then(taskFn, taskFn);
  feedbackMutationChain = run.catch(() => {});
  return run;
}

/**
 * Ensures the singleton MV3 Offscreen Document exists, serializing concurrent creation attempts
 * so parallel lookups never race `chrome.offscreen.createDocument` or accept a still-loading context.
 */
export async function ensureOffscreenDocument() {
  if (typeof chrome === 'undefined' || !chrome.offscreen?.createDocument) {
    return false;
  }

  if (creatingOffscreenPromise) {
    return creatingOffscreenPromise;
  }

  creatingOffscreenPromise = (async () => {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

    if (typeof chrome.runtime.getContexts === 'function') {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl],
      });
      if (Array.isArray(existingContexts) && existingContexts.length > 0) {
        return true;
      }
    } else if (typeof chrome.offscreen.hasDocument === 'function') {
      if (await chrome.offscreen.hasDocument()) {
        return true;
      }
    }

    await chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason?.WORKERS || 'WORKERS'],
        justification:
          'Run ONNX Runtime WebAssembly neural furigana inference and pitch accent lookup',
      })
      .catch((err) => {
        if (String(err?.message || err).includes('single offscreen document')) {
          return;
        }
        throw err;
      });

    offscreenConfirmedRevision = -1;
    return true;
  })().finally(() => {
    creatingOffscreenPromise = null;
  });

  return creatingOffscreenPromise;
}

function normalizeLookupPayload(request) {
  return {
    text: String(request?.text ?? ''),
    contextText: typeof request?.contextText === 'string' ? request.contextText : '',
    contextStart: typeof request?.contextStart === 'number' ? request.contextStart : -1,
    contextEnd: typeof request?.contextEnd === 'number' ? request.contextEnd : -1,
  };
}

/**
 * Routes a lookup request through the Offscreen ONNX Neural AI engine when available,
 * gracefully falling back to local dictionary lookup if Offscreen APIs are absent.
 */
async function performLookup(request) {
  await ensureFeedbackLoaded();
  const payload = normalizeLookupPayload(request);

  if (chrome.offscreen?.createDocument) {
    try {
      const ready = await ensureOffscreenDocument();
      if (ready) {
        const needsSync = offscreenConfirmedRevision !== feedbackRevision;
        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'OFFSCREEN_LOOKUP',
          payload,
          feedbackRevision,
          ...(needsSync ? { feedbackState: persistedFeedbackState } : {}),
        });
        if (response?.ok && response.result) {
          if (typeof response.syncedRevision === 'number') {
            offscreenConfirmedRevision = response.syncedRevision;
          }
          return response.result;
        }
      }
    } catch {
      // Fall through to local dictionary fallback if offscreen fails
    }
  }

  const dict = await getDict();
  return runFallbackLookup(payload, dict);
}

/**
 * Safely clears and re-creates the selection context menu serialized through a promise queue,
 * guaranteeing zero duplicate-ID errors across MV3 service worker restarts.
 */
function ensureContextMenus() {
  menuSetupChain = menuSetupChain
    .then(
      () =>
        new Promise((resolve) => {
          chrome.contextMenus.removeAll(() => {
            void chrome.runtime.lastError;
            chrome.contextMenus.create(
              {
                id: CONTEXT_MENU_ID,
                title: 'Read Kanji: 「%s」',
                contexts: ['selection'],
              },
              () => {
                void chrome.runtime.lastError;
                resolve();
              }
            );
          });
        })
    )
    .catch(() => {});
  return menuSetupChain;
}

/**
 * Ensures default sync settings are populated on install without overwriting user choices.
 */
async function ensureDefaultSettings() {
  try {
    const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
    const updates = {};
    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
      if (existing[key] === undefined) {
        updates[key] = defaultValue;
      }
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.sync.set(updates);
    }
  } catch {
    // Ignore storage quota / transient errors during install
  }
}

/**
 * Stores the latest lookup in local storage so the popup can show context-menu lookups
 * even on restricted tabs (e.g. PDF viewer or pages where content scripts cannot run).
 */
async function saveLastLookup(result) {
  try {
    await chrome.storage.local.set({
      lastLookup: {
        result,
        timestamp: Date.now(),
      },
    });
  } catch {
    // Ignore transient local storage errors
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onInstalled.addListener(() => {
    void ensureContextMenus();
    void ensureDefaultSettings();
    if (chrome.offscreen?.createDocument) {
      void ensureOffscreenDocument().catch(() => {});
    } else {
      void getDict().catch(() => {});
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    void ensureContextMenus();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_ID || !info.selectionText) {
      return;
    }

    const globalGen = ++latestContextMenuLookupGen;
    const hasTab = tab?.id != null && tab.id >= 0;
    const hasFrameId = typeof info.frameId === 'number';
    const frameKey = hasTab ? `${tab.id}:${hasFrameId ? info.frameId : 0}` : 'no-tab';
    const frameGen = (frameLookupGenMap.get(frameKey) || 0) + 1;
    frameLookupGenMap.set(frameKey, frameGen);

    void (async () => {
      try {
        const sendTabMsg = (msg) =>
          hasFrameId
            ? chrome.tabs.sendMessage(tab.id, msg, { frameId: info.frameId })
            : chrome.tabs.sendMessage(tab.id, msg);
        const scriptTarget = hasFrameId
          ? { tabId: tab.id, frameIds: [info.frameId] }
          : { tabId: tab.id };

        let lookupRequest = { text: info.selectionText };
        let contentInjected = false;

        if (hasTab) {
          try {
            const sel = await sendTabMsg({ type: 'GET_SELECTION' });
            if (sel && typeof sel.selectionText === 'string' && sel.selectionText.trim()) {
              lookupRequest = {
                text: sel.selectionText,
                contextText: typeof sel.contextText === 'string' ? sel.contextText : '',
                contextStart: typeof sel.contextStart === 'number' ? sel.contextStart : -1,
                contextEnd: typeof sel.contextEnd === 'number' ? sel.contextEnd : -1,
              };
            }
          } catch {
            // Content script may not yet be injected on pre-existing tabs after extension reload;
            // attempt programmatic injection once so we can both get context AND show the card.
            try {
              await chrome.scripting.executeScript({
                target: scriptTarget,
                files: ['src/content/content.js'],
              });
              contentInjected = true;
              const sel = await sendTabMsg({ type: 'GET_SELECTION' });
              if (sel && typeof sel.selectionText === 'string' && sel.selectionText.trim()) {
                lookupRequest = {
                  text: sel.selectionText,
                  contextText: typeof sel.contextText === 'string' ? sel.contextText : '',
                  contextStart: typeof sel.contextStart === 'number' ? sel.contextStart : -1,
                  contextEnd: typeof sel.contextEnd === 'number' ? sel.contextEnd : -1,
                };
              }
            } catch {
              // Restricted page (chrome://, Chrome Web Store, PDF viewer) — continue with info.selectionText
            }
          }
        }

        const result = await performLookup(lookupRequest);

        // Discard stale completion if a newer context-menu lookup superseded this one
        if (globalGen === latestContextMenuLookupGen) {
          await saveLastLookup(result);
        }
        if (frameLookupGenMap.get(frameKey) !== frameGen) {
          return;
        }

        if (hasTab) {
          const payload = {
            type: 'SHOW_READING_CARD',
            text: lookupRequest.text,
            lookupRequest,
            result,
          };

          try {
            await sendTabMsg(payload);
          } catch {
            if (!contentInjected) {
              try {
                await chrome.scripting.executeScript({
                  target: scriptTarget,
                  files: ['src/content/content.js'],
                });
                await sendTabMsg(payload);
              } catch {
                // Restricted page — saved in lastLookup for popup
              }
            }
          }
        }
      } catch (err) {
        console.error('[YomiPitch] Context menu lookup failed:', err);
      }
    })();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target === 'offscreen' || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'LOOKUP_KANJI') {
      (async () => {
        try {
          const result = await performLookup(message);
          if (message.saveLast) {
            await saveLastLookup(result);
          }
          sendResponse({ ok: true, result });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Dictionary lookup failed',
          });
        }
      })();
      return true; // Keep message channel open for async sendResponse
    }

    if (message.type === 'GET_FEEDBACK_STATE') {
      (async () => {
        try {
          await ensureFeedbackLoaded();
          sendResponse({
            ok: true,
            state: persistedFeedbackState,
            revision: feedbackRevision,
          });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to load feedback state',
          });
        }
      })();
      return true;
    }

    if (message.type === 'GET_FEEDBACK_LIST') {
      (async () => {
        try {
          await ensureFeedbackLoaded();
          sendResponse({
            ok: true,
            entries: workerFeedbackLearner.listEntries(),
          });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to list learned words',
          });
        }
      })();
      return true;
    }

    if (message.type === 'SUBMIT_FEEDBACK') {
      enqueueFeedbackMutation(async () => {
        await ensureFeedbackLoaded({ strict: true });
        const feedback = message.feedback || {};
        const lookupRequest = message.lookupRequest?.text
          ? normalizeLookupPayload(message.lookupRequest)
          : null;
        const nextRevision = feedbackRevision + 1;

        if (chrome.offscreen?.createDocument) {
          let offscreenHandled = false;
          try {
            const ready = await ensureOffscreenDocument();
            if (ready) {
              const needsSync = offscreenConfirmedRevision !== feedbackRevision;
              const response = await chrome.runtime.sendMessage({
                target: 'offscreen',
                type: 'OFFSCREEN_RECORD_FEEDBACK',
                feedback,
                lookupRequest,
                feedbackRevision,
                nextRevision,
                ...(needsSync ? { feedbackState: persistedFeedbackState } : {}),
              });
              if (response) {
                offscreenHandled = true;
                if (!response.ok) {
                  throw new Error(response.error || 'Invalid feedback');
                }
                const committedRev = Math.max(nextRevision, Number(response.syncedRevision) || nextRevision);
                try {
                  await persistFeedbackState(response.state, committedRev);
                } catch (storageErr) {
                  await rollbackOffscreenFeedbackIfNeeded();
                  throw storageErr;
                }
                offscreenConfirmedRevision = committedRev;
                if (response.result && message.saveLast !== false) {
                  await saveLastLookup(response.result);
                }
                return {
                  ok: true,
                  entry: response.entry,
                  entries: response.entries || workerFeedbackLearner.listEntries(),
                  result: response.result || null,
                };
              }
            }
          } catch (err) {
            if (offscreenHandled) {
              throw err;
            }
            // Otherwise fall through to worker-side learner
          }
        }

        const dict = await getDict();
        const entry = await workerFeedbackLearner.recordFeedback({
          ...feedback,
          dict,
        });
        try {
          await persistFeedbackState(workerFeedbackLearner.toJSON(), nextRevision);
        } catch (storageErr) {
          await workerFeedbackLearner.loadState(persistedFeedbackState);
          throw storageErr;
        }
        const result = lookupRequest ? runFallbackLookup(lookupRequest, dict) : null;
        if (result && message.saveLast !== false) {
          await saveLastLookup(result);
        }
        return {
          ok: true,
          entry,
          entries: workerFeedbackLearner.listEntries(),
          result,
        };
      })
        .then((res) => sendResponse(res))
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to save feedback',
          });
        });
      return true;
    }

    if (message.type === 'REMOVE_FEEDBACK') {
      enqueueFeedbackMutation(async () => {
        await ensureFeedbackLoaded({ strict: true });
        const id = String(message.id ?? '');
        const lookupRequest = message.lookupRequest?.text
          ? normalizeLookupPayload(message.lookupRequest)
          : null;
        const nextRevision = feedbackRevision + 1;

        if (chrome.offscreen?.createDocument) {
          let offscreenHandled = false;
          try {
            const ready = await ensureOffscreenDocument();
            if (ready) {
              const needsSync = offscreenConfirmedRevision !== feedbackRevision;
              const response = await chrome.runtime.sendMessage({
                target: 'offscreen',
                type: 'OFFSCREEN_REMOVE_FEEDBACK',
                id,
                lookupRequest,
                feedbackRevision,
                nextRevision,
                ...(needsSync ? { feedbackState: persistedFeedbackState } : {}),
              });
              if (response) {
                offscreenHandled = true;
                if (!response.ok) {
                  throw new Error(response.error || 'Failed to remove feedback');
                }
                const committedRev = Math.max(nextRevision, Number(response.syncedRevision) || nextRevision);
                try {
                  await persistFeedbackState(response.state, committedRev);
                } catch (storageErr) {
                  await rollbackOffscreenFeedbackIfNeeded();
                  throw storageErr;
                }
                offscreenConfirmedRevision = committedRev;
                if (response.result && message.saveLast !== false) {
                  await saveLastLookup(response.result);
                }
                return {
                  ok: true,
                  removed: response.removed,
                  entries: response.entries || workerFeedbackLearner.listEntries(),
                  result: response.result || null,
                };
              }
            }
          } catch (err) {
            if (offscreenHandled) {
              throw err;
            }
            // Fall through to worker-side removal
          }
        }

        const removed = await workerFeedbackLearner.removeFeedback(id);
        try {
          await persistFeedbackState(workerFeedbackLearner.toJSON(), nextRevision);
        } catch (storageErr) {
          await workerFeedbackLearner.loadState(persistedFeedbackState);
          throw storageErr;
        }
        let result = null;
        if (lookupRequest) {
          const dict = await getDict();
          result = runFallbackLookup(lookupRequest, dict);
          if (message.saveLast !== false) {
            await saveLastLookup(result);
          }
        }
        return {
          ok: true,
          removed,
          entries: workerFeedbackLearner.listEntries(),
          result,
        };
      })
        .then((res) => sendResponse(res))
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to remove feedback',
          });
        });
      return true;
    }

    if (message.type === 'CLEAR_FEEDBACK') {
      enqueueFeedbackMutation(async () => {
        await ensureFeedbackLoaded({ strict: true });
        const lookupRequest = message.lookupRequest?.text
          ? normalizeLookupPayload(message.lookupRequest)
          : null;
        const nextRevision = feedbackRevision + 1;

        if (chrome.offscreen?.createDocument) {
          let offscreenHandled = false;
          try {
            const ready = await ensureOffscreenDocument();
            if (ready) {
              const response = await chrome.runtime.sendMessage({
                target: 'offscreen',
                type: 'OFFSCREEN_CLEAR_FEEDBACK',
                lookupRequest,
                nextRevision,
              });
              if (response) {
                offscreenHandled = true;
                if (!response.ok) {
                  throw new Error(response.error || 'Failed to clear feedback');
                }
                const committedRev = Math.max(nextRevision, Number(response.syncedRevision) || nextRevision);
                try {
                  await persistFeedbackState(response.state, committedRev);
                } catch (storageErr) {
                  await rollbackOffscreenFeedbackIfNeeded();
                  throw storageErr;
                }
                offscreenConfirmedRevision = committedRev;
                if (response.result && message.saveLast !== false) {
                  await saveLastLookup(response.result);
                }
                return {
                  ok: true,
                  entries: [],
                  result: response.result || null,
                };
              }
            }
          } catch (err) {
            if (offscreenHandled) {
              throw err;
            }
            // Fall through to worker-side clear
          }
        }

        await workerFeedbackLearner.clearAll();
        try {
          await persistFeedbackState(workerFeedbackLearner.toJSON(), nextRevision);
        } catch (storageErr) {
          await workerFeedbackLearner.loadState(persistedFeedbackState);
          throw storageErr;
        }
        let result = null;
        if (lookupRequest) {
          const dict = await getDict();
          result = runFallbackLookup(lookupRequest, dict);
          if (message.saveLast !== false) {
            await saveLastLookup(result);
          }
        }
        return {
          ok: true,
          entries: [],
          result,
        };
      })
        .then((res) => sendResponse(res))
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to clear feedback',
          });
        });
      return true;
    }

    if (message.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
}
