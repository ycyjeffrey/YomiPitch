/**
 * Continual-Learning Neural & Lexicon Feedback Engine (`src/shared/feedback-learner.js`)
 *
 * Enables YomiPitch to genuinely learn from user reading corrections (e.g. `月王子` -> `つきおうじ`):
 *   1. Per-Kanji Alignment: Aligns `(surface, reading)` into character-level `vocab.labels` targets
 *      using Kanji reading candidates + rendaku/sokuon/jukujikun dynamic programming.
 *   2. Online Neural Logit Adapter: Wraps ONNX Runtime `InferenceSession.run()` in RAM (without
 *      modifying any `vendor/horse-furigana` files on disk) to apply learned multiclass log-odds
 *      weights over contextual, word, Kanji-bigram, and compound-head/tail morphological features.
 *   3. Dynamic Runtime Lexicon & Span Resolver: Injects learned compounds/readings into the
 *      in-memory lexicon and resolves ateji/gikun & conjugated verb/adjective stems cleanly.
 *   4. Deterministic Edit / Undo: Stores compact feedback records (`chrome.storage.local`) and
 *      rebuilds weights deterministically when entries are edited or removed.
 */

import { splitMorae } from './pitch.js';

const KANJI_OR_ITER_RE = /[\p{Script=Han}々〆ヵヶ]/u;
const SINGLE_HAN_RE = /^\p{Script=Han}$/u;
const VALID_READING_KANA_RE = /^[ぁ-ゖァ-ヺーゝゞヽヾ]+$/u;
const OUTER_PUNCT_RE =
  /^[\s「」『』（）()［］\[\]【】〈〉《》〔〕｛｝{}“”‘’"'、。，．・…‥！？!?：；:;〜~—―-]+|[\s「」『』（）()［］\[\]【】〈〉《》〔〕｛｝{}“”‘’"'、。，．・…‥！？!?：；:;〜~—―-]+$/gu;

let registeredTextNormalizer = null;

/**
 * Registers the shared span-preserving annotation normalizer (`normalizeForAnnotation` from
 * `ai-engine.js`) without introducing a circular `ort.wasm` import in the MV3 Service Worker.
 *
 * @param {(text: string) => { normText: string, pieces: Array<{ origStart: number, origEnd: number, normStart: number, normEnd: number }> }} fn
 */
export function setFeedbackTextNormalizer(fn) {
  if (typeof fn === 'function') {
    registeredTextNormalizer = fn;
  }
}

export function cleanFeedbackSurface(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').replace(OUTER_PUNCT_RE, '').trim();
}

function normalizeWithSpanMapping(text, origStart = -1, origEnd = -1) {
  const str = typeof text === 'string' ? text : '';
  if (!str) {
    return { normText: '', normStart: -1, normEnd: -1 };
  }
  if (registeredTextNormalizer) {
    const { normText, pieces } = registeredTextNormalizer(str);
    if (origStart >= 0 && origEnd >= origStart && origEnd <= str.length && Array.isArray(pieces)) {
      let nStart = -1;
      let nEnd = -1;
      for (const p of pieces) {
        if (p.origEnd <= origStart) continue;
        if (p.origStart >= origEnd) break;
        if (nStart === -1) {
          nStart =
            origStart <= p.origStart
              ? p.normStart
              : p.normStart + Math.min(p.normEnd - p.normStart, origStart - p.origStart);
        }
        nEnd =
          origEnd >= p.origEnd
            ? p.normEnd
            : p.normStart + Math.min(p.normEnd - p.normStart, origEnd - p.origStart);
      }
      if (origStart === origEnd) {
        const at = pieces.find((p) => p.origStart >= origStart);
        nStart = at ? at.normStart : normText.length;
        nEnd = nStart;
      }
      return { normText, normStart: nStart, normEnd: nEnd };
    }
    return { normText, normStart: -1, normEnd: -1 };
  }
  const nfkc = str.normalize('NFKC');
  return {
    normText: nfkc,
    normStart: origStart >= 0 && origEnd <= str.length ? str.slice(0, origStart).normalize('NFKC').length : -1,
    normEnd: origStart >= 0 && origEnd <= str.length ? str.slice(0, origEnd).normalize('NFKC').length : -1,
  };
}

const DAKUTEN_MAP = Object.freeze({
  か: 'が', き: 'ぎ', く: 'ぐ', け: 'げ', こ: 'ご',
  さ: 'ざ', し: 'じ', す: 'ず', せ: 'ぜ', そ: 'ぞ',
  た: 'だ', ち: 'ぢ', つ: 'づ', て: 'で', と: 'ど',
  は: 'ば', ひ: 'び', ふ: 'ぶ', へ: 'べ', ほ: 'ぼ',
});

const HANDAKUTEN_MAP = Object.freeze({
  は: 'ぱ', ひ: 'ぴ', ふ: 'ぷ', へ: 'ぺ', ほ: 'ぽ',
});

const SOKUON_TAIL_SET = new Set(['く', 'き', 'つ', 'ち', 'り']);

/**
 * Extracts all candidate reading strings for a single Kanji `ch` from `kanjiCandidates[ch]`,
 * supporting both `{ on?: string[], kun?: string[], nanori?: string[] }` and `string[]`.
 *
 * @param {Record<string, any> | null | undefined} kanjiCandidates
 * @param {string} ch
 * @returns {string[]}
 */
function getKanjiCandidateStrings(kanjiCandidates, ch) {
  if (!kanjiCandidates || !Object.hasOwn(kanjiCandidates, ch)) {
    return [];
  }
  const entry = kanjiCandidates[ch];
  if (Array.isArray(entry)) {
    return entry;
  }
  if (entry && typeof entry === 'object') {
    const out = [];
    if (Array.isArray(entry.on)) out.push(...entry.on);
    if (Array.isArray(entry.kun)) out.push(...entry.kun);
    if (Array.isArray(entry.nanori)) out.push(...entry.nanori);
    return out;
  }
  return [];
}

/**
 * Clones a single `kanjiCandidates[ch]` value for copy-on-write backup/restore.
 */
function cloneKanjiCandidateEntry(entry) {
  if (entry === undefined) return undefined;
  if (Array.isArray(entry)) return [...entry];
  if (entry && typeof entry === 'object') {
    return {
      ...(entry.on ? { on: [...entry.on] } : {}),
      ...(entry.kun ? { kun: [...entry.kun] } : {}),
      ...(entry.nanori ? { nanori: [...entry.nanori] } : {}),
    };
  }
  return entry;
}

/**
 * Adds a reading `piece` to `kanjiCandidates[ch]` in place (preserving `{ on, kun, nanori }` shape).
 */
function addPieceToKanjiCandidates(kanjiCandidates, ch, piece) {
  const existing = kanjiCandidates[ch];
  if (Array.isArray(existing)) {
    if (!existing.includes(piece)) {
      kanjiCandidates[ch] = [...existing, piece];
    }
    return;
  }
  if (existing && typeof existing === 'object') {
    const all = getKanjiCandidateStrings(kanjiCandidates, ch);
    if (!all.includes(piece)) {
      kanjiCandidates[ch] = {
        ...existing,
        kun: [...(Array.isArray(existing.kun) ? existing.kun : []), piece],
      };
    }
    return;
  }
  kanjiCandidates[ch] = { on: [], kun: [piece], nanori: [] };
}

export const FEEDBACK_STORAGE_KEY = 'userFeedbackState';
export const FEEDBACK_SCHEMA_VERSION = 1;
const MAX_FEEDBACK_ENTRIES = 1000;

/**
 * Converts Katakana characters (including ヵ/ヶ) to Hiragana while preserving `ー` and Hiragana.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeReadingKana(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim().replace(/\s+/gu, '');
  if (!trimmed) return '';
  let out = '';
  for (const ch of trimmed) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x30a1 && cp <= 0x30f4) {
      out += String.fromCodePoint(cp - 0x60);
    } else if (ch === 'ヵ') {
      out += 'か';
    } else if (ch === 'ヶ') {
      out += 'け';
    } else if (ch === 'ヽ') {
      out += 'ゝ';
    } else if (ch === 'ヾ') {
      out += 'ゞ';
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Validates and normalizes a user-supplied reading string (Hiragana or Katakana).
 *
 * @param {string} rawReading
 * @returns {{ ok: boolean, reading: string, error?: string }}
 */
export function validateUserReading(rawReading) {
  const raw = typeof rawReading === 'string' ? rawReading.trim().replace(/\s+/gu, '') : '';
  if (!raw) {
    return { ok: false, reading: '', error: 'Please enter a reading in Hiragana or Katakana.' };
  }
  if (raw.length > 80) {
    return { ok: false, reading: '', error: 'Reading is too long (max 80 characters).' };
  }
  if (!VALID_READING_KANA_RE.test(raw)) {
    return {
      ok: false,
      reading: '',
      error: 'Please use Hiragana or Katakana only (e.g. つきおうじ).',
    };
  }
  const reading = normalizeReadingKana(raw);
  return { ok: true, reading };
}

/**
 * Parses optional pitch accent input such as `""`, `"3"`, `"[0]"`, `"1, 3"` into validated integers `0..maxMora`.
 *
 * @param {string | number | number[] | null | undefined} rawPitches
 * @param {number | null} [maxMora]
 * @param {string} [readingForError]
 * @returns {{ ok: boolean, pitches: number[], error?: string }}
 */
export function parseUserPitches(rawPitches, maxMora = null, readingForError = '') {
  const upper = Number.isInteger(maxMora) && maxMora >= 0 ? maxMora : 20;
  const rangeError = () =>
    Number.isInteger(maxMora) && maxMora >= 0 && readingForError
      ? `Pitch accent for "${readingForError}" (${maxMora} mora${maxMora === 1 ? '' : 'e'}) must be between 0 and ${maxMora}.`
      : `Pitch accent must be between 0 and ${upper}.`;

  if (rawPitches == null || rawPitches === '') {
    return { ok: true, pitches: [] };
  }
  if (Array.isArray(rawPitches)) {
    const clean = [];
    for (const item of rawPitches) {
      const n = Number(item);
      if (!Number.isInteger(n)) {
        return { ok: false, pitches: [], error: 'Pitch accent must be a whole number (0, 1, 2, …).' };
      }
      if (n < 0 || n > upper) {
        return { ok: false, pitches: [], error: rangeError() };
      }
      if (!clean.includes(n)) clean.push(n);
    }
    return { ok: true, pitches: clean };
  }
  if (typeof rawPitches === 'number') {
    if (!Number.isInteger(rawPitches)) {
      return { ok: false, pitches: [], error: 'Pitch accent must be a whole number (0, 1, 2, …).' };
    }
    if (rawPitches < 0 || rawPitches > upper) {
      return { ok: false, pitches: [], error: rangeError() };
    }
    return { ok: true, pitches: [rawPitches] };
  }

  const cleaned = String(rawPitches)
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/[、／/]/g, ',');
  if (!cleaned) {
    return { ok: true, pitches: [] };
  }

  const parts = cleaned.split(/[\s,]+/).filter(Boolean);
  const pitches = [];
  for (const part of parts) {
    // Support full-width digits `０-９` too
    let ascii = '';
    for (const ch of part) {
      const cp = ch.codePointAt(0);
      ascii += cp >= 0xff10 && cp <= 0xff19 ? String.fromCodePoint(cp - 0xff10 + 0x30) : ch;
    }
    if (!/^\d{1,2}$/.test(ascii)) {
      return { ok: false, pitches: [], error: 'Pitch accent must be whole numbers like 0, 1, 2, 3.' };
    }
    const val = Number(ascii);
    if (val < 0 || val > upper) {
      return { ok: false, pitches: [], error: rangeError() };
    }
    if (!pitches.includes(val)) {
      pitches.push(val);
    }
  }
  return { ok: true, pitches };
}

