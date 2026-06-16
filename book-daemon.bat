@echo off
REM 🏸 每日抢场守护脚本 - 无需管理员权限
REM 放到启动项：%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\

cd /d "D:\desktop\projects\venue-deploy"

:TICK
set HOUR=%TIME:~0,2%
set MIN=%TIME:~3,2%
set SEC=%TIME:~6,2%

REM 去掉前导空格
if "%HOUR:~0,1%"==" " set HOUR=0%HOUR:~1,1%

if "%HOUR%"=="08" if "%MIN%"=="28" if "%SEC%"=="00" (
  echo [%DATE% %TIME%] ⏰ 开始抢场! >> book-launcher.log
  start /min "VenueBooking" node.exe book.js
  timeout /t 60 /nobreak >nul
)

timeout /t 1 /nobreak >nul
goto TICK
