@echo off
chcp 65001 >nul
set "ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $p=Join-Path $env:ROOT '启动 CraftDeck.lnk'; $s=$ws.CreateShortcut($p); $s.TargetPath=Join-Path $env:ROOT 'CraftDeck\CraftDeck.exe'; $s.WorkingDirectory=Join-Path $env:ROOT 'CraftDeck'; $s.IconLocation=(Join-Path $env:ROOT 'CraftDeck\CraftDeck.ico')+',0'; $s.Description='CraftDeck 我的世界启动器'; $s.Save()"
echo 已在当前文件夹创建「启动 CraftDeck.lnk」。
pause
