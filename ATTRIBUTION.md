# Open-Source Model, Runtime & Data Attribution

**YomiPitch v2.0 — Kanji Reading & Intonation** runs 100% locally in the browser and bundles the following neural model, WebAssembly runtime, and lexical datasets:

---

## 1. Horse Furigana Neural Model (`@2008-horse/horse-furigana`)

- **Powered by Horse Models**: <https://2008-horse.com/licensing/>
- **Package**: `@2008-horse/horse-furigana` (`vendor/horse-furigana/`)
- **Copyright**: © 2026 2008 Horse
- **License**: **Horse Models Community License v2.0** (see [`vendor/horse-furigana/LICENSE`](./vendor/horse-furigana/LICENSE) and [`vendor/horse-furigana/THIRD-PARTY-NOTICES.md`](./vendor/horse-furigana/THIRD-PARTY-NOTICES.md))

Provides the 7.67 MB INT8 quantized ONNX neural network (`model.int8.onnx`) and candidate tables used for context-aware Japanese furigana disambiguation.

---

## 2. ONNX Runtime Web (`onnxruntime-web`)

- **Source**: <https://github.com/microsoft/onnxruntime> (`vendor/onnxruntime-web/`)
- **Copyright**: © Microsoft Corporation
- **License**: [MIT License](https://opensource.org/licenses/MIT)

Executes the INT8 ONNX model inside the Chrome MV3 Offscreen Document via SIMD WebAssembly (`ort-wasm-simd-threaded.wasm`).

---

## 3. JMdict & KANJIDIC2 (EDRDG)

- **Source**: [Electronic Dictionary Research and Development Group (EDRDG)](https://www.edrdg.org/)
  - JMdict: <https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project>
  - KANJIDIC2: <https://www.edrdg.org/wiki/index.php/KANJIDIC_Project>
- **Copyright**: © James William Breen and The Electronic Dictionary Research and Development Group (EDRDG)
- **License**: [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/)

JMdict and KANJIDIC2 are used in accordance with the [EDRDG Licence Statement](https://www.edrdg.org/edrdg/licence.html). `JMdict` provides Japanese Kanji headwords, kana readings, frequency/priority rankings (`ichi1`, `news1`, `spec1`, `gai1`, `nf01`–`nf48`), and part-of-speech inflection tags. `KANJIDIC2` provides single-Kanji Kun'yomi (`訓読み`) and On'yomi (`音読み`) readings in `data/single_kanji.json.gz`.

---

## 4. Kanjium Pitch Accents

- **Source**: [Kanjium (`accents.txt`)](https://github.com/mifunetoshiro/kanjium)
- **Author**: Uros Ozvatic
- **License**: [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/)

Kanjium provides standard Tokyo Japanese pitch accent downstep numbers mapped onto dictionary `(headword, reading)` pairs in `data/dict.json.gz`, `data/pitch_map.json.gz`, and `data/single_kanji.json.gz`.

---

## License Notice for Derived Dictionary Data (`data/*.json.gz`)

Because `data/dict.json.gz`, `data/pitch_map.json.gz`, and `data/single_kanji.json.gz` are derived from CC BY-SA 4.0 lexical resources (JMdict, KANJIDIC2, and Kanjium), those `data/*.json.gz` files are distributed under the terms of the **[Creative Commons Attribution-ShareAlike 4.0 International License (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/)**.
