Unicode true
Name "Second Mind uninstaller extraction diagnostic"
OutFile "uninstaller-intermediate.exe"
RequestExecutionLevel user
SetCompressor zlib
CRCCheck force
SilentInstall silent
SilentUnInstall silent
Function .onInit
  WriteUninstaller "$EXEDIR\native-uninstaller.exe"
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
Function un.onInit
  FileOpen $0 "$EXEDIR\uninstaller-init.txt" w
  FileWrite $0 "uninstaller init reached"
  FileClose $0
FunctionEnd
Section Uninstall
  SetErrorLevel 0
SectionEnd
