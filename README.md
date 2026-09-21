# JevGuard

Estensione Chrome (MV3) che mostra, dentro ogni riga della lista di Gmail, quanto quel
messaggio sembra spam o phishing. Il punteggio arriva da **Jev** (TypeSafe System One),
non da euristiche locali.

## 1. Cosa fa

Mentre scorri la posta, JevGuard legge dalla riga solo quello che Gmail già mostra
(mittente — nome, indirizzo e dominio —, oggetto, anteprima), lo manda a Jev come sei
domande booleane calibrate e dipinge nella riga una barretta colorata con la percentuale
di rischio. Niente apertura del messaggio, niente lettura del corpo, niente scansione
della casella: solo le righe che hai davvero sotto gli occhi.

```
riga Gmail → mittente / oggetto / anteprima → Jev (1 richiesta) → barra colorata + %
```

**Cosa non analizza mai**: le viste in cui la riga mostra il *destinatario* e non il
mittente — **Inviati, Bozze, Programmati, In uscita, Modelli**. Lì `span[email]` è la
persona a cui stai scrivendo: giudicare quelle righe significherebbe far valutare a Jev
la tua stessa posta in uscita come se arrivasse dal dominio del destinatario, pagando
una chiamata per ognuna. `listRows()` in `src/content/gmail-rows.js` restituisce zero
righe quando l'hash della pagina è una di quelle viste; tornando in Posta in arrivo il
rescan su `hashchange` riaccende tutto da solo.

## 2. Installazione

Non c'è niente da compilare e niente da installare: il `package.json` non dichiara
dipendenze e non ha uno step di build (serve solo a marcare i sorgenti `src/*.js` come
ESM per Node — vedi §4). Nessun `npm install`.

