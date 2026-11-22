/**
 * Toolbar Popup Controller (`src/popup/popup.js`)
 *
 * - Automatically checks the active tab for highlighted Kanji text (messaging content script
 *   with `chrome.scripting.executeScript` fallback when `activeTab` is available).
 * - Provides instant manual Kanji lookup input + sample word chips.
 * - Renders pitch accent mora contours, numeric pitch badges, copy & speech buttons.
 * - Syncs the `showFloatingButton` user preference with `chrome.storage.sync`.
 */

import { KANJI_RE, containsKanji } from '../shared/lookup.js';

const formEl = document.getElementById('lookup-form');
const inputEl = document.getElementById('kanji-input');
const clearBtn = document.getElementById('clear-btn');
const samplesViewEl = document.getElementById('samples-view');
const sampleChipsEl = document.getElementById('sample-chips');
const resultContainerEl = document.getElementById('result-container');
const toggleEl = document.getElementById('floating-pill-toggle');
const learnedToggleBtn = document.getElementById('learned-toggle-btn');
const learnedPanelEl = document.getElementById('learned-panel');
const learnedListEl = document.getElementById('learned-list');
const clearAllLearnedBtn = document.getElementById('clear-all-learned-btn');

let lookupSeq = 0;
let feedbackSeq = 0;
let hasUserInteracted = false;
let activeLookupRequest = null;
let activeSourceLabel = '';
let cachedLearnedEntries = [];

function updateClearButton() {
  clearBtn.hidden = !inputEl.value;
}

function clearElement(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function renderMoraContour(contour, isMini = false) {
  const row = document.createElement('span');
  row.className = isMini ? 'mora-row mora-row-mini' : 'mora-row';
  if (contour.tooltip) {
    row.title = contour.tooltip;
  }

  contour.morae.forEach((mora, idx) => {
    const span = document.createElement('span');
    const classes = ['mora'];
    if (mora.high) {
      classes.push('mora-high');
      if (idx > 0 && !contour.morae[idx - 1].high) {
        classes.push('mora-rise');
      }
    }
    if (mora.dropAfter) {
      classes.push('mora-drop');
    }
    span.className = classes.join(' ');
    span.textContent = mora.text;
    row.appendChild(span);
  });

  return row;
}

async function copyReading(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('icon-btn-copied');
    setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove('icon-btn-copied');
    }, 1300);
  } catch {
    // Ignore clipboard rejection
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
    // Ignore speech synthesis errors
  }
}

