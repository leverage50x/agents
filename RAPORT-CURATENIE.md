# Resume și curățenie — Stage 2B, 27 octombrie 2026

Referință inițială: `f4fb6b5debce7defd4b239f9cbcdb5ee4ae58dd4`, branch `stage2b-local-control`, repository PRIVATE [leverage50x/agents](https://github.com/leverage50x/agents). Singura modificare preexistentă era jurnalul; a fost păstrată și inclusă. Main, tagurile, credențialele și configurațiile private nu au fost editate.

## Resume: remediere verificată și limitare reală

**Lifecycle-ul aplicației este reparat. Deblocarea conversației personale rămâne parțială:** aceasta are un proprietar nativ extern real, pe care aplicația nu îl poate înlocui în siguranță.

Pentru sesiunea indicată, `/proc/locks` confirmă FLOCK WRITE al procesului Codex PID **90565**, părinte **15917**, în afara arborelui agentului aplicației. Nu există lease al aplicației pentru workspace sau thread. Lanțul observabil este Codex → Codex → systemd; metadatele nu demonstrează sigur dacă proprietarul este CLI, VS Code sau App Server. Nu au fost citite cmdline/environment/auth/transcripturi, trimise semnale proprietarului ori modificate lock-uri. Verificarea în sandbox ascundea procesele host; constatarea se bazează pe citirea aprobată de platformă, repetată la final.

Agentul existent pornise după commitul inițial: lipsa restartului nu explica acest Busy. Acum sursa controllerului este mai nouă decât agentul pornit, deci **noul patch necesită restart**. Nu s-a repornit instanța personală automat.

Problema confirmată în aplicație era separată: `run.finally` elibera lease-urile proprii, dar păstra App Server și thread-urile încărcate. Codex 0.163.0 păstrează writer lock până la shutdown-ul recorderului, inclusiv după completed/failed și cu stare idle. Închiderea unei conversații sau terminarea turnului nu demonstrează eliberarea procesului care o deține. Documentația [App Server](https://learn.chatgpt.com/docs/app-server) descrie lifecycle-ul; `thread/unsubscribe` nu garantează eliberare imediată și nu a fost adăugat în allowlist.

Remedierea separă procesul persistent pentru `account/read`/`thread/list`, care nu încarcă thread-uri, de workerul de execuție creat pentru fiecare turn confirmat. Workerul este închis și așteptat înainte de eliberarea lease-urilor. Un exit code al wrapperului nu este suficient: se așteaptă evenimentul `close`, inclusiv închiderea pipe-urilor. Dacă aceasta nu se confirmă, `codex-cleanup-unconfirmed` păstrează blocarea. Sunt oprite numai handle-uri create de aplicație.

Erorile de politică/protocol/aprobare/output/clock rămân fatale; crearea unui worker nou nu le poate ocoli. Binding-ul original al workspace-ului este păstrat între workers. Timeouturile de transport ale unui worker nu otrăvesc procesul sănătos de metadate și nu declanșează replay. RPC30s, idle180s și total600s, progresul/partial output și toate restricțiile READ-ONLY sunt păstrate.

## Ce a fost eliminat și simplificat

- Eliminat `listSessionIds`, wrapper fără consumator de producție. Testul duplicat pe el a fost absorbit în inventarul de bază, păstrând scanarea nested, deduplicarea și verificarea că transcripturile nu sunt citite.
- Eliminate implementările duplicate de normalizare a sesiunilor și sortare. UUID/timestamp/proiect/titlu sunt validate prin aceeași proiecție allowlist; câmpurile private sunt excluse. Adaptorul nu mai permite unei pagini mai vechi să suprascrie metadata recentă.
- Eliminate cele două implementări independente de oprire Codex, înlocuite cu `src/codex-child.mjs`, care confirmă ieșirea numai a copilului propriu.
- Eliminate setul `loaded`, eligibilitatea `confirmed` a sesiunii, ramura UI `active-confirmed` și mesajul legacy `session-activity-unverified`. După închiderea workerului, inventarul nu mai pretinde că aplicația deține un thread idle. **`confirmed:true` al instrucțiunii este păstrat.**
- Eliminat al doilea map al sesiunilor din heartbeat; proiecția și eligibilitatea Busy/Discovered sunt calculate o singură dată.
- Eliminat `ownerAlive` din launcher. Verificarea unică a generației păstrează lock-ul dacă metadatele procesului sunt ilizibile; lipsa accesului nu mai este confundată cu ieșirea.
- Unificate tranzițiile de eșec ale joburilor. Update-urile întârziate, corpurile de cerere care traversează TTL și reconectarea fără dashboard poll nu mai pot reînvia un job expirat.
- Înlocuite căutările repetate în lista agenților pentru fiecare dispozitiv cu un Map pe snapshot, de la O(dispozitive × agenți) la O(dispozitive + agenți), păstrând revalidarea revocării.
- Corectat un test launcher fragil: așteaptă expirarea observabilă a heartbeat-ului, în loc de sleep fix. Testul expirării aprobării menține heartbeat-uri, pentru a verifica separat vechimea selecției și deconectarea.

**Fișiere întregi eliminate: 0.** Toate modulele rămase au utilizări de producție sau rol istoric documentat; nu s-au șters fișiere pentru a reduce artificial numărul lor. `src/codex-runner.mjs` și rutele DEMO erau deja eliminate înaintea acestei runde. Nu există cod DEMO actual; referințele istorice, inclusiv tagul Stage1, sunt păstrate.

## Ce a fost păstrat

Autentificarea operator/agent, UUID-urile persistente, revocarea și registrul atomic, inventarul dispozitivelor și sesiunilor, New/Resume cu selecție și confirmare explicită, protecțiile de concurență, launcherul și heartbeat-ul. Filtrul CLI Cwd + Active rămâne neschimbat: surse cli/vscode, nearhivate și workspace autorizat; nu certifică un proces activ.

Arhitectura cu Hub central și agenți separați rămâne disponibilă pentru extindere ulterioară la dispozitive proprii; această rundă nu conectează alte dispozitive. Nu s-au introdus terminal, management de subagenți, DEMO, scriere, MCP live sau autostart. Zero dependențe externe; package.json/lockfile nu necesită dezinstalări. `.gitignore` protejează deja `.env`, `.local-run`, `.codex`, logurile/cache-urile; nu s-au găsit temporare ori credențiale urmărite. Dovezile și backup-urile locale ignorate nu au fost șterse.

## Teste automate și verificări reale

| Verificare | Rezultat observat |
| --- | --- |
| Baseline complet | 153/153 PASS după aprobarea loopback; EPERM inițial este documentat |
| După lifecycle, înainte de curățenie | 160/160 PASS |
| Suita finală după refactoring | **170/170 PASS**, 0 fail/skip/cancel, 7949,680311ms |
| Lifecycle nou | 7/7 PASS: ownership, completed/failed/RPC/idle/total/exit, cleanup neconfirmat, fatal sticky și workspace înlocuit |
| Backend țintit | 52/52 PASS; regresiile lock/TTL eșuau pe codul anterior |
| UI | 19/19 PASS, **DOM simulat**, fără verificare vizuală a browserului |
| Metadata / filenames / adaptor | 6/6, 6/6, 15/15 PASS; fără citirea transcripturilor pentru inventar |
| Sintaxă / whitespace / audit | Verificate înainte de commit; operațiunile și rezultatele sunt în jurnal |

Prima suită finală a avut168 PASS/2 FAIL: testul launcher cu sleep fix și testul expirării aprobării care simula simultan o deconectare. Fixture-urile au fost corectate; protecțiile producției nu au fost relaxate. Verificările refuzate de sandbox și încercările eșuate nu sunt raportate drept PASS.

Proba reală reușită, înainte de extragerea utilitarelor comune, a folosit Hub/agent HTTP reale pe port temporar loopback, Codex 0.163.0 și autentificarea WSL existentă, exclusiv într-un workspace sintetic:

| Scenariu | Rezultat real |
| --- | --- |
| New → completed | 6160ms; răspuns/progres primite și parțial observat prin HTTP |
| Resume pe același ID | 4062ms, completed, markerul anterior recuperat fără includerea lui în noul prompt |
| Eliberare după completed | Alt App Server a dobândit thread-ul, demonstrând release-ul workerului |
| Thread realmente ocupat de acel server | Refuzat cu codex-busy în823ms |
| TUI CLI → dashboard | TUI real într-un PTY privat, `--no-daemon`, exit0; sesiune cli în inventar și Resume completed în4233ms, context păstrat |
| Alt thread în același workspace | Permis în timp ce primul era încă deținut extern |
| Resume după eliberarea externă | Completed în3598ms, context păstrat |

README-ul a rămas identic; nu s-au reluat conversații personale ori înregistrat răspunsurile modelului. Autentificarea a rămas authenticated în toate fazele și niciun copil direct al probei nu a rămas în registrul ei.

După refactoring, proba repetată a confirmat New completed în5969ms, Resume cu context în3440ms, eliberarea workerului și Busy real în1120ms. **Repetarea TUI a atins deadline-ul120s al helperului**, fără confirmarea răspunsului/închiderii grațioase; proba s-a închis cu exit1, iar procesele proprii au fost curățate. Metadatele read-only ale acelui workspace confirmă existența thread-ului cli, dar nu certifică finalizarea turnului. Cauza exactă a acestei încercări TUI rămâne neconfirmată; nu este atribuită aplicației, modelului sau unei cote fără dovezi. Nu se pretinde un al doilea PASS pentru handoff-ul TUI după refactoring.

O încercare anterioară cu `codex exec --thread-source cli` a fost exclusă corect din inventar: `source=exec`, `threadSource=cli` este doar analytics. Codul și metadata locale confirmă distincția; filtrul nu a fost lărgit și source nu a fost falsificat.

Launcherul real, pe o copie izolată a surselor de producție și credențiale sintetice, a trecut start/start/status/logs/stop/status; agent Online la pornire și ambele procese proprii oprite la final. Prima configurație a fixture-ului a fost respinsă pentru chei nepermise; s-a corectat fixture-ul, fără modificarea whitelist-ului aplicației. Instanța personală de pe8765 nu a fost oprită/reporinită. `codex login status` confirmă login-ul existent; nu s-a creat alt login.

## Fișiere și linii

Față de HEAD-ul inițial: **17 fișiere modificate, 3 create, 0 eliminate**. Fișiere create: `src/codex-child.mjs`, `test/codex-lifecycle.test.mjs`, acest raport. Modificările preexistente ale jurnalului sunt incluse și păstrate.

<!-- STATS_START -->
| Domeniu | Linii adăugate | Linii eliminate |
| --- | ---: | ---: |
| docs | 135 | 6 |
| journal | 2116 | 0 |
| source | 203 | 111 |
| tests | 469 | 37 |
| **Total** | **2923** | **154** |
<!-- STATS_END -->

Creșterea netă include noul lifecycle, verificările de securitate, regresiile și jurnalul. Nu se revendică reducerea netă a întregului repository; simplificările eliminate sunt enumerate explicit mai sus.

## Limite și următorul pas

1. Proprietarul nativ extern al sesiunii personale trebuie să elibereze thread-ul prin clientul său original, la alegerea operatorului. Aplicația nu poate forța acest handoff. CLI/VS Code/App Server pot avea durate diferite ale procesului; starea idle nu înseamnă lock liber.
2. Pentru încărcarea noului controller și Hub, când nu există un turn al aplicației de păstrat, rulează manual în rădăcina proiectului:

```bash
./leverage status
./leverage stop
./leverage start
./leverage status
```

Aceste comenzi vizează serviciile proprii launcherului. Restartul lor nu eliberează proprietarul extern al conversației personale. Nu șterge lock-uri și nu folosi killall/pkill.

3. Testează vizual în browser o sesiune sintetică New → Resume și verifică disponibilitatea după handoff-ul normal din CLI. Proba TUI repetată neconcludentă rămâne de investigat separat, fără a interveni în istoricul personal. Nu au fost rulate turnuri reale de10minute; timeouturile lungi sunt verificate sintetic.
4. Păstrează READ-ONLY. Scrierea, aprobările tehnice, auditul persistent și execuția pe alte dispozitive necesită autorizare separată; nu fac parte din această rundă.

## Publicare și închiderea jurnalului

Commitul și push-ul sunt autorizate numai pe `stage2b-local-control`. Raportul și jurnalul se finalizează **înaintea commitului final**; rezultatele ulterioare ale commit/push/GitHub Actions și starea curată vor fi furnizate în răspunsul final, fără completări locale postcommit. Aici nu se inventează un hash ori un rezultat CI încă neexecutat.
