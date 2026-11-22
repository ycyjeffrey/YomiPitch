import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { getAnnotator, normalizeForAnnotation, defaultFeedbackLearner } from '../src/shared/ai-engine.js';
import { lookupKanjiWithAI } from '../src/shared/lookup.js';
import { FeedbackLearner, validateUserReading, parseUserPitches } from '../src/shared/feedback-learner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let dict = null;
let pitchMap = null;
let singleKanji = null;
let annotator = null;
let resources = null;

function loadGzipJson(relPath) {
  const raw = fs.readFileSync(path.join(ROOT, relPath));
  return JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
}

before(async () => {
  dict = loadGzipJson('data/dict.json.gz');
  pitchMap = loadGzipJson('data/pitch_map.json.gz');
  singleKanji = loadGzipJson('data/single_kanji.json.gz');
  annotator = await getAnnotator();
  resources = { dict, pitchMap, singleKanji, annotator };
});

after(async () => {
  if (annotator && typeof annotator.dispose === 'function') {
    await annotator.dispose();
  }
});

test('Span-tracking pre-normalizer preserves exact [origStart, origEnd] <-> [normStart, normEnd] mappings', () => {
  const n1 = normalizeForAnnotation('１６年前の事件');
  assert.equal(n1.normText, '十六年前の事件');
  assert.deepEqual(n1.pieces[0], {
    origStart: 0,
    origEnd: 2,
    normStart: 0,
    normEnd: 2,
    origText: '１６',
    normText: '十六',
    converted: true,
  });

  const n2 = normalizeForAnnotation('3ヶ月前');
  assert.equal(n2.normText, '三箇月前');
  assert.equal(n2.pieces[0].origText, '3');
  assert.equal(n2.pieces[0].normText, '三');
  assert.equal(n2.pieces[1].origText, 'ヶ');
  assert.equal(n2.pieces[1].normText, '箇');

  // Multi-length numeral offset mapping (`300円` -> `三百円`, origEnd 3 <-> normEnd 2)
  const n3 = normalizeForAnnotation('300円');
  assert.equal(n3.normText, '三百円');
  assert.equal(n3.pieces[0].origStart, 0);
  assert.equal(n3.pieces[0].origEnd, 3);
  assert.equal(n3.pieces[0].normStart, 0);
  assert.equal(n3.pieces[0].normEnd, 2);
  assert.equal(n3.pieces[1].origStart, 3);
  assert.equal(n3.pieces[1].normStart, 2);

  // Place names with ヶ must NOT be normalized to 箇
  const place = normalizeForAnnotation('関ヶ原の戦い');
  assert.equal(place.normText, '関ヶ原の戦い');

  // Leading-zero codes and multi-dot versions stay untouched, while Japanese decimals convert cleanly
  const leadingZero = normalizeForAnnotation('01号室');
  assert.equal(leadingZero.normText, '01号室');
  const multiDot = normalizeForAnnotation('1.2.3版');
  assert.equal(multiDot.normText, '1.2.3版');
  const decimal = normalizeForAnnotation('3.5倍');
  assert.equal(decimal.normText, '三点五倍');
});

