; Inno Setup script: ERM Print Helper installer
; Требуется Inno Setup 6+ (iscc.exe)
; Сборка: сначала `npm run build:exe`, затем запустить iscc по этому .iss

#define MyAppName "ERM Print Helper"
#define MyAppPublisher "MySell"
#define MyAppURL "https://mysell.su/"
#define MyAppExeName "erm-print-helper.exe"

; Версию можно подставлять из package.json вручную или скриптом (см. build-installer.ps1)
#define MyAppVersion "1.0.8"

[Setup]
AppId={{8B5B7F35-8A66-4A4E-A8C3-0D5C2B9F1E4A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
; Per-user установка (без админ-прав)
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
Compression=lzma
SolidCompression=yes
OutputBaseFilename=erm-print-helper-setup
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
InfoBeforeFile=info-before.txt
; Не используем CloseApplications: у Print Helper нет окна (только трей),
; Inno не может закрыть его через WM_CLOSE и показывает ошибку.
; Процессы гасим в [Code] через taskkill.

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
; Без checkedonce — галочка автозапуска всегда включена по умолчанию при каждой установке
Name: "startup"; Description: "Запускать Print Helper при входе в Windows"; GroupDescription: "Дополнительно:"
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Ярлыки:"; Flags: unchecked

[Files]
; Папка dist/ должна быть подготовлена заранее
; restartreplace — если файл всё же занят, замена после перезагрузки
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion restartreplace
Source: "..\dist\SumatraPDF.exe"; DestDir: "{app}"; Flags: ignoreversion restartreplace
Source: "..\dist\tray.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\README.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\run-tray.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\traybin\*"; DestDir: "{app}\traybin"; Flags: ignoreversion recursesubdirs createallsubdirs restartreplace

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\run-tray.vbs"; IconFilename: "{app}\tray.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\run-tray.vbs"; IconFilename: "{app}\tray.ico"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\run-tray.vbs"""; IconFilename: "{app}\tray.ico"; Tasks: startup

[Registry]
; Дублируем автозапуск в Run — надёжнее ярлыка в Startup на части ПК
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ERMPrintHelper"; ValueData: """{sys}\wscript.exe"" ""{app}\run-tray.vbs"""; Flags: uninsdeletevalue; Tasks: startup

[Code]
procedure KillPrintHelperProcesses;
var
  ResultCode: Integer;
begin
  { Основной exe + helper трея (держит lock на traybin) }
  Exec('taskkill.exe', '/F /IM erm-print-helper.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /IM tray_windows_release.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(500);
end;

function InitializeSetup(): Boolean;
begin
  KillPrintHelperProcesses;
  Result := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  KillPrintHelperProcesses;
  Result := '';
end;

[Run]
; runasoriginaluser + nowait: родительский процесс сразу выходит (фоновый child) —
; не ждём его и не считаем это ошибкой установки
Filename: "{sys}\wscript.exe"; Parameters: """{app}\run-tray.vbs"""; Description: "Запустить Print Helper"; Flags: nowait postinstall skipifsilent runasoriginaluser
