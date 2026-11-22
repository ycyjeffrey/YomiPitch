import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createCachedDictLoader } from '../src/shared/dict-loader.js';
import { POS, deinflectWord } from '../src/shared/deinflect.js';
import { lookupKanji, normalizeSelectionText, containsKanji } from '../src/shared/lookup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DICT_PATH = path.resolve(__dirname, '..', 'data', 'dict.json.gz');

let streamOpenCount = 0;
const getDict = createCachedDictLoader(async () => {
  streamOpenCount += 1;
  return Readable.toWeb(fs.createReadStream(DICT_PATH));
});

test('dict-loader decompresses data/dict.json.gz via DecompressionStream("gzip") and caches concurrent calls', async () => {
  const [d1, d2, d3] = await Promise.all([getDict(), getDict(), getDict()]);
  assert.equal(streamOpenCount, 1, 'Expected concurrent getDict() calls to share one stream load');
  assert.equal(d1, d2);
  assert.equal(d2, d3);
  assert.ok(Object.keys(d1).length > 230000, 'Expected full 236k+ Kanji dictionary');
});

test('1. Unambiguous Kanji words return exact reading and pitch accent', async () => {
  const dict = await getDict();

  const cases = [
    ['怪物', 'かいぶつ', [0]],
    ['東京', 'とうきょう', [0]],
    ['先生', 'せんせい', [3]],
  ];

  for (const [word, expectedReading, expectedPitches] of cases) {
    const res = lookupKanji(word, dict);
    assert.equal(res.found, true, `Expected ${word} to be found`);
    assert.equal(res.matchType, 'exact');
    assert.equal(res.isTied, false);
    assert.equal(res.readings.length, 1);
    assert.equal(res.readings[0].reading, expectedReading);
    assert.deepEqual(res.readings[0].pitches, expectedPitches);
    assert.equal(res.readings[0].pitchContours.length, expectedPitches.length);
  }
});

test('2. Multi-reading Kanji where one reading is clearly more likely return only the top reading', async () => {
  const dict = await getDict();

  const cases = [
    ['人気', 'にんき', [0]],
    ['明日', 'あした', [3]],
    ['生物', 'せいぶつ', [1, 0]],
    ['上手', 'じょうず', [3]],
    ['日本', 'にほん', [2]],
    ['私', 'わたし', [0]],
    ['一人', 'ひとり', [2]],
  ];

  for (const [word, expectedReading, expectedPitches] of cases) {
    const res = lookupKanji(word, dict);
    assert.equal(res.found, true, `Expected ${word} to be found`);
    assert.equal(res.matchType, 'exact');
    assert.equal(res.isTied, false, `Expected ${word} not to be tied`);
    assert.equal(res.readings.length, 1, `Expected single winning reading for ${word}`);
    assert.equal(res.readings[0].reading, expectedReading);
    assert.deepEqual(res.readings[0].pitches, expectedPitches);
  }
});

test('3. Equal-likelihood ties return ALL tied readings and mark isTied = true', async () => {
  const dict = await getDict();

  const cases = [
    ['一日', [['いちにち', [4]], ['ついたち', [4]]]],
    ['市場', [['いちば', [1]], ['しじょう', [0]]]],
    ['金', [['かね', [0]], ['きん', [1]]]],
    ['風', [['かぜ', [0]], ['ふう', [1]]]],
    ['家', [['いえ', [2]], ['うち', [0]]]],
  ];

  for (const [word, expectedPairs] of cases) {
    const res = lookupKanji(word, dict);
    assert.equal(res.found, true, `Expected ${word} to be found`);
    assert.equal(res.matchType, 'exact');
    assert.equal(res.isTied, true, `Expected ${word} to be flagged as tied`);
    assert.equal(res.readings.length, expectedPairs.length);

    const actualMap = new Map(res.readings.map((r) => [r.reading, r.pitches]));
    for (const [expRead, expPitch] of expectedPairs) {
      assert.ok(actualMap.has(expRead), `Expected ${word} to include tied reading ${expRead}`);
      assert.deepEqual(actualMap.get(expRead), expPitch);
    }
  }
});