test('ONNX Neural AI resolves １６年前, Japanese counters, rendaku/sokuonbin, and calendar dates accurately', async () => {
  const expectedReadings = [
    ['１６年前', 'じゅうろくねんまえ'],
    ['16年前', 'じゅうろくねんまえ'],
    ['４年前', 'よねんまえ'],
    ['4年前', 'よねんまえ'],
    ['１人', 'ひとり'],
    ['1人', 'ひとり'],
    ['２人', 'ふたり'],
    ['2人', 'ふたり'],
    ['４人', 'よにん'],
    ['２０歳', 'はたち'],
    ['20歳', 'はたち'],
    ['３００円', 'さんびゃくえん'],
    ['300円', 'さんびゃくえん'],
    ['８００円', 'はっぴゃくえん'],
    ['１本', 'いっぽん'],
    ['３本', 'さんぼん'],
    ['６本', 'ろっぽん'],
    ['３階', 'さんがい'],
    ['３ヶ月前', 'さんかげつまえ'],
    ['3ヶ月前', 'さんかげつまえ'],
    ['8ヶ月', 'はっかげつ'],
    ['何ヶ月', 'なんかげつ'],
    ['4月1日', 'しがつついたち'],
    ['四月一日', 'しがつついたち'],
    ['5月1日', 'ごがつついたち'],
    ['五月一日', 'ごがつついたち'],
    ['20日', 'はつか'],
    ['二十日', 'はつか'],
    ['２０日', 'はつか'],
    ['14日', 'じゅうよっか'],
    ['一日中働いた', 'いちにちじゅうはたらいた'],
    ['関ヶ原', 'せきがはら'],
    ['関ヶ原の戦い', 'せきがはらのたたかい'],
  ];

  for (const [input, expected] of expectedReadings) {
    const res = await lookupKanjiWithAI(input, resources);
    assert.equal(res.found, true, `Expected ${input} to be found`);
    assert.notEqual(
      res.readings[0].reading,
      'じゅうろくとしぜん',
      `${input} must never produce literal character-by-character reading`
    );
    assert.equal(
      res.readings[0].reading,
      expected,
      `Expected "${input}" -> "${expected}", got "${res.readings[0].reading}"`
    );
  }
});

test('Context-disambiguated webpage highlighting resolves polyphones & sub-compound spans with Kanjium pitch accents', async () => {
  const contextCases = [
    {
      word: '人気',
      sentence: '人気がない夜道を歩く',
      expectedReading: 'ひとけ',
      expectedPitches: [0],
    },
    {
      word: '人気',
      sentence: '人気のある映画を見る',
      expectedReading: 'にんき',
      expectedPitches: [0],
    },
    {
      word: '市場',
      sentence: '市場で野菜を買う',
      expectedReading: 'いちば',
      expectedPitches: [1],
    },
    {
      word: '市場',
      sentence: '株式市場の動向',
      expectedReading: 'しじょう',
      expectedPitches: [0],
    },
    {
      word: '上手',
      sentence: '舞台の上手から登場する',
      expectedReading: 'かみて',
      expectedPitches: [0, 3],
    },
    {
      word: '上手',
      sentence: '歌が上手だ',
      expectedReading: 'じょうず',
      expectedPitches: [3],
    },
    {
      word: '大家',
      sentence: 'アパートの大家さんに払う',
      expectedReading: 'おおや',
      expectedPitches: [1],
    },
    {
      word: '大家',
      sentence: '日本画の大家として知られる',
      expectedReading: 'たいか',
      expectedPitches: [1],
    },
    {
      word: '一日',
      sentence: '一日中働いた',
      expectedReading: 'いちにち',
      expectedPitches: [4],
    },
  ];

  for (const { word, sentence, expectedReading, expectedPitches } of contextCases) {
    const start = sentence.indexOf(word);
    assert.ok(start >= 0, `"${word}" must appear in "${sentence}"`);
    const end = start + word.length;

    const res = await lookupKanjiWithAI(
      { text: word, contextText: sentence, contextStart: start, contextEnd: end },
      resources
    );

    assert.equal(res.found, true);
    assert.equal(res.matchType, 'ai-context');
    assert.equal(res.hasContext, true);
    assert.equal(res.aiPowered, true);
    assert.equal(
      res.readings[0].reading,
      expectedReading,
      `Expected "${word}" in "${sentence}" -> "${expectedReading}", got "${res.readings[0].reading}"`
    );
    assert.deepEqual(
      res.readings[0].pitches,
      expectedPitches,
      `Expected pitches for "${word}" (${expectedReading}) -> ${JSON.stringify(expectedPitches)}`
    );
    assert.equal(res.readings[0].pitchContours.length, expectedPitches.length);
  }
});

