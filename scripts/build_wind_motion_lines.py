#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public/assets/wind-motion-lines-sprite.png"

FRAME_COUNT = 8
FRAME_WIDTH = 32
FRAME_HEIGHT = 20
SCALE = 4


def draw_tapered_line(draw: ImageDraw.ImageDraw, points, color, width: int) -> None:
    for index in range(len(points) - 1):
        t = index / max(1, len(points) - 2)
        segment_width = max(1, round(width * (1 - t * 0.55)))
        draw.line([points[index], points[index + 1]], fill=color, width=segment_width)


def draw_frame(sheet: Image.Image, frame: int) -> None:
    ox = frame * FRAME_WIDTH * SCALE
    phase = frame / (FRAME_COUNT - 1)
    offset = round(phase * 10 * SCALE)
    draw = ImageDraw.Draw(sheet, "RGBA")

    lines = [
        {
            "y": 4.2,
            "length": 22,
            "alpha": 132,
            "width": 1.75,
            "x": 5,
            "curve": -1.3,
        },
        {
            "y": 9.0,
            "length": 26,
            "alpha": 156,
            "width": 2.1,
            "x": 1.5,
            "curve": 0.5,
        },
        {
            "y": 14.0,
            "length": 17,
            "alpha": 106,
            "width": 1.45,
            "x": 9,
            "curve": 1.0,
        },
    ]

    for line in lines:
        x0 = ox + (line["x"] * SCALE) - offset
        x1 = x0 + (line["length"] * SCALE)
        y = line["y"] * SCALE
        curve = line["curve"] * SCALE
        points = [
            (x0, y),
            (x0 + (x1 - x0) * 0.38, y + curve),
            (x0 + (x1 - x0) * 0.73, y - curve * 0.25),
            (x1, y),
        ]
        shadow_points = [(px, py + 0.55 * SCALE) for px, py in points]
        shadow_color = (16, 83, 104, max(0, round(line["alpha"] * 0.42)))
        draw_tapered_line(draw, shadow_points, shadow_color, round((line["width"] + 0.45) * SCALE))

        color = (238, 255, 255, line["alpha"])
        draw_tapered_line(draw, points, color, round(line["width"] * SCALE))

        tip_alpha = max(0, line["alpha"] - 36)
        draw.ellipse(
            (
                x1 - 0.8 * SCALE,
                y - 0.45 * SCALE,
                x1 + 0.35 * SCALE,
                y + 0.45 * SCALE,
            ),
            fill=(252, 255, 255, tip_alpha),
        )


def main() -> None:
    sheet = Image.new("RGBA", (FRAME_WIDTH * FRAME_COUNT * SCALE, FRAME_HEIGHT * SCALE), (0, 0, 0, 0))
    for frame in range(FRAME_COUNT):
        draw_frame(sheet, frame)

    sheet = sheet.filter(ImageFilter.GaussianBlur(0.16 * SCALE))
    sheet = sheet.resize((FRAME_WIDTH * FRAME_COUNT, FRAME_HEIGHT), Image.Resampling.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT)
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
