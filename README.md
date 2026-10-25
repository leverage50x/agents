# Leverage50xAgents — Etapa 2B, control local READ-ONLY

Dashboard central pentru dispozitive personale, heartbeat și inventar al sesiunilor Codex. Stage 1 este păstrat în tagul `v0.1.1-stage1-demo`, 2A pe `stage2-device-discovery`, iar controlul local și launcher-ul pe `stage2b-local-control`, fără merge în main.

**Scrierea și execuția pe alte dispozitive rămân blocate.** Fluxul local READ-ONLY cere dispozitiv/sesiune sau New/workspace/instrucțiune selectate explicit și confirmare. DEMO rămâne separat; `LEVERAGE_ENABLE_LIVE_CODEX=1` este refuzat. Ghid curent: [ETAPA-2B-LOCAL.md](ETAPA-2B-LOCAL.md).

## Pornire locală

Cu credențialele Stage 2A deja create în `.local-run`, folosește din rădăcină `./leverage start`, `./leverage status`, `./leverage logs` și `./leverage stop`. Nu mai sunt necesare două terminale. Procesele sunt detașate, fără autostart. Un port ocupat este diagnosticat fără oprirea altor procese. Pașii de mai jos descriu înrolarea inițială și pornirea manuală Stage 2A, dacă fișierele lipsesc; launcher-ul nu generează secrete automat.

Node.js >=22, npm, Linux/WSL. Numai module Node built-in, fără dependențe externe.

```bash
npm ci
npm test
node src/manage.mjs init
node --env-file=.local-run/hub.env src/hub.mjs
```

Alt terminal, în același checkout:

```bash
node --env-file=.local-run/hub.env src/manage.mjs enroll --name laptop-1 --out .local-run/laptop1.env
LEVERAGE_WORKSPACE="$PWD" node --env-file=.local-run/laptop1.env src/agent.mjs
```

Deschide manual http://127.0.0.1:8765. Introdu tokenul **operatorului**, consultat privat în `.local-run/hub.env`. Nu îl trimite în conversație, capturi sau Git. Tokenul browserului rămâne în memoria paginii. Oprește procesele cu Ctrl+C. `init`/`enroll` refuză suprascrierea fișierelor private existente; la restart refolosește fișierele, fără o nouă înrolare.

Fișierul Stage 1 `.env` rămâne ignorat și păstrat; noul flux nu îl reutilizează ca secret partajat. Node încarcă explicit fișierele prin `--env-file`, iar variabilele deja exportate au prioritate. `.env.example` conține doar placeholder-uri.

## Dispozitive și permisiuni

Fiecare agent primește UUIDv4 persistent și token independent. Registrul privat `.local-run/agents.json` păstrează numai hash-uri SHA-256 și revocări, în fișier 600/director 700. Nume identice sunt permise. Dashboard-ul afișează UUID, Online/Offline, heartbeat și sesiuni selectate per dispozitiv. Online înseamnă heartbeat în ultimele 15 secunde, nu sănătatea Codex.

Operatorul poate înrola/revoca agenți și folosi dashboard-ul; un agent poate raporta numai propriul UUID și nu poate folosi endpointurile administrative sau vedea inventarul altora. Revocarea persistă după restart și invalidează următoarea cerere. Inventarul și sarcinile DEMO rămân în memorie; agenții refac inventarul după restart Hub.

Ghidul [ETAPA-2-LAPTOP2.md](ETAPA-2-LAPTOP2.md) rămâne documentație pentru descoperirea 2A. Conectarea laptopului 2 și execuția pe alt dispozitiv nu fac parte din această livrare. Hub-ul și destinațiile HTTP ale agentului rămân exclusiv loopback. Nu expune portul pe internet și nu schimba bind-ul în 0.0.0.0.

## Sesiuni Codex și confidențialitate

Agentul încearcă adaptorul oficial App Server pentru codex-cli **0.163.0**, versiunea a cărei schemă a fost verificată local. Sunt permise numai initialize/initialized/thread/list, cu `useStateDbOnly=true`, fără resume, turnuri, tool-uri sau apeluri de model. Alte versiuni/erori folosesc fallback explicit după numele fișierelor; nu presupunem compatibilitate neverificată.

Sunt raportate maximum 40 UUID-uri, timestampuri și opțional un basename validat al proiectului. Nu se transmit căi absolute, transcripturi, preview, titluri, chei sau configurații. Protocolul thread/list poate include preview/name tranzitoriu în memoria procesului/parserului; adaptorul le elimină imediat. Pentru a evita și această procesare tranzitorie, setează `LEVERAGE_SESSION_SOURCE=files`. Cu `LEVERAGE_REPORT_PROJECT=0` omiți etichetele proiectelor.

Toate sesiunile sunt **descoperite, cu activitate neconfirmată**: un App Server nou nu confirmă că o sesiune a altui proces este activă. `updatedAt` este ultima activitate cunoscută din metadatele App Server; `mtime` din fallback se afișează separat, fără a fi prezentat ca activitate. Fallback-ul citește numai nume/stat, maximum 10000 intrări la cinci niveluri, fără conținut JSONL. Numele MCP sunt configurate, fără verificare live.

Configurație agent: `LEVERAGE_AGENT_ID`, `LEVERAGE_AGENT_TOKEN`, `LEVERAGE_DEVICE`, `LEVERAGE_URL` loopback, opțional `LEVERAGE_WORKSPACE`, `LEVERAGE_CODEX_HOME`/`CODEX_HOME`, `LEVERAGE_SESSION_SOURCE=app-server|files`, `LEVERAGE_REPORT_PROJECT=0`. Hub: `LEVERAGE_OPERATOR_TOKEN`, `LEVERAGE_CREDENTIAL_STORE`, `LEVERAGE_HOST`, `LEVERAGE_PORT`. Vechiul `LEVERAGE_TOKEN` este acceptat doar ca token operator pentru tranziție; nu autentifică agenți.

Inventarul 2A descris mai sus rămâne disponibil separat de controllerul local 2B. Detalii istorice: [ETAPA-2A-ARHITECTURA.md](ETAPA-2A-ARHITECTURA.md). Politica locală, selecția și limitările actuale sunt în [ETAPA-2B-LOCAL.md](ETAPA-2B-LOCAL.md). Scrierea, aprobările tehnice și auditul persistent al execuției rămân separate.

## Teste și CI

`npm test` folosește `node --test`, date sintetice și porturi temporare pe 127.0.0.1. Sunt testate și două procese agent reale pe același sistem; aceasta nu verifică fizic laptopul 2 sau tunelul SSH. Sandboxul poate necesita aprobare pentru loopback/subprocese; un blocaj nu reprezintă PASS.

Workflow-ul `.github/workflows/ci.yml` rulează pe push/PR: Ubuntu, Node.js 22, `npm ci`, `npm test`, permisiunea `contents: read`, fără secrete reale. Rezultatele executate sunt în [VERIFICARE.md](VERIFICARE.md), iar operațiunile în [comenzi executate agent.md](<comenzi executate agent.md>). Nu publica `.env`, `.local-run`, credențiale sau configurații personale.

Licență MIT; vezi LICENSE.
