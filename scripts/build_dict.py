#!/usr/bin/env python3
"""
Builds the compact offline Kanji reading & pitch accent dictionary (data/dict.json.gz)
from open-source CC BY-SA 4.0 datasets:
  1. JMdict (EDRDG: http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz)
  2. Kanjium Pitch Accents (https://github.com/mifunetoshiro/kanjium)
  3. KANJIDIC2 (EDRDG: http://www.edrdg.org/kanjidic/kanjidic2.xml.gz) for rare single-Kanji fallback

Output schema (JSON object keyed by Kanji surface):
  {
    "怪物": [["かいぶつ", [0]]],
    "市場": [["いちば", [1]], ["しじょう", [0]]],
    "食べる": [["たべる", [2], 1]]
  }
Each candidate tuple is:
  [reading]                       (no pitch accent, non-inflecting)
  [reading, pitches]              (with pitch accent numbers, non-inflecting)
  [reading, pitches, posMask]     (inflecting verb / i-adjective / suru-verb)
"""

from __future__ import annotations

import gzip
import json
import pathlib
import re
import urllib.request
import xml.etree.ElementTree as ET

JMDICT_URL = "https://www.edrdg.org/pub/Nihongo/JMdict_e.gz"
KANJIUM_URL = "https://raw.githubusercontent.com/mifunetoshiro/kanjium/master/data/source_files/raw/accents.txt"
KANJIDIC2_URL = "https://www.edrdg.org/kanjidic/kanjidic2.xml.gz"

KANJI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\U00020000-\U0002CEAF々〆ヵヶ]")

PENALIZED_KINF = {"ENT_rK", "ENT_sK", "ENT_iK", "ENT_oK", "ENT_io"}
PENALIZED_RINF = {"ENT_rk", "ENT_sk", "ENT_ik", "ENT_ok"}
AFFIX_POS = {
    "ENT_suf",
    "ENT_n-suf",
    "ENT_pref",
    "ENT_n-pref",
    "ENT_ctr",
    "ENT_aux",
    "ENT_aux-v",
    "ENT_aux-adj",
}

# Bitmask flags shared with src/shared/deinflect.js
POS_FLAGS = {
    "ENT_v1": 1 << 0,
    "ENT_v1-s": 1 << 0,
    "ENT_v5u": 1 << 1,
    "ENT_v5u-s": 1 << 1,
    "ENT_v5k": 1 << 2,
    "ENT_v5k-s": 1 << 3,
    "ENT_v5g": 1 << 4,
    "ENT_v5s": 1 << 5,
    "ENT_v5t": 1 << 6,
    "ENT_v5n": 1 << 7,
    "ENT_v5b": 1 << 8,
    "ENT_v5m": 1 << 9,
    "ENT_v5r": 1 << 10,
    "ENT_v5r-i": 1 << 10,
    "ENT_v5aru": 1 << 10,
    "ENT_vk": 1 << 11,
    "ENT_vs": 1 << 12,
    "ENT_vs-s": 1 << 12,
    "ENT_vs-i": 1 << 12,
    "ENT_adj-i": 1 << 13,
    "ENT_adj-ix": 1 << 13,
}


