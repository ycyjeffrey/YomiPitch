/**
 * Environment-agnostic ONNX Neural Furigana Engine (`@2008-horse/horse-furigana` + `onnxruntime-web`).
 *
 * Works seamlessly in BOTH:
 *   1. Chrome MV3 Offscreen Document (loads WASM + 7.67 MB INT8 ONNX model via `chrome.runtime.getURL` + `fetch`)
 *   2. Node.js 20+ (`node:fs/promises` for automated end-to-end AI test suite)
 *
 * Includes:
 *   - Exact span-tracking pre-normalization for ASCII/full-width numbers + counters (`１６年前` -> `十六年前`,
 *     `3ヶ月前` -> `三箇月前`, `20歳` -> `二十歳`, `300円` -> `三百円`, `1人` -> `一人`)
 *   - Calendar date & euphonic counter post-processing guards (`4月1日` -> `しがつついたち`,
 *     `20日` / `二十日` -> `はつか`, `8ヶ月` -> `はっかげつ`, `何ヶ月` -> `なんかげつ`)
 */

import * as ort from '../../vendor/onnxruntime-web/ort.wasm.min.mjs';
import { create as createHorseFurigana, files as horseModelFiles } from '../../vendor/horse-furigana/dist/index.js';
import {
  createAdaptiveOrt,
  defaultFeedbackLearner,
  setFeedbackTextNormalizer,
} from './feedback-learner.js';

export { defaultFeedbackLearner };

ort.env.wasm.numThreads = 1;

function hasChromeRuntimeUrl() {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function';
}

const isNodeRuntime =
  typeof process !== 'undefined' && Boolean(process.versions && process.versions.node);

function configureWasmPathsIfNeeded() {
  if (hasChromeRuntimeUrl()) {
    const wasmBase = chrome.runtime.getURL('vendor/onnxruntime-web/');
    if (!isNodeRuntime || wasmBase.startsWith('file://')) {
      ort.env.wasm.wasmPaths = wasmBase;
    }
  }
}

configureWasmPathsIfNeeded();

const KANJI_OR_ITER_RE = /[\p{Script=Han}々〆ヵヶ]/u;
const ASCII_OR_FW_DIGIT_RE = /^[0-9０-９]$/;
const NUMERAL_OR_QUANT_PREFIX_RE = /[0-9０-９一二三四五六七八九十百千万億兆〇零何幾数]$/;
const NUMERAL_KANJI_RE = /[一二三四五六七八九十百千万億兆〇零]$/;
const COUNTER_KA_FOLLOW_RE = /^(?:か月|カ月|か所|カ所|か国|カ国|つ(?![ぁ-ゖ]))/u;
const DIGIT_PRECEDING_PREFIX_RE = /[第約全計築週月年時分秒]$/u;

const KANJI_DIGITS_STR = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const POSITIONAL_KANJI_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

const DECIMAL_FRAC_DIGIT_READING = Object.freeze({
  〇: 'ぜろ',
  零: 'れい',
  一: 'いち',
  二: 'に',
  三: 'さん',
  四: 'よん',
  五: 'ご',
  六: 'ろく',
  七: 'なな',
  八: 'はち',
  九: 'きゅう',
});