test('Single-Kanji behavior: shows all readings + Kun/On when isolated, and AI reading + Kun/On when in context', async () => {
  // 1. Standalone "年" (no context) -> all standalone readings + Kun + On
  const nenIsolated = await lookupKanjiWithAI('年', resources);
  assert.equal(nenIsolated.found, true);
  assert.equal(nenIsolated.matchType, 'single-kanji');
  assert.equal(nenIsolated.isSingleKanji, true);
  assert.equal(nenIsolated.hasContext, false);
  assert.ok(nenIsolated.readings.length >= 2, 'Standalone 年 must return multiple readings');

  const toshiEntry = nenIsolated.readings.find((r) => r.reading === 'とし');
  const nenEntry = nenIsolated.readings.find((r) => r.reading === 'ねん');
  assert.ok(toshiEntry, 'Standalone 年 must include とし');
  assert.deepEqual(toshiEntry.pitches, [2]);
  assert.ok(nenEntry, 'Standalone 年 must include ねん');
  assert.deepEqual(nenEntry.pitches, [1]);
  assert.ok(nenIsolated.kanjiDetails.kun.includes('とし'));
  assert.ok(nenIsolated.kanjiDetails.on.includes('ネン'));

  // 2. Standalone "生" (no context) -> multiple standalone readings + Kun + On
  const namaIsolated = await lookupKanjiWithAI('生', resources);
  assert.equal(namaIsolated.matchType, 'single-kanji');
  assert.equal(namaIsolated.isSingleKanji, true);
  assert.ok(namaIsolated.readings.length >= 3);
  assert.ok(namaIsolated.kanjiDetails.kun.length > 0);
  assert.ok(namaIsolated.kanjiDetails.on.includes('セイ'));
  assert.ok(namaIsolated.kanjiDetails.on.includes('ショウ'));

  // 3. Highlighted "生" inside "生ビールを飲む" -> top AI context reading is "なま" [1] + kanjiDetails
  const beerSentence = '生ビールを飲む';
  const namaInContext = await lookupKanjiWithAI(
    { text: '生', contextText: beerSentence, contextStart: 0, contextEnd: 1 },
    resources
  );
  assert.equal(namaInContext.matchType, 'ai-context');
  assert.equal(namaInContext.isSingleKanji, true);
  assert.equal(namaInContext.hasContext, true);
  assert.equal(namaInContext.readings[0].reading, 'なま');
  assert.deepEqual(namaInContext.readings[0].pitches, [1]);
  assert.ok(namaInContext.kanjiDetails.kun.length > 0);
  assert.ok(namaInContext.kanjiDetails.on.includes('セイ'));
  assert.ok(Array.isArray(namaInContext.kanjiDetails.allWords));

  // 4. Highlighted "年" inside "１６年前の事件" -> top AI context reading is "ねん" [1]
  const incidentSentence = '１６年前の事件';
  const nenIdx = incidentSentence.indexOf('年');
  const nenInContext = await lookupKanjiWithAI(
    { text: '年', contextText: incidentSentence, contextStart: nenIdx, contextEnd: nenIdx + 1 },
    resources
  );
  assert.equal(nenInContext.matchType, 'ai-context');
  assert.equal(nenInContext.isSingleKanji, true);
  assert.equal(nenInContext.readings[0].reading, 'ねん');

  // 5. Highlighted "前" inside "１６年前の事件" -> top AI context reading is "まえ" [1]
  const maeIdx = incidentSentence.indexOf('前');
  const maeInContext = await lookupKanjiWithAI(
    { text: '前', contextText: incidentSentence, contextStart: maeIdx, contextEnd: maeIdx + 1 },
    resources
  );
  assert.equal(maeInContext.matchType, 'ai-context');
  assert.equal(maeInContext.isSingleKanji, true);
  assert.equal(maeInContext.readings[0].reading, 'まえ');
});

