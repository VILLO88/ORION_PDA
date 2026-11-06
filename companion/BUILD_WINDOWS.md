# Build Orion Companion on Windows

Step-by-step per produrre `Orion Companion Setup <ver>.exe` (NSIS) e
`Orion Companion-<ver>-win.zip` (portable da scompattare) su una macchina Windows 10/11
x64. **Build non firmato**: l'installer mostrerà l'avviso SmartScreen
"Unknown publisher" finché non procuriamo un certificato.

---

## 1. Prerequisiti

Installa via [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/)
da PowerShell (apri "Windows PowerShell" o "Terminal" come utente
normale, NON come admin):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Verifica:

```powershell
node --version    # >= 20.x
npm --version
git --version
```

Riavvia il terminale dopo l'install per ricaricare il `PATH`.

---

## 2. Clone della repo

```powershell
cd $HOME\Documents
git clone https://github.com/VILLO88/ORION_PDA.git
cd ORION_PDA\companion
npm install
```

`npm install` compila qualche dipendenza nativa (jimp, pdfjs-dist).
Su Windows quasi tutto è puro JS, niente toolchain C/C++ richiesta.

---

## 3. Procura i binari nativi (ffmpeg + dfu-util)

### ffmpeg + ffprobe (essentials build di gyan.dev)

Scarica:

```
https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
```

Estrai con tasto destro → "Extract All". Dalla cartella estratta apri
`ffmpeg-X.Y-essentials_build\bin\` e copia **ffmpeg.exe** e
**ffprobe.exe** dentro la repo:

```
ORION_PDA\companion\src\main\resources\ffmpeg\win32-x64\
  ffmpeg.exe
  ffprobe.exe
```

(Crea la cartella se non esiste.) La build "essentials" è statica —
nessuna DLL da copiare. Verifica con:

```powershell
.\src\main\resources\ffmpeg\win32-x64\ffmpeg.exe -version
```

### dfu-util

Scarica dal sito ufficiale:

```
https://dfu-util.sourceforge.net/releases/
```

Cerca `dfu-util-0.11-binaries.tar.xz` (o versione più recente). Estrai
(7-Zip va bene) e prendi **dfu-util.exe** dalla cartella `win32` o
`win64`:

```
ORION_PDA\companion\src\main\resources\dfu-util\win32-x64\
  dfu-util.exe
```

Verifica:

```powershell
.\src\main\resources\dfu-util\win32-x64\dfu-util.exe --help
```

---

## 4. Genera l'icona per Windows

Manca uno script: `build-mac-icon.mjs` produce solo `.icns` e `.png`.
Per `.ico` due opzioni:

**A. Conversione online veloce** (per ora la più rapida):
1. Vai su [icoconvert.com](https://icoconvert.com/) o
   [convertio.co/png-ico](https://convertio.co/png-ico/).
2. Carica `build\icon.png` (generato sul mac e committato in repo).
3. Configura: multi-size ICO (16, 32, 48, 64, 128, 256 px).
4. Scarica come `icon.ico` e salvalo in `build\icon.ico`.

**B. Via Inkscape o ImageMagick** (se installati):

```powershell
magick build/icon.png -define icon:auto-resize=16,32,48,64,128,256 build/icon.ico
```

(ImageMagick: `winget install ImageMagick.ImageMagick`)

---

## 5. Package

```powershell
npm run package:win
```

Output in `dist\`:

```
Orion Companion Setup 0.X.0.exe        ← installer NSIS (~ 150 MB)
Orion Companion-0.X.0-win.zip          ← portable: si scompatta e si lancia

