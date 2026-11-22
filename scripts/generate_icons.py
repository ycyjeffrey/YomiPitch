#!/usr/bin/env python3
"""
Generates crisp, anti-aliased PNG extension icons (16, 32, 48, 128 px)
using pure Python stdlib (`zlib` and `struct`) with zero external dependencies.

Visual design:
  - Rounded squircle badge with rich deep-indigo gradient (#1E1B4B -> #312E81)
  - Subtle inner border highlight
  - Crisp white pitch-accent step line (Low -> High -> Downstep tick) at top
  - Stylized geometric Japanese character mark ("文" / Kanji strokes) centered below
"""

from __future__ import annotations

import math
import pathlib
import struct
import zlib


def clamp(val: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, val))


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge1 == edge0:
        return 1.0 if x >= edge1 else 0.0
    t = clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def sd_rounded_box(px: float, py: float, cx: float, cy: float, hw: float, hh: float, r: float) -> float:
    qx = abs(px - cx) - hw + r
    qy = abs(py - cy) - hh + r
    out_dist = math.hypot(max(qx, 0.0), max(qy, 0.0))
    in_dist = min(max(qx, qy), 0.0)
    return out_dist + in_dist - r


def sd_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    pax, pay = px - ax, py - ay
    bax, bay = bx - ax, by - ay
    denom = bax * bax + bay * bay
    h = 0.0 if denom == 0.0 else clamp((pax * bax + pay * bay) / denom)
    return math.hypot(pax - bax * h, pay - bay * h)


def blend(dst: tuple[float, float, float, float], src_rgb: tuple[float, float, float], src_a: float) -> tuple[float, float, float, float]:
    if src_a <= 0.0:
        return dst
    dr, dg, db, da = dst
    sr, sg, sb = src_rgb
    out_a = src_a + da * (1.0 - src_a)
    if out_a <= 1e-6:
        return (0.0, 0.0, 0.0, 0.0)
    out_r = (sr * src_a + dr * da * (1.0 - src_a)) / out_a
    out_g = (sg * src_a + dg * da * (1.0 - src_a)) / out_a
    out_b = (sb * src_a + db * da * (1.0 - src_a)) / out_a
    return (out_r, out_g, out_b, out_a)


def render_icon(size: int) -> bytes:
    aa = 1.15 / size  # Normalized anti-aliasing feather width
    pixels = bytearray(size * size * 4)

    for y in range(size):
        ny = (y + 0.5) / size
        for x in range(size):
            nx = (x + 0.5) / size

            col = (0.0, 0.0, 0.0, 0.0)

            # 1. Rounded squircle background with rich indigo-violet vertical gradient
            d_box = sd_rounded_box(nx, ny, 0.5, 0.5, 0.455, 0.455, 0.21)
            bg_alpha = 1.0 - smoothstep(-aa, aa, d_box)
            if bg_alpha > 0.0:
                t = clamp(ny * 0.85 + nx * 0.15)
                bg_r = (30.0 * (1.0 - t) + 55.0 * t) / 255.0
                bg_g = (27.0 * (1.0 - t) + 48.0 * t) / 255.0
                bg_b = (75.0 * (1.0 - t) + 163.0 * t) / 255.0
                col = blend(col, (bg_r, bg_g, bg_b), bg_alpha)

                # Subtle inner top glow border
                ring = (1.0 - smoothstep(0.0, aa * 1.8, abs(d_box + 0.015))) * (1.0 - ny * 0.7) * 0.28
                col = blend(col, (1.0, 1.0, 1.0), ring * bg_alpha)

                # 2. Pitch accent intonation bar across top (coral-amber accent #FB7185 / #F43F5E)
                #    Low dot (0.24, 0.27) -> step up -> High bar (0.36..0.72, 0.19) -> downstep tick (0.72, 0.19..0.28)
                pitch_w = max(0.032, 1.15 / size)
                d_p1 = sd_segment(nx, ny, 0.24, 0.27, 0.35, 0.27)
                d_p2 = sd_segment(nx, ny, 0.35, 0.27, 0.35, 0.195)
                d_p3 = sd_segment(nx, ny, 0.35, 0.195, 0.73, 0.195)
                d_p4 = sd_segment(nx, ny, 0.73, 0.195, 0.73, 0.275)
                d_pitch = min(d_p1, d_p2, d_p3, d_p4) - pitch_w * 0.5
                pitch_a = (1.0 - smoothstep(-aa, aa, d_pitch)) * bg_alpha
                col = blend(col, (251.0 / 255.0, 113.0 / 255.0, 133.0 / 255.0), pitch_a)

                # 3. Crisp stylized Kanji glyph "文" (bun / character / reading) in pure white
                stroke_w = max(0.044, 1.35 / size)
                # Top short vertical cap
                s1 = sd_segment(nx, ny, 0.50, 0.33, 0.50, 0.43)
                # Horizontal bar
                s2 = sd_segment(nx, ny, 0.24, 0.44, 0.76, 0.44)
                # Left-sweeping stroke (from upper-right-center down-left)
                s3a = sd_segment(nx, ny, 0.62, 0.44, 0.50, 0.64)
                s3b = sd_segment(nx, ny, 0.50, 0.64, 0.27, 0.79)
                # Right-sweeping stroke (from upper-left-center down-right)
                s4a = sd_segment(nx, ny, 0.37, 0.48, 0.51, 0.65)
                s4b = sd_segment(nx, ny, 0.51, 0.65, 0.74, 0.79)

                d_glyph = min(s1, s2, s3a, s3b, s4a, s4b) - stroke_w * 0.5
                glyph_a = (1.0 - smoothstep(-aa, aa, d_glyph)) * bg_alpha
                col = blend(col, (1.0, 1.0, 1.0), glyph_a)

            idx = (y * size + x) * 4
            pixels[idx] = int(round(clamp(col[0]) * 255))
            pixels[idx + 1] = int(round(clamp(col[1]) * 255))
            pixels[idx + 2] = int(round(clamp(col[2]) * 255))
            pixels[idx + 3] = int(round(clamp(col[3]) * 255))

    return encode_png(size, size, bytes(pixels))


def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def encode_png(width: int, height: int, rgba: bytes) -> bytes:
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # Filter type 0 (None)
        raw.extend(rgba[y * stride : (y + 1) * stride])

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=9)
    signature = b"\x89PNG\r\n\x1a\n"
    return signature + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")


def main() -> None:
    root = pathlib.Path(__file__).resolve().parent.parent
    icons_dir = root / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)

    for size in (16, 32, 48, 128):
        out_file = icons_dir / f"icon{size}.png"
        png_bytes = render_icon(size)
        out_file.write_bytes(png_bytes)
        print(f"Generated {out_file.relative_to(root)} ({len(png_bytes):,} bytes)")


if __name__ == "__main__":
    main()
