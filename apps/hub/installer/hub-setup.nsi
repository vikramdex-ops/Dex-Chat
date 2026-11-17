; DexterityConnectHub-Setup.exe: the office hub's installer for the server PC.
;
; Built by apps/hub/scripts/build-setup.mjs from the assembled hub folder (the same files as the
; hub zip). All the real work (checks, service, firewall, sleep settings, start and health check)
; is done by Install-Hub.ps1, the same script Install-Hub.cmd runs from the zip, so both stay alike.
;
;   DexterityConnectHub-Setup.exe                  the wizard
;   DexterityConnectHub-Setup.exe /S               silent; repairs or upgrades an installed hub
;   ... /S /DATA=E:\HubData                        a new hub's data folder (an existing hub's data stays)
;   ... /S /NOPOWER                                leave the PC's sleep settings alone
;   ... /S /D=D:\Hub                               program folder for a new install (must be last)
;   "Uninstall Dexterity Connect Hub.exe" /S [/REMOVEDATA]
;
; Exit codes: 0 done, 1 failed, 2 refused (this PC does not meet a requirement).

!ifndef STAGE
  !error "Define STAGE: the assembled hub folder"
!endif
!ifndef GENERATED
  !error "Define GENERATED: the folder with files.nsh and unfiles.nsh"
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VIVERSION
  !define VIVERSION "0.0.0.0"
!endif
!ifndef OUTFILE
  !define OUTFILE "DexterityConnectHub-Setup-${VERSION}.exe"
!endif

!define PRODUCT "Dexterity Connect Hub"
!define COMPANY "Dexterity Design Services Private Limited"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DexterityConnectHub"
!define SETTINGS_KEY "SOFTWARE\Dexterity Connect Hub"
!define UNINSTALLER "Uninstall Dexterity Connect Hub.exe"

Unicode true
ManifestDPIAware true
ManifestSupportedOS all
; the manifest asks for administrator rights, so Windows shows its usual permission prompt
RequestExecutionLevel admin
SetCompressor /SOLID lzma
Name "${PRODUCT}"
Caption "${PRODUCT} ${VERSION} Setup"
UninstallCaption "${PRODUCT} Uninstall"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${PRODUCT}"
BrandingText "${PRODUCT} ${VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VIVERSION}"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "LegalCopyright" "${COMPANY}"
VIAddVersionKey "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

!include MUI2.nsh
!include LogicLib.nsh
!include x64.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
!include Sections.nsh

Var PS            ; 64-bit Windows PowerShell
Var DataDir       ; data folder for a new hub
Var Existing      ; folder of the installed hub service (setup or the old zip), or empty
Var KeepAwake
Var ResultText
Var RemoveData
Var DataField
Var RemoveBox
Var Extra

; ------------------------------------------------------------------ pages
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Set up the office hub"
!define MUI_WELCOMEPAGE_TEXT "This installs the Dexterity Connect hub on this PC: the always-on part that holds the office's people, messages, files and calls.$\r$\n$\r$\nUse a PC that stays on, on the office network. Setup installs the hub as a Windows service that starts with the PC and restarts itself, opens its ports in Windows Firewall (TCP 47900, UDP 47901 and 47910-47999 for large meetings), keeps the PC from sleeping while plugged in, and checks that the hub answers.$\r$\n$\r$\nRunning setup again repairs or upgrades the hub and never touches its data."
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipForExisting
!define MUI_DIRECTORYPAGE_TEXT_TOP "The hub's programs go in this folder. Its data is kept separately (next page)."
!insertmacro MUI_PAGE_DIRECTORY
Page custom DataPage DataPageLeave
!define MUI_COMPONENTSPAGE_NODESC
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "The hub is running"
!define MUI_FINISHPAGE_TEXT "$ResultText"
!define MUI_FINISHPAGE_TEXT_LARGE
!define MUI_FINISHPAGE_SHOWREADME "$APPDATA\${PRODUCT}\setup.log"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Open the setup log"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.RemoveDataPage un.RemoveDataLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ------------------------------------------------------------------ helpers
!macro FindPowerShell
  StrCpy $PS "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$PS"
    StrCpy $PS "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
!macroend

; Install-Hub.ps1 with the given arguments; leaves its exit code in $0 and its last message in
; $ResultText. Its output goes to the details list as it runs.
!macro RunSetupScript SCRIPT ARGS
  Delete "$PLUGINSDIR\result.txt"
  DetailPrint ""
  nsExec::ExecToLog '"$PS" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SCRIPT}" -InstallDir "$INSTDIR" -Version "${VERSION}" -ResultFile "$PLUGINSDIR\result.txt" ${ARGS}'
  Pop $0
  Call ReadResult
!macroend

Function ReadResult
  StrCpy $ResultText ""
  ClearErrors
  FileOpen $9 "$PLUGINSDIR\result.txt" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileReadUTF16LE $9 $8
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      StrCpy $ResultText "$ResultText$8"
    ${Loop}
    FileClose $9
  ${EndIf}