test('Standalone headwords, equal-likelihood ties, compounds, and conjugated verbs work seamlessly in lookupKanjiWithAI', async () => {
  // Unambiguous headword
  const kaibutsu = await lookupKanjiWithAI('怪物', resources);
  assert.equal(kaibutsu.readings[0].reading, 'かいぶつ');
  assert.deepEqual(kaibutsu.readings[0].pitches, [0]);

  // Standalone equal-likelihood ties preserved when no context is given
  const shijouTie = await lookupKanjiWithAI('市場', resources);
  assert.equal(shijouTie.isTied, true);
  assert.deepEqual(
    shijouTie.readings.map((r) => r.reading),
    ['いちば', 'しじょう']
  );

  const ichinichiTie = await lookupKanjiWithAI('一日', resources);
  assert.equal(ichinichiTie.isTied, true);
  assert.deepEqual(
    ichinichiTie.readings.map((r) => r.reading),
    ['いちにち', 'ついたち']
  );

  // Conjugated verbs (including Godan, Ichidan, compound verb, and irregular 来る)
  const verbCases = [
    ['振った', 'ふった', '振る', [0]],
    ['居た', 'いた', '居る', [0]],
    ['貸出した', 'かしだした', '貸出す', [3]],
    ['食べた', 'たべた', '食べる', [2]],
    ['来られる', 'こられる', '来る', [1]],
  ];

  for (const [surface, expReading, expBase, expBasePitches] of verbCases) {
    const r = await lookupKanjiWithAI(surface, resources);
    assert.equal(r.found, true);
    assert.equal(r.readings[0].reading, expReading, `Expected ${surface} -> ${expReading}`);
    assert.equal(r.readings[0].base?.surface, expBase);
    assert.deepEqual(r.readings[0].base?.pitches, expBasePitches);
  }

  // Multi-segment phrase with per-segment pitches
  const phrase = await lookupKanjiWithAI('１６年前の事件', resources);
  assert.equal(phrase.readings[0].reading, 'じゅうろくねんまえのじけん');
  assert.ok(phrase.segments.length >= 3);
});

