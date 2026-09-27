# مَدَد — قواعد جدار حماية ويندوز لخوادم التطوير (طلب المالك 27/09). تُشغَّل بصلاحية المسؤول مرة واحدة.
# تسمح بالمنافذ 5181–5184 من الشبكة المحلية الخاصة وحدها (Private + LocalSubnet)، وتحجبها — ومعها 8000 — على
# الشبكات العامة وشبكات النطاق حجباً صريحاً يغلب أي سماح آخر (قاعدة Docker Desktop على Public مثلاً).
$ErrorActionPreference = "Stop"
Get-NetFirewallRule -Group "MADAD dev" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Group "MADAD dev" -DisplayName "MADAD dev - apps on home network (Private only)" -Direction Inbound `
  -Protocol TCP -LocalPort 5181-5184 -Profile Private -RemoteAddress LocalSubnet -Action Allow | Out-Null
New-NetFirewallRule -Group "MADAD dev" -DisplayName "MADAD dev - block on public networks" -Direction Inbound `
  -Protocol TCP -LocalPort 5181-5184,8000 -Profile Public,Domain -Action Block | Out-Null
Get-NetFirewallRule -Group "MADAD dev" | Select-Object DisplayName, Profile, Action | Format-Table -AutoSize | Out-String | Write-Output
