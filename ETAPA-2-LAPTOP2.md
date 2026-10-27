# Laptopul 2 — ghid de pregătire pentru inventar privat

Livrarea curentă pe `stage2b-local-control` permite control real READ-ONLY numai pe agentul principal. Acest ghid pregătește o conectare ulterioară a laptopului 2 pentru inventar; comenzile pe alt dispozitiv și transferul credențialelor necesită autorizarea explicită a operatorului. Ele nu sunt executate ca parte a livrării curente.

Comenzile sunt pentru Bash în Linux/WSL, în contul proprietarului. Nu sunt comenzi executate pe laptopul 2 de agentul de dezvoltare. Sunt necesare Node.js >=22, npm, Git și OpenSSH client. Verifică `node --version`, `npm --version`, `git --version`, `ssh -V`. Pentru inventarul App Server verificat este necesar Codex CLI **0.163.0**; alte versiuni fac acest inventar indisponibil. Sursa explicită `files` oferă separat numai nume de fișiere, fără certificarea filtrului CLI. Nu instala sau actualiza Codex doar pentru acest ghid fără verificarea propriului mediu.

Trebuie să existe deja acces SSH autentificat de la laptopul 2 la mediul Linux care rulează Hub-ul, prin LAN sau VPN. Verifică identitatea serverului SSH printr-un canal de încredere. Nu dezactiva verificarea cheii SSH, nu configura port-forwarding public/router și nu modifica firewall-ul ori serviciul SSH ca parte incidentală a acestor comenzi. În WSL, destinația SSH trebuie să ajungă în mediul care poate accesa Hub-ul pe 127.0.0.1. Ghidul nu presupune că acest acces există deja pe dispozitivele tale.

## 1. Laptopul principal: Hub și primul agent

În checkout-ul proiectului, pe branch-ul `stage2b-local-control`, cu credențialele locale existente:

```bash
./leverage start
./leverage status
```

Launcher-ul pornește Hub-ul și agentul principal, fără autostart și fără generarea unor secrete noi. Dacă fișierele lipsesc, urmează întâi înrolarea inițială din [README.md](README.md). Credențialele operatorului și agentului sunt distincte, în fișiere mode600/director privat700. UUID-ul nu derivă din hostname; refolosește fișierul la restart, fără reînrolare. Fișierul Stage 1 `.env` rămâne păstrat și ignorat. Controlul local este descris în [ETAPA-2B-LOCAL.md](ETAPA-2B-LOCAL.md).

Deschide manual **http://127.0.0.1:8765** în browserul laptopului principal. Introdu numai valoarea `LEVERAGE_OPERATOR_TOKEN` din fișierul local `.local-run/hub.env`, consultat privat în editor. Nu lipi fișierul sau tokenul în chat, capturi, jurnale ori Git. Dashboard-ul păstrează tokenul doar în memoria paginii.

## 2. Laptopul 2: pregătirea checkout-ului

În terminalul Linux/WSL de pe laptopul 2, cu acces GitHub la repository-ul PRIVATE:

```bash
git clone --branch stage2b-local-control --single-branch https://github.com/leverage50x/agents.git leverage50xagents
cd leverage50xagents
npm ci
npm test
mkdir -p .local-run
chmod 700 .local-run
git check-ignore .local-run/agent.env
```

Dacă checkout-ul există deja, păstrează modificările locale și actualizează branch-ul prin fluxul Git obișnuit; nu utiliza reset distructiv. Nu este necesară instalarea unor dependențe Node externe.

## 3. Înrolare și transfer privat

Pe laptopul principal, în timp ce Hub-ul rulează:

```bash
node --env-file=.local-run/hub.env src/manage.mjs enroll --name laptop-2 --out .local-run/laptop2.env
node --env-file=.local-run/hub.env src/manage.mjs list
```

Notează UUID-ul laptopului 2 afișat de înrolare/listare. Acesta nu este tokenul. Tokenul este emis o singură dată și salvat direct în fișierul 600; Hub-ul păstrează numai SHA-256. Numele identice sunt permise, UUID-urile rămân distincte.

Transferă **numai** `.local-run/laptop2.env`, printr-un canal autentificat. Dacă există deja SSH de la laptopul principal către laptopul 2 și checkout-ul de mai sus este în directorul home:

```bash
read -r -p 'Destinatie SSH laptop 2 (user@host din LAN/VPN): ' LAPTOP2_SSH
scp .local-run/laptop2.env "$LAPTOP2_SSH:~/leverage50xagents/.local-run/agent.env"
```

Comanda `scp` este un exemplu de rută care trebuie să existe și să fie autorizată de tine; nu trimite fișierul către un host neverificat. Destinația trebuie să fie nouă: scp poate suprascrie un fișier existent. La rotație folosește un nume nou. Dacă există doar ruta necesară laptop 2 → Hub, poți transfera prin acea rută, din checkout-ul laptopului 2, presupunând același director al proiectului în home-ul principal:

```bash
read -r -p 'Destinatie SSH Hub (user@host din LAN/VPN): ' HUB_SSH
if test ! -e .local-run/agent.env; then
  scp "$HUB_SSH:~/leverage50xagents/.local-run/laptop2.env" .local-run/agent.env
else
  printf '%s\n' 'Fisierul exista deja; alege un nume nou pentru transfer.'
fi
```

Alternativ, transferă-l local printr-un mediu privat. **Nu transfera hub.env, registrul agents.json, `.env`, ~/.codex sau credențialele altui agent.** Pe laptopul 2:

```bash
cd ~/leverage50xagents
chmod 600 .local-run/agent.env
git check-ignore .local-run/agent.env
```

Nu rula `cat` sau comenzi care afișează tokenul pentru depanare. Copia privată păstrată pe laptopul principal este și ea o credențială de agent și trebuie protejată.

## 4. Tunel privat și pornirea agentului pe laptopul 2

Terminalul A, pe laptopul 2:

```bash
read -r -p 'Destinatie SSH Hub (user@host din LAN/VPN): ' HUB_SSH
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:18765:127.0.0.1:8765 "$HUB_SSH"
```

Tunelul ascultă numai pe loopback-ul laptopului 2, port 18765. Capătul SSH de pe laptopul principal se conectează la Hub pe loopback 8765. Hub-ul nu trebuie legat de adresa LAN sau 0.0.0.0. Păstrează autentificarea agentului chiar dacă tunelul SSH este autentificat. Dacă politicile SSH permit, limitează cheia dedicată la forwarding către 127.0.0.1:8765; configurarea serviciului SSH nu este efectuată automat de aplicație.

Terminalul B, pe laptopul 2:

```bash
cd ~/leverage50xagents
LEVERAGE_LOCAL_READONLY=0 LEVERAGE_URL=http://127.0.0.1:18765 LEVERAGE_WORKSPACE="$PWD" node --env-file=.local-run/agent.env src/agent.mjs
```

Variabila LEVERAGE_URL din terminal are prioritate față de valoarea din env-file. Agentul folosește local CODEX_HOME sau ~/.codex. Pentru alt director Codex deținut de tine, setează LEVERAGE_CODEX_HOME la o cale absolută. Nu indica directoare ale angajatorului/clientului fără autorizare separată.

Agentul de pe laptopul 2 raportează numai inventar. App Server pe versiunea verificată folosește filtrul de workspace și surse interactive; un inventar filtrat indisponibil nu este completat prin ghicirea transcripturilor. Pentru inventar explicit numai din numele fișierelor, fără proces App Server:

```bash
LEVERAGE_LOCAL_READONLY=0 LEVERAGE_URL=http://127.0.0.1:18765 LEVERAGE_SESSION_SOURCE=files LEVERAGE_WORKSPACE="$PWD" node --env-file=.local-run/agent.env src/agent.mjs
```

Cu `LEVERAGE_REPORT_PROJECT=0` poți omite și etichetele proiectelor. App Server nu primește tokenul de agent/operator din mediu. Laptopul 2 nu primește instrucțiuni de control; numai agentul principal configurat poate executa turnuri reale locale READ-ONLY după confirmarea operatorului. Shell, MCP și scrierea rămân blocate.

## 5. Verificarea manuală

În dashboard-ul laptopului principal verifică două dispozitive separate. În secțiunea Read-only selectează laptop-1, apoi laptop-2: sesiunile trebuie să fie cele raportate de dispozitivul selectat. Verifică UUID-urile, Online/Offline, ultimul heartbeat, sursa inventarului, eticheta proiectului dacă disponibilă și ultimul timestamp cunoscut.

`Discovered only — activity unconfirmed` este rezultatul corect pentru inventarul acestei etape. Un fișier nu dovedește că sesiunea rulează. Un App Server nou nu observă automat activitatea unui alt proces Codex; nu afișăm activitate confirmată pe baza sa. Pentru fallback, mtime este afișat separat de ultima activitate cunoscută. Numele MCP înseamnă doar configurare, nu conectivitate validată.

Oprește agentul sau tunelul de pe laptopul 2 și urmărește trecerea în Offline după cel puțin 15 secunde plus intervalul de refresh al paginii. Repornește folosind același fișier și verifică același UUID. Selecția laptopului 2 servește inventarului; nu îl prezintă ca disponibil pentru controlul local al laptopului principal.

## 6. Oprire și revocare

Ctrl+C în terminalul agentului și în terminalul tunelului de pe laptopul 2. Pentru a revoca tokenul din Hub, pe laptopul principal:

```bash
read -r -p 'UUID agent de revocat: ' AGENT_UUID
node --env-file=.local-run/hub.env src/manage.mjs revoke --device "$AGENT_UUID"
node --env-file=.local-run/hub.env src/manage.mjs list
```

Tokenul revocat primește 401 la următoarea cerere, iar dashboard-ul marchează dispozitivul Revoked/Offline. Revocarea persistă după restart. Procesele agent revocate continuă să reîncerce fără a loga credențiale; oprește-le cu Ctrl+C. Pentru un nou acces după revocare, înrolează din nou, salvează într-un **fișier nou**, transferă-l privat și folosește noile UUID/token; nu reactivezi vechea credențială.

Revocarea aplicației nu revocă o cheie SSH. Dacă vrei să retragi și accesul SSH, gestionează separat cheia dedicată pe serviciul SSH existent. Acest lucru necesită autorizarea ta și nu este executat de aplicație.

## Ce nu a fost verificat fizic

Dezvoltarea și CI folosesc două procese agent cu date sintetice pe un singur sistem. Protocolul Codex poate fi verificat cu un CODEX_HOME izolat. Accesul fizic la laptopul 2, ruta LAN/VPN, serverul SSH și inventarul lui real rămân de verificat de operator, după autorizare. Etapa 2B curentă permite numai controlul real local READ-ONLY al agentului principal; controlul altui dispozitiv și aprobările de scriere rămân pentru o etapă separată.
