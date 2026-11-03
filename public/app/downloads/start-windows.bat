@echo off
chcp 65001 >nul
cd /d "%~dp0"
:loop
node camera-agent.mjs
echo restarting in 10 seconds...
timeout /t 10 >nul
goto loop
