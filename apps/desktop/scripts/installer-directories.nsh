!include "LogicLib.nsh"

Var mwfFinalDirectory
Var mwfNewDirectory
Var mwfOldDirectory
Var mwfOldMoved
Var mwfNewMoved
Var mwfDirectoryError
Var mwfDirectorySource
Var mwfDirectoryDestination
Var mwfRestoreError
Var mwfDirectoryLogDirectory
Var mwfRecoveryStopped

; MoveFileEx preserves the destination and exposes the Windows error before rollback changes it.
; Open files inside a directory can make its rename return access denied (5).
!macro mwfDirectoryOperation SOURCE DESTINATION RESULT PHASE
  Push $0
  Push $1
  Push $2
  StrCpy $0 0
  ${Do}
    ${If} "${DESTINATION}" == ""
      System::Call 'kernel32::RemoveDirectoryW(w "${SOURCE}") i.r1 ?e'
    ${Else}
      System::Call 'kernel32::MoveFileExW(w "${SOURCE}", w "${DESTINATION}", i 0) i.r1 ?e'
    ${EndIf}
    Pop ${RESULT}
    ${If} "${DESTINATION}" == ""
      ${If} ${RESULT} == 2
      ${OrIf} ${RESULT} == 3
        StrCpy $1 1
      ${EndIf}
    ${EndIf}
    ${If} $1 != 0
      StrCpy ${RESULT} 0
      ${ExitDo}
    ${EndIf}
    ClearErrors
    FileOpen $2 "$PLUGINSDIR\directory-operations.log" a
    ${IfNot} ${Errors}
      FileSeek $2 0 END
      FileWrite $2 "${PHASE}: Windows error: ${RESULT}$\r$\n"
      FileClose $2
    ${EndIf}
    ${If} ${RESULT} != 5
    ${AndIf} ${RESULT} != 32
    ${AndIf} ${RESULT} != 33
      ${ExitDo}
    ${EndIf}
    IntOp $0 $0 + 1
    ${If} $0 >= 10
      ${ExitDo}
    ${EndIf}
    IntOp $1 $0 * 250
    Sleep $1
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro mwfReportDirectoryFailure
  ${If} $mwfRestoreError != 0
    StrCpy $mwfRecoveryStopped "1"
  ${EndIf}
  !ifmacrodef customInstallerDirectoryFailed
    !insertmacro customInstallerDirectoryFailed
  !else
    DetailPrint "Directory operation failed ($mwfDirectoryError): $mwfDirectorySource -> $mwfDirectoryDestination; restore error: $mwfRestoreError"
  !endif
!macroend

!macro mwfExtractPayload FILE
  !ifmacrodef customInstallerExtract
    !insertmacro customInstallerExtract "${FILE}"
  !else
    nsExec::ExecToStack '"$PLUGINSDIR\mwf-7za.exe" x -y -bd -bb0 "-o$INSTDIR" "${FILE}"'
    Pop $R0
    Pop $R1
  !endif
  ${If} $R0 != 0
    DetailPrint $R1
    Call mwfRollbackDirectories
    !ifmacrodef customInstallerExtractFailed
      !insertmacro customInstallerExtractFailed "${FILE}"
    !else
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)" /SD IDOK
    !endif
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro mwfStageApplication
  !ifdef MWF_INSTALLER_LOG_DIR
    ; electron-builder defines the cache name after including our function bodies, before this section expands.
    StrCpy $mwfDirectoryLogDirectory "${MWF_INSTALLER_LOG_DIR}"
  !endif
  StrCpy $mwfFinalDirectory $INSTDIR
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  ${If} $1 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $mwfNewDirectory "$INSTDIR.new-$0"
  StrCpy $mwfOldDirectory "$INSTDIR.old-$0"
  StrCpy $mwfOldMoved ""
  StrCpy $mwfNewMoved ""
  StrCpy $mwfDirectoryError 0
  StrCpy $mwfRestoreError 0
  StrCpy $mwfRecoveryStopped ""
  ClearErrors
  CreateDirectory $mwfNewDirectory
  ${If} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  File /oname=$PLUGINSDIR\mwf-7za.exe "${MWF_SEVENZIP_PATH}"
  StrCpy $INSTDIR $mwfNewDirectory
  SetOutPath $INSTDIR
  !insertmacro installApplicationFiles
  !ifdef MWF_SEVENZIP_LICENSE_DIR
    File /oname=7zip-installer-LICENSE.txt "${MWF_SEVENZIP_LICENSE_DIR}\LICENSE.txt"
    File /oname=7zip-installer-COPYING.txt "${MWF_SEVENZIP_LICENSE_DIR}\COPYING"
  !endif
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  StrCpy $INSTDIR $mwfFinalDirectory
  SetOutPath $PLUGINSDIR
