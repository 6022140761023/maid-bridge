@echo off
setlocal enabledelayedexpansion
set PORT=8788
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  echo killing PID %%p on port %PORT%
  taskkill /PID %%p /F >nul 2>&1
  set FOUND=1
)
if "!FOUND!"=="0" echo nothing listening on port %PORT%
endlocal