1. Se `icons/` è vuota, genera le icone: `node tools/make-icons.mjs`
   (senza i tre PNG referenziati dal manifest Chrome rifiuta di caricare l'estensione).
2. Apri `chrome://extensions` (serve Chrome ≥ 116).
3. Attiva **Modalità sviluppatore** (in alto a destra).
4. **Carica estensione non pacchettizzata** → seleziona la cartella `gmail-jev-guard/`.
5. **Ricarica la tab di Gmail.** I content script non entrano nelle tab già aperte:
   vale a ogni installazione e a ogni "Ricarica" dell'estensione.
6. Apri il popup dalla toolbar, incolla la **API key** di typesafe.ai, **Salva**.
   Il pulsante **Verifica** fa una `GET /v1/models`: conferma la chiave senza consumare token.
7. Accendi **Analisi attiva**. Il badge della toolbar diventa `ON`.

**Comportamento della sessione (voluto, non è un bug):**

| cosa | dove vive | sopravvive alla chiusura di Chrome |
|---|---|---|
| API key | `chrome.storage.local` | sì |
| interruttore "Analisi attiva" | `chrome.storage.session` | **no — riparte sempre OFF** |
| verdetti in cache, statistiche | `chrome.storage.session` | no |

Cioè: la chiave la inserisci una volta sola, l'analisi la riaccendi tu a ogni nuovo avvio
del browser. È la garanzia che l'estensione non chiami mai l'API a tua insaputa.

## 3. Come si legge l'indicatore

Barretta da ~54 px: 6 px di barra + la percentuale in 11 px. Non cambia mai l'altezza della riga.

- **Percentuale** = `max(probabilità spam, probabilità phishing)`, arrotondata.
- **Colore**: rampa continua verde → rosso, `hsl(120 → 0, 70%, 42%)`. Su tema scuro Gmail,
  `<html>` prende la classe `.jg-dark` e cambia solo la luminosità.
- **Fasce** (`RISK_BANDS` in `src/jev.js`):

| fascia | valore | lettura |
|---|---|---|
| basso | < 35 % | verde/giallo — nulla da fare |
| sospetto | 35 – 64 % | ambra — guarda mittente e link prima di cliccare |
| alto | ≥ 65 % | rosso — trattalo come ostile |

Le soglie si applicano al valore non arrotondato: una barra che mostra "65 %" può essere
ancora `sospetto` (0,647).

- **Tooltip** (`title` della barra), quattro blocchi nell'ordine:
  1. riga di sintesi — "Rischio phishing 87 % (alto)" / "Probabile spam …" / "Rischio …";
  2. `spam NN% · phishing NN%  (la % mostrata è la maggiore delle due)`;
  3. una riga `• <segnale>: NN%` per ogni segnale esplicativo **≥ 40 %** (i quattro segnali
     vengono sempre calcolati, in tooltip compaiono solo quelli che contano davvero);
  4. sempre, la riga di chiusura sull'origine del giudizio:
     `Valutato da TypeSafe Jev su mittente (nome, indirizzo e dominio), oggetto e anteprima.`
- **Stati transitori**: barra grigia pulsante = analisi in corso; barra grigia con `!` =
  errore. Il tooltip d'errore è `Analisi non riuscita: <motivo in italiano> [CODICE]`
  (con `NO_KEY` segue una seconda riga che rimanda al popup): il codice tra parentesi
  quadre è quello che ritrovi nella tabella di §9.

**Posizione**: la barra è posizionata in absolute dentro la cella dell'oggetto, allineata a
destra → sta subito a sinistra della colonna data e le icone che Gmail mostra all'hover non
la coprono. Se preferisci una colonna vera in più, cambia l'unica costante
`BADGE_PLACEMENT = "overlay"` → `"append-cell"`, in testa a `src/content/inject.js`.

## 4. Come funziona dentro

### Mappa dei file

| file | ruolo |
|---|---|
| `manifest.json` | MV3. Permessi: solo `storage` + host `https://api.typesafe.ai/*`. Nessun `tabs`, nessun `activeTab`. |
| `package.json` | Nessuna dipendenza, nessuna build. Serve solo per `"type": "module"`, così Node legge `src/jev.js` e `src/typesafe-client.js` come ESM anche prima di Node 20.19 (più due scorciatoie: `npm run icons`, `npm run calibrate`). |
| `src/jev.js` | ESM. `JEV_MODEL`, `QUESTIONS` (i 6 Noul), `buildState`, `scoreAnswers`, `RISK_BANDS`/`riskLevel`, `riskColor`, `SIGNAL_LABELS`, `senderDomain`, `verdictTooltip`. Zero `chrome.*`: gira anche in Node. |
| `src/typesafe-client.js` | ESM. `systemOne()`, `listModels()`, `TypeSafeError`, `italianMessage()`, `inputTokensOf()` (unico lettore tollerante del conteggio token, condiviso con il test). Timeout 20 s, 3 retry con backoff esponenziale che rispetta `retry-after`. |
| `src/background.js` | Service worker (module). Cache, coda, chiamate a Jev, storage, badge toolbar. |
| `src/content/gmail-rows.js` | Classic script. Il file che conosce il markup di **riga** di Gmail (`listRows`, `extractRow`, `subjectCell`) e le viste da saltare; l'unico altro selettore Gmail del progetto è `MAIN_SELECTOR` in `inject.js`. |
| `src/content/inject.js` | Classic script. `MAIN_SELECTOR`, observer, batching, disegno dei badge, `window.JevGuard.debug()/rescan()`. |
| `src/content/badge.css` | Stile della barra, stati `jg-pending` / `jg-error`, variante `.jg-dark`. |
| `src/popup/*` | Chiave API, interruttore, statistiche live (pagina + sessione), costo stimato, svuota cache. |
| `tools/make-icons.mjs` | Genera i 3 PNG in `icons/`. |
| `tools/fixtures.json` | Email di esempio per la calibrazione. |
| `tools/contract-test.mjs` | Test contro l'API reale (serve la chiave). |

I content script **non sono moduli** (non possono importare `jev.js`): `inject.js` ricalcola
in proprio tooltip e colore rispecchiando `verdictTooltip()` e `riskColor()`.
**Se tocchi quelle due funzioni, aggiorna anche `inject.js`.**

### Protocollo dei messaggi

Content script e popup parlano col service worker solo con `chrome.runtime.sendMessage`;
il SW risponde sempre (nessuna porta, nessuna connessione persistente).

| `type` | payload | risposta |
|---|---|---|
| `ANALYZE` | `{ items: RowData[] }` (max 5) | `{ ok, verdicts[] }` |
| `GET_CACHED` | `{ ids: string[] }` | `{ ok, verdicts[] }` (solo i noti) |
| `GET_STATUS` | `{}` | `{ ok, enabled, hasKey, stats, lastError }` |
| `SET_ENABLED` | `{ enabled }` | `{ ok, enabled }` |
| `SET_KEY` | `{ key }` | `{ ok }` |
| `VERIFY_KEY` | `{ key? }` | `{ ok, models[] }` |
| `CLEAR_CACHE` | `{}` | `{ ok }` |
| `PAGE_STATS` | `{ rows, rendered, pending, errors }` | `{ ok }` (fire & forget) |

`RowData` = `{ id, senderName, senderAddress, subject, snippet, hasAttachment, otherSendersCount }`.
`Verdict` = `{ id, risk, kind, level, phishing, spam, signals[], inputTokens, model, ts, error }`.

### Ciclo di lavoro

- **Lazy sul viewport**: un `IntersectionObserver` (margine 200 px) segna le righe visibili;
  un `MutationObserver` su `div[role="main"]` più l'evento `hashchange` (debounce 300 ms)
  reggono la navigazione single-page di Gmail. Nelle viste destinatario (Inviati, Bozze,
  Programmati, In uscita, Modelli — §1) non c'è nessuna riga da analizzare per definizione.
- **Cache per sessione**: i verdetti sono indicizzati per `RowData.id` — il thread id di
  Gmail quando la riga lo espone, altrimenti un hash del contenuto della riga. Una riga
  già vista si ridisegna istantaneamente e non viene mai rimandata a Jev. Tetto 500 verdetti,
  si scartano i più vecchi per timestamp; tutto muore alla chiusura di Chrome.
- **Batch e concorrenza**: `inject.js` raggruppa le righe ignote a blocchi di 5 e li manda in
  parallelo; il service worker esegue **al massimo 4 richieste Jev contemporanee**
  (`MAX_CONCURRENT = 4`) e deduplica le richieste già in volo.
- **Storage**: `local.apiKey` è leggibile solo dal service worker; `session` contiene
  `enabled`, `verdicts`, `stats`, `page` ed è aperta ai content script tramite
  `setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })`, così `inject.js` legge
  `enabled` e si iscrive a `storage.session.onChanged` senza passare dal SW.
- **Contatori del popup**: le prime quattro voci (*Righe rilevate*, *Con verdetto*,
  *In attesa*, *Errori*) arrivano da `PAGE_STATS` e descrivono **la scheda Gmail aperta**:
  *Con verdetto* conta le righe attualmente dipinte con un verdetto, cache compresa, e
  cala quando Gmail ricicla le righe. *Analisi riuscite*, *Token input* e *Costo stimato*
  sono invece i totali **della sessione** tenuti dal service worker, quindi
  *Token input ÷ Analisi riuscite* dà i token medi per mail (le chiamate fallite non producono token).
- **Spegnimento**: togliendo la spunta i badge spariscono dalla pagina; riaccendendo si
  ridisegnano dalla cache senza nuove chiamate.

## 5. Le domande a Jev

Una sola richiesta per mail: Jev ingerisce lo `state` una volta e valuta i sei Noul in
parallelo (più economico e più veloce di sei chiamate).

| Noul | domanda |
|---|---|
| `is_phishing` | è un tentativo di frode: si finge qualcuno per farti dare credenziali, dati o soldi? |
| `is_spam` | è posta commerciale massiva non richiesta: pubblicità, cold outreach, catene, spedite a una lista invece che scritte per te? |
| `sender_identity_mismatch` | il nome visualizzato dichiara un'organizzazione che non userebbe mai quel dominio? |
| `urgency_pressure` | mette fretta: scadenze, minacce, account o pacco in blocco? |
| `credential_or_payment_request` | chiede di autenticarti, confermare dati, pagare o trasferire denaro? |
| `too_good_to_be_true` | promette premi, vincite, eredità, rimborsi inattesi, rendimenti garantiti? |

I primi due fanno la percentuale, gli altri quattro solo la spiegano nel tooltip.
Lo `state` che accompagna le domande porta **esattamente i cinque campi che le domande
citano** (§7): tutto il resto sarebbe rumore che costa accuratezza.

**Perché la percentuale è un `max` e non una media pesata.** `is_phishing` e `is_spam` sono
probabilità calibrate: "0,80" significa davvero "in 8 casi su 10 di questo tipo è vero".
Combinarle con pesi inventati distruggerebbe quella calibrazione e produrrebbe un numero
senza unità di misura. Il `max` invece resta interpretabile: è la peggiore delle due accuse,
letta con la scala di chi l'ha prodotta. Inoltre spam e phishing sono categorie distinte, non
due componenti dello stesso rischio: una mail può essere phishing puro e spam quasi zero, e
va segnata rossa lo stesso. Il dominio del mittente, per la stessa ragione, viene estratto dal
codice (`senderDomain()`) e non lasciato inferire al modello.

## 6. Costi e limiti

- **$0,042 per milione di token di input**, output gratuito. Il popup mostra token consumati
  e **costo stimato** in tempo reale.
- **~1 richiesta per mail effettivamente visualizzata**, poi è in cache per tutta la sessione.
  Ordine di grandezza, **misurato sul corpo che il client spedisce davvero**
  (`JSON.stringify({ state, model, questions })`, `src/typesafe-client.js`): le sei domande
  da sole pesano ~3,8 KB, con uno `state` tipico il corpo è ~4,2 KB e nel caso peggiore
  (oggetto 300 + anteprima 600 caratteri) ~5,0 KB. Con l'euristica dei ~4 caratteri per
  token sono **~1.000–1.250 token di input a mail**, cioè 1.000 mail ≈ 1–1,3 M token ≈
  **$0,04–0,05**, prima di qualunque wrapping lato server.
  **È una stima finché non la misuri**: `TYPESAFE_API_KEY=... node tools/contract-test.mjs`
  (§8) stampa `Token di input totali`, `Costo misurato` e `Costo per email` reali,
  restituiti dall'API. Sostituisci i numeri qui sopra con quelli appena li hai.
- **Rate limit: 1.200 richieste/minuto.** Con il tetto di 4 richieste parallele è fuori
  portata nell'uso normale; se lo tocchi, il client fa retry con backoff.

Limiti onesti:

- JevGuard vede **solo ciò che mostra la lista**: niente corpo del messaggio, niente link,
  niente header, nessun controllo SPF/DKIM/DMARC. È un semaforo di triage, non un gateway
  antispam: un phishing ben scritto con oggetto anonimo può risultare basso.
- **Non copre le viste destinatario** (Inviati, Bozze, Programmati, In uscita, Modelli):
  lì la riga mostra a chi scrivi, non chi ti scrive, quindi l'analisi è disattivata di
  proposito (§1).
- Jev è **primariamente inglese**: sui testi italiani le soglie vanno calibrate (vedi §8)
  prima di fidarsi dei valori intermedi.
- Le **classi CSS di Gmail cambiano senza preavviso**: se un giorno non vedi più barre, i
  primi sospettati sono i selettori di riga in `gmail-rows.js` e `MAIN_SELECTOR` in
  `inject.js` → `window.JevGuard.debug()`.

## 7. Privacy

Per ogni riga analizzata esce dal browser **solo** questo oggetto, verso
`https://api.typesafe.ai/v1/systemone` e nient'altro:

| campo inviato | origine |
|---|---|
| `sender_display_name` | nome mittente mostrato nella riga (max 120 caratteri) |
| `sender_address` | indirizzo mittente, se la riga lo espone (max 160 caratteri) |
| `sender_domain` | derivato **in locale** dall'indirizzo, non dedotto dal modello |
| `subject` | oggetto (max 300 caratteri) |
| `preview_text` | anteprima già visibile nella lista (max 600 caratteri) |

Cinque campi, nessun altro: sono esattamente quelli che le sei domande citano. Un campo di
cui non si conosce il valore viene **omesso dall'oggetto**, mai spedito come segnaposto (un
`"(non disponibile)"` al posto del dominio il modello lo leggerebbe come un dominio sbagliato).
Unica eccezione: `preview_text` c'è sempre, al massimo come stringa vuota.

