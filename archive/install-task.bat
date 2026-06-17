@echo off
REM =============================================
REM  🏸 每日自动抢场 - Windows 任务计划程序
REM  自动提权，直接双击运行即可
REM =============================================

cd /d "%~dp0"

REM 检测是否管理员，不是则自动提权
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo 请求管理员权限...
  powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c \"%~f0\"' -Verb RunAs"
  exit /b
)

echo ========================================
echo  🏸 安装每日抢场任务计划
echo ========================================
echo.

REM 删除旧任务
schtasks /delete /tn "VenueBooking" /f >nul 2>&1

REM 创建新任务（使用 8.3 短路径避免空格问题）
schtasks /create /tn "VenueBooking" ^
  /tr "\"C:\Progra~1\nodejs\node.exe\" \"%~dp0book.js\"" ^
  /sc daily /st 08:28 ^
  /ru SYSTEM ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% EQU 0 (
  echo ✅ 任务计划安装成功！
  echo.
  echo   📅 每天 8:28 自动抢场
  echo   💻 锁屏/睡眠自动唤醒执行
  echo   📍 %~dp0book.js
  echo.
  echo   按任意键立即测试运行...
  pause >nul
  schtasks /run /tn VenueBooking
  echo 已触发，查看结果请去任务计划程序确认。
) else (
  echo ❌ 安装失败！
  pause
)
