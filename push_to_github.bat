@echo off
title Push VCHAT to GitHub
color 0B
cd /d "%~dp0"

echo ===================================================
echo             PUSH VCHAT TO GITHUB
echo ===================================================
echo.
echo Make sure you have created an empty repository on GitHub:
echo Repository name: chatapplication
echo (Do NOT add a README, license, or .gitignore on GitHub)
echo.

set /p GITHUB_URL="Enter your GitHub Repo URL (e.g. https://github.com/yourusername/chatapplication.git): "

if "%GITHUB_URL%"=="" (
    echo [ERROR] No URL entered.
    pause
    exit /b
)

echo.
echo [*] Adding remote origin...
git remote remove origin 2>nul
git remote add origin %GITHUB_URL%

echo [*] Renaming branch to main...
git branch -M main

echo [*] Pushing code to GitHub...
git push -u origin main

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ===================================================
    echo  SUCCESS! VCHAT has been pushed to GitHub!
    echo ===================================================
) else (
    echo.
    echo [ERROR] Push failed. Please check your GitHub credentials or repo URL.
)

echo.
pause
