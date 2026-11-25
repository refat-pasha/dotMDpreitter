; =========================================================================
;  build/installer.nsh — custom NSIS steps for the dotMDpritter installer.
;
;  electron-builder registers the ProgIDs (dotMDpritter.md, …) and adds them
;  to each extension's OpenWithProgids, which is enough for right-click
;  "Open with". Two extra registrations are needed for the app to appear as a
;  proper default-app candidate in Windows 10/11:
;
;    1. Software\Classes\Applications\<exe>      -> "Open with" app entry
;    2. Software\RegisteredApplications + Capabilities -> Settings > Default
;       apps card ("Set defaults for applications")
;
;  Both go to HKCU because the installer is per-user (perMachine: false).
;  Windows still requires the user to confirm the default once; installers
;  cannot claim it silently.
; =========================================================================

!macro customInstall
  ; Generic application registration (drives the "Open with" list).
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" \
    "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open" \
    "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" \
    "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Capabilities card in Settings > Apps > Default apps.
  WriteRegStr HKCU "Software\Classes\dotMDpritter\Capabilities" \
    "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\dotMDpritter\Capabilities" \
    "ApplicationDescription" "Offline-first Markdown editor with margin notes"
  WriteRegStr HKCU "Software\Classes\dotMDpritter\Capabilities\FileAssociations" \
    ".md" "dotMDpritter.md"
  WriteRegStr HKCU "Software\Classes\dotMDpritter\Capabilities\FileAssociations" \
    ".markdown" "dotMDpritter.markdown"
  WriteRegStr HKCU "Software\Classes\dotMDpritter\Capabilities\FileAssociations" \
    ".mdown" "dotMDpritter.mdown"
  WriteRegStr HKCU "Software\Classes\dotMDpritter\Capabilities\FileAssociations" \
    ".mkd" "dotMDpritter.mkd"
  WriteRegStr HKCU "Software\RegisteredApplications" \
    "dotMDpritter" "Software\Classes\dotMDpritter\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\dotMDpritter"
  DeleteRegValue HKCU "Software\RegisteredApplications" "dotMDpritter"
!macroend
