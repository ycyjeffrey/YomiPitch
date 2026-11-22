/**
 * Rule-based Japanese verb, i-adjective, and suru-verb deinflector
 * with full conjugated reading reconstruction.
 *
 * Bitmask flags match scripts/build_dict.py exactly.
 */

export const POS = Object.freeze({
  V1: 1 << 0,      // 1: Ichidan verb (ends in る)
  V5U: 1 << 1,     // 2: Godan う verb (incl. 問う/請う v5u-s)
  V5K: 1 << 2,     // 4: Godan く verb
  V5K_S: 1 << 3,   // 8: Godan く irregular (行く/ゆく -> 行った/行って)
  V5G: 1 << 4,     // 16: Godan ぐ verb
  V5S: 1 << 5,     // 32: Godan す verb
  V5T: 1 << 6,     // 64: Godan つ verb
  V5N: 1 << 7,     // 128: Godan ぬ verb
  V5B: 1 << 8,     // 256: Godan ぶ verb
  V5M: 1 << 9,     // 512: Godan む verb
  V5R: 1 << 10,    // 1024: Godan る verb (incl. 有る/下さる/仰る)
  VK: 1 << 11,     // 2048: 来る irregular verb
  VS: 1 << 12,     // 4096: する-noun / する-verb
  ADJ_I: 1 << 13,  // 8192: い-adjective (incl. 良い/いい)
});

// Virtual intermediate grammatical states for chained auxiliaries (bits >= 16)
const V_V1 = 1 << 16;
const V_V5U = 1 << 17;
const V_V5K = 1 << 18;
const V_V5K_S = 1 << 19;
const V_V5R = 1 << 20;
const V_VK = 1 << 21;
const V_VS_SURU = 1 << 22;
const V_ADJ_I = 1 << 23;
const V_TE = 1 << 24;
const TOP_ONLY = 0;
const ALL_OUTER =
  V_V1 | V_V5U | V_V5K | V_V5K_S | V_V5R | V_VK | V_VS_SURU | V_ADJ_I | V_TE;

const LEXICAL_MASK = (1 << 14) - 1;
const YOI_SURFACE_RE = /([良よいイイ好善佳吉宜]い|イイ)$/;
const KANA_KURU_RE = /[来來]る$/;
const SURU_KANJI_RE = /為る$/;

/**
 * @typedef {Object} DeinflectRule
 * @property {string} from - Suffix stripped from the inflected string
 * @property {string} to - Suffix appended to form the inner candidate string
 * @property {number} accepts - Bitmask of lexical POS or virtual states accepted on the inner form
 * @property {number} produces - Virtual state bit this form represents to outer rules (0 = top-level only)
 * @property {string} readFrom - Suffix stripped from inner reading when reconstructing forward reading
 * @property {string} readTo - Suffix appended to inner reading when reconstructing forward reading
 * @property {string} label - Concise grammatical description
 * @property {RegExp} [guard] - Optional regex guard tested against the inner candidate surface
 */

/** @type {DeinflectRule[]} */
const RULES = [];

function addRule(from, to, accepts, produces, label, opts = {}) {
  RULES.push({
    from,
    to,
    accepts,
    produces,
    readFrom: opts.readFrom ?? to,
    readTo: opts.readTo ?? from,
    label,
    guard: opts.guard ?? null,
  });
}