function buildReadingItem(cand) {
  const item = document.createElement('div');
  item.className = 'reading-item';

  const main = document.createElement('div');
  main.className = 'reading-main';

  const left = document.createElement('div');
  left.className = 'reading-left';

  const contours = Array.isArray(cand.pitchContours) ? cand.pitchContours : [];
  const contourHolder = document.createElement('span');

  if (contours.length > 0) {
    contourHolder.appendChild(renderMoraContour(contours[0], false));
    left.appendChild(contourHolder);

    const badges = document.createElement('span');
    badges.className = 'pitch-badges';

    contours.forEach((c, idx) => {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className =
        'pitch-badge' +
        (contours.length > 1 ? ' pitch-badge-interactive' : '') +
        (idx === 0 ? ' pitch-badge-active' : '');
      const baseTooltip = c.tooltip || `${c.pitch}: ${c.labelJa}`;
      badge.title =
        cand.pitchScope === 'standalone'
          ? `Standalone word accent (${baseTooltip}) — compound pitch may shift in context`
          : baseTooltip;
      badge.textContent =
        cand.pitchScope === 'standalone' ? `standalone [${c.pitch}]` : `[${c.pitch}]`;

      const label = document.createElement('span');
      label.className = 'pitch-label';
      label.textContent = c.labelJa;
      badge.appendChild(label);

      if (contours.length > 1) {
        badge.addEventListener('click', () => {
          clearElement(contourHolder);
          contourHolder.appendChild(renderMoraContour(c, false));
          Array.from(badges.children).forEach((el, bIdx) => {
            el.classList.toggle('pitch-badge-active', bIdx === idx);
          });
        });
      }

      badges.appendChild(badge);
    });

    left.appendChild(badges);
  } else {
    const plain = document.createElement('span');
    plain.className = 'reading-plain';
    plain.textContent = cand.reading;
    left.appendChild(plain);

    if (!cand.base) {
      const noPitch = document.createElement('span');
      noPitch.className = 'pitch-badge pitch-badge-none';
      noPitch.title = 'No pitch accent entry recorded for this form';
      noPitch.textContent = 'Intonation: —';
      left.appendChild(noPitch);
    }
  }

  main.appendChild(left);

  const actions = document.createElement('div');
  actions.className = 'actions';

  if ('speechSynthesis' in window) {
    const speakBtn = document.createElement('button');
    speakBtn.type = 'button';
    speakBtn.className = 'icon-btn';
    speakBtn.title = 'Listen (ja-JP)';
    speakBtn.setAttribute('aria-label', `Listen to ${cand.reading}`);
    speakBtn.textContent = '🔊';
    speakBtn.addEventListener('click', () => speakJapanese(cand.reading));
    actions.appendChild(speakBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'icon-btn';
  copyBtn.title = 'Copy reading';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    void copyReading(cand.reading, copyBtn);
  });
  actions.appendChild(copyBtn);

  main.appendChild(actions);
  item.appendChild(main);

  if (cand.base) {
    const meta = document.createElement('div');
    meta.className = 'base-meta';

    const baseContours = cand.base.pitchContours || [];
    const basePitches = cand.base.pitches || [];
    const hasOwnPitch = contours.length > 0 || (cand.pitches?.length || 0) > 0;

    if (!hasOwnPitch && (baseContours.length > 0 || basePitches.length > 0)) {
      const baseLabel = document.createElement('span');
      baseLabel.textContent = `Intonation: base form ${cand.base.surface}`;
      meta.appendChild(baseLabel);

      if (baseContours.length > 0) {
        meta.appendChild(renderMoraContour(baseContours[0], true));
        for (const bc of baseContours) {
          const bBadge = document.createElement('span');
          bBadge.className = 'pitch-badge';
          bBadge.title = bc.tooltip || `${bc.pitch}: ${bc.labelJa}`;
          bBadge.textContent = `[${bc.pitch}]`;
          meta.appendChild(bBadge);
        }
      } else {
        for (const p of basePitches) {
          const bBadge = document.createElement('span');
          bBadge.className = 'pitch-badge';
          bBadge.textContent = `[${p}]`;
          meta.appendChild(bBadge);
        }
      }
    } else if (!hasOwnPitch) {
      const baseLabel = document.createElement('span');
      baseLabel.textContent = `Base: ${cand.base.surface} (${cand.base.reading})`;
      meta.appendChild(baseLabel);

      const noPitch = document.createElement('span');
      noPitch.className = 'pitch-badge pitch-badge-none';
      noPitch.textContent = 'Intonation: —';
      meta.appendChild(noPitch);
    } else {
      const baseLabel = document.createElement('span');
      baseLabel.textContent = `Base: ${cand.base.surface}`;
      meta.appendChild(baseLabel);

      if (baseContours.length > 0) {
        meta.appendChild(renderMoraContour(baseContours[0], true));
        for (const bc of baseContours) {
          const bBadge = document.createElement('span');
          bBadge.className = 'pitch-badge';
          bBadge.title = bc.tooltip || `${bc.pitch}: ${bc.labelJa}`;
          bBadge.textContent = `[${bc.pitch}]`;
          meta.appendChild(bBadge);
        }
      } else {
        const bRead = document.createElement('span');
        bRead.textContent = `(${cand.base.reading})`;
        meta.appendChild(bRead);
      }
    }

    if (cand.base.ruleLabel) {
      const ruleTag = document.createElement('span');
      ruleTag.className = 'tag';
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
  wrap.className = 'kanji-details';

  if (extraWords.length > 0) {
    const row = document.createElement('div');
    row.className = 'kd-row';
    const label = document.createElement('span');
    label.className = 'kd-label';
    label.textContent = 'Other words';
    row.appendChild(label);

    const chips = document.createElement('div');
    chips.className = 'kd-chips';
    for (const [r, pitches] of extraWords) {
      const chip = document.createElement('span');
      chip.className = 'kd-chip';
      chip.textContent = r;
      if (Array.isArray(pitches) && pitches.length > 0) {
        const pSpan = document.createElement('span');
        pSpan.className = 'kd-pitch';
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
    row.className = 'kd-row';
    const label = document.createElement('span');
    label.className = 'kd-label';
    label.textContent = '訓読み (Kun)';
    row.appendChild(label);

    const chips = document.createElement('div');
    chips.className = 'kd-chips';
    for (const k of kun) {
      const chip = document.createElement('span');
      chip.className = 'kd-chip';
      chip.textContent = k;
      chips.appendChild(chip);
    }
    row.appendChild(chips);
    wrap.appendChild(row);
  }

  if (on.length > 0) {
    const row = document.createElement('div');
    row.className = 'kd-row';
    const label = document.createElement('span');
    label.className = 'kd-label';
    label.textContent = '音読み (On)';
    row.appendChild(label);

    const chips = document.createElement('div');
    chips.className = 'kd-chips';
    for (const o of on) {
      const chip = document.createElement('span');
      chip.className = 'kd-chip';
      chip.textContent = o;
      chips.appendChild(chip);
    }
    row.appendChild(chips);
    wrap.appendChild(row);
  }

  return wrap;
}

function renderLearnedPanel(entries) {
  cachedLearnedEntries = Array.isArray(entries) ? entries : [];
  if (!learnedToggleBtn || !learnedPanelEl || !learnedListEl) {
    return;
  }

  const count = cachedLearnedEntries.length;
  if (count === 0) {
    learnedToggleBtn.hidden = true;
    learnedToggleBtn.setAttribute('aria-expanded', 'false');
    learnedPanelEl.hidden = true;
    clearElement(learnedListEl);
    return;
  }

  learnedToggleBtn.hidden = false;
  learnedToggleBtn.textContent = `Learned (${count})`;
  clearElement(learnedListEl);

  for (const item of cachedLearnedEntries) {
    const row = document.createElement('div');
    row.className = 'learned-row';

    const wordBtn = document.createElement('button');
    wordBtn.type = 'button';
    wordBtn.className = 'learned-row-word-btn';
    wordBtn.title = `Look up ${item.surface}`;

    const surfSpan = document.createElement('span');
    surfSpan.className = 'learned-row-surface';
    surfSpan.textContent = item.surface;
    wordBtn.appendChild(surfSpan);

    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'learned-row-ctx';
    arrowSpan.textContent = '→';
    wordBtn.appendChild(arrowSpan);

    const readSpan = document.createElement('span');
    readSpan.className = 'learned-row-reading';
    readSpan.textContent = item.reading;
    wordBtn.appendChild(readSpan);

    if (Array.isArray(item.pitches) && item.pitches.length > 0) {
      const pSpan = document.createElement('span');
      pSpan.className = 'learned-row-pitch';
      pSpan.textContent = `[${item.pitches.join(',')}]`;
      wordBtn.appendChild(pSpan);
    }

    if (item.isContextualPolyphone) {
      const ctxSpan = document.createElement('span');
      ctxSpan.className = 'learned-row-ctx';
      ctxSpan.textContent = '(context)';
      wordBtn.appendChild(ctxSpan);
    }

    wordBtn.addEventListener('click', () => {
      hasUserInteracted = true;
      inputEl.value = item.surface;
      updateClearButton();
      void performLookup(item.surface);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'learned-row-del';
    delBtn.title = `Forget ${item.surface} → ${item.reading}`;
    delBtn.setAttribute('aria-label', `Remove learned reading for ${item.surface}`);
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      const op = ++feedbackSeq;
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'REMOVE_FEEDBACK',
          id: item.id,
          lookupRequest: activeLookupRequest,
          saveLast: Boolean(activeLookupRequest),
        });
        if (op !== feedbackSeq) return;
        if (res?.ok) {
          renderLearnedPanel(res.entries || []);
          if (res.result && activeLookupRequest) {
            renderResult(res.result, activeSourceLabel, activeLookupRequest, 'Reverted to default reading');
          }
        }
      } catch {
        delBtn.disabled = false;
      }
    });

    row.appendChild(wordBtn);
    row.appendChild(delBtn);
    learnedListEl.appendChild(row);
  }
}

async function refreshLearnedEntries() {
  if (!learnedToggleBtn || !learnedPanelEl || !learnedListEl) {
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_FEEDBACK_LIST' });
    if (res?.ok && Array.isArray(res.entries)) {
      renderLearnedPanel(res.entries);
    }
  } catch {
    // Ignore when background is unavailable
  }
}

function buildFeedbackSection(result, requestMeta, statusToast = '') {
  const surface = String(result.normalized || result.query || requestMeta?.text || '').trim();
  if (!surface || (!result.hasKanji && !KANJI_RE.test(surface))) {
    return null;
  }

  const wrap = document.createElement('div');
  wrap.className = 'feedback-wrap';

  const bar = document.createElement('div');
  bar.className = 'feedback-bar';

  const barLeft = document.createElement('div');
  barLeft.className = 'feedback-bar-left';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'feedback-btn';
  toggleBtn.textContent = result.learnedFromFeedback
    ? '✎ Edit taught reading'
    : '✎ Wrong reading? Teach AI';
  barLeft.appendChild(toggleBtn);

  if (result.learnedFromFeedback && result.feedbackEntryId) {
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'feedback-btn feedback-undo-btn';
    undoBtn.title = 'Forget this taught reading and revert to base model';
    undoBtn.textContent = '↺ Undo';
    undoBtn.addEventListener('click', async () => {
      undoBtn.disabled = true;
      undoBtn.textContent = '…';
      const op = ++feedbackSeq;
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'REMOVE_FEEDBACK',
          id: result.feedbackEntryId,
          lookupRequest: requestMeta,
          saveLast: true,
        });
        if (op !== feedbackSeq) return;
        if (res?.ok) {
          renderLearnedPanel(res.entries || []);
          if (res.result) {
            renderResult(res.result, activeSourceLabel, requestMeta, 'Reverted to default reading');
            return;
          }
        }
      } catch {
        // Fall through
      }
      undoBtn.disabled = false;
      undoBtn.textContent = '↺ Undo';
    });
    barLeft.appendChild(undoBtn);
  }

  bar.appendChild(barLeft);

  if (statusToast) {
    const toast = document.createElement('span');
    toast.className = 'feedback-toast';
    toast.textContent = statusToast;
    bar.appendChild(toast);
  }

  wrap.appendChild(bar);

  const form = document.createElement('form');
  form.className = 'feedback-form';
  form.hidden = true;
  form.autocomplete = 'off';

  const hint = document.createElement('div');
  hint.className = 'feedback-hint';
  hint.textContent = `Correct reading for 「${surface}」 (hiragana / katakana):`;
  form.appendChild(hint);

  const inputsRow = document.createElement('div');
  inputsRow.className = 'feedback-inputs';

  const topCand = result.readings?.[0] || null;
  const currentReading = topCand?.reading || '';

  const readingInput = document.createElement('input');
  readingInput.type = 'text';
  readingInput.className = 'feedback-input';
  readingInput.maxLength = 120;
  readingInput.placeholder = 'e.g. つきおうじ';
  readingInput.setAttribute('aria-label', `Correct reading for ${surface}`);
  readingInput.value = currentReading;
  inputsRow.appendChild(readingInput);

  const pitchInput = document.createElement('input');
  pitchInput.type = 'text';
  pitchInput.className = 'feedback-pitch-input';
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
  errorEl.className = 'feedback-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.hidden = true;
  form.appendChild(errorEl);

  const controls = document.createElement('div');
  controls.className = 'feedback-controls';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'feedback-cancel-btn';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'feedback-save-btn';
  saveBtn.textContent = 'Save & Learn';

  controls.appendChild(cancelBtn);
  controls.appendChild(saveBtn);
  form.appendChild(controls);

  const closeForm = () => {
    form.hidden = true;
    errorEl.hidden = true;
    errorEl.textContent = '';
  };

  const openForm = () => {
    form.hidden = false;
    errorEl.hidden = true;
    errorEl.textContent = '';
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

  form.addEventListener('keydown', (e) => {
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawReading = readingInput.value.trim();
    if (!rawReading) {
      errorEl.textContent = 'Please enter a reading in hiragana or katakana.';
      errorEl.hidden = false;
      return;
    }

    errorEl.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Learning…';
    const op = ++feedbackSeq;

    try {
      const res = await chrome.runtime.sendMessage({
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
      });

      if (op !== feedbackSeq) return;
      if (!res?.ok) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save & Learn';
        errorEl.textContent = res?.error || 'Could not save reading feedback.';
        errorEl.hidden = false;
        return;
      }

      renderLearnedPanel(res.entries || []);
      if (res.result) {
        renderResult(res.result, activeSourceLabel, requestMeta, 'Learned! AI updated ✨');
      } else {
        closeForm();
      }
    } catch (err) {
      if (op !== feedbackSeq) return;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Learn';
      errorEl.textContent = err instanceof Error ? err.message : 'Could not save reading feedback.';
      errorEl.hidden = false;
    }
  });

  wrap.appendChild(form);
  return wrap;
}