!macroend

Function .onGUIEnd
  Call mwfCleanupDirectories
FunctionEnd

Function mwfCleanupDirectories
  ${If} $mwfRecoveryStopped == "1"
    Return
  ${EndIf}
  ${If} $mwfFinalDirectory != ""
    Call mwfRollbackDirectories
  ${EndIf}
FunctionEnd

; Only directories created or renamed by this installer are removed during rollback.
Function mwfRollbackDirectories
  SetOutPath $PLUGINSDIR
  ${If} $mwfNewMoved == "1"
    RMDir /r "\\?\$mwfFinalDirectory"
    StrCpy $mwfNewMoved ""
  ${EndIf}
  ${If} $mwfOldMoved == "1"
    !insertmacro mwfDirectoryOperation "$mwfOldDirectory" "$mwfFinalDirectory" $mwfRestoreError "restore"
    ${If} $mwfRestoreError != 0
      ; Leave the complete backup in place if another process prevents restoration.
      DetailPrint $mwfOldDirectory
      RMDir /r "\\?\$mwfNewDirectory"
      Return
    ${EndIf}
    StrCpy $mwfOldMoved ""
  ${EndIf}
  ${If} $mwfNewDirectory != ""
    RMDir /r "\\?\$mwfNewDirectory"
  ${EndIf}
  StrCpy $INSTDIR $mwfFinalDirectory
FunctionEnd

Function mwfPromoteDirectories
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 2
  !endif
  ; SetOutPath opens a directory handle; release it before either rename.
  SetOutPath $PLUGINSDIR
  ClearErrors
  ${If} ${FileExists} "$mwfFinalDirectory\*.*"
    StrCpy $mwfDirectorySource $mwfFinalDirectory
    StrCpy $mwfDirectoryDestination $mwfOldDirectory
    !insertmacro mwfDirectoryOperation "$mwfDirectorySource" "$mwfDirectoryDestination" $mwfDirectoryError "backup"
    ${If} $mwfDirectoryError != 0
      Call mwfRollbackDirectories
      !insertmacro mwfReportDirectoryFailure
      SetErrors
      Return
    ${EndIf}
    StrCpy $mwfOldMoved "1"
  ${Else}
    ; NSIS can create the destination before the install section starts.
    StrCpy $mwfDirectorySource $mwfFinalDirectory
    StrCpy $mwfDirectoryDestination ""
    !insertmacro mwfDirectoryOperation "$mwfDirectorySource" "" $mwfDirectoryError "remove-empty"
    ${If} $mwfDirectoryError != 0
      Call mwfRollbackDirectories
      !insertmacro mwfReportDirectoryFailure
      SetErrors
      Return
    ${EndIf}
  ${EndIf}
  ClearErrors
  StrCpy $mwfDirectorySource $mwfNewDirectory
  StrCpy $mwfDirectoryDestination $mwfFinalDirectory
  !insertmacro mwfDirectoryOperation "$mwfDirectorySource" "$mwfDirectoryDestination" $mwfDirectoryError "promote"
  ${If} $mwfDirectoryError != 0
    Call mwfRollbackDirectories
    !insertmacro mwfReportDirectoryFailure
    SetErrors
    Return
  ${EndIf}
  StrCpy $mwfNewMoved "1"
  SetOutPath $mwfFinalDirectory
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 3
  !endif
  ClearErrors
FunctionEnd

!macro mwfFinishDirectories
  StrCpy $mwfNewMoved ""
  ${If} $mwfOldMoved == "1"
    RMDir /r "\\?\$mwfOldDirectory"
    StrCpy $mwfOldMoved ""
  ${EndIf}
!macroend
