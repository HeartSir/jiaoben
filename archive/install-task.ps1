$action = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "D:\desktop\projects\venue-deploy\book.js"
$trigger = New-ScheduledTaskTrigger -Daily -At 08:28
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

Register-ScheduledTask -TaskName "VenueBooking" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force

Write-Host "✅ 任务计划安装成功！每天 8:28 自动抢场"
Write-Host "  运行 schtasks /run /tn VenueBooking 立即测试"
