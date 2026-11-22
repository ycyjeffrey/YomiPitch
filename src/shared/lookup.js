/**
 * Primary Kanji reading & pitch accent lookup engine:
 *   1. Punctuation / whitespace normalization
 *   2. Exact dictionary headword lookup (preserving equal-likelihood ties)
 *   3. Verb / i-adjective / suru-verb deinflection with full reading reconstruction
 *   4. Greedy longest-match multi-word / compound phrase segmentation fallback
 */

import {
  annotateWithAI,
  getAnnotator,
  kataToHira,
  normalizeForAnnotation,
  parseKanjiIntUnder10000,
  readNumberForKaCounter,
} from './ai-engine.js';
import { deinflectWord } from './deinflect.js';
import { defaultFeedbackLearner } from './feedback-learner.js';
import { buildPitchContours } from './pitch.js';

export const KANJI_RE = /[\p{Script=Han}々〆ヵヶ]/u;

const SINGLE_HAN_RE = /^\p{Script=Han}$/u;
const NON_BMP_HAN_RE = /[\u{10000}-\u{3FFFF}]/u;
const DIGIT_CHAR_RE = /^[0-9０-９]$/;
const DIGIT_OR_KA_MARK_RE = /[0-9０-９]|[0-9０-９一二三四五六七八九十百千万億兆〇零何幾数][ヶヵ]/;
const TEMPORAL_MONTH_COUNTER_RE = /[ヶかカ箇]月$/;

const COUNTER_EXPR_RE =
  /^([0-9０-９]{1,4}|[一二三四五六七八九十百千]{1,9}|(?:[一二三四五六七八九]?[十百千])?数|何|幾)(ヶ月|か月|カ月|箇月|ヶ所|か所|カ所|箇所|ヶ国|か国|カ国|箇国)$/;

const COUNTER_WITH_TRAIL_RE =
  /^([0-9０-９]{1,4}|[一二三四五六七八九十百千]{1,9}|(?:[一二三四五六七八九]?[十百千])?数|何|幾)(ヶ月|か月|カ月|箇月|ヶ所|か所|カ所|箇所|ヶ国|か国|カ国|箇国)[間前目後]?$/;

const COUNTER_SUFFIX_READINGS = Object.freeze({
  ヶ月: 'かげつ',
  か月: 'かげつ',
  カ月: 'かげつ',
  箇月: 'かげつ',
  ヶ所: 'かしょ',
  か所: 'かしょ',
  カ所: 'かしょ',
  箇所: 'かしょ',
  ヶ国: 'かこく',
  か国: 'かこく',
  カ国: 'かこく',
  箇国: 'かこく',
});

const KANJI_DIGITS = Object.freeze({
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
});

const KANJI_UNITS = Object.freeze({
  千: 1000,
  百: 100,
  十: 10,
});

const TRIM_CHAR_CLASS =
  '[\\s\\u3000「」『』（）()【】〈〉《》［］\\[\\]｛｝\\{\\}｟｠〘〙〖〗〝〟“”‘’"\'`´、。，．・！？!?：；:;…‥〜～｜|／/\\\\＜＞<>]';

const TRIM_PUNCT_RE = new RegExp(`^${TRIM_CHAR_CLASS}+|${TRIM_CHAR_CLASS}+$`, 'gu');
const LEAD_TRIM_RE = new RegExp(`^${TRIM_CHAR_CLASS}+`, 'u');
const TRAIL_TRIM_RE = new RegExp(`${TRIM_CHAR_CLASS}+$`, 'u');

const DAKUTEN_MAP = Object.freeze({
  か: 'が', き: 'ぎ', く: 'ぐ', け: 'げ', こ: 'ご',
  さ: 'ざ', し: 'じ', す: 'ず', せ: 'ぜ', そ: 'ぞ',
  た: 'だ', ち: 'ぢ', つ: 'づ', て: 'で', と: 'ど',
  は: 'ば', ひ: 'び', ふ: 'ぶ', へ: 'べ', ほ: 'ぼ',
});

const HANDAKUTEN_MAP = Object.freeze({
  は: 'ぱ', ひ: 'ぴ', ふ: 'ぷ', へ: 'ぺ', ほ: 'ぽ',
});

const SOKUON_TAIL_SET = new Set(['く', 'き', 'つ', 'ち']);

const MAX_SEGMENT_SPAN = 24;
const MAX_COMBINED_READINGS = 32;

/**
 * Returns true if `text` contains at least one Japanese Kanji (or Kanji iteration/counter mark).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function containsKanji(text) {
  return typeof text === 'string' && KANJI_RE.test(text);
}

/**
 * Strips leading/trailing whitespace, quotes, brackets, and Japanese/ASCII punctuation.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeSelectionText(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.replace(TRIM_PUNCT_RE, '').trim();
}

/**
 * Formats exact dictionary tuple entries `[reading, pitches?, posMask?, score?, deinflectOnly?]`,
 * excluding secondary `deinflectOnly` (`tuple[4] === 1`) entries.
 *
 * @param {Array<[string, number[]?, number?, number?, number?]>} entries
 */
function formatExactEntries(entries) {
  return entries
    .filter((tuple) => tuple[4] !== 1)
    .map((tuple) => {
      const reading = tuple[0];
      const pitches = Array.isArray(tuple[1]) ? tuple[1] : [];
      const posMask = tuple[2] || 0;
      return {
        reading,
        pitches,
        pitchContours: buildPitchContours(reading, pitches),
        posMask,
      };
    });
}

/**
 * Enriches pitchless exact entries that happen to be conjugated verb/adjective forms (e.g. 来た)
 * with base-form pitch metadata and `pitchUnavailableReason: 'inflected'`.
 */
function enrichPitchlessExactEntries(readings, surface, dict) {
  if (readings.length === 0 || !readings.every((r) => r.pitches.length === 0)) {
    return;
  }
  if (Array.from(surface).length < 2) {
    return;
  }
  const deinflected = deinflectWord(surface, dict);
  if (deinflected.length === 0) {
    return;
  }
  for (const r of readings) {
    const matchingBase = deinflected.find((d) => d.conjugatedReading === r.reading);
    if (matchingBase) {
      r.pitchUnavailableReason = 'inflected';
      r.base = {
        surface: matchingBase.baseSurface,
        reading: matchingBase.baseReading,
        pitches: matchingBase.basePitches,
        pitchContours: buildPitchContours(matchingBase.baseReading, matchingBase.basePitches),
        ruleLabel: matchingBase.labels.join(' + '),
      };
    }
  }
}

/**
 * Formats deinflected matches with full conjugated reading, checking `dict[surface]` for any
 * verified conjugated-surface pitch and setting `pitchUnavailableReason: 'inflected'` otherwise.
 */
function formatDeinflectedMatches(matches, surface, dict) {
  const exactTuples =
    surface && dict && Object.hasOwn(dict, surface)
      ? dict[surface].filter((t) => t[4] !== 1)
      : [];

  return matches.map((m) => {
    const verifiedTuple = exactTuples.find(
      (t) => t[0] === m.conjugatedReading && Array.isArray(t[1]) && t[1].length > 0
    );
    const verifiedPitches = verifiedTuple ? verifiedTuple[1] : [];
    const entry = {
      reading: m.conjugatedReading,
      pitches: verifiedPitches,
      pitchContours: buildPitchContours(m.conjugatedReading, verifiedPitches),
      base: {
        surface: m.baseSurface,
        reading: m.baseReading,
        pitches: m.basePitches,
        pitchContours: buildPitchContours(m.baseReading, m.basePitches),
        ruleLabel: m.labels.join(' + '),
      },
    };
    if (verifiedPitches.length === 0) {
      entry.pitchUnavailableReason = 'inflected';
    }
    return entry;
  });
}

/**
 * Resolves productive `X々` Kanji iteration mark words when `X々` is not directly in `dict`
 * (e.g. `町々` -> `まちまち`).
 */
