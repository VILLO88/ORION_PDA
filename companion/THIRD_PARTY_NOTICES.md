# Third-party software

Orion Companion is released under the MIT licence (see `LICENSE`). The
packaged app also contains the following programs, which keep their own
licences. They are separate executables that the Companion starts; they are
not linked into it.

## FFmpeg (`ffmpeg`, `ffprobe`)

Used to convert music and video. Licence: GNU General Public License, version
2 or later or version 3 depending on the build, since these builds enable
GPL components (for example libx264 and libmp3lame).

- Source code: <https://ffmpeg.org/download.html>
- Windows builds: gyan.dev, "release essentials" <https://www.gyan.dev/ffmpeg/builds/>
- macOS builds: osxexperts.net <https://www.osxexperts.net>
- Linux builds: John Van Sickle's static builds <https://johnvansickle.com/ffmpeg/>

Each build site publishes the exact configuration and the matching source.
`ffmpeg -version` prints the version and configuration of the copy inside the
app.

## dfu-util

Used to flash ORION's firmware over USB. Licence: GNU General Public License,
version 2 or later. Source code: <https://dfu-util.sourceforge.net>

## libusb

Used by dfu-util on macOS and Windows. Licence: GNU Lesser General Public
License, version 2.1 or later. Source code: <https://libusb.info>

## Electron and Chromium

The app runs on Electron (MIT licence), which includes Chromium. Their licence
texts are in every package, next to the app: `LICENSE.electron.txt` and
`LICENSES.chromium.html`.

## JavaScript libraries

The libraries in `package.json` are bundled into the app under their own
licences (MIT, Apache-2.0, BSD and similar). `npx license-checker` in the
source folder lists them.