FunctionEnd

; the program path from a service ImagePath: "C:\a b\x.exe" args -> C:\a b\x.exe
Function ImageToPath
  Exch $0
  Push $1
  Push $2
  StrCpy $1 $0 1
  ${If} $1 == '"'
    StrCpy $0 $0 "" 1
    StrCpy $2 0
    ${Do}
      StrCpy $1 $0 1 $2
      ${If} $1 == '"'
      ${OrIf} $1 == ""
        ${Break}
      ${EndIf}
      IntOp $2 $2 + 1
    ${Loop}
    StrCpy $0 $0 $2
  ${EndIf}
  Pop $2
  Pop $1
  Exch $0
FunctionEnd


; "D:\Data\" -> "D:\Data": a trailing backslash would swallow the closing quote on the command line
Function TrimSlash
  Exch $0
  Push $1
  ${Do}
    StrCpy $1 $0 1 -1
    ${If} $1 != "\"
      ${Break}
    ${EndIf}
    StrCpy $0 $0 -1
  ${Loop}
  Pop $1
  Exch $0
FunctionEnd

Function SkipForExisting
  ${If} $Existing != ""
    Abort
  ${EndIf}
FunctionEnd

Function DataPage
  ${If} $Existing != ""
    Abort ; an installed hub keeps its data where it is
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Where the hub keeps its data" "Messages, shared files, recordings and the hub's certificate."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "Everything people share is kept in this folder, so it grows over time. Choose a drive with plenty of free space (10 GB or more). Backups go somewhere else: a second disk or a network share, chosen later in the app."
  Pop $0
  ${NSD_CreateDirRequest} 0 44u 78% 13u "$DataDir"
  Pop $DataField
  ${NSD_CreateBrowseButton} 80% 43u 20% 15u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 BrowseData
  ${NSD_CreateLabel} 0 68u 100% 36u "Only Windows administrators can open this folder. If it already holds a hub's data, that hub carries on. Running setup again later always keeps the data where it is."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function BrowseData
  ${NSD_GetText} $DataField $0
  nsDialogs::SelectFolderDialog "Folder for the hub's data" "$0"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $DataField "$0"
  ${EndIf}
FunctionEnd

Function DataPageLeave
  ${NSD_GetText} $DataField $0
  StrCpy $1 $0 2
  StrCpy $2 $0 1 1
  ${If} $1 == "\\"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Choose a folder on a disk of this PC. A network share is fine for backups, not for the hub's own data."
    Abort
  ${EndIf}
  ${If} $2 != ":"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Choose a full folder path, for example D:\Dexterity Connect Hub Data."
    Abort
  ${EndIf}
  Push $0
  Call TrimSlash
  Pop $DataDir
FunctionEnd

; ------------------------------------------------------------------ install
Section "Keep this PC awake while plugged in (recommended for the hub)" SecAwake
  StrCpy $KeepAwake 1
SectionEnd

Section "Dexterity Connect Hub service" SecHub
  SectionIn RO
  SetDetailsPrint both
  File "/oname=$PLUGINSDIR\Install-Hub.ps1" "${STAGE}\Install-Hub.ps1"

  StrCpy $Extra ""
  ${If} $Existing == ""
    StrCpy $Extra '-DataDir "$DataDir"'
  ${EndIf}

  ; 1. check this PC (Windows, free space, ports) before changing anything
  DetailPrint "Checking this PC..."
  !insertmacro RunSetupScript "$PLUGINSDIR\Install-Hub.ps1" "-CheckOnly $Extra"
  ${If} $0 != 0
    ${If} $ResultText == ""
      StrCpy $ResultText "Setup could not check this PC (error $0). See $APPDATA\${PRODUCT}\setup.log"
    ${EndIf}
    MessageBox MB_ICONSTOP|MB_OK "$ResultText" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}

  ; 2. stop an installed hub so its programs can be replaced
  ${If} $Existing != ""
    DetailPrint "Stopping the hub..."
    !insertmacro RunSetupScript "$PLUGINSDIR\Install-Hub.ps1" "-StopOnly"
  ${EndIf}

  ; 3. the programs (the data folder is never part of this)
  DetailPrint "Copying the hub's programs to $INSTDIR"
  SetOutPath "$INSTDIR"
  SetOverwrite on
  !include "${GENERATED}\files.nsh"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  ; Apps & features
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${UNINSTALLER},0"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K /M=*.exe /G=0" $1 $2 $3
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" $1

  ; 4. service, firewall, sleep settings, start, and wait for /health
  ${If} $KeepAwake != 1
    StrCpy $Extra "$Extra -NoKeepAwake"
  ${EndIf}
  DetailPrint "Setting up the hub service..."
  !insertmacro RunSetupScript "$INSTDIR\Install-Hub.ps1" "$Extra"
  ${If} $0 != 0
    ${If} $ResultText == ""
      StrCpy $ResultText "Setup did not finish (error $0). See $APPDATA\${PRODUCT}\setup.log"
    ${EndIf}
    MessageBox MB_ICONSTOP|MB_OK "$ResultText" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
