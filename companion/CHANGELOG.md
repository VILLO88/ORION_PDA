# Changelog


## [0.13.0] — 25 novembre 2026

In breve: l'**App Store** delle app Lua (pubblicare, provare, installare,
votare, commentare), l'**emulatore di ORION dentro la Companion**, le **note
in Markdown** e la pagina **Wikipedia**.

⚠️ **Firmware.** App Store via USB ed emulatore vanno col firmware di oggi.
Il firmware **0.3.0, in arrivo**, serve a tre cose: l'app `wiki` che legge
cio' che converte la pagina Wikipedia (la conversione si fa gia' adesso), le
note `.md` create e mostrate renderizzate sul dispositivo (la Companion le
gestisce comunque), e le rifiniture dell'installazione via Bluetooth, che
intanto funziona con ORION sulla home.

**App Store** (pagina nuova nella barra laterale). Chi scrive app Lua per ORION
le pubblica gratis dalla Companion; un moderatore approva ogni versione; poi
tutti le trovano, le installano sulla card con un clic, le votano (1-5, un voto
per account) e le commentano.

- **Server**: un Worker Cloudflare (D1 per app, versioni, voti, commenti,
  segnalazioni; R2 per i pacchetti), gestito dal progetto e fuori dal
  sorgente pubblico. La Companion punta a
  `orion-store.villanimatteo88.workers.dev` (`ORION_STORE_URL` per un'altra
  istanza).
- **Account**: login con GitHub, col giro del loopback come per Notion. Il
  token di GitHub non arriva all'app; quello dello store e' tenuto con
  `safeStorage`, e il server ne conserva solo lo SHA-256.
- **Moderazione prima della pubblicazione**, perche' un'app su ORION puo'
  scrivere su tutta la microSD con `shared/`. Il server legge il codice e
  segnala `shared` (non per `shared/sounds/`, i suoni di sistema che ogni app legge), `serial`, `gpio`, `i2c`, `ble`, `mesh`, codice compilato:
  il moderatore lo vede in coda, l'utente sulla pagina dell'app, e prima di
  installarne una che usa `shared/` gli si chiede conferma. I moderatori sono i
  login in `ADMINS`; possono provare una versione sulla loro ORION prima di
  approvarla, nascondere app e commenti, bannare.
- **Pubblicare**: si sceglie il `.lua`; la cartella dati e' `data/<nome>/`
  accanto, come nella card dell'emulatore, oppure una cartella col nome dello
  script accanto a lui, come negli esempi della SDK (`doom.lua` + `doom/`).
  Sottocartelle comprese; sulla card finisce sempre in `/apps/data/<nome>/`.
  Ogni file ha la sua spunta: README, LEGGIMI e sorgenti `.py` sono fuori di
  default, e dimensione e numero di file si ricontano a ogni spunta. Titolo, sommario, categoria,
  versione e descrizione vengono dal commento in testa allo script
  (`-- category:`, `-- version:`, `-- api:`), e si correggono nel modulo.
  Controlli prima di inviare: nome valido per la card, script entro 32 KB,
  pacchetto entro 4 MB.
- **Sulla card**: `apps/<nome>.lua` e `apps/data/<nome>/`, nient'altro; lo
  SHA-256 del pacchetto si verifica prima di scrivere. Un aggiornamento
  sovrascrive i file del pacchetto e lascia cio' che l'app ha salvato da se'.
  Le versioni installate dallo store sono in `apps/.store.json` (il launcher non
  lo vede), da cui "update available". La pagina avvisa oltre le 15 app, il
  massimo che il launcher mostra.
- **Screenshot**: fino a 5 immagini PNG o JPEG per versione (1 MB l'una), fatte
  dall'autore come preferisce, di solito catturando la finestra
  dell'emulatore. Si aggiungono e si riordinano nel modulo di pubblicazione,
  si moderano con la versione e compaiono nell'elenco (la prima), sulla pagina
  dell'app (galleria, clic per ingrandire, frecce) e in coda. Un aggiornamento
  senza immagini tiene quelle della versione approvata. Passano dal processo
  principale come `data:`: la pagina accetta solo quelle (e ora anche gli avatar
  di GitHub, che prima la CSP bloccava).
- **L'emulatore di ORION dentro la Companion** (WebAssembly, lo stesso della
  SDK: `make -C emulator web`, poi `npm run emu:copia`). Un modulo solo da 1,8 MB
  con i suoni di sistema, caricato solo quando serve:
  - **Try** sulla pagina di ogni app: la si prova senza ORION (non conta come
    download, `?try=1`);
  - **Try in emulator** in coda di moderazione: il moderatore prova la versione
    in attesa senza la scheda;
  - **Try in emulator** nel modulo di pubblicazione, sul `.lua` del disco, con
    **Capture**: lo schermo (536x336 a 2x, PNG) va dritto negli screenshot.
  Tasti come nell'emulatore della SDK (F1-F4, Alt = Fn) piu' i pulsanti MENU,
  SAVE, SEARCH, PLAY, ESC; il log mostra `orion.sys.log` e gli errori Lua. La
  CSP della pagina ora permette `wasm-unsafe-eval` e `connect-src data:`.
- **Installare via Bluetooth**, senza cavo: se ORION non e' collegata in USB ma
  lo e' via Bluetooth, Install, Update, Remove e la scheda Installed passano
  dalla radio (`src/renderer/src/lib/storeBle.ts`). Stesse regole dell'USB, e
  si mandano solo i file diversi da quelli gia' sulla card (dimensione e
  CRC), quindi un aggiornamento muove solo cio' che e' cambiato. Avanzamento e
  tempo stimato nella riga di stato; sopra il minuto (~0,5-1,3 kB/s) chiede
  conferma e suggerisce il cavo. Pulsante "Connect over Bluetooth" dove serve.
  Funziona col firmware dei betatester (con ORION sulla home); il firmware
  0.3.0, in arrivo, permette anche di restare in Apps, ci mostra subito l'app
  nuova e rifiuta di sovrascrivere un'app mentre gira.
- Prove (repo privata, insieme al server): `npm run prova:store` — il Worker vero contro SQLite (100 controlli) e
  i moduli della Companion contro il Worker in locale, con gli esempi della SDK
  (36 controlli).

**Note in Markdown.** Dal firmware del 25/11/2026 ORION chiede, a ogni nota
nuova, se farla `.txt` o `.md`. La Companion ora le vede tutte e due.

- Pagina Note: le `.md` compaiono nell'albero (con l'etichetta `MD`) e
  l'anteprima ha il toggle **Rendered / Source**, ricordato fra una sessione e
  l'altra. L'HTML e' ristretto (`src/renderer/src/lib/markdown.ts`): l'HTML
  scritto dentro la nota esce come testo, i link e i `[[wiki link]]` sono solo
  testo sottolineato, le immagini mostrano il loro testo alternativo.