/**
 * Expands a base hiragana reading with rendaku (voicing) and sokuon (`っ`) euphonic variants.
 *
 * @param {string} baseHira
 * @returns {Set<string>}
 */
function expandKanaVariants(baseHira) {
  const out = new Set();
  if (!baseHira) return out;
  out.add(baseHira);

  const cps = Array.from(baseHira);
  const first = cps[0];
  const rest = cps.slice(1).join('');

  if (Object.hasOwn(DAKUTEN_MAP, first)) {
    out.add(DAKUTEN_MAP[first] + rest);
  }
  if (Object.hasOwn(HANDAKUTEN_MAP, first)) {
    out.add(HANDAKUTEN_MAP[first] + rest);
  }

  for (const v of Array.from(out)) {
    const vCps = Array.from(v);
    if (vCps.length >= 2 && SOKUON_TAIL_SET.has(vCps[vCps.length - 1])) {
      out.add(`${vCps.slice(0, -1).join('')}っ`);
    }
  }
  return out;
}

/**
 * Extracts a compact context signature around `[contextStart, contextEnd]` inside `contextText`.
 *
 * @param {string} contextText
 * @param {number} contextStart
 * @param {number} contextEnd
 * @returns {{ before: string, after: string, hasSentenceContext: boolean }}
 */
export function extractContextWindow(contextText, contextStart, contextEnd) {
  if (
    typeof contextText !== 'string' ||
    !contextText ||
    typeof contextStart !== 'number' ||
    typeof contextEnd !== 'number' ||
    contextStart < 0 ||
    contextEnd <= contextStart ||
    contextEnd > contextText.length
  ) {
    return { before: '', after: '', hasSentenceContext: false };
  }

  const beforeFull = Array.from(contextText.slice(0, contextStart));
  const afterFull = Array.from(contextText.slice(contextEnd));
  const before = beforeFull.slice(Math.max(0, beforeFull.length - 4)).join('').trim();
  const after = afterFull.slice(0, 5).join('').trim();
  const hasSentenceContext = Boolean(before || after);
  return { before, after, hasSentenceContext };
}

/**
 * Strips shared trailing Hiragana okurigana after the last Kanji in `(surface, reading)`
 * (e.g. `("喰らった", "くらった")` -> `{ stemSurface: "喰", stemReading: "く", okurigana: "らった" }`).
 *
 * @param {string} surface
 * @param {string} reading
 * @returns {{ stemSurface: string, stemReading: string, okurigana: string } | null}
 */
export function extractStemBeforeOkurigana(surface, reading) {
  const sCps = Array.from(surface);
  let lastKanjiIdx = -1;
  for (let i = sCps.length - 1; i >= 0; i--) {
    if (KANJI_OR_ITER_RE.test(sCps[i])) {
      lastKanjiIdx = i;
      break;
    }
  }
  if (lastKanjiIdx < 0 || lastKanjiIdx >= sCps.length - 1) {
    return null;
  }

  const trailingRaw = sCps.slice(lastKanjiIdx + 1).join('');
  const trailingHira = normalizeReadingKana(trailingRaw);
  if (!trailingHira || !/^[ぁ-ゖー]+$/u.test(trailingHira)) {
    return null;
  }
  if (!reading.endsWith(trailingHira) || reading.length <= trailingHira.length) {
    return null;
  }

  const stemSurface = sCps.slice(0, lastKanjiIdx + 1).join('');
  const stemReading = reading.slice(0, reading.length - trailingHira.length);
  if (!stemSurface || !stemReading) {
    return null;
  }
  return { stemSurface, stemReading, okurigana: trailingHira };
}

/**
 * Aligns a surface string (`normSurface`) to a hiragana reading (`hiraReading`) into per-character
 * reading pieces and `vocab.labels` strings using dynamic programming.
 *
 * @param {string} normSurface
 * @param {string} hiraReading
 * @param {Set<string> | null} labelSet
 * @param {Record<string, string[]> | null} kanjiCandidates
 * @returns {{
 *   charReadings: string[],
 *   vocabLabels: Array<string | null>,
 *   fullyInVocab: boolean,
 *   compositional: boolean
 * }}
 */
