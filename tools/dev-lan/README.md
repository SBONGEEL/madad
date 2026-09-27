# خوادم التطوير على شبكة البيت (طلب المالك 27/09)

- `docker-compose.yml`: خلفية التطوير (`madad-dev-api`) والواجهات الأربع مبنيّةً خلف nginx (`madad-dev-web`) على
  المنافذ 5181 (اللوحة) و5182 (العميل) و5183 (المورد) و5184 (السائق). `restart: always`: تقوم مع Docker كل مرة.
  الخلفية بلا منفذ على الشبكة؛ `/api` يمرّ عبر nginx.
- `.env` محلي لا يُرفع: `MADAD_DATABASE_URL` (المضيف `madad-pg` على شبكة `madad-dev`) و`MADAD_JWT_SECRET`.
- `firewall.ps1` (مرة، بصلاحية المسؤول): يسمح بـ5181–5184 من الشبكة الخاصة المحلية وحدها، ويحجبها مع 8000 على العامة.

تهيئة أول مرة:
```
docker network create madad-dev
docker network connect madad-dev madad-pg
docker update --restart always madad-pg
docker compose up -d          # من هذا المجلد
```

نسخ التطوير للهاتف: `MADAD_SHELL=dev npx cap sync android` في كل تطبيق ثم `gradlew assembleDebug`. الغلاف
(`ui/dev-shell`) يجد الحاسوب: آخر عنوان ← `<اسم الحاسوب>.local` ← بحث في الشبكة ← خانة يدوية (ضغطة طويلة على الشعار).
نسخ الإنتاج بلا `MADAD_SHELL`، و`npm run check:shell` يثبت أنها خالية من الغلاف ومن أي عنوان محلي.
