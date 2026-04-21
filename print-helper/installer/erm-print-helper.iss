; Inno Setup script: ERM Print Helper installer
; Требуется Inno Setup 6+ (iscc.exe)
; Сборка: сначала `npm run build:exe`, затем запустить iscc по этому .iss

#define MyAppName "ERM Print Helper"
#define MyAppPublisher "ERM"
#define MyAppURL "https://example.local/"
#define MyAppExeName "erm-print-helper.exe"

; Версию можно подставлять из package.json вручную или скриптом (см. build-installer.ps1)
#define MyAppVersion "1.0.0"

[Setup]
AppId={{8B5B7F35-8A66-4A4E-A8C3-0D5C2B9F1E4A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Per-user установка (без админ-прав)
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
Compression=lzma
SolidCompression=yes
OutputBaseFilename=erm-print-helper-setup
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesInstallIn64BitMode=x64
WizardStyle=modern

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "startup"; Description: "Запускать Print Helper при входе в Windows"; GroupDescription: "Дополнительно:"; Flags: checkedonce
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Ярлыки:"; Flags: unchecked

[Files]
; Папка dist/ должна быть подготовлена заранее
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\SumatraPDF.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\tray.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\README.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\traybin\*"; DestDir: "{app}\traybin"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить Print Helper"; Flags: nowait postinstall skipifsilent

