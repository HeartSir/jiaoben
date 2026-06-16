@echo off
REM =============================================
REM  🏸 每日自动抢场 - Windows 任务计划程序
REM
REM  用法：以管理员身份运行此脚本一次即可
REM  之后每天 8:28 自动执行 book.js
REM  电脑锁屏/未登录也能运行
REM =============================================

cd /d "%~dp0"

echo ========================================
echo  🏸 安装每日抢场任务计划
echo ========================================
echo.
echo  脚本路径: %~dp0book.js
echo  执行时间: 每天 8:28
echo.

REM 删除旧任务（如果有）
schtasks /delete /tn "VenueBooking" /f 2>nul

REM 创建新任务
schtasks /create /tn "VenueBooking" ^
  /tr "\"C:\Program Files\nodejs\node.exe\" \"%~dp0book.js\"" ^
  /sc daily /st 08:28 ^
  /ru SYSTEM ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% EQU 0 (
  echo.
  echo ✅ 任务计划安装成功！
  echo.
  echo   📅 每天 8:28 自动执行
  echo   💻 锁屏/未登录状态也有效
  echo   📍 %~dp0book.js
  echo.
  echo   ⚡ 要测试运行，请执行：
  echo      schtasks /run /tn VenueBooking
) else (
  echo.
  echo ❌ 安装失败，请以管理员身份运行！
  pause
)
