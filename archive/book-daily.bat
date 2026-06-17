@echo off
REM =============================================
REM  🏸 每日自动抢场 - Windows 任务计划程序用
REM  用法：让 Task Scheduler 每天 8:28 执行此文件
REM =============================================

cd /d "D:\desktop\venue-deploy"

REM 日志文件
set LOGFILE=book-%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%.log

echo [%TIME%] ========== 开始抢场 ========== >> %LOGFILE%
node book.js >> %LOGFILE% 2>&1
echo [%TIME%] ========== 结束 ========== >> %LOGFILE%
echo. >> %LOGFILE%
