@echo off
py -3 -m pip install -r requirements.txt
if errorlevel 1 exit /b 1
py -3 -m uvicorn backend.main:app --reload
