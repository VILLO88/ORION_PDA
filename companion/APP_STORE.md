# Publishing apps in the Orion App Store

Anyone with a GitHub account can publish a Lua app for ORION, for free, from
the Orion Companion. A moderator reviews **every version** before it goes
public; then everyone can find it, try it in the Companion's emulator,
install it on ORION, rate it and comment on it.

## Why every version is reviewed

An ORION app can read and write the **whole microSD** through `shared/`
paths: one careless or malicious app could delete someone's notes. The store
reads your code and shows what it uses — **Whole card** (`shared/`, except the
system sounds in `shared/sounds/`), Serial, GPIO, I2C, Bluetooth, Mesh radio,
**Compiled code** (`.luac`, which the moderator cannot read) — to the
moderator, and to users on the app page. Apps marked *Whole card* ask users
to confirm before installing. Use `shared/` only when the app really needs it.

## Your app's folder

An app is one Lua file, plus an optional data folder. Either layout works:

```
myapp.lua                    myapp.lua
data/myapp/…                 myapp/…
(the emulator's card)        (the SDK examples)
```

On ORION the script goes to `/apps/myapp.lua` and the data folder to
`/apps/data/myapp/` — the `data/` your app reads and writes.

- **The file name is the app's name on the card**: 2-27 characters, lowercase
  letters, digits, `-` and `_`. It belongs to whoever publishes it first.
- The script is at most **32 KB** (ORION refuses bigger scripts): put the rest
  in modules under the data folder, as DOOM does.
- The package is at most **4 MB** and 200 files. Data file names: letters,
  digits, `.`, `-`, `_`.
- In the publish form every data file has a tick box. `README.md`,
  `LEGGIMI.md` and `.py` sources are left out by default.

## The head of your script

The form is filled from the comment at the top of the script:

```lua
-- myapp.lua: one line that says what it is (the summary).
-- category: games          games, office, utility, radio, music, dev, other
-- version: 1.0.0           optional
-- api: 0.3.0               optional: the firmware API it needs
-- title: My App            optional
--
-- Keys: … everything else in this comment block becomes the description
-- (Markdown), which you can still edit in the form.
```

## Publishing

1. Companion → **App Store** → **Sign in with GitHub**.
2. **My apps** → **Choose .lua…**.
3. **Try in emulator**: the app runs as it is on your disk. **Capture**
   adds the screen (536×336 at 2×) to the screenshots. You can also add
   PNG/JPEG images of your own: up to 5, 1 MB each.
4. Check title, summary, category, version and description, then **Send for
   review**.

The version waits for a moderator; **My apps** shows its state and, if it is
rejected, why. One version at a time can wait: withdraw it to send another.

**Updates**: choose the same `.lua` again and raise the version number. If
you add no screenshots, those of the version in the store carry over. On
ORION an update overwrites the package's files and leaves alone what the app
saved by itself (scores, records).

## The emulator is not the device

The Companion's emulator runs the same code as ORION (same Lua, same API,
same 32-bit memory limits), but not at the same speed: on ORION a full-screen
frame takes ~75 ms. Expansion port, Bluetooth, mesh radio and microphone are
not emulated. Try the app on a real ORION before publishing if you can.

## Server

The store is run by the ORION project (a Cloudflare Worker at
`orion-store.villanimatteo88.workers.dev`); its code is not part of the
Companion's source. The Companion talks to it over HTTPS, and a fork can
point to another instance with the `ORION_STORE_URL` environment variable.
