@echo off
setlocal DisableDelayedExpansion
set "signTool=%MWF_DESKTOP_WINDOWS_SIGNTOOL%"
set "certificateFile=%MWF_DESKTOP_WINDOWS_CER_FILE%"
set "tokenPin=%MWF_DESKTOP_WINDOWS_TOKEN_PIN%"
set "keyContainer=%MWF_DESKTOP_WINDOWS_KEY_CONTAINER%"
set "targetFile=%MWF_DESKTOP_WINDOWS_SIGN_TARGET%"
set "appendSignature="
if "%MWF_DESKTOP_WINDOWS_SIGN_APPEND%"=="1" set "appendSignature=/as"
set "MWF_DESKTOP_WINDOWS_SIGNTOOL="
set "MWF_DESKTOP_WINDOWS_CER_FILE="
set "MWF_DESKTOP_WINDOWS_TOKEN_PIN="
set "MWF_DESKTOP_WINDOWS_KEY_CONTAINER="
set "MWF_DESKTOP_WINDOWS_SIGN_TARGET="
set "MWF_DESKTOP_WINDOWS_SIGN_APPEND="
set "signTool=" & set "certificateFile=" & set "tokenPin=" & set "keyContainer=" & set "targetFile=" & set "appendSignature=" & "%signTool%" sign /v /fd sha256 /f "%certificateFile%" /kc "[{{%tokenPin%}}]=%keyContainer%" /csp "eToken Base Cryptographic Provider" %appendSignature% "%targetFile%"
exit /b %errorlevel%