export function alignSurfaceToReading(normSurface, hiraReading, labelSet = null, kanjiCandidates = null) {
  const sChars = Array.from(normSurface);
  const rChars = Array.from(hiraReading);
  const N = sChars.length;
  const M = rChars.length;

  if (N === 0 || M === 0) {
    return { charReadings: [], vocabLabels: [], fullyInVocab: false, compositional: false };
  }

  if (N === 1) {
    const inVocab = labelSet ? labelSet.has(hiraReading) : false;
    return {
      charReadings: [hiraReading],
      vocabLabels: [inVocab ? hiraReading : null],
      fullyInVocab: inVocab,
      compositional: true,
    };
  }

  // Precompute known Kanji candidate sets (including rendaku/sokuon)
  const knownPerPos = sChars.map((ch, idx) => {
    const map = new Map(); // reading -> score
    if (!KANJI_OR_ITER_RE.test(ch)) {
      const h = normalizeReadingKana(ch);
      map.set(h, 8.0);
      return map;
    }
    const rawList = getKanjiCandidateStrings(kanjiCandidates, ch);
    for (const cand of rawList) {
      const base = normalizeReadingKana(cand);
      if (!base) continue;
      map.set(base, Math.max(map.get(base) || 0, 5.5));
      for (const v of expandKanaVariants(base)) {
        if (!map.has(v)) {
          map.set(v, 4.6);
        }
      }
    }
    if (ch === '々' && idx > 0 && KANJI_OR_ITER_RE.test(sChars[idx - 1])) {
      const prevList = getKanjiCandidateStrings(kanjiCandidates, sChars[idx - 1]);
      for (const cand of prevList) {
        for (const v of expandKanaVariants(normalizeReadingKana(cand))) {
          map.set(v, Math.max(map.get(v) || 0, 4.4));
        }
      }
    }
    return map;
  });

  // DP: dp[i][r] = { score, prevI, prevR, piece, inKnown, inVocab }
  const dp = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(null));
  dp[0][0] = { score: 0, prevI: -1, prevR: -1, piece: '', inKnown: true, inVocab: true };

  for (let i = 0; i < N; i++) {
    const ch = sChars[i];
    const isKanji = KANJI_OR_ITER_RE.test(ch);
    const knownMap = knownPerPos[i];

    for (let r = 0; r < M; r++) {
      const cur = dp[i][r];
      if (!cur) continue;

      if (!isKanji) {
        const expected = normalizeReadingKana(ch);
        const eChars = Array.from(expected);
        const nextR = r + eChars.length;
        if (nextR <= M && rChars.slice(r, nextR).join('') === expected) {
          const nextScore = cur.score + 8.0;
          if (!dp[i + 1][nextR] || nextScore > dp[i + 1][nextR].score) {
            dp[i + 1][nextR] = {
              score: nextScore,
              prevI: i,
              prevR: r,
              piece: expected,
              inKnown: cur.inKnown,
              inVocab: cur.inVocab,
            };
          }
        }
        continue;
      }

      const maxTake = Math.min(8, M - r - (N - 1 - i > 0 ? 0 : 0));
      for (let len = 1; len <= maxTake; len++) {
        const nextR = r + len;
        // Remaining characters must have at least 1 mora if all remaining are non-empty,
        // unless using group continuation `∅` handled separately below.
        if (M - nextR < N - 1 - i) break;

        const piece = rChars.slice(r, nextR).join('');
        const knownScore = knownMap.get(piece);
        const isInVocab = labelSet ? labelSet.has(piece) : false;

        let stepScore;
        if (knownScore !== undefined && isInVocab) {
          stepScore = knownScore + 2.0;
        } else if (knownScore !== undefined) {
          stepScore = knownScore;
        } else if (isInVocab) {
          // Valid reading label in neural vocabulary (e.g. rare nanori like `つく` for `月`)
          stepScore = 1.8 - Math.abs(len - 2) * 0.15;
        } else {
          // Last-resort partition fallback
          stepScore = -2.5 - Math.abs(len - 2) * 0.2;
        }

        const nextScore = cur.score + stepScore;
        const prevBest = dp[i + 1][nextR];
        if (!prevBest || nextScore > prevBest.score) {
          dp[i + 1][nextR] = {
            score: nextScore,
            prevI: i,
            prevR: r,
            piece,
            inKnown: cur.inKnown && (knownScore !== undefined || isInVocab),
            inVocab: cur.inVocab && isInVocab,
          };
        }
      }
    }
  }

  const final = dp[N][M];
  if (final && final.score > -1.5 * N) {
    const charReadings = new Array(N);
    const vocabLabels = new Array(N);
    let ci = N;
    let cr = M;
    let allVocab = true;

    while (ci > 0) {
      const node = dp[ci][cr];
      const ch = sChars[ci - 1];
      charReadings[ci - 1] = node.piece;
      if (!KANJI_OR_ITER_RE.test(ch)) {
        vocabLabels[ci - 1] = '<kana>';
      } else if (labelSet && labelSet.has(node.piece)) {
        vocabLabels[ci - 1] = node.piece;
      } else {
        vocabLabels[ci - 1] = null;
        allVocab = false;
      }
      const pI = node.prevI;
      const pR = node.prevR;
      ci = pI;
      cr = pR;
    }

    return {
      charReadings,
      vocabLabels,
      fullyInVocab: allVocab,
      compositional: final.inKnown,
    };
  }

  // Whole-compound group label fallback (`[hiraReading, '∅', '∅', ...]`) when `hiraReading` is in `vocab.labels`
  const wholeInVocab = Boolean(labelSet && labelSet.has(hiraReading) && labelSet.has('∅'));
  return {
    charReadings: [hiraReading, ...new Array(N - 1).fill('')],
    vocabLabels: wholeInVocab ? [hiraReading, ...new Array(N - 1).fill('∅')] : new Array(N).fill(null),
    fullyInVocab: wholeInVocab,
    compositional: false,
  };
}

/**
 * Extracts multi-scale contextual & morphological features for a Kanji at `chars[pos]`
 * inside sequence `chars[0..L-1]`.
 *
 * @param {string[]} chars
 * @param {number} pos
 * @param {{ isContextualPolyphone?: boolean }} [opts]
 * @returns {Array<{ key: string, scale: number, cap: number }>}
 */
export function extractKanjiFeatures(chars, pos, opts = {}) {
  const L = chars.length;
  const ch = chars[pos];
  if (!ch || !KANJI_OR_ITER_RE.test(ch)) {
    return [];
  }

  let runStart = pos;
  while (runStart > 0 && KANJI_OR_ITER_RE.test(chars[runStart - 1])) {
    runStart--;
  }
  let runEnd = pos + 1;
  while (runEnd < L && KANJI_OR_ITER_RE.test(chars[runEnd])) {
    runEnd++;
  }

  const runLen = runEnd - runStart;
  const relPos = pos - runStart;
  const runSurface = chars.slice(runStart, runEnd).join('');

  const beforeRun = chars.slice(Math.max(0, runStart - 2), runStart).join('') || '^';
  const afterRun = chars.slice(runEnd, Math.min(L, runEnd + 3)).join('') || '$';
  const hasSurrounding = beforeRun !== '^' || afterRun !== '$';

  const features = [];

  // 1. Surrounding sentence context features (highest specificity for polyphones like 人気 / 辛い / 行った)
  if (hasSurrounding) {
    features.push({
      key: `CTX_AROUND:${beforeRun}|${runSurface}@${relPos}|${afterRun}`,
      scale: 2.4,
      cap: 8.5,
    });
    if (afterRun !== '$') {
      features.push({
        key: `CTX_AFTER:${runSurface}@${relPos}|${afterRun.slice(0, 2)}`,
        scale: 2.0,
        cap: 7.0,
      });
      features.push({
        key: `CTX_AFTER1:${ch}|${afterRun[0]}`,
        scale: 0.75,
        cap: 3.2,
      });
    }
    if (beforeRun !== '^') {
      features.push({
        key: `CTX_BEFORE:${beforeRun.slice(-1)}|${runSurface}@${relPos}`,
        scale: 1.3,
        cap: 5.0,
      });
    }
  }

  // 2. Word / compound identity feature
  if (opts.isContextualPolyphone) {
    // Keep standalone word prior modest so opposite contexts aren't clobbered
    features.push({
      key: `WORD:${runSurface}@${relPos}`,
      scale: 0.45,
      cap: 1.5,
    });
  } else {
    features.push({
      key: `WORD:${runSurface}@${relPos}`,
      scale: 3.2,
      cap: 11.0,
    });
  }

  // 3. Sub-compound Kanji bigram features (transfers to longer compounds sharing morphemes, e.g. 月王子様)
  if (!opts.isContextualPolyphone) {
    if (pos + 1 < runEnd) {
      features.push({
        key: `BG_R:${ch}${chars[pos + 1]}`,
        scale: 1.15,
        cap: 4.8,
      });
    }
    if (pos > runStart) {
      features.push({
        key: `BG_L:${chars[pos - 1]}${ch}`,
        scale: 1.0,
        cap: 4.2,
      });
    }

    // 4. Morphological role generalization (transfers prefix/suffix reading tendencies to unseen compounds!)
    if (runLen >= 2 && relPos === 0) {
      features.push({
        key: `ROLE_HEAD:${ch}:${runLen >= 3 ? '3+' : '2'}`,
        scale: 0.65,
        cap: 3.6,
      });
      features.push({
        key: `ROLE_HEAD_ANY:${ch}`,
        scale: 0.65,
        cap: 3.6,
      });
    } else if (runLen >= 2 && relPos === runLen - 1) {
      features.push({
        key: `ROLE_TAIL:${ch}`,
        scale: 0.45,
        cap: 2.8,
      });
    } else if (runLen >= 3 && relPos > 0 && relPos < runLen - 1) {
      features.push({
        key: `ROLE_MID:${ch}`,
        scale: 0.35,
        cap: 2.2,
      });
    }
  }

  return features;
}

/**
 * Stateful Continual-Learning Feedback Engine.
 */
export class FeedbackLearner {
  constructor() {
    /** @type {Array<any>} */
    this.entries = [];
    /** @type {Record<string, Record<string, number>>} */
    this.weights = Object.create(null);
    /** @type {number} */
    this.revision = 0;

    // Neural vocabulary & lexicon bindings (attached once ONNX assets load)
    /** @type {string[] | null} */
    this.vocabChars = null;
    /** @type {string[] | null} */
    this.vocabLabels = null;
    /** @type {Map<string, number> | null} */
    this.labelToId = null;
    /** @type {Set<string> | null} */
    this.labelSet = null;

    /** @type {{ kanjiCandidates: Record<string, string[]>, readings: Record<string, string[]> } | null} */
    this.runtimeLexicon = null;
    /** @type {Map<string, string[] | undefined>} */
    this._origReadingsBackup = new Map();
    /** @type {Map<string, string[] | undefined>} */
    this._origKanjiBackup = new Map();
    /** @type {((text: string) => Promise<Float32Array | null>) | null} */
    this.baseProbsRunner = null;

    // Fast lookup indexes rebuilt from `entries`
    /** @type {Map<string, Array<any>>} */
    this.entriesBySurface = new Map();
    /** @type {Map<string, Array<any>>} */
    this.entriesByNormSurface = new Map();
    /** @type {Map<string, Set<string>>} */
    this.learnedSubSpanReadings = new Map();
    /** @type {number} */
    this.maxEntryNormCharLen = 0;
  }