- Copia, sposta, rinomina (l'estensione resta quella), cancella e backup
  accettano le `.md`; anche lo specchio Bluetooth le porta nei due versi.
- Sync con **Obsidian**: una nota nuova che arriva dalla vault nasce sul
  dispositivo come `.md`, quindi si vede renderizzata. Quelle gia' arrivate
  come `.txt` restano `.txt`.
- Sync con **Notion**: le `.md` del dispositivo si sincronizzano come le
  altre; una pagina nuova da Notion resta `.txt` (il suo testo e' piano).
- ⚠️ `foo.txt` e `foo.md` nella stessa cartella hanno la stessa chiave di
  sincronizzazione: il sync la salta e dice di rinominarne una, invece di
  sceglierne una a caso.

**Wikipedia per ORION** (pagina nuova nella barra laterale). Si sceglie uno ZIM
di Kiwix e la Companion lo converte nel formato dell'app `wiki` di ORION:
testo ripulito e traslitterato per il pannello, link gia' risolti, indice dei
titoli per la ricerca mentre si scrive, coordinate per cercare il posto in cui
ci si trova. Va sulla card (`wiki/<nome>`) o in una cartella.

- Il lettore ZIM e' in TypeScript puro (`src/main/wiki/zim.ts`, zstd con
  `fzstd`): nessun modulo nativo da ricompilare. Gli ZIM vecchi in xz sono
  rifiutati con un messaggio.
- Sostituisce lo script Python della SDK (`zim2orion.py`), controllato byte per
  byte sulla Wikipedia italiana "top" (50 002 articoli): indici identici e
  testo identico per ogni articolo. Cinque volte piu' veloce (22 s contro 110).
- Da riga di comando: `npm run wiki -- FILE.zim CARTELLA`.
- ⚠️ Su ORION serve il firmware con l'API 0.3.0 (`file:seek`), in arrivo:
  la pagina lo dice in alto, prima di convertire.


## [0.12.2] — 6 novembre 2026

**La Companion e' pubblica.** Il sorgente sta nella cartella `companion/`
della repo [VILLO88/ORION_PDA](https://github.com/VILLO88/ORION_PDA), e le versioni
pronte per macOS, Windows e Linux nelle sue Release. Il programma non cambia.

- `LICENSE` (MIT) e `THIRD_PARTY_NOTICES.md`: FFmpeg, dfu-util e libusb,
  inclusi nei pacchetti, hanno le loro licenze (GPL e LGPL), e i loro testi
  viaggiano con l'app (accanto a `LICENSE.electron.txt` su Windows e Linux, in
  `Contents/` su macOS).
- `scripts/esporta-pubblico.sh` copia nella repo pubblica l'ultimo commit,
  senza storia git e senza le note di lavoro interne.
- README e istruzioni di build puntano alla repo pubblica.


## [0.12.1] — 6 novembre 2026

**Windows: la portable ora e' uno zip.** Il `.exe` portable si scompattava
da solo in `%TEMP%` a ogni avvio, e su Windows 11 non partiva: "ffmpeg.dll
non e' stato trovato". La libreria c'era nel pacchetto (verificato), ma li'
Windows la blocca; l'installer sullo stesso PC funzionava. Ora c'e'
`Orion Companion-<ver>-win.zip`: si scompatta una volta dove si vuole (anche
su una chiavetta) e si lancia `Orion Companion.exe`. Parte anche piu' in
fretta, perche' non riscompatta 150 MB a ogni avvio.

**Ogni pacchetto porta solo i suoi programmi.** ffmpeg, dfu-util e l'helper
del calendario erano copiati per intero in tutti i pacchetti, quindi i
binari per Mac finivano anche in quelli per Windows e Linux.

Provato su Windows 11 con l'installer 0.12.0: si apre, e il Bluetooth crea
una cartella nelle note.


## [0.12.0] — 6 novembre 2026

Prima release dopo la 0.11.0 di giugno. Raccoglie tutto il lavoro di
settembre e ottobre descritto nelle voci qui sotto: note ed ebook senza cavo,
calendario (dal Mac, o da un file `.ics`), note protette, video a 15
fotogrammi al secondo e a pezzi sopra il 1080p, niente riconversioni inutili.

⚠️ **Il numero di versione era fermo a 0.11.0 da giugno**, mentre il dmg per
Mac veniva ricostruito con le modifiche nuove: un "0.11.0" per Mac di ottobre
e uno per Windows/Linux di giugno erano due programmi diversi con lo stesso
nome. Da qui in poi ogni build distribuita ha la sua versione.

### Il deposito delle note protette sta su ORION (10 ottobre 2026)

**Vuole il firmware del 10/10/2026.** Il deposito non sta più sulla microSD
ma nella flash di ORION; sulla card resta solo la sua sigla
(`/NOTE/.orion_vault_id`). La Companion ne tiene una copia in
`userData/note-vaults/<sigla>.vault`, un file semplice, uguale su macOS,
Windows e Linux.

- se la copia manca (prima volta, o password cambiata) **Unlock** la chiede a
  ORION sulla console USB con Web Serial: la password si batte **su ORION**;
- il backup cifrato porta con sé la copia, e dice quando manca;
- dalla copia si può ridare il deposito a ORION (`vault put`), scegliendo
  quella giusta con la password;
- lo specchio Bluetooth porta anche la sigla.

### Da provare su Windows e Linux prima di distribuire

Provato finora solo su macOS. Fuori dal Mac non sono mai stati provati il
**Web Bluetooth** (note, ebook e calendario senza cavo) e il **Web Serial**
(copia del deposito). Il calendario di sistema c'è solo su macOS: altrove si
usa l'import `.ics`.


## 9 ottobre 2026 — i video a 15 fotogrammi al secondo

I video si convertono a **15** fotogrammi al secondo invece di 10: il
movimento e' piu' fluido, e si attenua l'effetto "a tendina" che si vedeva
sulle panoramiche. **Vuole il firmware del 9/10/2026**, che manda i video al
pannello piu' in fretta (3 MHz invece di 2,5): con uno piu' vecchio un file a
15 salta fotogrammi. I file gia' convertiti a 10 continuano ad andare.
⚠️ I file crescono del 50% circa: un film intero passa i 4 GB della FAT32 e
va spezzato.

`scripts/spezza-av.mjs` spezza un `.av` in parti riproducibili da sole,
tagliando fra un fotogramma e l'altro: `node scripts/spezza-av.mjs film.av`.
⚠️ Il dispositivo non apre i video con un nome piu' lungo di 31 caratteri: lo
script avvisa.


## 9 ottobre 2026 — il Bluetooth dentro le pagine

La pagina **Bluetooth** non c'e' piu': quello che faceva sta dove serve, come
gia' per il calendario. **Vuole il firmware del 9/10/2026** (protocollo 2): con
uno piu' vecchio le pagine lo dicono, e il calendario continua a funzionare.

**Notes** — senza cavo, *Use Bluetooth*: la pagina e' quella di sempre, con
tutto: albero, anteprima, `PRIVATE`, backup, sync con Obsidian e Notion.
Lavora su uno **specchio**, una copia di `/NOTE` tenuta sul PC e allineata al
dispositivo: la prima volta legge ogni nota (lento), poi solo cio' che e'
cambiato. Ogni modifica fatta dalla Companion va sul dispositivo subito dopo.
⚠️ Se la radio cade prima che una modifica arrivi, resta nello specchio e
parte **per prima** alla connessione successiva: senza, una nota arrivata da
Obsidian e mai giunta al dispositivo sparirebbe, e il sync dopo la
cancellerebbe anche da Obsidian.
⚠️ *Reload* rilegge dal dispositivo cio' che e' cambiato li'. Se la stessa
nota e' stata cambiata da tutte e due le parti fra un Reload e l'altro, vince
quella del PC.

**Ebooks** — terza destinazione, *Bluetooth*: converte e manda in `/books`.
Un libro intero sono molti minuti: sopra i 100 kB dice quanto ci vorra' e
chiede, libro per libro.

**Files resta solo via cavo.** Navigare la scheda via radio era stato scritto
e poi tolto lo stesso giorno, su richiesta: il Bluetooth serve a note, ebook e
calendario.

⚠️ Corretto: la vecchia pagina mandava i `.txt` in `/notes`, una cartella che
il dispositivo non legge (le note stanno in `/NOTE/<categoria>/`).

⚠️ **Provato contro un dispositivo finto, non contro ORION**: il codice vero
del firmware compilato sul PC, dietro un Bluetooth che taglia i pacchetti come
macOS. La radio vera puo' ancora dire la sua.


## 9 ottobre 2026 — le note protette (`PRIVATE`)

Il dispositivo ora ha una categoria di note **cifrate**, `NOTE/PRIVATE`, con
file `.enc` al posto dei `.txt`. La Companion le sa aprire: nella pagina Notes
la cartella ha un lucchetto, **Unlock** chiede la password impostata sul
dispositivo, e da li' le note si leggono come le altre.

⚠️ **Chiusa, `PRIVATE` risulta vuota**: ne' titoli ne' quante note ci sono,
come sul dispositivo. Si richiude da sola dopo dieci minuti senza usarla, con
**Lock now**, e uscendo dall'app.

⚠️ **La chiave resta nel processo principale.** Non va al renderer, non va su
disco, non va nei log. La password si usa e si lascia cadere.

⚠️ **In Electron `node:crypto` non ha ChaCha20-Poly1305.** Electron usa
BoringSSL al posto di OpenSSL: scrypt c'e', quel cifrario no
(`Unknown cipher`). La prima versione funzionava in ogni prova fatta con
`node` e dentro l'app non apriva niente — e prendeva l'errore per "password
sbagliata", chiudendo il dialogo senza una parola. Ora il cifrario e' scritto
in `src/main/notes/chacha.ts`, confrontato con `node:crypto` dove c'e' (91
casi, nei due versi) e **fatto girare dall'eseguibile di Electron** sul
deposito vero. E solo un sigillo che non torna vuol dire "password sbagliata":
ogni altro errore esce com'e'. Stessa lezione del Bluetooth: provato con
`node` non vuol dire provato in Electron.

I formati li definisce il firmware (`deposito.h`, `ui_note.c`) e lo scambio
col dispositivo e' provato li', in `prove_pc/`, nei due versi.

⚠️ **Il backup dipende da `PRIVATE` aperta o chiusa.** Aperta, le note
protette vanno nel backup **in chiaro**, come `.txt` dentro `PRIVATE/`:
sbloccare e' il consenso, e un backup che si apre solo col dispositivo in mano
serve a poco. Chiusa, vanno **cosi' come sono, cifrate** — per copiare un file
cifrato la chiave non serve — e insieme va il deposito (`.orion_vault`),
perche' una nota cifrata senza il suo deposito non si apre piu'.

⚠️ **Una nota non passa da una zona all'altra.** Copiare o spostare fra
`PRIVATE` e il resto viene rifiutato, dicendolo: cambierebbe cartella ma non
contenuto, e il dispositivo non elencherebbe ne' un `.txt` dentro `PRIVATE`
ne' un `.enc` fuori. E `PRIVATE` non si rinomina: e' dal nome che il firmware
la riconosce.

⚠️ **Obsidian e Notion: `PRIVATE` si sincronizza solo da aperta.** Aperta,
dall'altra parte nasce una cartella (o pagina) `PRIVATE` con le note **in
chiaro**, e cio' che torna indietro viene **cifrato** prima di toccare la
microSD: sul dispositivo dentro `PRIVATE` ci sono solo `.enc`, copie di
conflitto comprese. Il confronto si fa sul testo, non sul file — il file
cifrato cambia a ogni salvataggio. Chiusa, resta fuori in tutti e due i versi
e le sue righe nel manifest passano avanti intatte: una nota che non si vede
non e' una nota cancellata.
⚠️ Vuol dire che **quelle note stanno in chiaro nella vault e su Notion**: e'
la scelta fatta, ma va saputo quando si decide cosa mettere in `PRIVATE`.

⚠️ **Una nota col nome troppo lungo non scende sul dispositivo.** Il firmware
riapre una nota dal titolo che tiene in memoria: oltre **47 caratteri** (23
per le cartelle) la nota comparirebbe in elenco senza potersi aprire. Il sync
la rifiuta e lo dice fra gli errori, con il nome; rinominata, passa al giro
dopo. Vale per tutte le note, non solo per `PRIVATE`. Fino a oggi il limite
del firmware era 23 anche per i titoli, ed e' cosi' che e' saltato fuori.

⚠️ **Qui non c'e' il blocco dopo cinque tentativi.** Sul dispositivo ferma chi
lo ha in mano; sul PC non fermerebbe nessuno.

Non fatto: **modificare** una nota protetta dall'editor della Companion. Le
uniche scritture cifrate sono quelle delle sincronizzazioni.


## 8 ottobre 2026 — i video 4K si convertono a pezzi, in parallelo

Il tempo di una conversione e' quasi tutto **decodifica** del sorgente: ffmpeg
deve decodificare ogni fotogramma per tenerne dieci al secondo. Il dithering
in JS costa ~3 ms a fotogramma e non e' il collo di bottiglia.

Ora, su macOS e per i video **sopra il 1080p** di almeno un minuto, il video
viene diviso in quattro pezzi, ognuno col suo ffmpeg e la **decodifica
hardware** (VideoToolbox). Su quattro minuti di un film vero — 4K HEVC a 10
bit — **57,8 s diventano 25,0**. I due file sono identici byte per byte, audio
compreso.

⚠️ **Le due cose servono insieme.** La decodifica hardware da sola aiuta poco,
e piu' processi su CPU nemmeno: e' il decodificatore del chip a reggere piu'
flussi alla volta.

⚠️ **Non e' un guadagno su tutto**, e per questo c'e' la soglia. Su un 1080p
H.264 un pezzo e quattro pezzi fanno lo stesso tempo (5,0 s contro 5,0-5,1).

⚠️ **La GPU non c'entra col dithering**: Floyd-Steinberg e Atkinson propagano
l'errore da un pixel al successivo, sono sequenziali per costruzione.

Il formato si presta: ogni fotogramma ha un posto fisso nel file e il suo
blocco audio un posto fisso nel PCM, quindi il sincronismo non dipende da
quale pezzo finisce prima. Se la via a pezzi fallisce, la conversione
**ricomincia da capo** con quella di sempre. Per forzare quella di sempre:
`ORION_VIDEO_SERIALE=1`.

⚠️ Da fare: il dithering e' ancora su un thread solo; con quattro flussi su un
sorgente leggero diventerebbe lui il limite. E l'ffmpeg incluso nell'app
decodifica il 1080p piu' lentamente di quello di Homebrew sulla stessa
macchina (5,0 s contro 3,7): vale la pena capire con che opzioni e' compilato.


## 23 settembre 2026 — il calendario del Mac sul dispositivo

Nuova pagina **Calendar**: si scelgono i calendari, la finestra di tempo, si
guarda **cosa verra' mandato** e si scrive sulla microSD. Al posto del
segnaposto che c'era da sempre.

⚠️ **Il PC espande, il dispositivo legge.** Un calendario non e' un elenco di
appuntamenti ma un elenco di regole — ogni secondo martedi', tranne il 24
dicembre, spostato di un'ora dal fuso. Quelle regole le srotola EventKit sul
Mac, e sul dispositivo arriva una lista piatta gia' ordinata, con l'ora di
parete locale. Il dispositivo non sa cosa sia una ricorrenza, un fuso orario o
l'ora legale, ed e' la stessa scelta gia' fatta per gli ebook (`.pdar`) e per i
video (`.av`).

⚠️ **Un eseguibile Swift, non un modulo nativo di Node.** La lezione del
Bluetooth era "niente moduli da ricompilare a ogni versione di Electron", ma
quel problema e' l'ABI di Node, non il codice nativo: un binario che stampa
JSON su stdout non ha nessuna ABI in comune con Electron. Si ricompila quando
cambia macOS, non quando cambia Electron.

⚠️ **Su macOS 14 il permesso ha un nome nuovo.** La lettura degli eventi si
chiama "full access": servono tutte e due le stringhe nell'`Info.plist` e il
metodo nuovo nell'helper, altrimenti il sistema risponde "negato" **senza
mostrare nessun pannello**. Stesso genere di trappola della stringa del
Bluetooth, che in sviluppo non si vede e si vede solo nel pacchetto.

⚠️ **I caratteri li traduce il PC, e si vedono prima.** Il font del dispositivo
ha l'ASCII piu' otto caratteri: "Caffè" passa intero, "naïve" perde la dieresi,
il cirillico e le emoji spariscono. Per questo la pagina mostra l'anteprima dei
titoli **gia' tradotti**: accorgersene qui costa un secondo, accorgersene sul
dispositivo costa un giro di cavo.

**Anche senza un Mac**: si puo' trascinare nella pagina un file **`.ics`**
esportato da qualunque programma di calendario, e sostituisce il Calendario di
sistema come sorgente — stesso percorso da li' in giu'. Non e' un ripiego: su
Windows l'API del calendario vuole un'app impacchettata MSIX, e su Linux *il*
calendario di sistema non esiste (Evolution su GNOME, Akonadi su KDE). Il file
e' l'unica strada che hanno, ed e' anche la via d'uscita su macOS per chi non
vuole concedere il permesso.

Le ricorrenze le srotola `ical.js`, la libreria di Thunderbird: scriverle a
mano e' il modo piu' rapido di avere qualcosa che sembra funzionare e sbaglia
il quinto martedi' del mese.

**Anche senza cavo**: il pulsante *Send over Bluetooth* mette prima l'orologio
del dispositivo all'ora di questo Mac, poi chiede al dispositivo dimensione e
CRC del calendario che ha gia' e **non manda niente se e' identico** — che e'
il caso quasi sempre, perche' un calendario si risincronizza spesso e cambia
di rado.

**Privacy**: di default non e' selezionato nessun calendario; escono dal Mac
solo titolo, orario, luogo e nome del calendario — niente invitati, niente
note, niente inviti; e il file sulla scheda non e' cifrato, cosa che la pagina
dice invece di nascondere.


## 21 settembre 2026 — note ed ebook al dispositivo **senza cavo**

Nuova pagina **Bluetooth**: si connette a ORION, si scelgono i file, si
mandano. Le destinazioni sono quelle di sempre — `.txt` in `/notes`, `.pdar`
in `/books` — perche' un file arrivato via radio deve finire dove sarebbe
finito via cavo.

⚠️ **Il canale c'era gia' e non lo usava nessuno.** Il firmware configura il
modulo con `AT+PROFILE=323`, che accende anche **SPP e GATT Server**, e il
modulo espone di suo il servizio "transparent" di Feasycom. Non c'era niente
da progettare lato radio: c'era da scrivere il protocollo sopra.

⚠️ **Web Bluetooth, non una libreria nativa.** Electron ha Chromium dentro,
quindi l'API c'e' gia': niente moduli da ricompilare a ogni versione di
Electron. Il prezzo e' che il protocollo vive nel renderer, perche' e' li' che
sta `navigator.bluetooth`.

⚠️ **E' lento di proposito.** Un pacchetto per volta, con la risposta del
dispositivo prima del successivo: e' l'unico controllo di flusso disponibile,
perche' RTS e CTS del modulo non arrivano al microcontrollore e l'anello di
ricezione e' di 512 byte. Le note sono istantanee; un ebook puo' prendere
qualche minuto.

⚠️ **I pacchetti sono da 180 byte e non da 492**, che sarebbe il massimo del
modulo: il limite vero e' l'**MTU** del collegamento, e macOS ne negozia
tipicamente 185. Chiedere di piu' non da' piu' velocita': da' una scrittura
che fallisce.

Il dispositivo scrive su un file `.part` e lo rinomina **solo** se il CRC32
finale torna, quindi un trasferimento interrotto non lascia sulla scheda un
file che sembra buono.

### Due cose da sapere

- su macOS l'app dichiara l'uso del Bluetooth nell'`Info.plist`: senza, il
  sistema **termina l'app** invece di chiedere il permesso — e si vede solo nel
  pacchetto, non in sviluppo;
- ⚠️ non toccare la schermata Bluetooth **sul dispositivo** mentre il PC
  trasferisce: legge dalla stessa coda e si mangerebbe un pacchetto.


## 20 settembre 2026 (sera) — la dimensione del testo degli ebook si sceglie

Una pagina di ebook conteneva **504 caratteri**: 42 per riga, 12 righe. Il
motivo non era il font ma la **scala intera**: il reader usa il 6x12 a scala 2,
cioe' celle da 12x24, e fra "com'e'" e "la meta'" non c'e' niente.

Ora la conversione offre due dimensioni:

| | caratteri per riga | righe | per pagina |
|---|---:|---:|---:|
| **normale** (come prima) | 42 | 12 | 504 |
| **compatto** | 70 | 21 | **1470** |

⚠️ Il "compatto" non e' solo la scala 1: sono anche **margini larghi** (58 px
per lato) e **due pixel di interlinea in piu'**. Senza i margini la riga sarebbe
di 85 caratteri, e una riga cosi' lunga si perde con l'occhio tornando a capo —
i libri stampati stanno fra 60 e 65 per la stessa ragione. Senza l'interlinea
le righe si toccherebbero, perche' il font usa tutte e 12 le righe della sua
cella, discendenti di `p` e `q` compresi.

