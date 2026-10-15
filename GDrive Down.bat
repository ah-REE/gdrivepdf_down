@echo off
cd /d "%~dp0"
title GDrive Down

where python >nul 2>nul
if errorlevel 1 (
  echo [gdrive_down] Python was not found on PATH.
  echo Install Python 3.10+ and run this file again.
  pause
  exit /b 1
)

python -c "import fastapi, uvicorn, requests, PIL" >nul 2>nul
if errorlevel 1 (
  echo [gdrive_down] First run: installing dependencies ^(one time, a few minutes^)...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [gdrive_down] Dependency install failed. Check your connection and retry.
    pause
    exit /b 1
  )
)

python server.py
pause
