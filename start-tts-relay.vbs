' maid-bridge / start-tts-relay.vbs
' ---------------------------------------------------------------------------
' Launch the TTS relay (Fish Audio format shim) with NO console window.
' Pure ASCII + self-locating -- Windows script hosts read .vbs in the ANSI
' codepage, so a Chinese path inside would be read as mojibake.
' ---------------------------------------------------------------------------
Option Explicit
Dim fso, sh, dir, exe, script

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

dir    = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(dir, "tts-relay.mjs")
exe    = "C:\Program Files\nodejs\node.exe"

If Not fso.FileExists(exe) Then
  WScript.Echo "node.exe not found: " & exe
  WScript.Quit 1
End If
If Not fso.FileExists(script) Then
  WScript.Echo "tts-relay.mjs not found: " & script
  WScript.Quit 1
End If

sh.CurrentDirectory = dir
' 0 = hidden window, False = do not wait
sh.Run """" & exe & """ """ & script & """ --dump", 0, False
