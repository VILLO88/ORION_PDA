# Tools

| tool | what it does |
|---|---|
| `image.py` | converts a PNG, JPG or other picture to `.obm`, with dithering. Needs ffmpeg |
| `obm_view.py` | turns an `.obm` back into a PNG, to check it |
| `obm_panel.py` | converts an `.obm` to the panel layout and back |
| `sound.py` | converts an audio file to a 48 kHz WAV for `sfx_load`, or synthesizes a simple effect |
| `sound_library.py` | rebuilds the sounds in `../sounds/` from their recipes |
| `lualint` | finds globals a script reads but never assigns: misspelled names and `local`s used above their declaration |

Run any Python tool with `-h` for its options. Usage is explained in the guide
at [orionpda.org/sdk](https://orionpda.org/sdk) (chapters 3 and 5, and the
image format page).

`lualint` is built with `make` from the SDK root:

```
make lualint
tools/lualint my_app.lua
```

It reads the compiled bytecode, so it does not check argument types or a
wrong name inside a table such as `orion.gfx.clea`; the VS Code definitions
in `editor/` catch the latter.

`make check` runs `lualint` on the examples and checks the image and sound
tools.
