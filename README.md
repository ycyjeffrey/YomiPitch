# YomiPitch — Japanese Kanji Reading & Pitch Accent Chrome Extension

**YomiPitch** is a 100% offline Google Chrome Extension (Manifest V3) that shows **how to read highlighted Japanese Kanji** (in hiragana) along with **Tokyo Japanese pitch accent intonation** (`[0]`, `[1]`, `[2]`, … and visual high/low mora contours).

Under the hood, YomiPitch runs a local **7.67 MB INT8 ONNX Neural AI Furigana Model** (`@2008-horse/horse-furigana` + `onnxruntime-web` WebAssembly) combined with **JMdict**, **KANJIDIC2**, and **Kanjium** pitch accent dictionaries — plus an **online continual-learning feedback adapter** so you can teach the AI new or corrected readings on the fly. All inference runs locally in your browser with zero network requests and zero external servers.

> [Powered by Horse Models](https://2008-horse.com/licensing/)

---

## What YomiPitch Does

- **Context-Aware Neural AI Readings (`AI Context`)**: Reads surrounding sentence context on webpages so polyphones and compounds get the right pronunciation (`人気がない夜道` → `ひとけ [0]` vs. `人気のある映画` → `にんき [0]`, `市場で野菜を買う` → `いちば [1]` vs. `株式市場` → `しじょう [0]`).
- **Accurate Numbers, Counters & Dates (`AI`)**: Properly resolves full-width/ASCII digits, counter phonetics (`連濁` / `促音便`), and calendar dates (`１６年前` → `じゅうろくねんまえ`, `３００円` → `さんびゃくえん`, `２０歳` → `はたち`, `4月1日` → `しがつついたち`, `20日` → `はつか`).
- **Most Likely Reading + Equal-Likelihood Ties (`Tied`)**: Displays the single most likely reading when clear, or shows **both** readings side-by-side when two pronunciations are equally likely without context (e.g., standalone `市場` → `いちば` / `しじょう`, `1日` → `いちにち` / `ついたち`).
- **Smart Single-Kanji Lookup (`Single Kanji · All Readings`)**: Selecting a single Kanji without context shows **all** standalone readings plus **訓読み (Kun)** and **音読み (On)**; selecting a single Kanji inside a sentence shows its in-context AI reading first with Kun/On listed below.
- **Tokyo Pitch Accent Intonation**: Displays pitch drop numbers (`[0]`, `[1]`, `[2]`, …), pattern labels (`平板`, `頭高`, `中高`, `尾高`), and step-by-step high/low mora contour lines. For conjugated verbs/adjectives (`食べた`), reconstructs the full inflected reading (`たべた`) and shows the dictionary-form pitch (`食べる [2]`).
- **Continual-Learning Feedback (`Learned ✨`)**: If the AI predicts the wrong reading (for example, reading `月王子` as `げつおうじ` when you want `つきおうじ`), you can teach it directly in one click — it updates its online neural logit weights in RAM, persists locally, and generalizes patterns to related words and contexts.

---

## Installation (Zero Build Step)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/ycyjeffrey/YomiPitch.git
   ```
2. Open Google Chrome and go to **`chrome://extensions`**.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the cloned **`YomiPitch`** folder.
5. (Optional) Click the puzzle-piece Extensions icon in Chrome's toolbar and **pin YomiPitch (`読`)** for quick access.

> **Note:** No `npm install` or build step is required to use the extension — all compressed dictionaries and WebAssembly model files are pre-bundled.

---

## How to Use YomiPitch

### 1. Look Up Kanji Readings (3 Ways)

1. **Floating `読み` Button on Any Webpage *(Fastest)***
   - Highlight (select) any Japanese Kanji word or phrase on a webpage (e.g., `怪物` or `１６年前`).
   - Click the floating **`読み`** button that appears right next to your selection to open the reading & pitch card.
   - *Tip:* Press `Esc` or click anywhere outside the card to dismiss it. You can toggle the floating `読み` button on or off anytime at the bottom of the extension popup.

2. **Right-Click Context Menu**
   - Highlight any Japanese Kanji text on a webpage (including inside iframes).
   - Right-click and select **`Read Kanji: 「…」`** to display the reading card on the page.

3. **Extension Toolbar Popup**
   - Click the **YomiPitch** icon in the Chrome toolbar:
     - If you already have Kanji highlighted on the active tab, the popup **automatically reads your selection** (with its surrounding sentence context!).
     - You can also **type or paste any Kanji word, phrase, or single character** into the search bar and press **Read** (or click one of the built-in sample chips like `怪物`, `１６年前`, `市場`, `人気`, `食べた`, `年`).

---

### 2. How to Read the Pitch Accent (Intonation) Display

Each reading displays its **pitch accent number `[k]`** (the mora index after which pitch drops from high to low) and a visual **mora pitch contour**:

| Pitch Number | Pattern Name | Meaning | Example |
| :--- | :--- | :--- | :--- |
| **`[0]`** | **平板 (Heiban)** | Starts low on mora 1, rises on mora 2, and **stays high** (even onto a following particle like `が`). | `かいぶつ [0]` (`か` low → `いぶつ` high) |
| **`[1]`** | **頭高 (Atamadaka)** | Starts **high** on mora 1 and **drops** right after mora 1. | `きょう [1]` (`きょ` high ┐ → `う` low) |
| **`[2]`..`[N-1]`** | **中高 (Nakadaka)** | Starts low on mora 1, rises on mora 2, and **drops after mora `k`**. | `にっぽん [3]` (`に` low → `っぽ` high ┐ → `ん` low) |
| **`[N]`** | **尾高 (Odaka)** | Stays high through the final mora `N`, then **drops on the following particle**. | `はし [2]` ("bridge": `は` low → `し` high ┐ → particle low) |

- Click **`Copy`** next to any reading to copy its kana to your clipboard.

---

### 3. Teaching the AI (`✎ Wrong reading? Teach AI`)

Whenever the model misreads a proper noun, creative compound, ateji, or context-specific word:

1. Open the reading card (on the webpage or in the popup) and click **`✎ Wrong reading? Teach AI`** (or **`✎ Edit taught reading`** if already taught).
2. Type the correct reading in **hiragana or katakana** (for example, `つきおうじ` or `ツキオウジ` for `月王子`).
3. *(Optional)* Enter the pitch accent number (e.g., `3` or `0, 3`), or leave it blank.
4. Click **`Save & Learn`** (or press `Enter` after finishing IME conversion).

**What happens when you teach it:**
- The card immediately updates to your taught reading with a **`Learned ✨`** badge, persisted locally in `chrome.storage.local`.
- **Generalizes beyond exact memorization**:
  - Works inside full sentences (`月王子の剣`), with common suffixes (`月王子様` → `つきおうじさま`), for irregular ateji (`聖剣` → `エクスカリバー`), and across verb conjugations (`喰らった` → `喰らう`).
  - Teaching consistent prefix/suffix patterns (e.g., `月王子` → `つきおうじ` and `月騎士` → `つききし`) teaches the neural logit adapter to read unseen similar compounds (`月剣士` → `つきけんし`) while keeping everyday words (`月曜日` = `げつようび`, `月光` = `げっこう`, `一月` = `いちがつ`) unchanged.
  - Teaching a context-dependent polyphone inside a sentence (e.g., `人気` → `ひとけ` in `人気のない森`) generalizes to similar contexts (`人気のない道` → `ひとけ`) without overwriting `人気のある店` (`にんき`).
- **Undo or Manage Anytime**:
  - Click **`↺ Undo`** right on the card to revert a single word immediately.
  - Or open the toolbar popup and click **`Learned (N)`** in the top-right header to inspect all taught readings, delete individual items (`✕`), or **`Reset All`**.

---

## Example Lookups

| Highlighted Text | Context | YomiPitch Output |
| :--- | :--- | :--- |
| `怪物` | *(any)* | **`かいぶつ [0]`** (Heiban) |
| `１６年前` | *(any)* | **`じゅうろくねんまえ`** |
| `市場` | *(standalone — equal likelihood)* | **`いちば [1]`** & **`しじょう [0]`** (`Tied`) |
| `人気` | `人気がない夜道を歩く` | **`ひとけ [0]`** (`AI Context`) |
| `人気` | `人気のある映画を見る` | **`にんき [0]`** (`AI Context`) |
| `年` | *(isolated single Kanji)* | **`とし [2]`**, **`ねん [1]`** + Kun (`とし`) & On (`ネン`) |
| `月王子` | *(after teaching `つきおうじ`, pitch `3`)* | **`つきおうじ [3]`** (`Learned ✨`) |

---

## Project Structure

```text
YomiPitch/
├── manifest.json                 # Chrome Extension Manifest V3 (v2.1.0, offscreen + WASM CSP)
├── data/
│   ├── dict.json.gz              # Top-likelihood + equal-tie headword dictionary
│   ├── pitch_map.json.gz         # 118,011 Kanjium words -> per-reading pitch accents
│   └── single_kanji.json.gz      # 12,360 single Kanji (standalone words + Kun + On)
├── vendor/
│   ├── horse-furigana/           # 7.67 MB INT8 ONNX model + candidate tables
│   └── onnxruntime-web/          # SIMD WebAssembly ONNX runtime
├── src/
│   ├── background/
│   │   └── service-worker.js     # MV3 service worker (Offscreen lifecycle, feedback storage, context menu)
│   ├── offscreen/
│   │   ├── offscreen.html        # MV3 Offscreen Document host
│   │   └── offscreen.js          # Warm ONNX session + online learner + gzipped data handler
│   ├── content/
│   │   └── content.js            # Sentence context extractor, Shadow-DOM pill/card & inline feedback UI
│   ├── popup/
│   │   ├── popup.html            # Toolbar popup markup + Learned (N) drawer + attribution
│   │   ├── popup.css             # Responsive light/dark popup styles
│   │   └── popup.js              # Context-aware active-tab lookup, manual search & feedback manager
│   └── shared/
│       ├── ai-engine.js          # Browser/Node ONNX wrapper, span normalizer & date guards
│       ├── feedback-learner.js   # Online neural logit adapter & continual-learning lexicon
│       ├── dict-loader.js        # Memoized DecompressionStream('gzip') JSON loader
│       ├── pitch.js              # Mora splitter & pitch accent contour calculator
│       ├── deinflect.js          # POS-verified Japanese deinflector & reading reconstructor
│       └── lookup.js             # Context-aware AI lookup (`lookupKanjiWithAI`) & fallback
├── scripts/                      # Offline Python scripts for regenerating icons & dictionaries
├── tests/                        # 43 automated unit, ONNX AI, continual-learning & runtime tests
├── ATTRIBUTION.md                # Horse Models, ONNX Runtime, JMdict, KANJIDIC2 & Kanjium notices
└── package.json                  # Node test script (`npm test`)
```

---

## Running Automated Tests

Requires **Node.js 20+** (uses Node's built-in test runner — zero external npm install required):

```bash
npm test
```

---

## Attribution & License

- **Neural Furigana Model**: [Powered by Horse Models](https://2008-horse.com/licensing/) — `@2008-horse/horse-furigana` under the **Horse Models Community License v2.0** (`vendor/horse-furigana/LICENSE`).
- **ONNX Runtime Web**: `onnxruntime-web` (© Microsoft Corporation, MIT License).
- **Lexical & Pitch Data**: `data/*.json.gz` compiled from **JMdict** & **KANJIDIC2** (© EDRDG, CC BY-SA 4.0) and **Kanjium** (© Uros Ozvatic, CC BY-SA 4.0). See [ATTRIBUTION.md](./ATTRIBUTION.md) for full details.
