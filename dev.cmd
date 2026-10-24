@echo off
rem 雙擊這個檔案啟動 Agent Workbench 開發版（呼叫同資料夾的 dev.ps1）。
rem 用 -ExecutionPolicy Bypass 只放行這一次執行，不更改系統的 PowerShell 執行原則。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1"
if errorlevel 1 pause
