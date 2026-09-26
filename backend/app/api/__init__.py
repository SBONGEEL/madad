"""موجّه مستقل لكل جمهور (§11.1). حرّاس العزل في tests/api سبقت أول نقطة هنا."""
from __future__ import annotations

from app.api import admin, auth, customer, driver, media, supplier

routers = [auth.router, customer.router, supplier.router, driver.router, admin.router, media.router]
