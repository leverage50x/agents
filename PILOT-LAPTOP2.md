# Pilot: laptopul principal + agent WSL pe laptopul 2

Branch: `pilot-laptop2`, pornit din `2665aee` de pe `stage2b-local-control`. Există un singur Hub, pe laptopul 1. Laptopul 2 rulează același agent Node în mod **inventory-only**, cu metadate Codex autentificate local. `./laptop2` reutilizează launcher-ul existent și nu pornește Hub sau dashboard.

## Ce este disponibil

Dashboard-ul arată separat UUID, Online/Offline, ultimul heartbeat, starea Codex, sesiunile filtrate Cwd + Active și workspace-ul declarat local. Workspace-ul este configurat pe laptopul respectiv; Hub-ul primește numai aliasul `project` și o etichetă, nu calea absolută. Acest inventar nu este o autorizare de execuție.

**New/Resume pe laptopul 2 rămân blocate.** Controlul principal continuă să funcționeze cu confirmare explicită. Hub-ul actual acordă execuția numai UUID-ului principal și hash-ului workspace-ului său. Acceptarea aceleiași capabilități din heartbeat-ul unui alt agent ar permite autoautorizare. Următorul pas necesar este o autorizare acordată de operator pentru fiecare pereche dispozitiv/workspace, legarea aprobării la versiunea acelei autorizări și invalidarea joburilor la schimbare/revocare. Pilotul nu înlocuiește această verificare cu încredere în eticheta raportată de agent.

## Cerințe pe laptopul 2

Windows 11 cu **WSL2 Ubuntu deja instalat**, Node.js >=22, npm, Git și client OpenSSH. Rulează comenzile în Bash/Ubuntu, într-un director Linux, precum `~/leverage50xagents`. Nu folosi executabile Windows sau checkout în `/mnt/c`. Acest pilot nu instalează WSL, servicii SSH, firewall sau pachete privilegiate. Dacă Git/SSH lipsesc, pregătește-le prin procedura administrată a laptopului înainte de pilot; scriptul verifică și raportează lipsurile. Cu `nvm` deja instalat, Node poate fi pregătit în contul propriu cu `nvm install 22 && nvm use 22`.

Este necesară ruta SSH autentificată **laptop 2 → mediul Linux al Hub-ului**, prin LAN/VPN existent. Un server SSH Windows care nu ajunge la loopback-ul WSL al Hub-ului nu este suficient. Dacă această rută nu există, oprește setup-ul aici; nu expune porturi și nu modifica automat sistemul. Verifică cheia serverului SSH printr-un canal de încredere.

## 1. Laptopul 1: actualizare și înrolare

După salvarea modificărilor locale și terminarea joburilor aplicației, în checkout-ul principal:

```bash
git switch pilot-laptop2
git pull --ff-only
./leverage stop
./leverage start
./leverage status
node --env-file=.local-run/hub.env src/manage.mjs enroll --name laptop-2 --out .local-run/pilot-laptop2.env
```

Înrolarea scrie tokenul revocabil într-un fișier nou 600, fără să-l afișeze. Dacă fișierul există deja, reutilizează-l; nu reînrola inutil și nu îl suprascrie. Nu modifica configurația privată a laptopului 1. Dashboard: http://127.0.0.1:8765, cu tokenul operatorului consultat privat în `hub.env`.

## 2. Laptopul 2: cod și Codex local

Cu acces propriu la repository-ul PRIVATE:

```bash
git clone --branch pilot-laptop2 --single-branch https://github.com/leverage50x/agents.git ~/leverage50xagents
cd ~/leverage50xagents
npm ci
./laptop2 check
```

Pentru un checkout existent păstrează schimbările locale și folosește `git pull --ff-only` pe branch-ul pilot. Nu folosi reset/clean. Nu există dependențe npm externe ale aplicației; este folosit același checkout pentru versiuni reproductibile, dar nu se pornește al doilea Hub.

Adaptorul este verificat strict cu **Codex CLI 0.163.0**. Nu actualiza sau înlocui automat Codex-ul existent. Dacă lipsește sau este incompatibil, poți instala copia verificată numai în proiect, fără modificarea instalării globale:

