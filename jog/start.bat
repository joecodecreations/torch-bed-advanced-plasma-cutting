@echo off
rem Double-click to start the plasma jog controller and open its page.
rem To force a port:  start.bat COM5
cd /d "%~dp0"
title TorchBed

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  python -c "import sys" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python 3 is not installed.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^)
  echo or run:  winget install Python.Python.3.12
  echo Then double-click start.bat again.
  pause
  exit /b 1
)

start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:8790"
%PY% server.py %*
echo.
echo The controller stopped. Close this window, or read the message above.
pause
