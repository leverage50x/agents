# Leverage50xAgents — verificare Etapa 2A (2026-10-22)

## Verificări actuale

- Tagul Stage 1 a fost extras într-un director temporar și testat fără modificări: **25/25 PASS**. main și tagul nu au fost modificate.
- Suita integrată după adaptarea autentificării: **51/51 PASS**; după adăugarea a trei cazuri de securitate suplimentare: **54/54 PASS**. Verificarea finală după ajustările inventarului: `npm ci` cod 0, zero vulnerabilități raportate; `npm test` **54/54 PASS**, zero fail/skip, 3004.198565 ms. Rezultatul remote CI este consemnat după publicare în jurnal.
- Hub și doi agenți ca procese CLI Node reale au fost porniți exclusiv pe 127.0.0.1, cu case/date/credențiale sintetice. Au fost verificate heartbeat separat, nume identice, dashboard HTTP 200, restart cu același UUID și revocare, cu celălalt agent funcțional.
- Testele verifică token invalid, agent fără acces administrativ, operator fără acces la endpointurile agentului, UUID legat de credențială, revocare persistentă și în timpul unui heartbeat incomplet, Offline după expirare și sesiuni separate în UI. Tokenul unui agent activ sau revocat nu poate deveni token operator.
- Inventarul filtrează preview/turnuri/căi absolute și nu acceptă activitate confirmată declarată de agent. Adaptorul are 12 teste sintetice pentru protocol, paginare, fallback, versiune incompatibilă, output limitat, cereri nesolicitate și oprirea procesului la timeout.
- Codex CLI local: **0.163.0**; schema generată local confirmă useStateDbOnly. Adaptorul real a executat initialize/initialized/thread/list într-un CODEX_HOME izolat: sursa app-server, status available, 0 sesiuni, fără turnuri de model. Aceasta verifică protocolul, nu starea sesiunilor personale într-un alt runtime.
- Inventarul real local prin nume/stat a găsit 5 ID-uri de sesiune, status available, fără trunchiere; nu s-au citit transcripturi și nu s-au afișat ID-uri/căi personale.
- Protecția LEVERAGE_ENABLE_LIVE_CODEX=1 este păstrată și testată. Niciun dashboard task nu lansează Codex, shell sau MCP. Sesiunile rămân discovered/activity unconfirmed.
- Rulările inițiale din timpul asamblării au eșuat din cauza modulului încă nescris și a limitelor sandboxului pentru subprocese; nu sunt prezentate ca PASS. Suitele complete au fost rulate prin aprobarea explicită a platformei.

Nu a fost verificat fizic laptopul 2, accesul lui SSH/LAN/VPN sau inventarul lui real. Testele cu doi agenți rulează pe un singur sistem. UI are teste DOM sintetice și HTTP real; nu s-a deschis automat browserul și nu pretindem verificare vizuală în această etapă. Ghidul manual este ETAPA-2-LAPTOP2.md. Procesele temporare de test au fost oprite.

## Arhiva verificării Stage 1 (2026-10-17)

Textul următor descrie exclusiv starea istorică Stage 1; limitele autentificării partajate au fost înlocuite pe branch-ul 2A.

## Rezultate executate efectiv

- Mediu: Node.js v22.23.3, npm 10.9.9.
- Verificare inițială: git status --short a returnat 128, deoarece workspace-ul nu este repository Git. Nu am inițializat Git.
- La început, cele patru teste existente au trecut prin rulări separate; integrarea hub a necesitat permisiune explicită pentru portul localhost.
- După implementare: node --check a trecut pentru toate cele 14 fișiere .mjs din src, test și test-support.
- Testele directe fără porturi au trecut: API 7/7, agent 2/2, inventar 7/7, runner 4/4 și UI 3/3.
- npm test în sandbox: cod 1, cinci fișiere de teste au trecut, iar cele două teste HTTP au fost blocate de restricția de ascultare pe localhost. Acest rezultat nu este PASS.
- npm test reluat prin aprobarea separată a platformei pentru testele localhost: cod 0, **25/25 teste PASS**, zero eșecuri, zero teste omise.
- Testul HTTP real a pornit un hub pe un port temporar 127.0.0.1 și a utilizat implementarea reală a agentului prin tick, cu directoare și credențiale sintetice. A verificat servirea paginii/CSS, răspunsul 413, inventarierea, păstrarea instrucțiunii în pending_approval și finalizarea DEMO după aprobare, fără .git sau scrieri în workspace-ul fixture.
- Testul CLI a pornit și oprit efectiv procesul hub, cu autentificare, aprobare și respingere. Rezultatul trimis prin API în acel test este explicit MOCK.
- Revizia statică a src nu a găsit lansări child_process, spawn, execFile, eval sau new Function. Blocajul LEVERAGE_ENABLE_LIVE_CODEX=1 este prezent și testat.
- Serviciile testelor au fost oprite, iar fixture-urile temporare au fost curățate. Nu am instalat dependențe, făcut commit/push sau publicat nimic.