⚠️ Il target `portable` (un .exe che si scompatta da solo) e' stato tolto il
6/11/2026: si scompatta in `%TEMP%` a ogni avvio, e su Windows 11 li' il
`ffmpeg.dll` di Electron (non firmato) veniva bloccato — "ffmpeg.dll non e'
stato trovato" — mentre l'installer sullo stesso PC funzionava.
win-unpacked\                          ← bundle non compresso
```

---

## 6. Test

### Installer
1. Doppio-click su `Orion Companion Setup *.exe`.
2. SmartScreen blocca: clicca **More info → Run anyway**.
3. Installer NSIS classico. Default: `C:\Users\<you>\AppData\Local\Programs\Orion Companion`.
4. Avvio: cerca "Orion Companion" nel menu Start.

### Smoke test
- **Files**: drop file → upload SD.
- **MP3**: drop audio → conversione (ffmpeg dal bundle).
- **Video**: drop mp4 → `.av` generato.
- **Firmware**: pagina firmware mostra path `…\resources\dfu-util\win32-x64\dfu-util.exe`.

### WinUSB driver per il DFU

Se la pagina Firmware dice "no DFU device found" anche con il PDA in
modalità DFU, manca il driver WinUSB sull'interfaccia DFU.

Una volta sola per ciascuna macchina:

1. Scarica [Zadig](https://zadig.akeo.ie/).
2. Metti il PDA in DFU (Settings → FIRMWARE UPDATE sul device).
3. In Zadig: **Options → List All Devices**, seleziona **STM32 BOOTLOADER**.
4. Driver target: **WinUSB**. Click **Install Driver**.
5. Aspetta ~30 s, replug il device.

Se invece hai STM32CubeProgrammer installato, di solito il driver è
già a posto.

---

## 7. Distribuzione

Per ora upload diretto del `.exe` (installer o portable) sul tuo
sito. Gli utenti vedranno l'avviso SmartScreen al primo download.

In futuro, per togliere l'avviso, serve un **codice EV** firmato da
una CA riconosciuta (~200-400€/anno: Sectigo, DigiCert, ecc.).

---

---

## 8. Cosa **non** funziona su questa piattaforma (e cosa fare)

Aggiornato il 23/9/2026, quando e' arrivato il calendario.

### Il calendario di sistema non e' raggiungibile

⚠️ **E non e' un "non l'abbiamo ancora fatto": non c'e' una strada.**
L'API moderna di Windows (`Windows.ApplicationModel.Appointments`,
`AppointmentStore`) funziona **solo per app impacchettate MSIX** che dichiarano
la capability: un'app Electron distribuita come installer NSIS non lo e', e non
puo' diventarlo senza rifare l'impacchettamento. L'alternativa storica e'
Outlook via COM/MAPI, che pretende Outlook desktop installato e vale solo per
chi usa quello.

**La strada che c'e'**: nella pagina Calendar si trascina un file **`.ics`**,
esportato da qualunque programma di calendario. Sostituisce il calendario di
sistema come sorgente, passa per lo stesso scrittore e produce lo stesso
`.cal`: il dispositivo non sa da dove sono arrivati gli eventi. Non tocca
**nessun** sistema di permessi. Funziona gia' oggi, senza niente da aggiungere.

Se un giorno servira' l'automatismo, la cosa da fare **non** e' inseguire
l'API di sistema: e' **CalDAV**, che su tutte e tre le piattaforme parla con
Google e iCloud e diventa una terza sorgente per lo stesso scrittore. Vedi
`PDAV3/CALENDARIO.md`.

### Il Bluetooth e' da provare

⚠️ **Mai provato qui.** Il trasferimento verso il dispositivo passa da **Web
Bluetooth**, cioe' da Chromium: su Windows si appoggia a WinRT e vuole Windows 10 1703 o
successivo. Dovrebbe funzionare, ma "dovrebbe" non e' una misura.

E' la prova da mettere **in cima alla lista** prima di distribuire, perche' da
li' passano note, ebook e calendario. Il cavo (USB MSC) funziona a prescindere
ed e' il ripiego se il Bluetooth non regge.

### L'helper del Calendario non si costruisce (ed e' giusto)

`npm run build` chiama `scripts/build-calendario.mjs`, che fuori da macOS
**stampa una riga e non fa niente**: EventKit esiste solo li'. Non e' un
errore e non ferma la build.

---

## Troubleshooting

| Sintomo | Causa probabile | Fix |
|---|---|---|
| `spawn ffmpeg ENOENT` al packaged | Bin non in `resources\ffmpeg\win32-x64\` | Vedi step 3, verifica path |
| `electron-builder` errore "icon.ico not found" | `build\icon.ico` mancante | Vedi step 4 |
| Build OK ma app crash all'avvio | Antivirus blocca electron unsigned | Aggiungi exception per la cartella |
| DFU device non visto | WinUSB driver assente | Vedi step 6 (Zadig) |
| `npm install` molto lento | Dietro proxy o npm registry slow | `npm config set registry https://registry.npmjs.org/` |
