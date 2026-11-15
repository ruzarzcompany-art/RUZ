@echo off
chcp 65001 >nul
copy /y "C:\sijil-edge\sijil-edge-startup.bat" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\sijil-edge-startup.bat"
if errorlevel 1 (echo FAILED) else (echo DONE - the camera agent will start with Windows)
echo.
pause
