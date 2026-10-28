# Etapa 2C — analiza repository-ului la cerere

Etapa 2C extinde exclusiv controlul local READ-ONLY de pe `stage2b-local-control`. Dispozitivul principal, workspace-ul configurat, New/Resume și confirmarea operatorului rămân obligatorii. Nu acordă drepturi de scriere și nu controlează alte dispozitive.

## Cum primește Codex codul

Snapshot-ul automat al README-ului a fost eliminat. La New, App Server 0.163.0 primește numai două unelte definite de aplicație: `repository_list` și `repository_read`. Modelul cere directoare și intervale de linii în timpul analizei; agentul local verifică fiecare cerere și returnează datele autorizate, numerotate și marcate ca nefiind instrucțiuni. Citirea nu execută JavaScript, configurații, scripturi npm sau teste din proiect.

Resume pe o sesiune creată astfel restaurează uneltele persistate de Codex. Versiunea 0.163.0 nu permite adăugarea lor prin `thread/resume` unei sesiuni mai vechi. Pentru compatibilitate, modelul poate emite o cerere JSON strictă de listare/citire; aplicația o servește și continuă conversația selectată prin `turn/start`, în cadrul aceleiași aprobări și al aceluiași job. Nu creează o conversație înlocuitoare și nu modifică istoricul anterior. Cererile intermediare nu reprezintă răspunsul final.