  /**
   * Attaches Horse Furigana vocabulary, mutable in-memory lexicon tables, and an optional
   * base ONNX forward runner so online gradient updates calibrate directly against base neural probs.
   */
  attachModelAssets({ vocab, runtimeLexicon, baseProbsRunner = null }) {
    if (vocab && Array.isArray(vocab.chars) && Array.isArray(vocab.labels)) {
      this.vocabChars = vocab.chars;
      this.vocabLabels = vocab.labels;
      this.labelToId = new Map();
      this.labelSet = new Set();
      for (let i = 0; i < vocab.labels.length; i++) {
        this.labelToId.set(vocab.labels[i], i);
        this.labelSet.add(vocab.labels[i]);
      }
    }
    this.runtimeLexicon = runtimeLexicon || null;
    this._origReadingsBackup = new Map();
    this._origKanjiBackup = new Map();
    if (baseProbsRunner) {
      this.baseProbsRunner = baseProbsRunner;
    }
  }

  /**
   * Serializes state for `chrome.storage.local`.
   */
  toJSON() {
    return {
      version: FEEDBACK_SCHEMA_VERSION,
      revision: this.revision,
      entries: this.entries.map((e) => {
        const copy = { ...e, pitches: [...(e.pitches || [])] };
        delete copy._aligned;
        return copy;
      }),
      weights: JSON.parse(JSON.stringify(this.weights)),
    };
  }

  /**
   * Restores state from `chrome.storage.local` and synchronizes runtime lexicon & indexes.
   *
   * @param {any} rawState
   */
  async loadState(rawState) {
    if (!rawState || typeof rawState !== 'object') {
      this.entries = [];
      this.weights = Object.create(null);
      this.revision = 0;
      this._rebuildIndexesAndLexicon();
      return;
    }

    this.revision =
      Number.isInteger(rawState.revision) && rawState.revision >= 0 ? rawState.revision : 0;

    const rawEntries = Array.isArray(rawState.entries) ? rawState.entries : [];
    this.entries = rawEntries
      .filter((e) => e && typeof e.surface === 'string' && typeof e.reading === 'string')
      .slice(0, MAX_FEEDBACK_ENTRIES)
      .map((e) => {
        const cleanSurf = cleanFeedbackSurface(e.surface) || e.surface.trim();
        const computedNorm =
          normalizeWithSpanMapping(e.normSurface || cleanSurf).normText || e.normSurface || cleanSurf;
        return {
          id: String(e.id || `${cleanSurf}::${e.contextBefore || ''}|${e.contextAfter || ''}`),
          rawSurface: typeof e.rawSurface === 'string' ? e.rawSurface : e.surface,
          surface: cleanSurf,
          normSurface: computedNorm,
          reading: normalizeReadingKana(e.reading),
          pitches: Array.isArray(e.pitches) ? e.pitches.filter((n) => Number.isInteger(n)) : [],
          contextText: typeof e.contextText === 'string' ? e.contextText : '',
          contextStart: typeof e.contextStart === 'number' ? e.contextStart : -1,
          contextEnd: typeof e.contextEnd === 'number' ? e.contextEnd : -1,
          normContextText: typeof e.normContextText === 'string' ? e.normContextText : '',
          normContextStart: typeof e.normContextStart === 'number' ? e.normContextStart : -1,
          normContextEnd: typeof e.normContextEnd === 'number' ? e.normContextEnd : -1,
          contextBefore: typeof e.contextBefore === 'string' ? e.contextBefore : '',
          contextAfter: typeof e.contextAfter === 'string' ? e.contextAfter : '',
          isContextualPolyphone: Boolean(e.isContextualPolyphone),
          previousReading: typeof e.previousReading === 'string' ? e.previousReading : '',
          createdAt: Number(e.createdAt) || Date.now(),
          updatedAt: Number(e.updatedAt) || Date.now(),
          count: Math.max(1, Number(e.count) || 1),
        };
      });

    this.weights = Object.create(null);
    this._rebuildIndexesAndLexicon();

    if (rawState.weights && typeof rawState.weights === 'object' && Object.keys(rawState.weights).length > 0) {
      for (const [fKey, labelMap] of Object.entries(rawState.weights)) {
        if (labelMap && typeof labelMap === 'object') {
          this.weights[fKey] = { ...labelMap };
        }
      }
    } else if (this.entries.length > 0) {
      await this.retrainAll();
    }
  }

  /**
   * Returns a newest-first copy of learned entries for UI display.
   */
  listEntries() {
    return [...this.entries]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((e) => ({
        id: e.id,
        surface: e.surface,
        normSurface: e.normSurface,
        reading: e.reading,
        pitches: [...(e.pitches || [])],
        contextBefore: e.contextBefore || '',
        contextAfter: e.contextAfter || '',
        isContextualPolyphone: Boolean(e.isContextualPolyphone),
        previousReading: e.previousReading || '',
        updatedAt: e.updatedAt,
        count: e.count,
      }));
  }

  /**
   * Checks whether `surface` already has multiple distinct standard readings or a conflicting
   * standard dictionary reading when taught inside a sentence context.
   */
  _detectContextualPolyphone(surface, normSurface, reading, hasSentenceContext, dict) {
    if (!hasSentenceContext) {
      return false;
    }
    const baseReadings = new Set();
    if (dict && Object.hasOwn(dict, surface)) {
      for (const tuple of dict[surface]) {
        if (tuple[4] !== 1 && tuple[0]) baseReadings.add(normalizeReadingKana(tuple[0]));
      }
    }
    if (dict && normSurface !== surface && Object.hasOwn(dict, normSurface)) {
      for (const tuple of dict[normSurface]) {
        if (tuple[4] !== 1 && tuple[0]) baseReadings.add(normalizeReadingKana(tuple[0]));
      }
    }
    const lexList = this._origReadingsBackup.has(normSurface)
      ? this._origReadingsBackup.get(normSurface)
      : this.runtimeLexicon?.readings?.[normSurface];
    if (Array.isArray(lexList)) {
      for (const r of lexList) {
        baseReadings.add(normalizeReadingKana(r));
      }
    }
    // Only treat as context-dependent polyphone if `reading` is ALREADY one of multiple known
    // readings of an established word (e.g. `人気` -> `ひとけ` vs `にんき`, `辛い` -> `つらい` vs `からい`).
    // If the user teaches a brand-new reading (e.g. `月王子` -> `つきおうじ` or `月神` -> `つきがみ`),
    // it is a general lexical preference that should apply everywhere!
    return baseReadings.size >= 2 && baseReadings.has(reading);
  }