test('Edge cases: irregular jukujikun sub-spans, partial digit selections, durations, zero/decimals, 1日 tie, and Kun-only Kanji', async () => {
  // 1. Irregular jukujikun sub-spans must NOT invent standalone readings (`いま` / `だい`)
  const imaInKyou = await lookupKanjiWithAI(
    { text: '今', contextText: '今日の天気', contextStart: 0, contextEnd: 1 },
    resources
  );
  assert.equal(imaInKyou.found, true);
  assert.equal(imaInKyou.matchType, 'unalignable-context');
  assert.equal(imaInKyou.unalignable, true);
  assert.equal(imaInKyou.readings.length, 0);
  assert.equal(imaInKyou.enclosingCompound?.surface, '今日');
  assert.equal(imaInKyou.enclosingCompound?.reading, 'きょう');

  const daiInOtona = await lookupKanjiWithAI(
    { text: '大', contextText: '大人になった', contextStart: 0, contextEnd: 1 },
    resources
  );
  assert.equal(daiInOtona.found, true);
  assert.equal(daiInOtona.matchType, 'unalignable-context');
  assert.equal(daiInOtona.unalignable, true);
  assert.equal(daiInOtona.readings.length, 0);
  assert.equal(daiInOtona.enclosingCompound?.surface, '大人');
  assert.equal(daiInOtona.enclosingCompound?.reading, 'おとな');

  // 2. Partial selections inside multi-digit runs must NOT include unselected digits
  const partialSixYears = await lookupKanjiWithAI(
    { text: '6年', contextText: '16年前の事件', contextStart: 1, contextEnd: 3 },
    resources
  );
  assert.equal(partialSixYears.found, true);
  assert.equal(partialSixYears.readings[0].reading, 'ろくねん');

  const partial345Yen = await lookupKanjiWithAI(
    { text: '345円', contextText: '12345円の商品', contextStart: 2, contextEnd: 6 },
    resources
  );
  assert.equal(partial345Yen.found, true);
  assert.equal(partial345Yen.readings[0].reading, 'さんびゃくよんじゅうごえん');

  // 3. Duration expressions merged with verbs (`一日働く`, `20日間働いた`, `10日働く`)
  const oneDayWork = await lookupKanjiWithAI('一日働く', resources);
  assert.equal(oneDayWork.readings[0].reading, 'いちにちはたらく');

  const oneDayInWorkCtx = await lookupKanjiWithAI(
    { text: '一日', contextText: '一日働く', contextStart: 0, contextEnd: 2 },
    resources
  );
  assert.equal(oneDayInWorkCtx.readings[0].reading, 'いちにち');

  const twentyDaysWorked = await lookupKanjiWithAI('20日間働いた', resources);
  assert.equal(twentyDaysWorked.readings[0].reading, 'はつかかんはたらいた');

  const tenDaysWork = await lookupKanjiWithAI('10日働く', resources);
  assert.equal(tenDaysWork.readings[0].reading, 'とおかはたらく');

  // 4. Zero & decimals (`0年`, `1.5倍`, `0.5秒`, `3.14倍`)
  const zeroYear = await lookupKanjiWithAI('0年', resources);
  assert.equal(zeroYear.readings[0].reading, 'ぜろねん');

  const onePointFive = await lookupKanjiWithAI('1.5倍', resources);
  assert.equal(onePointFive.readings[0].reading, 'いってんごばい');

  const zeroPointFive = await lookupKanjiWithAI('0.5秒', resources);
  assert.equal(zeroPointFive.readings[0].reading, 'ぜろてんごびょう');

  const piTimes = await lookupKanjiWithAI('3.14倍', resources);
  assert.equal(piTimes.readings[0].reading, 'さんてんいちよんばい');

  // 5. Isolated `1日` preserves both duration (`いちにち`) and calendar (`ついたち`) equal-likelihood ties
  const numericOneDayTie = await lookupKanjiWithAI('1日', resources);
  assert.equal(numericOneDayTie.isTied, true);
  assert.deepEqual(
    numericOneDayTie.readings.map((r) => r.reading),
    ['いちにち', 'ついたち']
  );

  // 6. Kun-only single Kanji (`喰`) retains Kun readings cleanly
  const kuuKanji = await lookupKanjiWithAI('喰', resources);
  assert.equal(kuuKanji.found, true);
  assert.equal(kuuKanji.matchType, 'single-kanji');
  assert.ok(kuuKanji.kanjiDetails.kun.length > 0);

  // 7. Sub-compound pitch accent scope is labeled `'standalone'`
  const subCompoundMarket = await lookupKanjiWithAI(
    { text: '市場', contextText: '株式市場の動向', contextStart: 2, contextEnd: 4 },
    resources
  );
  assert.equal(subCompoundMarket.readings[0].reading, 'しじょう');
  assert.equal(subCompoundMarket.readings[0].pitchScope, 'standalone');
});

