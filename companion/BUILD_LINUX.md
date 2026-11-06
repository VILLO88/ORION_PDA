# Build Orion Companion on Linux (Fedora 39+ / Ubuntu 22.04+)

Step-by-step per produrre `Orion Companion-<ver>.AppImage` e
`orion-companion_<ver>_amd64.deb` su Linux x86_64. Esempi per
**Fedora**; le note Ubuntu/Debian sono in-line.

---

## 1. Prerequisiti

### Fedora

```bash
sudo dnf install -y nodejs npm git dfu-util
```

Verifica versioni:

```bash
node --version    # >= 20.x
npm --version
git --version
dfu-util --version
```

Se `nodejs` su Fedora è vecchio (<20), abilita NodeSource:

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

### Ubuntu/Debian

```bash
sudo apt update
sudo apt install -y nodejs npm git dfu-util libusb-1.0-0
# Se nodejs < 20:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## 2. Clone della repo

```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/VILLO88/ORION_PDA.git
cd ORION_PDA/companion
npm install
```

---

## 3. Procura i binari nativi (ffmpeg + dfu-util)

### ffmpeg + ffprobe (static da johnvansickle.com)

```bash
cd /tmp
curl -L -O https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar xJf ffmpeg-release-amd64-static.tar.xz
cd ffmpeg-*-amd64-static/
mkdir -p ~/src/orion-companion/src/main/resources/ffmpeg/linux-x64
cp ffmpeg ffprobe ~/src/orion-companion/src/main/resources/ffmpeg/linux-x64/
chmod +x ~/src/orion-companion/src/main/resources/ffmpeg/linux-x64/{ffmpeg,ffprobe}
```

Verifica che siano davvero statici:

```bash
ldd ~/src/orion-companion/src/main/resources/ffmpeg/linux-x64/ffmpeg
# output atteso: "not a dynamic executable"
```

### dfu-util

Su Fedora il binario di sistema è OK. Vediamo se è statico (non lo
è di solito, ma le dipendenze sono solo `libusb` e libc — di solito
già installate ovunque):

```bash
ldd $(which dfu-util)
# tipicamente: libusb-1.0.so.0 + libc.so.6 + ld-linux-x86-64
```

Strategia: copia il binario e dichiara `libusb-1.0` come dipendenza
del `.deb` (per AppImage va embedded). Più semplice:

```bash
DEST=~/src/orion-companion/src/main/resources/dfu-util/linux-x64
mkdir -p $DEST
cp $(which dfu-util) $DEST/dfu-util
chmod +x $DEST/dfu-util
```

Per **AppImage** electron-builder bundla solo la cartella `resources`
così com'è. Su distribuzioni dove `libusb-1.0.so.0` non è installata,
`dfu-util` fallirà con "shared library not found". Soluzioni:

- **Pragmatica**: documentare nel README che gli utenti Linux devono
  avere `libusb-1.0` (è una dipendenza standard su quasi tutto).
- **Completa**: copiare anche `libusb-1.0.so.0` in `linux-x64/` e
  usare `patchelf` per cambiare il rpath:

  ```bash
  sudo dnf install -y patchelf
  cp /usr/lib64/libusb-1.0.so.0 $DEST/   # path varia per distro
  patchelf --set-rpath '$ORIGIN' $DEST/dfu-util
  ldd $DEST/dfu-util   # ora deve trovare libusb in $DEST/
  ```

---

## 4. Genera l'icona Linux

Già pronta: `build/icon.png` (512×512) viene generato da
`scripts/build-mac-icon.mjs` sul mac e committato in repo. Se manca,
da Linux puoi rigenerarlo con qualsiasi tool che faccia padding +
resize, oppure:

```bash
# Da media/logo.png (1536×1024), pad a 1536×1536 + resize a 512:
sudo dnf install -y ImageMagick
magick media/logo.png -background transparent -gravity center \
  -extent 1536x1536 -resize 512x512 build/icon.png
