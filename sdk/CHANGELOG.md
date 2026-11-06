# Cambiamenti

Le correzioni che prima stavano in mezzo alle pagine ("fino al 16 settembre non
era vero…") sono qui. Le pagine descrivono come funziona adesso; per sapere se un
comportamento dipende dalla versione del firmware, guarda questo elenco.

## 26 ottobre 2026 · API 0.2.0

- Nuovi moduli: `orion.gpio`, `orion.i2c`, `orion.ble`, sul connettore J4.
- **Dialoghi.** Prima di questa data un dialogo (`orion.ui`) aperto mentre il
  pannello stava ancora trasferendo il frame precedente restava invisibile: era
  aperto ma non sullo schermo, e il successivo ESC lo annullava. Chi ha un'app che
  presenta a ogni frame lo vedeva quasi sempre. Corretto nel runtime; per il
  firmware vecchio si apre il dialogo solo se non si è presentato da circa 80 ms.
- **`orion.math.sincos`.** Prima di questa data dava risultati sbagliati dopo
  qualunque `atan2`, perché le due funzioni condividono un registro del
  coprocessore. Corretto nel firmware; per il vecchio, `math.sin` e `math.cos`.
- **`orion.mem.alloc`.** Il secondo argomento era documentato come `"veloce"`, ma la
  parola riconosciuta è `"fast"`. Qualunque altra parola dà la memoria grande senza
  errore: `is_fast()` dice dove si è finiti.
- **Richiamo del calendario.** Trenta minuti prima di un appuntamento il dispositivo
  suona e chiude l'app in esecuzione, che non riparte da sola.
- L'emulatore suona: WAV, effetti brevi, volume e posizione, con i limiti del
  dispositivo.

## 23 ottobre 2026

- L'emulatore ottiene l'audio da SDL2. Restano fuori MP3, Bluetooth e microfono.

## 10 ottobre 2026

- `orion.gfx.present()` restituisce il risultato a Lua, come `present_area`.
- Le app dichiarano una categoria del launcher con `-- category: …` in testa al file.
- Chiarito che la scala 2 è il minimo per un testo da leggere e che i file audio
  sotto i 48 kHz si suonano.

## 23 settembre 2026

- `play_file` accetta file a 44,1, 32 e 22,05 kHz, che il firmware porta a 48. Prima
  accettava solo 48 kHz. Sopra i 48 resta rifiutato.

## 16 settembre 2026

- **Pannello.** Prima di questa data il pannello si spegneva mentre un'app girava e i
  tasti non lo svegliavano, perché il codice che svuota la tastiera per le app non
  era quello che segnala l'attività. Ora disegnare e premere un tasto contano come
  attività.
- Formato pannello (`--pannello`): un fondale a schermo intero passa da 31,65 a
  0,70 ms.
- `orion.math`: `sincos`, `atan2`, `dist`. Documentata la soglia a cui il
  coprocessore conta davvero.
- Nasce `docs/`, con riferimento, guide e il sito navigabile.
