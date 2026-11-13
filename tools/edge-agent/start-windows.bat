@echo off
rem يشغّل جهاز التحليل ويعيد تشغيله تلقائياً إن توقف.
cd /d "%~dp0"
if not exist .venv (
  python -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
:loop
.venv\Scripts\python agent.py
echo توقف الجهاز — إعادة التشغيل بعد 10 ثوان
timeout /t 10 /nobreak >nul
goto loop