⚠️ **A scala 1 i tratti delle lettere sono da un pixel.** Sul pannello
riflettivo, senza retroilluminazione, si vedono piu' chiari che su un monitor.
E' la cosa da guardare prima di adottare il compatto per un libro lungo, ed e'
il motivo per cui la scelta esiste invece di essere stata fatta al posto
dell'utente.

### Come fa a funzionare senza riconvertire niente

⚠️ La scala **viaggia dentro il file**, nel primo degli otto byte riservati
dell'intestazione `.pdar`. Il firmware la legge e ne ricava margini e
interlinea; **zero vuol dire 2**, quindi tutti i libri convertiti prima si
rendono esattamente come prima. Un `.pdar` nuovo a scala normale e' byte per
byte identico a uno vecchio — verificato.

Prima la scala era un **patto implicito**: la costante `EB_FONT_SCALE` nel
firmware e un `?? 2` nella Companion, in due programmi diversi, da tenere
allineati a mano. Un libro impaginato a una scala e reso a un'altra non si vede
piu' grande: si vede **rotto**, perche' gli a capo sono gia' decisi e le righe
sfondano la pagina.


## 20 settembre 2026 — niente riconversioni inutili, e i video al ritmo giusto

### La musica: un MP3 non si riconverte piu'

Fino a ieri **ogni** file passava per libmp3lame, perche' il firmware
accettava solo 48 kHz. Dal 15/9/2026 il lettore ricampiona da solo qualunque
frequenza fino a 48 kHz, quindi un MP3 a 44,1 suona senza toccarlo.

