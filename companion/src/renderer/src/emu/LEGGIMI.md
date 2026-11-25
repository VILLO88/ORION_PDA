# L'emulatore di ORION, compilato in WebAssembly

`orion-emu.mjs` **non si modifica qui**: e' generato dalla SDK.

```
cd ../SDK/emulator && make web        # vuole Emscripten: brew install emscripten
cd OrionCompanion && npm run emu:copia
```

Un file solo (WebAssembly e suoni di sistema dentro, `SINGLE_FILE`), caricato
solo quando si preme "Try": vedi `src/renderer/src/lib/emulatore.ts`.
