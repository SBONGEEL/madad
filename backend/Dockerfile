# مَدَد — صورة الخلفية (§14). سياق البناء: مجلد backend.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Africa/Tripoli

WORKDIR /app

# حزم WeasyPrint (§14) هنا لا في بيئة التطوير، وفحص الإقلاع يصيح إن نقص منها شيء.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libcairo2 libgdk-pixbuf-2.0-0 fontconfig \
 && rm -rf /var/lib/apt/lists/*

# خطّا الهوية داخل الصورة: Tajawal للعربية وInter للأرقام واللاتينية.
COPY app/pdf/fonts/ /usr/share/fonts/truetype/madad/
RUN fc-cache -f

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