test('Continual-learning user feedback: learns 月王子 -> つきおうじ, generalizes to unseen compounds, disambiguates contextual polyphones, handles ateji & verbs, and cleanly undoes', async () => {
  await defaultFeedbackLearner.clearAll();
  try {
    // 1. Validate reading & pitch sanitizers
    assert.deepEqual(validateUserReading('ツキオウジ'), { ok: true, reading: 'つきおうじ' });
    assert.equal(validateUserReading('月王子').ok, false);
    assert.match(validateUserReading('tsukiouji').error, /hiragana or katakana/i);
    assert.deepEqual(parseUserPitches('3, 0'), { ok: true, pitches: [3, 0] });
    assert.equal(parseUserPitches('abc').ok, false);

    // 2. User's exact scenario: if model predicts げつおうじ for 月王子, teach it つきおうじ [3]
    await defaultFeedbackLearner.recordFeedback({
      surface: '月王子',
      normSurface: '月王子',
      reading: 'げつおうじ',
      dict,
    });
    assert.equal((await lookupKanjiWithAI('月王子', resources)).readings[0].reading, 'げつおうじ');

    const princeEntry = await defaultFeedbackLearner.recordFeedback({
      surface: '月王子',
      normSurface: '月王子',
      reading: 'つきおうじ',
      pitches: '3',
      previousReading: 'げつおうじ',
      dict,
    });
    const princeRes = await lookupKanjiWithAI('月王子', resources);
    assert.equal(princeRes.found, true);
    assert.equal(princeRes.learnedFromFeedback, true);
    assert.equal(princeRes.feedbackEntryId, princeEntry.id);
    assert.equal(princeRes.readings[0].reading, 'つきおうじ');
    assert.deepEqual(princeRes.readings[0].pitches, [3]);
    assert.equal(princeRes.readings[0].pitchContours.length, 1);

    // Learned word also works inside full sentences and with honorific suffixes (`月王子様`)
    const princeInSentence = await lookupKanjiWithAI(
      { text: '月王子', contextText: '月王子の剣が光った', contextStart: 0, contextEnd: 3 },
      resources
    );
    assert.equal(princeInSentence.readings[0].reading, 'つきおうじ');
    assert.deepEqual(princeInSentence.readings[0].pitches, [3]);

    const princeHonorific = await lookupKanjiWithAI('月王子様', resources);
    assert.equal(princeHonorific.readings[0].reading, 'つきおうじさま');

    // 3. True neural generalization: before a 2nd example, unseen 月剣士 stays conservative (げっけんし);
    //    after teaching 月騎士 -> つききし, unseen 月剣士 generalizes to つきけんし while attested words stay safe!
    assert.equal((await lookupKanjiWithAI('月剣士', resources)).readings[0].reading, 'げっけんし');

    await defaultFeedbackLearner.recordFeedback({
      surface: '月騎士',
      normSurface: '月騎士',
      reading: 'つききし',
      dict,
    });
    assert.equal((await lookupKanjiWithAI('月騎士', resources)).readings[0].reading, 'つききし');
    assert.equal((await lookupKanjiWithAI('月剣士', resources)).readings[0].reading, 'つきけんし');

    // High-certainty attested words MUST remain untouched
    assert.equal(
      (
        await lookupKanjiWithAI(
          { text: '月曜日', contextText: '月曜日の朝', contextStart: 0, contextEnd: 3 },
          resources
        )
      ).readings[0].reading,
      'げつようび'
    );
    assert.equal((await lookupKanjiWithAI('月光', resources)).readings[0].reading, 'げっこう');
    assert.equal((await lookupKanjiWithAI('一月', resources)).readings[0].reading, 'いちがつ');

    // 4. Contextual polyphone learning: teaching 人気 -> ひとけ in 人気のない森 generalizes to
    //    unseen 人気のない道 -> ひとけ without clobbering 人気のある店 (にんき) or standalone 人気 (にんき)
    await defaultFeedbackLearner.recordFeedback({
      surface: '人気',
      normSurface: '人気',
      reading: 'ひとけ',
      contextText: '人気のない森を歩く',
      contextStart: 0,
      contextEnd: 2,
      dict,
    });
    const hitokeUnseen = await lookupKanjiWithAI(
      { text: '人気', contextText: '人気のない道を歩く', contextStart: 0, contextEnd: 2 },
      resources
    );
    assert.equal(hitokeUnseen.readings[0].reading, 'ひとけ');

    const ninkiShop = await lookupKanjiWithAI(
      { text: '人気', contextText: '人気のある店に行く', contextStart: 0, contextEnd: 2 },
      resources
    );
    assert.equal(ninkiShop.readings[0].reading, 'にんき');
    assert.equal((await lookupKanjiWithAI('人気', resources)).readings[0].reading, 'にんき');

    // 5. Irregular ateji / gikun (`聖剣` -> `エクスカリバー`) and conjugated stem (`喰らった` -> `くらった` -> `喰らう`)
    await defaultFeedbackLearner.recordFeedback({
      surface: '聖剣',
      normSurface: '聖剣',
      reading: 'エクスカリバー',
      dict,
    });
    assert.equal(
      (await lookupKanjiWithAI('聖剣を抜いた', resources)).readings[0].reading,
      'えくすかりばーをぬいた'
    );

    await defaultFeedbackLearner.recordFeedback({
      surface: '喰らった',
      normSurface: '喰らった',
      reading: 'くらった',
      dict,
    });
    assert.equal((await lookupKanjiWithAI('喰らった', resources)).readings[0].reading, 'くらった');
    assert.equal((await lookupKanjiWithAI('喰らう', resources)).readings[0].reading, 'くらう');

    // 6. Serialization round-trip (`toJSON` -> fresh `FeedbackLearner.loadState`) + empty-state weight reset
    const snapshot = defaultFeedbackLearner.toJSON();
    assert.ok(snapshot.entries.length >= 5);
    const clone = new FeedbackLearner();
    await clone.loadState(snapshot);
    assert.equal(clone.listEntries().length, snapshot.entries.length);
    assert.ok(Object.keys(clone.weights).length > 0);
    await clone.loadState({ version: 1, entries: [], weights: {} });
    assert.equal(Object.keys(clone.weights).length, 0, 'Empty-state reload must clear residual weights');

    // 6b. Mora-bounded pitch validation, bracketed surface lookup, contradictory contextual polyphone, & numeric/counter feedback
    await assert.rejects(
      () =>
        defaultFeedbackLearner.recordFeedback({
          surface: '猫',
          reading: 'ねこ',
          pitches: '3',
          dict,
        }),
      /2 morae.*between 0 and 2/i
    );

    await defaultFeedbackLearner.recordFeedback({
      surface: '「月皇子」',
      normSurface: '月皇子',
      reading: 'つきおうじ',
      pitches: '3',
      dict,
    });
    const bracketCleaned = await lookupKanjiWithAI('月皇子', resources);
    assert.equal(bracketCleaned.readings[0].reading, 'つきおうじ');
    assert.deepEqual(bracketCleaned.readings[0].pitches, [3]);

    // Teaching 人気 -> ひとけ in `店の人気がない` must NOT misfire on `店の人気がある` just because both share `の` before `人気`!
    await defaultFeedbackLearner.recordFeedback({
      surface: '人気',
      normSurface: '人気',
      reading: 'ひとけ',
      contextText: '店の人気がない夜',
      contextStart: 2,
      contextEnd: 4,
      dict,
    });
    assert.equal(
      (
        await lookupKanjiWithAI(
          { text: '人気', contextText: '店の人気がある昼', contextStart: 2, contextEnd: 4 },
          resources
        )
      ).readings[0].reading,
      'にんき'
    );

    // Numeric / `ヶ` counter feedback (`3ヶ月` -> `みつき` custom override) normalizes cleanly across `normalizeForAnnotation`
    await defaultFeedbackLearner.recordFeedback({
      surface: '3ヶ月',
      normSurface: '3ヶ月',
      reading: 'みつき',
      contextText: '3ヶ月待った',
      contextStart: 0,
      contextEnd: 3,
      dict,
    });
    const threeMonthsCustom = await lookupKanjiWithAI(
      { text: '3ヶ月', contextText: '3ヶ月待った', contextStart: 0, contextEnd: 3 },
      resources
    );
    assert.equal(threeMonthsCustom.readings[0].reading, 'みつき');

    // 7. Individual undo (`removeFeedback`) + `clearAll` restores base predictions cleanly
    const removed = await defaultFeedbackLearner.removeFeedback(princeEntry.id);
    assert.equal(removed, true);
    await defaultFeedbackLearner.clearAll();
    assert.equal(defaultFeedbackLearner.listEntries().length, 0);
    assert.equal((await lookupKanjiWithAI('月騎士', resources)).readings[0].reading, 'げっきし');
    assert.equal((await lookupKanjiWithAI('月剣士', resources)).readings[0].reading, 'げっけんし');
    assert.equal((await lookupKanjiWithAI('3ヶ月', resources)).readings[0].reading, 'さんかげつ');
  } finally {
    await defaultFeedbackLearner.clearAll();
  }
});