const KANJI_DIGIT_VAL = Object.freeze({
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

const KANJI_UNIT_VAL = Object.freeze({
  千: 1000,
  百: 100,
  十: 10,
});

const MONTH_READINGS = Object.freeze({
  一月: 'いちがつ',
  二月: 'にがつ',
  三月: 'さんがつ',
  四月: 'しがつ',
  五月: 'ごがつ',
  六月: 'ろくがつ',
  七月: 'しちがつ',
  八月: 'はちがつ',
  九月: 'くがつ',
  十月: 'じゅうがつ',
  十一月: 'じゅういちがつ',
  十二月: 'じゅうにがつ',
});

const SPECIAL_CALENDAR_DAYS = Object.freeze({
  1: 'ついたち',
  2: 'ふつか',
  3: 'みっか',
  4: 'よっか',
  5: 'いつか',
  6: 'むいか',
  7: 'なのか',
  8: 'ようか',
  9: 'ここのか',
  10: 'とおか',
  14: 'じゅうよっか',
  20: 'はつか',
  24: 'にじゅうよっか',
});

const COUNTER_BASE_READINGS = Object.freeze({
  箇月: 'かげつ',
  箇所: 'かしょ',
  箇国: 'かこく',
});

const COUNTER_TRAIL_READINGS = Object.freeze({
  間: 'かん',
  前: 'まえ',
  目: 'め',
  後: 'ご',
});

const CALENDAR_MONTH_DAY_RE =
  /^(十[一二]|[一二三四五六七八九十])月(三十一|三十|二十[一二三四五六七八九]?|十[一二三四五六七八九]?|[一二三四五六七八九])日$/;

const COUNTER_GUARD_RE =
  /^([一二三四五六七八九十百千]{1,9}|(?:[一二三四五六七八九]?[十百千])?数|何|幾)(箇月|箇所|箇国)([間前目後])?$/;

const DECIMAL_SEGMENT_RE =
  /^(〇|零|[一二三四五六七八九十百千万]{1,12})点([〇零一二三四五六七八九]{1,6})([\p{Script=Han}々〆ヵヶ]*)$/u;

const DAY_PREFIX_MERGE_RE =
  /^(二十四|二十|十四|[一二三四五六七八九十])日(間|中|目)?([\p{Script=Han}々〆ヵヶ]+)$/u;

const CALENDAR_MONTH_DAY_PREFIX_RE =
  /^(十[一二]|[一二三四五六七八九十])月(三十一|三十|二十[一二三四五六七八九]?|十[一二三四五六七八九]?|[一二三四五六七八九])日([\p{Script=Han}々〆ヵヶ]+)$/u;

/** @type {Promise<{ annotate(text: string): Promise<Array<{ text: string, reading?: string }>>, dispose(): Promise<void> }> | null} */
let cachedAnnotatorPromise = null;

/**
 * Converts Katakana characters (including ヵ/ヶ) to Hiragana while preserving other characters.
 *
 * @param {string} text
 * @returns {string}
 */
export function kataToHira(text) {
  if (!text) return '';
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x30a1 && cp <= 0x30f4) {
      out += String.fromCodePoint(cp - 0x60);
    } else if (ch === 'ヵ') {
      out += 'か';
    } else if (ch === 'ヶ') {
      out += 'け';
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Converts full-width digits `０-９` to ASCII `0-9`.
 *
 * @param {string} digits
 * @returns {string}
 */
function toAsciiDigits(digits) {
  let out = '';
  for (const ch of digits) {
    const cp = ch.codePointAt(0);
    out += cp >= 0xff10 && cp <= 0xff19 ? String.fromCodePoint(cp - 0xff10 + 0x30) : ch;
  }
  return out;
}

/**
 * Converts an integer `1..9999` into positional Japanese Kanji numerals.
 *
 * @param {number} k
 * @returns {string}
 */
function chunkUnder10000ToKanji(k) {
  const th = Math.floor(k / 1000);
  const hu = Math.floor((k % 1000) / 100);
  const te = Math.floor((k % 100) / 10);
  const on = k % 10;

  let out = '';
  if (th > 0) out += (th === 1 ? '' : KANJI_DIGITS_STR[th]) + '千';
  if (hu > 0) out += (hu === 1 ? '' : KANJI_DIGITS_STR[hu]) + '百';
  if (te > 0) out += (te === 1 ? '' : KANJI_DIGITS_STR[te]) + '十';
  if (on > 0) out += KANJI_DIGITS_STR[on];
  return out;
}

/**
 * Converts an integer `1..99999999` (up to 8 digits) into positional Japanese Kanji numerals.
 * Examples:
 *   16 -> 十六, 10 -> 十, 20 -> 二十, 100 -> 百, 300 -> 三百,
 *   1000 -> 千, 2026 -> 二千二十六, 10000 -> 一万
 *
 * @param {number} n
 * @returns {string | null}
 */
export function integerToKanji(n) {
  if (!Number.isInteger(n) || n < 1 || n > 99_999_999) {
    return null;
  }
  if (n < 10_000) {
    return chunkUnder10000ToKanji(n);
  }
  const man = Math.floor(n / 10_000);
  const rem = n % 10_000;
  const manStr = man === 1 ? '一' : chunkUnder10000ToKanji(man);
  return `${manStr}万${rem > 0 ? chunkUnder10000ToKanji(rem) : ''}`;
}

/**
 * Parses a standard positional Kanji integer `1..9999` (e.g. 四 -> 4, 二十四 -> 24, 三百 -> 300).
 *
 * @param {string} str
 * @returns {number | null}
 */
export function parseKanjiIntUnder10000(str) {
  let total = 0;
  let curDigit = null;
  let lastUnit = Infinity;

  for (const ch of str) {
    if (Object.hasOwn(KANJI_DIGIT_VAL, ch)) {
      if (curDigit !== null) return null;
      curDigit = KANJI_DIGIT_VAL[ch];
    } else if (Object.hasOwn(KANJI_UNIT_VAL, ch)) {
      const unit = KANJI_UNIT_VAL[ch];
      if (unit >= lastUnit) return null;
      total += (curDigit ?? 1) * unit;
      curDigit = null;
      lastUnit = unit;
    } else {
      return null;
    }
  }

  total += curDigit ?? 0;
  return total >= 1 && total <= 9999 ? total : null;
}

/**
 * Reads an integer `1..9999` in standard Japanese with optional gemination before `か`-row counters.
 *
 * @param {number} n
 * @param {boolean} geminateFinal
 * @returns {string | null}
 */
export function readNumberForKaCounter(n, geminateFinal = true) {
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
 * Reads a calendar day `1..31` in Japanese (`ついたち`, `ふつか`, ..., `じゅうよっか`, `はつか`, ...).
 *
 * @param {number} day
 * @returns {string | null}
 */
function readCalendarDay(day) {
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }
  if (Object.hasOwn(SPECIAL_CALENDAR_DAYS, day)) {
    return SPECIAL_CALENDAR_DAYS[day];
  }
  const numRead = readNumberForKaCounter(day, false);
  return numRead ? `${numRead}にち` : null;
}

/**
 * Resolves normalized `箇月` / `箇所` / `箇国` counter segments with exact euphonic gemination.
 *
 * @param {string} normSegText
 * @returns {string | null}
 */
function resolveNormalizedKaCounter(normSegText) {
  const m = COUNTER_GUARD_RE.exec(normSegText);
  if (!m) return null;
  const [, numPart, counterPart, trailPart] = m;
  const baseReading = COUNTER_BASE_READINGS[counterPart];
  if (!baseReading) return null;

  let numReading = null;
  if (numPart === '何') {
    numReading = 'なん';
  } else if (numPart === '幾') {
    numReading = 'いく';
  } else if (numPart === '数') {
    numReading = 'すう';
  } else if (numPart.endsWith('数')) {
    const pVal = parseKanjiIntUnder10000(numPart.slice(0, -1));
    const pRead = pVal ? readNumberForKaCounter(pVal, false) : null;
    if (pRead) numReading = `${pRead}すう`;
  } else {
    const val = parseKanjiIntUnder10000(numPart);
    if (val !== null) {
      numReading = readNumberForKaCounter(val, true);
    }
  }

  if (!numReading) return null;
  const trailReading = trailPart ? COUNTER_TRAIL_READINGS[trailPart] || '' : '';
  return `${numReading}${baseReading}${trailReading}`;
}

/**
 * Reads an integer `0..99999999` before `点` (`てん`) in a Japanese decimal expression
 * (e.g. `0.` -> `ぜろてん`, `1.` -> `いってん`, `8.` -> `はってん`, `10.` -> `じゅってん`).
 *
 * @param {string} intKanji
 * @returns {string | null}
 */
function readDecimalIntegerBeforeTen(intKanji) {
  if (intKanji === '〇') return 'ぜろ';
  if (intKanji === '零') return 'れい';

  const readUnder10000BeforeTen = (part) => {
    const val = parseKanjiIntUnder10000(part);
    if (val === null) return null;
    const ones = val % 10;
    const tens = Math.floor((val % 100) / 10);
    const hundreds = Math.floor((val % 1000) / 100);
    // In Japanese before `てん` (`t`-row): 1 -> いっ, 8 -> はっ, 10 -> じゅっ, 100 -> ひゃっ (or ひゃくてん; plain is standard except 1/8/10)
    if (ones === 1 || ones === 8 || (ones === 0 && tens > 0)) {
      return readNumberForKaCounter(val, true);
    }
    if (ones === 0 && tens === 0 && hundreds > 0) {
      return readNumberForKaCounter(val, false);
    }
    return readNumberForKaCounter(val, false);
  };

  const manIdx = intKanji.indexOf('万');
  if (manIdx < 0) {
    return readUnder10000BeforeTen(intKanji);
  }
  const manPart = intKanji.slice(0, manIdx);
  const remPart = intKanji.slice(manIdx + 1);
  const manVal = parseKanjiIntUnder10000(manPart);
  if (manVal === null) return null;
  const manRead = readNumberForKaCounter(manVal, false);
  if (!manRead) return null;
  if (!remPart) return `${manRead}まん`;
  const remRead = readUnder10000BeforeTen(remPart);
  return remRead ? `${manRead}まん${remRead}` : null;
}

/**
 * Resolves `<int>点<frac>` Japanese decimal reading (`1.5` -> `いってんご`, `3.14` -> `さんてんいちよん`).
 *
 * @param {string} intPart
 * @param {string} fracPart
 * @returns {string | null}
 */
function resolveDecimalPrefixReading(intPart, fracPart) {
  const intRead = readDecimalIntegerBeforeTen(intPart);
  if (!intRead) return null;
  let fracRead = '';
  for (const ch of fracPart) {
    const dRead = DECIMAL_FRAC_DIGIT_READING[ch];
    if (!dRead) return null;
    fracRead += dRead;
  }
  return `${intRead}てん${fracRead}`;
}

/**
 * Pre-normalizes numbers and counters for Horse Furigana while recording exact bidirectional
 * UTF-16 offset mappings (`[origStart, origEnd] <-> [normStart, normEnd]`) at code-point boundaries.
 *
 * Optional `options.selectionStart` / `options.selectionEnd` split multi-digit runs cleanly at
 * user selection boundaries so partial selections inside numbers (e.g. `6年` inside `16年前` or
 * `345円` inside `12345円`) never absorb unselected digits or fuse across selection boundaries.
 *
 * @param {string} origText
 * @param {{ selectionStart?: number, selectionEnd?: number }} [options]
 * @returns {{
 *   origText: string,
 *   normText: string,
 *   pieces: Array<{
 *     origStart: number,
 *     origEnd: number,
 *     normStart: number,
 *     normEnd: number,
 *     origText: string,
 *     normText: string,
 *     converted: boolean
 *   }>
 * }}
 */
export function normalizeForAnnotation(origText, options = {}) {
  const text = String(origText ?? '');
  const selStart = typeof options?.selectionStart === 'number' ? options.selectionStart : -1;
  const selEnd = typeof options?.selectionEnd === 'number' ? options.selectionEnd : -1;
  const hasSelBounds = selStart >= 0 && selEnd > selStart && selEnd <= text.length;

  const cps = Array.from(text);
  const cpOffsets = new Array(cps.length + 1);
  let u16 = 0;
  for (let idx = 0; idx < cps.length; idx++) {
    cpOffsets[idx] = u16;
    u16 += cps[idx].length;
  }
  cpOffsets[cps.length] = u16;

  const splitSet = new Set();
  if (hasSelBounds) {
    splitSet.add(selStart);
    splitSet.add(selEnd);
  }

  const pieces = [];
  let normText = '';
  let normCursor = 0;
  let i = 0;

  while (i < cps.length) {
    const ch = cps[i];

    // 1. Contiguous ASCII / full-width digit run (respecting selection split boundaries)
    if (ASCII_OR_FW_DIGIT_RE.test(ch)) {
      let end = i + 1;
      while (
        end < cps.length &&
        ASCII_OR_FW_DIGIT_RE.test(cps[end]) &&
        !splitSet.has(cpOffsets[end])
      ) {
        end++;
      }

      const runOrigStart = cpOffsets[i];
      const runOrigEnd = cpOffsets[end];

      // If selection bounds exist and this digit sub-run was sliced off OUTSIDE `[selStart, selEnd]`
      // directly adjacent to another digit inside `[selStart, selEnd]`, keep the outside fragment
      // as raw digits so the two sides never fuse into one Kanji run.
      const splitBeforeInsideDigits =
        hasSelBounds &&
        runOrigEnd === selStart &&
        end < cps.length &&
        ASCII_OR_FW_DIGIT_RE.test(cps[end]);
      const splitAfterInsideDigits =
        hasSelBounds &&
        runOrigStart === selEnd &&
        i > 0 &&
        ASCII_OR_FW_DIGIT_RE.test(cps[i - 1]);

      const rawRun = cps.slice(i, end).join('');
      const asciiRun = toAsciiDigits(rawRun);
      const prevChar = i > 0 ? cps[i - 1] : '';
      const prev2Char = i > 1 ? cps[i - 2] : '';

      // 1a. Decimal `<int>.<frac>` adjacent to Kanji/counter (e.g. `1.5倍`, `0.5秒`, `3.14倍`)
      if (
        !splitBeforeInsideDigits &&
        !splitAfterInsideDigits &&
        prevChar !== '.' &&
        prevChar !== '．' &&
        end < cps.length &&
        (cps[end] === '.' || cps[end] === '．') &&
        !splitSet.has(cpOffsets[end]) &&
        end + 1 < cps.length &&
        ASCII_OR_FW_DIGIT_RE.test(cps[end + 1]) &&
        !splitSet.has(cpOffsets[end + 1])
      ) {
        let fracEnd = end + 2;
        while (
          fracEnd < cps.length &&
          ASCII_OR_FW_DIGIT_RE.test(cps[fracEnd]) &&
          !splitSet.has(cpOffsets[fracEnd])
        ) {
          fracEnd++;
        }

        const fracSplitBeforeInside =
          hasSelBounds &&
          cpOffsets[fracEnd] === selStart &&
          fracEnd < cps.length &&
          ASCII_OR_FW_DIGIT_RE.test(cps[fracEnd]);
        const afterFracChar = fracEnd < cps.length ? cps[fracEnd] : '';
        const afterFracSlice = cps.slice(fracEnd, Math.min(cps.length, fracEnd + 4)).join('');
        const notDotChain = afterFracChar !== '.' && afterFracChar !== '．';
        const fracLen = fracEnd - (end + 1);
        const validIntForDec =
          asciiRun === '0' || (asciiRun.length >= 1 && asciiRun.length <= 8 && asciiRun[0] !== '0');
        const decAdjacentToKanji =
          (afterFracChar && KANJI_OR_ITER_RE.test(afterFracChar)) ||
          COUNTER_KA_FOLLOW_RE.test(afterFracSlice);

        if (
          !fracSplitBeforeInside &&
          notDotChain &&
          validIntForDec &&
          fracLen >= 1 &&
          fracLen <= 6 &&
          decAdjacentToKanji
        ) {
          const intKanji = asciiRun === '0' ? '〇' : integerToKanji(Number(asciiRun));
          if (intKanji) {
            // Integer piece
            pieces.push({
              origStart: runOrigStart,
              origEnd: runOrigEnd,
              normStart: normCursor,
              normEnd: normCursor + intKanji.length,
              origText: rawRun,
              normText: intKanji,
              converted: true,
            });
            normText += intKanji;
            normCursor += intKanji.length;

            // Dot piece -> `点`
            const dotCh = cps[end];
            pieces.push({
              origStart: cpOffsets[end],
              origEnd: cpOffsets[end + 1],
              normStart: normCursor,
              normEnd: normCursor + 1,
              origText: dotCh,
              normText: '点',
              converted: true,
            });
            normText += '点';
            normCursor += 1;

            // Fractional digit pieces (1-to-1 per digit)
            for (let f = end + 1; f < fracEnd; f++) {
              const fOrig = cps[f];
              const fVal = Number(toAsciiDigits(fOrig));
              const fKanji = POSITIONAL_KANJI_DIGITS[fVal];
              pieces.push({
                origStart: cpOffsets[f],
                origEnd: cpOffsets[f + 1],
                normStart: normCursor,
                normEnd: normCursor + fKanji.length,
                origText: fOrig,
                normText: fKanji,
                converted: true,
              });
              normText += fKanji;
              normCursor += fKanji.length;
            }

            i = fracEnd;
            continue;
          }
        }
      }

      const nextSlice = cps.slice(end, Math.min(cps.length, end + 4)).join('');
      const nextChar = end < cps.length ? cps[end] : '';
      const next2Char = end + 1 < cps.length ? cps[end + 1] : '';

      const isDecimalPart =
        ((prevChar === '.' || prevChar === '．') && ASCII_OR_FW_DIGIT_RE.test(prev2Char)) ||
        ((nextChar === '.' || nextChar === '．') && ASCII_OR_FW_DIGIT_RE.test(next2Char));

      const isSingleZero = !isDecimalPart && asciiRun === '0';
      const isValidPositiveInt =
        !isDecimalPart &&
        asciiRun.length >= 1 &&
        asciiRun.length <= 8 &&
        asciiRun[0] !== '0';

      const adjacentToKanjiOrCounter =
        (nextChar && KANJI_OR_ITER_RE.test(nextChar)) ||
        COUNTER_KA_FOLLOW_RE.test(nextSlice) ||
        (prevChar && DIGIT_PRECEDING_PREFIX_RE.test(prevChar));

      if (
        !splitBeforeInsideDigits &&
        !splitAfterInsideDigits &&
        adjacentToKanjiOrCounter &&
        (isSingleZero || isValidPositiveInt)
      ) {
        const kanjiNum = isSingleZero ? '〇' : integerToKanji(Number(asciiRun));
        if (kanjiNum) {
          const normStart = normCursor;
          const normEnd = normStart + kanjiNum.length;
          pieces.push({
            origStart: runOrigStart,
            origEnd: runOrigEnd,
            normStart,
            normEnd,
            origText: rawRun,
            normText: kanjiNum,
            converted: true,
          });
          normText += kanjiNum;
          normCursor = normEnd;
          i = end;
          continue;
        }
      }

      // Leave leading-zero / decimal / non-Japanese digit runs untouched char-by-char
      for (let k = i; k < end; k++) {
        const dCh = cps[k];
        const origStart = cpOffsets[k];
        const origEnd = cpOffsets[k + 1];
        const normStart = normCursor;
        const normEnd = normStart + dCh.length;
        pieces.push({
          origStart,
          origEnd,
          normStart,
          normEnd,
          origText: dCh,
          normText: dCh,
          converted: false,
        });
        normText += dCh;
        normCursor = normEnd;
      }
      i = end;
      continue;
    }

    // 2. Counter `ヶ` / `ヵ` after numerals or quantifiers (何 / 幾 / 数)
    if (
      (ch === 'ヶ' || ch === 'ヵ') &&
      i > 0 &&
      NUMERAL_OR_QUANT_PREFIX_RE.test(cps[i - 1]) &&
      i + 1 < cps.length &&
      KANJI_OR_ITER_RE.test(cps[i + 1])
    ) {
      const origStart = cpOffsets[i];
      const origEnd = cpOffsets[i + 1];
      const normStart = normCursor;
      const normEnd = normStart + 1;
      pieces.push({
        origStart,
        origEnd,
        normStart,
        normEnd,
        origText: ch,
        normText: '箇',
        converted: true,
      });
      normText += '箇';
      normCursor = normEnd;
      i += 1;
      continue;
    }

    // 3. Counter `か` / `カ` before `月` / `所` / `国` after numerals or quantifiers
    if (
      (ch === 'か' || ch === 'カ') &&
      i > 0 &&
      NUMERAL_OR_QUANT_PREFIX_RE.test(cps[i - 1]) &&
      i + 1 < cps.length &&
      (cps[i + 1] === '月' || cps[i + 1] === '所' || cps[i + 1] === '国')
    ) {
      const origStart = cpOffsets[i];
      const origEnd = cpOffsets[i + 1];
      const normStart = normCursor;
      const normEnd = normStart + 1;
      pieces.push({
        origStart,
        origEnd,
        normStart,
        normEnd,
        origText: ch,
        normText: '箇',
        converted: true,
      });
      normText += '箇';
      normCursor = normEnd;
      i += 1;
      continue;
    }

    // 4. Default 1-to-1 character passthrough
    const origStart = cpOffsets[i];
    const origEnd = cpOffsets[i + 1];
    const normStart = normCursor;
    const normEnd = normStart + ch.length;
    pieces.push({
      origStart,
      origEnd,
      normStart,
      normEnd,
      origText: ch,
      normText: ch,
      converted: false,
    });
    normText += ch;
    normCursor = normEnd;
    i += 1;
  }

  return { origText: text, normText, pieces };
}

setFeedbackTextNormalizer(normalizeForAnnotation);

/**
 * Applies deterministic post-fix guards to raw Horse Furigana segments in normalized space:
 *   1. Calendar month + day (`四月一日` -> `しがつ` + `ついたち`, `五月二十日` -> `ごがつ` + `はつか`)
 *   2. Standalone / embedded `二十日` -> `はつか` (when not preceded by higher numerals like `百二十日`)
 *   3. Post-month `一日` (when preceded by `<digits>月` and not followed by `中`/`間`/`目`) -> `ついたち`
 *   4. Day/duration expressions merged into a following Kanji word (`一日働く` -> `いちにち` + `はたら` + `く`,
 *      `二十日間働いた` -> `はつかかん` + `はたら` + `いた`, `十日働く` -> `とおか` + `はたら` + `く`)
 *   5. Decimal expressions (`一点五倍` -> `いってんご` + `ばい`, `三点一四倍` -> `さんてんいちよん` + `ばい`)
 *   6. `箇月` / `箇所` / `箇国` euphonic gemination (`八箇月` -> `はっかげつ`, `何箇月` -> `なんかげつ`)
 *
 * @param {Array<{ text: string, reading?: string }>} rawSegments
 * @param {string} normText
 * @param {{ annotate(t: string): Promise<Array<{ text: string, reading?: string }>> } | null} [annotator]
 * @returns {Promise<Array<{ normStart: number, normEnd: number, normSurface: string, reading: string, isKanji: boolean }>>}
 */
async function applyPostFixGuards(rawSegments, normText, annotator = null) {
  const out = [];
  let cursor = 0;

  const annotateTailKanji = async (tailKanji, tailStart, afterContext) => {
    if (!annotator) {
      return [{ normStart: tailStart, normEnd: tailStart + tailKanji.length, normSurface: tailKanji, reading: tailKanji, isKanji: true }];
    }
    const probeContext = tailKanji + afterContext.slice(0, 12);
    const subRaw = await annotator.annotate(probeContext);
    const subItems = [];
    let consumed = 0;
    for (const s of subRaw) {
      if (consumed >= tailKanji.length) break;
      const takeLen = Math.min(s.text.length, tailKanji.length - consumed);
      const subText = s.text.slice(0, takeLen);
      const isK = typeof s.reading === 'string';
      subItems.push({
        normStart: tailStart + consumed,
        normEnd: tailStart + consumed + takeLen,
        normSurface: subText,
        reading: isK ? s.reading : subText,
        isKanji: isK,
      });
      consumed += takeLen;
    }
    return subItems;
  };

  for (const seg of rawSegments) {
    const segText = String(seg.text ?? '');
    const normStart = cursor;
    const normEnd = cursor + segText.length;
    cursor = normEnd;

    if (typeof seg.reading !== 'string') {
      const isGenitiveKaBetweenKanji =
        (segText === 'ヶ' || segText === 'ヵ') &&
        normStart > 0 &&
        normEnd < normText.length &&
        KANJI_OR_ITER_RE.test(normText[normStart - 1]) &&
        KANJI_OR_ITER_RE.test(normText[normEnd]);
      out.push({
        normStart,
        normEnd,
        normSurface: segText,
        reading: isGenitiveKaBetweenKanji ? 'が' : segText,
        isKanji: isGenitiveKaBetweenKanji,
      });
      continue;
    }

    const beforeStr = normText.slice(0, normStart);
    const afterStr = normText.slice(normEnd);

    // Guard 1: Combined `<1..12>月<1..31>日` calendar date segment (not followed by 中/間/目)
    const calMatch = CALENDAR_MONTH_DAY_RE.exec(segText);
    if (calMatch && !NUMERAL_KANJI_RE.test(beforeStr) && !/^[中間目]/.test(afterStr)) {
      const monthSurface = `${calMatch[1]}月`;
      const daySurface = `${calMatch[2]}日`;
      const monthReading = MONTH_READINGS[monthSurface];
      const dayVal = parseKanjiIntUnder10000(calMatch[2]);
      const dayReading = dayVal ? readCalendarDay(dayVal) : null;

      if (monthReading && dayReading) {
        const splitPos = normStart + monthSurface.length;
        out.push({
          normStart,
          normEnd: splitPos,
          normSurface: monthSurface,
          reading: monthReading,
          isKanji: true,
        });
        out.push({
          normStart: splitPos,
          normEnd,
          normSurface: daySurface,
          reading: dayReading,
          isKanji: true,
        });
        continue;
      }
    }

    // Guard 1b: `<1..12>月<1..31>日` merged with a following Kanji word (e.g. `四月一日始` in `4月1日始まる`)
    const calPrefixMatch = CALENDAR_MONTH_DAY_PREFIX_RE.exec(segText);
    if (
      calPrefixMatch &&
      !NUMERAL_KANJI_RE.test(beforeStr) &&
      !/^[中間目]/.test(calPrefixMatch[3])
    ) {
      const monthSurface = `${calPrefixMatch[1]}月`;
      const daySurface = `${calPrefixMatch[2]}日`;
      const tailKanji = calPrefixMatch[3];
      const monthReading = MONTH_READINGS[monthSurface];
      const dayVal = parseKanjiIntUnder10000(calPrefixMatch[2]);
      const dayReading = dayVal ? readCalendarDay(dayVal) : null;

      if (monthReading && dayReading) {
        const p1 = normStart + monthSurface.length;
        const p2 = p1 + daySurface.length;
        out.push({
          normStart,
          normEnd: p1,
          normSurface: monthSurface,
          reading: monthReading,
          isKanji: true,
        });
        out.push({
          normStart: p1,
          normEnd: p2,
          normSurface: daySurface,
          reading: dayReading,
          isKanji: true,
        });
        const tailSegs = await annotateTailKanji(tailKanji, p2, afterStr);
        out.push(...tailSegs);
        continue;
      }
    }

    // Guard 2: Leading-zero digit month like `04月1日` -> `04` + `月一日`
    if (
      segText === '月一日' &&
      /(?:1[0-2]|0?[1-9]|１[０-２]|０?[１-９])$/.test(beforeStr) &&
      !/^[中間目]/.test(afterStr)
    ) {
      out.push({
        normStart,
        normEnd: normStart + 1,
        normSurface: '月',
        reading: 'がつ',
        isKanji: true,
      });
      out.push({
        normStart: normStart + 1,
        normEnd,
        normSurface: '一日',
        reading: 'ついたち',
        isKanji: true,
      });
      continue;
    }

    // Guard 3: `一日` immediately after `<month>月` (not followed by 中/間/目)
    if (
      segText === '一日' &&
      /[一二三四五六七八九十1-9１-９]月$/.test(beforeStr) &&
      !/^[中間目]/.test(afterStr)
    ) {
      out.push({
        normStart,
        normEnd,
        normSurface: segText,
        reading: 'ついたち',
        isKanji: true,
      });
      continue;
    }

    // Guard 4: `二十日` (`20日` / `２０日`) -> `はつか`
    if (segText === '二十日' && !NUMERAL_KANJI_RE.test(beforeStr)) {
      out.push({
        normStart,
        normEnd,
        normSurface: segText,
        reading: 'はつか',
        isKanji: true,
      });
      continue;
    }
    if (segText.endsWith('二十日') && segText.length > 3) {
      const prefixSurface = segText.slice(0, -3);
      if (!NUMERAL_KANJI_RE.test(prefixSurface)) {
        let fixedReading = seg.reading;
        if (fixedReading.endsWith('はたち')) {
          fixedReading = `${fixedReading.slice(0, -3)}はつか`;
        } else if (fixedReading.endsWith('に')) {
          fixedReading = `${fixedReading.slice(0, -1)}はつか`;
        }
        out.push({
          normStart,
          normEnd,
          normSurface: segText,
          reading: fixedReading,
          isKanji: true,
        });
        continue;
      }
    }

    // Guard 4b: Day/duration expression merged with following Kanji (`一日働` -> `いちにち` + `はたら`,
    // `二十日間働` -> `はつかかん` + `はたら`, `十日働` + `く` -> `とおか` + `はたら`)
    const dayMergeMatch = DAY_PREFIX_MERGE_RE.exec(segText);
    if (dayMergeMatch && !NUMERAL_KANJI_RE.test(beforeStr)) {
      const [, numDayStr, durSuffix = '', tailKanji] = dayMergeMatch;
      const dayPrefixSurface = `${numDayStr}日${durSuffix}`;
      const dayVal = parseKanjiIntUnder10000(numDayStr);
      const followedByOkurigana = /^[ぁ-ゖ]/.test(afterStr);
      const isPostMonth = /[一二三四五六七八九十1-9１-９]月$/.test(beforeStr);

      let prefixReading = null;
      if (numDayStr === '二十') {
        const suffixRead =
          durSuffix === '間' ? 'かん' : durSuffix === '中' ? 'じゅう' : durSuffix === '目' ? 'め' : '';
        prefixReading = `はつか${suffixRead}`;
      } else if (numDayStr === '一') {
        const hiraSeg = kataToHira(seg.reading);
        const droppedNichi =
          hiraSeg.startsWith('いち') &&
          !hiraSeg.startsWith('いちにち') &&
          !hiraSeg.startsWith('いちじつ');
        if (droppedNichi || (isPostMonth && !durSuffix)) {
          const baseOneDay = isPostMonth && !durSuffix ? 'ついたち' : 'いちにち';
          const suffixRead =
            durSuffix === '間' ? 'かん' : durSuffix === '中' ? 'じゅう' : durSuffix === '目' ? 'め' : '';
          prefixReading = `${baseOneDay}${suffixRead}`;
        }
      } else if (dayVal !== null && followedByOkurigana) {
        const baseDayRead = readCalendarDay(dayVal);
        const suffixRead =
          durSuffix === '間' ? 'かん' : durSuffix === '中' ? 'じゅう' : durSuffix === '目' ? 'め' : '';
        if (baseDayRead) {
          prefixReading = `${baseDayRead}${suffixRead}`;
        }
      }

      if (prefixReading) {
        const splitPos = normStart + dayPrefixSurface.length;
        out.push({
          normStart,
          normEnd: splitPos,
          normSurface: dayPrefixSurface,
          reading: prefixReading,
          isKanji: true,
        });
        const tailSegs = await annotateTailKanji(tailKanji, splitPos, afterStr);
        out.push(...tailSegs);
        continue;
      }
    }

    // Guard 5: Decimal expression `<int>点<frac><counter?>` (`一点五倍` -> `いってんご` + `ばい`, `三点一四倍` -> `さんてんいちよん` + `ばい`)
    const decMatch = DECIMAL_SEGMENT_RE.exec(segText);
    if (decMatch && !NUMERAL_KANJI_RE.test(beforeStr)) {
      const [, intPart, fracPart, tailKanji] = decMatch;
      const decRead = resolveDecimalPrefixReading(intPart, fracPart);
      if (decRead) {
        const decSurface = `${intPart}点${fracPart}`;
        if (!tailKanji) {
          out.push({
            normStart,
            normEnd,
            normSurface: segText,
            reading: decRead,
            isKanji: true,
          });
          continue;
        }
        const splitPos = normStart + decSurface.length;
        out.push({
          normStart,
          normEnd: splitPos,
          normSurface: decSurface,
          reading: decRead,
          isKanji: true,
        });
        const tailSegs = await annotateTailKanji(tailKanji, splitPos, afterStr);
        out.push(...tailSegs);
        continue;
      }
    }

    // Guard 6: Euphonic `箇月` / `箇所` / `箇国` counters
    const counterFixed = resolveNormalizedKaCounter(segText);
    if (counterFixed) {
      out.push({
        normStart,
        normEnd,
        normSurface: segText,
        reading: counterFixed,
        isKanji: true,
      });
      continue;
    }

    out.push({
      normStart,
      normEnd,
      normSurface: segText,
      reading: seg.reading,
      isKanji: true,
    });
  }

  return out;
}

/**
 * Loads raw ONNX model bytes and JSON lexicon assets in either Chrome Extension or Node.js.
 */
async function loadHorseAssets() {
  configureWasmPathsIfNeeded();
  if (hasChromeRuntimeUrl()) {
    const base = 'vendor/horse-furigana/models/';
    const fetchJson = async (name) => {
      const res = await fetch(chrome.runtime.getURL(base + name));
      if (!res.ok) {
        throw new Error(`Failed to load ${name} (${res.status})`);
      }
      return res.json();
    };
    const modelRes = await fetch(chrome.runtime.getURL(base + 'model.int8.onnx'));
    if (!modelRes.ok) {
      throw new Error(`Failed to load model.int8.onnx (${modelRes.status})`);
    }

    const [modelBuf, vocab, kanjiCandidates, readings, names] = await Promise.all([
      modelRes.arrayBuffer(),
      fetchJson('vocab.json'),
      fetchJson('kanji-candidates.json'),
      fetchJson('readings.json'),
      fetchJson('names.json'),
    ]);

    return {
      model: new Uint8Array(modelBuf),
      vocab,
      lexicon: { kanjiCandidates, readings, names },
    };
  }

  // Node.js environment (automated tests / CLI)
  const fs = await import('node:fs/promises');
  const [modelBuf, vocabRaw, kanjiRaw, readingsRaw, namesRaw] = await Promise.all([
    fs.readFile(horseModelFiles.model),
    fs.readFile(horseModelFiles.vocab, 'utf8'),
    fs.readFile(horseModelFiles.kanjiCandidates, 'utf8'),
    fs.readFile(horseModelFiles.readings, 'utf8'),
    fs.readFile(horseModelFiles.names, 'utf8'),
  ]);

  return {
    model: new Uint8Array(modelBuf.buffer, modelBuf.byteOffset, modelBuf.byteLength),
    vocab: JSON.parse(vocabRaw),
    lexicon: {
      kanjiCandidates: JSON.parse(kanjiRaw),
      readings: JSON.parse(readingsRaw),
      names: JSON.parse(namesRaw),
    },
  };
}

/**
 * Returns the memoized Horse Furigana ONNX annotator instance (`{ annotate, dispose }`),
 * ensuring concurrent callers share one single loaded ONNX InferenceSession.
 */
export function getAnnotator() {
  if (!cachedAnnotatorPromise) {
    cachedAnnotatorPromise = (async () => {
      try {
        const { model, vocab, lexicon } = await loadHorseAssets();
        defaultFeedbackLearner.attachModelAssets({
          vocab,
          runtimeLexicon: lexicon,
        });
        const { wrappedOrt } = createAdaptiveOrt(ort, defaultFeedbackLearner, vocab);
        const annotator = await createHorseFurigana({
          ort: wrappedOrt,
          model,
          vocab,
          lexicon,
        });
        if (defaultFeedbackLearner.entries.length > 0) {
          await defaultFeedbackLearner.retrainAll();
        }
        return annotator;
      } catch (err) {
        cachedAnnotatorPromise = null;
        throw err;
      }
    })();
  }
  return cachedAnnotatorPromise;
}

/**
 * Annotates Japanese `text` using the ONNX neural model with span-preserving number/counter
 * pre-normalization and calendar date post-fix guards, mapping every segment back to exact
 * `[origStart, origEnd]` offsets in `text`.
 *
 * @param {string} text
 * @param {{ annotate(t: string): Promise<Array<{ text: string, reading?: string }>> } | null} [customAnnotator]
 * @returns {Promise<{
 *   origText: string,
 *   normText: string,
 *   pieces: Array<{
 *     origStart: number,
 *     origEnd: number,
 *     normStart: number,
 *     normEnd: number,
 *     origText: string,
 *     normText: string,
 *     converted: boolean
 *   }>,
 *   segments: Array<{
 *     origStart: number,
 *     origEnd: number,
 *     normStart: number,
 *     normEnd: number,
 *     surface: string,
 *     normSurface: string,
 *     reading: string,
 *     isKanji: boolean
 *   }>,
 *   fullReading: string
 * }>}
 */
export async function annotateWithAI(text, customAnnotator = null, options = {}) {
  const { origText, normText, pieces } = normalizeForAnnotation(text, options);
  if (!normText) {
    return { origText, normText, pieces, segments: [], fullReading: '' };
  }

  const learner =
    options?.feedbackLearner === false
      ? null
      : options?.feedbackLearner || defaultFeedbackLearner;

  const annotator = customAnnotator || (await getAnnotator());
  const rawSegments = await annotator.annotate(normText);
  const guardedRaw = await applyPostFixGuards(rawSegments, normText, annotator);
  const guarded = learner
    ? learner.applyLearnedSpansToSegments(guardedRaw, normText)
    : guardedRaw;

  let pieceIdx = 0;
  const segments = [];

  for (const g of guarded) {
    while (pieceIdx < pieces.length && pieces[pieceIdx].normEnd <= g.normStart) {
      pieceIdx++;
    }
    let endPieceIdx = pieceIdx;
    while (endPieceIdx + 1 < pieces.length && pieces[endPieceIdx + 1].normStart < g.normEnd) {
      endPieceIdx++;
    }

    const firstPiece = pieces[pieceIdx];
    const lastPiece = pieces[endPieceIdx];
    const origStart = firstPiece ? firstPiece.origStart : 0;
    const origEnd = lastPiece ? lastPiece.origEnd : origText.length;
    const surface = origText.slice(origStart, origEnd);

    segments.push({
      origStart,
      origEnd,
      normStart: g.normStart,
      normEnd: g.normEnd,
      surface,
      normSurface: g.normSurface,
      reading: g.isKanji ? g.reading : surface,
      isKanji: g.isKanji,
      learned: Boolean(g.learned),
    });
  }

  const fullReading = segments.map((s) => s.reading).join('');
  return {
    origText,
    normText,
    pieces,
    segments,
    fullReading,
  };
}
