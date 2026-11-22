/**
 * Mora splitting and Japanese pitch accent contour utilities.
 *
 * Pitch accent numbers follow standard NHK / Kanjium notation:
 *   0 = Heiban (平板): Low on 1st mora, High on remaining morae, no drop (stays/rises High on particle)
 *   1 = Atamadaka (頭高): High on 1st mora, drops immediately after 1st mora, Low thereafter
 *   k >= 2:
 *     - Nakadaka (中高) when k < moraCount: Low on 1st mora, High on morae 2..k, drops after mora k
 *     - Odaka (尾高) when k >= moraCount: Low on 1st mora, High on morae 2..N, drops after final mora (before particle)
 */

const SMALL_COMBINING_KANA_RE = /^[ゃゅょぁぃぅぇぉゎゕゖャュョァィゥェォヮヵヶ]$/;
const NON_GLIDE_BASE_RE = /^[っッんンー]$/;

/**
 * Splits a Hiragana or Katakana reading into Japanese morae.
 * - Palatalized/glide small kana combine with the preceding regular kana into 1 mora (きょう -> ['きょ', 'う']).
 * - Sokuon (っ/ッ), moraic nasal (ん/ン), and chōonpu (ー) each form their own separate mora.
 *
 * @param {string} reading
 * @returns {string[]}
 */
export function splitMorae(reading) {
  if (!reading || typeof reading !== 'string') {
    return [];
  }
  const chars = Array.from(reading.trim());
  const morae = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (morae.length > 0 && SMALL_COMBINING_KANA_RE.test(ch)) {
      const prevMora = morae[morae.length - 1];
      const prevLead = Array.from(prevMora)[0];
      if (!NON_GLIDE_BASE_RE.test(prevLead)) {
        morae[morae.length - 1] += ch;
        continue;
      }
    }
    morae.push(ch);
  }

  return morae;
}

/**
 * Returns human-readable metadata describing a pitch accent pattern.
 *
 * @param {number} pitch
 * @param {number} moraCount
 * @returns {{ pattern: 'heiban' | 'atamadaka' | 'nakadaka' | 'odaka', labelJa: string, labelEn: string, tooltip: string }}
 */
export function getPitchPatternInfo(pitch, moraCount) {
  if (pitch === 0) {
    return {
      pattern: 'heiban',
      labelJa: '平板',
      labelEn: 'Heiban',
      tooltip:
        moraCount === 1
          ? '0: 平板 (Heiban — starts low, rises on following particle)'
          : '0: 平板 (Heiban — starts low, stays high with no downstep)',
    };
  }
  if (pitch === 1) {
    return {
      pattern: 'atamadaka',
      labelJa: '頭高',
      labelEn: 'Atamadaka',
      tooltip: '1: 頭高 (Atamadaka — starts high, drops after 1st mora)',
    };
  }
  if (moraCount > 0 && pitch >= moraCount) {
    return {
      pattern: 'odaka',
      labelJa: '尾高',
      labelEn: 'Odaka',
      tooltip: `${pitch}: 尾高 (Odaka — rises after 1st mora, drops on following particle)`,
    };
  }
  return {
    pattern: 'nakadaka',
    labelJa: '中高',
    labelEn: 'Nakadaka',
    tooltip: `${pitch}: 中高 (Nakadaka — rises after 1st mora, drops after mora ${pitch})`,
  };
}

/**
 * Computes the mora-by-mora high/low pitch contour and downstep position.
 *
 * @param {string} reading
 * @param {number} pitch
 * @returns {{
 *   pitch: number,
 *   pattern: 'heiban' | 'atamadaka' | 'nakadaka' | 'odaka',
 *   labelJa: string,
 *   labelEn: string,
 *   tooltip: string,
 *   moraCount: number,
 *   risesOnParticle: boolean,
 *   morae: Array<{ text: string, high: boolean, dropAfter: boolean }>
 * }}
 */
export function computePitchContour(reading, pitch) {
  const moraTexts = splitMorae(reading);
  const n = moraTexts.length;
  const info = getPitchPatternInfo(pitch, n);

  if (n === 0) {
    return {
      pitch,
      ...info,
      moraCount: 0,
      risesOnParticle: false,
      morae: [],
    };
  }

  const morae = moraTexts.map((text, idx) => {
    if (pitch === 0) {
      return {
        text,
        high: idx > 0,
        dropAfter: false,
      };
    }
    if (pitch === 1) {
      return {
        text,
        high: idx === 0,
        dropAfter: idx === 0,
      };
    }
    // pitch >= 2: mora 0 is Low, morae 1..(pitch - 1) are High, drop after mora (pitch - 1)
    return {
      text,
      high: idx >= 1 && idx < pitch,
      dropAfter: idx === pitch - 1,
    };
  });

  return {
    pitch,
    ...info,
    moraCount: n,
    risesOnParticle: pitch === 0 && n === 1,
    morae,
  };
}

/**
 * Builds pitch contours for all pitch numbers associated with a reading.
 *
 * @param {string} reading
 * @param {number[] | undefined} pitches
 */
export function buildPitchContours(reading, pitches = []) {
  if (!Array.isArray(pitches) || pitches.length === 0) {
    return [];
  }
  return pitches.map((p) => computePitchContour(reading, p));
}