  /**
   * Records a user feedback example, runs online gradient updates on the neural logit adapter,
   * updates the dynamic runtime lexicon, and returns the saved entry.
   *
   * @param {{
   *   surface: string,
   *   normSurface?: string,
   *   reading: string,
   *   pitches?: string | number | number[],
   *   contextText?: string,
   *   contextStart?: number,
   *   contextEnd?: number,
   *   previousReading?: string,
   *   dict?: Record<string, any> | null
   * }} params
   */
  async recordFeedback(params) {
    const rawSurface = String(params?.surface ?? '').trim();
    const surface = cleanFeedbackSurface(rawSurface) || rawSurface;
    if (!surface || !KANJI_OR_ITER_RE.test(surface)) {
      throw new Error('Target word must contain at least one Japanese Kanji.');
    }

    const validatedReading = validateUserReading(params?.reading ?? '');
    if (!validatedReading.ok) {
      throw new Error(validatedReading.error);
    }

    const reading = validatedReading.reading;
    const moraCount = splitMorae(reading).length;
    const parsedPitches = parseUserPitches(params?.pitches, moraCount, reading);
    if (!parsedPitches.ok) {
      throw new Error(parsedPitches.error);
    }

    const rawNormInput = cleanFeedbackSurface(String(params?.normSurface || '')) || surface;
    const normSurface = normalizeWithSpanMapping(rawNormInput).normText || rawNormInput;

    const contextText = typeof params?.contextText === 'string' ? params.contextText : '';
    let contextStart = typeof params?.contextStart === 'number' ? params.contextStart : -1;
    let contextEnd = typeof params?.contextEnd === 'number' ? params.contextEnd : -1;

    // If `rawSurface` had outer brackets/punctuation trimmed (e.g. `「月王子」` -> `月王子`),
    // narrow `[contextStart, contextEnd]` to the inner `surface` slice inside `contextText`.
    if (
      contextText &&
      contextStart >= 0 &&
      contextEnd <= contextText.length &&
      surface !== rawSurface
    ) {
      const outerSlice = contextText.slice(contextStart, contextEnd);
      const innerOffset = outerSlice.indexOf(surface);
      if (innerOffset >= 0) {
        contextStart += innerOffset;
        contextEnd = contextStart + surface.length;
      }
    }

    let normContextText = '';
    let normContextStart = -1;
    let normContextEnd = -1;
    if (contextText && contextStart >= 0 && contextEnd > contextStart && contextEnd <= contextText.length) {
      const mapped = normalizeWithSpanMapping(contextText, contextStart, contextEnd);
      normContextText = mapped.normText;
      normContextStart = mapped.normStart;
      normContextEnd = mapped.normEnd;
    }

    const ctxWin =
      normContextText && normContextStart >= 0 && normContextEnd >= normContextStart
        ? extractContextWindow(normContextText, normContextStart, normContextEnd)
        : extractContextWindow(contextText, contextStart, contextEnd);

    const isContextualPolyphone = this._detectContextualPolyphone(
      surface,
      normSurface,
      reading,
      ctxWin.hasSentenceContext,
      params?.dict || null
    );

    const entryKey = isContextualPolyphone
      ? `${normSurface}::ctx::${ctxWin.before}|${ctxWin.after}`
      : `${normSurface}::word`;

    const now = Date.now();
    const existingIdx = this.entries.findIndex(
      (e) =>
        e.id === entryKey ||
        (!isContextualPolyphone && !e.isContextualPolyphone && (e.normSurface === normSurface || e.surface === surface))
    );

    const entry = {
      id: entryKey,
      rawSurface,
      surface,
      normSurface,
      reading,
      pitches: parsedPitches.pitches,
      contextText: ctxWin.hasSentenceContext ? contextText : '',
      contextStart: ctxWin.hasSentenceContext ? contextStart : -1,
      contextEnd: ctxWin.hasSentenceContext ? contextEnd : -1,
      normContextText: ctxWin.hasSentenceContext ? normContextText : '',
      normContextStart: ctxWin.hasSentenceContext ? normContextStart : -1,
      normContextEnd: ctxWin.hasSentenceContext ? normContextEnd : -1,
      contextBefore: ctxWin.before,
      contextAfter: ctxWin.after,
      isContextualPolyphone,
      previousReading:
        typeof params?.previousReading === 'string'
          ? normalizeReadingKana(params.previousReading)
          : '',
      createdAt: existingIdx >= 0 ? this.entries[existingIdx].createdAt : now,
      updatedAt: now,
      count: existingIdx >= 0 ? (this.entries[existingIdx].count || 1) + 1 : 1,
    };

    const wasReplacement = existingIdx >= 0;
    if (wasReplacement) {
      this.entries[existingIdx] = entry;
    } else {
      this.entries.push(entry);
      if (this.entries.length > MAX_FEEDBACK_ENTRIES) {
        this.entries.shift();
      }
    }

    this.revision += 1;

    if (wasReplacement) {
      await this.retrainAll();
    } else {
      this._rebuildIndexesAndLexicon();
      await this._trainSingleEntry(entry);
    }

    return entry;
  }

  /**
   * Deletes a learned entry by `id` (or by `surface` / `normSurface`) and deterministically
   * retrains weights from remaining entries so zero stale weights linger.
   *
   * @param {string} idOrSurface
   * @returns {Promise<boolean>}
   */
  async removeFeedback(idOrSurface) {
    const key = String(idOrSurface ?? '').trim();
    if (!key) return false;
    const cleanKey = cleanFeedbackSurface(key) || key;

    const beforeLen = this.entries.length;
    this.entries = this.entries.filter(
      (e) =>
        e.id !== key &&
        e.surface !== key &&
        e.surface !== cleanKey &&
        e.normSurface !== key &&
        e.normSurface !== cleanKey &&
        e.rawSurface !== key
    );
    if (this.entries.length === beforeLen) {
      return false;
    }

    this.revision += 1;
    await this.retrainAll();
    return true;
  }

  /**
   * Clears all learned feedback entries and resets runtime lexicon & neural adapter weights.
   */
  async clearAll() {
    this.entries = [];
    this.weights = Object.create(null);
    this.revision += 1;
    this._rebuildIndexesAndLexicon();
  }

  /**
   * Rebuilds fast lookup maps AND resets + populates the mutable in-memory `runtimeLexicon`
   * from the pristine `baseLexiconSnapshot` without ever touching files on disk.
   */
  _rebuildIndexesAndLexicon() {
    this.entriesBySurface.clear();
    this.entriesByNormSurface.clear();
    this.learnedSubSpanReadings.clear();
    this.maxEntryNormCharLen = 0;

    // 1. Restore modified lexicon keys from lazy copy-on-write backup first
    if (this.runtimeLexicon) {
      for (const [k, origArr] of this._origReadingsBackup.entries()) {
        if (origArr !== undefined) {
          this.runtimeLexicon.readings[k] = [...origArr];
        } else {
          delete this.runtimeLexicon.readings[k];
        }
      }
      for (const [k, origVal] of this._origKanjiBackup.entries()) {
        if (origVal !== undefined) {
          this.runtimeLexicon.kanjiCandidates[k] = cloneKanjiCandidateEntry(origVal);
        } else {
          delete this.runtimeLexicon.kanjiCandidates[k];
        }
      }
    }

    const kanjiCandRef = this.runtimeLexicon?.kanjiCandidates || null;

    // Process oldest -> newest so newest entries sit at index 0 (highest priority)
    const chronological = [...this.entries].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

    for (const entry of chronological) {
      const addMapItem = (map, key, val) => {
        const arr = map.get(key) || [];
        // Keep newest first in lookup lists
        arr.unshift(val);
        map.set(key, arr);
      };

      addMapItem(this.entriesBySurface, entry.surface, entry);
      if (entry.rawSurface && entry.rawSurface !== entry.surface) {
        addMapItem(this.entriesBySurface, entry.rawSurface, entry);
      }
      addMapItem(this.entriesByNormSurface, entry.normSurface, entry);

      const normLen = Array.from(entry.normSurface).length;
      if (normLen > this.maxEntryNormCharLen) {
        this.maxEntryNormCharLen = normLen;
      }

      // Also index conjugated stem if applicable (`喰らった` -> `喰` = `く`)
      const stemInfo = extractStemBeforeOkurigana(entry.normSurface, entry.reading);
      if (stemInfo) {
        const set = this.learnedSubSpanReadings.get(stemInfo.stemSurface) || new Set();
        set.add(stemInfo.stemReading);
        this.learnedSubSpanReadings.set(stemInfo.stemSurface, set);
      }

      const fullSet = this.learnedSubSpanReadings.get(entry.normSurface) || new Set();
      fullSet.add(entry.reading);
      this.learnedSubSpanReadings.set(entry.normSurface, fullSet);

      // Align per-character readings for sub-span alignment & kanjiCandidates enrichment
      const aligned = alignSurfaceToReading(
        entry.normSurface,
        entry.reading,
        this.labelSet,
        kanjiCandRef
      );
      entry._aligned = aligned;

      const normChars = Array.from(entry.normSurface);
      if (aligned.charReadings.length === normChars.length) {
        for (let i = 0; i < normChars.length; i++) {
          const ch = normChars[i];
          const piece = aligned.charReadings[i];
          if (KANJI_OR_ITER_RE.test(ch) && piece) {
            const cSet = this.learnedSubSpanReadings.get(ch) || new Set();
            cSet.add(piece);
            this.learnedSubSpanReadings.set(ch, cSet);

            // Inject character reading into in-memory `kanjiCandidates[ch]` so Horse Furigana's
            // candidate path builder can generate unseen compounds using this Kanji reading!
            if (this.runtimeLexicon?.kanjiCandidates && SINGLE_HAN_RE.test(ch)) {
              if (!this._origKanjiBackup.has(ch)) {
                const orig = Object.hasOwn(this.runtimeLexicon.kanjiCandidates, ch)
                  ? cloneKanjiCandidateEntry(this.runtimeLexicon.kanjiCandidates[ch])
                  : undefined;
                this._origKanjiBackup.set(ch, orig);
              }
              addPieceToKanjiCandidates(this.runtimeLexicon.kanjiCandidates, ch, piece);
            }
          }
        }
      }

      // Inject non-contextual word reading at rank 0 of `runtimeLexicon.readings[normSurface]`
      if (this.runtimeLexicon?.readings && !entry.isContextualPolyphone) {
        const targetSurf = entry.normSurface;
        if (Array.from(targetSurf).length >= 1) {
          if (!this._origReadingsBackup.has(targetSurf)) {
            const orig = Object.hasOwn(this.runtimeLexicon.readings, targetSurf)
              ? [...this.runtimeLexicon.readings[targetSurf]]
              : undefined;
            this._origReadingsBackup.set(targetSurf, orig);
          }
          const prev = this.runtimeLexicon.readings[targetSurf] || [];
          this.runtimeLexicon.readings[targetSurf] = [
            entry.reading,
            ...prev.filter((r) => normalizeReadingKana(r) !== entry.reading),
          ];
        }
      }
    }
  }

  /**
   * Rebuilds all indexes and retrains online neural adapter weights from scratch across `this.entries`.
   */
  async retrainAll() {
    this.weights = Object.create(null);
    this._rebuildIndexesAndLexicon();
    const chronological = [...this.entries].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (const entry of chronological) {
      await this._trainSingleEntry(entry);
    }
  }

