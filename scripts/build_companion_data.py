#!/usr/bin/env python3
"""
Builds two compact companion datasets for the AI-powered YomiPitch engine:
  1. data/pitch_map.json.gz:
     Full Kanjium (word -> { reading: [pitches] }) map so context-disambiguated AI readings
     (e.g., 人気 -> ひとけ [0], 上手 -> かみて [0, 3], 大家 -> たいか [1, 0]) get exact pitch accents.
  2. data/single_kanji.json.gz:
     Complete single-Kanji readings table combining JMdict standalone word readings (with pitch accents)
     and KANJIDIC2 Kun'yomi (hiragana) + On'yomi (katakana) readings for single-character lookups.
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

SINGLE_HAN_RE = re.compile(r"^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\U00020000-\U0002CEAF]$")
PENALIZED_KINF = {"ENT_rK", "ENT_sK", "ENT_iK", "ENT_oK", "ENT_io"}
PENALIZED_RINF = {"ENT_rk", "ENT_sk", "ENT_ik", "ENT_ok"}


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


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "KanjiExtensionDictBuilder/2.0"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read()


def main() -> None:
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    data_dir = repo_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    # 1. Build pitch_map from Kanjium
    print("Downloading Kanjium pitch accents...")
    k_lines = fetch_bytes(KANJIUM_URL).decode("utf-8").splitlines()
    pitch_map: dict[str, dict[str, list[int]]] = {}

    for line in k_lines:
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
        if not accs:
            continue
        w_entry = pitch_map.setdefault(word, {})
        if reading in w_entry:
            for v in accs:
                if v not in w_entry[reading]:
                    w_entry[reading].append(v)
        else:
            w_entry[reading] = accs

    pitch_raw = json.dumps(pitch_map, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pitch_gz = gzip.compress(pitch_raw, compresslevel=9)
    pitch_out = data_dir / "pitch_map.json.gz"
    pitch_out.write_bytes(pitch_gz)
    print(f"Wrote {pitch_out} ({len(pitch_map):,} words, {len(pitch_gz) / 1e6:.2f} MB gzipped)")

    # 2. Collect common/normal single-Kanji readings from JMdict
    print("Downloading JMdict for single-Kanji word readings...")
    raw_jm = gzip.decompress(fetch_bytes(JMDICT_URL)).decode("utf-8")
    clean_jm = re.sub(r"<!DOCTYPE.*?\n\]>", "", raw_jm, flags=re.S)
    clean_jm = re.sub(r"&(?!amp;|lt;|gt;|quot;|apos;)([a-zA-Z0-9_-]+);", r"ENT_\1", clean_jm)
    jm_root = ET.fromstring(clean_jm)

    single_words: dict[str, dict[str, tuple[int, list[int]]]] = {}

    for entry in jm_root.findall("entry"):
        k_eles = []
        any_kpri = False
        for ki, k in enumerate(entry.findall("k_ele")):
            keb = k.findtext("keb") or ""
            kpri = [p.text for p in k.findall("ke_pri") if p.text]
            kinf = {i.text for i in k.findall("ke_inf") if i.text}
            if kpri:
                any_kpri = True
            k_eles.append((ki, keb, kpri, kinf))

        r_eles = []
        for ri, r in enumerate(entry.findall("r_ele")):
            if r.find("re_nokanji") is not None:
                continue
            reb_raw = r.findtext("reb") or ""
            reb = to_hiragana(reb_raw)
            rpri = [p.text for p in r.findall("re_pri") if p.text]
            rinf = {i.text for i in r.findall("re_inf") if i.text}
            restr = {rs.text for rs in r.findall("re_restr") if rs.text}
            r_eles.append((ri, reb, rpri, rinf, restr))

        for ki, keb, kpri, kinf in k_eles:
            if not SINGLE_HAN_RE.match(keb):
                continue
            if kinf & PENALIZED_KINF:
                continue
            if not kpri and any_kpri:
                continue
            app = [
                (ri, reb, rpri, rinf)
                for (ri, reb, rpri, rinf, restr) in r_eles
                if not restr or keb in restr
            ]
            for order_idx, (_, reb, rpri, rinf) in enumerate(app):
                if rinf & PENALIZED_RINF:
                    continue
                sc = 0
                if kpri and rpri:
                    sc += 100
                elif rpri:
                    sc += 50
                elif ki == 0 and order_idx == 0:
                    sc += 20
                else:
                    continue
                pitches = pitch_map.get(keb, {}).get(reb, [])
                if pitches:
                    sc += 5
                prev = single_words.setdefault(keb, {}).get(reb)
                if prev is None or sc > prev[0]:
                    single_words[keb][reb] = (sc, pitches)

    # 3. Collect Kun'yomi and On'yomi from KANJIDIC2
    print("Downloading KANJIDIC2 for complete single-Kanji Kun/On readings...")
    raw_kd = gzip.decompress(fetch_bytes(KANJIDIC2_URL)).decode("utf-8")
    clean_kd = re.sub(r"<!DOCTYPE.*?\n\]>", "", raw_kd, flags=re.S)
    kd_root = ET.fromstring(clean_kd)

    single_kanji: dict[str, dict] = {}
    for char in kd_root.findall("character"):
        literal = char.findtext("literal") or ""
        if not SINGLE_HAN_RE.match(literal):
            continue
        rmgroup = char.find("./reading_meaning/rmgroup")
        kun_list: list[str] = []
        on_list: list[str] = []
        if rmgroup is not None:
            for r in rmgroup.findall("reading"):
                rtype = r.attrib.get("r_type")
                val = (r.text or "").strip()
                if not val:
                    continue
                if rtype == "ja_kun":
                    if val not in kun_list:
                        kun_list.append(val)
                elif rtype == "ja_on":
                    if val not in on_list:
                        on_list.append(val)

        w_map = single_words.get(literal, {})
        # Also include Kanjium single-kanji readings if present
        for reb, accs in pitch_map.get(literal, {}).items():
            if reb not in w_map:
                w_map[reb] = (15, accs)

        ranked_words = sorted(w_map.items(), key=lambda kv: -kv[1][0])
        words_out = [
            [reb, accs] if accs else [reb]
            for reb, (_, accs) in ranked_words[:8]
        ]

        if words_out or kun_list or on_list:
            entry_obj: dict[str, list] = {}
            if words_out:
                entry_obj["w"] = words_out
            if kun_list:
                entry_obj["k"] = kun_list
            if on_list:
                entry_obj["o"] = on_list
            single_kanji[literal] = entry_obj

    sk_raw = json.dumps(single_kanji, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sk_gz = gzip.compress(sk_raw, compresslevel=9)
    sk_out = data_dir / "single_kanji.json.gz"
    sk_out.write_bytes(sk_gz)
    print(f"Wrote {sk_out} ({len(single_kanji):,} kanji, {len(sk_gz) / 1e6:.2f} MB gzipped)")


if __name__ == "__main__":
    main()