function resolveIterationWord(span, dict) {
  const cps = Array.from(span);
  if (cps.length !== 2 || cps[1] !== '々' || !SINGLE_HAN_RE.test(cps[0])) {
    return null;
  }
  const baseChar = cps[0];
  if (!Object.hasOwn(dict, baseChar)) {
    return null;
  }
  const baseEntries = formatExactEntries(dict[baseChar]);
  if (baseEntries.length === 0) {
    return null;
  }
  const seen = new Set();
  const out = [];
  for (const entry of baseEntries) {
    const doubled = entry.reading + entry.reading;
    if (!seen.has(doubled)) {
      seen.add(doubled);
      out.push({
        reading: doubled,
        pitches: [],
        pitchContours: [],
      });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Parses standard Japanese Kanji numerals (1..9999) such as 三, 十, 十二, 二十四, 八十八, 三百.
 *
 * @param {string} str
 * @returns {number | null}
 */
function parseKanjiNumber(str) {
  let total = 0;
  let currentDigit = null;
  let lastUnit = Infinity;

  for (const ch of str) {
    if (Object.hasOwn(KANJI_DIGITS, ch)) {
      if (currentDigit !== null) {
        return null;
      }
      currentDigit = KANJI_DIGITS[ch];
    } else if (Object.hasOwn(KANJI_UNITS, ch)) {
      const unit = KANJI_UNITS[ch];
      if (unit >= lastUnit) {
        return null;
      }
      total += (currentDigit ?? 1) * unit;
      currentDigit = null;
      lastUnit = unit;
    } else {
      return null;
    }
  }

  total += currentDigit ?? 0;
  return total >= 1 && total <= 9999 ? total : null;
}

/**
 * Converts an integer `1..9999` into its Japanese numeral reading before a `か`-row counter
 * (`かげつ`, `かしょ`, `かこく`) or plain when `geminateFinal` is false.
 *
 * @param {number} n
 * @param {boolean} geminateFinal
 * @returns {string | null}
 */
function readJapaneseNumberForKaCounter(n, geminateFinal = true) {
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    return null;
  }

  const thousands = Math.floor(n / 1000);
  const hundreds = Math.floor((n % 1000) / 100);
  const tens = Math.floor((n % 100) / 10);
  const ones = n % 10;

  let out = '';

  if (thousands > 0) {
    const thMap = [
      '',
      'せん',
      'にせん',
      'さんぜん',
      'よんせん',
      'ごせん',
      'ろくせん',
      'ななせん',
      'はっせん',
      'きゅうせん',
    ];
    out += thMap[thousands];
  }

  if (hundreds > 0) {
    const isFinal = tens === 0 && ones === 0 && geminateFinal;
    const hPlain = [
      '',
      'ひゃく',
      'にひゃく',
      'さんびゃく',
      'よんひゃく',
      'ごひゃく',
      'ろっぴゃく',
      'ななひゃく',
      'はっぴゃく',
      'きゅうひゃく',
    ];
    const hGem = [
      '',
      'ひゃっ',
      'にひゃっ',
      'さんびゃっ',
      'よんひゃっ',
      'ごひゃっ',
      'ろっぴゃっ',
      'ななひゃっ',
      'はっぴゃっ',
      'きゅうひゃっ',
    ];
    out += isFinal ? hGem[hundreds] : hPlain[hundreds];
  }

  if (tens > 0) {
    const tPrefix = ['', '', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
    const isFinal = ones === 0 && geminateFinal;
    out += tPrefix[tens] + (isFinal ? 'じゅっ' : 'じゅう');
  }

  if (ones > 0) {
    const oPlain = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
    const oGem = ['', 'いっ', 'に', 'さん', 'よん', 'ご', 'ろっ', 'なな', 'はっ', 'きゅう'];
    out += geminateFinal ? oGem[ones] : oPlain[ones];
  }

  return out || null;
}

/**
 * Resolves Japanese numeral + `か`-row counter expressions (`ヶ月`/`か月`/`カ月`/`箇月`,
 * `ヶ所`/`か所`/`カ所`/`箇所`, `ヶ国`/`か国`/`カ国`/`箇国`) with standard euphonic changes.
 *
 * @param {string} span
 * @returns {string | null}
 */
function resolveCounterExpression(span) {
  const m = COUNTER_EXPR_RE.exec(span);
  if (!m) {
    return null;
  }
  const [, numPart, counterPart] = m;
  const suffixReading = COUNTER_SUFFIX_READINGS[counterPart];
  if (!suffixReading) {
    return null;
  }

  let numReading = null;
  if (numPart === '何') {
    numReading = 'なん';
  } else if (numPart === '幾') {
    numReading = 'いく';
  } else if (numPart === '数') {
    numReading = 'すう';
  } else if (numPart.endsWith('数')) {
    const prefixVal = parseKanjiNumber(numPart.slice(0, -1));
    const prefixRead = prefixVal ? readJapaneseNumberForKaCounter(prefixVal, false) : null;
    if (prefixRead) {
      numReading = `${prefixRead}すう`;
    }
  } else if (/^[0-9０-９]+$/.test(numPart)) {
    const asciiDigits = Array.from(numPart)
      .map((ch) => {
        const cp = ch.codePointAt(0);
        return cp >= 0xff10 && cp <= 0xff19 ? String.fromCodePoint(cp - 0xff10 + 0x30) : ch;
      })
      .join('');
    if (asciiDigits === '0') {
      numReading = 'ぜろ';
    } else if (/^[1-9][0-9]{0,3}$/.test(asciiDigits)) {
      numReading = readJapaneseNumberForKaCounter(Number(asciiDigits), true);
    }
  } else {
    const val = parseKanjiNumber(numPart);
    if (val !== null) {
      numReading = readJapaneseNumberForKaCounter(val, true);
    }
  }

  return numReading ? `${numReading}${suffixReading}` : null;
}

/**
 * Checks if code-point index `idx` starts an honorific prefix (`お`/`ご`) that forms an exact or
 * deinflected lexical word in `dict` starting with Kanji at `idx + 1`.
 *
 * @param {string[]} chars
 * @param {number} idx
 * @param {Record<string, Array<[string, number[]?, number?, number?, number?]>>} dict
 */
function hasHonorificPrefixMatch(chars, idx, dict) {
  const ch = chars[idx];
  if ((ch !== 'お' && ch !== 'ご') || idx + 1 >= chars.length || !KANJI_RE.test(chars[idx + 1])) {
    return false;
  }
  const maxEnd = Math.min(chars.length, idx + MAX_SEGMENT_SPAN);
  for (let end = maxEnd; end >= idx + 2; end--) {
    const span = chars.slice(idx, end).join('');
    if (
      (Object.hasOwn(dict, span) && formatExactEntries(dict[span]).length > 0) ||
      deinflectWord(span, dict).length > 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if code-point index `idx` starts an ASCII / full-width digit run that forms a
 * dictionary headword or numeric counter expression (e.g. `3ヶ月`, `１ヶ月`).
 *
 * @param {string[]} chars
 * @param {number} idx
 * @param {Record<string, Array<[string, number[]?, number?, number?, number?]>>} dict
 */
function hasDigitLedMatchAt(chars, idx, dict) {
  if (!DIGIT_CHAR_RE.test(chars[idx])) {
    return false;
  }
  // Never split mid-way inside a contiguous digit run (e.g. avoid turning `01ヶ月` into `0` + `1ヶ月`)
  if (idx > 0 && DIGIT_CHAR_RE.test(chars[idx - 1])) {
    return false;
  }
  const maxEnd = Math.min(chars.length, idx + MAX_SEGMENT_SPAN);
  for (let end = maxEnd; end >= idx + 2; end--) {
    const span = chars.slice(idx, end).join('');
    if (!containsKanji(span)) {
      continue;
    }
    if (
      (Object.hasOwn(dict, span) && formatExactEntries(dict[span]).length > 0) ||
      resolveCounterExpression(span) !== null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Greedy longest-match left-to-right segmentation for multi-word phrases and novel compounds.
 * Strictly code-point safe across supplementary Unicode planes.
 *
 * @param {string} text
 * @param {Record<string, Array<[string, number[]?, number?, number?, number?]>>} dict
 */
function segmentPhrase(text, dict) {
  const chars = Array.from(text);
  const segments = [];
  let resolvedKanjiCount = 0;
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];
    const startsKanji = KANJI_RE.test(ch);
    const startsHonorificWord = !startsKanji && hasHonorificPrefixMatch(chars, i, dict);
    const startsDigitCounter =
      !startsKanji && !startsHonorificWord && hasDigitLedMatchAt(chars, i, dict);

    if (startsKanji || startsHonorificWord || startsDigitCounter) {
      const minLen = startsHonorificWord || startsDigitCounter ? 2 : 1;
      const maxEnd = Math.min(chars.length, i + MAX_SEGMENT_SPAN);
      let matched = false;

      for (let end = maxEnd; end >= i + minLen; end--) {
        const span = chars.slice(i, end).join('');
        if (!containsKanji(span)) {
          continue;
        }
        const spanCpLen = end - i;

        // Suffix `間` directly after a month counter (`3ヶ月間` -> `さんかげつかん`)
        if (
          span === '間' &&
          segments.length > 0 &&
          TEMPORAL_MONTH_COUNTER_RE.test(segments[segments.length - 1].surface)
        ) {
          segments.push({
            surface: span,
            isKanji: true,
            matchType: 'exact',
            isTied: false,
            candidates: [{ reading: 'かん', pitches: [], pitchContours: [] }],
          });
          resolvedKanjiCount++;
          i = end;
          matched = true;
          break;
        }

        if (Object.hasOwn(dict, span)) {
          const candidates = formatExactEntries(dict[span]);
          if (candidates.length > 0) {
            enrichPitchlessExactEntries(candidates, span, dict);
            segments.push({
              surface: span,
              isKanji: true,
              matchType: 'exact',
              isTied: candidates.length > 1,
              candidates,
            });
            resolvedKanjiCount++;
            i = end;
            matched = true;
            break;
          }
        }

        const counterReading = resolveCounterExpression(span);
        if (counterReading) {
          segments.push({
            surface: span,
            isKanji: true,
            matchType: 'counter',
            isTied: false,
            candidates: [{ reading: counterReading, pitches: [], pitchContours: [] }],
          });
          resolvedKanjiCount++;
          i = end;
          matched = true;
          break;
        }

        if (spanCpLen === 2) {
          const iterCandidates = resolveIterationWord(span, dict);
          if (iterCandidates) {
            segments.push({
              surface: span,
              isKanji: true,
              matchType: 'iteration',
              isTied: iterCandidates.length > 1,
              candidates: iterCandidates,
            });
            resolvedKanjiCount++;
            i = end;
            matched = true;
            break;
          }
        }

        if (spanCpLen >= 2 && !startsDigitCounter) {
          const deinflected = deinflectWord(span, dict);
          if (deinflected.length > 0) {
            const candidates = formatDeinflectedMatches(deinflected, span, dict);
            segments.push({
              surface: span,
              isKanji: true,
              matchType: 'deinflected',
              isTied: candidates.length > 1,
              candidates,
            });
            resolvedKanjiCount++;
            i = end;
            matched = true;
            break;
          }
        }
      }

      if (!matched) {
        // Rare unknown Kanji character not present even in KANJIDIC2 fallback
        segments.push({
          surface: ch,
          isKanji: true,
          isUnknown: true,
          matchType: 'unknown',
          isTied: false,
          candidates: [{ reading: ch, pitches: [], pitchContours: [] }],
        });
        i += 1;
      }
    } else {
      // Pure Hiragana / Katakana / inline punctuation / non-counter digit run: keep as-is
      let end = i + 1;
      while (
        end < chars.length &&
        !KANJI_RE.test(chars[end]) &&
        !hasHonorificPrefixMatch(chars, end, dict) &&
        !hasDigitLedMatchAt(chars, end, dict)
      ) {
        end++;
      }
      const kanaRun = chars.slice(i, end).join('');
      segments.push({
        surface: kanaRun,
        isKanji: false,
        matchType: 'kana',
        isTied: false,
        candidates: [{ reading: kanaRun, pitches: [], pitchContours: [] }],
      });
      i = end;
    }
  }

  if (resolvedKanjiCount === 0) {
    return null;
  }

  // Assemble combined reading strings (preserving all distinct tied combinations up to 32)
  let combined = [''];
  let tiesTruncated = false;
  for (const seg of segments) {
    const segReadings = Array.from(new Set(seg.candidates.map((c) => c.reading)));
    if (tiesTruncated && segReadings.length > 0) {
      // Earlier truncation remains truncated as remaining segments append
    }
    const next = [];
    const nextSeen = new Set();
    for (const prefix of combined) {
      for (const r of segReadings) {
        const merged = prefix + r;
        if (nextSeen.has(merged)) {
          continue;
        }
        if (next.length < MAX_COMBINED_READINGS) {
          nextSeen.add(merged);
          next.push(merged);
        } else {
          tiesTruncated = true;
        }
      }
    }
    combined = next;
  }

  return {
    segments,
    readings: combined.map((r) => ({
      reading: r,
      pitches: [],
      pitchContours: [],
    })),
    isTied: combined.length > 1,
    tiesTruncated,
  };
}

/**
 * Looks up a Japanese word or short phrase in `dict`, returning its most likely reading(s),
 * pitch accent contours, deinflection metadata, or per-segment compound breakdown.
 *
 * @param {string} rawText
 * @param {Record<string, Array<[string, number[]?, number?, number?, number?]>>} dict
 */
export function lookupKanji(rawText, dict, options = {}) {
  const normalized = normalizeSelectionText(rawText);

  if (!normalized || !containsKanji(normalized)) {
    return {
      query: rawText ?? '',
      normalized,
      found: false,
      hasKanji: false,
      matchType: 'none',
      isTied: false,
      tiesTruncated: false,
      readings: [],
      segments: [],
    };
  }

  if (!dict) {
    throw new Error('Dictionary is not loaded');
  }

  const learner =
    options?.feedbackLearner === false
      ? null
      : options?.feedbackLearner || defaultFeedbackLearner;

  if (learner) {
    const normTarget = normalizeForAnnotation(normalized).normText || normalized;
    const directLearned = learner.findDirectMatch(normalized, normTarget, options);
    if (directLearned) {
      const pitches = lookupVerifiedPitches(
        normalized,
        directLearned.reading,
        null,
        dict,
        normTarget,
        learner
      );
      return {
        query: rawText,
        normalized,
        found: true,
        hasKanji: true,
        matchType: 'learned',
        learnedFromFeedback: true,
        feedbackEntryId: directLearned.id,
        isTied: false,
        tiesTruncated: false,
        readings: [
          {
            reading: directLearned.reading,
            pitches,
            pitchContours: buildPitchContours(directLearned.reading, pitches),
            learned: true,
          },
        ],
        segments: [],
      };
    }
  }

  // 1. Primary path: Exact headword match
  if (Object.hasOwn(dict, normalized)) {
    const readings = formatExactEntries(dict[normalized]);
    if (readings.length > 0) {
      enrichPitchlessExactEntries(readings, normalized, dict);
      return {
        query: rawText,
        normalized,
        found: true,
        hasKanji: true,
        matchType: 'exact',
        isTied: readings.length > 1,
        tiesTruncated: false,
        readings,
        segments: [],
      };
    }
  }

  // 2. Secondary path: Deinflection match (verbs, i-adjectives, suru-verbs)
  const deinflected = deinflectWord(normalized, dict);
  if (deinflected.length > 0) {
    const readings = formatDeinflectedMatches(deinflected, normalized, dict);
    return {
      query: rawText,
      normalized,
      found: true,
      hasKanji: true,
      matchType: 'deinflected',
      isTied: readings.length > 1,
      tiesTruncated: false,
      readings,
      segments: [],
    };
  }

  // 3. Productive X々 Kanji iteration mark match (e.g. 町々 -> まちまち)
  const iterationReadings = resolveIterationWord(normalized, dict);
  if (iterationReadings) {
    return {
      query: rawText,
      normalized,
      found: true,
      hasKanji: true,
      matchType: 'iteration',
      isTied: iterationReadings.length > 1,
      tiesTruncated: false,
      readings: iterationReadings,
      segments: [],
    };
  }

  // 4. Productive Japanese numeral + counter match (e.g. 三か月 / ３ヶ月 -> さんかげつ)
  const counterReading = resolveCounterExpression(normalized);
  if (counterReading) {
    return {
      query: rawText,
      normalized,
      found: true,
      hasKanji: true,
      matchType: 'counter',
      isTied: false,
      tiesTruncated: false,
      readings: [{ reading: counterReading, pitches: [], pitchContours: [] }],
      segments: [],
    };
  }

  // 5. Multi-word / compound phrase segmentation fallback
  if (Array.from(normalized).length > 1) {
    const segmented = segmentPhrase(normalized, dict);
    if (segmented) {
      return {
        query: rawText,
        normalized,
        found: true,
        hasKanji: true,
        matchType: 'segmented',
        isTied: segmented.isTied,
        tiesTruncated: segmented.tiesTruncated,
        readings: segmented.readings,
        segments: segmented.segments,
      };
    }
  }

  return {
    query: rawText,
    normalized,
    found: false,
    hasKanji: true,
    matchType: 'none',
    isTied: false,
    tiesTruncated: false,
    readings: [],
    segments: [],
  };
}

/**
 * Generates standard Japanese rendaku (dakuten/handakuten) and sokuon (`っ`) phonetic variants
 * for a single-Kanji reading.
 *
 * @param {string} baseReading
 * @returns {string[]}
 */
function expandReadingVariants(baseReading) {
  if (!baseReading) return [];
  const variants = [baseReading];
  const first = baseReading[0];
  if (Object.hasOwn(DAKUTEN_MAP, first)) {
    variants.push(DAKUTEN_MAP[first] + baseReading.slice(1));
  }
  if (Object.hasOwn(HANDAKUTEN_MAP, first)) {
    variants.push(HANDAKUTEN_MAP[first] + baseReading.slice(1));
  }
  const len = variants.length;
  for (let i = 0; i < len; i++) {
    const v = variants[i];
    if (v.length >= 2 && SOKUON_TAIL_SET.has(v[v.length - 1])) {
      const soku = `${v.slice(0, -1)}っ`;
      if (!variants.includes(soku)) {
        variants.push(soku);
      }
    }
  }
  return variants;
}

/**
 * Looks up verified pitch accent numbers for `(surface, reading)` across `pitchMap`, `dict`,
 * and optional normalized Kanji surface (`normSurface`, e.g. `２０歳` -> `二十歳`).
 *
 * @param {string} surface
 * @param {string} reading
 * @param {Record<string, Record<string, number[]>> | null | undefined} pitchMap
 * @param {Record<string, Array<[string, number[]?, number?, number?, number?]>> | null | undefined} dict
 * @param {string} [normSurface]
 * @returns {number[]}
 */
function lookupVerifiedPitches(
  surface,
  reading,
  pitchMap,
  dict,
  normSurface = '',
  feedbackLearner = null
) {
  if (feedbackLearner) {
    const learnedPitches = feedbackLearner.lookupLearnedPitches(surface, reading, normSurface);
    if (learnedPitches.length > 0) {
      return learnedPitches;
    }
  }

  const hira = kataToHira(reading);
  const surfaces = normSurface && normSurface !== surface ? [surface, normSurface] : [surface];

  for (const surf of surfaces) {
    if (pitchMap && Object.hasOwn(pitchMap, surf)) {
      const pMap = pitchMap[surf];
      if (pMap && Object.hasOwn(pMap, hira) && Array.isArray(pMap[hira]) && pMap[hira].length > 0) {
        return [...pMap[hira]];
      }
    }
    if (dict && Object.hasOwn(dict, surf)) {
      const tuple = dict[surf].find(
        (t) => t[0] === hira && Array.isArray(t[1]) && t[1].length > 0
      );
      if (tuple) {
        return [...tuple[1]];
      }
    }
  }

  return [];
}

/**
 * Resolves supplementary-plane Kanji segments (CJK Extension B-G, e.g. `𠮷野家` or rare `𠮷`)
 * that are outside the neural model's BMP character vocabulary.
 */
function resolveSupplementarySegmentReading(seg, dict, singleKanji) {
  if (!seg.isKanji || !NON_BMP_HAN_RE.test(seg.surface)) {
    return seg.reading;
  }
  if (dict && Object.hasOwn(dict, seg.surface)) {
    const entries = formatExactEntries(dict[seg.surface]);
    if (entries.length > 0) {
      return entries[0].reading;
    }
  }
  const cps = Array.from(seg.surface);
  if (cps.length === 1) {
    const ch = cps[0];
    if (singleKanji && Object.hasOwn(singleKanji, ch) && singleKanji[ch]?.w?.length > 0) {
      return singleKanji[ch].w[0][0];
    }
    if ((!dict || !Object.hasOwn(dict, ch)) && (!singleKanji || !Object.hasOwn(singleKanji, ch))) {
      return seg.surface;
    }
  }
  return seg.reading;
}

/**
 * Collects scored candidate hiragana readings for a Kanji sub-span `normChars[startIdx..endIdx]`
 * when aligning a multi-Kanji compound reading (e.g. `株式市場` -> `かぶしき` + `しじょう`,
 * `十六年前` -> `じゅうろく` + `ねん` + `まえ`, `一日中働` -> `いちにち` + `じゅう` + `はたら`).
 */
function collectSubSpanCandidates(normChars, startIdx, endIdx, trailingContextKana, resources) {
  const { dict, pitchMap, singleKanji, feedbackLearner } = resources;
  const sub = normChars.slice(startIdx, endIdx).join('');
  const spanLen = endIdx - startIdx;
  /** @type {Map<string, number>} */
  const candidates = new Map();

  const addCand = (r, weight) => {
    const hira = kataToHira(r);
    if (!hira) return;
    const prev = candidates.get(hira);
    if (prev === undefined || weight > prev) {
      candidates.set(hira, weight);
    }
  };

  if (feedbackLearner) {
    for (const learnedRead of feedbackLearner.getSubSpanCandidates(sub)) {
      addCand(learnedRead, 5.2 * spanLen);
    }
  }

  if (dict && Object.hasOwn(dict, sub)) {
    for (const tuple of dict[sub]) {
      addCand(tuple[0], 4.5 * spanLen);
      if (spanLen >= 2) {
        for (const v of expandReadingVariants(tuple[0])) {
          if (v !== tuple[0]) addCand(v, 3.6 * spanLen);
        }
      }
    }
  }

  if (pitchMap && Object.hasOwn(pitchMap, sub)) {
    for (const r of Object.keys(pitchMap[sub])) {
      addCand(r, 4.2 * spanLen);
      if (spanLen >= 2) {
        for (const v of expandReadingVariants(r)) {
          if (v !== r) addCand(v, 3.5 * spanLen);
        }
      }
    }
  }

  if (sub === '〇' || sub === '零') {
    addCand('ぜろ', 4.2);
    addCand('れい', 4.2);
  } else if (sub === '点') {
    addCand('てん', 4.2);
  }

  if (singleKanji && Object.hasOwn(singleKanji, sub)) {
    const sk = singleKanji[sub];
    if (Array.isArray(sk?.w)) {
      for (const w of sk.w) {
        addCand(w[0], 4.0);
      }
    }
  }

  // Numeral readings for Kanji number spans (e.g. 十六 -> じゅうろく, 四 -> よん/よ/し)
  const numVal = parseKanjiIntUnder10000(sub);
  if (numVal !== null) {
    const plainNum = readNumberForKaCounter(numVal, false);
    const gemNum = readNumberForKaCounter(numVal, true);
    if (plainNum) addCand(plainNum, 4.3 * spanLen);
    if (gemNum) addCand(gemNum, 4.1 * spanLen);
    if (numVal === 1) addCand('ひと', 3.8);
    if (numVal === 2) addCand('ふた', 3.8);
    if (numVal === 4) {
      addCand('よ', 4.0);
      addCand('し', 4.0);
    }
    if (numVal === 7) addCand('しち', 4.0);
    if (numVal === 9) addCand('く', 4.0);
    if (numVal === 20) addCand('はた', 3.8);
  }

  // Verb/adjective stem at the end of a Kanji run followed by okurigana (e.g. `働` + `いた` -> `はたら`)
  if (endIdx === normChars.length && trailingContextKana && dict) {
    const okuriChars = Array.from(trailingContextKana);
    for (let k = Math.min(okuriChars.length, 6); k >= 1; k--) {
      const okuri = okuriChars.slice(0, k).join('');
      const deinflected = deinflectWord(sub + okuri, dict);
      for (const m of deinflected) {
        if (m.conjugatedReading.endsWith(okuri) && m.conjugatedReading.length > okuri.length) {
          addCand(m.conjugatedReading.slice(0, -okuri.length), 4.5 * spanLen);
        }
      }
    }
  }

  // Single-Kanji Kun/On stems + rendaku/sokuon variants
  if (spanLen === 1) {
    const ch = normChars[startIdx];
    const sk = singleKanji?.[ch];
    if (sk) {
      for (const kRaw of sk.k || []) {
        const clean = kRaw.replace(/^-|-$/g, '');
        const dotIdx = clean.indexOf('.');
        const fullKana = dotIdx >= 0 ? clean.replace(/\./g, '') : clean;
        const stemKana = dotIdx > 0 ? clean.slice(0, dotIdx) : clean;
        for (const base of [stemKana, fullKana]) {
          for (const v of expandReadingVariants(base)) {
            addCand(v, v === base ? 3.0 : 2.3);
          }
        }
      }
      for (const oRaw of sk.o || []) {
        const base = kataToHira(oRaw.replace(/^-|-$/g, ''));
        for (const v of expandReadingVariants(base)) {
          addCand(v, v === base ? 3.0 : 2.3);
        }
      }
    }
    if (ch === '々' && startIdx > 0) {
      const prevCands = collectSubSpanCandidates(normChars, startIdx - 1, startIdx, '', resources);
      for (const [prevRead] of prevCands) {
        for (const v of expandReadingVariants(prevRead)) {
          addCand(v, 2.8);
        }
      }
    }
  }

  return candidates;
}

/**
 * Extracts the exact reading of a sub-span `[sliceOrigStart, sliceOrigEnd]` inside a larger
 * AI-annotated Kanji segment `seg` using boundary-constrained dynamic programming alignment.
 *
 * When `seg` is an inseparable irregular / jukujikun word (such as `今日` -> `きょう`,
 * `大人` -> `おとな`, `明日` -> `あした`, `二十歳` -> `はたち`) whose characters cannot be
 * compositionally aligned to `seg.reading`, returns `{ reading: null, unalignableCompound }`
 * instead of inventing a false standalone reading.
 */
async function sliceKanjiSegmentReading(annotated, seg, sliceOrigStart, sliceOrigEnd, resources) {
  if (sliceOrigStart <= seg.origStart && sliceOrigEnd >= seg.origEnd) {
    return {
      reading: resolveSupplementarySegmentReading(seg, resources.dict, resources.singleKanji),
      unalignableCompound: null,
    };
  }

  // Map `[sliceOrigStart, sliceOrigEnd]` -> `[subNormStart, subNormEnd]` via `annotated.pieces`
  let subNormStart = seg.normStart;
  let subNormEnd = seg.normEnd;
  for (const p of annotated.pieces) {
    if (p.origEnd > sliceOrigStart) {
      subNormStart = Math.max(seg.normStart, p.normStart);
      break;
    }
  }
  for (let idx = annotated.pieces.length - 1; idx >= 0; idx--) {
    const p = annotated.pieces[idx];
    if (p.origStart < sliceOrigEnd) {
      subNormEnd = Math.min(seg.normEnd, p.normEnd);
      break;
    }
  }

  const prefixNorm = annotated.normText.slice(seg.normStart, subNormStart);
  const midNorm = annotated.normText.slice(subNormStart, subNormEnd);
  const relStart = Array.from(prefixNorm).length;
  const relEnd = relStart + Array.from(midNorm).length;

  const normChars = Array.from(seg.normSurface);
  const N = normChars.length;
  const segHira = kataToHira(seg.reading);
  const readChars = Array.from(segHira);
  const M = readChars.length;

  if (relStart === 0 && relEnd === N) {
    return {
      reading: seg.reading,
      unalignableCompound: null,
    };
  }

  const afterSegStr = annotated.origText.slice(seg.origEnd);
  const trailingKanaMatch = /^[ぁ-ゖー]{1,6}/.exec(afterSegStr);
  const trailingKana = trailingKanaMatch ? trailingKanaMatch[0] : '';

  // DP state: dp[i][r] = { score, rStart, rEnd }
  // Every valid transition [i -> j] must NOT jump across `relStart` or `relEnd` (`!(i < b && j > b)`).
  const dp = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(null));
  dp[0][0] = {
    score: 0,
    rStart: relStart === 0 ? 0 : -1,
    rEnd: -1,
  };

  for (let i = 0; i < N; i++) {
    let anyReachable = false;
    for (let r = 0; r <= M; r++) {
      if (dp[i][r] !== null) {
        anyReachable = true;
        break;
      }
    }
    if (!anyReachable) continue;

    for (let j = i + 1; j <= N; j++) {
      if ((i < relStart && j > relStart) || (i < relEnd && j > relEnd)) {
        continue;
      }

      const candMap = collectSubSpanCandidates(normChars, i, j, trailingKana, resources);
      if (candMap.size === 0) continue;

      for (const [candHira, weight] of candMap) {
        const cChars = Array.from(candHira);
        const cLen = cChars.length;
        if (cLen === 0 || cLen > M) continue;

        for (let r = 0; r + cLen <= M; r++) {
          const cur = dp[i][r];
          if (!cur) continue;

          let matches = true;
          for (let k = 0; k < cLen; k++) {
            if (readChars[r + k] !== cChars[k]) {
              matches = false;
              break;
            }
          }
          if (!matches) continue;

          const nextR = r + cLen;
          const nextScore = cur.score + weight - 0.15;
          const nextRStart = j === relStart ? nextR : cur.rStart;
          const nextREnd = j === relEnd ? nextR : cur.rEnd;
          const existing = dp[j][nextR];

          if (!existing || nextScore > existing.score) {
            dp[j][nextR] = {
              score: nextScore,
              rStart: nextRStart,
              rEnd: nextREnd,
            };
          }
        }
      }
    }
  }

  const finalState = dp[N][M];
  if (finalState && finalState.rStart >= 0 && finalState.rEnd >= finalState.rStart) {
    const extracted = readChars.slice(finalState.rStart, finalState.rEnd).join('');
    if (extracted) {
      return {
        reading: extracted,
        unalignableCompound: null,
      };
    }
  }

  return {
    reading: null,
    unalignableCompound: {
      surface: seg.surface,
      normSurface: seg.normSurface,
      reading: seg.reading,
    },
  };
}

/**
 * Extracts the reading and sub-segments for `[targetStart, targetEnd]` from an annotated context.
 */
async function extractSpanFromAnnotation(annotated, targetStart, targetEnd, resources) {
  const overlapping = annotated.segments.filter(
    (s) => s.origEnd > targetStart && s.origStart < targetEnd
  );

  const extractedSegments = [];
  let isSubCompoundSlice = false;
  let unalignableCompound = null;
  let anySegmentLearned = false;

  for (const seg of overlapping) {
    if (seg.learned) {
      anySegmentLearned = true;
    }
    const sliceStart = Math.max(seg.origStart, targetStart);
    const sliceEnd = Math.min(seg.origEnd, targetEnd);
    const subSurface = annotated.origText.slice(sliceStart, sliceEnd);

    if (!seg.isKanji) {
      extractedSegments.push({
        surface: subSurface,
        normSurface: subSurface,
        reading: subSurface,
        isKanji: false,
        learned: false,
      });
    } else {
      if (sliceStart > seg.origStart || sliceEnd < seg.origEnd) {
        isSubCompoundSlice = true;
      }
      const sliced = await sliceKanjiSegmentReading(
        annotated,
        seg,
        sliceStart,
        sliceEnd,
        resources
      );
      if (sliced.unalignableCompound) {
        unalignableCompound = {
          ...sliced.unalignableCompound,
          learned: Boolean(seg.learned),
        };
        break;
      }
      const subNorm =
        sliceStart === seg.origStart && sliceEnd === seg.origEnd ? seg.normSurface : subSurface;
      extractedSegments.push({
        surface: subSurface,
        normSurface: subNorm,
        reading: sliced.reading,
        isKanji: true,
        learned: Boolean(seg.learned),
      });
    }
  }

  if (unalignableCompound) {
    return {
      reading: '',
      segments: [],
      isSubCompoundSlice: true,
      unalignableCompound,
      anySegmentLearned,
    };
  }

  return {
    reading: extractedSegments.map((s) => s.reading).join(''),
    segments: extractedSegments,
    isSubCompoundSlice,
    unalignableCompound: null,
    anySegmentLearned,
  };
}

/**
 * Builds UI-ready per-segment breakdown chips with pitch contours for multi-segment AI results.
 */
function buildAISegmentBreakdown(rawSegments, pitchMap, dict, feedbackLearner = null) {
  if (!Array.isArray(rawSegments) || rawSegments.length <= 1) {
    return [];
  }
  return rawSegments.map((s) => {
    if (!s.isKanji) {
      return {
        surface: s.surface,
        isKanji: false,
        matchType: 'kana',
        isTied: false,
        candidates: [{ reading: s.reading, pitches: [], pitchContours: [] }],
      };
    }
    const segPitches = lookupVerifiedPitches(
      s.surface,
      s.reading,
      pitchMap,
      dict,
      s.normSurface,
      feedbackLearner
    );
    return {
      surface: s.surface,
      isKanji: true,
      matchType: s.learned ? 'learned' : 'ai',
      learned: Boolean(s.learned),
      isTied: false,
      candidates: [
        {
          reading: s.reading,
          pitches: segPitches,
          pitchContours: buildPitchContours(s.reading, segPitches),
        },
      ],
    };
  });
}

/**
 * Builds enriched reading entry (pitch contours + optional deinflected verb/adjective base pitch)
 * for an AI-resolved `(surface, reading)` pair, correcting irregular verb stems (e.g. `来られる` -> `こられる`)
 * when POS-verified deinflection disproves an ungrammatical conjugation, while never overwriting
 * a user-learned reading (`opts.preserveReading === true`).
 */
function buildEnrichedAIReadingEntry(surface, normSurface, reading, pitchMap, dict, opts = {}) {
  const feedbackLearner = opts?.feedbackLearner || null;
  const preserveReading = Boolean(opts?.preserveReading);
  let effectiveReading = reading;
  let pitches = lookupVerifiedPitches(
    surface,
    effectiveReading,
    pitchMap,
    dict,
    normSurface,
    feedbackLearner
  );

  if (pitches.length === 0 && dict && Array.from(surface).length >= 2) {
    const hiraReading = kataToHira(effectiveReading);
    const deinflected = deinflectWord(surface, dict);
    if (deinflected.length > 0) {
      let matchingBase = deinflected.find((m) => m.conjugatedReading === hiraReading);
      if (!matchingBase && !preserveReading) {
        matchingBase = deinflected[0];
        effectiveReading = matchingBase.conjugatedReading;
        pitches = lookupVerifiedPitches(
          surface,
          effectiveReading,
          pitchMap,
          dict,
          normSurface,
          feedbackLearner
        );
      }
      if (matchingBase) {
        const entry = {
          reading: effectiveReading,
          pitches,
          pitchContours: buildPitchContours(effectiveReading, pitches),
          base: {
            surface: matchingBase.baseSurface,
            reading: matchingBase.baseReading,
            pitches: matchingBase.basePitches,
            pitchContours: buildPitchContours(matchingBase.baseReading, matchingBase.basePitches),
            ruleLabel: matchingBase.labels.join(' + '),
          },
        };
        if (pitches.length === 0) {
          entry.pitchUnavailableReason = 'inflected';
        }
        return entry;
      }
    }
  }

  return {
    reading: effectiveReading,
    pitches,
    pitchContours: buildPitchContours(effectiveReading, pitches),
  };
}

/**
 * Context-aware, ONNX Neural AI Kanji reading & pitch accent lookup (`YomiPitch v2.0`).
 *
 * Accepts either a string `query` or `{ text, contextText = '', contextStart = -1, contextEnd = -1 }`.
 * Combines:
 *   - Isolated single-Kanji complete pronunciation display (`w` + Kun'yomi `k` + On'yomi `o`)
 *   - In-sentence context-disambiguated single-Kanji & polyphone AI reading (`人気` -> `ひとけ` vs `にんき`,
 *     `市場` -> `いちば` vs `しじょう`, `上手` -> `かみて` vs `じょうず`, `生` in `生ビール` -> `なま`)
 *   - Span-normalized numbers, counters & calendar dates (`１６年前` -> `じゅうろくねんまえ`, `4月1日` -> `しがつついたち`)
 *   - Exact dictionary ties for isolated ambiguous words (`市場` -> `いちば` & `しじょう`)
 *
 * @param {string | { text: string, contextText?: string, contextStart?: number, contextEnd?: number }} request
 * @param {{
 *   dict?: Record<string, Array<[string, number[]?, number?, number?, number?]>>,
 *   pitchMap?: Record<string, Record<string, number[]>>,
 *   singleKanji?: Record<string, { w?: Array<[string, number[]?]>, k?: string[], o?: string[] }>,
 *   annotator?: { annotate(t: string): Promise<Array<{ text: string, reading?: string }>> } | false | null
 * }} [resources]
 */
export async function lookupKanjiWithAI(request, resources = {}) {
  const rawText = typeof request === 'string' ? request : String(request?.text ?? '');
  const rawContext =
    typeof request === 'object' && typeof request?.contextText === 'string'
      ? request.contextText
      : '';
  const rawStart =
    typeof request === 'object' && typeof request?.contextStart === 'number'
      ? request.contextStart
      : -1;
  const rawEnd =
    typeof request === 'object' && typeof request?.contextEnd === 'number'
      ? request.contextEnd
      : -1;

  // 1. Trim surrounding whitespace/punctuation and adjust context offsets accurately
  const leadLen = LEAD_TRIM_RE.exec(rawText)?.[0]?.length || 0;
  const afterLead = rawText.slice(leadLen);
  const trailLen = TRAIL_TRIM_RE.exec(afterLead)?.[0]?.length || 0;
  const normalized =
    trailLen > 0 ? afterLead.slice(0, afterLead.length - trailLen) : afterLead;

  let adjStart = -1;
  let adjEnd = -1;
  if (normalized && rawContext && rawStart >= 0 && rawEnd <= rawContext.length) {
    const s1 = rawStart + leadLen;
    const e1 = rawEnd - trailLen;
    if (s1 >= 0 && e1 >= s1 && rawContext.slice(s1, e1) === normalized) {
      adjStart = s1;
      adjEnd = e1;
    } else if (rawContext.slice(rawStart, rawEnd) === normalized) {
      adjStart = rawStart;
      adjEnd = rawEnd;
    }
  }

  const hasContext =
    normalized.length > 0 &&
    adjStart >= 0 &&
    adjEnd <= rawContext.length &&
    rawContext.slice(adjStart, adjEnd) === normalized &&
    rawContext.trim().length > normalized.length &&
    normalizeSelectionText(rawContext).length > normalized.length;

  if (!normalized || !containsKanji(normalized)) {
    return {
      query: rawText,
      normalized,
      found: false,
      hasKanji: false,
      matchType: 'none',
      isSingleKanji: false,
      hasContext: false,
      aiPowered: false,
      isTied: false,
      tiesTruncated: false,
      readings: [],
      segments: [],
    };
  }

  const { dict = null, pitchMap = null, singleKanji = null } = resources;
  const feedbackLearner =
    resources.feedbackLearner === false
      ? null
      : resources.feedbackLearner || defaultFeedbackLearner;
  const normTarget = normalizeForAnnotation(normalized).normText || normalized;

  const resolveAnnotator = async () => {
    if (resources.annotator === false) return null;
    if (resources.annotator) return resources.annotator;
    return await getAnnotator();
  };

  const cps = Array.from(normalized);
  const isSingleHan = cps.length === 1 && SINGLE_HAN_RE.test(normalized);

  // 2. Single-Kanji Behavior (isolated vs in-sentence context)
  if (isSingleHan) {
    const sk = singleKanji && Object.hasOwn(singleKanji, normalized) ? singleKanji[normalized] : null;

    if (!hasContext) {
      let readings = [];
      if (Array.isArray(sk?.w) && sk.w.length > 0) {
        readings = sk.w.map(([r, p]) => {
          const learnedP = feedbackLearner
            ? feedbackLearner.lookupLearnedPitches(normalized, r, normTarget)
            : [];
          const pitches =
            learnedP.length > 0
              ? learnedP
              : Array.isArray(p) && p.length > 0
                ? [...p]
                : lookupVerifiedPitches(normalized, r, pitchMap, dict, normTarget, feedbackLearner);
          return {
            reading: r,
            pitches,
            pitchContours: buildPitchContours(r, pitches),
          };
        });
      } else if (dict && Object.hasOwn(dict, normalized)) {
        readings = formatExactEntries(dict[normalized]).map((entry) => {
          const pitches =
            entry.pitches.length > 0
              ? entry.pitches
              : lookupVerifiedPitches(
                  normalized,
                  entry.reading,
                  pitchMap,
                  dict,
                  normTarget,
                  feedbackLearner
                );
          return {
            ...entry,
            pitches,
            pitchContours: buildPitchContours(entry.reading, pitches),
          };
        });
      } else if (sk && ((sk.k && sk.k.length > 0) || (sk.o && sk.o.length > 0))) {
        const fallbackSet = new Set();
        for (const k of sk.k || []) {
          if (!k.includes('.') && !k.includes('-')) fallbackSet.add(k);
        }
        if (fallbackSet.size === 0) {
          for (const o of sk.o || []) {
            fallbackSet.add(kataToHira(o.replace(/^-|-$/g, '')));
          }
        }
        readings = [...fallbackSet].slice(0, 6).map((r) => ({
          reading: r,
          pitches: [],
          pitchContours: [],
        }));
      }

      const directLearned = feedbackLearner?.findDirectMatch(normalized, normTarget, {});
      if (directLearned) {
        const lPitches = lookupVerifiedPitches(
          normalized,
          directLearned.reading,
          pitchMap,
          dict,
          normTarget,
          feedbackLearner
        );
        const learnedEntry = {
          reading: directLearned.reading,
          pitches: lPitches,
          pitchContours: buildPitchContours(directLearned.reading, lPitches),
          learned: true,
        };
        readings = [
          learnedEntry,
          ...readings.filter((r) => kataToHira(r.reading) !== directLearned.reading),
        ];
      }

      const hasAnyData =
        readings.length > 0 || Boolean(sk?.k?.length) || Boolean(sk?.o?.length);

      return {
        query: rawText,
        normalized,
        found: hasAnyData,
        hasKanji: true,
        matchType: hasAnyData ? 'single-kanji' : 'none',
        learnedFromFeedback: Boolean(directLearned),
        feedbackEntryId: directLearned?.id || null,
        isSingleKanji: true,
        hasContext: false,
        aiPowered: Boolean(directLearned),
        isTied: false,
        tiesTruncated: false,
        readings,
        segments: [],
        kanjiDetails: {
          kun: sk?.k ? [...sk.k] : [],
          on: sk?.o ? [...sk.o] : [],
        },
      };
    }

    // Single Kanji WITH webpage sentence context
    const directLearned = feedbackLearner?.findDirectMatch(normalized, normTarget, {
      contextText: rawContext,
      contextStart: adjStart,
      contextEnd: adjEnd,
    });

    const annotator = await resolveAnnotator();
    if (annotator) {
      const annotated = await annotateWithAI(rawContext, annotator, {
        selectionStart: adjStart,
        selectionEnd: adjEnd,
        feedbackLearner,
      });
      const extracted = await extractSpanFromAnnotation(annotated, adjStart, adjEnd, {
        dict,
        pitchMap,
        singleKanji,
        annotator,
        feedbackLearner,
      });

      if (extracted.unalignableCompound && !directLearned) {
        const uc = extracted.unalignableCompound;
        const ucPitches = lookupVerifiedPitches(
          uc.surface,
          uc.reading,
          pitchMap,
          dict,
          uc.normSurface,
          feedbackLearner
        );
        return {
          query: rawText,
          normalized,
          found: true,
          hasKanji: true,
          matchType: 'unalignable-context',
          unalignable: true,
          learnedFromFeedback: Boolean(uc.learned || extracted.anySegmentLearned),
          isSingleKanji: true,
          hasContext: true,
          aiPowered: true,
          isTied: false,
          tiesTruncated: false,
          readings: [],
          segments: [],
          enclosingCompound: {
            surface: uc.surface,
            reading: uc.reading,
            pitches: ucPitches,
            pitchContours: buildPitchContours(uc.reading, ucPitches),
          },
          kanjiDetails: {
            allWords: sk?.w ? sk.w.map((w) => (w[1] ? [w[0], [...w[1]]] : [w[0]])) : [],
            kun: sk?.k ? [...sk.k] : [],
            on: sk?.o ? [...sk.o] : [],
          },
        };
      }

      const contextualReading = directLearned ? directLearned.reading : extracted.reading;
      const isLearned = Boolean(directLearned || extracted.anySegmentLearned);
      const skWordTuple = sk?.w?.find((w) => w[0] === kataToHira(contextualReading));
      const verifiedPitches = lookupVerifiedPitches(
        normalized,
        contextualReading,
        pitchMap,
        dict,
        normTarget,
        feedbackLearner
      );
      const pitches =
        verifiedPitches.length > 0
          ? verifiedPitches
          : Array.isArray(skWordTuple?.[1])
            ? [...skWordTuple[1]]
            : [];

      const readingEntry = {
        reading: contextualReading,
        pitches,
        pitchContours: buildPitchContours(contextualReading, pitches),
        learned: isLearned,
      };
      if (extracted.isSubCompoundSlice && pitches.length > 0 && !directLearned?.pitches?.length) {
        readingEntry.pitchScope = 'standalone';
      }

      return {
        query: rawText,
        normalized,
        found: Boolean(contextualReading),
        hasKanji: true,
        matchType: isLearned ? 'ai-learned' : 'ai-context',
        learnedFromFeedback: isLearned,
        feedbackEntryId: directLearned?.id || null,
        isSingleKanji: true,
        hasContext: true,
        aiPowered: true,
        isTied: false,
        tiesTruncated: false,
        readings: contextualReading ? [readingEntry] : [],
        segments: [],
        kanjiDetails: {
          allWords: sk?.w ? sk.w.map((w) => (w[1] ? [w[0], [...w[1]]] : [w[0]])) : [],
          kun: sk?.k ? [...sk.k] : [],
          on: sk?.o ? [...sk.o] : [],
        },
      };
    }
  }

  // Standalone non-Han Kanji-like mark (e.g. standalone `々`)
  if (cps.length === 1 && !SINGLE_HAN_RE.test(normalized)) {
    return {
      query: rawText,
      normalized,
      found: false,
      hasKanji: true,
      matchType: 'none',
      isSingleKanji: false,
      hasContext: false,
      aiPowered: false,
      isTied: false,
      tiesTruncated: false,
      readings: [],
      segments: [],
    };
  }

  // 3. Multi-Character Lookup WITH Surrounding Sentence Context
  if (hasContext) {
    const directLearned = feedbackLearner?.findDirectMatch(normalized, normTarget, {
      contextText: rawContext,
      contextStart: adjStart,
      contextEnd: adjEnd,
    });

    const annotator = await resolveAnnotator();
    if (annotator) {
      const annotated = await annotateWithAI(rawContext, annotator, {
        selectionStart: adjStart,
        selectionEnd: adjEnd,
        feedbackLearner,
      });
      const extracted = await extractSpanFromAnnotation(annotated, adjStart, adjEnd, {
        dict,
        pitchMap,
        singleKanji,
        annotator,
        feedbackLearner,
      });

      if (extracted.unalignableCompound && !directLearned) {
        const uc = extracted.unalignableCompound;
        const ucPitches = lookupVerifiedPitches(
          uc.surface,
          uc.reading,
          pitchMap,
          dict,
          uc.normSurface,
          feedbackLearner
        );
        return {
          query: rawText,
          normalized,
          found: true,
          hasKanji: true,
          matchType: 'unalignable-context',
          unalignable: true,
          learnedFromFeedback: Boolean(uc.learned || extracted.anySegmentLearned),
          isSingleKanji: false,
          hasContext: true,
          aiPowered: true,
          isTied: false,
          tiesTruncated: false,
          readings: [],
          segments: [],
          enclosingCompound: {
            surface: uc.surface,
            reading: uc.reading,
            pitches: ucPitches,
            pitchContours: buildPitchContours(uc.reading, ucPitches),
          },
        };
      }

      const effectiveSpanReading = directLearned ? directLearned.reading : extracted.reading;
      const isLearned = Boolean(directLearned || extracted.anySegmentLearned);
      const normSpanSurface =
        extracted.segments.length > 0
          ? extracted.segments.map((s) => s.normSurface).join('')
          : normTarget;

      const entry = buildEnrichedAIReadingEntry(
        normalized,
        normSpanSurface,
        effectiveSpanReading,
        pitchMap,
        dict,
        { preserveReading: isLearned, feedbackLearner }
      );
      entry.learned = isLearned;

      if (extracted.isSubCompoundSlice && entry.pitches.length > 0 && !directLearned?.pitches?.length) {
        entry.pitchScope = 'standalone';
      }
      const segments =
        entry.base || directLearned
          ? []
          : buildAISegmentBreakdown(extracted.segments, pitchMap, dict, feedbackLearner);

      return {
        query: rawText,
        normalized,
        found: Boolean(effectiveSpanReading),
        hasKanji: true,
        matchType: isLearned ? 'ai-learned' : 'ai-context',
        learnedFromFeedback: isLearned,
        feedbackEntryId: directLearned?.id || null,
        isSingleKanji: false,
        hasContext: true,
        aiPowered: true,
        isTied: false,
        tiesTruncated: false,
        readings: effectiveSpanReading ? [entry] : [],
        segments,
      };
    }
  }

  // 4. Multi-Character Lookup WITHOUT Surrounding Context
  // 4.0 User-learned feedback entry takes precedence over static dictionary ties/defaults
  const directLearnedStandalone = feedbackLearner?.findDirectMatch(normalized, normTarget, {});
  if (directLearnedStandalone) {
    const entry = buildEnrichedAIReadingEntry(
      normalized,
      normTarget,
      directLearnedStandalone.reading,
      pitchMap,
      dict,
      { preserveReading: true, feedbackLearner }
    );
    entry.learned = true;
    return {
      query: rawText,
      normalized,
      found: true,
      hasKanji: true,
      matchType: 'learned',
      learnedFromFeedback: true,
      feedbackEntryId: directLearnedStandalone.id,
      isSingleKanji: false,
      hasContext: false,
      aiPowered: true,
      isTied: false,
      tiesTruncated: false,
      readings: [entry],
      segments: [],
    };
  }

  // Isolated `1日` / `１日` without context is ambiguous between duration (`いちにち`) and calendar day (`ついたち`)
  if ((normalized === '1日' || normalized === '１日') && dict && Object.hasOwn(dict, '一日')) {
    const dayTieReadings = formatExactEntries(dict['一日']);
    if (dayTieReadings.length > 0) {
      enrichPitchlessExactEntries(dayTieReadings, '一日', dict);
      return {
        query: rawText,
        normalized,
        found: true,
        hasKanji: true,
        matchType: 'exact',
        isSingleKanji: false,
        hasContext: false,
        aiPowered: false,
        isTied: dayTieReadings.length > 1,
        tiesTruncated: false,
        readings: dayTieReadings,
        segments: [],
      };
    }
  }
  const isDigitOrCounterCompound =
    DIGIT_OR_KA_MARK_RE.test(normalized) ||
    COUNTER_EXPR_RE.test(normalized) ||
    COUNTER_WITH_TRAIL_RE.test(normalized);

  // 4a. Pure Exact Dictionary Headword (preserves top likelihood & equal-likelihood ties)
  if (!isDigitOrCounterCompound && dict && Object.hasOwn(dict, normalized)) {
    const readings = formatExactEntries(dict[normalized]);
    if (readings.length > 0) {
      enrichPitchlessExactEntries(readings, normalized, dict);
      return {
        query: rawText,
        normalized,
        found: true,
        hasKanji: true,
        matchType: 'exact',
        isSingleKanji: false,
        hasContext: false,
        aiPowered: false,
        isTied: readings.length > 1,
        tiesTruncated: false,
        readings,
        segments: [],
      };
    }
  }

  // 4b. Everything Else -> ONNX Neural AI Model
  const annotator = await resolveAnnotator();
  if (annotator) {
    const annotated = await annotateWithAI(normalized, annotator, { feedbackLearner });
    const resolvedSegments = annotated.segments.map((s) => ({
      ...s,
      reading: resolveSupplementarySegmentReading(s, dict, singleKanji),
    }));
    const anyLearned = resolvedSegments.some((s) => s.learned);
    const fullReading = resolvedSegments.map((s) => s.reading).join('');
    const entry = buildEnrichedAIReadingEntry(
      normalized,
      annotated.normText,
      fullReading,
      pitchMap,
      dict,
      { preserveReading: anyLearned, feedbackLearner }
    );
    if (anyLearned) {
      entry.learned = true;
    }
    const segments = entry.base
      ? []
      : buildAISegmentBreakdown(resolvedSegments, pitchMap, dict, feedbackLearner);

    return {
      query: rawText,
      normalized,
      found: Boolean(fullReading),
      hasKanji: true,
      matchType: anyLearned ? 'ai-learned' : 'ai',
      learnedFromFeedback: anyLearned,
      isSingleKanji: false,
      hasContext: false,
      aiPowered: true,
      isTied: false,
      tiesTruncated: false,
      readings: fullReading ? [entry] : [],
      segments,
    };
  }

  // Fallback to synchronous dictionary lookup when AI annotator is explicitly disabled
  if (dict) {
    return lookupKanji(rawText, dict, { feedbackLearner });
  }

  return {
    query: rawText,
    normalized,
    found: false,
    hasKanji: true,
    matchType: 'none',
    isSingleKanji: false,
    hasContext: false,
    aiPowered: false,
    isTied: false,
    tiesTruncated: false,
    readings: [],
    segments: [],
  };
}

