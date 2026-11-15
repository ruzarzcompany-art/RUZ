@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Installing WhatsApp sender...
.venv\Scripts\python -m pip install --upgrade neonize python-magic-bin
if errorlevel 1 (echo FAILED) else (echo DONE - now run whatsapp-start)
echo.
pause
