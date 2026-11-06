# Helper del Calendario

Qui ci finisce **un binario compilato**, non versionato:

```
calendario/darwin-arm64/orion-calendario
calendario/darwin-x64/orion-calendario
```

Lo costruisce `npm run build:calendario` dal sorgente Swift in
`src/main/calendario/helper.swift` (lo fa anche `npm run build`, da solo).
Serve Xcode o gli strumenti da riga di comando: `xcode-select --install`.

⚠️ **Solo macOS.** L'helper usa EventKit, che altrove non esiste: su Windows e
Linux lo script di build stampa una riga e non fa niente, e la pagina Calendar
dice che la lettura del calendario di sistema e' disponibile solo su Mac.

⚠️ **Non e' un modulo nativo di Node**, ed e' il motivo per cui e' un
eseguibile: non ha nessuna ABI in comune con Electron, quindi non va
ricompilato quando Electron cambia versione — solo quando cambia macOS. Vedi
`PDAV3/CALENDARIO.md` §5.
