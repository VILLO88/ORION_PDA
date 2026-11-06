# Writing ORION apps in VS Code

Install the **Lua** extension by sumneko (`sumneko.lua`, listed as just "Lua"
in the marketplace). Then open the SDK folder: the `.luarc.json` there points
the extension at `orion.stub.lua`, and VS Code completes `orion.gfx.`, shows
the arguments of each function and flags names that do not exist.

If your apps live in a folder of your own, copy `editor/luarc.template.json`
into it as `.luarc.json` and set the path of the definitions:

```json
{ "workspace.library": ["/path/to/the/SDK/editor"] }
```

The editor does not know the device's limits (for example that
`present_area` ignores `y` and `h`); those are in the reference at
[orionpda.org/sdk](https://orionpda.org/sdk). To see the
app running, use the emulator:

```
make
./emulator/orion-emu emulator/card/apps/your_app.lua
```

`orion.stub.lua` is only for the editor: do not copy it to the card.
