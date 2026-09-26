@echo off
title VCHAT — Professional Modern Messaging
color 0B
cd /d "%~dp0"

echo ===================================================
echo             STARTING VCHAT PLATFORM
echo ===================================================
echo.

if exist "%~dp0env\Scripts\activate.bat" (
    echo [*] Activating virtual environment: env
    call "%~dp0env\Scripts\activate.bat"
    goto :env_done
)

if exist "%~dp0venv\Scripts\activate.bat" (
    echo [*] Activating virtual environment: venv
    call "%~dp0venv\Scripts\activate.bat"
    goto :env_done
)

echo [!] No virtual environment found. Using system Python.

:env_done
echo.
echo [*] Checking database migrations...
python manage.py migrate --noinput

echo.
echo [*] Opening VCHAT in your default browser...
start http://127.0.0.1:8000/

echo.
echo ===================================================
echo  VCHAT is running at: http://127.0.0.1:8000/
echo  Press Ctrl+C in this window to stop the server.
echo ===================================================
echo.

python manage.py runserver 127.0.0.1:8000

echo.
echo VCHAT server has stopped.
pause