```

---

## 5. Package

```bash
cd ~/src/orion-companion
npm run package:linux
```

Output in `dist/`:

```
Orion Companion-0.X.0.AppImage             ← single-file, no install
orion-companion_0.X.0_amd64.deb            ← per Debian/Ubuntu
linux-unpacked/                            ← bundle non compresso
```

Nota: il `.deb` su Fedora non si installa direttamente (`rpm`
incompatibile). **Usa l'AppImage su Fedora.** Se servisse un `.rpm`,
si aggiunge a `electron-builder.yml`:

```yaml
linux:
  target:
    - AppImage
    - deb
    - rpm   # aggiungi questo
```

---

## 6. Test

### AppImage (Fedora & co.)

```bash
chmod +x dist/Orion\ Companion-*.AppImage
./dist/Orion\ Companion-*.AppImage
```

### .deb (Ubuntu/Debian)

```bash
sudo dpkg -i dist/orion-companion_*.deb
sudo apt -f install   # se ci sono dipendenze mancanti
orion-companion       # lancio da CLI
```

### Smoke test
- **Files**: drop file → upload SD.
- **MP3**: drop audio → ffmpeg dal bundle.
- **Video**: drop mp4 → `.av` generato.
- **Firmware**: pagina firmware mostra path
  `.../resources/dfu-util/linux-x64/dfu-util`.

### udev rule per DFU senza sudo

Senza questo, ogni `dfu-util` flash chiede sudo o fallisce con
"Cannot open DFU device". Una volta sola:

```bash
sudo tee /etc/udev/rules.d/99-orion-dfu.rules > /dev/null <<'EOF'
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Riconnetti il device dopo aver applicato la regola.

---

## 7. Distribuzione

Upload diretto del `.AppImage` (o `.deb`) sul tuo sito.

L'AppImage NON ha signing standard su Linux; gli utenti lo eseguono
direttamente senza prompt. Se vuoi un nome più "pulito" nel launcher,
usa [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher)
o aggiungi un `.desktop` file accanto.

---

---

## 8. Cosa **non** funziona su questa piattaforma (e cosa fare)

Aggiornato il 23/9/2026, quando e' arrivato il calendario.

### Il calendario di sistema non e' raggiungibile

⚠️ **E non e' un "non l'abbiamo ancora fatto": non c'e' una strada.**
Su Linux **non esiste "il" calendario di sistema**. C'e' Evolution
Data Server su GNOME e Akonadi su KDE, tutti e due via D-Bus, ciascuno presente
solo se c'e' quel desktop — e nessuno dei due su una macchina con XFCE, su un
server, o dentro un Flatpak senza i permessi giusti. Inseguirli vorrebbe dire
due integrazioni, ciascuna valida per meta' degli utenti.

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
Bluetooth**, cioe' da Chromium: su Linux si appoggia a **BlueZ**, e li' e' storicamente
capriccioso — dipende dalla versione di BlueZ e da come e' impacchettato
Chromium. Dentro un AppImage o un Flatpak ci sono di mezzo anche i permessi
D-Bus.

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
| `spawn ffmpeg ENOENT` packaged | Bin mancanti in `resources/ffmpeg/linux-x64/` | Vedi step 3 |
| `dfu-util: error while loading shared libraries: libusb-1.0.so.0` | Distro senza libusb | `dnf/apt install libusb-1.0`, o patchelf+bundle |
| Build crash: "Cannot find module 'jimp'" | `npm install` saltato o fallito | Rilancia `npm install` |
| AppImage non parte (Fedora 40+) | Manca `FUSE2` | `sudo dnf install -y fuse fuse-libs` |
| Permission denied su `/dev/ttyUSB0` o simili | Utente non in gruppo `dialout` / udev rule mancante | `sudo usermod -aG dialout $USER` + relog, oppure udev rule |