// ---------------------------------------------------------------------------
// 1. Ichidan (v1) & Virtual V1 rules
// ---------------------------------------------------------------------------
const ANY_V1 = POS.V1 | V_V1;
addRule('た', 'る', ANY_V1, TOP_ONLY, 'past');
addRule('て', 'る', ANY_V1, V_TE, 'te-form');
addRule('たら', 'る', ANY_V1, TOP_ONLY, 'conditional');
addRule('たり', 'る', ANY_V1, TOP_ONLY, 'tari-form');
addRule('ちゃう', 'る', ANY_V1, V_V5U, 'colloquial completion');
addRule('とく', 'る', ANY_V1, V_V5K, 'colloquial preparation');
addRule('ない', 'る', ANY_V1, V_ADJ_I, 'negative');
addRule('ぬ', 'る', ANY_V1, TOP_ONLY, 'negative');
addRule('ず', 'る', ANY_V1, TOP_ONLY, 'negative');
addRule('ずに', 'る', ANY_V1, TOP_ONLY, 'without doing');
addRule('ます', 'る', ANY_V1, TOP_ONLY, 'polite');
addRule('ました', 'る', ANY_V1, TOP_ONLY, 'polite past');
addRule('ません', 'る', ANY_V1, TOP_ONLY, 'polite negative');
addRule('ませんでした', 'る', ANY_V1, TOP_ONLY, 'polite past negative');
addRule('ましょう', 'る', ANY_V1, TOP_ONLY, 'polite volitional');
addRule('まして', 'る', ANY_V1, TOP_ONLY, 'polite te-form');
addRule('なさい', 'る', ANY_V1, TOP_ONLY, 'polite imperative');
addRule('たい', 'る', ANY_V1, V_ADJ_I, 'desiderative');
addRule('たがる', 'る', ANY_V1, V_V5R, 'desiderative');
addRule('やすい', 'る', ANY_V1, V_ADJ_I, 'easy to');
addRule('にくい', 'る', ANY_V1, V_ADJ_I, 'hard to');
addRule('づらい', 'る', ANY_V1, V_ADJ_I, 'hard to');
addRule('すぎる', 'る', ANY_V1, V_V1, 'excessive');
addRule('過ぎる', 'る', ANY_V1, V_V1, 'excessive', { readTo: 'すぎる' });
addRule('ながら', 'る', ANY_V1, TOP_ONLY, 'while');
addRule('そう', 'る', ANY_V1, TOP_ONLY, 'seeming');
addRule('られる', 'る', ANY_V1, V_V1, 'passive/potential');
addRule('れる', 'る', ANY_V1, V_V1, 'colloquial potential');
addRule('させる', 'る', ANY_V1, V_V1, 'causative');
addRule('させられる', 'る', ANY_V1, V_V1, 'causative-passive');
addRule('よう', 'る', ANY_V1, TOP_ONLY, 'volitional');
addRule('れば', 'る', ANY_V1, TOP_ONLY, 'conditional');
addRule('ろ', 'る', ANY_V1, TOP_ONLY, 'imperative');
addRule('よ', 'る', POS.V1, TOP_ONLY, 'imperative');

// ---------------------------------------------------------------------------
// 2. Godan (v5) stem families
// ---------------------------------------------------------------------------
const GODAN_ROWS = [
  { u: 'う', i: 'い', a: 'わ', e: 'え', o: 'お', mask: POS.V5U | V_V5U },
  { u: 'く', i: 'き', a: 'か', e: 'け', o: 'こ', mask: POS.V5K | POS.V5K_S | V_V5K | V_V5K_S },
  { u: 'ぐ', i: 'ぎ', a: 'が', e: 'げ', o: 'ご', mask: POS.V5G },
  { u: 'す', i: 'し', a: 'さ', e: 'せ', o: 'そ', mask: POS.V5S },
  { u: 'つ', i: 'ち', a: 'た', e: 'て', o: 'と', mask: POS.V5T },
  { u: 'ぬ', i: 'に', a: 'な', e: 'ね', o: 'の', mask: POS.V5N },
  { u: 'ぶ', i: 'び', a: 'ば', e: 'べ', o: 'ぼ', mask: POS.V5B },
  { u: 'む', i: 'み', a: 'ま', e: 'め', o: 'も', mask: POS.V5M },
  { u: 'る', i: 'り', a: 'ら', e: 'れ', o: 'ろ', mask: POS.V5R | V_V5R },
];

