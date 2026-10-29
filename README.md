# Leverage50xAgents — Etapa 2C, analiză locală READ-ONLY

Dashboard central pentru dispozitive personale, heartbeat și inventar al sesiunilor Codex. Stage 1 este păstrat în tagul `v0.1.1-stage1-demo`, 2A pe `stage2-device-discovery`, iar controlul local și launcher-ul pe `stage2b-local-control`, fără merge în main.

Pilotul cu agent separat WSL este pe `pilot-laptop2`: [PILOT-LAPTOP2.md](PILOT-LAPTOP2.md), `./laptop2 check|start|stop|status`. Acesta reutilizează agentul și autentificarea Codex locală pentru inventar; controlul laptopului secundar rămâne blocat până la autorizarea explicită per dispozitiv/workspace în Hub.

Aplicația oferă inventar de dispozitive/sesiuni și control Codex real, local, **READ-ONLY**. Selectează explicit dispozitivul principal, New sau Resume, workspace-ul și instrucțiunea, apoi confirmă. Codex poate cere directoare și linii din sursele autorizate în timpul analizei, fără preload al întregului repository. Scrierea și execuția pe alte dispozitive rămân blocate; `LEVERAGE_ENABLE_LIVE_CODEX=1` este refuzat. Ghid curent: [ETAPA-2C-READONLY.md](ETAPA-2C-READONLY.md); launcher și istoric: [ETAPA-2B-LOCAL.md](ETAPA-2B-LOCAL.md).

## Pornire locală

Cu credențialele deja create în `.local-run`, folosește din rădăcină:

```bash
./leverage start
./leverage status
./leverage logs
./leverage stop
```

Procesele sunt detașate, fără autostart. `stop` verifică identitatea proceselor proprii; un port ocupat de alt proces este diagnosticat fără oprirea lui. `logs` afișează numai evenimente operaționale filtrate. Launcher-ul nu generează secrete automat.

Node.js >=22, npm, Linux/WSL. Numai module Node built-in, fără dependențe externe.

```bash
npm ci
npm test
node src/manage.mjs init
node --env-file=.local-run/hub.env src/hub.mjs
```

Comenzile de mai sus pentru `init` și Hub sunt necesare numai la înrolarea inițială, dacă fișierele lipsesc. În alt terminal, în același checkout:

```bash
node --env-file=.local-run/hub.env src/manage.mjs enroll --name laptop-1 --out .local-run/laptop1.env
```

Oprește apoi Hub-ul manual cu Ctrl+C în terminalul lui și rulează `./leverage start`. Acesta configurează agentul principal și workspace-ul local pentru controlul READ-ONLY. `init`/`enroll` refuză suprascrierea fișierelor private existente; la restart refolosește fișierele, fără o nouă înrolare.

Deschide manual http://127.0.0.1:8765. Introdu tokenul **operatorului**, consultat privat în `.local-run/hub.env`. Nu îl trimite în conversație, capturi sau Git. Tokenul browserului rămâne în memoria paginii. Autentificarea Codex existentă este verificată separat; aplicația afișează doar authenticated, not authenticated sau unavailable, fără credențiale sau date de cont.

Fișierul Stage 1 `.env` rămâne ignorat și păstrat; noul flux nu îl reutilizează ca secret partajat. Node încarcă explicit fișierele prin `--env-file`, iar variabilele deja exportate au prioritate. `.env.example` conține doar placeholder-uri.

## Dispozitive și permisiuni

Fiecare agent primește UUIDv4 persistent și token independent. Registrul privat `.local-run/agents.json` păstrează numai hash-uri SHA-256 și revocări, în fișier 600/director 700. Nume identice sunt permise. Dashboard-ul afișează UUID, Online/Offline, heartbeat și sesiuni selectate per dispozitiv. Online înseamnă heartbeat în ultimele 15 secunde, nu sănătatea Codex.

