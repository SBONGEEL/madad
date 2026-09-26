"""توليد PDF بـWeasyPrint (§10، §14). ثلاثة قوالب منفصلة: عميل، مورد، سائق.

العزل بنيوي: كل قالب يُملأ من مخطط خرج جمهوره نفسه (الذي يخرج في JSON)، لا من
صفوف القاعدة. فما لا يحمله المخطط لا يصل إلى الـPDF، ويُختبر ذلك على بايتات
الـPDF المولَّد لا على HTML قبله.
"""
from __future__ import annotations

import base64
import html
import pathlib
from functools import lru_cache
from string import Template
from typing import Any

DIR = pathlib.Path(__file__).resolve().parent.parent / "pdf"


class PdfUnavailable(RuntimeError):
    """WeasyPrint أو حزمه أو الخط غائب. يوقف الإقلاع بصراحة."""


def esc(value: object) -> str:
    return html.escape("" if value is None else str(value))


@lru_cache
def _file(name: str) -> str:
    return (DIR / name).read_text(encoding="utf-8")


@lru_cache
def _logo() -> str:
    return "data:image/svg+xml;base64," + base64.b64encode((DIR / "logo.svg").read_bytes()).decode()


def fill(template: str, **values: Any) -> str:
    """كل قيمة تمرّ على esc إلا ما سُمّي html_* (نصّ HTML بنته دالة هنا من قيم مهرَّبة)."""
    return Template(_file(template)).substitute(
        {k: (v if k.startswith("html_") or k in ("rows", "stops") else esc(v)) for k, v in values.items()})


def render(*, title: str, body: str, uncompressed: bool = False) -> bytes:
    try:
        from weasyprint import HTML
    except Exception as exc:  # حزم النظام الناقصة تسقط هنا عند الاستيراد
        raise PdfUnavailable(f"WeasyPrint لا يعمل: {exc}") from exc
    document = Template(_file("base.html")).substitute(
        title=esc(title), tokens=_file("tokens.css"), logo=_logo(), body=body)
    return HTML(string=document).write_pdf(uncompressed_pdf=uncompressed)


def rows(cells: list[list[object]], numeric_from: int = 1) -> str:
    out = []
    for r in cells:
        tds = "".join(f'<td class="n num">{esc(c)}</td>' if i >= numeric_from else f"<td>{esc(c)}</td>"
                      for i, c in enumerate(r))
        out.append(f"<tr>{tds}</tr>")
    return "\n".join(out)


def self_check() -> None:
    """عند الإقلاع: PDF عربي صغير، ويتحقق أن خطّي الهوية ضُمِّنا فعلاً."""
    data = render(title="فحص الإقلاع", body="<p>مَدَد — فحص PDF</p><p class='num'>1,250.000</p>", uncompressed=True)
    if not data.startswith(b"%PDF"):
        raise PdfUnavailable("المخرج ليس PDF")
    for font in (b"Tajawal", b"Inter"):
        if font not in data:
            raise PdfUnavailable(f"الخط {font.decode()} لم يُضمَّن — تحقق من تثبيته داخل الصورة")