for (const row of GODAN_ROWS) {
  const { u, i, a, e, o, mask } = row;

  // Ren'youkei (i-stem)
  addRule(`${i}ます`, u, mask, TOP_ONLY, 'polite');
  addRule(`${i}ました`, u, mask, TOP_ONLY, 'polite past');
  addRule(`${i}ません`, u, mask, TOP_ONLY, 'polite negative');
  addRule(`${i}ませんでした`, u, mask, TOP_ONLY, 'polite past negative');
  addRule(`${i}ましょう`, u, mask, TOP_ONLY, 'polite volitional');
  addRule(`${i}まして`, u, mask, TOP_ONLY, 'polite te-form');
  addRule(`${i}なさい`, u, mask, TOP_ONLY, 'polite imperative');
  addRule(`${i}たい`, u, mask, V_ADJ_I, 'desiderative');
  addRule(`${i}たがる`, u, mask, V_V5R, 'desiderative');
  addRule(`${i}やすい`, u, mask, V_ADJ_I, 'easy to');
  addRule(`${i}にくい`, u, mask, V_ADJ_I, 'hard to');
  addRule(`${i}づらい`, u, mask, V_ADJ_I, 'hard to');
  addRule(`${i}すぎる`, u, mask, V_V1, 'excessive');
  addRule(`${i}過ぎる`, u, mask, V_V1, 'excessive', { readTo: `${i}すぎる` });
  addRule(`${i}ながら`, u, mask, TOP_ONLY, 'while');
  addRule(`${i}そう`, u, mask, TOP_ONLY, 'seeming');

  // Mizenkei (a-stem)
  addRule(`${a}ない`, u, mask, V_ADJ_I, 'negative');
  addRule(`${a}ぬ`, u, mask, TOP_ONLY, 'negative');
  addRule(`${a}ん`, u, mask, TOP_ONLY, 'colloquial negative');
  addRule(`${a}ず`, u, mask, TOP_ONLY, 'negative');
  addRule(`${a}ずに`, u, mask, TOP_ONLY, 'without doing');
  addRule(`${a}れる`, u, mask, V_V1, 'passive');
  addRule(`${a}せる`, u, mask, V_V1, 'causative');
  addRule(`${a}せられる`, u, mask, V_V1, 'causative-passive');
  if (u !== 'す') {
    addRule(`${a}される`, u, mask, V_V1, 'causative-passive');
  }

  // E-stem (potential, conditional, imperative)
  addRule(`${e}る`, u, mask, V_V1, 'potential');
  addRule(`${e}ば`, u, mask, TOP_ONLY, 'conditional');
  addRule(e, u, mask, TOP_ONLY, 'imperative');

  // O-stem (volitional)
  addRule(`${o}う`, u, mask, TOP_ONLY, 'volitional');
}

// Godan onbin (te / ta / tara / tari / chau / toku)
// Note: V5K_S (行く -> いった) is placed first so 行った resolves to 行く (いった) over 行う/行る.
const ONBIN_GROUPS = [
  { prefix: 'っ', t: 'た', te: 'て', u: 'く', mask: POS.V5K_S | V_V5K_S },
  // Sokuonbin (っ): v5u, v5t, v5r
  { prefix: 'っ', t: 'た', te: 'て', u: 'う', mask: POS.V5U | V_V5U },
  { prefix: 'っ', t: 'た', te: 'て', u: 'つ', mask: POS.V5T },
  { prefix: 'っ', t: 'た', te: 'て', u: 'る', mask: POS.V5R | V_V5R },
  // U-onbin (問うた / 請うた / 乞うた)
  { prefix: 'う', t: 'た', te: 'て', u: 'う', mask: POS.V5U },
  // I-onbin: v5k (いた/いて) and v5g (いだ/いで)
  { prefix: 'い', t: 'た', te: 'て', u: 'く', mask: POS.V5K | V_V5K },
  { prefix: 'い', t: 'だ', te: 'で', u: 'ぐ', mask: POS.V5G },
  // Shi-stem: v5s (した/して)
  { prefix: 'し', t: 'た', te: 'て', u: 'す', mask: POS.V5S },
  // Hatsuonbin (ん): v5n, v5b, v5m
  { prefix: 'ん', t: 'だ', te: 'で', u: 'ぬ', mask: POS.V5N },
  { prefix: 'ん', t: 'だ', te: 'で', u: 'ぶ', mask: POS.V5B },
  { prefix: 'ん', t: 'だ', te: 'で', u: 'む', mask: POS.V5M },
];

for (const g of ONBIN_GROUPS) {
  const voiced = g.te === 'で';
  addRule(`${g.prefix}${g.t}`, g.u, g.mask, TOP_ONLY, 'past');
  addRule(`${g.prefix}${g.te}`, g.u, g.mask, V_TE, 'te-form');
  addRule(`${g.prefix}${g.t}ら`, g.u, g.mask, TOP_ONLY, 'conditional');
  addRule(`${g.prefix}${g.t}り`, g.u, g.mask, TOP_ONLY, 'tari-form');
  addRule(`${g.prefix}${voiced ? 'じゃう' : 'ちゃう'}`, g.u, g.mask, V_V5U, 'colloquial completion');
  addRule(`${g.prefix}${voiced ? 'どく' : 'とく'}`, g.u, g.mask, V_V5K, 'colloquial preparation');
}