test('4. Verb, i-adjective, and suru-verb deinflections reconstruct full conjugated readings and base pitch', async () => {
  const dict = await getDict();

  const cases = [
    // Ichidan & chained auxiliaries
    ['食べた', 'たべた', '食べる', [2]],
    ['食べなかった', 'たべなかった', '食べる', [2]],
    ['食べたくなかった', 'たべたくなかった', '食べる', [2]],
    // Godan verbs across all rows + irregulars
    ['読んだ', 'よんだ', '読む', [1]],
    ['読まれている', 'よまれている', '読む', [1]],
    ['書いた', 'かいた', '書く', [1]],
    ['書かなかった', 'かかなかった', '書く', [1]],
    ['泳いだ', 'およいだ', '泳ぐ', [2]],
    ['泳いでいた', 'およいでいた', '泳ぐ', [2]],
    ['話した', 'はなした', '話す', [2]],
    ['話します', 'はなします', '話す', [2]],
    ['待った', 'まった', null, null],
    ['待たない', 'またない', '待つ', [1]],
    ['死んだ', 'しんだ', '死ぬ', [0]],
    ['遊んだ', 'あそんだ', '遊ぶ', [0]],
    ['帰った', 'かえった', '帰る', [1]],
    ['買った', 'かった', '買う', [0]],
    ['買わない', 'かわない', '買う', [0]],
    // Irregular v5k-s (行く)
    ['行った', 'いった', '行く', [0]],
    ['行かない', 'いかない', '行く', [0]],
    ['行きます', 'いきます', '行く', [0]],
    // v5u-s u-onbin (問う / 請う)
    ['問うた', 'とうた', '問う', [0, 1]],
    ['請うた', 'こうた', '請う', [1]],
    // Irregular vk (来る)
    ['来た', 'きた', '来る', [1]],
    ['来ない', 'こない', '来る', [1]],
    ['来なかった', 'こなかった', '来る', [1]],
    ['来よう', 'こよう', '来る', [1]],
    ['来られる', 'こられる', '来る', [1]],
    ['来させる', 'こさせる', '来る', [1]],
    // i-Adjectives including 良い / いい / 可愛い
    ['高かった', 'たかかった', '高い', [2]],
    ['高くない', 'たかくない', '高い', [2]],
    ['高ければ', 'たかければ', '高い', [2]],
    ['良かった', 'よかった', '良い', [1]],
    ['気持ち良かった', 'きもちよかった', '気持ち良い', []],
    ['気持ちよかった', 'きもちよかった', '気持ちいい', []],
    ['可愛かった', 'かわいかった', '可愛い', [3]],
    // Suru-verbs
    ['勉強する', 'べんきょうする', '勉強', [0]],
    ['勉強した', 'べんきょうした', '勉強', [0]],
    ['勉強しない', 'べんきょうしない', '勉強', [0]],
    ['勉強できる', 'べんきょうできる', '勉強', [0]],
    ['勉強される', 'べんきょうされる', '勉強', [0]],
  ];

  for (const [surface, expectedReading, expectedBase, expectedBasePitches] of cases) {
    const res = lookupKanji(surface, dict);
    assert.equal(res.found, true, `Expected ${surface} to be resolved`);
    assert.equal(
      res.readings[0].reading,
      expectedReading,
      `Expected ${surface} -> ${expectedReading}, got ${res.readings[0]?.reading}`
    );
    if (expectedBase) {
      assert.ok(res.readings[0].base, `Expected base metadata on ${surface}`);
      assert.equal(res.readings[0].base.surface, expectedBase);
      assert.deepEqual(res.readings[0].base.pitches, expectedBasePitches);
    }
  }
});

test('4b. Tied base verbs preserve all tied readings when deinflected', async () => {
  const dict = await getDict();

  const res = lookupKanji('開いた', dict);
  assert.equal(res.found, true);
  assert.equal(res.matchType, 'deinflected');
  assert.equal(res.isTied, true);
  const readings = res.readings.map((r) => r.reading).sort();
  assert.deepEqual(readings, ['あいた', 'ひらいた']);
});