  /**
   * Computes learned log-odds adjustments `Map<labelStr, deltaLogit>` at `chars[pos]`.
   *
   * @param {string[]} chars
   * @param {number} pos
   * @returns {Map<string, number> | null}
   */
  scorePosition(chars, pos) {
    const feats = extractKanjiFeatures(chars, pos, { isContextualPolyphone: false });
    if (feats.length === 0) return null;

    /** @type {Map<string, number> | null} */
    let totals = null;
    for (const f of feats) {
      const wMap = this.weights[f.key];
      if (!wMap) continue;
      if (!totals) totals = new Map();
      for (const [label, w] of Object.entries(wMap)) {
        if (w === 0) continue;
        totals.set(label, (totals.get(label) || 0) + w);
      }
    }
    return totals;
  }

  /**
   * Runs online multiclass cross-entropy / margin gradient updates for a single feedback entry,
   * calibrating directly against the base ONNX neural model's probabilities when attached!
   */
  async _trainSingleEntry(entry) {
    const kanjiCandRef = this.runtimeLexicon?.kanjiCandidates || null;

    // Also train conjugated stem if okurigana-bearing (`喰らった` -> `喰` before `らった`)
    const targetsToTrain = [];

    const hasNormCtx =
      entry.normContextText &&
      entry.normContextStart >= 0 &&
      entry.normContextEnd <= entry.normContextText.length &&
      entry.normContextText.slice(entry.normContextStart, entry.normContextEnd) === entry.normSurface;

    const hasRawCtx =
      !hasNormCtx &&
      entry.contextText &&
      entry.contextStart >= 0 &&
      entry.contextEnd <= entry.contextText.length &&
      entry.contextText.slice(entry.contextStart, entry.contextEnd) === entry.surface;

    const hasValidCtx = Boolean(hasNormCtx || hasRawCtx);

    const fullSeqStr = hasNormCtx
      ? entry.normContextText
      : hasRawCtx
        ? entry.contextText.slice(0, entry.contextStart) +
          entry.normSurface +
          entry.contextText.slice(entry.contextEnd)
        : entry.normSurface;

    const seqChars = Array.from(fullSeqStr);
    const spanCharStart = hasNormCtx
      ? Array.from(entry.normContextText.slice(0, entry.normContextStart)).length
      : hasRawCtx
        ? Array.from(entry.contextText.slice(0, entry.contextStart)).length
        : 0;

    const aligned =
      entry._aligned ||
      alignSurfaceToReading(entry.normSurface, entry.reading, this.labelSet, kanjiCandRef);
    entry._aligned = aligned;

    const normChars = Array.from(entry.normSurface);
    if (aligned.vocabLabels.length === normChars.length) {
      targetsToTrain.push({
        seqStr: fullSeqStr,
        seqChars,
        spanCharStart,
        normChars,
        vocabLabels: aligned.vocabLabels,
        isContextualPolyphone: entry.isContextualPolyphone,
      });
    }

    // Also train isolated `normSurface` when non-contextual so standalone & sentence both converge
    if (hasValidCtx && !entry.isContextualPolyphone && aligned.vocabLabels.length === normChars.length) {
      targetsToTrain.push({
        seqStr: entry.normSurface,
        seqChars: normChars,
        spanCharStart: 0,
        normChars,
        vocabLabels: aligned.vocabLabels,
        isContextualPolyphone: false,
      });
    }

    for (const tSpec of targetsToTrain) {
      let baseProbs = null;
      if (this.baseProbsRunner && this.vocabLabels) {
        try {
          baseProbs = await this.baseProbsRunner(tSpec.seqStr);
        } catch {
          baseProbs = null;
        }
      }

      const V = this.vocabLabels ? this.vocabLabels.length : 0;
      const steps = Math.min(6, 3 + (entry.count || 1));
      const lr = 0.85;

      // Pass A: One regularized generalization step on non-WORD features against `baseProbs`
      // so `WORD` memorization does not starve prefix/suffix/context generalization!
      for (let i = 0; i < tSpec.normChars.length; i++) {
        const targetLabel = tSpec.vocabLabels[i];
        if (!targetLabel || targetLabel === '<kana>') continue;
        const pos = tSpec.spanCharStart + i;
        if (pos < 0 || pos >= tSpec.seqChars.length) continue;

        const genFeats = extractKanjiFeatures(tSpec.seqChars, pos, {
          isContextualPolyphone: tSpec.isContextualPolyphone,
        }).filter((f) => !f.key.startsWith('WORD:'));
        if (genFeats.length === 0) continue;

        const candidateLabels = new Set([targetLabel]);
        const ch = tSpec.normChars[i];
        for (const kc of getKanjiCandidateStrings(kanjiCandRef, ch)) {
          for (const v of expandKanaVariants(normalizeReadingKana(kc))) {
            if (!this.labelSet || this.labelSet.has(v)) candidateLabels.add(v);
          }
        }
        if (baseProbs && V > 0 && (pos + 1) * V <= baseProbs.length) {
          const rowOffset = pos * V;
          let top1 = -1, top2 = -1, v1 = -1, v2 = -1;
          for (let lid = 2; lid < V; lid++) {
            const p = baseProbs[rowOffset + lid];
            if (p > v1) { v2 = v1; top2 = top1; v1 = p; top1 = lid; }
            else if (p > v2) { v2 = p; top2 = lid; }
          }
          if (top1 >= 2) candidateLabels.add(this.vocabLabels[top1]);
          if (top2 >= 2) candidateLabels.add(this.vocabLabels[top2]);
        }

        const logScores = new Map();
        let maxLog = -Infinity;
        for (const lbl of candidateLabels) {
          let baseLog = -3.5;
          if (baseProbs && this.labelToId && V > 0 && (pos + 1) * V <= baseProbs.length) {
            const lid = this.labelToId.get(lbl);
            if (lid !== undefined) baseLog = Math.log(Math.max(baseProbs[pos * V + lid], 1e-7));
          } else if (lbl !== targetLabel) {
            baseLog = -1.2;
          }
          logScores.set(lbl, baseLog);
          if (baseLog > maxLog) maxLog = baseLog;
        }

        let denom = 0;
        for (const lv of logScores.values()) denom += Math.exp(lv - maxLog);

        const lrGen = 1.15;
        for (const f of genFeats) {
          let wMap = this.weights[f.key];
          if (!wMap) {
            wMap = Object.create(null);
            this.weights[f.key] = wMap;
          }
          for (const [lbl, lv] of logScores) {
            const prob = Math.exp(lv - maxLog) / (denom || 1);
            const grad = (lbl === targetLabel ? 1 : 0) - prob;
            if (Math.abs(grad) < 1e-4) continue;
            const updated = (wMap[lbl] || 0) + lrGen * f.scale * grad;
            wMap[lbl] = Math.max(-f.cap, Math.min(f.cap, Number(updated.toFixed(4))));
          }
        }
      }

      // Pass B: Joint fine-tuning across all features (`WORD` + `CTX` + `BG` + `ROLE`)
      for (let step = 0; step < steps; step++) {
        for (let i = 0; i < tSpec.normChars.length; i++) {
          const targetLabel = tSpec.vocabLabels[i];
          if (!targetLabel || targetLabel === '<kana>') continue;

          const pos = tSpec.spanCharStart + i;
          if (pos < 0 || pos >= tSpec.seqChars.length) continue;

          const feats = extractKanjiFeatures(tSpec.seqChars, pos, {
            isContextualPolyphone: tSpec.isContextualPolyphone,
          });
          if (feats.length === 0) continue;

          // Compute current rival probabilities over active candidate labels
          const candidateLabels = new Set([targetLabel]);
          if (entry.previousReading && tSpec.normChars.length === 1) {
            candidateLabels.add(entry.previousReading);
          }
          const ch = tSpec.normChars[i];
          for (const kc of getKanjiCandidateStrings(kanjiCandRef, ch)) {
            for (const v of expandKanaVariants(normalizeReadingKana(kc))) {
              if (!this.labelSet || this.labelSet.has(v)) {
                candidateLabels.add(v);
              }
            }
          }

          // Include top-3 base ONNX rival labels at `pos` (e.g. `げっ`, `げつ` for `月騎士`)
          if (baseProbs && V > 0 && (pos + 1) * V <= baseProbs.length) {
            const rowOffset = pos * V;
            let top1 = -1, top2 = -1, top3 = -1;
            let v1 = -1, v2 = -1, v3 = -1;
            for (let lid = 2; lid < V; lid++) {
              const p = baseProbs[rowOffset + lid];
              if (p > v1) {
                v3 = v2; top3 = top2;
                v2 = v1; top2 = top1;
                v1 = p; top1 = lid;
              } else if (p > v2) {
                v3 = v2; top3 = top2;
                v2 = p; top2 = lid;
              } else if (p > v3) {
                v3 = p; top3 = lid;
              }
            }
            if (top1 >= 2) candidateLabels.add(this.vocabLabels[top1]);
            if (top2 >= 2) candidateLabels.add(this.vocabLabels[top2]);
            if (top3 >= 2) candidateLabels.add(this.vocabLabels[top3]);
          }

          const currentDelta = this.scorePosition(tSpec.seqChars, pos);
          const logScores = new Map();
          let maxLog = -Infinity;

          for (const lbl of candidateLabels) {
            let baseLog = -3.5;
            if (baseProbs && this.labelToId && V > 0 && (pos + 1) * V <= baseProbs.length) {
              const lid = this.labelToId.get(lbl);
              if (lid !== undefined) {
                const rawP = Math.max(baseProbs[pos * V + lid], 1e-7);
                baseLog = Math.log(rawP);
              }
            } else if (lbl !== targetLabel) {
              baseLog = -1.2;
            }
            const lVal = baseLog + (currentDelta?.get(lbl) || 0);
            logScores.set(lbl, lVal);
            if (lVal > maxLog) maxLog = lVal;
          }

          let denom = 0;
          for (const lVal of logScores.values()) {
            denom += Math.exp(lVal - maxLog);
          }
          const targetProb = Math.exp((logScores.get(targetLabel) || maxLog) - maxLog) / (denom || 1);

          // Stop early if target probability already has decisive margin (> 0.985)
          if (targetProb > 0.985) continue;

          for (const f of feats) {
            let wMap = this.weights[f.key];
            if (!wMap) {
              wMap = Object.create(null);
              this.weights[f.key] = wMap;
            }
            for (const [lbl, lVal] of logScores) {
              const prob = Math.exp(lVal - maxLog) / (denom || 1);
              const grad = (lbl === targetLabel ? 1 : 0) - prob;
              if (Math.abs(grad) < 1e-4) continue;
              const updated = (wMap[lbl] || 0) + lr * f.scale * grad;
              wMap[lbl] = Math.max(-f.cap, Math.min(f.cap, Number(updated.toFixed(4))));
            }
          }
        }
      }
    }
  }

