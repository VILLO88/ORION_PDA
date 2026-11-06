# ffmpeg / ffprobe binaries

`getFfmpegPath()` / `getFfprobePath()` (see
`src/main/ffmpeg/paths.ts`) look for the executables under this
directory in a sub-folder named `<platform>-<arch>`:

```
src/main/resources/ffmpeg/
  darwin-arm64/ffmpeg   ffprobe   (Apple Silicon)
  darwin-x64/ffmpeg     ffprobe   (Intel Mac)
  linux-x64/ffmpeg      ffprobe
  win32-x64/ffmpeg.exe  ffprobe.exe
```

In **development** the resolver falls back to whatever `ffmpeg` /
`ffprobe` is on the system `PATH`, so during local iteration you can
keep using the homebrew/apt install. For **packaged builds**
(electron-builder) the binaries for the target platform must be
present in `src/main/resources/ffmpeg/<plat>/`, otherwise users
without a system ffmpeg will see "spawn ffmpeg ENOENT" inside the
MP3/video pipelines.

## Static binary sources

Use **statically linked** builds whenever possible — dynamic builds
drag in dozens of dylibs/DLLs (`libavformat`, `libavcodec`, ...) that
electron-builder will not auto-bundle.

### macOS (darwin-arm64 / darwin-x64)

Recommended source: **osxexperts.net** static builds.

```
https://www.osxexperts.net/ffmpeg71arm.zip      (darwin-arm64)
https://www.osxexperts.net/ffmpeg71intel.zip    (darwin-x64)
https://www.osxexperts.net/ffprobe71arm.zip     (darwin-arm64)
https://www.osxexperts.net/ffprobe71intel.zip   (darwin-x64)
```

(Version number rolls — pick the latest stable from the site.)

After download:

```bash
mkdir -p src/main/resources/ffmpeg/darwin-arm64
cd src/main/resources/ffmpeg/darwin-arm64
unzip ~/Downloads/ffmpeg71arm.zip
unzip ~/Downloads/ffprobe71arm.zip
chmod +x ffmpeg ffprobe
# Strip the macOS quarantine attribute so the bundled binary launches
# without prompting on the end-user's machine.
xattr -d com.apple.quarantine ffmpeg ffprobe 2>/dev/null || true
# Verify it's truly static (zero non-system deps).
otool -L ffmpeg | head
otool -L ffprobe | head
```

The `otool -L` output should only reference `/usr/lib/libSystem.*`
and `/usr/lib/libc++.*` — anything in `/opt/homebrew/...` or
`/usr/local/...` means it's NOT static.

### Linux (linux-x64)

Recommended source: **johnvansickle.com** static builds.

```
https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
```

After download:

```bash
mkdir -p src/main/resources/ffmpeg/linux-x64
cd /tmp
tar xJf ~/Downloads/ffmpeg-release-amd64-static.tar.xz
cd ffmpeg-*-amd64-static/
cp ffmpeg ffprobe \
   /path/to/OrionCompanion/src/main/resources/ffmpeg/linux-x64/
chmod +x .../linux-x64/ffmpeg .../linux-x64/ffprobe
ldd .../linux-x64/ffmpeg | head      # should say "not a dynamic executable"
```

### Windows (win32-x64)

Recommended source: **gyan.dev** essentials build (smaller; the
"full" build adds CUDA/intel codecs not relevant here).

```
https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
```

After download:

```
src/main/resources/ffmpeg/win32-x64/
  ffmpeg.exe
  ffprobe.exe
```

Both binaries from the `bin/` folder of the zip. No DLLs needed for
the essentials build.

## Size budget

After populating all four platforms expect ~60–80 MB per OS folder.
The packaged `.dmg`/`.exe`/`.AppImage` gets roughly +80 MB per target
because electron-builder picks only the matching platform from
`extraResources` (it doesn't ship Linux binaries inside the mac
build, etc.).

## Verifying after a build

```bash
npm run package:mac    # or :win / :linux
```

Then inside the installed app, open Files / MP3 / Video — convert
anything that runs ffmpeg. If a `spawn ENOENT` shows, the resolver
fell through to the PATH lookup which means the bundled binary path
is wrong or the file is missing.
