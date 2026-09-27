"""يولّد أيقونات أندرويد (mipmap بكل كثافة، وتكيّفية) وأيقونة اللوحة للتثبيت، من design/app-icons/*.svg.

  python design/app-icons/build_icons.py        (من جذر المستودع؛ يحتاج Chrome للرسم وPillow)
"""
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "design" / "app-icons"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
BG = {}


def render(svg: str, size: int = 1024) -> Image.Image:
    with tempfile.TemporaryDirectory() as t:
        src, png = Path(t) / "i.html", Path(t) / "i.png"
        src.write_text(f'<html><body style="margin:0;background:transparent">{svg.replace(chr(34) + "512" + chr(34), chr(34) + str(size) + chr(34), 2)}</body></html>',
                       encoding="utf-8")
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
                        f"--window-size={size},{size}", f"--screenshot={png}", src.as_uri()], check=True, capture_output=True)
        return Image.open(png).convert("RGBA").copy()


def build(app: str) -> None:
    svg = (HERE / f"{app}.svg").read_text(encoding="utf-8")
    bg = re.search(r'<rect width="512" height="512" rx="112" fill="([^"]+)"/>', svg).group(1)
    full = render(svg)
    # المحتوى بلا الخلفية المدوّرة: للطبقة الأمامية في الأيقونة التكيّفية والمستديرة
    bare = render(re.sub(r'<rect width="512" height="512" rx="112" fill="[^"]+"/>(<rect [^>]+/>)?', "", svg))
    if app == "admin":
        full.resize((512, 512), Image.LANCZOS).save(ROOT / "brand" / "madad-pwa-512.png")
        full.resize((192, 192), Image.LANCZOS).save(ROOT / "brand" / "madad-pwa-192.png")
        return
    res = ROOT / app / "android" / "app" / "src" / "main" / "res"
    for d, k in DENS.items():
        n, fg = round(48 * k), round(108 * k)
        out = res / f"mipmap-{d}"
        full.resize((n, n), Image.LANCZOS).save(out / "ic_launcher.png")
        # مستديرة: دائرة بلون الخلفية والمحتوى نفسه
        r = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        ImageDraw.Draw(r).ellipse((0, 0, 1023, 1023), fill=bg)
        r.alpha_composite(bare.resize((880, 880), Image.LANCZOS), (72, 72))
        r.resize((n, n), Image.LANCZOS).save(out / "ic_launcher_round.png")
        # تكيّفية: المحتوى في المنطقة الآمنة (66 من 108) على شفاف
        f = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        inner = 560             # الشارة في الركن تبقى داخل دائرة الـ66 مهما كان قناع المشغّل
        f.alpha_composite(bare.resize((inner, inner), Image.LANCZOS), ((1024 - inner) // 2, (1024 - inner) // 2))
        f.resize((fg, fg), Image.LANCZOS).save(out / "ic_launcher_foreground.png")
    (res / "values" / "ic_launcher_background.xml").write_text(
        f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">{bg}</color>\n</resources>\n',
        encoding="utf-8")


if __name__ == "__main__":
    for a in ("customer", "supplier", "driver", "admin"):
        build(a)
        print("icons", a)
