@echo off
cd /d "%~dp0"
py -3.9 "local_app\server.py"
if errorlevel 1 (
  echo.
  echo Unable to start. Install Python 3.9, then run this file again.
)
pause
