#!/usr/bin/env python3
from __future__ import annotations

import colorsys
from pathlib import Path

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/assets/runner/runner-source-electric-blue-transparent.png"
OUT_DIR = ROOT / "public/assets/runner"

FRAME_COUNT = 6
FRAME_WIDTH = 32
FRAME_HEIGHT = 40
TARGET_VISIBLE_HEIGHT = 38

HEADBANDS = [
    ("electric-blue", "#008CFF"),
    ("neon-green", "#00E85A"),
    ("hot-pink", "#FF2BBD"),
    ("sun-yellow", "#FFE500"),
    ("orange", "#FF7A00"),
    ("violet", "#8A2BFF"),
    ("cyan", "#00E5FF"),
    ("red", "#FF1744"),
]


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("source frame has no opaque pixels")
    return bbox


def normalize_sheet(source: Image.Image) -> Image.Image:
    source = source.convert("RGBA")
    cell_width = source.width // FRAME_COUNT
    if cell_width * FRAME_COUNT != source.width:
        raise ValueError(f"source width {source.width} is not divisible by {FRAME_COUNT}")

    sheet = Image.new("RGBA", (FRAME_WIDTH * FRAME_COUNT, FRAME_HEIGHT), (0, 0, 0, 0))
    for frame in range(FRAME_COUNT):
        cell = source.crop((frame * cell_width, 0, (frame + 1) * cell_width, source.height))
        bbox = alpha_bbox(cell)
        sprite = cell.crop(bbox)
        scale = TARGET_VISIBLE_HEIGHT / sprite.height
        centroid_x = alpha_centroid_x(sprite)
        new_size = (
            max(1, round(sprite.width * scale)),
            max(1, round(sprite.height * scale)),
        )
        sprite = sprite.resize(new_size, Image.Resampling.LANCZOS)
        frame_image = Image.new("RGBA", (FRAME_WIDTH, FRAME_HEIGHT), (0, 0, 0, 0))
        x = round(FRAME_WIDTH / 2 - centroid_x * scale)
        y = FRAME_HEIGHT - new_size[1] - 1
        composite_clipped(frame_image, sprite, x, y)
        sheet.alpha_composite(frame_image, (frame * FRAME_WIDTH, 0))
    clean_chroma_residue(sheet)
    return sheet


def alpha_centroid_x(image: Image.Image) -> float:
    alpha = image.getchannel("A")
    total = 0
    weighted = 0
    for y in range(alpha.height):
        for x in range(alpha.width):
            value = alpha.getpixel((x, y))
            total += value
            weighted += x * value
    return weighted / total if total else image.width / 2


def composite_clipped(dest: Image.Image, src: Image.Image, x: int, y: int) -> None:
    src_left = max(0, -x)
    src_top = max(0, -y)
    src_right = min(src.width, dest.width - x)
    src_bottom = min(src.height, dest.height - y)
    if src_right <= src_left or src_bottom <= src_top:
        return

    dest.alpha_composite(
        src.crop((src_left, src_top, src_right, src_bottom)),
        (max(0, x), max(0, y)),
    )


def clean_chroma_residue(image: Image.Image) -> None:
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, alpha = pixels[x, y]
            if alpha > 0 and r > 145 and b > 130 and g < 105:
                pixels[x, y] = (0, 0, 0, 0)


def parse_hex(hex_color: str) -> tuple[int, int, int]:
    value = hex_color.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def is_headband_seed_pixel(r: int, g: int, b: int, alpha: int) -> bool:
    if alpha < 20:
        return False
    h, lightness, saturation = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    hue = h * 360
    value = max(r, g, b) / 255
    return 178 <= hue <= 232 and saturation >= 0.45 and value >= 0.45 and b > r * 1.2


def build_headband_mask(sheet: Image.Image) -> Image.Image:
    mask = Image.new("L", sheet.size, 0)
    pixels = sheet.load()
    mask_pixels = mask.load()
    for y in range(sheet.height):
        for x in range(sheet.width):
            if is_headband_seed_pixel(*pixels[x, y]):
                mask_pixels[x, y] = 255
    return mask.filter(ImageFilter.MaxFilter(3))


def recolor_headband(sheet: Image.Image, mask: Image.Image, hex_color: str) -> Image.Image:
    target_r, target_g, target_b = parse_hex(hex_color)
    target_h, _target_l, target_s = colorsys.rgb_to_hls(
        target_r / 255, target_g / 255, target_b / 255
    )

    image = sheet.copy()
    pixels = image.load()
    mask_pixels = mask.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, alpha = pixels[x, y]
            if alpha < 20 or mask_pixels[x, y] == 0:
                continue

            _h, lightness, saturation = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            new_r, new_g, new_b = colorsys.hls_to_rgb(
                target_h,
                lightness,
                min(1, max(saturation, target_s * 0.92)),
            )
            pixels[x, y] = (
                round(new_r * 255),
                round(new_g * 255),
                round(new_b * 255),
                alpha,
            )
    return image


def main() -> None:
    if not SOURCE.exists():
        raise FileNotFoundError(SOURCE)

    base_sheet = normalize_sheet(Image.open(SOURCE))
    headband_mask = build_headband_mask(base_sheet)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    base_sheet.save(OUT_DIR / "runner-base-blue.png")

    for name, color in HEADBANDS:
        out = recolor_headband(base_sheet, headband_mask, color)
        out.save(OUT_DIR / f"runner-{name}.png")
        print(f"wrote public/assets/runner/runner-{name}.png")


if __name__ == "__main__":
    main()
