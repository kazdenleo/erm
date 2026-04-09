' Запуск ERM Print Helper (только трей, без консоли).
' Либо этот файл, либо erm-print-helper.exe — окно консоли не показывается.
' Выход: меню по правому клику на иконку в трее или http://127.0.0.1:9100/exit

Set fso = CreateObject("Scripting.FileSystemObject")
exePath = fso.GetParentFolderName(WScript.ScriptFullName) & "\erm-print-helper.exe"
If Not fso.FileExists(exePath) Then
  MsgBox "Файл не найден: " & exePath, vbExclamation, "ERM Print Helper"
  WScript.Quit 1
End If
CreateObject("WScript.Shell").Run """" & exePath & """", 0, False
