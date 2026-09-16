@echo off
rem Shared path resolution for refresh-cookies.cmd / start-mimo-proxy.cmd.
rem Sets NODE (a Node.js >= 18 exe) and APP (the MiMo Desktop exe) in the
rem CALLER's scope - deliberately no setlocal/endlocal in this file.
rem
rem Override either one by setting it before the call:
rem   set MIMO_NODE=C:\path\to\node.exe
rem   set MIMO_APP=D:\path\to\Xiaomi MiMo.exe

rem ---- NODE: MIMO_NODE > PATH > common install locations --------------------
set "NODE="
if defined MIMO_NODE set "NODE=%MIMO_NODE%"
if not defined NODE for /f "delims=" %%i in ('where.exe node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE for %%p in (
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles%\nodejs\node64.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\node\node.exe"
  "%LOCALAPPDATA%\hermes\node\node.exe"
) do if not defined NODE if exist "%%~p" set "NODE=%%~p"

rem ---- APP: MIMO_APP > uninstall registry > fixed drives > running process ---
set "APP="
if defined MIMO_APP set "APP=%MIMO_APP%"
if not defined APP for %%p in (
  "%ProgramFiles%\Xiaomi MiMo\Xiaomi MiMo.exe"
  "%ProgramFiles(x86)%\Xiaomi MiMo\Xiaomi MiMo.exe"
  "%LOCALAPPDATA%\Programs\Xiaomi MiMo\Xiaomi MiMo.exe"
) do if not defined APP if exist "%%~p" set "APP=%%~p"
if not defined APP for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$n='Xiaomi MiMo\Xiaomi MiMo.exe';$e=(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue|ForEach-Object{Get-ItemProperty $_.PSPath}|Where-Object{$_.DisplayName -like '*MiMo*'}|ForEach-Object{$_.DisplayIcon -replace ',\d+$',''}|Where-Object{$_ -like '*.exe' -and (Test-Path $_)}|Select-Object -First 1);if(-not $e){$e=(Get-PSDrive -PSProvider FileSystem|ForEach-Object{Join-Path $_.Root ('Program Files\'+$n)})|Where-Object{Test-Path $_}|Select-Object -First 1};if(-not $e){$e=(Get-Process 'Xiaomi MiMo*' -ErrorAction SilentlyContinue|Select-Object -First 1).Path};if($e){$e}" 2^>nul`) do if not defined APP set "APP=%%i"
