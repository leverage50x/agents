# Simplificarea aplicației după Etapa 2C

Baseline: `1f1fda3840c47e215198fc738a70aa77c6d15018`, branch `stage2b-local-control`, working tree curat. Refactoringul păstrează funcționalitățile Etapei 2C; nu este o etapă de extindere a permisiunilor.

## Arhitectura înainte și după

Rămân 17 fișiere de producție și 14 module ESM, fără dependențe externe. Dashboard-ul folosește HTTP către Hub, Hub-ul autentifică separat operatorul și agenții, agentul inventariază dispozitivul și controlează numai Codex local READ-ONLY. Controllerul folosește un proces pentru metadate și un worker temporar pentru fiecare analiză aprobată. Cititorul limitat de repository și transportul de compatibilitate rămân separate de mecanismele Codex native. Launcher-ul verifică și gestionează numai procesele proprii.

Înainte, inventarul simplu și controllerul duplicau paginarea `thread/list`. Acum folosesc un singur algoritm în modulul existent `codex-session-metadata.mjs`. Nu s-a creat alt modul și nu s-a introdus infrastructură. Inventarul continuă să raporteze `partial` pentru metadate eligibile invalide; controllerul păstrează comportamentul anterior de a le omite și decorarea cu Busy/Discovered.

## Eliminări și simplificări concrete

- Două implementări de paginare, filtrare, deduplicare și control al cursorilor au devenit una. Sunt păstrate DB-only, filtrele Cwd/Active, limita de 8 pagini, maximum 100 rânduri pe răspuns, cursorul de maximum 4.096 caractere și maximum 40 rezultate. Inventarul simplu sortează acum înainte de plafon, la fel ca controllerul, și păstrează cele mai recente sesiuni când serverul trimite o pagină neordonată/supradimensionată. O regresie verifică explicit acest caz.
- Secvența Hub/agent din launcher este o singură buclă ordonată: verificare specifică rolului, pornire, persistarea identității, eveniment și readiness. Ordinea, rollback-ul, verificarea ownership-ului și refuzul adoptării serviciilor externe sunt păstrate.
- Agentul folosește un singur traseu de tratare a erorilor transport/HTTP/JSON. Orice eșec din timpul unei execuții închide controllerul; 401/403 rămân fatale și fără execuție activă.
- `boundedText` nu mai serializează fiecare caracter ca JSON și nu mai construiește un array intermediar. Calculează exact costul UTF-8/escaping, apoi returnează un singur segment. Reparația surrogate-urilor și toate plafoanele rămân identice.
- Tabela statică de asseturi Hub nu mai este construită pentru fiecare cerere. Evicția FIFO folosește prima cheie Map, după guard-ul imediat anterior care dovedește că toate joburile rămase sunt terminale; nu mai caută încă o dată un job terminal.
- Computers nu mai repetă preview-ul a opt sesiuni. Păstrează numărul și starea inventarului; lista detaliată selectabilă și Resume păstrează titlul, ID-ul complet, proiectul și activitatea. La reconectarea reușită, controalele nu mai sunt actualizate de două ori.
- Markerul static mereu `true` `CODEX_CONTROL_TOOL_POLICY_VERIFIED` și ramura sa imposibilă au fost eliminate. Verificările reale ale versiunii CLI, politicii returnate, metodelor, aprobărilor și uneltelor sunt păstrate. O verificare TOML de array repetată după return-ul pentru array a fost eliminată.

Nu a fost eliminată nicio funcție numită sau vreun modul întreg: auditul callerilor nu a demonstrat cod mort de acest tip. A fost adăugată o singură funcție comună de paginare în locul celor două blocuri duplicate. Au fost eliminate două callback-uri de căutare/randare redundantă, un catch duplicat, un marker constant și verificările imposibile descrise mai sus. Nu s-au eliminat teste de regresie; s-a eliminat numai aserțiunea pe markerul constant, păstrând testul politicii efective.

## Dimensiune și metodă

Producție = `src/*` + `leverage`; teste = `test/*` + `test-support/*`. Documentația Markdown, jurnalul, configurațiile, licența și artefactele ignorate sunt excluse din producție. Liniile sunt linii fizice, inclusiv comentarii și spații; nu pretindem o măsurare AST a instrucțiunilor. Fișierele CSS/HTML aveau deja linii lungi; nu au fost minificate sau comprimate suplimentar.

| Măsurătoare producție | Înainte | După |
| --- | ---: | ---: |
| Fișiere | 17 | 17 |
| Linii fizice | 3.166 | 3.141 |
| Octeți sursă | 177.757 | 176.427 |
| Module ESM | 14 | 14 |
| Muchii import local | 18 | 18 |
| Module built-in distincte importate | 13 | 13 |
| Dependențe externe / devDependencies | 0 / 0 | 0 / 0 |

