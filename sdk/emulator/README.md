# The ORION emulator

```
make                                   # from the SDK root, needs SDL2
./emulator/orion-emu emulator/card/apps/bricks.lua
```

On Windows there is a ready-made build:
[orion-emulator-windows.zip](https://github.com/VILLO88/ORION_PDA/releases/download/emulator-windows/orion-emulator-windows.zip).
`README-windows.txt` is the text that goes in the zip, and
`.github/workflows/emulator-windows.yml` (in the ORION repo) builds it.

`card/` stands in for the microSD card: `card/apps/` holds the apps and
`card/sounds/` the sound library. Give one path and the card is the folder
that contains `apps/`; or give the card and the app separately:

```
./orion-emu ./card apps/bricks.lua
```

The emulator compiles the same runtime sources as the device (`runtime/`):
the API, the dialogs, the memory allocator, Lua. Only the layer underneath
(pixels, keys, files, sound) is different, in `emu_*.c`.

What it cannot show you: timing (on the device a full frame takes ~75 ms and
the main loop has real deadlines), the cost of scattered PSRAM reads, MP3,
Bluetooth audio and the microphone. Lua gets 168 KB here instead of 128,
because objects are bigger on a 64-bit PC; measure memory on the device with
`orion.sys.log(collectgarbage("count"))`.

Keys, environment variables and installation on macOS, Linux and Windows are
in the guide at [orionpda.org/sdk](https://orionpda.org/sdk).
