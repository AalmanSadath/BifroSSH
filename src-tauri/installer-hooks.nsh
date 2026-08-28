; Make the uninstaller's "Delete the application data" checkbox tell the truth.
;
; Tauri's own template ticks that box and then deletes registry keys: the
; installer's recorded location and its language, and nothing else. The whole
; template contains three RMDir calls, all of them for $INSTDIR and the Start
; Menu folder. So an uninstall that says it is removing your data leaves the
; vault, the private keys and known_hosts exactly where they were.
;
; That matters more here than it would for most apps. Somebody handing on or
; decommissioning a machine ticks that box and reasonably believes their saved
; credentials are gone.
;
; This hook runs inside Section Uninstall after that block, where both
; $DeleteAppDataCheckboxState and $UpdateMode are still in scope. $APPDATA is
; the roaming profile of the user doing the uninstall, which is where
; get_data_dir puts everything on Windows.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; An update reuses the uninstaller, and $UpdateMode above is what keeps a
    ; version bump from wiping the vault. Do not remove that guard.
    IfFileExists "$APPDATA\BifroSSH\*.*" 0 BifroSSHNoAppData

    ; Deleting a credential store cannot be undone and there is no copy of it
    ; anywhere else, so it is worth one question even though the box was
    ; ticked. /SD IDNO makes a silent uninstall keep the data: an unattended
    ; run is the one that cannot answer.
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
      "Delete saved hosts, identities, private keys and known hosts?$\r$\n$\r$\nThis cannot be undone, and nothing else holds a copy. Choose No to leave them in place for a future install." \
      /SD IDNO IDYES BifroSSHDeleteAppData
    Goto BifroSSHNoAppData

    BifroSSHDeleteAppData:
      RMDir /r "$APPDATA\BifroSSH"

    BifroSSHNoAppData:
  ${EndIf}
!macroend