**Non** escono mai: il corpo del messaggio, i link, gli header, gli allegati, l'id del thread
(resta locale, serve solo come chiave di cache), l'indirizzo del tuo account. Restano locali
anche `hasAttachment` e `otherSendersCount`: il content script li estrae e fanno parte di
`RowData`, ma **non vengono inviati al modello** (nessuna delle sei domande li usa).

La API key sta in `chrome.storage.local`, la legge **solo** il service worker: non viene mai
iniettata nella pagina, non compare nel DOM di Gmail, non transita nei messaggi verso i
content script. Nessuna telemetria, nessun endpoint di logging, nessun server terzo: le uniche
tracce sono le righe `[JevGuard]` nella console locale.

## 8. Calibrazione e test

```bash
cd ~/Developer/jev-gmail/gmail-jev-guard
TYPESAFE_API_KEY=sk-... node tools/contract-test.mjs
```

Gira le email di `tools/fixtures.json` contro l'API reale. Sono casi italiani costruiti a
coppie — la finta Poste e una Poste vera, la finta Intesa e un accesso reale, il finto
rimborso dell'Agenzia delle Entrate e uno legittimo, più promozioni sollecitate, newsletter
e posta personale — così un modello che dicesse solo "linguaggio bancario italiano =
phishing" verrebbe subito smascherato. Stampa una tabella: una riga per fixture, con le probabilità restituite dai Noul, il rischio calcolato e
l'esito atteso dal campo `expect` (`phishing` / `spam` / `ok`), così vedi a colpo d'occhio
falsi positivi e falsi negativi. Usa `src/jev.js` e `src/typesafe-client.js` esatti
dell'estensione — quello che vedi nel test è quello che vedrai in Gmail. In coda stampa
`Token di input totali`, `Costo misurato` e `Costo per email`: sono le uniche cifre di
costo misurate davvero, quelle con cui aggiornare la stima di §6.