Operatorul poate înrola/revoca agenți și folosi dashboard-ul; un agent poate raporta numai propriul UUID și nu poate folosi endpointurile administrative sau vedea inventarul altora. Revocarea persistă după restart și invalidează următoarea cerere. Numai agentul principal configurat poate revendica instrucțiuni locale READ-ONLY confirmate explicit. Inventarul, joburile și răspunsurile rămân în memorie; agenții refac inventarul după restart Hub.

Ghidul [ETAPA-2-LAPTOP2.md](ETAPA-2-LAPTOP2.md) rămâne documentație pentru descoperirea 2A. Conectarea laptopului 2 și execuția pe alt dispozitiv nu fac parte din această livrare. Hub-ul și destinațiile HTTP ale agentului rămân exclusiv loopback. Nu expune portul pe internet și nu schimba bind-ul în 0.0.0.0.

## Sesiuni Codex și confidențialitate

Adaptorul App Server este verificat pentru codex-cli **0.163.0**. Inventarul folosește `thread/list` cu `useStateDbOnly:true` și filtrul implicit `codex resume`: workspace-ul autorizat, `archived:false`, `sourceKinds:["cli","vscode"]`, sortare după ultima actualizare. Sesiunile auxiliare și subagenții sunt omise; numărul rezultatelor nu este fixat. O eroare a inventarului App Server filtrat produce o listă indisponibilă, fără a ghici selecția din fișiere.

Sunt raportate maximum 40 UUID-uri, timestampuri și opțional un basename validat al proiectului și un titlu sigur din metadatele oficiale `Thread.name`, limitat la 120 bytes UTF-8. Dacă titlul lipsește sau este sensibil, UI afișează `Untitled session`; nu îl derivă din preview sau transcript. Căile absolute, transcripturile, preview-urile, cheile și configurațiile nu sunt trimise la Hub. Câmpurile suplimentare ale protocolului sunt eliminate din datele returnate de adaptor.

O sesiune `Discovered` este un candidat pentru verificare, nu dovada că rulează ori poate fi reluată. Resume reverifică disponibilitatea și dobândește lock-ul nativ exclusiv al thread-ului prin Codex 0.163.0. `Busy` înseamnă conflict pe thread-ul selectat sau un turn deja pornit de aplicație; un alt thread din același workspace este permis. Lock-ul nativ coordonează procesele care folosesc același CODEX_HOME și poate rămâne deținut de un client Codex inactiv, cât timp thread-ul este încărcat în acel client. Închiderea conversației din UI nu dovedește eliberarea lui. Aplicația nu oprește clientul personal și nu forțează lock-uri.

Inventarul și autentificarea folosesc un App Server care nu încarcă thread-uri. Fiecare turn aprobat are un worker separat, închis și așteptat până la confirmarea ieșirii înainte de eliberarea lease-urilor aplicației, inclusiv la completed, failed și timeout. Inventarul afișează eligibilitatea `Discovered` sau `Busy`. Dacă ieșirea workerului nu poate fi confirmată, `codex-cleanup-unconfirmed` blochează turnurile următoare; verifică starea agentului înaintea unui restart explicit.

`updatedAt` este ultima activitate cunoscută; timpul relativ, ID-ul complet și UTC-ul sunt afișate în dashboard. Pentru inventar explicit din fișiere, `LEVERAGE_SESSION_SOURCE=files` citește numai nume/stat și nu certifică filtrul CLI sau activitatea. Numele MCP indică numai configurarea, fără verificare live. `LEVERAGE_REPORT_PROJECT=0` omite etichetele proiectelor.

Controlul local poate crea o conversație New ori continua sesiunea Resume selectată explicit. Controllerul verifică politica READ-ONLY și permite numai uneltele proprii `repository_list` / `repository_read`, care citesc la cerere fișiere sursă și configurații neconfidențiale. Pentru sesiunile vechi fără unelte persistate, un protocol JSON limitat continuă analiza în același thread. Nu sunt preîncărcate automat README-ul sau toate fișierele. Modelul nu primește scriere, shell, network, browser sau MCP.

