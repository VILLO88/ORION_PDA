# ORION

ORION is a pocket PDA with a physical keyboard, a 536x336 one-bit Sharp memory
LCD, a microSD card, headphone audio, a microphone and Bluetooth. The screen
is reflective, with no backlight, and reads well in daylight.

| folder | contents |
|---|---|
| [`sdk/`](sdk/) | the SDK for writing apps in Lua: emulator, runtime, tools, examples |
| [`companion/`](companion/) | Orion Companion, the desktop app: music, video and ebook conversion, files, notes, calendar, firmware updates |
| [`firmware/`](firmware/) | firmware updates |

The documentation (guide and API reference, in English and Italian) is at
**[orionpda.org/sdk](https://orionpda.org/sdk)**.

**Emulator for Windows:** download
[orion-emulator-windows.zip](https://github.com/VILLO88/ORION_PDA/releases/download/emulator-windows/orion-emulator-windows.zip),
extract it and double-click `orion-emu.exe`, or drag an app (`.lua`) onto it.
Nothing to install. On macOS and Linux the emulator is built from
[`sdk/`](sdk/).

**Orion Companion** for macOS, Windows and Linux: download it from the
[Releases](https://github.com/VILLO88/ORION_PDA/releases?q=companion&expanded=true)
(look for "Orion Companion"). Installation notes are in
[`companion/INSTALL.md`](companion/INSTALL.md).

## License

MIT, see [`LICENSE`](LICENSE).