Protocolul experimental este verificat pe versiunea instalată, nu presupus compatibil cu orice versiune viitoare. Vezi [documentația oficială App Server](https://learn.chatgpt.com/docs/app-server), secțiunea „Dynamic tool calls”. Configurația și schema sunt controlate de aplicație; dashboard-ul nu poate furniza politici, căi absolute de execuție sau alte unelte.

## Fișiere autorizate și limite

Sunt permise fișiere text UTF-8 cu extensiile `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.json`, `.md`, `.markdown`, `.css`, `.html`, `.yml`, `.yaml`, `.toml`, plus `LICENSE`, `LICENSE.md`, `leverage`, `.gitignore` și `.editorconfig`, dacă trec toate verificările. `.github/workflows/ci.yml` și testele pot fi inspectate. Numele de căi acceptate sunt ASCII, cu maximum 12 componente; unele repository-uri cu nume Unicode vor necesita o politică ulterioară.

Sunt excluse toate `.env*`, directoarele ascunse în afară de `.github`, `.local-run`, `.git`, `.codex`, `.aws`, dependențele și ieșirile generate, directoarele de autentificare, secrete, sesiuni, transcripturi, date personale și backup-uri. Jurnalul operațional și rapoartele `RAPORT*` nu sunt context pentru model. Modulele sursă precum `credentials.mjs` pot fi analizate, însă fișierele de credențiale nu pot fi citite.

| Limită per job aprobat | Valoare |
| --- | --- |
| Dimensiunea integrală a unui fișier | 64 KiB |
| Volum citit cumulat, inclusiv recitirile și fișierele respinse după scanare | 512 KiB |
| Cereri de listare/citire, inclusiv refuzurile | 64 |
| Intrări returnate la o listare | 100 |
| Intrări scanate într-un director la o cerere | 1.000 |
| Linii returnate la o citire | 200 |
| Conținut returnat la o citire | 16 KiB |

Fișierul întreg este scanat înainte de returnarea unui interval de linii. Sunt respinse formate cunoscute de chei/tokenuri, credențiale literale, emailuri personale, căi de utilizator și anumite date de contact/rețea. Acest filtru este conservator: teste care conțin tokenuri sintetice pot fi refuzate. **Nu este un detector semantic complet de informații confidențiale**; un nume propriu sau un secret arbitrar fără un format recognoscibil nu poate fi identificat garantat. Workspace-ul trebuie să conțină sursele pe care operatorul are dreptul să le analizeze.

Traversarea folosește descriptori Linux/WSL și `O_NOFOLLOW` pentru fiecare componentă. Sunt refuzate symlink-uri, hardlink-uri, fișiere speciale, traversarea `..`, căi absolute și codificate, înlocuirea workspace-ului și fișierele schimbate în timpul citirii. Răspunsurile incomplete indică paginarea/următoarea linie; modelul nu primește un snapshot al întregului proiect.

## Izolare Codex și lifecycle

Shell-ul, execuția unificată, browserul, web search, MCP, aplicațiile, pluginurile, subagenții și cererile de escaladare rămân indisponibile. Singurele cereri executate de aplicație sunt citirile/listările brokerului pentru thread-ul și turn-ul selectate. Un nume de unealtă necunoscut, alt thread/turn, un replay sau o cerere de aprobare este refuzată. Instrucțiunile din fișiere sunt date nefiabile; nu pot schimba allowlist-ul sau limitele tehnice.

Documentele de proiect încărcate automat de Codex sunt dezactivate prin `project_doc_max_bytes=0`. Deoarece CLI 0.163.0 continuă să încarce instrucțiunile din propriul director global, aplicația refuză o execuție dacă există acolo `AGENTS.md` sau `AGENTS.override.md`; nu le citește și nu le șterge. Preflight-ul `config/read` refuză MCP activ, fișiere externe de instrucțiuni/compactare și comenzi de autentificare ale providerelor. Un tabel `mcp_servers={}` nu este considerat dovadă de dezactivare: Codex îl combină cu serverele existente.

Descrierile skill-urilor pot fi incluse automat chiar cu shell-ul dezactivat. Aplicația cere inventarul de metadate prin `skills/list`, fără să-l trimită la Hub, apoi dezactivează toate căile raportate, inclusiv cele de sistem, în configurația RPC a thread-ului propriu. Catalogul incomplet, cu erori sau într-un format necunoscut blochează execuția. Dezactivarea runtime a fost verificată cu App Server nativ, inclusiv când promptul menționează un skill dezactivat; nu se schimbă fișierele de configurare. Notificările externe sunt dezactivate numai în procesul propriu. Nu sunt modificate configurațiile globale, login-ul sau credențialele.

Aceste verificări presupun configurația locală stabilă pe durata jobului; nu izolează întregul proces Codex împotriva unui utilizator ostil care îi modifică simultan configurația sau sistemul de operare. Codex folosește în continuare propria autentificare și persistență a sesiunilor. La Resume, contextul anterior al conversației selectate este încărcat intern de Codex cu acordul explicit al operatorului; aplicația nu îl citește prin API și nu îl publică.

O singură execuție de aplicație poate fi activă în workspace. Lock-ul nativ protejează thread-ul selectat chiar dacă deținătorul este inactiv. Worker-ul propriu este închis și confirmat înainte de eliberarea lease-urilor; nu sunt oprite procese personale. Timeout-ul RPC este 30 s, lipsa activității 180 s, iar limita totală a analizei 600 s. Continuările de compatibilitate nu resetează limita totală. După eroare nu se reia automat instrucțiunea.

Dashboard-ul arată selecția, progresul citirilor autorizate, răspunsul și codurile de eroare sigure. Limita existentă de afișare este de maximum 8.000 de caractere, redusă suplimentar la 8.000 de octeți JSON UTF-8 de transport. `outputTruncated` indică explicit orice tăiere, inclusiv la transport. Pentru detalii suplimentare se poate confirma un Resume cu o întrebare mai îngustă.

## Verificări

Baseline-ul a trecut cu 170/170 teste. După implementare, o rulare intermediară completă a trecut cu 200 teste, iar verificarea finală cu **204/204 PASS**, fără teste omise sau anulate (7,486 s). Rularea completă precedentă a trecut tot 204/204 în 9,301 s; după ea s-a clarificat numai textul aprobării din UI pentru o analiză cu posibile continuări limitate. `npm ci` a reușit, fără dependențe externe sau vulnerabilități raportate; 34 module ESM au trecut verificarea sintaxei. CI rulează separat pe commitul publicat. Testele includ brokerul real de filesystem, protocol Codex simulat, autentificarea/izolarea Hub-agent, lifecycle, lock-uri, timeouturi, launcher și UI în DOM simulat.

Probe distincte cu App Server **nativ** și provider **sintetic** loopback au verificat catalogul efectiv de unelte, persistența lui la cold Resume, blocarea instrucțiunilor proiectului și dezactivarea runtime a skill-urilor user/system, inclusiv la menționarea lor explicită. Aceste probe nu sunt prezentate drept inferență cu model real.

Validarea cu **Codex și model real**, Hub HTTP și agent reale, a folosit un repository sintetic izolat, nou, cu login-ul WSL existent. Instrucțiunea principală a fost cea de analiză a funcțiilor nefolosite și duplicării, cu interdicția de modificare.

| Probă reală | Rezultat |
| --- | --- |
| New → analiză | completed, 66,555 s; progres și răspuns parțial observate |
| Resume pe același ID | completed, 20,781 s; contextul markerului anterior păstrat, 2 recitiri |
| Citiri private/externe/symlink | 4 refuzuri, 0 octeți citiți; completed, 21,430 s |
| Thread deținut de alt App Server propriu testului | refuz `codex-busy`, 0,628 s; proprietarul nu a fost forțat |
| Resume pe sesiune fără unelte persistate | completed, 59,383 s; 12 continuări JSON, același ID și context păstrat |
| Alt thread în același workspace cât primul era deținut | permis, fără fals Busy |
| Resume după eliberarea proprietarului de test | completed, 11,237 s; citire actuală a importurilor |
| Plafon de turn redus la 50 ms numai în probă | `codex-turn-timeout`; workerul propriu închis |

New a făcut 12 cereri și a citit efectiv 7 fișiere, 941 octeți în total: `src/main.mjs:1-3`, `src/math.mjs:1-7`, `src/display.mjs:1-3`, `package.json:1-7`, `test/math.test.mjs:1-4`, `.github/workflows/ci.yml:1-9`, `README.md:1-2`. Modelul a identificat `dormantFormat` nefolosită, la liniile 4–6 din `src/math.mjs`, și duplicarea `sum` / `sumAgain` din cele două module. Toate căile sursă/test citate în rezultat existau în fixture; verificarea nu este o garanție generală împotriva halucinațiilor în alte analize.

Căile respinse au fost `.env`, `.local-run/private.json`, `../outside.md` și un symlink `src/escape.md`. Sentinelul privat nu a apărut în răspuns. Hash-urile celor 9 fișiere originale, inclusiv cele private ale fixture-ului, au rămas identice. Nicio operațiune de scriere nu a fost disponibilă modelului. Pentru sesiunea legacy, helperul de test a omis intenționat `dynamicTools` numai la construirea unei conversații native noi; Resume și citirile ulterioare au folosit integrarea reală. Nu a fost reluată o conversație personală sau un CLI personal.

Toate procesele create de integrarea izolată au fost închise. Durata totală a fost 187,733 s. Răspunsurile brute, tokenurile, PII și transcripturile anterioare nu au fost înregistrate. Testul cu plafon scurt validează mecanismul real de timeout; limita implicită de 10 minute și cazurile de progres foarte lung rămân testate prin protocol/timp sintetic.

Aplicația principală a fost reîncărcată prin launcher numai după verificarea absenței joburilor queued/running: status/stop/start/status au avut exit0. După restart: HTTP200 la portul 8765, agent Online, Codex authenticated, inventar available cu 5 sesiuni la acel moment. Numărul este dinamic. Procesele Codex personale nu au fost oprite, login-ul nu a fost recreat și nu au fost accesate alte dispozitive. Interfața nu a fost verificată vizual într-un browser; verificările UI sunt simulate, iar verificarea aplicației reale este HTTP/backend/agent.

## Folosire locală

După încărcarea codului nou, selectează dispozitivul local, New sau o sesiune Resume, workspace-ul și o instrucțiune precum:

> Analizează repository-ul, identifică funcțiile nefolosite și codul duplicat. Indică fișierul și liniile relevante. Nu modifica nimic.

Confirmă explicit jobul. Urmărește evenimentele `Repository list` / `Repository read`, starea finală și eventualul avertisment de trunchiere. Constatările modelului trebuie evaluate ca analiză, nu ca dovadă formală de cod mort: exporturile pot avea utilizatori externi sau utilizări dinamice.

Dacă Hub-ul și agentul rulează încă din versiunea anterioară, așteaptă încheierea oricărui job al aplicației, apoi execută:

```sh
./leverage stop
./leverage start
./leverage status
```

Launcher-ul oprește exclusiv procesele proprii verificate. Restartul aplicației nu eliberează lock-ul unei sesiuni deținute de alt client Codex.