Riconvertire un MP3 vuol dire decodificarlo e ricodificarlo, e la codifica MP3
e' **con perdita**: si buttava via qualita' a ogni passaggio, anche
ricodificando a 320 kbps. Ora un MP3 si **copia** (`-c:a copy`), si riscrivono
solo i tag ID3 che servono al device per ordinare l'album, ed e' istantaneo.

⚠️ Il caso limite non esiste: il formato MP3 **non puo'** superare i 48 kHz
(MPEG-1 32/44,1/48, MPEG-2 16/22,05/24, MPEG-2.5 8/11,025/12). "Un MP3 si copia
sempre" e' una regola senza eccezioni.

⚠️ **Conseguenza da sapere: un MP3 copiato non viene normalizzato.** Il
loudnorm richiede di ricodificare, ed era proprio il passaggio che si voleva
togliere. Un album di MP3 puo' quindi risultare piu' piano o piu' forte di uno
convertito da FLAC. E' il prezzo di non perdere qualita', ed e' stato scelto.

### La musica: FLAC → MP3

Resta **CBR 320 kbps**, che era gia' cosi'. Due cose migliorano:

- ⚠️ **non si ricampiona piu' per niente.** Un FLAC a 44,1 diventa un MP3 a
  44,1 invece che a 48: il ricampionamento e' una perdita, e ora che il
  firmware suona 44,1 non serve piu'. 88,2 e 176,4 scendono a 44,1 (rapporto
  intero), 96 e 192 a 48;