// Honorific v5r irregular polite forms (下さる -> 下さいます / 下さい, 仰る -> 仰います)
addRule('います', 'る', POS.V5R, TOP_ONLY, 'polite', { guard: /(下さ|仰|いらっしゃ)る$/ });
addRule('いました', 'る', POS.V5R, TOP_ONLY, 'polite past', { guard: /(下さ|仰|いらっしゃ)る$/ });
addRule('いません', 'る', POS.V5R, TOP_ONLY, 'polite negative', { guard: /(下さ|仰|いらっしゃ)る$/ });
addRule('い', 'る', POS.V5R, TOP_ONLY, 'imperative', { guard: /(下さ|仰|いらっしゃ)る$/ });

// ---------------------------------------------------------------------------
// 3. Kuru (vk: 来る / 持ってくる)
// ---------------------------------------------------------------------------
const VK_INFLECTIONS = [
  ['た', 'きた', TOP_ONLY, 'past'],
  ['て', 'きて', V_TE, 'te-form'],
  ['たら', 'きたら', TOP_ONLY, 'conditional'],
  ['たり', 'きたり', TOP_ONLY, 'tari-form'],
  ['ちゃう', 'きちゃう', V_V5U, 'colloquial completion'],
  ['ます', 'きます', TOP_ONLY, 'polite'],
  ['ました', 'きました', TOP_ONLY, 'polite past'],
  ['ません', 'きません', TOP_ONLY, 'polite negative'],
  ['ませんでした', 'きませんでした', TOP_ONLY, 'polite past negative'],
  ['ましょう', 'きましょう', TOP_ONLY, 'polite volitional'],
  ['たい', 'きたい', V_ADJ_I, 'desiderative'],
  ['やすい', 'きやすい', V_ADJ_I, 'easy to'],
  ['にくい', 'きにくい', V_ADJ_I, 'hard to'],
  ['すぎる', 'きすぎる', V_V1, 'excessive'],
  ['ながら', 'きながら', TOP_ONLY, 'while'],
  ['なさい', 'きなさい', TOP_ONLY, 'polite imperative'],
  ['ない', 'こない', V_ADJ_I, 'negative'],
  ['ぬ', 'こぬ', TOP_ONLY, 'negative'],
  ['ず', 'こず', TOP_ONLY, 'negative'],
  ['ずに', 'こずに', TOP_ONLY, 'without doing'],
  ['よう', 'こよう', TOP_ONLY, 'volitional'],
  ['られる', 'こられる', V_V1, 'passive/potential'],
  ['れる', 'これる', V_V1, 'colloquial potential'],
  ['させる', 'こさせる', V_V1, 'causative'],
  ['させられる', 'こさせられる', V_V1, 'causative-passive'],
  ['れば', 'くれば', TOP_ONLY, 'conditional'],
  ['い', 'こい', TOP_ONLY, 'imperative'],
];

for (const [kanjiSuffix, kanaReading, prod, label] of VK_INFLECTIONS) {
  // Kanji stem: 来た -> 来る (reading: くる -> きた)
  addRule(kanjiSuffix, 'る', POS.VK | V_VK, prod, label, {
    guard: KANA_KURU_RE,
    readFrom: 'くる',
    readTo: kanaReading,
  });
  // Kana stem: 持ってきた -> 持ってくる (reading: くる -> きた)
  addRule(kanaReading, 'くる', POS.VK | V_VK, prod, label, {
    readFrom: 'くる',
    readTo: kanaReading,
  });
}

// ---------------------------------------------------------------------------
// 4. Suru (vs: 勉強する / 愛する / 為る)
// ---------------------------------------------------------------------------
// Plain する itself (e.g. 勉強する -> 勉強)
addRule('する', 'する', V_VS_SURU, TOP_ONLY, 'suru-verb', {
  readFrom: 'する',
  readTo: 'する',
});

