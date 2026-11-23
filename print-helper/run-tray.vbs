' ERM Print Helper: запуск + watchdog.
' Если процесс упал — поднимает снова. Чистый выход (трей «Выход» /exit) — останавливает watchdog.
' Проверка через Win32_Process (не HTTP): иначе MSXML может зависнуть на TIME_WAIT порта.

Option Explicit
Dim fso, shell, exeDir, exePath, flagPath, wmi, procs, startedAt

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
exeDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = exeDir & "\erm-print-helper.exe"
flagPath = exeDir & "\.erm-print-helper-clean-exit"

If Not fso.FileExists(exePath) Then
  MsgBox "Файл не найден: " & exePath, vbExclamation, "ERM Print Helper"
  WScript.Quit 1
End If

Do
  If fso.FileExists(flagPath) Then
    On Error Resume Next
    fso.DeleteFile flagPath, True
    On Error GoTo 0
    WScript.Quit 0
  End If

  If IsHelperRunning() Then
    WScript.Sleep 4000
  Else
    shell.Run """" & exePath & """", 0, False
    startedAt = Timer
    Do While Elapsed(startedAt) < 10
      WScript.Sleep 400
      If IsHelperRunning() Then Exit Do
      If fso.FileExists(flagPath) Then
        On Error Resume Next
        fso.DeleteFile flagPath, True
        On Error GoTo 0
        WScript.Quit 0
      End If
    Loop
    If Not IsHelperRunning() Then
      WScript.Sleep 2500
    End If
  End If
Loop

Function Elapsed(startedAt)
  Dim d
  d = Timer - startedAt
  If d < 0 Then d = d + 86400
  Elapsed = d
End Function

Function IsHelperRunning()
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then
    Err.Clear
    IsHelperRunning = False
    Exit Function
  End If
  Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'erm-print-helper.exe'")
  If Err.Number <> 0 Then
    Err.Clear
    IsHelperRunning = False
    Exit Function
  End If
  IsHelperRunning = (procs.Count > 0)
  Err.Clear
End Function