function renderResult(result, sourceLabel = '', requestMeta = null, statusToast = '') {
  samplesViewEl.hidden = true;
  resultContainerEl.hidden = false;
  clearElement(resultContainerEl);

  const effectiveMeta = requestMeta || activeLookupRequest || {
    text: result.query || result.normalized || '',
    contextText: '',
    contextStart: -1,
    contextEnd: -1,
  };
  activeLookupRequest = effectiveMeta;
  activeSourceLabel = sourceLabel;

  const hasReadings = Array.isArray(result.readings) && result.readings.length > 0;
  const kdSection = buildKanjiDetailsSection(result);
  const hasEnclosing = Boolean(result.enclosingCompound?.reading);

  if (!result.found || (!hasReadings && !kdSection && !hasEnclosing)) {
    const empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = result.hasKanji
      ? `No dictionary reading found for "${result.normalized || result.query}".`
      : 'Please enter a word or phrase containing at least one Japanese Kanji.';
    resultContainerEl.appendChild(empty);
    const fb = buildFeedbackSection(result, effectiveMeta, statusToast);
    if (fb) {
      resultContainerEl.appendChild(fb);
    }
    return;
  }

  const card = document.createElement('div');
  card.className = 'result-card';

  const header = document.createElement('div');
  header.className = 'result-header';

  const wordSpan = document.createElement('span');
  wordSpan.className = 'surface-word';
  wordSpan.textContent = result.normalized || result.query;
  header.appendChild(wordSpan);

  if (result.learnedFromFeedback) {
    const learnedTag = document.createElement('span');
    learnedTag.className = 'tag tag-learned';
    learnedTag.title = 'Adapted from your reading feedback';
    learnedTag.textContent = 'Learned ✨';
    header.appendChild(learnedTag);
  }

  if (result.matchType === 'unalignable-context') {
    const irrTag = document.createElement('span');
    irrTag.className = 'tag tag-tie';
    irrTag.title = 'Part of an irregular whole-word compound (jukujikun) whose Kanji cannot be split';
    irrTag.textContent = 'Irregular Compound';
    header.appendChild(irrTag);
  } else if (result.matchType === 'ai-context') {
    const aiCtxTag = document.createElement('span');
    aiCtxTag.className = 'tag tag-ai';
    aiCtxTag.title = 'Disambiguated from surrounding webpage sentence by ONNX Neural AI';
    aiCtxTag.textContent = 'AI Context';
    header.appendChild(aiCtxTag);
  } else if (result.matchType === 'ai') {
    const aiTag = document.createElement('span');
    aiTag.className = 'tag tag-ai';
    aiTag.title = 'Predicted by ONNX Neural AI furigana model';
    aiTag.textContent = 'AI';
    header.appendChild(aiTag);
  } else if (result.matchType === 'single-kanji') {
    const skTag = document.createElement('span');
    skTag.className = 'tag';
    skTag.title = 'Isolated single Kanji — showing all standalone, Kun, and On readings';
    skTag.textContent = 'Single Kanji · All Readings';
    header.appendChild(skTag);
  } else if (result.isTied) {
    const tieTag = document.createElement('span');
    tieTag.className = 'tag tag-tie';
    tieTag.title = 'Multiple readings share the exact same top likelihood score';
    tieTag.textContent = 'Equal likelihood';
    header.appendChild(tieTag);
  } else if (result.matchType === 'deinflected') {
    const conjTag = document.createElement('span');
    conjTag.className = 'tag';
    conjTag.textContent = 'Conjugated';
    header.appendChild(conjTag);
  } else if (result.matchType === 'segmented') {
    const segTag = document.createElement('span');
    segTag.className = 'tag';
    segTag.textContent = 'Phrase';
    header.appendChild(segTag);
  }

  if (sourceLabel) {
    const srcTag = document.createElement('span');
    srcTag.className = 'tag';
    srcTag.textContent = sourceLabel;
    header.appendChild(srcTag);
  }

  card.appendChild(header);

  if (hasEnclosing) {
    const ec = result.enclosingCompound;
    const note = document.createElement('div');
    note.className = 'trunc-note';
    note.textContent = `In context, part of irregular compound 「${ec.surface}」 (cannot split per-Kanji):`;
    card.appendChild(note);
    card.appendChild(buildReadingItem(ec));
  }

  if (hasReadings) {
    for (const cand of result.readings) {
      card.appendChild(buildReadingItem(cand));
    }
  }

  if (result.tiesTruncated) {
    const truncNote = document.createElement('div');
    truncNote.className = 'trunc-note';
    truncNote.textContent = 'Showing first 32 tied combinations';
    card.appendChild(truncNote);
  }

  if (kdSection) {
    card.appendChild(kdSection);
  }

  if (Array.isArray(result.segments) && result.segments.length > 0) {
    const segWrap = document.createElement('div');
    segWrap.className = 'segments';

    const segTitle = document.createElement('div');
    segTitle.className = 'segments-title';
    segTitle.textContent = 'Per-Segment Breakdown';
    segWrap.appendChild(segTitle);

    const grid = document.createElement('div');
    grid.className = 'segments-grid';

    for (const seg of result.segments) {
      const chip = document.createElement('div');
      chip.className = 'seg-chip';

      if (seg.isKanji && seg.candidates?.length > 0) {
        const top = document.createElement('div');
        top.className = 'seg-top';
        const primary = seg.candidates[0];
        if (primary.pitchContours?.length > 0) {
          top.appendChild(renderMoraContour(primary.pitchContours[0], true));
          const pSpan = document.createElement('span');
          pSpan.textContent = `[${primary.pitchContours.map((c) => c.pitch).join(',')}]`;
          top.appendChild(pSpan);
        } else {
          const rSpan = document.createElement('span');
          rSpan.textContent = seg.candidates.map((c) => c.reading).join(' / ');
          top.appendChild(rSpan);
          if (primary.base?.pitches?.length > 0) {
            const bSpan = document.createElement('span');
            bSpan.title = `Base: ${primary.base.surface} (${primary.base.reading})`;
            bSpan.textContent = `base [${primary.base.pitches.join(',')}]`;
            top.appendChild(bSpan);
          }
        }
        chip.appendChild(top);
      }

      const surf = document.createElement('div');
      surf.className = 'seg-surface';
      surf.textContent = seg.surface;
      chip.appendChild(surf);

      grid.appendChild(chip);
    }

    segWrap.appendChild(grid);
    card.appendChild(segWrap);
  }

  const feedbackSection = buildFeedbackSection(result, effectiveMeta, statusToast);
  if (feedbackSection) {
    card.appendChild(feedbackSection);
  }

  resultContainerEl.appendChild(card);
}