SectionEnd

; ------------------------------------------------------------------ start (after the sections, which it refers to)
Function .onInit
  SetShellVarContext all ; $APPDATA is then C:\ProgramData
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "DexterityConnectHubSetup") p .r1 ?e'
  Pop $0
  ${If} $0 == 183
    MessageBox MB_ICONINFORMATION|MB_OK "Dexterity Connect Hub setup is already running." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "The office hub needs 64-bit Windows 10 or Windows 11. This PC has 32-bit Windows: use another PC for the hub." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  SetRegView 64
  ; CurrentMajorVersionNumber exists from Windows 10 on
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentMajorVersionNumber"
  ${If} $0 == ""
  ${OrIf} $0 < 10
    MessageBox MB_ICONSTOP|MB_OK "The office hub needs 64-bit Windows 10 or Windows 11. This PC has an older Windows: use another PC for the hub." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  !insertmacro FindPowerShell
  ${IfNot} ${FileExists} "$PS"
    MessageBox MB_ICONSTOP|MB_OK "Windows PowerShell is missing on this PC, and setup needs it. Turn it back on in Windows Features and run setup again." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  InitPluginsDir

  ${GetParameters} $R0
  ; an installed hub (from this setup or the old zip) is upgraded where it is, with its data
  StrCpy $Existing ""
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\DexterityConnectHub" "ImagePath"
  ${If} $0 != ""
    ExpandEnvStrings $0 $0
    Push $0
    Call ImageToPath
    Pop $0
    ${GetParent} $0 $1
    ${If} ${FileExists} "$1\*.*"
      StrCpy $Existing $1
    ${EndIf}
  ${EndIf}
  ${If} $Existing == ""
    ReadRegStr $1 HKLM "${UNINST_KEY}" "InstallLocation"
    ${If} $1 != ""
    ${AndIf} ${FileExists} "$1\*.*"
      StrCpy $Existing $1
    ${EndIf}
  ${EndIf}
  ; /D= is taken off the command line by Windows' NSIS loader; when $INSTDIR is still the default,
  ; no other folder was asked for
  ${If} $Existing != ""
  ${AndIf} $INSTDIR == "$PROGRAMFILES64\${PRODUCT}"
    StrCpy $INSTDIR $Existing
  ${EndIf}

  ClearErrors
  ${GetOptions} $R0 "/DATA=" $DataDir
  ${If} ${Errors}
    ; the data folder kept by an earlier uninstall, else the default
    ReadRegStr $DataDir HKLM "${SETTINGS_KEY}" "DataDir"
    ${If} $DataDir == ""
      StrCpy $DataDir "$APPDATA\${PRODUCT}\hub-data"
    ${EndIf}
  ${EndIf}
  Push $DataDir
  Call TrimSlash
  Pop $DataDir
  ClearErrors
  ${GetOptions} $R0 "/NOPOWER" $1
  ${IfNot} ${Errors}
    !insertmacro UnselectSection ${SecAwake}
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------------ uninstall
Function un.onInit
  SetShellVarContext all ; $APPDATA is then C:\ProgramData
  SetRegView 64
  !insertmacro FindPowerShell
  StrCpy $RemoveData 0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/REMOVEDATA" $1
  ${IfNot} ${Errors}
    StrCpy $RemoveData 1
  ${EndIf}
FunctionEnd

Function un.RemoveDataPage
  !insertmacro MUI_HEADER_TEXT "Keep the hub's data?" "Messages, shared files, recordings and the hub's certificate."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 40u "The hub's data is kept, so installing the hub again carries on where it left off, with the same people, messages and certificate. Only delete it when the office no longer uses this hub, and after a backup."
  Pop $0
  ${NSD_CreateCheckbox} 0 48u 100% 12u "Also delete the hub's data (this cannot be undone)"
  Pop $RemoveBox
  nsDialogs::Show
FunctionEnd

Function un.RemoveDataLeave
  ${NSD_GetState} $RemoveBox $0
  StrCpy $RemoveData 0
  ${If} $0 == ${BST_CHECKED}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Delete all of the hub's messages, files and recordings? This cannot be undone." IDYES yes
    Abort
    yes:
    StrCpy $RemoveData 1
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetDetailsPrint both
  StrCpy $Extra ""
  ${If} $RemoveData == 1
    StrCpy $Extra "-RemoveData"
  ${EndIf}
  ; the service and firewall rules (and the data, if asked); sleep settings stay as they are
  nsExec::ExecToLog '"$PS" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\Install-Hub.ps1" -Uninstall -InstallDir "$INSTDIR" $Extra'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "The hub service could not be removed, so nothing else was changed. See $APPDATA\${PRODUCT}\setup.log" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  !include "${GENERATED}\unfiles.nsh"
  Delete "$INSTDIR\hub-data-location.txt"
  Delete "$INSTDIR\${UNINSTALLER}"
  ; removed only when empty: a hub-data or logs folder from the old zip layout stays
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
SectionEnd
