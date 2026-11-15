@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
:loop
.venv\Scripts\python wa_sender.py
echo WhatsApp sender stopped - restarting in 15 seconds
timeout /t 15 /nobreak >nul
goto loop
