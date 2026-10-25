# Etapa 2B — launcher și control Codex local READ-ONLY

Acest branch este `stage2b-local-control`. Nu conectează laptopul 2 și nu permite execuție pe alte dispozitive sau scriere prin Codex. Instrucțiunile DEMO anterioare rămân separate de noul flux local.

## Pornire și oprire

Din rădăcina proiectului, în WSL/Linux cu Node.js >=22:

```bash
./leverage start
./leverage status
./leverage logs
./leverage stop
```

Launcher-ul reutilizează `.local-run/hub.env`, registrul existent și `.local-run/laptop1.env` (alternativ agent.env/laptop-1.env). Nu generează credențiale și nu suprascrie fișierele. Dacă alegerea este ambiguă, setează LEVERAGE_AGENT_ENV la fișierul propriu din `.local-run`. Directorul trebuie să fie privat, iar fișierele de credențiale mode600. Nu le afișa în conversații, capturi, Git sau comenzi de depanare.

`start` pornește Hub-ul și agentul detașat de terminal. Procesele pot rămâne pornite după închiderea terminalului; nu există autostart la boot. Comenzile simultane sunt serializate prin lock privat și pornirea duplicată este refuzată. Endpoint-ul implicit este **http://127.0.0.1:8765**; hostname-ul/portul provin din configurația existentă și sunt limitate la loopback.

`stop` semnalizează numai PID-urile din registrul launcherului după verificarea UID, startTime, executable, argv și cwd prin /proc. Refuză PID-urile reutilizate sau neconfirmate. Nu folosește killall/pkill. Dacă portul este ocupat de o instanță pornită manual sau altă aplicație, `start` diagnostichează conflictul fără să adopte sau să omoare procesul. Oprește separat vechea instanță din terminalul ei sau după verificarea explicită a identității sale, apoi repetă start.

`logs` afișează numai evenimente operaționale filtrate ale aplicației: pornire, readiness, rollback și oprire. Răspunsurile Codex, prompturile, outputul brut al copiilor și credentialele nu sunt scrise în aceste loguri. Erorile/răspunsurile turnului selectat sunt vizibile în dashboard, în memorie.

## Autentificarea

Dashboard-ul folosește tokenul operatorului din hub.env, consultat privat local. Codex folosește autentificarea sa existentă din WSL; aplicația nu copiază fișiere de login/tokenuri și nu le transmite prin Hub. Dashboard-ul afișează doar Codex authenticated, Not authenticated sau Unavailable.

Verificarea CLI manuală este `codex login status`. Dacă nu ești autentificat, efectuează `codex login` în propriul terminal WSL conform fluxului oficial. Launcher-ul nu pornește login și nu cere parole sau tokenuri Codex în interfață. Un login local confirmat nu dovedește că furnizorul/modelul este momentan disponibil; eroarea unei execuții este raportată separat.

`Online` confirmă heartbeat-ul agentului, separat de sănătatea App Server. După o oprire tranzitorie a App Server, agentul inactiv reconstruiește adaptorul cu backoff de 5–30 secunde și reface verificările de versiune/protocol. Nu reia un turn eșuat și nu redeschide controllerul după revocare, închidere explicită sau încălcarea politicii. Dacă `Unavailable` persistă, verifică `./leverage status`, `./leverage logs`, `codex --version` și `codex login status` în WSL; nu șterge autentificarea sau sesiunile. Raportul [INVESTIGATIE-GIT-CODEX.md](INVESTIGATIE-GIT-CODEX.md) documentează remedierea și limitele verificării VS Code.

## Selecție și prima instrucțiune

În secțiunea Local READ-ONLY, selectează explicit dispozitivul principal, New sau Resume, workspace-ul autorizat și, pentru Resume, ID-ul sesiunii. Nu este preselectat automat niciun thread. Introdu instrucțiunea, bifează confirmarea READ-ONLY și confirmă dialogul final. Primul exemplu autorizat:

```text
Analizează README.md și rezumă structura proiectului, fără modificări.
```

Hub-ul acceptă numai UUID-ul configurat al agentului principal și workspace-ul aplicației. Agentul raportează un binding al căii canonice, fără să trimită calea absolută în UI. Agentul altui dispozitiv nu poate crea, revendica sau finaliza o execuție locală. Nu sunt acceptate câmpuri de comandă, shell, cwd arbitrar sau suprascriere a politicii de sandbox/aprobare.

O sesiune descoperită este un candidat, nu dovada că poate fi reluată. Resume este verificat din nou local înainte de turn/start; sesiunile ocupate, inaccesibile sau din alt workspace sunt respinse. Nu se încarcă istoricul în Hub/dashboard. Contextul sesiunii selectate este gestionat de Codex însuși. Aplicația nu pretinde că un App Server proaspăt poate observa toate celelalte procese; dacă exclusivitatea nu poate fi stabilită, Resume trebuie refuzat conservator. Nu se lansează două turnuri simultane pe același thread.

## Politica READ-ONLY și limite

Controllerul trebuie să verifice versiunea/schema și configurația efectivă înainte de turn. Folosește sandbox readOnly, networkAccess=false pentru instrumente, o politică de aprobare care nu ocolește aprobările și refuză cererile de escaladare. Nu sunt expuse thread/shellCommand, command/exec sau process/*, care ar putea ocoli sandboxul. MCP, aplicațiile, browserul și instrumentele cu efecte secundare trebuie dezactivate înaintea unei probe reale.

Modul inițial furnizează modelului un snapshot validat al README-ului și o listă sigură a fișierelor proiectului, păstrând instrumentele dezactivate. Aceasta permite analiza cerută fără a lăsa modelul să citească fișiere private sau să execute shell. Versiunea0.163.0 și catalogul efectiv de instrumente au fost verificate cu un provider sintetic local; prima analiză cu model real a reușit fără schimbarea fișierelor urmărite. Acoperirea exactă și limitările sunt raportate în VERIFICARE.md, nu deduse din simpla autentificare.

Autonomia dezvoltării este documentată în [CODEX-AUTONOMIE.md](CODEX-AUTONOMIE.md). Setările workspace-write ale agentului de dezvoltare nu se aplică controllerului READ-ONLY din dashboard.

Sandboxul modelului nu interzice aplicației să-și păstreze starea proprie: launcher-ul scrie PID/loguri private în `.local-run`, iar Codex își gestionează nativ metadatele sesiunii. Acestea nu sunt permisiuni pentru model de a modifica fișierele proiectului.

Heartbeat-ul continuă pe durata turnului. Revocarea, pierderea transportului sau imposibilitatea validării autorizării închid controllerul activ. Hub-ul marchează jobul eșuat când agentul devine Offline; nu îl reia automat. După o întrerupere verifică status, apoi stop/start și reconfirmă o instrucțiune nouă. Joburile și răspunsurile sunt în memorie, nu într-un audit persistent.

## Ce rămâne separat

Scrierea fișierelor, aprobările tehnice pentru fiecare comandă, auditul persistent al execuției și execuția pe alte dispozitive necesită o etapă autorizată separat. Vechiul LEVERAGE_ENABLE_LIVE_CODEX=1 rămâne blocat; nu este un comutator de activare a acestui flux local. Nu folosi moduri full-access, no-sandbox, never-ask sau auto-approve pentru a rezolva incompatibilități.