Reducere: **25 linii (0,79%) și 1.330 octeți (0,75%)**. Reducerea este modestă: baza fusese deja curățată, iar o parte importantă din cod impune limite, izolare și lifecycle. Nu s-a sacrificat claritatea sau securitatea pentru un procent mai mare. Agentul are patru linii suplimentare pentru algoritmul mai eficient și explicația sa.

<!-- CATEGORY_METRICS -->
| Categorie | Fișiere înainte / după | Linii înainte / după | Octeți înainte / după |
| --- | ---: | ---: | ---: |
| Surse producție | 17 / 17 | 3166 / 3141 | 177757 / 176427 |
| Teste + suport | 20 / 20 | 5054 / 5128 | 278230 / 282085 |
| Documentație Markdown fără jurnal | 12 / 13 | 877 / 1002 | 108425 / 122557 |
| Jurnal operațional | 1 / 1 | 11484 / 12224 | 606274 / 652652 |
| Configurații + licență | 7 / 7 | 115 / 115 | 3644 / 3644 |
<!-- END_CATEGORY_METRICS -->

## Performanță măsurată

Comparația diferențială cu funcția originală `boundedText` a trecut **3.670.061 cazuri**, inclusiv Unicode, escaping JSON, surrogate-uri și limite de octeți. Funcția măsurată a fost extrasă exact din sursa finală, fără export/hook adăugat în aplicație. Nouă probe alternante pentru fiecare set, după încălzire:

| Set sintetic | Invocări/lot | Mediană înainte | Mediană după |
| --- | ---: | ---: | ---: |
| ASCII scurt | 10.000 | 28,703 ms | 1,910 ms |
| ASCII output | 500 | 350,244 ms | 24,991 ms |
| JSON escaping | 500 | 145,193 ms | 14,319 ms |
| Unicode | 500 | 202,116 ms | 14,009 ms |
| Surrogate-uri izolate | 500 | 252,043 ms | 19,079 ms |

Rezultatul **10,14–15,03×** se referă exclusiv la funcția izolată, nu la aplicație sau inferența modelului. Reducerea reconstrucției tabelei statice și a randării duplicate este vizibilă în cod, dar nu primește o afirmație numerică de performanță fără benchmark dedicat.

<!-- STARTUP_BENCHMARK -->
Benchmark pe copii izolate ale surselor baseline/finale: Hub și agent reale, credențiale sintetice, Codex indisponibil intenționat, Node.js 22.23.3. Șase perechi alternante, după un warmup exclus per versiune. Pornire = lansarea CLI `start` până la ieșirea cu readiness confirmat; copierea surselor și crearea credențialelor sunt excluse. RSS = suma VmRSS Hub + agent la 500 ms după readiness; include pagini partajate, nu este memorie fizică unică.

| Măsurătoare | Înainte | După |
| --- | ---: | ---: |
| Pornire mediană | 397,470 ms | 393,487 ms |
| Interval pornire | 391,040–400,103 ms | 389,707–407,587 ms |
| RSS cumulat median | 138.506 KiB | 140.136 KiB |
| Interval RSS | 131.160–140.248 KiB | 131.112–140.380 KiB |

**Nu rezultă o îmbunătățire demonstrată a pornirii sau memoriei**: intervalele se suprapun, iar RSS variază circa 9 MiB. Scenariul nu măsoară pornirea/inferența Codex autentificat. Manifestul surselor AFTER este identic cu sursele finale; toate procesele benchmark-ului au fost oprite verificat și fixture-urile proprii eliminate. Serviciile personale nu au fost atinse.
<!-- END_STARTUP_BENCHMARK -->

## Teste și verificări reale

Baseline: **204/204 PASS**, 6,596 s. După toate loturile: **208/208 PASS**, 7,533 s, fără teste omise/anulate; 34 module au trecut verificarea sintaxei. Timpii suitei nu sunt benchmark de performanță. Verificări intermediare: 102 teste Codex/reader, 34 apoi 47 Hub/agent, 15 launcher și 22 UI, toate PASS. Cazurile se suprapun; nu se adună pentru a inventa un total.

Cele patru regresii noi acoperă pagina de inventar neordonată/supradimensionată, erorile de rețea/JSON, limitele exacte ale textului transmis și rollover-ul istoricului Hub cu protejarea joburilor queued/running. UI existent verifică eliminarea preview-ului fără pierderea metadatelor din lista detaliată. Politica READ-ONLY, autentificarea/revocarea, cititorul, timeouturile, procesele concurente și cleanup-ul au toate regresiile anterioare păstrate.

<!-- REAL_VALIDATION -->
Verificarea **post-refactoring**, cu Hub HTTP, agent, Codex 0.163.0 și model reale, a folosit numai repository-uri și conversații sintetice noi. Autentificarea existentă a fost confirmată; nu au fost copiate credențiale, citite transcripturi personale sau oprite procese personale.

Prima rulare (141,978 s, exit 1) a confirmat:

- New → completed în 70,388 s: 12 cereri, 7 fișiere reale, 941 octeți. Au fost citite `src/main.mjs`, `src/math.mjs`, `src/display.mjs`, `package.json`, `test/math.test.mjs`, `.github/workflows/ci.yml`, `README.md`; au fost identificate funcția `dormantFormat`, duplicarea `sum`/`sumAgain` și liniile relevante. Căile citate existau în fixture.
- Resume → completed în 31,472 s, același ID și context păstrat, două recitiri.
- `.env`, `.local-run/private.json`, traversarea în afara workspace-ului și symlink-ul: patru refuzuri, zero octeți, fără expunerea sentinelului privat.
- Thread deținut de un App Server propriu testului: refuz `codex-busy`, fără forțarea proprietarului.

Rularea s-a oprit la construirea unei sesiuni auxiliare legacy: un turn nativ a ajuns `failed` fără un cod diagnostic disponibil în rezultatul controllerului. Nu este raportată drept PASS integral și nu atribuim eșecul unei cote, autentificării sau refactoringului fără dovezi. Cleanup-ul a închis toate procesele proprii. Rezultatul inițial a fost păstrat.

Au fost reluate **numai fazele rămase**, într-un fixture nou (139,861 s, exit 0):

- Construirea sesiunii legacy a reușit, fără modificări suplimentare ale codului de producție.
- Resume legacy → completed în 99,179 s, 12 continuări limitate, șapte fișiere citite, același ID și context păstrat.
- Busy real a rămas protejat, iar o altă sesiune din același workspace a putut fi folosită.
- Resume după eliberarea proprietarului propriu → completed în 27,541 s, cu citire reală a importurilor.
- Plafonul de turn redus la 50 ms în helper a produs `codex-turn-timeout`, cu workerul propriu închis. Limitele implicite lungi sunt acoperite sintetic, nu printr-o inferență de zece minute.
- Hash-urile tuturor celor nouă fișiere originale ale fixture-ului suplimentar au rămas identice; zero procese proprii rămase.

Eșecul nativ inițial nu s-a reprodus; cauza lui rămâne neidentificată. Nu a fost relaxată nicio politică pentru rerulare. UI a fost verificat prin teste VM/DOM, nu vizual într-un browser. Rezultatele istorice Etapa 2C sunt păstrate separat de aceste probe noi.
<!-- END_REAL_VALIDATION -->

## Ce s-a păstrat și de ce

- Cele două transporturi App Server au scopuri diferite: inventar scurt și controller persistent cu turnuri. Unificarea întregului protocol ar amesteca deadline-uri, erori și permisiuni; s-a extras numai algoritmul comun demonstrat.
- `codex-child` este folosit de ambele transporturi; `local-config` și metadatele sesiunilor au mai mulți consumatori. `repository-tools` separă protocolul de cititorul de filesystem. Comasarea arbitrară nu ar elimina logică.
- Validările Hub/agent/controller, reverificarea revocării după `await`, verificările PID/generație/UID/comandă și cele descriptor/path/inode protejează momente și granițe diferite. Nu sunt duplicate eliminabile.
- READ-ONLY, version pin, politica fără escaladare, blocarea configurațiilor ambientale, limita de output, preflight-urile și transportul legacy Resume rămân obligatorii.
- Inventarul filename-only, înrolarea/revocarea, compatibilitatea configurației operatorului și documentația istorică au utilizatori reali. Nu au fost șterse credențiale, sesiuni, rapoarte istorice sau configurații private.
- Mutarea validării tokenului înaintea încărcării registrului ar schimba diagnosticul unui registru corupt; nu a fost aplicată pentru un câștig I/O nemăsurat.

## Limite și recomandări

Nu există reducere demonstrată globală de CPU/RAM. Algoritmul comun poate păstra temporar cel mult 139 de metadate când serverul supradimensionează o pagină, comportament deja posibil anterior în controller; nu se revendică economie de memorie pentru acest caz. Ieșirea rămâne plafonată la 40.

Rămân limitările documentate în [ETAPA-2C-READONLY.md](ETAPA-2C-READONLY.md): versiunea verificată 0.163.0, configurație locală stabilă, recunoaștere conservatoare dar incompletă a datelor confidențiale și răspuns afișat limitat, cu semnalizare. Nu s-au introdus drepturi de scriere, terminal, DEMO sau controlul altor dispozitive.

Pentru simplificări ulterioare, măsurați mai întâi workload-uri reale și păstrați testele de frontieră. Nu recomand un framework sau rescrierea controllerului doar pentru reducerea numărului de fișiere. Serviciile personale existente nu sunt folosite pentru benchmark și nu sunt repornite în această rundă; încărcarea backend-ului actualizat se poate face cu `./leverage stop`, `./leverage start`, `./leverage status` după terminarea joburilor aplicației.

Jurnalul este finalizat înainte de commit. Hash-ul publicat, CI și sincronizarea sunt raportate operatorului după verificare, fără completări postcommit în repository. Main și tagurile istorice rămân protejate.
