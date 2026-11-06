# ORION SDK

Everything you need to write apps for **ORION V3**, a pocket PDA with a
physical keyboard, a 536x336 one-bit Sharp memory LCD, a microSD card, audio
and a microphone.

Apps are **Lua** files. Copy one to `/apps/` on the microSD card and it shows
up in the Apps menu: no compiling, no reflashing.

```lua
function init()
    orion.gfx.clear(orion.WHITE)
    orion.gfx.text(20, 20, "hello", orion.BLACK, 3)
    orion.gfx.present()
end

function update()
    for ev in orion.input.events() do
        if ev.kind == "down" and ev.key == orion.K.ESC then orion.sys.exit() end
    end
end
```

## Try it now

On Windows 11 there is nothing to build: download
[orion-emulator-windows.zip](https://github.com/VILLO88/ORION_PDA/releases/download/emulator-windows/orion-emulator-windows.zip),
extract it and double-click `orion-emu.exe`, or drag an app onto it.

On macOS and Linux you need SDL2 and a C compiler: on macOS
`brew install sdl2`, on Linux `sudo apt install build-essential libsdl2-dev`.
Then:

```sh
make
cd emulator
./orion-emu card/apps/bricks.lua
```

A window opens with the app. Keys, sound, environment variables and what the
emulator cannot show are explained in the guide on the website.

The emulator runs the same runtime sources as the device (`runtime/`); only
the layer underneath (pixels, keys, files, sound) is different. What it
cannot reproduce: timing (on the device a full frame takes about 75 ms, and
an app that is smooth on a PC can break the audio), the cost of scattered
PSRAM reads, MP3 files, Bluetooth audio and the microphone.

## Documentation

The guide and the API reference, in English and Italian, are at
**[orionpda.org/sdk](https://orionpda.org/sdk)**.

If you are new to this kind of device, read the guide in order: it takes
about an hour and ends with an app on the device. If you already program,
go to the reference and read the performance page first: on this screen the
limits matter more than the list of functions.

## What is in here

| folder | contents |
|---|---|
| `examples/` | four complete apps: `bricks` and `invaders` (games), `metronome` and `tuner` (music) |
| `sounds/` | 21 sound effects, free to use; copy the folder to `/sounds` on the card |
| `emulator/` | the emulator; `card/` stands in for the microSD |
| `runtime/` | the app runtime shared by the device and the emulator, and Lua 5.4 |
| `tools/` | `image.py` and `sound.py` to convert pictures and sounds, `lualint` to find misspelled names |
| `editor/` | definitions for VS Code's Lua extension |

## Commands

```
make          builds the emulator and lualint
make check    lints the examples and checks the tools
make clean    removes the binaries
```

## License

MIT, see `LICENSE` in the repository root. Lua is MIT licensed
(`runtime/lua/`); the 6x12 font is Spleen, BSD-2-Clause.
