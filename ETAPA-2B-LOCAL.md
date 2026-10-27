# Etapa 2B — launcher și control Codex local READ-ONLY

Acest branch este `stage2b-local-control`. Aplicația curentă oferă inventar și control Codex real local READ-ONLY, cu confirmare explicită. Nu conectează laptopul 2 și nu permite execuție pe alte dispozitive sau scriere prin Codex. Main și tagurile istorice rămân neschimbate.

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

O sesiune descoperită este un candidat, nu dovada că poate fi reluată. Resume reverifică inventarul local și dobândește atomic lock-ul nativ exclusiv al thread-ului prin `thread/resume` din Codex 0.163.0. Același ID deținut de alt proces este respins; alte ID-uri din același workspace sunt permise. Se păstrează lease-urile aplicației pe workspace/thread și refuzul unei stări `active` înainte de `turn/start`. Nu se încarcă istoricul în Hub/dashboard; `excludeTurns:true` evită returnarea lui, iar Codex însuși gestionează contextul selectat. Erorile native necunoscute sunt refuzate fără fallback la New sau retry automat.

Lock-ul folosește mecanismul OS din [`rollout/src/writer_lock.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/rollout/src/writer_lock.rs), dobândit înainte de încărcare și păstrat de recorder până la închiderea thread-ului/procesului; vezi [`thread-store/src/local/live_writer.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/thread-store/src/local/live_writer.rs). Protecția privește procesele native compatibile cu același CODEX_HOME; nu se pretinde protecție împotriva clienților necooperanți sau a sesiunilor copiate între home-uri. Versiunile diferite de 0.163.0 rămân blocate până la validare. Aplicația nu mai deduce exclusivitatea din cwd sau accesibilitatea `/proc`; un App Server proaspăt nu oferă inventarul global al proceselor active. Un thread încărcat de aplicație poate rămâne deținut de aceasta între turnuri.

### Folosirea sesiunilor în dashboard

Inventarul și selectorul Resume arată un titlu scurt și timpul relativ (`58m ago`, `2h ago`). Proiectul, ID-ul complet și timpul absolut UTC sunt în detaliile sesiunii. Titlul provine numai din metadatele oficiale `Thread.name`; dacă lipsește sau nu poate fi afișat în siguranță, apare `Untitled session`. Nu se folosește preview-ul conversației și nu se deschide transcriptul pentru un titlu. `Discovered` înseamnă candidat neverificat; `Loaded by this app` înseamnă că aplicația a încărcat sesiunea, cu o nouă verificare obligatorie înaintea fiecărui Resume. `Busy` și dispozitivele Offline, revocate, fără autentificare sau doar cu inventar nu sunt prezentate ca disponibile pentru reluare.

Lista verificată folosește filtrul implicit `codex resume` din versiunea 0.163.0: **Cwd + Active**, cu `cwd` egal cu workspace-ul autorizat, `archived:false`, `sourceKinds:["cli","vscode"]`, sortare după `updated_at` descrescător. Active înseamnă **nearhivat**, independent de `Thread.status` sau de existența unui proces activ. Subagenții, sursele `exec`, `appServer`, necunoscute și sesiunile auxiliare sunt omise. Rândurile sunt reverificate local, deduplicate și paginate, cu maximum 40 de rezultate și indicator de inventar incomplet când este atinsă limita. Numărul nu este fixat la două. Un fallback bazat pe nume de fișiere nu certifică acest filtru; pentru un inventar App Server cu workspace configurat, o eroare produce o listă indisponibilă, fără a ghici din fișiere.

Diferența 8 versus 2 provenea din cererea veche, care includea explicit toate sursele, inclusiv subagenții. Auditul metadatelor `source`/`createdAt`, corelat cu jurnalul precedent, identifica 2 sesiuni VS Code și 6 subagenți create până la acel audit. La verificarea din 26 octombrie 2026 erau 9 în inventarul larg (2 VS Code + 7 subagenți), iar filtrul CLI întorcea cele 2 VS Code. O sesiune auxiliară apărută ulterior explică trecerea la 9; nu a fost introdusă o limită artificială, iar numărul actual poate varia. Sesiunea sintetică creată anterior prin New are tot sursa oficială `vscode` și este eligibilă pentru același filtru în propriul workspace.