Ciclo di taratura:

1. Aggiungi a `tools/fixtures.json` le mail che l'estensione sbaglia (anonimizzate), con il
   loro `expect`.
2. Correggi `QUESTIONS[<noul>].criteria.true` / `.false` in `src/jev.js`: i criteri devono
   dire la stessa cosa nella stessa direzione delle `instructions`, e le mail italiane vanno
   descritte con i loro pretesti tipici (SPID, Poste, Agenzia delle Entrate, corrieri).
3. Rilancia il test, poi ricarica l'estensione da `chrome://extensions` e ricarica Gmail.

Le soglie delle fasce stanno in `RISK_BANDS`, sempre in `src/jev.js`.

## 9. Troubleshooting

Due console da tenere a mente:
**pagina** (F12 su Gmail) per i content script, **service worker** su `chrome://extensions` →
JevGuard → *Ispeziona visualizzazioni: service worker*.

| sintomo | cosa controllare |
|---|---|
| **Nessuna barra** | Sei in **Inviati / Bozze / Programmati / In uscita / Modelli**? Lì l'analisi è disattivata di proposito (§1), non è un guasto. Hai ricaricato la tab di Gmail dopo aver caricato l'estensione? Poi nella console: `window.JevGuard.debug()`. `enabled: false` → accendi l'interruttore nel popup (riparte OFF a ogni avvio di Chrome). `mainFound: false` → aggiorna `MAIN_SELECTOR` in `src/content/inject.js`: è il contenitore su cui sono agganciati observer e ricerca delle righe, e se non matcha `rescan()` esce subito, quindi toccare `gmail-rows.js` non serve a niente. `mainFound: true` ma `detectedRows: 0` → aggiorna `ROW_SELECTORS` / `SUBJECT_CELL_SELECTOR` in `src/content/gmail-rows.js`. `firstRow.senderAddress: ""` → è saltata solo l'estrazione del mittente. Se `debug` non esiste, i content script non sono entrati: controlla gli errori in `chrome://extensions`. |
| **Barre grigie pulsanti che non si fermano** | Analisi in corso o coda bloccata: guarda `pending` / `queued` in `debug()` e la console del service worker. |
| **Barre grigie con `!`** | Passa il mouse: il tooltip dice il motivo e chiude con il codice tra parentesi quadre (`Analisi non riuscita: … [AUTH]`). Codici: `NO_KEY`, `AUTH`, `RATE_LIMIT`, `BAD_REQUEST`, `NETWORK`, `TIMEOUT`, `DISABLED`, `UNKNOWN`. Dopo aver risolto, `window.JevGuard.rescan()`: cancella i verdetti in errore e rianalizza (uno scroll normale non ritenta). |
| **401 / `AUTH`** | Chiave sbagliata, scaduta o incollata con spazi. Popup → **Cambia** → reincolla → **Verifica** (deve elencare i modelli). |
| **429 / `RATE_LIMIT`** | Il client ha già ritentato 3 volte rispettando `retry-after`. Aspetta un minuto e `rescan()`. Se capita su pochi messaggi, è più probabile un problema di quota sull'account TypeSafe che il limite di 1.200 req/min. |
| **Barra nel punto sbagliato / coperta** | `BADGE_PLACEMENT = "append-cell"`, costante in testa a `src/content/inject.js`, poi ricarica estensione e tab. |
| **Numeri incoerenti nel popup** | Prima controlla che non sia normale: *Con verdetto* è relativo alla scheda Gmail aperta e cala quando Gmail ricicla le righe, mentre *Analisi riuscite* e *Token input* sono totali di sessione che salgono e basta (§4). Se restano incoerenti: **Svuota cache** nel popup (`CLEAR_CACHE`), poi ricarica Gmail. |

`window.JevGuard.debug()` disegna anche un bordo magenta tratteggiato per 3 secondi attorno a
ogni riga che ha riconosciuto: è il modo più rapido per capire se il problema è il
riconoscimento delle righe o l'analisi.