async function performLookup(requestOrText, sourceLabel = '') {
  const isObj = typeof requestOrText === 'object' && requestOrText !== null;
  const rawText = isObj ? String(requestOrText.text ?? '') : String(requestOrText ?? '');
  const trimmed = rawText.trim();
  const seq = ++lookupSeq;
  if (!trimmed) {
    activeLookupRequest = null;
    resultContainerEl.hidden = true;
    samplesViewEl.hidden = false;
    return;
  }

  const requestMeta = {
    text: trimmed,
    contextText: isObj && typeof requestOrText.contextText === 'string' ? requestOrText.contextText : '',
    contextStart: isObj && typeof requestOrText.contextStart === 'number' ? requestOrText.contextStart : -1,
    contextEnd: isObj && typeof requestOrText.contextEnd === 'number' ? requestOrText.contextEnd : -1,
  };

  const msg = {
    type: 'LOOKUP_KANJI',
    ...requestMeta,
    saveLast: true,
  };

  try {
    const response = await chrome.runtime.sendMessage(msg);
    if (seq !== lookupSeq) {
      return;
    }
    if (response?.ok && response.result) {
      renderResult(response.result, sourceLabel, requestMeta);
    } else {
      renderResult(
        {
          query: trimmed,
          normalized: trimmed,
          found: false,
          hasKanji: KANJI_RE.test(trimmed),
          readings: [],
        },
        sourceLabel,
        requestMeta
      );
    }
  } catch {
    if (seq !== lookupSeq) {
      return;
    }
    renderResult(
      {
        query: trimmed,
        normalized: trimmed,
        found: false,
        hasKanji: KANJI_RE.test(trimmed),
        readings: [],
      },
      sourceLabel,
      requestMeta
    );
  }
}