const SURU_INFLECTIONS = [
  ['した', 'た', TOP_ONLY, 'past'],
  ['して', 'て', V_TE, 'te-form'],
  ['したら', 'たら', TOP_ONLY, 'conditional'],
  ['したり', 'たり', TOP_ONLY, 'tari-form'],
  ['しちゃう', 'ちゃう', V_V5U, 'colloquial completion'],
  ['しとく', 'とく', V_V5K, 'colloquial preparation'],
  ['します', 'ます', TOP_ONLY, 'polite'],
  ['しました', 'ました', TOP_ONLY, 'polite past'],
  ['しません', 'ません', TOP_ONLY, 'polite negative'],
  ['しませんでした', 'ませんでした', TOP_ONLY, 'polite past negative'],
  ['しましょう', 'ましょう', TOP_ONLY, 'polite volitional'],
  ['しなさい', 'なさい', TOP_ONLY, 'polite imperative'],
  ['したい', 'たい', V_ADJ_I, 'desiderative'],
  ['しやすい', 'やすい', V_ADJ_I, 'easy to'],
  ['しにくい', 'にくい', V_ADJ_I, 'hard to'],
  ['しすぎる', 'すぎる', V_V1, 'excessive'],
  ['し過ぎる', '過ぎる', V_V1, 'excessive'],
  ['しながら', 'ながら', TOP_ONLY, 'while'],
  ['しない', 'ない', V_ADJ_I, 'negative'],
  ['せず', 'ず', TOP_ONLY, 'negative'],
  ['せずに', 'ずに', TOP_ONLY, 'without doing'],
  ['せぬ', 'ぬ', TOP_ONLY, 'negative'],
  ['しよう', 'よう', TOP_ONLY, 'volitional'],
  ['すれば', 'れば', TOP_ONLY, 'conditional'],
  ['しろ', 'ろ', TOP_ONLY, 'imperative'],
  ['せよ', 'よ', TOP_ONLY, 'imperative'],
  ['される', 'れる', V_V1, 'passive'],
  ['させる', 'せる', V_V1, 'causative'],
  ['させられる', 'せられる', V_V1, 'causative-passive'],
  ['できる', null, V_V1, 'potential'],
  ['出来る', null, V_V1, 'potential'],
];

for (const [kanaForm, kanjiTameSuffix, prod, label] of SURU_INFLECTIONS) {
  const normalizedRead = kanaForm === '出来る' ? 'できる' : kanaForm === 'し過ぎる' ? 'しすぎる' : kanaForm;
  addRule(kanaForm, 'する', V_VS_SURU, prod, label, {
    readFrom: 'する',
    readTo: normalizedRead,
  });
  if (kanjiTameSuffix) {
    addRule(kanjiTameSuffix, 'る', POS.VS, prod, label, {
      guard: SURU_KANJI_RE,
      readFrom: 'する',
      readTo: normalizedRead,
    });
  }
}

// ---------------------------------------------------------------------------
// 5. TE_FORM chained auxiliaries (〜ている, 〜てしまう, 〜ておく, 〜てみる, etc.)
// ---------------------------------------------------------------------------
addRule('いる', '', V_TE, V_V1, 'progressive');
addRule('る', '', V_TE, V_V1, 'colloquial progressive');
addRule('ある', '', V_TE, V_V5R, 'resultative');
addRule('おく', '', V_TE, V_V5K, 'preparatory');
addRule('みる', '', V_TE, V_V1, 'try doing');
addRule('しまう', '', V_TE, V_V5U, 'completion');
addRule('くる', '', V_TE, V_VK, 'directional');
addRule('来る', '', V_TE, V_VK, 'directional', { readTo: 'くる' });
addRule('いく', '', V_TE, V_V5K_S, 'directional');
addRule('行く', '', V_TE, V_V5K_S, 'directional', { readTo: 'いく' });
addRule('あげる', '', V_TE, V_V1, 'benefactive');
addRule('くれる', '', V_TE, V_V1, 'benefactive');
addRule('もらう', '', V_TE, V_V5U, 'benefactive');
addRule('ほしい', '', V_TE, V_ADJ_I, 'desiderative');
addRule('ください', '', V_TE, TOP_ONLY, 'polite request');
addRule('下さい', '', V_TE, TOP_ONLY, 'polite request', { readTo: 'ください' });
addRule('もいい', '', V_TE, TOP_ONLY, 'permission');
addRule('も良い', '', V_TE, TOP_ONLY, 'permission', { readTo: 'もいい' });
addRule('はいけない', '', V_TE, TOP_ONLY, 'prohibition');

