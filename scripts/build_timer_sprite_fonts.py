#!/usr/bin/env python3
from __future__ import annotations

import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public/assets"
GLYPHS = "0123456789:"

PATTERNS = {
    "0": [
        "11111",
        "10001",
        "10011",
        "10101",
        "11001",
        "10001",
        "11111",
    ],
    "1": [
        "00100",
        "01100",
        "00100",
        "00100",
        "00100",
        "00100",
        "01110",
    ],
    "2": [
        "11110",
        "00001",
        "00001",
        "11110",
        "10000",
        "10000",
        "11111",
    ],
    "3": [
        "11110",
        "00001",
        "00001",
        "01110",
        "00001",
        "00001",
        "11110",
    ],
    "4": [
        "10010",
        "10010",
        "10010",
        "11111",
        "00010",
        "00010",
        "00010",
    ],
    "5": [
        "11111",
        "10000",
        "10000",
        "11110",
        "00001",
        "00001",
        "11110",
    ],
    "6": [
        "01111",
        "10000",
        "10000",
        "11110",
        "10001",
        "10001",
        "01110",
    ],
    "7": [
        "11111",
        "00001",
        "00010",
        "00100",
        "00100",
        "01000",
        "01000",
    ],
    "8": [
        "01110",
        "10001",
        "10001",
        "01110",
        "10001",
        "10001",
        "01110",
    ],
    "9": [
        "01110",
        "10001",
        "10001",
        "01111",
        "00001",
        "00001",
        "11110",
    ],
    ":": [
        "0",
        "1",
        "1",
        "0",
        "1",
        "1",
        "0",
    ],
}

FONTS = [
    {
        "filename": "timer-font-normal.png",
        "cell_width": 12,
        "cell_height": 16,
        "block": 2,
        "fill": (248, 255, 246, 234),
        "highlight": (255, 255, 255, 188),
        "outline": (3, 78, 88, 210),
        "shadow": (23, 54, 77, 132),
        "shadow_offset": (1, 1),
    },
    {
        "filename": "timer-font-pressure.png",
        "cell_width": 14,
        "cell_height": 18,
        "block": 2,
        "fill": (255, 229, 0, 248),
        "highlight": (255, 255, 220, 210),
        "outline": (23, 54, 77, 245),
        "shadow": (197, 29, 99, 184),
        "shadow_offset": (2, 2),
    },
]


def empty_canvas(width: int, height: int) -> list[list[tuple[int, int, int, int]]]:
    return [[(0, 0, 0, 0) for _x in range(width)] for _y in range(height)]


def blend_pixel(
    canvas: list[list[tuple[int, int, int, int]]],
    x: int,
    y: int,
    color: tuple[int, int, int, int],
) -> None:
    if y < 0 or y >= len(canvas) or x < 0 or x >= len(canvas[0]):
        return

    src_r, src_g, src_b, src_a = color
    if src_a <= 0:
        return
    if src_a >= 255:
        canvas[y][x] = color
        return

    dst_r, dst_g, dst_b, dst_a = canvas[y][x]
    src_alpha = src_a / 255
    dst_alpha = dst_a / 255
    out_alpha = src_alpha + dst_alpha * (1 - src_alpha)
    if out_alpha <= 0:
        canvas[y][x] = (0, 0, 0, 0)
        return

    out_r = round((src_r * src_alpha + dst_r * dst_alpha * (1 - src_alpha)) / out_alpha)
    out_g = round((src_g * src_alpha + dst_g * dst_alpha * (1 - src_alpha)) / out_alpha)
    out_b = round((src_b * src_alpha + dst_b * dst_alpha * (1 - src_alpha)) / out_alpha)
    out_a = round(out_alpha * 255)
    canvas[y][x] = (out_r, out_g, out_b, out_a)


def rect(
    canvas: list[list[tuple[int, int, int, int]]],
    x: int,
    y: int,
    width: int,
    height: int,
    color: tuple[int, int, int, int],
) -> None:
    for py in range(y, y + height):
        for px in range(x, x + width):
            blend_pixel(canvas, px, py, color)


def draw_glyph(
    canvas: list[list[tuple[int, int, int, int]]],
    glyph: str,
    glyph_index: int,
    font: dict[str, object],
) -> None:
    pattern = PATTERNS[glyph]
    cell_width = int(font["cell_width"])
    cell_height = int(font["cell_height"])
    block = int(font["block"])
    glyph_width = max(len(row) for row in pattern) * block
    glyph_height = len(pattern) * block
    base_x = glyph_index * cell_width + (cell_width - glyph_width) // 2
    base_y = (cell_height - glyph_height) // 2
    shadow_dx, shadow_dy = font["shadow_offset"]

    lit_cells = [
        (col, row)
        for row, line in enumerate(pattern)
        for col, value in enumerate(line)
        if value == "1"
    ]

    for col, row in lit_cells:
        x = base_x + col * block
        y = base_y + row * block
        rect(canvas, x + shadow_dx, y + shadow_dy, block + 1, block + 1, font["shadow"])

    for col, row in lit_cells:
        x = base_x + col * block
        y = base_y + row * block
        rect(canvas, x - 1, y - 1, block + 2, block + 2, font["outline"])

    for col, row in lit_cells:
        x = base_x + col * block
        y = base_y + row * block
        rect(canvas, x, y, block, block, font["fill"])
        rect(canvas, x, y, 1, 1, font["highlight"])


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def write_png(
    path: Path,
    canvas: list[list[tuple[int, int, int, int]]],
) -> None:
    height = len(canvas)
    width = len(canvas[0])
    rows = bytearray()
    for row in canvas:
        rows.append(0)
        for r, g, b, a in row:
            rows.extend((r, g, b, a))

    data = b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
            png_chunk(b"IDAT", zlib.compress(bytes(rows), 9)),
            png_chunk(b"IEND", b""),
        ]
    )
    path.write_bytes(data)


def build_font(font: dict[str, object]) -> Path:
    width = int(font["cell_width"]) * len(GLYPHS)
    height = int(font["cell_height"])
    canvas = empty_canvas(width, height)
    for index, glyph in enumerate(GLYPHS):
        draw_glyph(canvas, glyph, index, font)

    path = OUT_DIR / str(font["filename"])
    write_png(path, canvas)
    return path


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for font in FONTS:
        path = build_font(font)
        print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