function normalizeFrameSelectionResult(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const t = val.trim();
    return t
      ? { selectionText: t, contextText: '', contextStart: -1, contextEnd: -1 }
      : null;
  }
  if (typeof val === 'object') {
    const t = String(val.selectionText ?? '').trim();
    if (!t) return null;
    return {
      selectionText: t,
      contextText: typeof val.contextText === 'string' ? val.contextText : '',
      contextStart: typeof val.contextStart === 'number' ? val.contextStart : -1,
      contextEnd: typeof val.contextEnd === 'number' ? val.contextEnd : -1,
    };
  }
  return null;
}

async function detectActiveTabSelection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return null;
    }

    let fallbackSelection = null;

    // 1. Query all frames (including iframes) via chrome.scripting.executeScript when activeTab grants access
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          const sel = window.getSelection?.();
          if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
          const BLOCK = new Set([
            'P', 'LI', 'DIV', 'ARTICLE', 'SECTION', 'TD', 'TH',
            'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
            'DD', 'DT', 'PRE', 'MAIN', 'BODY',
          ]);
          const SKIP = new Set(['RT', 'RP', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
          const range = sel.getRangeAt(0);
          let block = range?.commonAncestorContainer;
          if (block && block.nodeType !== 1) block = block.parentElement || block.parentNode;
          while (block && block.nodeType === 1 && !BLOCK.has(String(block.tagName || '').toUpperCase())) {
            block = block.parentElement || block.parentNode;
          }
          block = block || document.body;
          if (!block || !range?.startContainer || !range?.endContainer) {
            return { selectionText: sel.toString().trim(), contextText: '', contextStart: -1, contextEnd: -1 };
          }
          const before = [];
          const mid = [];
          const after = [];
          let state = 'before';
          const walk = (n) => {
            if (!n) return;
            if (n.nodeType === 3) {
              const v = n.nodeValue || '';
              if (n === range.startContainer && n === range.endContainer) {
                before.push(v.slice(0, range.startOffset));
                mid.push(v.slice(range.startOffset, range.endOffset));
                after.push(v.slice(range.endOffset));
                state = 'after';
              } else if (n === range.startContainer) {
                before.push(v.slice(0, range.startOffset));
                mid.push(v.slice(range.startOffset));
                state = 'inside';
              } else if (n === range.endContainer) {
                mid.push(v.slice(0, range.endOffset));
                after.push(v.slice(range.endOffset));
                state = 'after';
              } else if (state === 'before') before.push(v);
              else if (state === 'inside') mid.push(v);
              else after.push(v);
              return;
            }
            if (n.nodeType === 1) {
              const chs = n.childNodes || [];
              for (let i = 0; i <= chs.length; i++) {
                if (n === range.startContainer && range.startOffset === i) state = 'inside';
                if (n === range.endContainer && range.endOffset === i) state = 'after';
                if (i < chs.length) {
                  const c = chs[i];
                  if (c?.nodeType === 1 && (SKIP.has(c.tagName) || c.getAttribute?.('data-yomipitch-root') === 'true')) {
                    if (c.contains?.(range.startContainer)) state = 'inside';
                    if (c.contains?.(range.endContainer)) state = 'after';
                    continue;
                  }
                  walk(c);
                }
              }
            }
          };
          walk(block);
          const rawSel = mid.join('') || sel.toString();
          const lead = (/^\s+/u.exec(rawSel) || [''])[0];
          const rest = rawSel.slice(lead.length);
          const trail = (/\s+$/u.exec(rest) || [''])[0];
          const trimmed = trail ? rest.slice(0, rest.length - trail.length) : rest;
          if (!trimmed) return '';
          let bStr = before.join('') + lead;
          const bRe = /[。！？!?\n\r]/gu;
          let lastEnd = 0;
          let m;
          while ((m = bRe.exec(bStr)) !== null) lastEnd = m.index + m[0].length;
          if (lastEnd > 0) bStr = bStr.slice(lastEnd);
          if (bStr.length > 100) bStr = bStr.slice(bStr.length - 100);
          let aStr = trail + after.join('');
          const aM = /[。！？!?\n\r]/u.exec(aStr);
          if (aM) aStr = aStr.slice(0, aM.index + (aM[0] !== '\n' && aM[0] !== '\r' ? aM[0].length : 0));
          if (aStr.length > 100) aStr = aStr.slice(0, 100);
          const contextText = bStr + trimmed + aStr;
          const contextStart = bStr.length;
          const contextEnd = contextStart + trimmed.length;
          return { selectionText: trimmed, contextText, contextStart, contextEnd };
        },
      });
      if (Array.isArray(injected)) {
        const nonEmpty = injected
          .map((item) => normalizeFrameSelectionResult(item?.result))
          .filter(Boolean);
        const kanjiSelection = nonEmpty.find((s) => containsKanji(s.selectionText));
        if (kanjiSelection) {
          return kanjiSelection;
        }
        if (nonEmpty.length > 0) {
          fallbackSelection = nonEmpty[0];
        }
      }
    } catch {
      // Fall through to content script message fallback
    }

    // 2. Fallback to querying content script directly
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
      const parsed = normalizeFrameSelectionResult(res);
      if (parsed && containsKanji(parsed.selectionText)) {
        return parsed;
      }
      if (!fallbackSelection && parsed) {
        fallbackSelection = parsed;
      }
    } catch {
      // Restricted chrome:// or Web Store page
    }

    return fallbackSelection;
  } catch {
    // Ignore tab query errors
  }
  return null;
}

