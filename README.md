# Leverage50xAgents — Etapa 2B, control local READ-ONLY

Dashboard central pentru dispozitive personale, heartbeat și inventar al sesiunilor Codex. Stage 1 este păstrat în tagul `v0.1.1-stage1-demo`, 2A pe `stage2-device-discovery`, iar controlul local și launcher-ul pe `stage2b-local-control`, fără merge în main.

Aplicația oferă inventar de dispozitive/sesiuni și control Codex real, local, **READ-ONLY**. Selectează explicit dispozitivul principal, New sau Resume, workspace-ul și instrucțiunea, apoi confirmă. Scrierea și execuția pe alte dispozitive rămân blocate; `LEVERAGE_ENABLE_LIVE_CODEX=1` este refuzat. Ghid curent: [ETAPA-2B-LOCAL.md](ETAPA-2B-LOCAL.md).

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

Controlul local poate crea o conversație New ori continua sesiunea Resume selectată explicit. Controllerul verifică politica efectivă READ-ONLY, oferă contextul sigur al proiectului, păstrează instrumentele dezactivate și respinge escaladările. Modelul nu primește acces de scriere sau comenzi shell. Autentificarea, politica și selecția trebuie să fie valide înainte de turn; o eroare este raportată fără reluarea automată a instrucțiunii.

Progresul și răspunsul parțial apar în timpul turnului; numai notificarea `turn/completed` pentru thread-ul și turnul selectate confirmă finalizarea. Limitele implicite sunt separate: 30s pentru răspuns RPC, 180s fără activitate a turnului și 10 minute durată totală după confirmarea RPC. Activitatea prelungește numai limita de inactivitate. Timeouturile au coduri distincte și păstrează răspunsul parțial sigur. Detalii și verificări reale: [ETAPA-2B-LOCAL.md](ETAPA-2B-LOCAL.md).

Configurație agent: `LEVERAGE_AGENT_ID`, `LEVERAGE_AGENT_TOKEN`, `LEVERAGE_DEVICE`, `LEVERAGE_URL` loopback, opțional `LEVERAGE_WORKSPACE`, `LEVERAGE_CODEX_HOME`/`CODEX_HOME`, `LEVERAGE_SESSION_SOURCE=app-server|files`, `LEVERAGE_REPORT_PROJECT=0`. Hub: `LEVERAGE_OPERATOR_TOKEN`, `LEVERAGE_CREDENTIAL_STORE`, `LEVERAGE_HOST`, `LEVERAGE_PORT`. Vechiul `LEVERAGE_TOKEN` este acceptat doar ca token operator pentru tranziție; nu autentifică agenți.

Detalii istorice despre descoperirea 2A: [ETAPA-2A-ARHITECTURA.md](ETAPA-2A-ARHITECTURA.md). Politica locală, selecția și limitările actuale sunt în [ETAPA-2B-LOCAL.md](ETAPA-2B-LOCAL.md). Scrierea, aprobările tehnice și auditul persistent al execuției necesită o etapă separată.

## Teste și CI

`npm test` folosește `node --test`, date sintetice și porturi temporare pe 127.0.0.1. Sunt testate și două procese agent reale pe același sistem; aceasta nu verifică fizic laptopul 2 sau tunelul SSH. Sandboxul poate necesita aprobare pentru loopback/subprocese; un blocaj nu reprezintă PASS.

Workflow-ul `.github/workflows/ci.yml` rulează pe push/PR: Ubuntu, Node.js 22, `npm ci`, `npm test`, permisiunea `contents: read`, fără secrete reale. [VERIFICARE.md](VERIFICARE.md) păstrează rezultatele istorice; operațiunile și rezultatele rundelor ulterioare sunt în [comenzi executate agent.md](<comenzi executate agent.md>). Nu publica `.env`, `.local-run`, credențiale sau configurații personale.

Licență MIT; vezi LICENSE.