Cititorul blochează `.env*`, `.local-run`, directoare private, traversal, symlink/hardlink și formate sensibile recognoscibile; impune 64 KiB/fișier, 512 KiB și 64 cereri per job. Fiecare pagină are maximum 200 linii/16 KiB. Filtrul conservator poate refuza unele teste cu credențiale sintetice și nu garantează detectarea informațiilor confidențiale arbitrare. Instrucțiunile găsite în fișiere nu pot schimba politica. Preflight-ul Codex refuză configurații ambientale incompatibile și dezactivează skills numai pentru thread-ul propriu, fără schimbarea login-ului/configurației globale. Detalii: [ETAPA-2C-READONLY.md](ETAPA-2C-READONLY.md).

Progresul citirilor și răspunsul parțial apar în timpul analizei; numai notificările `turn/completed` corelate confirmă finalizarea. Limitele implicite sunt separate: 30s pentru răspuns RPC, 180s fără activitate și 10 minute durată totală după primul ACK. Continuările de compatibilitate nu resetează plafonul total. Timeouturile păstrează răspunsul parțial sigur, fără retry automat. Dashboard-ul semnalează explicit orice răspuns trunchiat de limita de afișare/transport. Detalii și verificări reale: [ETAPA-2C-READONLY.md](ETAPA-2C-READONLY.md).

Configurație agent: `LEVERAGE_AGENT_ID`, `LEVERAGE_AGENT_TOKEN`, `LEVERAGE_DEVICE`, `LEVERAGE_URL` loopback, opțional `LEVERAGE_WORKSPACE`, `LEVERAGE_CODEX_HOME`/`CODEX_HOME`, `LEVERAGE_SESSION_SOURCE=app-server|files`, `LEVERAGE_REPORT_PROJECT=0`. Hub: `LEVERAGE_OPERATOR_TOKEN`, `LEVERAGE_CREDENTIAL_STORE`, `LEVERAGE_HOST`, `LEVERAGE_PORT`. Vechiul `LEVERAGE_TOKEN` este acceptat doar ca token operator pentru tranziție; nu autentifică agenți.

Detalii istorice despre descoperirea 2A: [ETAPA-2A-ARHITECTURA.md](ETAPA-2A-ARHITECTURA.md). Politica locală, selecția și limitările actuale sunt în [ETAPA-2B-LOCAL.md](ETAPA-2B-LOCAL.md). Scrierea, aprobările tehnice și auditul persistent al execuției necesită o etapă separată.

## Teste și CI

`npm test` folosește `node --test`, date sintetice și porturi temporare pe 127.0.0.1. Sunt testate și două procese agent reale pe același sistem; aceasta nu verifică fizic laptopul 2 sau tunelul SSH. Sandboxul poate necesita aprobare pentru loopback/subprocese; un blocaj nu reprezintă PASS.

Ultima rundă de simplificare păstrează Etapa 2C: paginare comună a sesiunilor, pornire Hub/agent fără logică duplicată și limitare UTF-8/JSON mai eficientă. Computers arată rezumatul inventarului; metadatele complete sunt în lista selectabilă de sesiuni. Măsurători, teste și compromisuri: [RAPORT-OPTIMIZARE.md](RAPORT-OPTIMIZARE.md).

Workflow-ul `.github/workflows/ci.yml` rulează pe push/PR: Ubuntu, Node.js 22, `npm ci`, `npm test`, permisiunea `contents: read`, fără secrete reale. [VERIFICARE.md](VERIFICARE.md) păstrează rezultatele istorice; operațiunile și rezultatele rundelor ulterioare sunt în [comenzi executate agent.md](<comenzi executate agent.md>). Nu publica `.env`, `.local-run`, credențiale sau configurații personale.

Licență MIT; vezi LICENSE.