async function initSettings() {
  try {
    const stored = await chrome.storage.sync.get({ showFloatingButton: true });
    toggleEl.checked = Boolean(stored.showFloatingButton);
  } catch {
    toggleEl.checked = true;
  }

  toggleEl.addEventListener('change', () => {
    void chrome.storage.sync.set({ showFloatingButton: toggleEl.checked });
  });
}

async function initStartupLookup() {
  const selected = await detectActiveTabSelection();
  if (hasUserInteracted) {
    return;
  }
  if (selected && containsKanji(selected.selectionText)) {
    inputEl.value = selected.selectionText;
    updateClearButton();
    await performLookup(
      {
        text: selected.selectionText,
        contextText: selected.contextText,
        contextStart: selected.contextStart,
        contextEnd: selected.contextEnd,
      },
      'Selected on page'
    );
    return;
  }

  // Fallback to recent lookup stored from context menu (e.g. on restricted pages)
  try {
    const { lastLookup } = await chrome.storage.local.get('lastLookup');
    if (hasUserInteracted) {
      return;
    }
    if (
      lastLookup?.result?.found &&
      Date.now() - (lastLookup.timestamp || 0) < 5 * 60 * 1000
    ) {
      const recentText = lastLookup.result.normalized || lastLookup.result.query || '';
      inputEl.value = recentText;
      updateClearButton();
      renderResult(lastLookup.result, 'Recent', {
        text: recentText,
        contextText: '',
        contextStart: -1,
        contextEnd: -1,
      });
    }
  } catch {
    // Ignore local storage errors
  }
}

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  hasUserInteracted = true;
  void performLookup(inputEl.value);
});