  /**
   * Adapts a raw ONNX output probability tensor (`Float32Array [1, L, V]`) in place or into a new
   * `Float32Array` using the learned contextual & morphological log-odds weights!
   *
   * @param {BigInt64Array | number[]} charIds
   * @param {Float32Array} probsData
   * @param {number} numLabels
   * @returns {Float32Array}
   */
  adaptProbabilities(charIds, probsData, numLabels) {
    if (
      this.entries.length === 0 ||
      !this.vocabChars ||
      !this.labelToId ||
      !probsData ||
      numLabels <= 0
    ) {
      return probsData;
    }

    const L = charIds.length;
    if (L === 0 || probsData.length < L * numLabels) {
      return probsData;
    }

    const chars = new Array(L);
    const numVocabChars = this.vocabChars.length;
    let hasAnyKanji = false;
    for (let t = 0; t < L; t++) {
      const id = Number(charIds[t]);
      const ch = id >= 1 && id <= numVocabChars ? this.vocabChars[id - 1] : '';
      chars[t] = ch;
      if (ch && KANJI_OR_ITER_RE.test(ch)) {
        hasAnyKanji = true;
      }
    }
    if (!hasAnyKanji) {
      return probsData;
    }

    let out = null;

    for (let t = 0; t < L; t++) {
      if (!chars[t] || !KANJI_OR_ITER_RE.test(chars[t])) continue;
      const deltas = this.scorePosition(chars, t);
      if (!deltas || deltas.size === 0) continue;

      if (!out) {
        out = new Float32Array(probsData);
      }

      const rowOffset = t * numLabels;
      // Apply log-space shift: p'_k \propto p_k * exp(delta_k)
      // For numerical stability, compute logProbs on shifted entries while keeping untouched entries exact.
      let untouchedSum = 0;
      const shiftedIds = [];
      const shiftedLogVals = [];
      let maxLog = -Infinity;

      const touchedSet = new Set();
      for (const [lbl, d] of deltas) {
        const lid = this.labelToId.get(lbl);
        if (lid !== undefined && lid >= 0 && lid < numLabels && Math.abs(d) > 1e-5) {
          touchedSet.add(lid);
          const baseP = Math.max(out[rowOffset + lid], 1e-8);
          const lv = Math.log(baseP) + d;
          shiftedIds.push(lid);
          shiftedLogVals.push(lv);
          if (lv > maxLog) maxLog = lv;
        }
      }

      if (shiftedIds.length === 0) continue;

      for (let k = 0; k < numLabels; k++) {
        if (!touchedSet.has(k)) {
          untouchedSum += Math.max(0, out[rowOffset + k]);
        }
      }

      // Combine untouched mass `log(untouchedSum)` and shifted log-masses cleanly
      const hasUntouched = untouchedSum > 1e-12;
      const untouchedLog = hasUntouched ? Math.log(untouchedSum) : -Infinity;
      if (untouchedLog > maxLog) {
        maxLog = untouchedLog;
      }

      let expTotal = hasUntouched ? Math.exp(untouchedLog - maxLog) : 0;
      const shiftedExps = new Float64Array(shiftedIds.length);
      for (let j = 0; j < shiftedIds.length; j++) {
        const e = Math.exp(shiftedLogVals[j] - maxLog);
        shiftedExps[j] = e;
        expTotal += e;
      }

      if (expTotal <= 0) continue;

      const untouchedScale = hasUntouched ? Math.exp(untouchedLog - maxLog) / expTotal / untouchedSum : 0;
      for (let k = 0; k < numLabels; k++) {
        if (!touchedSet.has(k)) {
          out[rowOffset + k] *= untouchedScale;
        }
      }
      for (let j = 0; j < shiftedIds.length; j++) {
        out[rowOffset + shiftedIds[j]] = shiftedExps[j] / expTotal;
      }
    }

    return out || probsData;
  }

  /**
   * Deduplicates candidate entries across both `entriesBySurface` and `entriesByNormSurface`
   * regardless of whether `normSurface === surface`.
   */
  _collectCandidateEntries(surface, normSurface = '') {
    const cleanSurf = cleanFeedbackSurface(surface) || surface;
    const computedNorm = normSurface || normalizeWithSpanMapping(cleanSurf).normText || cleanSurf;
    const keys = new Set([surface, cleanSurf, normSurface, computedNorm].filter(Boolean));
    const seen = new Set();
    const out = [];
    for (const k of keys) {
      for (const e of this.entriesBySurface.get(k) || []) {
        if (!seen.has(e)) {
          seen.add(e);
          out.push(e);
        }
      }
      for (const e of this.entriesByNormSurface.get(k) || []) {
        if (!seen.has(e)) {
          seen.add(e);
          out.push(e);
        }
      }
    }
    return out;
  }

  /**
   * Resolves a direct user-learned entry for `(surface, normSurface)` in optional context.
   * For contextual polyphones, matches only when context overlaps without contradicting the
   * discriminating neighbor side!
   *
   * @param {string} surface
   * @param {string} [normSurface]
   * @param {{ contextText?: string, contextStart?: number, contextEnd?: number }} [ctx]
   */
  findDirectMatch(surface, normSurface = '', ctx = {}) {
    if (this.entries.length === 0) return null;

    const candidates = this._collectCandidateEntries(surface, normSurface);
    if (candidates.length === 0) return null;

    const rawCtxText = ctx?.contextText || '';
    const rawStart = typeof ctx?.contextStart === 'number' ? ctx.contextStart : -1;
    const rawEnd = typeof ctx?.contextEnd === 'number' ? ctx.contextEnd : -1;

    let win;
    if (rawCtxText && rawStart >= 0 && rawEnd >= rawStart && rawEnd <= rawCtxText.length) {
      const mapped = normalizeWithSpanMapping(rawCtxText, rawStart, rawEnd);
      win =
        mapped.normText && mapped.normStart >= 0 && mapped.normEnd >= mapped.normStart
          ? extractContextWindow(mapped.normText, mapped.normStart, mapped.normEnd)
          : extractContextWindow(rawCtxText, rawStart, rawEnd);
    } else {
      win = extractContextWindow(rawCtxText, rawStart, rawEnd);
    }

    // 1. Contextual polyphone match (strictly checks right-hand / left-hand consistency)
    if (win.hasSentenceContext) {
      for (const e of candidates) {
        if (!e.isContextualPolyphone) continue;

        const eAfterCps = Array.from(e.contextAfter || '');
        const eBeforeCps = Array.from(e.contextBefore || '');
        const reqAfterPrefix = eAfterCps.slice(0, Math.min(2, eAfterCps.length)).join('');
        const reqBeforeSuffix = eBeforeCps.slice(-Math.min(2, eBeforeCps.length)).join('');

        // If the learned example had following context (e.g. `人気がない`), any non-empty
        // following context in the query MUST agree with `reqAfterPrefix` (prevents `店の人気がある`
        // from matching `店の人気がない` just because both share `の` before `人気`!).
        if (reqAfterPrefix) {
          if (win.after && win.after.startsWith(reqAfterPrefix)) {
            return e;
          }
          continue;
        }

        // Only when `e.contextAfter` was empty (phrase-final target) do we match on `before` suffix
        if (reqBeforeSuffix && win.before && win.before.endsWith(reqBeforeSuffix)) {
          return e;
        }
      }
    }

    // 2. General (non-contextual) learned word entry
    for (const e of candidates) {
      if (!e.isContextualPolyphone) {
        return e;
      }
    }

    return null;
  }

