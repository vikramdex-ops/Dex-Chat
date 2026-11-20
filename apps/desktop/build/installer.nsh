; Dexterity Connect installer additions.
; Hub-off mode lets PCs pass Direct messages to each other when the office hub is down. It
; needs Windows Firewall to let other office PCs reach the app on private and domain networks.
; This succeeds when the installer runs as administrator; otherwise Windows asks the first
; time the app is used in that mode.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Dexterity Connect (office network)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Dexterity Connect (office network)" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Dexterity Connect (office network)"'
!macroend

; Replacing the version already on this PC. electron-builder runs the old version's uninstaller first
; and, by default, stops with "Failed to uninstall old application files ...: 2" when it fails. That
; is what happens when the app was installed for all users (Program Files, HKLM) and the update
; runs with the person's ordinary rights, as the in-app updater starts it. Instead: start this
; setup again with administrator rights (Windows asks once) and carry on there; if it already has
; them, or the person said no, say what to do in plain words (even in a silent update: someone is
; waiting for it), and open the app again so nobody is
; left without it. Tested by apps/desktop/build/update-test.ps1.
!include "FileFunc.nsh"
!macro dexUninstallCheck
  ${if} $R0 != 0
    DetailPrint "The old version's uninstaller stopped with code $R0."
    UserInfo::GetAccountType
    Pop $R1
    ${GetParameters} $R2
    ; --dex-elevated marks the copy started with administrator rights: it never asks again
    ClearErrors
    ${GetOptions} $R2 "--dex-elevated" $R3
    ${if} ${Errors}
    ${andIf} $R1 != "Admin"
      ClearErrors
      ExecShell "runas" "$EXEPATH" "$R2 --dex-elevated"
      ${ifNot} ${Errors}
        SetErrorLevel 0
        Quit
      ${endif}
    ${endif}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Dexterity Connect could not replace the version already on this PC (code $R0).$\r$\n$\r$\nIt was installed for everyone who uses this PC, so Windows has to allow the update. Close Dexterity Connect (right-click its icon by the clock, Quit), then run the setup again and click Yes when Windows asks for permission.$\r$\n$\r$\nThe version you have keeps working until then."
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    ${endif}
    SetErrorLevel 2
    Quit
  ${endif}
!macroend
!macro customUnInstallCheck
  !insertmacro dexUninstallCheck
!macroend
!macro customUnInstallCheckCurrentUser
  !insertmacro dexUninstallCheck
!macroend
