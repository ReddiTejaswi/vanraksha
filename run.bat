@echo off
set "PYTHON=python"
if exist "%LocalAppData%\Programs\Python\Python310\python.exe" set "PYTHON=%LocalAppData%\Programs\Python\Python310\python.exe"
py -3 --version >nul 2>&1
if not errorlevel 1 set "PYTHON=py -3"
%PYTHON% -m pip install -r requirements.txt
if errorlevel 1 exit /b 1
%PYTHON% -m uvicorn backend.main:app --host 127.0.0.1 --port 8765
