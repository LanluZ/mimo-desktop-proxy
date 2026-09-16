@echo off
setlocal
set "DIR=%~dp0"
set "INSPECT=9229"

call "%DIR%resolve-env.cmd"
if not defined NODE (
  echo [!] Node.js not found. Install Node ^>= 18 from nodejs.org, or set MIMO_NODE=C:\path\to\node.exe
  exit /b 1
)

"%NODE%" "%DIR%pull_cookies.mjs" "%DIR%cookies.json" %INSPECT%
if errorlevel 1 (
  echo.
  echo [!] pull failed. MiMo Desktop must be RUNNING with --inspect=%INSPECT%.
  echo     Either launch it via start-mimo-proxy.cmd, or add --inspect=%INSPECT%
  echo     to the target of your MiMo Desktop shortcut.
  exit /b 1
)
endlocal