test('5. Multi-word / compound phrase segmentation & punctuation stripping', async () => {
  const dict = await getDict();

  // Punctuation / quote stripping
  assert.equal(normalizeSelectionText('  「怪物」！？ '), '怪物');
  const quoted = lookupKanji('「怪物」', dict);
  assert.equal(quoted.found, true);
  assert.equal(quoted.matchType, 'exact');
  assert.equal(quoted.readings[0].reading, 'かいぶつ');
  assert.deepEqual(quoted.readings[0].pitches, [0]);

  // Phrase: 怪物の話 -> かいぶつのはなし
  const phrase1 = lookupKanji('怪物の話', dict);
  assert.equal(phrase1.found, true);
  assert.equal(phrase1.matchType, 'segmented');
  assert.equal(phrase1.readings[0].reading, 'かいぶつのはなし');
  assert.equal(phrase1.segments.length, 3);
  assert.equal(phrase1.segments[0].surface, '怪物');
  assert.deepEqual(phrase1.segments[0].candidates[0].pitches, [0]);
  assert.equal(phrase1.segments[1].surface, 'の');
  assert.equal(phrase1.segments[2].surface, '話');
  assert.deepEqual(phrase1.segments[2].candidates[0].pitches, [3]);

  // Compound noun: 東京駅 -> とうきょうえき
  const compound = lookupKanji('東京駅', dict);
  assert.equal(compound.found, true);
  assert.equal(compound.matchType, 'segmented');
  assert.equal(compound.readings[0].reading, 'とうきょうえき');
  assert.deepEqual(
    compound.segments.map((s) => s.surface),
    ['東京', '駅']
  );

  // Phrase with conjugated suru-verb: 日本語を勉強した -> にほんごをべんきょうした
  const sentence = lookupKanji('日本語を勉強した', dict);
  assert.equal(sentence.found, true);
  assert.equal(sentence.matchType, 'segmented');
  assert.equal(sentence.readings[0].reading, 'にほんごをべんきょうした');

  // Non-Kanji inputs are cleanly rejected
  assert.equal(containsKanji('ひらがなだけ'), false);
  const nonKanji = lookupKanji('ひらがなだけ', dict);
  assert.equal(nonKanji.found, false);
  assert.equal(nonKanji.hasKanji, false);
});

test('6. Verb frequency ranking, penalized headwords, and secondary deinflectOnly entries (振った, 居た, 居る)', async () => {
  const dict = await getDict();

  // Standalone iteration mark 々 is excluded from dictionary
  assert.equal(Object.hasOwn(dict, '々'), false);
  assert.equal(lookupKanji('々', dict).found, false);

  // Exact lookup of 居る filters out secondary deinflectOnly いる and returns only おる [1]
  const iruExact = lookupKanji('居る', dict);
  assert.equal(iruExact.found, true);
  assert.equal(iruExact.matchType, 'exact');
  assert.equal(iruExact.isTied, false);
  assert.equal(iruExact.readings.length, 1);
  assert.equal(iruExact.readings[0].reading, 'おる');
  assert.deepEqual(iruExact.readings[0].pitches, [1]);

  // Exact lookup of 来る filters out secondary きたる and returns only くる [1]
  const kuruExact = lookupKanji('来る', dict);
  assert.equal(kuruExact.found, true);
  assert.equal(kuruExact.isTied, false);
  assert.equal(kuruExact.readings.length, 1);
  assert.equal(kuruExact.readings[0].reading, 'くる');

  // Deinflection cases against real dict.json.gz
  const deinflectCases = [
    ['振った', 'ふった', '振る', [0]],
    ['居た', 'いた', '居る', [0]],
    ['居ない', 'いない', '居る', [0]],
    ['居ます', 'います', '居る', [0]],
    ['居った', 'おった', '居る', [1]],
    ['入った', 'はいった', '入る', [1]],
    ['切った', 'きった', '切る', [1]],
    ['着た', 'きた', '着る', [0]],
    ['来られる', 'こられる', '来る', [1]],
    ['貸出した', 'かしだした', '貸出す', [3]],
  ];

  for (const [surface, expectedReading, expectedBase, expectedPitches] of deinflectCases) {
    const res = lookupKanji(surface, dict);
    assert.equal(res.found, true, `Expected ${surface} to be resolved`);
    assert.equal(res.isTied, false, `Expected ${surface} to have a single top reading`);
    assert.equal(res.readings.length, 1, `Expected 1 reading for ${surface}`);
    assert.equal(res.readings[0].reading, expectedReading);
    assert.equal(res.readings[0].base?.surface, expectedBase);
    assert.deepEqual(res.readings[0].base?.pitches, expectedPitches);
  }

  // Distinct baseSurface entries that genuinely tie on (nonPenalized, chainLength, baseScore, codePointLength)
  // are ALL retained rather than filtered by baseSurface === bestBaseSurface
  const syntheticTieDict = {
    歩る: [['ある', [1], POS.V5R, 150]],
    歩う: [['あう', [0], POS.V5U, 150]],
  };
  const tiedDeinflect = deinflectWord('歩った', syntheticTieDict);
  assert.equal(tiedDeinflect.length, 2);
  assert.deepEqual(
    tiedDeinflect.map((m) => m.baseSurface).sort(),
    ['歩う', '歩る']
  );
});

