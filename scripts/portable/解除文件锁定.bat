@echo off
chcp 65001 >nul
echo 正在解除 Windows 下载锁定，请稍候……
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File"
echo 完成。以后打开启动器或游戏文件不会再频繁弹安全提示。
pause
