@echo off
setlocal enabledelayedexpansion
title Telemetro Movil - Deploy y Respaldo
cd /d "%~dp0"

:: Configuracion del Proyecto
set SITE_ID=83d6715f-6895-43c8-a89d-c9aad4e651fa
set SITE_URL=telemetro-movil-app.netlify.app
set GITHUB_REPO=https://github.com/daniel-pizarro-arrue/telemetro-movil-app

echo.
echo ========================================================
echo         TELEMETRO MOVIL - ACTUALIZADOR DEPLOY
echo ========================================================
echo   Sitio Netlify: https://!SITE_URL!
echo   Repositorio:   !GITHUB_REPO!
echo ========================================================
echo.
echo   [1] ACTUALIZACION COMPLETA (GitHub + Netlify En Vivo) [DEFAULT]
echo   [2] Solo Desplegar en Netlify
echo   [3] Solo Subir a GitHub
echo   [4] Abrir enlace en el navegador
echo.
set /p OPCION="Selecciona una opcion [1-4] (Presiona Enter para opcion 1): "

if "!OPCION!"=="" set OPCION=1
if "!OPCION!"=="1" goto :full_deploy
if "!OPCION!"=="2" goto :netlify_only
if "!OPCION!"=="3" goto :github_only
if "!OPCION!"=="4" goto :open_browser

echo [ERROR] Opcion no valida.
goto :error

:full_deploy
echo.
echo --------------------------------------------------------
echo  [Paso 1/2] Sincronizando con GitHub...
echo --------------------------------------------------------
set /p COMMIT_MSG="Mensaje del cambio (Enter para fecha automatica): "
if "!COMMIT_MSG!"=="" set COMMIT_MSG=Actualizacion telemetro %date% %time%

git add .
git commit -m "!COMMIT_MSG!"
git push origin main
if errorlevel 1 (
    echo [ADVERTENCIA] Fallo el push a GitHub o no hay cambios pendientes.
)

:netlify_only
echo.
echo --------------------------------------------------------
echo  [Paso 2/2] Desplegando en Produccion Netlify...
echo --------------------------------------------------------
call npx netlify deploy --site=%SITE_ID% --dir=. --prod
if errorlevel 1 (
    echo.
    echo [ERROR] Fallo el despliegue directo a Netlify.
    goto :error
)

echo.
echo ========================================================
echo   DESPLIEGUE EXITOSO!
echo.
echo   Abre este enlace en tu telefono celular:
echo   https://!SITE_URL!
echo ========================================================
echo.
pause
exit /b 0

:github_only
echo.
echo --------------------------------------------------------
echo  Subiendo cambios a GitHub...
echo --------------------------------------------------------
set /p COMMIT_MSG="Mensaje del cambio (Enter para fecha automatica): "
if "!COMMIT_MSG!"=="" set COMMIT_MSG=Actualizacion telemetro %date% %time%

git add .
git commit -m "!COMMIT_MSG!"
git push origin main
if errorlevel 1 (
    echo.
    echo [ERROR] No se pudo subir a GitHub. Revisa la conexion.
    goto :error
)
echo [OK] Repositorio de GitHub actualizado.
pause
exit /b 0

:open_browser
start https://!SITE_URL!
exit /b 0

:error
echo.
echo ========================================================
echo   Ocurrio un problema durante el proceso.
echo ========================================================
echo.
pause
exit /b 1