test('7. Selected-form pitch clarity (pitchUnavailableReason === "inflected")', async () => {
  const dict = await getDict();

  const tabeta = lookupKanji('食べた', dict);
  assert.equal(tabeta.found, true);
  assert.equal(tabeta.matchType, 'deinflected');
  assert.deepEqual(tabeta.readings[0].pitches, []);
  assert.equal(tabeta.readings[0].pitchUnavailableReason, 'inflected');
  assert.equal(tabeta.readings[0].base?.surface, '食べる');
  assert.deepEqual(tabeta.readings[0].base?.pitches, [2]);
  assert.equal(tabeta.readings[0].base?.pitchContours.length, 1);

  // Exact pitchless inflected headword (来た) also receives base pitch + pitchUnavailableReason
  const kita = lookupKanji('来た', dict);
  assert.equal(kita.found, true);
  assert.equal(kita.readings[0].reading, 'きた');
  assert.equal(kita.readings[0].pitchUnavailableReason, 'inflected');
  assert.equal(kita.readings[0].base?.surface, '来る');
  assert.deepEqual(kita.readings[0].base?.pitches, [1]);

  // If dict[surface] explicitly records verified pitch for the conjugated form, preserve it
  const customDict = {
    食べた: [['たべた', [1], 0, 100, 1]], // deinflectOnly on exact so lookupKanji uses deinflected path unless checked
    食べる: [['たべる', [2], POS.V1, 192]],
  };
  const customDictVerified = {
    ...customDict,
    食べた: [['たべた', [1]]],
  };
  // Segment deinflection or direct lookup with verified pitch
  const directVerified = lookupKanji('食べた', customDictVerified);
  assert.deepEqual(directVerified.readings[0].pitches, [1]);
  assert.equal(directVerified.readings[0].pitchUnavailableReason, undefined);
});

test('8. Productive X々 iteration mark handling (町々, 人々, and phrase spans)', async () => {
  const dict = await getDict();

  // Productive X々 not directly in dict
  const machimachi = lookupKanji('町々', dict);
  assert.equal(machimachi.found, true);
  assert.equal(machimachi.readings[0].reading, 'まちまち');

  // Lexical rendaku X々 directly in dict
  const hitobito = lookupKanji('人々', dict);
  assert.equal(hitobito.found, true);
  assert.equal(hitobito.matchType, 'exact');
  assert.equal(hitobito.readings[0].reading, 'ひとびと');
  assert.deepEqual(hitobito.readings[0].pitches, [2]);

  // Productive X々 inside multi-word phrase segmentation
  const phrase = lookupKanji('町々の風景', dict);
  assert.equal(phrase.found, true);
  assert.equal(phrase.matchType, 'segmented');
  assert.equal(phrase.readings[0].reading, 'まちまちのふうけい');

  // Synthetic dict fallback when 村々 / 山々 are absent from dict
  const miniDict = {
    村: [['むら', [2]]],
    山: [['やま', [2]]],
  };
  assert.equal(lookupKanji('村々', miniDict).readings[0].reading, 'むらむら');
  assert.equal(lookupKanji('山々', miniDict).readings[0].reading, 'やまやま');
});

