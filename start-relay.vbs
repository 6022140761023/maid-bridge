' maid-bridge / start-relay.vbs
' ---------------------------------------------------------------------------
' Launch the local OpenAI-compatible relay with NO console window.
' Double-click it, or let the Startup shortcut call it at logon.
'
' NOTE: this file is deliberately PURE ASCII and SELF-LOCATING.
'   Windows script hosts read .vbs using the system ANSI codepage (GBK here),
'   so a UTF-8 file containing a Chinese path (…\mc游戏\…) would be read as
'   mojibake and node would silently fail to find relay.mjs.
'   Deriving the folder from WScript.ScriptFullName avoids that entirely.
' ---------------------------------------------------------------------------
Option Explicit
Dim fso, sh, dir, exe, script

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

dir    = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(dir, "relay.mjs")
exe    = "C:\Program Files\nodejs\node.exe"

If Not fso.FileExists(exe) Then
  WScript.Echo "node.exe not found: " & exe
  WScript.Quit 1
End If
If Not fso.FileExists(script) Then
  WScript.Echo "relay.mjs not found: " & script
  WScript.Quit 1
End If

sh.CurrentDirectory = dir
' 0 = hidden window, False = do not wait
' --dump writes every request/response into dumps\ (debugging; safe to delete)
sh.Run """" & exe & """ """ & script & """ --dump", 0, False
