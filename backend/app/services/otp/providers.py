"""مزوّدو قنوات الرمز (م-23، م-24) خلف واجهة واحدة.

كل مزوّد يقرأ إعداده من البيئة وحدها (MADAD_OTP_<القناة>_*) ولا يفترض مفتاحاً: غياب
أيّ متغير لازم = القناة «غير مضبوطة»، فتُتخطّى ويعرض اللوح ذلك. لا سرّ في القاعدة ولا المستودع.
تبديل المزوّد = تغيير MADAD_OTP_<القناة>_PROVIDER ومتغيراته، بلا تغيير في الشيفرة الأخرى.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol

import httpx

TIMEOUT = httpx.Timeout(10.0)


class ProviderError(Exception):
    """فشل الإرسال عبر القناة: يُسجَّل، ويُبلَّغ المالك، ويُنتقل للقناة التالية."""


class Provider(Protocol):
    name: str

    async def send(self, phone: str, code: str) -> None: ...


def _env(*keys: str) -> dict[str, str] | None:
    vals = {k: os.environ.get(k, "") for k in keys}
    return vals if all(vals.values()) else None


def message(code: str) -> str:
    return f"رمز مَدَد: {code}\nلا تشاركه مع أحد. صالح 5 دقائق."


# ——— واتساب الرسمي ——————————————————————————————————————————————————————————
@dataclass
class MetaCloud:
    """WhatsApp Cloud API من Meta مباشرة: قالب مصادقة معتمد برمز."""
    token: str
    phone_number_id: str
    template: str
    name: str = "whatsapp_official:meta"

    async def send(self, phone: str, code: str) -> None:
        body = {"messaging_product": "whatsapp", "to": phone.lstrip("+"), "type": "template",
                "template": {"name": self.template, "language": {"code": "ar"},
                             "components": [{"type": "body", "parameters": [{"type": "text", "text": code}]},
                                            {"type": "button", "sub_type": "url", "index": "0",
                                             "parameters": [{"type": "text", "text": code}]}]}}
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.post(f"https://graph.facebook.com/v21.0/{self.phone_number_id}/messages",
                             headers={"Authorization": f"Bearer {self.token}"}, json=body)
        if r.status_code >= 300:
            raise ProviderError(f"meta {r.status_code}: {r.text[:200]}")


@dataclass
class TwilioWhatsApp:
    """واتساب عبر Twilio (قالب محتوى معتمد)."""
    sid: str
    token: str
    sender: str
    content_sid: str
    name: str = "whatsapp_official:twilio"

    async def send(self, phone: str, code: str) -> None:
        async with httpx.AsyncClient(timeout=TIMEOUT, auth=(self.sid, self.token)) as c:
            r = await c.post(f"https://api.twilio.com/2010-04-01/Accounts/{self.sid}/Messages.json",
                             data={"From": f"whatsapp:{self.sender}", "To": f"whatsapp:{phone}",
                                   "ContentSid": self.content_sid, "ContentVariables": f'{{"1":"{code}"}}'})
        if r.status_code >= 300:
            raise ProviderError(f"twilio {r.status_code}: {r.text[:200]}")


# ——— رقم واتساب عادي عبر البوابة (gateway/whatsapp-linked) ——————————————————————
@dataclass
class LinkedGateway:
    url: str
    token: str
    name: str = "whatsapp_linked:gateway"

    async def send(self, phone: str, code: str) -> None:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.post(f"{self.url.rstrip('/')}/send", headers={"Authorization": f"Bearer {self.token}"},
                             json={"phone": phone, "text": message(code)})
        if r.status_code >= 300:
            raise ProviderError(f"gateway {r.status_code}: {r.text[:200]}")


# ——— SMS عبر مزوّد ليبي (م-23) ——————————————————————————————————————————————
@dataclass
class HttpSms:
    """واجهة HTTP عامة: عناوين مزوّدي الرسائل الليبيين تختلف، فتُضبط الحقول من البيئة
    عند فتح الحساب (العنوان، واسم حقل الرقم والنص والمرسِل، ورأس المصادقة)."""
    url: str
    auth_header: str
    auth_value: str
    sender: str
    to_field: str = "to"
    text_field: str = "text"
    sender_field: str = "sender"
    name: str = "sms:http"

    async def send(self, phone: str, code: str) -> None:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.post(self.url, headers={self.auth_header: self.auth_value},
                             json={self.to_field: phone, self.text_field: message(code),
                                   self.sender_field: self.sender})
        if r.status_code >= 300:
            raise ProviderError(f"sms {r.status_code}: {r.text[:200]}")


def configured(channel: str) -> Provider | None:
    """المزوّد المضبوط للقناة، أو None."""
    p = f"MADAD_OTP_{channel.upper()}_"
    kind = os.environ.get(p + "PROVIDER", "")
    if channel == "whatsapp_official" and kind == "meta":
        e = _env(p + "TOKEN", p + "PHONE_NUMBER_ID", p + "TEMPLATE")
        return e and MetaCloud(e[p + "TOKEN"], e[p + "PHONE_NUMBER_ID"], e[p + "TEMPLATE"])
    if channel == "whatsapp_official" and kind == "twilio":
        e = _env(p + "SID", p + "TOKEN", p + "SENDER", p + "CONTENT_SID")
        return e and TwilioWhatsApp(e[p + "SID"], e[p + "TOKEN"], e[p + "SENDER"], e[p + "CONTENT_SID"])
    if channel == "whatsapp_linked" and kind == "gateway":
        e = _env(p + "URL", p + "TOKEN")
        return e and LinkedGateway(e[p + "URL"], e[p + "TOKEN"])
    if channel == "sms" and kind == "http":
        e = _env(p + "URL", p + "AUTH_HEADER", p + "AUTH_VALUE", p + "SENDER")
        if not e:
            return None
        return HttpSms(e[p + "URL"], e[p + "AUTH_HEADER"], e[p + "AUTH_VALUE"], e[p + "SENDER"],
                       os.environ.get(p + "TO_FIELD") or "to", os.environ.get(p + "TEXT_FIELD") or "text",
                       os.environ.get(p + "SENDER_FIELD") or "sender")
    return None