// ---------------------------------------------------------------------------
// 6. i-Adjectives (adj_i) & Virtual ADJ_I (〜ない, 〜たい, etc.)
// ---------------------------------------------------------------------------
const ANY_ADJ = POS.ADJ_I | V_ADJ_I;
const ADJ_INFLECTIONS = [
  ['かった', TOP_ONLY, 'past'],
  ['かったです', TOP_ONLY, 'polite past'],
  ['くない', V_ADJ_I, 'negative'],
  ['くないです', TOP_ONLY, 'polite negative'],
  ['くありません', TOP_ONLY, 'polite negative'],
  ['くありませんでした', TOP_ONLY, 'polite past negative'],
  ['くて', TOP_ONLY, 'te-form'],
  ['くても', TOP_ONLY, 'concessive'],
  ['くは', TOP_ONLY, 'topic adverbial'],
  ['くも', TOP_ONLY, 'inclusive adverbial'],
  ['く', TOP_ONLY, 'adverbial'],
  ['ければ', TOP_ONLY, 'conditional'],
  ['かったら', TOP_ONLY, 'conditional'],
  ['かったり', TOP_ONLY, 'tari-form'],
  ['さ', TOP_ONLY, 'nominalized'],
  ['そう', TOP_ONLY, 'seeming'],
  ['すぎる', V_V1, 'excessive'],
  ['過ぎる', V_V1, 'excessive'],
  ['がる', V_V5R, 'verbified'],
  ['め', TOP_ONLY, 'somewhat'],
  ['です', TOP_ONLY, 'polite'],
];

for (const [adjSuffix, prod, label] of ADJ_INFLECTIONS) {
  const normRead =
    adjSuffix === '過ぎる' ? 'すぎる' : adjSuffix === 'です' ? 'いです' : adjSuffix;
  addRule(adjSuffix, 'い', ANY_ADJ, prod, label, {
    readFrom: 'い',
    readTo: normRead,
  });

  // Kana いい -> よ + suffix (e.g. 気持ちよかった -> 気持ちいい)
  if (adjSuffix !== 'です') {
    addRule(`よ${adjSuffix}`, 'いい', POS.ADJ_I, prod, label, {
      guard: /いい$/,
      readFrom: 'いい',
      readTo: `よ${normRead}`,
    });
  }
}

// Special さそう after 良い / 無い / 〜ない (良さそう, 無さそう, 高くなさそう)
addRule('さそう', 'い', ANY_ADJ, TOP_ONLY, 'seeming', {
  guard: /(ない|[無良よいイイ好善佳吉宜]い)$/,
  readFrom: 'い',
  readTo: 'さそう',
});
addRule('よさそう', 'いい', POS.ADJ_I, TOP_ONLY, 'seeming', {
  guard: /いい$/,
  readFrom: 'いい',
  readTo: 'よさそう',
});

// Negative te-form & colloquial obligations on 〜ない (食べないで, 行かなきゃ, 来なくちゃ)
addRule('ないで', 'ない', V_ADJ_I, TOP_ONLY, 'negative request', {
  guard: /ない$/,
  readFrom: 'ない',
  readTo: 'ないで',
});
addRule('なきゃ', 'ない', V_ADJ_I, TOP_ONLY, 'colloquial must', {
  guard: /ない$/,
  readFrom: 'ない',
  readTo: 'なきゃ',
});
addRule('なくちゃ', 'ない', V_ADJ_I, TOP_ONLY, 'colloquial must', {
  guard: /ない$/,
  readFrom: 'ない',
  readTo: 'なくちゃ',
});

/**
 * Applies a chain of deinflection rules in forward order (from dictionary base reading
 * outward to the user's conjugated surface form).
 *
 * @param {string} baseSurface
 * @param {string} baseReading
 * @param {DeinflectRule[]} innerToOuterRules
 * @param {boolean} isSuruNoun
 * @returns {string | null}
 */
function reconstructReading(baseSurface, baseReading, innerToOuterRules, isSuruNoun) {
  let reading = isSuruNoun ? `${baseReading}する` : baseReading;

  for (let idx = 0; idx < innerToOuterRules.length; idx++) {
    const rule = innerToOuterRules[idx];

    // Special case: dictionary entries like 気持ち良い -> 'きもちいい'
    // conjugate their first adjective inflection as 'きもちよ...' (never 'きもちい...').
    if (
      idx === 0 &&
      !isSuruNoun &&
      rule.readFrom === 'い' &&
      rule.readTo !== 'いです' &&
      YOI_SURFACE_RE.test(baseSurface) &&
      reading.endsWith('いい')
    ) {
      reading = reading.slice(0, -2) + 'よ' + rule.readTo;
      continue;
    }

    if (rule.readFrom === '') {
      reading += rule.readTo;
    } else if (reading.endsWith(rule.readFrom)) {
      reading = reading.slice(0, -rule.readFrom.length) + rule.readTo;
    } else {
      return null;
    }
  }

  return reading;
}