Criteriile sunt verificate în sursa oficială Codex 0.163.0 (`tui/src/resume_picker.rs`, `thread_list_params`, testul `remote_thread_list_params_omit_provider_filter`) și în schema generată de CLI-ul instalat. [Referința CLI](https://learn.chatgpt.com/docs/cli/reference) descrie excluderea implicită a sesiunilor neinteractive; [App Server](https://learn.chatgpt.com/docs/app-server) documentează metadatele și `thread/list`. Aplicația păstrează `useStateDbOnly:true`, evitând repararea metadatelor prin scanarea transcripturilor.

Formularul **Local READ-ONLY** creează sau continuă o conversație reală după selectarea explicită și confirmare. Răspunsul și progresul sunt afișate în dashboard pentru instrucțiunea confirmată.

Pentru un test manual, creează întâi o conversație New cu o instrucțiune scurtă fără modificări, așteaptă rezultatul, apoi selectează explicit aceeași sesiune pentru Resume. Verifică ID-ul complet și proiectul înainte de confirmare. Nu selecta o conversație personală doar pentru a testa interfața.

| Mesaj/cod | Semnificație și pas următor |
| --- | --- |
| `codex-busy` | Thread-ul selectat are deja un proprietar activ sau aplicația are un turn în curs. Așteaptă eliberarea lui și reconfirmă explicit; aplicația nu oprește procese externe. |
| `session-activity-unverified` | Cod istoric al verificării `/proc` din versiunea anterioară; controllerul curent folosește lock-ul atomic nativ. |
| `session-unavailable` | Sesiunea nu mai apare în workspace-ul selectat. Actualizează inventarul și verifică selecția. |
| `codex-request-rejected` | App Server a refuzat cererea; nu se creează automat o sesiune înlocuitoare. Verifică starea locală și selectează din nou. |
| `codex-rpc-timeout` | App Server nu a răspuns la cererea RPC în 30s; nu se retrimite cererea. |
| `codex-idle-timeout` | Nu s-a primit activitate pentru turnul curent timp de 180s. |
| `codex-turn-timeout` | Turnul a atins limita totală de 10 minute, chiar dacă mai exista activitate. |

Rezultat istoric din 26 octombrie 2026, înaintea remedierii concurenței: Hub-ul și agentul HTTP reale au creat New, dar Resume era refuzat de euristica `/proc` cu `session-activity-unverified` (EACCES). Launcherul și autentificarea au fost verificate atunci înainte/după stop/start. Acest blocaj nu era dovada unui conflict pe thread.

Verificare reală din 27 octombrie 2026: controllerul de producție cu Codex 0.163.0 și autentificarea WSL existentă a finalizat New în 4,4s și Resume pe același ID sintetic în 5,7s. Resume a recuperat markerul turnului precedent, fără ca acesta să fie inclus în noua instrucțiune; a produs 9 snapshoturi și 5 evenimente de progres. README-ul izolat a rămas identic, fără reluarea conversațiilor personale și fără înregistrarea outputului. Două procese App Server native distincte au verificat conflictul exclusiv pe același ID, acceptarea altui ID în același workspace și transferul după închiderea numai a procesului de test. Sandboxul de dezvoltare a blocat inițial scrierea metadatelor proprii App Server; proba Resume a folosit aprobarea platformei, păstrând politica READ-ONLY și tool-urile dezactivate. Procesele existente ale operatorului nu au fost oprite. Fluxul HTTP/progres/heartbeat și duratele lungi sunt testate automat cu protocol și timp sintetice; nu se revendică o verificare vizuală a browserului sau o execuție reală de 10 minute.

### Progres și limite de timp

Limitele implicite separă răspunsul RPC (30s), lipsa activității turnului (180s) și durata totală după ACK-ul `turn/start` (600s). Un flux de notificări pentru alt thread/turn nu resetează idle; activitatea relevantă de reasoning/items/output prelungește numai idle. Reasoning-ul nu este afișat ori trimis la Hub. Constructorul intern validează plafoane de 30s/600s/1800s pentru RPC/idle/total; dashboard-ul și mediul nu le pot suprascrie.

Finalizarea necesită `turn/completed` cu ID-ul turnului confirmat; notificările sosite înaintea răspunsului RPC sunt corelate pe ID și nu pot fi suprascrise de finalizarea unui alt turn. `item/completed.agentMessage.text` este textul autoritativ, inclusiv când nu există delte. Un item complet sau textul parțial nu certifică succesul turnului. Outputul este redacted, limitat și transmis ca snapshot de înlocuire; un fragment de cuvânt neterminat este reținut până când poate fi filtrat în siguranță. Agentul limitează actualizările la o cerere în curs și combină snapshoturile intermediare, fără să blocheze heartbeat-ul. UI distinge Partial response și Final response. Timeoutul sau întreruperea păstrează parțialul sigur, fără reluare automată.

Incidentul raportat New avea 120,256s și 535 caractere de răspuns la eșec: a atins vechiul plafon absolut de 120s, nu limita RPC de 10s. Codul vechi publica outputul doar la final și păstra un singur slot de completion timpurie, vulnerabil la notificări în altă ordine. Regresiile verifică separat această cursă, outputul final fără delte, timeouturile și progresul; nu se afirmă că acea cursă a fost observată în execuția istorică.

## Politica READ-ONLY și limite

Controllerul trebuie să verifice versiunea/schema și configurația efectivă înainte de turn. Folosește sandbox readOnly, networkAccess=false pentru instrumente, o politică de aprobare care nu ocolește aprobările și refuză cererile de escaladare. Nu sunt expuse thread/shellCommand, command/exec sau process/*, care ar putea ocoli sandboxul. MCP, aplicațiile, browserul și instrumentele cu efecte secundare trebuie dezactivate înaintea unei probe reale.

Modul inițial furnizează modelului un snapshot validat al README-ului și o listă sigură a fișierelor proiectului, păstrând instrumentele dezactivate. Aceasta permite analiza cerută fără a lăsa modelul să citească fișiere private sau să execute shell. Versiunea0.163.0 și catalogul efectiv de instrumente au fost verificate cu un provider sintetic local; prima analiză cu model real a reușit fără schimbarea fișierelor urmărite. Acoperirea exactă și limitările sunt raportate în VERIFICARE.md, nu deduse din simpla autentificare.

Autonomia dezvoltării este documentată în [CODEX-AUTONOMIE.md](CODEX-AUTONOMIE.md). Setările workspace-write ale agentului de dezvoltare nu se aplică controllerului READ-ONLY din dashboard.

Sandboxul modelului nu interzice aplicației să-și păstreze starea proprie: launcher-ul scrie PID/loguri private în `.local-run`, iar Codex își gestionează nativ metadatele sesiunii. Acestea nu sunt permisiuni pentru model de a modifica fișierele proiectului.

Heartbeat-ul continuă pe durata turnului. Revocarea, pierderea transportului sau imposibilitatea validării autorizării închid controllerul activ. Hub-ul marchează jobul eșuat când agentul devine Offline; nu îl reia automat. După o întrerupere verifică status, apoi stop/start și reconfirmă o instrucțiune nouă. Joburile și răspunsurile sunt în memorie, nu într-un audit persistent.

## Ce rămâne separat

Scrierea fișierelor, aprobările tehnice pentru fiecare comandă, auditul persistent al execuției și execuția pe alte dispozitive necesită o etapă autorizată separat. Vechiul LEVERAGE_ENABLE_LIVE_CODEX=1 rămâne blocat; nu este un comutator de activare a acestui flux local. Nu folosi moduri full-access, no-sandbox, never-ask sau auto-approve pentru a rezolva incompatibilități.