- ⚠️ **un mono resta mono.** Prima `-ac 2` raddoppiava il file per niente.

⚠️ E CBR invece di VBR ha una ragione che vale solo su questo dispositivo: il
firmware stima la durata del brano dal bitrate del **primo frame**. Con un CBR
il conto e' esatto; con un VBR la barra di avanzamento sbaglia per tutto il
brano.

### I video: 10 fotogrammi al secondo, fissi

Il default era **30** e la pagina lasciava scegliere fra 24 e 60. **Nessuno di
quei valori era producibile dal dispositivo.**

I limiti sono due e comanda il piu' basso: la banda a 2,5 MHz darebbe 13,2
fotogrammi al secondo, ma il datasheet del pannello dichiara `fSCS` con
**massimo 10 Hz** (Table 6-3-1). Chiedere di piu' non li fa andare piu' veloci:
il lettore butta la differenza e la conta come "salti", quindi un file a 30 si
vedeva **peggio** di uno a 10 — due terzi dei fotogrammi scartati in modo
irregolare — e occupava tre volte lo spazio.

Il selettore e' sparito dalla pagina: al suo posto c'e' il numero con il
perche'.

⚠️ E l'audio degli `.av` ora e' **mono**, che discende dal punto sopra: a 10
fps un blocco stereo sarebbe 19 200 byte per fotogramma, oltre il limite di
16 384 del lettore, e il device **rifiuterebbe il file** all'apertura. Il
controllo adesso e' nel convertitore, cosi' l'errore arriva prima della
conversione invece che dopo aver copiato il file sulla scheda.

Tutte le modifiche significative al companion. Formato approssimativo
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.11.0] — 2026-06-08

### Cambiato