Ieșirile complete ale testelor, comenzile literale și erorile sunt în [comenzi executate agent.md](<comenzi executate agent.md>). Jurnalul include și un patch inițial respins pentru format, fără modificări, apoi corectat.

## Comportament verificat

- Demonstrația funcționează într-un director absolut existent și lizibil, fără repository Git.
- Cererile fără bearer valid, JSON malformat sau neobiect, inventarul invalid și rezultatele necorespunzătoare sunt respinse.
- Limita corpului este de 20000 bytes, inclusiv pentru caractere UTF-8 împărțite între fragmente.
- Sarcinile neaprobate și respinse nu sunt livrate; aprobările repetate și rezultatele duplicate sau atribuite altui dispozitiv sunt respinse.
- Dispozitivele devin offline după 15 secunde fără heartbeat; cererile pentru dispozitive offline sunt refuzate.
- URL-urile externe, credențialele în URL și hosturile de ascultare externe sunt refuzate înaintea utilizării; agentul setează redirect: error.
- Inventarul sintetizat verifică nume MCP fără alte câmpuri, șiruri TOML multiline, lipsă sau inaccesibilitate, intrări simbolice, UUID-uri duplicate, ordonare peste 500 fișiere și scanări limitate.
- Un spy verifică faptul că scanarea sesiunilor nu apelează readFileSync pentru transcripturi.
- Logica UI este testată cu DOM și fetch simulate: blocare înaintea conectării, după eroare și pentru dispozitive offline, reconectare, escapare HTML și confirmare de aprobare refuzată.

## Fișiere modificate sau adăugate

Modificate:
- AGENTS.md — autonomie locală și restricții păstrate.
- src/hub.mjs, src/agent.mjs, src/codex-runner.mjs, src/inventory.mjs — validări, inventar, localhost și runner demo fără Git.
- src/ui.mjs, src/ui.html — stări de conexiune și formulări demo/inventar.
- test/hub.test.mjs, test/runner.test.mjs, test/inventory.test.mjs — teste extinse și curățare.
- README.md, INSTRUCTIUNI-RO.md, PROMPT-CODEX-RO.md, VERIFICARE.md — documentație actualizată.

Adăugate:
- src/local-config.mjs.
- test/api.test.mjs, test/agent.test.mjs, test/local.integration.test.mjs, test/ui.test.mjs.
- test-support/fixtures.mjs.
- comenzi executate agent.md.

Nu am modificat package.json, package-lock.json, .env.example, .gitignore, LICENSE sau src/ui.css.

## Simulări și integrări neverificate

Rezultatul DEMO este o simulare, chiar când transportul HTTP și modulele hub/agent sunt reale. Nu a fost executat niciun Codex, shell sau MCP prin instrucțiunile dashboardului.

Nu am inspectat configurații personale sau sesiuni reale. Nu am verificat vizual aplicația într-un browser, pornirea agentului ca proces CLI separat, autentificarea Codex, sesiunile VS Code, MCP live sau un al doilea dispozitiv.

Autentificarea este încă partajată; un deținător al tokenului poate utiliza toate endpointurile. Coada este în memorie, fără persistență, recuperare sau audit persistent al aprobărilor aplicației. Parserul numelor MCP nu este un parser TOML complet. Acesta este un MVP local demonstrativ, nu un produs auditat pentru producție.

ETAPA 1 este încheiată. ETAPA 2 nu a fost începută.
