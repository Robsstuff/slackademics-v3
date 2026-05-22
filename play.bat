@echo off
echo Starting Slackademics...
cd /d "%~dp0.."
start "" http://localhost:7790/game/
python -m http.server 7790
pause
