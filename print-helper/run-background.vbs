' Запуск ERM Print Helper (exe) в фоне. Ярлык на этот файл можно положить в Автозагрузку.
Set FSO = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
dir = FSO.GetParentFolderName(WScript.ScriptFullName)
exePath = dir & "\dist\erm-print-helper.exe"
If FSO.FileExists(exePath) Then
  WshShell.Run """" & exePath & """", 0, False
Else
  WScript.Echo "Сначала соберите exe: npm run build:exe в папке print-helper"
End If
