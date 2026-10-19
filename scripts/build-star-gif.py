#!/usr/bin/env python3
"""基于仓库真实截图合成 Star 点击引导，不修改 GitHub 账号状态。"""

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = (1200, 760)
ACCENT = (240, 120, 85)
SHOT_ORIGIN = (64, 128)
SHOT_WIDTH = 1072
FPS = 12


def font(size: int) -> ImageFont.FreeTypeFont:
    """从命令行指定的字体绘制宣传文字。"""
    return ImageFont.truetype(ARGS.font, size)


def background() -> Image.Image:
    """绘制低饱和朱砂色背景，让真实仓库截图成为主体。"""
    image = Image.new('RGB', SIZE)
    pixels = image.load()
    # 将暖色限制在画布边缘，避免形成大面积高亮。
    for y in range(SIZE[1]):
        for x in range(SIZE[0]):
            glow = max(0, 1 - ((x - 1080) ** 2 + (y - 80) ** 2) / 1200000)
            pixels[x, y] = (int(23 + 27 * glow), int(21 + 8 * glow), int(22 + 7 * glow))
    return image.convert('RGBA')


def scene() -> Image.Image:
    """保留截图内容及比例，在截图外增加标题与阴影。"""
    frame = background()
    with Image.open(ARGS.source) as source:
        shot = source.convert('RGBA')
        shot = shot.resize((SHOT_WIDTH, round(source.height * SHOT_WIDTH / source.width)), Image.Resampling.LANCZOS)
    # 截图只做比例缩放与圆角裁切，账户指标保持截图原值。
    x, y = SHOT_ORIGIN
    mask = Image.new('L', shot.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, shot.width, shot.height), 12, fill=255)
    shadow = Image.new('RGBA', SIZE)
    ImageDraw.Draw(shadow).rounded_rectangle((x, y + 14, x + shot.width, y + shot.height + 14),
                                             12, fill=(0, 0, 0, 160))
    frame = Image.alpha_composite(frame, shadow.filter(ImageFilter.GaussianBlur(20)))
    frame.paste(shot, (x, y), mask)
    draw = ImageDraw.Draw(frame)
    draw.text((64, 30), 'micro-harness', font=font(26), fill='white')
    draw.text((64, 70), 'Small kernel. Clear execution.', font=font(17), fill=(190, 181, 184))
    draw.text((64, 697), 'Give it a star on GitHub.', font=font(22), fill=ACCENT)
    draw.text((795, 704), 'github.com/AlexZhangUPUPUP/micro-harness', font=font(13), fill=(190, 181, 184))
    return frame


def pointer(draw: ImageDraw.ImageDraw, x: float, y: float, pressed: bool) -> None:
    """绘制清楚可见的鼠标指针，点击时略微收缩。"""
    scale = 0.87 if pressed else 1
    points = [(0, 0), (0, 40), (10, 31), (18, 49), (26, 45), (18, 28), (32, 28)]
    points = [(x + px * scale, y + py * scale) for px, py in points]
    draw.polygon(points, fill=(15, 18, 22, 255))
    draw.line(points + [points[0]], fill='white', width=3, joint='curve')


def feedback(frame: Image.Image, elapsed: float, button: tuple) -> None:
    """合成按钮选中与扩散反馈，仅作用于导出的动画像素。"""
    draw = ImageDraw.Draw(frame)
    left, top, right, bottom = button
    # 不显示递增的 Star 数字，避免把演示效果误认为真实仓库指标。
    draw.rounded_rectangle(button, radius=4, fill=(255, 248, 245), outline=ACCENT, width=1)
    draw.text((left + 8, top + 3), '★ Starred', font=font(13), fill=(165, 67, 43))
    # 点击波纹和粒子随时间衰减，在短暂停留后自然消失。
    if elapsed >= 0.7:
        return
    layer = Image.new('RGBA', SIZE)
    effect = ImageDraw.Draw(layer)
    cx, cy = (left + right) / 2, (top + bottom) / 2
    radius = 10 + elapsed * 60
    alpha = round(210 * (1 - elapsed / 0.7))
    effect.ellipse((cx - radius, cy - radius, cx + radius, cy + radius),
                   outline=(*ACCENT, alpha), width=2)
    for index in range(8):
        angle = index * math.tau / 8
        px, py = cx + math.cos(angle) * radius, cy + math.sin(angle) * radius
        effect.ellipse((px - 2, py - 2, px + 2, py + 2), fill=(*ACCENT, alpha))
    frame.alpha_composite(layer)


def animate(base: Image.Image) -> list[Image.Image]:
    """生成停留、移入、点击、反馈与回到初态的循环帧。"""
    # 按钮坐标相对已裁切的源截图，由实际截图位置明确给定。
    with Image.open(ARGS.source) as source:
        scale = SHOT_WIDTH / source.width
    left, top, right, bottom = ARGS.button
    button = (64 + left * scale, 128 + top * scale, 64 + right * scale, 128 + bottom * scale)
    target = ((button[0] + button[2]) / 2, (button[1] + button[3]) / 2)
    frames = []
    for index in range(60):
        t = index / FPS
        frame = base.copy()
        # 使用平滑曲线让指针从窗口右下方移入 Star 按钮。
        progress = max(0, min(1, (t - 0.5) / 1.3))
        ease = progress * progress * (3 - 2 * progress)
        x = 880 + (target[0] - 880) * ease
        y = 490 + (target[1] - 490) * ease
        if 2 <= t < 4.4:
            feedback(frame, t - 2, button)
        # 末尾淡出指针，再停留到下一轮，避免指针突跳。
        cursor = Image.new('RGBA', SIZE)
        pointer(ImageDraw.Draw(cursor), x, y, 2 <= t < 2.16)
        opacity = min(1, max(0, (4.5 - t) / 0.4))
        cursor.putalpha(cursor.getchannel('A').point(lambda value: round(value * opacity)))
        frame.alpha_composite(cursor)
        frames.append(frame.convert('RGB'))
    return frames


def build() -> None:
    """使用共享调色板导出轻量、可循环的 GIF。"""
    frames = animate(scene())
    # 同时采样未点击及选中状态，保留白色文字和朱砂强调色。
    samples = Image.new('RGB', (600, 380))
    samples.paste(frames[0].resize((300, 190)), (0, 0))
    samples.paste(frames[27].resize((300, 190)), (300, 0))
    samples.paste(frames[40].resize((300, 190)), (0, 190))
    palette = samples.quantize(colors=240)
    reserved = [255, 255, 255, *ACCENT, 15, 18, 22, 255, 248, 245, 165, 67, 43]
    palette.putpalette(reserved + palette.getpalette()[:768 - len(reserved)])
    images = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    # 输出位置由参数控制，源截图始终保留用于复现。
    ARGS.output.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(ARGS.output, save_all=True, append_images=images[1:],
                   duration=80, loop=0, optimize=True, disposal=1)
    print(f'{ARGS.output}: {SIZE}, 4.8s, {ARGS.output.stat().st_size / 1024 / 1024:.2f} MiB')


# 命令行入口显式声明截图、按钮坐标与字体路径。
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('docs/star-repo.png'))
    parser.add_argument('--output', type=Path, default=Path('docs/star.gif'))
    parser.add_argument('--button', nargs=4, type=int, default=(2240, 32, 2416, 88))
    parser.add_argument('--font', default='/System/Library/Fonts/SFNS.ttf')
    ARGS = parser.parse_args()
    build()