def to_hiragana(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F4:
            out.append(chr(code - 0x60))
        elif ch == "ヵ":
            out.append("か")
        elif ch == "ヶ":
            out.append("け")
        else:
            out.append(ch)
    return "".join(out)


def pri_score(tags: set[str]) -> int:
    if not tags:
        return 0
    score = 0
    if "ichi1" in tags or "spec1" in tags or "gai1" in tags:
        score += 40
    elif "ichi2" in tags or "spec2" in tags or "gai2" in tags:
        score += 20

    if "news1" in tags:
        score += 30
    elif "news2" in tags:
        score += 15

    nfs = [int(t[2:]) for t in tags if re.match(r"^nf\d\d$", t)]
    if nfs:
        score += 49 - min(nfs)
    return score


def compute_pos_mask(pos_set: set[str]) -> int:
    mask = 0
    for tag in pos_set:
        mask |= POS_FLAGS.get(tag, 0)
    return mask


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "KanjiExtensionDictBuilder/1.0"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read()


def load_kanjium() -> tuple[dict[tuple[str, str], list[int]], dict[str, list[tuple[str, list[int]]]]]:
    print("Downloading Kanjium pitch accent data...")
    lines = fetch_bytes(KANJIUM_URL).decode("utf-8").splitlines()
    pitch_map: dict[tuple[str, str], list[int]] = {}
    kanjium_words: dict[str, list[tuple[str, list[int]]]] = {}

    for line in lines:
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        word = parts[0].strip()
        reading = to_hiragana(parts[1].strip() or word)
        accs: list[int] = []
        for tok in re.findall(r"\d+", parts[2]):
            val = int(tok)
            if val not in accs:
                accs.append(val)
        key = (word, reading)
        if key in pitch_map:
            for v in accs:
                if v not in pitch_map[key]:
                    pitch_map[key].append(v)
        else:
            pitch_map[key] = accs
        if KANJI_RE.search(word):
            kanjium_words.setdefault(word, []).append((reading, pitch_map[key]))

    print(f"  Loaded {len(pitch_map):,} (word, reading) pitch entries.")
    return pitch_map, kanjium_words


def load_jmdict(
    pitch_map: dict[tuple[str, str], list[int]],
) -> dict[str, dict[str, dict]]:
    print("Downloading JMdict XML...")
    raw_xml = gzip.decompress(fetch_bytes(JMDICT_URL)).decode("utf-8")
    clean_xml = re.sub(r"<!DOCTYPE.*?\n\]>", "", raw_xml, flags=re.S)
    clean_xml = re.sub(
        r"&(?!amp;|lt;|gt;|quot;|apos;)([a-zA-Z0-9_-]+);", r"ENT_\1", clean_xml
    )
    root = ET.fromstring(clean_xml)

    candidates: dict[str, dict[str, dict]] = {}

    for entry in root.findall("entry"):
        k_eles = []
        any_kpri = False
        for ki, k in enumerate(entry.findall("k_ele")):
            keb = k.findtext("keb") or ""
            kpri = [p.text for p in k.findall("ke_pri") if p.text]
            kinf = {i.text for i in k.findall("ke_inf") if i.text}
            if kpri:
                any_kpri = True
            k_eles.append((ki, keb, kpri, kinf))
        if not k_eles:
            continue

        pos_set = {
            p.text
            for s in entry.findall("sense")
            for p in s.findall("pos")
            if p.text
        }
        is_standalone = bool(pos_set - AFFIX_POS) if pos_set else True
        pos_mask = compute_pos_mask(pos_set)

        r_eles = []
        for ri, r in enumerate(entry.findall("r_ele")):
            if r.find("re_nokanji") is not None:
                continue
            reb_raw = r.findtext("reb") or ""
            reb = to_hiragana(reb_raw)
            rpri = [p.text for p in r.findall("re_pri") if p.text]
            rinf = {i.text for i in r.findall("re_inf") if i.text}
            restr = {rs.text for rs in r.findall("re_restr") if rs.text}
            r_eles.append((ri, reb, rpri, rinf, restr, bool(reb_raw != reb)))

        for ki, keb, kpri, kinf in k_eles:
            if not KANJI_RE.search(keb):
                continue
            app = [
                (ri, reb, rpri, rinf, was_kata)
                for (ri, reb, rpri, rinf, restr, was_kata) in r_eles
                if not restr or keb in restr
            ]
            if not app:
                continue

            union_tags = set(kpri)
            for _, _, rp, _, _ in app:
                union_tags.update(rp)

            for order_idx, (ri, reb, rpri, rinf, was_kata) in enumerate(app):
                if kpri:
                    eff_tags = (union_tags if order_idx == 0 else set(rpri)) if rpri else set()
                else:
                    eff_tags = set() if any_kpri else set(rpri)

                sc = pri_score(eff_tags)
                if sc > 0:
                    sc += 100
                elif ki == 0 and not (kinf & PENALIZED_KINF):
                    sc += 20

                if is_standalone:
                    sc += 8
                if order_idx == 0:
                    sc += 3
                elif order_idx == 1:
                    sc += 1
                if was_kata and order_idx > 0:
                    sc -= 15
                if kinf & PENALIZED_KINF:
                    sc -= 60
                if rinf & PENALIZED_RINF:
                    sc -= 60

                pitches = pitch_map.get((keb, reb), [])
                if pitches:
                    sc += 2

                w_dict = candidates.setdefault(keb, {})
                prev = w_dict.get(reb)
                if prev is None:
                    w_dict[reb] = {
                        "score": sc,
                        "pitches": list(pitches),
                        "pos_mask": pos_mask,
                    }
                else:
                    if sc > prev["score"]:
                        prev["score"] = sc
                    if not prev["pitches"] and pitches:
                        prev["pitches"] = list(pitches)
                    prev["pos_mask"] |= pos_mask

    print(f"  Loaded {len(candidates):,} Kanji headwords from JMdict.")
    return candidates


def add_kanjidic2_fallbacks(
    candidates: dict[str, dict[str, dict]],
    pitch_map: dict[tuple[str, str], list[int]],
) -> int:
    print("Downloading KANJIDIC2 for single-Kanji fallback...")
    raw_xml = gzip.decompress(fetch_bytes(KANJIDIC2_URL)).decode("utf-8")
    clean_xml = re.sub(r"<!DOCTYPE.*?\n\]>", "", raw_xml, flags=re.S)
    root = ET.fromstring(clean_xml)
    added = 0

    for char in root.findall("character"):
        literal = char.findtext("literal") or ""
        if not literal or literal == "々" or literal in candidates:
            continue
        rmgroup = char.find("./reading_meaning/rmgroup")
        if rmgroup is None:
            continue
        kun_readings = []
        on_readings = []
        for r in rmgroup.findall("reading"):
            r_type = r.attrib.get("r_type")
            val = (r.text or "").strip()
            if not val:
                continue
            if r_type == "ja_kun":
                # Strip okurigana suffix after '.' and prefix '-'
                stem = val.lstrip("-")
                if "." not in stem and "-" not in val:
                    kun_readings.append(to_hiragana(stem))
            elif r_type == "ja_on":
                on_readings.append(to_hiragana(val.lstrip("-").rstrip("-")))

        chosen = kun_readings[:1] or on_readings[:1]
        if chosen:
            reb = chosen[0]
            candidates[literal] = {
                reb: {
                    "score": 5,
                    "pitches": pitch_map.get((literal, reb), []),
                    "pos_mask": 0,
                }
            }
            added += 1

    print(f"  Added {added:,} rare single-Kanji fallbacks from KANJIDIC2.")
    return added


def main() -> None:
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    out_path = repo_root / "data" / "dict.json.gz"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    pitch_map, kanjium_words = load_kanjium()
    candidates = load_jmdict(pitch_map)

    kanjium_added = 0
    for word, items in kanjium_words.items():
        if word not in candidates:
            rmap = {}
            for reb, accs in items:
                rmap[reb] = {"score": 10, "pitches": list(accs), "pos_mask": 0}
            candidates[word] = rmap
            kanjium_added += 1
    print(f"  Added {kanjium_added:,} Kanjium-only Kanji headwords.")

    add_kanjidic2_fallbacks(candidates, pitch_map)

    compact: dict[str, list[list]] = {}
    ties = 0
    alt_inflect_count = 0
    for word, rmap in candidates.items():
        if word == "々":
            continue
        ranked = sorted(rmap.items(), key=lambda kv: -kv[1]["score"])
        top_score = ranked[0][1]["score"]
        winners = []
        covered_pos = 0
        for reb, info in ranked:
            if info["score"] != top_score:
                break
            pitches = info["pitches"]
            pos_mask = info["pos_mask"]
            covered_pos |= pos_mask
            if pos_mask:
                winners.append([reb, pitches, pos_mask, info["score"]])
            elif pitches:
                winners.append([reb, pitches])
            else:
                winners.append([reb])
        if len(winners) > 1:
            ties += 1

        # Preserve secondary inflecting readings that introduce distinct POS conjugation classes
        # (e.g., 居る has winner おる v5r, while いる v1 handles 居た -> いた / 居ない -> いない).
        for reb, info in ranked:
            if info["score"] == top_score:
                continue
            pos_mask = info["pos_mask"]
            new_bits = pos_mask & ~covered_pos
            if new_bits and info["score"] > 0:
                winners.append([reb, info["pitches"], pos_mask, info["score"], 1])
                covered_pos |= pos_mask
                alt_inflect_count += 1

        compact[word] = winners

    raw_bytes = json.dumps(compact, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz_bytes = gzip.compress(raw_bytes, compresslevel=9)
    out_path.write_bytes(gz_bytes)

    print(f"Done! Wrote {out_path}")
    print(f"  Total entries : {len(compact):,}")
    print(f"  Tied entries  : {ties:,}")
    print(f"  Alt inflects  : {alt_inflect_count:,}")
    print(f"  Uncompressed  : {len(raw_bytes) / 1e6:.2f} MB")
    print(f"  Gzipped       : {len(gz_bytes) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
