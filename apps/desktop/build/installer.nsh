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
