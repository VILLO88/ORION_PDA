ORION emulator for Windows
==========================

The official way to use the emulator on Windows. The latest build is always at
https://github.com/VILLO88/ORION_PDA/releases/download/emulator-windows/orion-emulator-windows.zip

No installation: keep this folder together. orion-emu.exe needs the .dll
files next to it and the "card" folder.

Run an app
----------
- Double-click orion-emu.exe: it starts card\apps\bricks.lua.
- Or drag a .lua file onto orion-emu.exe. The app must be inside a folder
  called "apps"; the folder that contains "apps" is the emulator's microSD
  card. Example:

      Desktop\my-card\apps\hello.lua      drag this onto orion-emu.exe
      Desktop\my-card\apps\data\hello\    the app's saved files end up here

- From a terminal (cmd or PowerShell), in this folder:

      orion-emu.exe card\apps\invaders.lua
      orion-emu.exe C:\path\to\my-card apps\hello.lua

The black window next to the emulator is the console: orion.sys.log() and Lua
errors are printed there. Errors are also shown on the emulator's screen.

Keys: arrows, Enter, Esc, Backspace, Delete as on the device; Shift = SHIFT,
Alt = Fn; F1 MENU, F2 SAVE, F3 SEARCH, F4 PLAY.

First launch
------------
Windows SmartScreen may say "Windows protected your PC": click
"More info", then "Run anyway". The emulator is not signed.

Settings
--------
Set them in a terminal before starting, for example in cmd:

      set ORION_AUDIO=0
      orion-emu.exe card\apps\metronome.lua

ORION_AUDIO=0       no sound (if the PC has no audio output)
ORION_LUA_KB=210    a larger Lua memory, for very large apps

Not available on Windows yet: orion.serial (it answers "not found").
Same as on every PC: no MP3, Bluetooth audio or microphone.

The full guide is at https://orionpda.org/sdk
