# Sync note ↔ Notion — flusso di lavoro

Documento di riferimento sul funzionamento **attuale** della sincronizzazione
delle note del PDA con Notion in OrionCompanion (v0.10.0).

> In breve: l'utente collega il proprio Notion con un click (OAuth), sceglie una
> pagina genitore, e le note del device (`<mount>/NOTE/`, file `.txt`) vengono
> sincronizzate **in due direzioni** con una gerarchia di sottopagine sotto
> quella pagina. Il token resta cifrato sul dispositivo; nessun segreto viaggia
> dentro l'app.

---

## 1. Componenti

| Componente | Dove | Ruolo |
|---|---|---|
| **App desktop** (Electron) | repo OrionCompanion | UI + motore di sync, gira sul Mac dell'utente |
| **Broker OAuth** | Cloudflare Worker `orion-notion-broker.villanimatteo88.workers.dev` | custodisce il `client_secret`; fa lo scambio `code → token` e il `refresh` |
| **Integrazione Notion** | Notion (public OAuth) "companion" | identità OAuth dell'app (client_id pubblico) |

**Perché serve il broker.** Notion richiede il `client_secret` sia per ottenere
il token sia per rinnovarlo (client "confidential", niente PKCE). Quel segreto
**non può** essere incluso in un'app distribuita a tutti. Il broker è un piccolo
servizio stateless che tiene il segreto e fa lo scambio al posto dell'app.

---

## 2. Flusso di collegamento (OAuth) — una tantum per utente

```
App desktop                              Broker (ha il client_secret)
  │  utente clicca "Collega Notion"
  │  apre un server loopback 127.0.0.1:PORT, genera un nonce casuale
  │  apre il browser sull'URL di autorizzazione Notion
  │     (client_id, redirect_uri = BROKER/callback, state = {nonce, port})
  ▼
Browser → login Notion + scelta delle pagine da condividere
  ▼
Notion → redirect a  BROKER/callback?code=…&state=…
                                   │  broker: code + client_secret → token (server-side)
  ┌────────────────────────────────┘
  ▼
Broker → 302 verso  http://127.0.0.1:PORT/cb?payload=base64(token)&nonce
  │  l'app verifica il nonce, decodifica il token
  │  salva il token CIFRATO (safeStorage / Keychain del SO)
  │     in <userData>/notion/connection.json
  ▼
Collegato. Da qui l'app usa il Bearer token per leggere/scrivere (nessun secret lato app).
```

- **Refresh automatico**: a una risposta `401` l'app chiama `POST BROKER/refresh`
  (anche il refresh usa il secret → passa dal broker) e ritenta una volta.
- **Sicurezza**: il broker redirige **solo** a `127.0.0.1`, valida `nonce` e
  `port`, e non logga mai `code` né token. Il token utente resta **solo** sul
  suo dispositivo, cifrato. Nessun database centrale di token.

---

## 3. Scelta della pagina genitore

