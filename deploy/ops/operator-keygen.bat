@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  Hara Registry - generate your SSH key (Windows)
REM  Run this, then send the PUBLIC key it prints to your Hara admin.
REM ============================================================
set "KEYDIR=%USERPROFILE%\.ssh"
set "KEYFILE=%KEYDIR%\id_ed25519"

echo(
echo ============================================================
echo   Hara Registry - SSH key setup
echo ============================================================
echo(

where ssh-keygen >nul 2>nul
if errorlevel 1 (
  echo ERROR: ssh-keygen was not found on this PC.
  echo Install it: Settings ^> Apps ^> Optional Features ^> Add a feature ^> "OpenSSH Client"
  echo Then double-click this file again.
  echo(
  pause
  exit /b 1
)

if not exist "%KEYDIR%" mkdir "%KEYDIR%"

if exist "%KEYFILE%.pub" (
  echo You already have an SSH key - reusing it ^(not overwriting^).
  goto :show
)

echo No SSH key found yet. Let's make one.
set /p "WHO=Type your name or email (used only as a label), then press Enter: "
echo(
echo Creating an ed25519 key. You can set a passphrase ^(recommended^) or press Enter twice for none.
echo(
ssh-keygen -t ed25519 -f "%KEYFILE%" -C "!WHO!"
if errorlevel 1 (
  echo(
  echo Key generation failed. Nothing was changed.
  pause
  exit /b 1
)

:show
echo(
echo ============================================================
echo   COPY THE LINE BELOW AND SEND IT TO YOUR HARA ADMIN
echo ============================================================
echo(
type "%KEYFILE%.pub"
echo(
type "%KEYFILE%.pub" | clip
echo ^(This public key was also copied to your clipboard - just paste it to your admin.^)
echo(
echo ============================================================
echo   SAFE TO SHARE: the line above is your PUBLIC key.
echo   NEVER send the file "id_ed25519" ^(without .pub^) - that one is PRIVATE.
echo ============================================================
echo(
pause
