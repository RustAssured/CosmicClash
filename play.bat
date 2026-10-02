@echo off
rem Double-click to play ADEUK: TITANS. Builds the game, starts a local server, opens the browser.
rem Optional: drag nothing, just double-click. Close this black window to stop the game server.
cd /d "%~dp0"
echo Building the game (about 30 seconds)...
call npx vite build --logLevel error
if errorlevel 1 (
  echo Build failed. Run "npm ci" once in this folder, then try again.
  pause
  exit /b 1
)
echo Starting the game at http://localhost:4173 ...
start "" "http://localhost:4173/?orbit=1"
call npx vite preview --port 4173 --strictPort
