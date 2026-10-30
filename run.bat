@echo off
REM Food Delivery Route Optimizer - one-click launcher.
REM Double-click this file, or run "run.bat" from a terminal.
setlocal
cd /d "%~dp0"
chcp 65001 >nul

where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found. Install Python 3.9+ from https://www.python.org/downloads/
    echo and tick "Add python.exe to PATH" during setup.
    pause
    exit /b 1
)

python -c "import pandas" >nul 2>nul
if errorlevel 1 (
    echo Installing required packages...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo Package installation failed.
        pause
        exit /b 1
    )
)

:menu
cls
echo ==================================================================
echo              FOOD DELIVERY ROUTE OPTIMIZER - LAUNCHER
echo ==================================================================
echo   1. Route Finder (Dijkstra vs A*, interactive menu)
echo   2. Search Visualization (opens in browser)
echo   3. Delivery Simulation (50 drivers, 100 orders)
echo   4. Relay Delivery: Direct vs Relay (console table)
echo   5. Fleet ^& Relay Map (opens in browser)
echo   6. Demo Route R128 -^> S019
echo   7. Run Tests
echo   8. Exit
echo ------------------------------------------------------------------
set "choice="
set /p "choice=Select an option (1-8): "

if "%choice%"=="1" python main.py & goto pause
if "%choice%"=="2" goto visualize
if "%choice%"=="3" python main.py --simulate & goto pause
if "%choice%"=="4" python main.py --relay & goto pause
if "%choice%"=="5" goto fleet
if "%choice%"=="6" python main.py --source R128 --destination S019 & goto pause
if "%choice%"=="7" python -m unittest discover -s tests -t . -v & goto pause
if "%choice%"=="8" exit /b 0
echo Invalid choice.
goto pause

:visualize
echo.
echo The browser will open automatically. Press Ctrl+C here to stop the
echo visualization and return to this menu.
echo.
python visualize.py
goto pause

:fleet
echo.
echo The browser will open automatically. Press Ctrl+C here to stop the
echo visualization and return to this menu.
echo.
python visualize.py --fleet
goto pause

:pause
echo.
pause
goto menu
