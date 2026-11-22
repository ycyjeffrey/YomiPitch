import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitMorae,
  computePitchContour,
  buildPitchContours,
  getPitchPatternInfo,
} from '../src/shared/pitch.js';

test('splitMorae splits standard hiragana, sokuon (っ), moraic nasal (ん), and chōonpu (ー)', () => {
  assert.deepEqual(splitMorae('かいぶつ'), ['か', 'い', 'ぶ', 'つ']);
  assert.deepEqual(splitMorae('にっぽん'), ['に', 'っ', 'ぽ', 'ん']);
  assert.deepEqual(splitMorae('せんせい'), ['せ', 'ん', 'せ', 'い']);
  assert.deepEqual(splitMorae('らーめん'), ['ら', 'ー', 'め', 'ん']);
  assert.deepEqual(splitMorae('コーヒー'), ['コ', 'ー', 'ヒ', 'ー']);
});

test('splitMorae merges small palatalized/glide kana with preceding regular kana into one mora', () => {
  assert.deepEqual(splitMorae('きょう'), ['きょ', 'う']);
  assert.deepEqual(splitMorae('しゃかい'), ['しゃ', 'か', 'い']);
  assert.deepEqual(splitMorae('とうきょう'), ['と', 'う', 'きょ', 'う']);
  assert.deepEqual(splitMorae('じょうず'), ['じょ', 'う', 'ず']);
  assert.deepEqual(splitMorae('べんきょう'), ['べ', 'ん', 'きょ', 'う']);
  assert.deepEqual(splitMorae('チェック'), ['チェ', 'ッ', 'ク']);
  assert.deepEqual(splitMorae('パーティー'), ['パ', 'ー', 'ティ', 'ー']);
});

test('splitMorae handles empty or non-string input safely', () => {
  assert.deepEqual(splitMorae(''), []);
  assert.deepEqual(splitMorae(null), []);
});

test('computePitchContour: Heiban (0) — かいぶつ [0]', () => {
  const c = computePitchContour('かいぶつ', 0);
  assert.equal(c.pattern, 'heiban');
  assert.equal(c.labelJa, '平板');
  assert.equal(c.moraCount, 4);
  assert.equal(c.risesOnParticle, false);
  assert.deepEqual(c.morae, [
    { text: 'か', high: false, dropAfter: false },
    { text: 'い', high: true, dropAfter: false },
    { text: 'ぶ', high: true, dropAfter: false },
    { text: 'つ', high: true, dropAfter: false },
  ]);
});

test('computePitchContour: 1-mora Heiban (0) — き [0] rises on following particle', () => {
  const c = computePitchContour('き', 0);
  assert.equal(c.pattern, 'heiban');
  assert.equal(c.risesOnParticle, true);
  assert.deepEqual(c.morae, [{ text: 'き', high: false, dropAfter: false }]);
});

test('computePitchContour: Atamadaka (1) — きょう [1], あめ [1], しゃかい [1]', () => {
  const kyou = computePitchContour('きょう', 1);
  assert.equal(kyou.pattern, 'atamadaka');
  assert.equal(kyou.labelJa, '頭高');
  assert.deepEqual(kyou.morae, [
    { text: 'きょ', high: true, dropAfter: true },
    { text: 'う', high: false, dropAfter: false },
  ]);

  const ame = computePitchContour('あめ', 1);
  assert.equal(ame.pattern, 'atamadaka');
  assert.deepEqual(ame.morae, [
    { text: 'あ', high: true, dropAfter: true },
    { text: 'め', high: false, dropAfter: false },
  ]);

  const shakai = computePitchContour('しゃかい', 1);
  assert.equal(shakai.pattern, 'atamadaka');
  assert.deepEqual(shakai.morae, [
    { text: 'しゃ', high: true, dropAfter: true },
    { text: 'か', high: false, dropAfter: false },
    { text: 'い', high: false, dropAfter: false },
  ]);
});

test('computePitchContour: Nakadaka (2..N-1) — にっぽん [3]', () => {
  const nippon = computePitchContour('にっぽん', 3);
  assert.equal(nippon.pattern, 'nakadaka');
  assert.equal(nippon.labelJa, '中高');
  assert.deepEqual(nippon.morae, [
    { text: 'に', high: false, dropAfter: false },
    { text: 'っ', high: true, dropAfter: false },
    { text: 'ぽ', high: true, dropAfter: true },
    { text: 'ん', high: false, dropAfter: false },
  ]);
});

test('computePitchContour: Odaka (N) — はし [2]', () => {
  const hashi = computePitchContour('はし', 2);
  assert.equal(hashi.pattern, 'odaka');
  assert.equal(hashi.labelJa, '尾高');
  assert.deepEqual(hashi.morae, [
    { text: 'は', high: false, dropAfter: false },
    { text: 'し', high: true, dropAfter: true },
  ]);
});

test('buildPitchContours supports words with multiple valid pitch accents (せいぶつ [1, 0])', () => {
  const contours = buildPitchContours('せいぶつ', [1, 0]);
  assert.equal(contours.length, 2);
  assert.equal(contours[0].pitch, 1);
  assert.equal(contours[0].pattern, 'atamadaka');
  assert.equal(contours[1].pitch, 0);
  assert.equal(contours[1].pattern, 'heiban');
  assert.match(getPitchPatternInfo(0, 4).tooltip, /平板/);
});
