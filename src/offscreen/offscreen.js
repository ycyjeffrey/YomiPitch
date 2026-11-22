/**
 * Chrome MV3 Offscreen Document — ONNX Neural Furigana & Pitch Lookup Host
 *
 * Keeps the 7.67 MB INT8 Horse Furigana ONNX WebAssembly session plus compressed
 * `dict.json.gz`, `pitch_map.json.gz`, and `single_kanji.json.gz` warm in memory,
 * serving `OFFSCREEN_LOOKUP` requests from the background service worker.
 */

import { createCachedDictLoader } from '../shared/dict-loader.js';
import { getAnnotator, defaultFeedbackLearner } from '../shared/ai-engine.js';
import { lookupKanjiWithAI } from '../shared/lookup.js';

function makeAssetLoader(assetPath) {
  return createCachedDictLoader(async () => {
    const assetUrl = chrome.runtime.getURL(assetPath);
    const response = await fetch(assetUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch ${assetPath} (${response.status})`);
    }
    return response.body;
  });
}

const getDict = makeAssetLoader('data/dict.json.gz');
const getPitchMap = makeAssetLoader('data/pitch_map.json.gz');
const getSingleKanji = makeAssetLoader('data/single_kanji.json.gz');

let resourcesPromise = null;
let syncedFeedbackRevision = -1;
let offscreenOpChain = Promise.resolve();

function enqueueOffscreenOp(taskFn) {
  const run = offscreenOpChain.then(taskFn, taskFn);
  offscreenOpChain = run.catch(() => {});
  return run;
}

async function applyFeedbackStateIfNeeded(state, revision, force = false) {
  if (state === undefined) {
    return;
  }
  if (!force) {
    if (typeof revision === 'number') {
      if (revision <= syncedFeedbackRevision) {
        return;
      }
    } else if (syncedFeedbackRevision !== -1) {
      return;
    }
  }
  await defaultFeedbackLearner.loadState(state);
  if (typeof revision === 'number') {
    syncedFeedbackRevision = revision;
    defaultFeedbackLearner.revision = revision;
  } else if (state && typeof state.revision === 'number') {
    syncedFeedbackRevision = state.revision;
  } else if (syncedFeedbackRevision === -1) {
    syncedFeedbackRevision = 0;
  }
}

export function getOffscreenResources() {
  if (!resourcesPromise) {
    resourcesPromise = Promise.all([
      getDict(),
      getPitchMap(),
      getSingleKanji(),
      getAnnotator(),
    ])
      .then(async ([dict, pitchMap, singleKanji, annotator]) => {
        if (
          syncedFeedbackRevision === -1 &&
          typeof chrome !== 'undefined' &&
          typeof chrome.runtime?.sendMessage === 'function'
        ) {
          try {
            const res = await chrome.runtime.sendMessage({ type: 'GET_FEEDBACK_STATE' });
            if (res?.ok && syncedFeedbackRevision === -1) {
              await applyFeedbackStateIfNeeded(res.state ?? null, res.revision ?? 0);
            }
          } catch {
            // Service worker will also push state on next message if needed
          }
        }
        return {
          dict,
          pitchMap,
          singleKanji,
          annotator,
        };
      })
      .catch((err) => {
        resourcesPromise = null;
        throw err;
      });
  }
  return resourcesPromise;
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  // Eagerly begin warming up dictionaries + ONNX WASM session when offscreen document loads
  void getOffscreenResources().catch(() => {});

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'offscreen' || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'OFFSCREEN_LOOKUP') {
      enqueueOffscreenOp(async () => {
        const resources = await getOffscreenResources();
        await applyFeedbackStateIfNeeded(message.feedbackState, message.feedbackRevision);
        const result = await lookupKanjiWithAI(message.payload || {}, resources);
        return { ok: true, result, syncedRevision: syncedFeedbackRevision };
      })
        .then((res) => sendResponse(res))
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Offscreen AI lookup failed',
          });
        });
      return true;
    }

    if (message.type === 'OFFSCREEN_SYNC_FEEDBACK') {
      enqueueOffscreenOp(async () => {
        await getOffscreenResources();
        await applyFeedbackStateIfNeeded(
          message.state ?? null,
          message.revision,
          Boolean(message.force)
        );
        return { ok: true, syncedRevision: syncedFeedbackRevision };
      })
        .then((res) => sendResponse(res))
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Offscreen feedback sync failed',
          });
        });
      return true;
    }

    if (message.type === 'OFFSCREEN_RECORD_FEEDBACK') {
      enqueueOffscreenOp(async () => {
        const resources = await getOffscreenResources();
        await applyFeedbackStateIfNeeded(message.feedbackState, message.feedbackRevision);
        const feedbackInput = message.feedback || {};
        const entry = await defaultFeedbackLearner.recordFeedback({
          ...feedbackInput,
          dict: resources.dict,
        });
        if (typeof message.nextRevision === 'number') {
          syncedFeedbackRevision = Math.max(syncedFeedbackRevision + 1, message.nextRevision);
        } else {
          syncedFeedbackRevision += 1;
        }
        defaultFeedbackLearner.revision = syncedFeedbackRevision;
        const result = message.lookupRequest?.text
          ? await lookupKanjiWithAI(message.lookupRequest, resources)
          : null;
        return {
          ok: true,
          entry,
          state: defaultFeedbackLearner.toJSON(),
          entries: defaultFeedbackLearner.listEntries(),
          result,
          syncedRevision: syncedFeedbackRevision,
        };
      })
        .then((res) => sendResponse(res))
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to learn reading feedback',
          });
        });
      return true;
    }

    if (message.type === 'OFFSCREEN_REMOVE_FEEDBACK') {
      enqueueOffscreenOp(async () => {
        const resources = await getOffscreenResources();
        await applyFeedbackStateIfNeeded(message.feedbackState, message.feedbackRevision);
        const removed = await defaultFeedbackLearner.removeFeedback(message.id);
        if (typeof message.nextRevision === 'number') {
          syncedFeedbackRevision = Math.max(syncedFeedbackRevision + 1, message.nextRevision);
        } else {
          syncedFeedbackRevision += 1;
        }
        defaultFeedbackLearner.revision = syncedFeedbackRevision;
        const result = message.lookupRequest?.text
          ? await lookupKanjiWithAI(message.lookupRequest, resources)
          : null;
        return {
          ok: true,
          removed,
          state: defaultFeedbackLearner.toJSON(),
          entries: defaultFeedbackLearner.listEntries(),
          result,
          syncedRevision: syncedFeedbackRevision,
        };
      })
        .then((res) => sendResponse(res))
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to remove learned feedback',
          });
        });
      return true;
    }

    if (message.type === 'OFFSCREEN_CLEAR_FEEDBACK') {
      enqueueOffscreenOp(async () => {
        const resources = await getOffscreenResources();
        await defaultFeedbackLearner.clearAll();
        if (typeof message.nextRevision === 'number') {
          syncedFeedbackRevision = Math.max(syncedFeedbackRevision + 1, message.nextRevision);
        } else {
          syncedFeedbackRevision += 1;
        }
        defaultFeedbackLearner.revision = syncedFeedbackRevision;
        const result = message.lookupRequest?.text
          ? await lookupKanjiWithAI(message.lookupRequest, resources)
          : null;
        return {
          ok: true,
          state: defaultFeedbackLearner.toJSON(),
          entries: [],
          result,
          syncedRevision: syncedFeedbackRevision,
        };
      })
        .then((res) => sendResponse(res))
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to clear learned feedback',
          });
        });
      return true;
    }

    if (message.type === 'OFFSCREEN_WARMUP' || message.type === 'OFFSCREEN_PING') {
      (async () => {
        try {
          await getOffscreenResources();
          sendResponse({ ok: true, ready: true });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : 'Offscreen warmup failed',
          });
        }
      })();
      return true;
    }

    return false;
  });
}