/**
 * Checks whether a candidate string matches the dictionary under the required POS / virtual mask.
 *
 * @param {string} candidate
 * @param {number} acceptsMask
 * @param {Record<string, Array<[string, number[]?, number?, number?, number?]>>} dict
 * @param {DeinflectRule[]} outerToInnerChain
 * @param {Array<{
 *   baseSurface: string,
 *   baseReading: string,
 *   basePitches: number[],
 *   basePosMask: number,
 *   baseScore: number,
 *   conjugatedReading: string,
 *   labels: string[],
 *   chainLength: number
 * }>} results
 */
function collectLexicalMatches(candidate, acceptsMask, dict, outerToInnerChain, results) {
  const innerToOuter = outerToInnerChain.slice().reverse();
  const labels = innerToOuter.map((r) => r.label);

  // 1. Direct lexical POS match in dict (v1, v5*, vk, adj_i, or lexical -する vs verb,
  //    including secondary deinflection-only entries where tuple[4] === 1)
  const lexicalBits =
    (acceptsMask & LEXICAL_MASK) | (acceptsMask & V_VS_SURU ? POS.VS : 0);

  if (lexicalBits !== 0 && Object.hasOwn(dict, candidate)) {
    const entries = dict[candidate];
    for (const entry of entries) {
      const baseReading = entry[0];
      const basePitches = entry[1] || [];
      const entryPos = entry[2] || 0;
      const baseScore = typeof entry[3] === 'number' ? entry[3] : 0;
      const matchedBits = entryPos & lexicalBits;
      if (!matchedBits) continue;

      // If matched only via V_VS_SURU on a lexical dict entry, ensure its reading ends in する
      if (
        !(entryPos & (acceptsMask & LEXICAL_MASK)) &&
        (acceptsMask & V_VS_SURU) &&
        !baseReading.endsWith('する')
      ) {
        continue;
      }

      const conj = reconstructReading(candidate, baseReading, innerToOuter, false);
      if (conj) {
        results.push({
          baseSurface: candidate,
          baseReading,
          basePitches,
          basePosMask: entryPos,
          baseScore,
          conjugatedReading: conj,
          labels,
          chainLength: outerToInnerChain.length,
        });
      }
    }
  }

  // 2. Suru-noun stem match: e.g. candidate === '勉強する' -> dict['勉強'] with POS.VS
  if ((acceptsMask & V_VS_SURU) && candidate.endsWith('する') && candidate.length > 2) {
    const nounStem = candidate.slice(0, -2);
    if (Object.hasOwn(dict, nounStem)) {
      const entries = dict[nounStem];
      for (const entry of entries) {
        const baseReading = entry[0];
        const basePitches = entry[1] || [];
        const entryPos = entry[2] || 0;
        const baseScore = typeof entry[3] === 'number' ? entry[3] : 0;
        if (!(entryPos & POS.VS)) continue;
        if (baseReading.endsWith('する')) continue;

        const conj = reconstructReading(nounStem, baseReading, innerToOuter, true);
        if (conj) {
          results.push({
            baseSurface: nounStem,
            baseReading,
            basePitches,
            basePosMask: entryPos,
            baseScore,
            conjugatedReading: conj,
            labels,
            chainLength: outerToInnerChain.length,
          });
        }
      }
    }
  }
}

const MAX_CHAIN_DEPTH = 6;

/**
 * Attempts to deinflect an inflected Japanese word against `dict`, returning
 * reconstructed full readings along with base word metadata.
 *
 * @param {string} surface
 * @param {Record<string, Array<[string, number[]?, number?, number?, number?]>>} dict
 */
