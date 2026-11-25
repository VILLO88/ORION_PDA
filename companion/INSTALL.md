# Orion Companion — install guide

Orion Companion is distributed as **unsigned** builds for now (no Apple
Developer ID, no Windows code-signing certificate). The app itself is
safe; the warnings you'll see on first launch are the standard OS
behaviour for any app that's not signed by a recognised developer.

The instructions below are for each OS. Pick yours.

---

## macOS

### Install

1. Download `Orion Companion-<version>-arm64.dmg` (Apple Silicon) or
   `Orion Companion-<version>-x64.dmg` (Intel) from the release page.
2. Double-click the `.dmg`, drag **Orion Companion** into the
   `Applications` folder.

### First launch (important)

Double-clicking the app icon will show a dialog like:

> "Orion Companion" cannot be opened because the developer cannot be
> verified.

This is Gatekeeper, not a bug: the app is signed but not notarized by Apple
(that needs a paid Apple Developer account). Do one of the following:

**Option A — System Settings (one-time):**
1. Double-click the app once and close the warning.
2. Open **System Settings → Privacy & Security**, scroll down: next to
   *"Orion Companion" was blocked…* click **Open Anyway**, and confirm.
   macOS remembers your choice for future launches.

On macOS 14 and older, **right-click** the app → **Open** → **Open** does the
same in one step.

**Option B — terminal (faster for power users):**

```bash
xattr -dr com.apple.quarantine "/Applications/Orion Companion.app"
```

Then double-click as normal.

> ⚠️ **"Orion Companion is damaged and can't be opened"** — this is what
> **0.13.0** downloaded from GitHub shows: its signature was incomplete. Option B
> above opens it; from **0.13.1** the app is signed properly and shows the
> normal warning instead.

> ⚠️ **`-dr`, not `-d`.** Without `-r` the flag is cleared only on the bundle
> itself, and the helper programs *inside* it keep theirs. The app opens, but
> the parts of it that run a separate binary — reading the system Calendar,
> flashing firmware — fail with no useful message. Option A (right-click →
> Open) covers the whole bundle and does not have this problem.

### Permissions

On first use, the app may ask for access to:

- **Calendar** — only if you open the Calendar page. Read-only, and only the
  calendars you tick. macOS shows this prompt once and you can revoke it any
  time in System Settings → Privacy & Security → Calendars.
- **USB devices** — required for firmware DFU flashing.
- **Files & folders** — only when you pick a destination folder for
  exports.

Grant when asked. No analytics, no network calls except the firmware
update manifest fetch from `orionpda.org`.

### Uninstall

Drag the app to the Trash. Then:

```bash
rm -rf "~/Library/Application Support/Orion Companion"
rm -rf "~/Library/Logs/Orion Companion"
```

---

## Windows

### Install

1. Download `Orion Companion Setup <version>.exe` (installer, recommended)
   or `Orion Companion-<version>-win.zip` (portable, no installation).
2. Installer: double-click to run. Zip: right-click → **Extract All** into a
   folder of your choice (a USB stick works too), then run
   `Orion Companion.exe` from that folder. Don't run it from inside the zip
   without extracting it.

There is no self-unpacking portable `.exe` any more: it unpacked itself into
`%TEMP%` at every launch, and Windows 11 can block the app's libraries there
("ffmpeg.dll was not found").

### First launch (important)

Windows SmartScreen will block the installer with:

> Windows protected your PC. Microsoft Defender SmartScreen prevented
> an unrecognised app from starting.

Click **More info → Run anyway**. SmartScreen learns the app once and
won't block subsequent runs from the same publisher hash.

### USB driver for firmware flashing

DFU flashing on Windows needs the **WinUSB** driver bound to the
device's DFU interface. If you've ever used STM32CubeProgrammer on
this machine, you already have it. Otherwise:

1. Install [Zadig](https://zadig.akeo.ie/).
2. Put the Orion into DFU mode (Settings → FIRMWARE UPDATE on the
   device).
3. In Zadig, select the STM32 BOOTLOADER device, pick **WinUSB**,
   click **Install Driver**.

### Uninstall

Use Settings → Apps → Orion Companion → Uninstall (installer) or
just delete the folder you extracted (zip). State directory:
`%APPDATA%\Orion Companion`.

---

## Linux

### AppImage

1. Download `Orion Companion-<version>.AppImage`.
2. Make it executable: `chmod +x Orion\ Companion-*.AppImage`
3. Run it: `./Orion\ Companion-*.AppImage`

No installation, no root needed. Put it anywhere; integrates with the
launcher via [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher)
if you want a menu entry.

### .deb (Debian/Ubuntu/Mint)

```bash
sudo dpkg -i orion-companion_<version>_amd64.deb
sudo apt -f install      # if missing deps
```

State directory: `~/.config/Orion Companion`.

### Fedora (and rpm-based)

The AppImage is the recommended path. If you need rpm packaging, ask.

### udev rule for DFU flashing (one-time, all Linux)

Without this, `dfu-util` (used internally for firmware updates) needs
sudo. Drop this file in:

`/etc/udev/rules.d/99-orion-dfu.rules`

```
# STM32 system bootloader DFU interface
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"
```

Then:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Replug the device, you're done.

---

## App Store

Browsing and installing apps needs an internet connection; signing in is
needed only to rate, comment or publish (with a GitHub account, in your
browser). Apps are installed over USB (ORION in USB mode) or over Bluetooth
(slower, ~1 kB/s: a small app takes seconds; for big ones the app suggests the
cable). Over Bluetooth, keep ORION on its home screen while installing; with
firmware 0.3.0 you can also stay in Apps.

**Try** runs an app in the built-in ORION emulator, without the device. The
first key or click in the emulator turns its sound on (browsers start audio
only after a gesture).

## External tools the app uses

For the time being, the build uses **ffmpeg + ffprobe + dfu-util**
from your system if available, otherwise from the bundled copies (once
we ship them in the resources folder — see
`src/main/resources/{ffmpeg,dfu-util}/README.md` for the per-platform
sources).

On dev machines with homebrew (`brew install ffmpeg dfu-util`) or
`apt install ffmpeg dfu-util` everything works out of the box. End
users will need either a system install OR a packaged build with the
binaries populated.

---

## Reporting issues

Logs and crash reports live in the application support / config
directory listed above (look for `logs/`). Attach those when filing
an issue along with:

- OS + version
- Orion firmware version (shown in the companion header)
- Steps to reproduce
