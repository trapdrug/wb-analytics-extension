@echo off
chcp 65001 >nul
REM ============================================================
REM  WB Analytics — запуск локального backend-сервера (Windows)
REM  Двойной клик по этому файлу = ноутбук становится сервером.
REM  Требуется только Node.js (проверяется ниже).
REM ============================================================

cd /d "%~dp0"

echo.
echo [WB Analytics] Проверяю Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден.
  echo Скачай и установи LTS-версию с https://nodejs.org и повтори.
  echo.
  pause
  exit /b 1
)
node -v

REM Проверяем, что встроенный node:sqlite доступен (Node ^>= 22.5).
node -e "require('node:sqlite');process.exit(0)" 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Ваша версия Node.js слишком старая для встроенного node:sqlite.
  echo Нужен Node.js 22.5.0 или новее. Обнови на https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo [WB Analytics] Backend слушает http://127.0.0.1:4000
echo [WB Analytics] НЕ закрывай это окно, пока используешь расширение.
echo [WB Analytics] Остановить сервер: нажми Ctrl+C или закрой окно.
echo.

node server.js

echo.
echo [WB Analytics] Сервер остановлен.
pause
