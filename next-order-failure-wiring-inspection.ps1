Write-Host "===== ORDER SERVICE ====="
Get-Content .\src\oms\order\order.service.ts

Write-Host "`n===== ORDER MODULE ====="
Get-Content .\src\oms\order\order.module.ts

Write-Host "`n===== INVENTORY SERVICE RESERVATION PATH ====="
$path = ".\src\oms\inventory\inventory.service.ts"
$lines = Get-Content $path
$start = ($lines | Select-String -Pattern "async reserveOrder" | Select-Object -First 1).LineNumber
if ($start) {
  $from = [Math]::Max(1, $start - 20)
  $to = [Math]::Min($lines.Count, $start + 180)
  $lines[($from-1)..($to-1)]
}

Write-Host "`n===== ORDER FAILURE EXCEPTION SERVICE ====="
Get-Content .\src\oms\order\order-failure-exception.service.ts

Write-Host "`n===== ORDER FAILURE EXCEPTION MODULE/WIRING ====="
Get-ChildItem .\src\oms -Recurse -File -Include *.ts |
  Where-Object { $_.FullName -match "order|exception" } |
  ForEach-Object {
    Write-Host "`n--- $($_.FullName) ---"
    Get-Content $_.FullName
  }