- **Ebook reader → font 6x12 (Spleen)**. L'ereader firmware passa da font_8x8
  (cella 8×8) a font_6x12 (cella 6×12, discendenti veri): più leggibile per
  letture prolungate. Le metriche di impaginazione (`FONT_ADVANCE_W/H`) passano
  da 8/8 a 6/12 → a scala 2 ora **42 colonne × 12 righe** per pagina.
  ⚠️ Richiede il firmware aggiornato (anch'esso a font_6x12) e la
  **ri-conversione dei .pdar esistenti** (quelli vecchi andrebbero in overflow
  verticale).

### Aggiunto

- **Tipografia preservata** nella conversione epub/.md: virgolette curve
  (“ ” ‘ ’), lineette (– —), bullet (•) ed ellissi (…) non vengono più
  appiattite in ASCII (il font 6x12 ora include questi glifi). Aggiunta
  decodifica delle entità HTML (`&quot;`, `&amp;`, …) lasciate dal lexer.

### Corretto / Migliorato

- **Code block**: le righe più lunghe della colonna ora vanno a capo
  (hard-wrap) invece di essere troncate silenziosamente.
- **EPUB**: parsing dell'OPF via DOM (robusto a namespace e ordine attributi)
  invece che via regex; tabelle rese preservando le righe (celle unite da
  " | ", separatore dopo l'header).

## [0.10.0] — 2026-06-07

### Aggiunto

- **Sync delle note con servizi esterni + selettore servizio**. Nella pagina
  Notes un menu a tendina permette di scegliere con quale servizio
  sincronizzare le note del device (`<mount>/NOTE/`, file `.txt`). La scelta è
  persistita.
- **Obsidian sync** (bidirezionale, vault locale, nessun setup esterno).
  Confronto hash-first con manifest dell'ultimo sync; conflitti risolti per
  mtime (il perdente è conservato come copia `(conflict …)`); cambio estensione
  `.txt` ↔ `.md`.
- **Notion sync** (bidirezionale, OAuth). L'utente collega il proprio Notion con
  un click (login nel browser, scelta delle pagine). La cartella note del device
  diventa una gerarchia di sottopagine sotto una pagina genitore scelta
  dall'utente; le note `.txt` ↔ sottopagine foglia (contenuto = paragrafi).
  Cancellazioni e conflitti propagati come per Obsidian. Il token resta cifrato
  solo sul dispositivo (`safeStorage`); lo scambio OAuth passa da un broker
  esterno minimale (Cloudflare Worker) così che il `client_secret` non sia mai
  spedito nell'app. Messaggi d'errore comprensibili e box di dettaglio nel
  pannello quando una pagina non può contenere note.

## [0.9.2] — 2026-06-03

### Corretto

- **Music: pagina non scrollabile durante la conversione**. La MusicPage aveva
  `h-full` senza overflow, quindi si bloccava all'altezza del riquadro e la
  lista brani in fondo restava tagliata e irraggiungibile. Ora l'intera pagina
  scorre (scrollbar unica) e il pannello di avanzamento resta fissato in cima
  (sticky) mentre si scorrono i brani. Rimosso lo scroll interno ridondante
  della lista brani.

## [0.9.1] — 2026-06-03

### Aggiunto

- **Music: pannello di avanzamento realtime**. Durante la conversione di un
  album compare in alto (sempre visibile, senza dover scorrere la lista) un
  pannello con percentuale complessiva grande, una status bar segmentata a
  colori accesi — verde (completati), accent animato (brano in corso), rosso
  (errori) — contatori per stato e nome del brano attualmente in conversione.
  La percentuale è fluida perché include la frazione del brano corrente.

## [0.9.0] — 2026-06-03

### Aggiunto

- **Music: gerarchia Genere / Artista / Album + rilevamento automatico**. La
  destinazione sul device passa da `music/<genere>/<album>` a
  **`music/<genere>/<artista>/<album>`**, con un nuovo campo **Artista** tra
  Genere e Album. Nuova spunta **Auto** (attiva di default, con tooltip
  esplicativo al passaggio del mouse): alla selezione di un album la Companion
  interroga iTunes (stessa chiamata delle copertine), deduce artista, genere e
  nome album canonico — anche quando il nome cartella contiene entrambi (es.
  "John Mayer - Born And Raised") — e compila automaticamente i tre campi con
  nomi sanitizzati folder-safe (es. "Singer/Songwriter" → "Singer_Songwriter").
  Le cartelle genere/artista vengono create automaticamente se mancanti. I campi
  restano sempre modificabili a mano; disattivando Auto si impostano solo
  manualmente. Il limite di 47 caratteri e il popup di correzione coprono ora
  anche l'Artista. La risposta iTunes include il genere primario
  (`primaryGenreName`).

## [0.8.2] — 2026-06-03

### Corretto

- **Music: ordine dei brani dell'album**. La pulizia del nome rimuoveva il
  prefisso numerico ("01 ", "02 …") dal nome dei file di output, e il device
  ordina i brani per nome → l'ordine dell'album si perdeva. Ora la conversione
  scrive il numero di traccia nel tag ID3 `track` (TRCK) di ogni MP3 — preso dal
  numero iniziale del nome file originale, con fallback alla posizione in coda —
  insieme al `title` pulito, mantenendo `artist`/`album` dal sorgente. I nomi
  file restano puliti. Nota: l'ordinamento corretto richiede che il player del
  firmware ordini per tag `track` (non per nome file).

## [0.8.1] — 2026-06-03

### Corretto

- **Music: stato residuo tra album consecutivi**. Dopo aver convertito un
  album, selezionarne un altro (Choose folder / drop) accodava i nuovi brani a
  quelli già convertiti e lasciava il picker copertina e il nome album agganciati
  all'album precedente. Ora, se il batch precedente è già stato convertito
  (tutti i brani done/error), una nuova selezione riparte pulita: coda svuotata,
  picker copertina resettato e nome album ri-rilevato dalla nuova cartella.
  Anche "Clear list" azzera copertina e auto-detect. L'accodamento resta attivo
  finché la coda non è stata convertita (per comporre un album da più cartelle).

## [0.8.0] — 2026-06-03

### Aggiunto

- **Music: ricerca copertina online (iTunes)**. Quando si aggiungono brani,
  l'app legge artista/album dai tag ID3 del primo brano (ffprobe) e interroga
  automaticamente la iTunes Search API (online prioritario). Una nuova card
  **"Copertina album"** mostra un campo di ricerca con termine libero e una
  griglia di miniature selezionabili: **Nessuna**, **Dai brani** (cover
  embedded, se presente) e i risultati iTunes; il primo risultato è
  pre-selezionato. La copertina scelta viene scaricata in alta risoluzione,
  ditherata a 200×200 e scritta come `cover.bin` (stessa pipeline 1bpp). Le
  miniature sono scaricate lato main e passate come data URL per non allentare
  la CSP del renderer. `Mp3ConvertRequest.cover` (`none`/`embedded`/`url`),
  default `embedded` (retro-compatibile). Nuovi IPC `cover:suggest` /
  `cover:search`. Nota: la ricerca invia artista/album ai server Apple.

## [0.7.0] — 2026-06-03

### Aggiunto

- **Music: album art → `cover.bin`**. Durante la conversione di un album, se
  i brani hanno una cover art embedded viene estratta (ffmpeg), ridotta a
  200×200 con dithering Floyd–Steinberg (fit + padding bianco se non quadrata)
  e scritta come `cover.bin` nella root dell'album: 1bpp packed MSB-first
  (25 byte/riga × 200 = 5000 byte, bit=1 = pixel bianco), stessa convenzione
  del framebuffer Sharp / immagini ebook → il firmware fa blit diretto nel
  player. L'attività registra `· cover ✓` quando una copertina viene scritta.
- **Music: gerarchia Genere / Album sul device**. Il campo cartella è ora
  diviso in **Genere** (cartella padre sotto `/music/`) e **Album**
  (sottocartella): un album convertito finisce in
  `…/music/<genere>/<album>/`. Il genere ha un **dropdown** che elenca le
  cartelle già presenti sotto `/music/` del device (puoi sceglierne una o
  digitarne una nuova), con refresh automatico dopo ogni conversione. Risolve
  il caso in cui scrivendo `/BLUES` i brani finivano sciolti nella cartella
  genere senza la sottocartella album.

### Corretto

- **Music: scroll della lista brani**. Durante la conversione di album lunghi
  la lista si limitava ai primi elementi visibili senza poter scorrere; ora ha
  altezza massima con scroll interno, così si segue l'avanzamento di tutte le
  tracce.

## [0.6.0] — 2026-06-03

### Aggiunto

- **Music: limite nomi a 47 caratteri + pulizia automatica**. Il
  convertitore musicale ora rispetta il limite firmware di Orion di 47
  caratteri per i nomi di brano e album (spazi e caratteri speciali
  inclusi). Al click su **Convert & upload**, se un nome di brano o
  dell'album/cartella supera i 47 caratteri si apre un popup di
  correzione con un campo editabile (`maxLength` 47) e contatore live per
  ogni voce fuori limite; la conversione parte solo quando tutti i nomi
  rientrano. All'import, inoltre, ogni numero o carattere speciale
  iniziale viene rimosso automaticamente dal nome del brano
  (es. `02.Hello` → `Hello`, `01 - Intro` → `Intro`). Il nome ripulito/
  corretto diventa anche il filename MP3 di output.

## [0.5.0] — 2026-05-23

### Aggiunto

- **Music: local export + bitrate adattivo**. La MusicPage ora ha il
  toggle Device / Local export (mirror della VideoPage): puoi convertire
  brani o interi album in MP3 senza device collegato, scegliendo una
  cartella di destinazione sul PC (default `~/Documents/Orion/music-export/`).
  La pipeline MP3 passa da VBR q=2 fisso a una strategia adattiva che
  legge codec + bitrate del sorgente via ffprobe:
  - Sorgenti lossless (FLAC, ALAC, WAV, PCM, APE, TTA, …) → CBR 320 kbps.
  - Sorgenti lossy con bitrate noto → CBR clamp(srcKbps, 192, 320).
  - Fallback (probe fallita) → VBR q=2 (~190 kbps).
- **Bug Report modal**. Nuova voce **Help** in fondo alla Sidebar
  (`LifeBuoy`) che apre un modale per inviare bug report via email a
  `info@mvlabs.org` con subject `orion_companion_bug`. Il body include
  descrizione + passi per riprodurre, e auto-allega: app version,
  platform/arch/kernel release, versioni Electron/Chrome/Node, ffmpeg
  detection, device connesso (mount, firmware, label) e le ultime 20
  voci dall'ActivityContext. Bottoni **Send via email** (apre il client
  mail predefinito via `mailto:`) e **Copy full report** (clipboard,
  per chi non ha un client mail configurato). Body troncato a ~1800 byte
  nel `mailto:` per restare sotto i limiti pratici di Outlook/Windows.
- **IPC system:info** — main expone `app.getVersion()` + `process.platform`
  / `arch` / `os.release()` + runtime versions, consumato dal Bug Report.

## [0.4.0] — 2026-05-23

### Aggiunto

- **Notes: tree view + folder management**. La sezione Notes adesso
  visualizza `<mount>/NOTE/` come albero gerarchico (cartelle e
  sottocartelle) e permette di crearle, rinominarle, eliminarle,
  copiarle/spostarle via drag&drop o clipboard (Cmd/Ctrl + C / X / V),
  in linea con la nuova organizzazione del firmware.
  - Tree component con expand/collapse, right-click context menu,
    drag&drop (default = move, Alt/Ctrl/Cmd = copy).
  - Toolbar: Reload, New folder, Backup all to PC.
  - Shortcuts: Cmd/Ctrl + C/X/V, F2 = rename, Cmd+Backspace = delete.
- **IPC notes:tree** — walk ricorsivo di `<mount>/NOTE/` (folder + .txt),
  con NoteTreeFolder/NoteTreeFile.
- **IPC notes:{mkdir,rename,delete,copy,move}** — CRUD scoped a
  `<mount>/NOTE/` con safety check (path obbligatoriamente dentro
  un device Orion connesso). File limitati a `.txt`.
- **Backup ricorsivo**: `notes.backup` e `notes.backupAll` adesso
  mirrorano la gerarchia su `~/Documents/Orion/notes/` (preservando
  le sottocartelle), non più flatten.
- **PromptDialog**: piccolo modal per text input nella sezione Notes,
  necessario perché Electron disabilita `window.prompt()` nel renderer.

### Risolto

- **Ebook reflow: normalizzazione Unicode → ASCII**. Il `cp_map` di
  `font_8x8` copre solo lettere accentate italiane; ogni altro codepoint
  > 0x7E finiva renderizzato come `?` (effetto "?Chi siete?" su testi
  italiani con guillemet). Adesso `renderRun` / `wrapHeadingLines` /
  `renderCodeBlock` normalizzano in fase di reflow: «»‹›→`"`, '`’‚→`'`,
  "”„→`"`, –—→`-`, …→`...`, NBSP→` `, ·→`.`, •◦→`*`. Le accentate
  italiane vere passano invariate (`src/main/pdar/reflow.ts`).
- **Ebook reflow: pagine bianche residue**. `commitPage` ora scarta le
  pagine costituite da soli `NEWLINE`/`PARAGRAPH` token. Caso tipico:
  paragrafo che finisce esattamente a fine pagina seguito da inizio
  capitolo — generava una pagina bianca rendendo l'avanzamento di una
  pagina "morta" sul firmware (`src/main/pdar/reflow.ts`).

## [0.3.0] — 2026-05-23

### Aggiunto

- **Rilevamento DFU senza MSC**: la pagina Firmware adesso fa polling di
  `dfu-util -l` ogni 5 secondi mentre è in idle. Se l'utente entra in
  DFU manualmente dal device (Settings → FIRMWARE UPDATE) o ne fa un
  reset hardware, il companion mostra una nuova card "Orion detected
  in DFU (bootloader) mode" con bottone "Flash latest firmware". Il
  flow salta lo step "scrivi DFU trigger su SD + ejecta" e va diretto
  al flash del binario cached (`src/renderer/src/pages/FirmwarePage.tsx`).
- **CI GitHub Actions** (`.github/workflows/release.yml`): due job in
  parallelo che buildano Windows (NSIS installer + portable .exe) e
  Linux (AppImage + .deb amd64). Trigger su push di tag `v*` (crea una
  release GitHub in draft con gli artefatti allegati) o manuale via
  `workflow_dispatch`. La build mac resta locale.
- **electron-builder deb depends**: dichiarate `libusb-1.0-0` (necessaria
  a `dfu-util` bundlato) + dipendenze standard Electron (GTK, libnss3,
  ecc.). Adesso `apt install ./orion-companion_*.deb` risolve tutto in
  automatico.
- **`author.email`** in `package.json`: richiesto da electron-builder
  per il campo Maintainer del `.deb`.

### Risolto

- **Paginazione ebook con font_8x8**: `FONT_ADVANCE_W` allineato da 6 a 8
  px in `src/main/pdar/format.ts`. Il firmware ebook reader usa
  `font_8x8` (vedi `ui.c` → `eb_reader_draw`, `sharp_lcd_set_font(&font_8x8)`),
  ma il generatore `.pdar` calcolava il wrap su 6 px (vecchio `font_5x7`)
  producendo righe ~33% più larghe della superficie utile, troncate sul
  margine destro. I `.pdar` rigenerati dopo questo bump hanno il wrap
  corretto.
- **Firmware flash**: il flash non viene più segnato come fallito quando
  `dfu-util` esce con codice 74 dopo il comando `:leave`. È il
  comportamento atteso — il device riavvia prima di poter rispondere al
  `get_status` finale, ma il flash è già andato a buon fine. Adesso il
  wrapper riconosce la riga `File downloaded successfully.` come marker
  di successo e ignora l'exit code in quel caso (`src/main/firmware/dfu.ts`).
- **FirmwarePage**: durante il flash non viene più mostrato il messaggio
  "Connect your Orion via USB…". Quando Orion entra in DFU il volume MSC
  sparisce e `device` diventa `null`, ma il dispositivo è in bootloader,
  non disconnesso. La card adesso mostra solo il pulsante Cancel mentre
  il flow è attivo; il pannello live in basso resta l'unica fonte di
  stato.

### Note

- Il warning `Invalid DFU suffix signature` nel log di dfu-util resta —
  per eliminarlo bisogna aggiungere il suffisso DFU al `.bin` in fase
  di build del firmware (`dfu-suffix -v 0x0483 -p 0xdf11 -a firmware.bin`),
  modifica lato repo CUBE_IDE, non Companion.

---

## [0.2.0] — 2026-05-21

Prima build distribuibile end-to-end per macOS Apple Silicon.

### Aggiunto

- **Packaging mac**: `.dmg` + `.zip` per `darwin-arm64`, **non firmati**
  (no Apple Developer ID). Configurato `electron-builder.yml` con
  `identity: null`, `hardenedRuntime: false`, `gatekeeperAssess: false`.
- **Icona app**: pipeline `scripts/build-mac-icon.mjs` (Jimp + iconutil)
  che pad `media/logo.png` a quadrato, genera l'iconset, produce
  `build/icon.icns` (mac) e `build/icon.png` (linux).
- **Bundle binari nativi darwin-arm64**:
  - `ffmpeg` + `ffprobe` 7.1 statici (zero deps homebrew) da
    osxexperts.net.
  - `dfu-util` da homebrew con `libusb-1.0.0.dylib` bundlata e rpath
    patchato (`install_name_tool` + `codesign -s -` ad-hoc).
- **Resolver path runtime**: `src/main/ffmpeg/paths.ts` (mirror del
  `firmware/paths.ts`). Sequenza: bundle pacchettizzato →
  `src/main/resources/` in dev → `which`/`where` → well-known paths
  (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/snap/bin`).
  Quest'ultimo step è importante perché su macOS le GUI app non
  ereditano `$PATH` della shell.
- **Guide build per platform**: `BUILD_WINDOWS.md`, `BUILD_LINUX.md`.
- **Guida install utente**: `INSTALL.md` con istruzioni Gatekeeper
  bypass su mac, SmartScreen su Win, AppImage/deb su linux.
- **Handoff firmware UTF-8**: `HANDOFF_FIRMWARE_UTF8.md` per istruire
  la sessione firmware ad aggiungere decoder UTF-8 minimale + glifi
  Latin-1 al `font_5x7`. Risolve il bug "accenti rendono come `??`".

### Modificato

- **Ebook converter**: scala font fissa a **x2**, rimosso il selettore
  x1/x2/x3 dalla UI (`EbookPage.tsx`). Cols disponibili 42 invece di 28
  evitano il troncamento dei titoli di lunghezza media.
- **Reflow heading**: wrap su word-boundary (`wrapHeadingLines` in
  `reflow.ts`), niente più tagli a metà parola anche per titoli lunghi.
- **Call sites ffmpeg/ffprobe**: `src/main/ipc/{video,mp3}.ts` usano
  ora `getFfmpegPathSync()`/`getFfprobePathSync()` invece di stringhe
  letterali — il packaged build risolve il binario corretto.

### Note operative

- Per distribuire ad altri utenti macOS: usare il `.dmg` corrente, gli
  utenti faranno right-click → Open al primo avvio (vedi `INSTALL.md`).
- Per Win/Linux: seguire `BUILD_WINDOWS.md` / `BUILD_LINUX.md` su una
  macchina target — il packaging cross-platform non è ancora
  configurato.

---

## [0.1.0] — 2026-05-18

Prima milestone interna (non distribuita): Step 1-8 completati.

### Aggiunto

- Bootstrap UI + theme toggle + sidebar 10 voci.
- Device discovery via marker `.orion-device` su volumi USB MSC.
- Backup read-only delle note (`/NOTE/*.txt`).
- MP3 manager con `ffmpeg` (loudnorm -14 LUFS, 48 kHz, libmp3lame VBR).
- Drag&drop cartelle + folder picker nativo.
- Formato `.pdar` (header 32B + TOC + body con stream di token UTF-8).
- Reader Markdown (via `marked`).
- Reader EPUB (via `JSZip` + `node-html-parser`).
- Reader PDF (via `pdfjs-dist`).
- Floyd-Steinberg dithering per immagini, bit-pack 1bpp MSB-first
  coerente col framebuffer Sharp LS032.
- Firmware DFU via `dfu-util` con wizard 4-step.
- Auto-update firmware via SD card (`<ver>.fwver` + `DFU` file).
- Video converter (`.mp4`/`.mkv`/`.mov`/`.avi` → `.av`).
- File manager con drag&drop e clipboard.