Dopo il collegamento l'utente sceglie **una pagina** Notion sotto cui vivranno le
note. La lista è popolata da una `search` API (mostra solo le pagine a cui
l'integrazione ha accesso).

- Le note del device finiscono **sotto** quella pagina come sottopagine.
- ⚠️ La pagina deve essere una **pagina normale**. Un *profilo persona* o un
  *database* non possono contenere sottopagine: in quel caso il sync mostra un
  messaggio chiaro ("La pagina scelta non può contenere note…"). Soluzione:
  creare una pagina vuota in Notion, condividerla con l'integrazione
  (pagina → ⋯ → Connessioni → companion) e selezionarla.

---

## 4. Modello dati: device ↔ Notion

| Device (`<mount>/NOTE/`) | Notion |
|---|---|
| cartella | sottopagina "contenitore" (ha sottopagine) |
| nota `.txt` | sottopagina foglia (senza sottopagine), contenuto = blocchi paragrafo |
| testo della nota | un blocco `paragraph` per riga (no rich text/heading/liste) |

- La gerarchia di cartelle/sottocartelle è **preservata** specularmente.
- Una sottopagina con figli è interpretata come **cartella**; una foglia come
  **nota**.
- ⚠️ **I file allegati non contano**: trascinare un `.txt` dentro Notion crea un
  *allegato* (blocco file), non una pagina → l'engine lo ignora di proposito.
  Per creare una nota da Notion bisogna creare una **sottopagina**.

---

## 5. Motore di sync (bidirezionale)

Stessa logica del sync Obsidian. A ogni "Sync now":

1. **Enumera** i due lati: le note del device e le sottopagine sotto la pagina
   genitore.
2. **Confronta** con un *manifest* dell'ultimo sync (`relKey → {pageId, hash}`)
   salvato in `<userData>/notion/manifest-<workspaceId>.json`. Il manifest serve
   a distinguere "creato da un lato" da "cancellato dall'altro".
3. Per ogni nota (confronto **hash-first**):
   - **uguali** → niente da fare;
   - **cambiata solo sul device** → push del testo su Notion;
   - **cambiata solo su Notion** → pull del testo sul device;
   - **nuova su un lato** → creata sull'altro;
   - **cancellata su un lato** (era nel manifest) → archiviata/cancellata
     sull'altro;
   - **modificata su entrambi** (conflitto reale) → vince la versione **più
     recente** (mtime device vs `last_edited_time` Notion); la perdente è
     **conservata** come copia (`(conflict <data ora>)`), mai persa.
4. Salva il nuovo manifest.

Gli errori per singola nota non bloccano il resto: vengono raccolti e mostrati
nel pannello (box rosso con i messaggi).

---

## 6. Mappa dei file (codice)

**App — main process** (`src/main/ipc/notion/`)
- `config.ts` — costanti pubbliche: `CLIENT_ID`, `BROKER_BASE_URL`,
  `NOTION_VERSION` (`2022-06-28`), URL autorizzazione/callback/refresh.
- `tokenStore.ts` — salva/legge il token cifrato (`safeStorage`) in
  `<userData>/notion/connection.json`.
- `auth.ts` — `connect()` (loopback + browser), `status()`, `disconnect()`,
  `refreshAccessToken()`.
- `api.ts` — wrapper REST Notion (search/pages/blocks), auto-refresh su 401,
  conversione testo ↔ paragrafi, messaggi d'errore tradotti.
- `sync.ts` — motore bidirezionale + manifest.

**App — renderer**
- `components/NotionSyncPanel.tsx` — UI: collega/scollega, scelta pagina
  genitore, "Sync now", report + box errori.
- `pages/NotesPage.tsx` — selettore servizio (Obsidian / Notion).

**App — wiring**
- `shared/ipc-types.ts`, `preload/index.ts`, `lib/api.ts`, `main/index.ts`
  (handler IPC `notion:connect|status|disconnect|listPages|setParent|sync`),
  `lib/ActivityContext.tsx`, `pages/HomePage.tsx` (Recent Activity).

**Broker** (`broker/`, fuori dall'app, non bundlato)
- `worker/src/index.js` + `worker/wrangler.toml` — Cloudflare Worker (in uso).
- `api/*.js` + `lib/notion.js` — variante Vercel (fallback, non usata).
- `README.md` — guida deploy/sicurezza.

---

## 7. Configurazione e deploy del broker (riferimento)

Già fatto per l'ambiente attuale; qui per memoria/replica.

1. **Integrazione Notion** (notion.so/my-integrations) tipo **OAuth/Public**,
   capabilities Read/Insert/Update, Redirect URI = `<worker>/callback`.
   → fornisce `client_id` (pubblico) e `client_secret` (segreto).
2. **Deploy del Worker**:
   ```bash
   cd broker/worker
   # client_id (pubblico) in wrangler.toml
   npx wrangler deploy                      # → stampa l'URL del Worker
   npx wrangler secret put NOTION_CLIENT_SECRET   # il secret vive SOLO qui
   # imposta NOTION_REDIRECT_URI = <worker-url>/callback in wrangler.toml
   npx wrangler deploy                      # redeploy
   ```
3. **App**: in `src/main/ipc/notion/config.ts` `CLIENT_ID` e `BROKER_BASE_URL`
   (la root del Worker). In dev si possono sovrascrivere con le env
   `NOTION_OAUTH_CLIENT_ID` e `NOTION_BROKER_URL`.

> `NOTION_VERSION` deve combaciare tra `config.ts` e `wrangler.toml`
> (attuale: `2022-06-28`).

---

## 8. Gotchas

- **Pagina genitore valida**: non un profilo persona / database (vedi §3).
- **Allegati vs pagine**: solo le sottopagine sono note (vedi §4).
- **Conversione testo**: solo paragrafi; aggiornare una nota fa *replace* dei
  blocchi di contenuto ma **non** tocca le sottopagine.
- **Rate limit Notion** (~3 req/s): l'engine è sequenziale — ottimo per poche
  note, potenzialmente lento con centinaia di note.
- **safeStorage**: usa il portachiavi del SO; se non disponibile (raro) il
  salvataggio del token fallisce con errore esplicito.
- **Token scaduto** (~1h): rinnovo trasparente via broker al primo `401`.
