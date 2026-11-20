@echo off
REM One-click launcher for Compakta.
REM Starts the server, waits for it to answer, then opens your browser.

setlocal
cd /d "%~dp0"

where bun >nul 2>&1
if errorlevel 1 (
  echo.
  echo   bun is not installed or not on PATH.
  echo   Install it from https://bun.sh  ^(Windows: powershell -c "irm bun.sh/install.ps1 ^| iex"^)
  echo.
  pause
  exit /b 1
)

echo Starting Compakta...
echo.

REM Run detached so this window can close and the server keeps going. A cmd
REM wrapper captures bun's output in .server.log / .server.err (both ignored)
REM so a failed start can be diagnosed from this window below. Closing the
REM minimised "Compakta" window still stops the server.
start "Compakta" /min cmd /c "bun run src\server.ts > .server.log 2> .server.err"

REM Wait for the port to answer before opening a browser. A user-preset PORT
REM is honoured; only when it is unset does the launcher assume the default.
if "%PORT%"=="" set PORT=5178
for /l %%i in (1,1,40) do (
  curl -s --noproxy "127.0.0.1" -o nul -w "" http://127.0.0.1:%PORT%/api/status && goto ready
  timeout /t 1 /nobreak >nul
)

REM The probe never answered: report and keep this window open. Never claim
REM the server is up, and never point a browser at a dead URL.
echo The server did not answer on port %PORT% within 40 seconds.
echo.
echo   URL that failed:  http://127.0.0.1:%PORT%
echo   Server window:    the minimised "Compakta" window - if it has
echo                     closed, the server exited and its error is below.
echo.
call :showlog ".server.err"
call :showlog ".server.log"
echo   If the minimised window is still open, give it a moment and open
echo   http://127.0.0.1:%PORT% manually. Otherwise fix the error above and
echo   either run start.bat again, or see the error live in this window:
echo     bun start
echo.
pause
exit /b 1

:ready
echo Server is up: http://127.0.0.1:%PORT%
start "" http://127.0.0.1:%PORT%
echo Browser opened. Close the minimised "Compakta" window to stop the server.
echo.
pause
exit /b 0

REM Show a log only when it exists and is non-empty; a clean start has none.
:showlog
if exist %1 (
  for %%A in (%1) do (
    if %%~zA gtr 0 (
      echo   --- %~1 ---
      type %1
      echo.
    )
  )
)
exit /b 0