test('9. Japanese numeric + counter expressions (ヶ月 / か月 / ヶ所 / ヶ国 and phrase spans)', async () => {
  const dict = await getDict();

  const counterCases = [
    ['三か月', 'さんかげつ'],
    ['３ヶ月', 'さんかげつ'],
    ['1ヶ月', 'いっかげつ'],
    ['6か月', 'ろっかげつ'],
    ['６ヶ月', 'ろっかげつ'],
    ['8ヶ月', 'はっかげつ'],
    ['八ヶ月', 'はっかげつ'],
    ['10ヶ月', 'じゅっかげつ'],
    ['十ヶ月', 'じゅっかげつ'],
    ['11ヶ月', 'じゅういっかげつ'],
    ['12ヶ月', 'じゅうにかげつ'],
    ['20ヶ月', 'にじゅっかげつ'],
    ['24ヶ月', 'にじゅうよんかげつ'],
    ['幾ヶ月', 'いくかげつ'],
    ['数ヶ月', 'すうかげつ'],
    ['何ヶ月', 'なんかげつ'],
    ['三ヶ所', 'さんかしょ'],
    ['88ヶ所', 'はちじゅうはっかしょ'],
    ['三ヶ国', 'さんかこく'],
    ['８か国', 'はっかこく'],
    ['３ヶ月間', 'さんかげつかん'],
    ['あと3ヶ月', 'あとさんかげつ'],
  ];

  for (const [expr, expectedReading] of counterCases) {
    const res = lookupKanji(expr, dict);
    assert.equal(res.found, true, `Expected counter expression ${expr} to be resolved`);
    assert.equal(
      res.readings[0].reading,
      expectedReading,
      `Expected ${expr} -> ${expectedReading}, got ${res.readings[0]?.reading}`
    );
  }

  // Leading-zero digit runs must not split mid-digit into `0` + `1ヶ月` (`0いっかげつ`)
  const leadingZero = lookupKanji('01ヶ月', dict);
  assert.notEqual(leadingZero.readings[0]?.reading, '0いっかげつ');
});

test('10. Supplementary-plane Unicode Kanji detection & surrogate-safe phrase segmentation (𠮷, 𠮷野家, 𠮟った)', async () => {
  const dict = await getDict();

  assert.equal(containsKanji('𠮷'), true);
  assert.equal(containsKanji('𠮟'), true);

  const yoshinoya = lookupKanji('𠮷野家', dict);
  assert.equal(yoshinoya.found, true);
  assert.equal(yoshinoya.readings[0].reading, 'よしのや');

  const shikatta = lookupKanji('𠮟った', dict);
  assert.equal(shikatta.found, true);
  assert.equal(shikatta.readings[0].reading, 'しかった');
  assert.equal(shikatta.readings[0].base?.surface, '𠮟る');

  const yoshinoyaPhrase = lookupKanji('𠮷野家の牛丼', dict);
  assert.equal(yoshinoyaPhrase.found, true);
  assert.equal(yoshinoyaPhrase.matchType, 'segmented');
  assert.equal(yoshinoyaPhrase.readings[0].reading, 'よしのやのぎゅうどん');

  // Unknown supplementary Kanji inside a phrase must remain an intact code point (never split UTF-16 surrogates)
  const unknownSuppPhrase = lookupKanji('𠮷と東京', dict);
  assert.equal(unknownSuppPhrase.found, true);
  assert.equal(unknownSuppPhrase.matchType, 'segmented');
  assert.equal(unknownSuppPhrase.segments[0].surface, '𠮷');
  assert.equal(unknownSuppPhrase.readings[0].reading, '𠮷ととうきょう');
  for (const seg of unknownSuppPhrase.segments) {
    assert.doesNotMatch(
      seg.surface,
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      'Segment surface must never contain lone UTF-16 surrogates'
    );
  }
});

test('11. Tied phrase combinations preserve up to 32 combinations and flag tiesTruncated beyond 32', async () => {
  const dict = await getDict();

  // 2 * 2 * 2 = 8 tied combinations (> old cap of 6, <= 32)
  const eightCombo = lookupKanji('市場と一日と家', dict);
  assert.equal(eightCombo.found, true);
  assert.equal(eightCombo.matchType, 'segmented');
  assert.equal(eightCombo.isTied, true);
  assert.equal(eightCombo.readings.length, 8);
  assert.equal(eightCombo.tiesTruncated, false);

  // 2^6 = 64 tied combinations (> 32 -> truncated to 32 with tiesTruncated = true)
  const sixtyFourCombo = lookupKanji('市場の家と一日の金と風の市場', dict);
  assert.equal(sixtyFourCombo.found, true);
  assert.equal(sixtyFourCombo.matchType, 'segmented');
  assert.equal(sixtyFourCombo.isTied, true);
  assert.equal(sixtyFourCombo.readings.length, 32);
  assert.equal(sixtyFourCombo.tiesTruncated, true);
});
