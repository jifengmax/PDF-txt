@echo off
node "%~dp0bin\pdf2txt.mjs" %*
exit /b %errorlevel%
