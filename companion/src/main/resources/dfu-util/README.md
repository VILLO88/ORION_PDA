# dfu-util binaries

`getDfuUtilPath()` looks for `dfu-util` (or `dfu-util.exe` on Windows) under
this directory, in a sub-folder named `<platform>-<arch>`:

```
src/main/resources/dfu-util/
  darwin-arm64/dfu-util      (Apple Silicon)
  darwin-x64/dfu-util        (Intel Mac)
  linux-x64/dfu-util
  win32-x64/dfu-util.exe
```

In **development** the resolver falls back to whatever `dfu-util` is on the
system `PATH`, so you don't strictly need to copy any binary while iterating
locally. For **packaged builds** (electron-builder) all four files must be
present, otherwise users without dfu-util installed globally will see "dfu-util
not found".

## How to populate

### macOS (darwin-arm64 / darwin-x64)

```bash
brew install dfu-util
mkdir -p src/main/resources/dfu-util/darwin-arm64
cp /opt/homebrew/bin/dfu-util src/main/resources/dfu-util/darwin-arm64/
chmod +x src/main/resources/dfu-util/darwin-arm64/dfu-util

# Check dylib dependencies. If it links to brew's libusb you must either
# (a) build a static binary, or (b) bundle the libusb dylib alongside and
# patch the rpath with install_name_tool.
otool -L src/main/resources/dfu-util/darwin-arm64/dfu-util

# Easier: grab the static prebuilt from
#   http://dfu-util.sourceforge.net/releases/
# (look for darwin-arm64 or darwin-x86_64 archives)
```

For the Intel build (`darwin-x64`) repeat on an Intel Mac or in a Rosetta
shell, OR download the prebuilt from sourceforge.

### Linux (linux-x64)

```bash
sudo apt install dfu-util  # or equivalent
cp $(which dfu-util) src/main/resources/dfu-util/linux-x64/dfu-util
chmod +x src/main/resources/dfu-util/linux-x64/dfu-util
ldd src/main/resources/dfu-util/linux-x64/dfu-util
# Same dylib caveat: prefer a static build or bundle libusb-1.0.so.0.
```

Don't forget to also ship the udev rule for non-sudo flashing on Linux:

```
# /etc/udev/rules.d/99-orion-dfu.rules
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"
```

### Windows (win32-x64)

Download the official Windows release from
[dfu-util sourceforge](http://dfu-util.sourceforge.net/releases/) and extract
`dfu-util.exe` into `win32-x64/`.

STM32 DFU on Windows also needs the **WinUSB** driver — STM32CubeProgrammer
or Zadig must install it once on each user's machine.

## Verifying

After populating, run a packaged build:

```bash
npm run package:mac   # or :win / :linux
```

Then inside the installed app, open Firmware → check the binary path printed
in the bottom-right corner of the Flash step. It should point under
`Contents/Resources/dfu-util/...` (macOS) or `resources/dfu-util/...`
(Linux/Win).