```bash
mkdir -p .local-run
chmod 700 .local-run
npm install --prefix .local-run/codex-cli --no-save --package-lock=false @openai/codex@0.163.0
export PATH="$PWD/.local-run/codex-cli/node_modules/.bin:$PATH"
./laptop2 check
```

Instalarea locală și exportul PATH sunt necesare numai în acel caz; refă exportul în terminalele noi când folosești această copie. `check` verifică Node, Git, versiunea Codex și `codex login status`; consumă diagnosticele în memorie și afișează numai rezultate sigure. Nu execută login sau browser.

Pe laptopul 2, verifică explicit:

```bash
codex login status
```

Dacă nu este autentificat, rulează **tu**, în WSL pe laptopul 2, `codex login`, apoi `./laptop2 check`. Folosește login-ul ChatGPT existent când este disponibil; nu este necesară o cheie API pentru acest flux. [OpenAI Docs: autentificare CLI](https://learn.chatgpt.com/docs/cli/reference#codex-login). Nu copia `.codex`, `auth.json`, tokenuri Codex, chei SSH sau istoricul conversațiilor de pe laptopul 1. [`WSL` în documentația oficială](https://learn.chatgpt.com/docs/windows/wsl).

## 3. Laptopul 2: propria configurație privată

Transferul folosește SSH-ul deja autorizat, către același cont care rulează Hub-ul. Presupune checkout-ul principal în `~/leverage50xagents`; adaptează numai calea sursă dacă diferă:

```bash
cd ~/leverage50xagents
umask 077
mkdir -p .local-run
chmod 700 .local-run
read -r -p 'SSH Hub (user@host din LAN/VPN): ' HUB_SSH
if test ! -e .local-run/agent.env; then
  scp "$HUB_SSH:~/leverage50xagents/.local-run/pilot-laptop2.env" .local-run/agent.env
fi
chmod 600 .local-run/agent.env
git check-ignore .local-run/agent.env
```

Se transferă **numai credențiala aplicației pentru laptopul 2**. Nu transfera `hub.env`, `.env`, `agents.json` sau credențiala laptopului principal. Dacă SSH/scp eșuează, rezolvă ruta; nu crea un fișier de token improvizat.

Completează o singură dată configurația pentru workspace-ul pe care îl autorizezi local. Acest exemplu alege checkout-ul proiectului:

```bash
node --input-type=module <<'JS'
import fs from 'node:fs';
const file = '.local-run/agent.env';
fs.appendFileSync(file, '\nLEVERAGE_URL=http://127.0.0.1:18765\nLEVERAGE_WORKSPACE=' + JSON.stringify(fs.realpathSync('.')) + '\n');
JS
```

Poți alege altă cale absolută deținută și autorizată de tine prin editarea privată a `LEVERAGE_WORKSPACE`. Pentru un CODEX_HOME personal diferit, adaugă local `LEVERAGE_CODEX_HOME` cu acea cale absolută. Nu adăuga tokenul operatorului. Nu este nevoie să adaugi flag-uri READONLY/METADATA: launcher-ul forțează inventarul autentificat și blochează execuția. Modificările config se încarcă după `stop`/`start`.

## 4. Tunel și pornire

Pe laptopul 2, tunel persistent în fundal, cu socket de control privat (nu autostart):

```bash
cd ~/leverage50xagents
ssh -M -S "$PWD/.local-run/hub-ssh.sock" -fNT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:18765:127.0.0.1:8765 "$HUB_SSH"
./laptop2 check
./laptop2 start
./laptop2 status
```

Nu refolosi/suprascrie un socket de control existent fără să verifici conexiunea sa. SSH păstrează verificarea cheii serverului. Portul 18765 există numai pe loopback-ul laptopului 2; capătul SSH trebuie să ajungă la Hub-ul 127.0.0.1:8765. Nu există shell/comandă remote prin această comandă SSH (`-N`). Nu sunt modificate porturi publice sau reguli firewall.

Agentul rămâne pornit după închiderea terminalului. `start` previne duplicatele, refuză adoptarea unui agent extern și așteaptă heartbeat autentificat. `status` distinge procesul propriu de heartbeat-ul confirmat de Hub; poate arăta proces pornit, dar Offline când tunelul cade. Tokenul/fișierul Codex nu sunt trimise la Hub. Un singur workspace este configurat per agent în pilot.

## 5. Demonstrație și oprire

În dashboard-ul laptopului 1 selectează succesiv cele două dispozitive în lista de inventar. Verifică UUID-uri distincte, heartbeat, Codex authenticated/Not authenticated/Unavailable, etichetele workspace-urilor și sesiunile proprii. Lista goală este corectă dacă nu există sesiuni interactive nearhivate în workspace; nu se inventează sesiuni. Laptopul 2 rămâne inventory-only în formularul de control.

Pe laptopul 2:

```bash
./laptop2 stop
./laptop2 status
ssh -S "$PWD/.local-run/hub-ssh.sock" -O exit "$HUB_SSH"
```

`stop` oprește exclusiv agentul propriu verificat prin PID, UID, start-time, executabil, comandă și cwd. Nu oprește Codex personal sau Hub. După cel puțin 15 secunde plus refresh, laptopul 2 apare Offline; reconectarea cu aceeași configurație păstrează UUID-ul. Pentru revocare, pe laptopul 1:

```bash
read -r -p 'UUID laptop 2 de revocat: ' AGENT_UUID
node --env-file=.local-run/hub.env src/manage.mjs revoke --device "$AGENT_UUID"
```

Revocarea persistă după restart; următoarea cerere primește 401, iar agentul închide propriul client metadata. Oprește procesul cu `./laptop2 stop`. Pentru reînrolare folosește o credențială nouă și un fișier nou; nu reactivezi tokenul revocat. Revocarea aplicației nu revocă cheia SSH.

## Verificarea livrării

Baseline:208/208PASS. Verificarea finală: **224/224 PASS**,0fail/skip/cancel,7,116s. Sunt păstrate regresiile New/Resume, lock-uri, timeouturi, autentificare și cititorul Etapei 2C. Testele noi acoperă două identități independente, nume identice, heartbeat simultan, izolarea sesiunilor/workspace-urilor, self-status fără privilegii administrative, reconectare cu același UUID, Offline, token invalid, revocare persistentă și refuzul escaladării prin capabilități falsificate. Testele launcher-ului verifică exclusiv propriile procese, duplicate, token revocat, fișiere private și absența Hub-ului pe agent-only. UI este verificat în VM/DOM, nu vizual.

Pe WSL-ul disponibil, `./laptop2 check` a confirmat Node22.23.3, Git disponibil, Codex0.163.0 și login authenticated, fără afișarea contului. O probă nativă separată a pornit **două procese agent-only**, în copii izolate cu UUID/token/workspace-uri distincte, și un singur Hub sintetic pe 127.0.0.1. Ambele procese au folosit același login Codex existent pe acest laptop, numai pentru account/read și thread/list: authenticated, inventory available,0sesiuni în fiecare workspace nou, fără turnuri sau copiere de auth. Duplicate start a refolosit procesele proprii, iar stop a închis toate procesele de test. Sesiunile distincte din testele cu două dispozitive sunt metadate simulate; proba nativă nu a fabricat conversații doar pentru inventar.

Erori reale remediate în teste: returnarea PID-ului Hub nul în agent-only și diagnosticul pentru URL nepermis; o așteptare greșită a testului pentru workspace:null a fost corectată. Nu s-au relaxat verificările de ownership sau securitate. Check refuză executarea pe Windows nativ; cazul Node18 a fost verificat prin VM, nu printr-o instalare Node18 reală.

Testele cu două identități pe același sistem nu demonstrează acces fizic la laptopul 2, autentificarea lui proprie, conectivitatea LAN/VPN sau ruta SSH WSL de pe dispozitivul tău. Controlul secundar și testul New → Resume pe acel agent nu sunt implementate în pilot; acesta este blocajul arhitectural descris la început, nu o execuție verificată pe alt calculator.
