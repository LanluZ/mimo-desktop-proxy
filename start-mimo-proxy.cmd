@echo off
setlocal
set "DIR=%~dp0"
set "INSPECT=9229"
set "PROXY=8800"

call "%DIR%resolve-env.cmd"
if not defined NODE (
  echo [!] Node.js not found. Install Node ^>= 18 from nodejs.org, or set MIMO_NODE=C:\path\to\node.exe
  exit /b 1
)

rem --- 1. MiMo Desktop must run with --inspect so we can read its runtime cookies
powershell -NoProfile -Command "try{Invoke-RestMethod http://127.0.0.1:%INSPECT%/json/version -TimeoutSec 2|Out-Null;exit 0}catch{exit 1}"
if errorlevel 1 (
  if not defined APP (
    echo [!] MiMo Desktop is not running with --inspect, and its .exe could not be located.
    echo     Set MIMO_APP=C:\path\to\Xiaomi MiMo.exe and retry.
    exit /b 1
  )
  echo [1/3] no inspector on :%INSPECT% - restarting MiMo Desktop with --inspect...
  powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -like 'Xiaomi MiMo*' } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; Start-Process '%APP%' -ArgumentList '--inspect=%INSPECT%','--remote-debugging-port=9222'"
  powershell -NoProfile -Command "for($i=0;$i -lt 45;$i++){try{Invoke-RestMethod http://127.0.0.1:%INSPECT%/json/version -TimeoutSec 2|Out-Null;exit 0}catch{Start-Sleep -Seconds 1}};exit 1"
  if errorlevel 1 ( echo [!] MiMo Desktop did not come up with the inspector & exit /b 1 )
) else (
  echo [1/3] inspector on :%INSPECT% OK
)

rem --- 2. pull the login cookies out of the running app
echo [2/3] pulling login cookies...
"%NODE%" "%DIR%pull_cookies.mjs" "%DIR%cookies.json" %INSPECT%
if errorlevel 1 ( echo [!] cookie pull failed & exit /b 1 )

rem --- 3. start the proxy if it is not already up
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PROXY%/v1/models -TimeoutSec 2|Out-Null;exit 0}catch{exit 1}"
if errorlevel 1 (
  echo [3/3] starting proxy...
  start "mimo-proxy" /min cmd /c ""%NODE%" "%DIR%proxy.mjs" 1>>"%DIR%proxy.log" 2>&1"
  ping -n 4 127.0.0.1 >nul
) else (
  echo [3/3] proxy already running on :%PROXY%
)

echo.
echo ready: http://127.0.0.1:%PROXY%/v1   (models: mimo-pro, mimo-flash)
echo check: curl http://127.0.0.1:%PROXY%/health
endlocal