  /**
   * Returns user-learned pitch accent array for `(surface, reading)` if the user taught pitches.
   *
   * @param {string} surface
   * @param {string} reading
   * @param {string} [normSurface]
   * @returns {number[]}
   */
  lookupLearnedPitches(surface, reading, normSurface = '') {
    if (this.entries.length === 0) return [];
    const hira = normalizeReadingKana(reading);
    const list = this._collectCandidateEntries(surface, normSurface);
    for (const e of list) {
      if (e.reading === hira && Array.isArray(e.pitches) && e.pitches.length > 0) {
        return [...e.pitches];
      }
    }
    return [];
  }

  /**
   * Returns learned sub-span reading candidates for `subSurface` (used in `collectSubSpanCandidates`).
   *
   * @param {string} subSurface
   * @returns {string[]}
   */
  getSubSpanCandidates(subSurface) {
    const set = this.learnedSubSpanReadings.get(subSurface);
    return set ? [...set] : [];
  }

  /**
   * Post-aligns `guarded` normalized segments in `annotateWithAI` so non-compositional / ateji /
   * gikun user-taught words (e.g. `聖剣` -> `えくすかりばー`, `月王子` -> `つきおうじ`) are guaranteed
   * to take their taught reading even when embedded inside full sentences (`聖剣を抜いた`, `月王子様`).
   *
   * @param {Array<{ normStart: number, normEnd: number, normSurface: string, reading: string, isKanji: boolean }>} segments
   * @param {string} normText
   */
  applyLearnedSpansToSegments(segments, normText) {
    if (this.entries.length === 0 || !normText || segments.length === 0) {
      return segments;
    }

    // Collect general (non-contextual-polyphone) multi-char or single-char exact segment matches
    const generalEntries = this.entries.filter((e) => !e.isContextualPolyphone);
    if (generalEntries.length === 0) {
      return segments;
    }

    // First pass: exact segment match or conjugated stem+okurigana match
    const updated = segments.map((seg, idx) => {
      if (!seg.isKanji) return seg;

      // Exact segment match
      const directList = this.entriesByNormSurface.get(seg.normSurface);
      const generalDirect = directList?.find((e) => !e.isContextualPolyphone);
      if (generalDirect && Array.from(seg.normSurface).length >= 2) {
        return { ...seg, reading: generalDirect.reading, learned: true };
      }

      // Single-Kanji segment match when followed by learned okurigana (e.g. `喰` + `らう` from `喰らった` -> `くらった`)
      const nextSeg = idx + 1 < segments.length ? segments[idx + 1] : null;
      if (nextSeg && !nextSeg.isKanji) {
        for (const e of generalEntries) {
          const stemInfo = extractStemBeforeOkurigana(e.normSurface, e.reading);
          if (
            stemInfo &&
            stemInfo.stemSurface === seg.normSurface &&
            nextSeg.normSurface.startsWith(stemInfo.okurigana[0])
          ) {
            return { ...seg, reading: stemInfo.stemReading, learned: true };
          }
        }
      }

      return seg;
    });

    // Second pass: multi-character learned phrase spanning inside or across adjacent segments
    // (e.g. `聖剣` -> `えくすかりばー` or `月王子` inside `月王子様` where segment was `月王子様`)
    const multiEntries = generalEntries
      .filter((e) => Array.from(e.normSurface).length >= 2)
      .sort((a, b) => b.normSurface.length - a.normSurface.length);

    if (multiEntries.length === 0) {
      return updated;
    }

    const result = [];
    let i = 0;
    while (i < updated.length) {
      const seg = updated[i];

      // Case A: Multiple consecutive segments combine to equal a learned entry (e.g. `月` + `王子` -> `月王子`)
      let mergedMatch = null;
      let mergedEndIdx = i;
      let combinedNorm = '';
      for (let j = i; j < Math.min(updated.length, i + 5); j++) {
        combinedNorm += updated[j].normSurface;
        const m = multiEntries.find((e) => e.normSurface === combinedNorm);
        if (m) {
          mergedMatch = m;
          mergedEndIdx = j;
        }
      }

      if (mergedMatch && mergedEndIdx > i) {
        result.push({
          normStart: updated[i].normStart,
          normEnd: updated[mergedEndIdx].normEnd,
          normSurface: mergedMatch.normSurface,
          reading: mergedMatch.reading,
          isKanji: true,
          learned: true,
        });
        i = mergedEndIdx + 1;
        continue;
      }

      // Case B: Single larger Kanji segment starts with a learned multi-Kanji compound + honorific/plural suffix
      // (e.g. `月王子様`, `月王子達`, `月王子殿`, `聖剣使い`)
      if (seg.isKanji && !seg.learned) {
        const prefixEntry = multiEntries.find(
          (e) =>
            seg.normSurface.startsWith(e.normSurface) &&
            seg.normSurface.length > e.normSurface.length
        );
        if (prefixEntry) {
          const tailSurface = seg.normSurface.slice(prefixEntry.normSurface.length);
          const COMMON_SUFFIX_READINGS = {
            様: 'さま',
            達: 'たち',
            殿: 'どの',
            氏: 'し',
            君: 'くん',
            ちゃん: 'ちゃん',
            団: 'だん',
            軍: 'ぐん',
            国: 'こく',
            城: 'じょう',
            領: 'りょう',
            編: 'へん',
            戦: 'せん',
          };
          if (Object.hasOwn(COMMON_SUFFIX_READINGS, tailSurface)) {
            const splitNorm = seg.normStart + prefixEntry.normSurface.length;
            result.push({
              normStart: seg.normStart,
              normEnd: splitNorm,
              normSurface: prefixEntry.normSurface,
              reading: prefixEntry.reading,
              isKanji: true,
              learned: true,
            });
            result.push({
              normStart: splitNorm,
              normEnd: seg.normEnd,
              normSurface: tailSurface,
              reading: COMMON_SUFFIX_READINGS[tailSurface],
              isKanji: KANJI_OR_ITER_RE.test(tailSurface),
            });
            i++;
            continue;
          }
        }
      }

      result.push(seg);
      i++;
    }

    return result;
  }
}

/**
 * Wraps `ort` so `InferenceSession.create(...)` exposes both:
 *   - `baseProbsRunner(text)` for online cross-entropy calibration against unadapted ONNX probs
 *   - Automatic `learner.adaptProbabilities(...)` inside `session.run()` during Horse Furigana inference!
 */
export function createAdaptiveOrt(baseOrt, learner, vocab) {
  let rawSession = null;

  const runRawProbs = async (text) => {
    if (!rawSession || !vocab || !text) return null;
    const chars = Array.from(text);
    if (chars.length === 0) return null;

    const numVocab = vocab.chars.length;
    const ids = new BigInt64Array(chars.length);
    for (let i = 0; i < chars.length; i++) {
      const idx = vocab.chars.indexOf(chars[i]);
      if (idx >= 0) {
        ids[i] = BigInt(idx + 1);
      } else {
        // Match Horse Furigana OOV hash bucket (`numVocab + 1 + (fnv1a % 256)`)
        let h = 2166136261;
        for (let k = 0; k < chars[i].length; k++) {
          h ^= chars[i].charCodeAt(k);
          h = Math.imul(h, 16777619) >>> 0;
        }
        ids[i] = BigInt(numVocab + 1 + (h % 256));
      }
    }

    const out = await rawSession.run({
      char_inputs: new baseOrt.Tensor('int64', ids, [1, chars.length]),
      input_lengths: new baseOrt.Tensor('int64', BigInt64Array.from([BigInt(chars.length)]), [1]),
    });
    return out?.logits?.data || null;
  };

  const wrappedOrt = {
    ...baseOrt,
    InferenceSession: {
      ...baseOrt.InferenceSession,
      async create(modelBytes, options) {
        const session = await baseOrt.InferenceSession.create(modelBytes, options);
        rawSession = session;
        learner.baseProbsRunner = runRawProbs;

        return new Proxy(session, {
          get(target, prop, receiver) {
            if (prop === 'run') {
              return async (feeds, ...rest) => {
                const results = await target.run(feeds, ...rest);
                if (
                  learner &&
                  learner.entries.length > 0 &&
                  feeds?.char_inputs?.data &&
                  results?.logits?.data &&
                  results.logits.dims?.length === 3
                ) {
                  const numLabels = results.logits.dims[2];
                  const adapted = learner.adaptProbabilities(
                    feeds.char_inputs.data,
                    results.logits.data,
                    numLabels
                  );
                  if (adapted !== results.logits.data) {
                    return {
                      ...results,
                      logits: new baseOrt.Tensor('float32', adapted, results.logits.dims),
                    };
                  }
                }
                return results;
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' ? val.bind(target) : val;
          },
        });
      },
    },
  };

  return { wrappedOrt, runRawProbs };
}

/** Singleton default learner shared by the AI annotator in the current runtime. */
export const defaultFeedbackLearner = new FeedbackLearner();
