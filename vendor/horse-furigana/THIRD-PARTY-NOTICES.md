# Third-party notices

The model and data files of this package contain material derived from the third-party resources below. In the npm package they are in the `models/` folder; in the Hugging Face repository they are at the top level. Each section says which files it applies to and reproduces the notice that has to travel with them.

The terms below apply to the third-party material as licensed by its owners. They do not license the Horse Furigana model, vocabulary or lexicon files as a whole, which are provided under `LICENSE`. Nothing in `LICENSE` limits the rights these terms grant in the third-party material itself.

| file | NDL corpus (CC BY 4.0) | UniDic (BSD-3-Clause) | Unicode License v3 |
|---|---|---|---|
| `model.int8.onnx` | yes | yes | yes |
| `vocab.json` | yes | yes | yes |
| `kanji-candidates.json` | yes | yes | no |
| `readings.json` | yes | yes | no |
| `names.json` | no | yes | no |

## National Diet Library: 振り仮名注釈コーパス（書誌データコーパス）

Applies to: `model.int8.onnx`, `vocab.json`, `kanji-candidates.json`, `readings.json`.

国立国会図書館 NDLラボ「振り仮名注釈コーパス（書誌データコーパス）」 https://github.com/ndl-lab/huriganacorpus-ndlbib , licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Modified: re-tokenised and filtered; used as training data and to derive vocabulary labels and lexicon entries.

## UniDic

Applies to: `model.int8.onnx`, `vocab.json`, `kanji-candidates.json`, `readings.json`, `names.json`.

This product uses UniDic 2.1.2 (unidic-mecab kana-accent, The UniDic Consortium, https://clrd.ninjal.ac.jp/unidic/), BSD licence. Lexicon entries (surface and reading) were used as training data and to derive vocabulary labels and lexicon entries.

Reference listed by the National Institute for Japanese Language and Linguistics for UniDic: 伝 康晴, 小木曽 智信, 小椋 秀樹, 山田 篤, 峯松 信明, 内元 清貴, 小磯 花絵: 「コーパス日本語学のための言語資源：形態素解析用電子化辞書の開発とその応用」, 日本語科学, Vol.22, pp.101-123 (2007). https://doi.org/10.15084/00002185

```text
Copyright (c) 2011-2013, The UniDic Consortium
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

 * Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the
   distribution.

 * Neither the name of the UniDic Consortium nor the names of its
   contributors may be used to endorse or promote products derived
   from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

AUTHORS:

```text
The UniDic Consortium
```

## Unicode, Inc.: Unihan database

Applies to: `model.int8.onnx`, `vocab.json` (character-set membership fields only).

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```