export function deinflectWord(surface, dict) {
  if (!surface || Array.from(surface).length < 2 || !dict) {
    return [];
  }

  /** @type {Array<{
   *   baseSurface: string,
   *   baseReading: string,
   *   basePitches: number[],
   *   basePosMask: number,
   *   baseScore: number,
   *   conjugatedReading: string,
   *   labels: string[],
   *   chainLength: number
   * }>} */
  const rawMatches = [];
  const visited = new Set();

  /**
   * @param {string} current
   * @param {number | null} currentRequiredMask - null at depth 0 (initial surface)
   * @param {DeinflectRule[]} chain
   */
  function dfs(current, currentRequiredMask, chain) {
    if (chain.length >= MAX_CHAIN_DEPTH) {
      return;
    }

    for (let i = 0; i < RULES.length; i++) {
      const rule = RULES[i];

      if (currentRequiredMask === null) {
        // At depth 0, V_TE alone is only valid if user literally highlighted a te-form (e.g. 食べて)
        // which is fine! Any rule except internal-only states is valid at top level.
      } else {
        // Outer step requires `rule.produces` to satisfy `currentRequiredMask`
        if (rule.produces === TOP_ONLY || !(rule.produces & currentRequiredMask)) {
          continue;
        }
      }

      if (rule.from.length > 0) {
        if (current.length <= rule.from.length || !current.endsWith(rule.from)) {
          continue;
        }
      }

      const nextSurface =
        (rule.from.length > 0 ? current.slice(0, -rule.from.length) : current) + rule.to;

      if (nextSurface.length === 0) {
        continue;
      }
      if (rule.guard && !rule.guard.test(nextSurface)) {
        continue;
      }

      const nextChain = [...chain, rule];
      collectLexicalMatches(nextSurface, rule.accepts, dict, nextChain, rawMatches);

      const virtualMask = rule.accepts & ALL_OUTER;
      if (virtualMask !== 0) {
        const stateKey = `${nextSurface}\0${virtualMask}`;
        if (!visited.has(stateKey)) {
          visited.add(stateKey);
          dfs(nextSurface, virtualMask, nextChain);
        }
      }
    }
  }

  dfs(surface, null, []);

  if (rawMatches.length === 0) {
    return [];
  }

  // Rank candidates:
  //   1. Non-penalized lexical status (baseScore >= 0 over rK/sK/iK/oK penalized forms)
  //   2. Shorter auxiliary chainLength
  //   3. Irregular dedicated verb flag (V5K_S 行く / VK 来る) on non-penalized equal-chain matches
  //   4. Higher lexical frequency baseScore
  //   5. Longer baseSurface code-point length
  // Retain ALL candidates that tie with rawMatches[0] across these ranking keys (even across
  // distinct baseSurface entries when they genuinely tie).
  rawMatches.sort((a, b) => {
    const aNonPenalized = a.baseScore >= 0 ? 1 : 0;
    const bNonPenalized = b.baseScore >= 0 ? 1 : 0;
    if (bNonPenalized !== aNonPenalized) {
      return bNonPenalized - aNonPenalized;
    }
    const aCpLen = Array.from(a.baseSurface).length;
    const bCpLen = Array.from(b.baseSurface).length;
    if (bCpLen !== aCpLen) {
      return bCpLen - aCpLen;
    }
    if (a.chainLength !== b.chainLength) {
      return a.chainLength - b.chainLength;
    }
    const aIrreg = a.basePosMask & (POS.V5K_S | POS.VK) ? 1 : 0;
    const bIrreg = b.basePosMask & (POS.V5K_S | POS.VK) ? 1 : 0;
    if (bIrreg !== aIrreg) {
      return bIrreg - aIrreg;
    }
    if (b.baseScore !== a.baseScore) {
      return b.baseScore - a.baseScore;
    }
    const aHasPitch = a.basePitches.length > 0 ? 1 : 0;
    const bHasPitch = b.basePitches.length > 0 ? 1 : 0;
    return bHasPitch - aHasPitch;
  });

  const best = rawMatches[0];
  const bestNonPenalized = best.baseScore >= 0 ? 1 : 0;
  const bestChainLen = best.chainLength;
  const bestIrreg = best.basePosMask & (POS.V5K_S | POS.VK) ? 1 : 0;
  const bestScore = best.baseScore;
  const bestCpLen = Array.from(best.baseSurface).length;

  const deduped = [];
  const seenReadings = new Set();

  for (const m of rawMatches) {
    const mNonPenalized = m.baseScore >= 0 ? 1 : 0;
    const mIrreg = m.basePosMask & (POS.V5K_S | POS.VK) ? 1 : 0;
    const mCpLen = Array.from(m.baseSurface).length;
    if (
      mNonPenalized !== bestNonPenalized ||
      m.chainLength !== bestChainLen ||
      mIrreg !== bestIrreg ||
      m.baseScore !== bestScore ||
      mCpLen !== bestCpLen
    ) {
      continue;
    }
    const key = `${m.conjugatedReading}\0${m.baseSurface}\0${m.baseReading}`;
    if (seenReadings.has(key)) {
      continue;
    }
    seenReadings.add(key);
    deduped.push(m);
  }

  return deduped;
}