inputEl.addEventListener('input', () => {
  hasUserInteracted = true;
  ++lookupSeq;
  updateClearButton();
  if (!inputEl.value.trim()) {
    resultContainerEl.hidden = true;
    samplesViewEl.hidden = false;
  }
});

clearBtn.addEventListener('click', () => {
  hasUserInteracted = true;
  ++lookupSeq;
  inputEl.value = '';
  updateClearButton();
  resultContainerEl.hidden = true;
  samplesViewEl.hidden = false;
  inputEl.focus();
});

sampleChipsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-word]');
  if (!btn) return;
  hasUserInteracted = true;
  const word = btn.getAttribute('data-word') || '';
  inputEl.value = word;
  updateClearButton();
  void performLookup(word);
});

if (learnedToggleBtn && learnedPanelEl) {
  learnedToggleBtn.addEventListener('click', () => {
    const willOpen = learnedPanelEl.hidden;
    learnedPanelEl.hidden = !willOpen;
    learnedToggleBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
}

if (clearAllLearnedBtn) {
  clearAllLearnedBtn.addEventListener('click', async () => {
    clearAllLearnedBtn.disabled = true;
    const op = ++feedbackSeq;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'CLEAR_FEEDBACK',
        lookupRequest: activeLookupRequest,
        saveLast: Boolean(activeLookupRequest),
      });
      if (op !== feedbackSeq) return;
      if (res?.ok) {
        renderLearnedPanel([]);
        if (res.result && activeLookupRequest) {
          renderResult(res.result, activeSourceLabel, activeLookupRequest, 'Reset all learned readings');
        }
      }
    } finally {
      clearAllLearnedBtn.disabled = false;
    }
  });
}

void initSettings();
void refreshLearnedEntries();
void initStartupLookup();
