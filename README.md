# Leverage50xAgents — ETAPA 1, MVP local DEMO

Leverage50xAgents a fost redenumit dintr-un prototip anterior. Aplicația afișează dispozitivul local, numele serverelor MCP configurate și identificatorii descoperiți în fișierele sesiunilor Codex.

**Instrucțiunile sunt numai demonstrative.** Dashboardul cere aprobare sau respingere pentru fiecare instrucțiune. Agentul returnează un rezultat DEMO ONLY; nu pornește Codex, shell sau instrumente MCP. Setarea LEVERAGE_ENABLE_LIVE_CODEX=1 este refuzată explicit.

## Cerințe și verificare

Node.js >=22 și npm. Aplicația folosește numai module Node incluse; nu este necesară instalarea unor dependențe. Directorul de lucru poate fi un director personal existent, fără Git.

Din directorul proiectului:

~~~bash
npm test
~~~

Testele folosesc configurații și sesiuni sintetice. Două teste de integrare deschid porturi temporare exclusiv pe 127.0.0.1; un sandbox care interzice ascultarea poate raporta EPERM. Aceasta nu reprezintă un rezultat PASS. Vezi VERIFICARE.md pentru rezultatele executate efectiv și comenzi executate agent.md pentru jurnal, inclusiv erorile.

## Pornire pe același calculator

Creează într-un manager de parole un secret aleatoriu lung, preferabil 32 octeți reprezentați prin 64 caractere hexazecimale. Nu îl trimite în chat, Git sau jurnal. Hub-ul și agentul folosesc același secret, introdus la promptul ascuns.

Terminal A, în directorul proiectului:

~~~bash
read -rsp 'Token: ' LEVERAGE_TOKEN
export LEVERAGE_TOKEN
npm run hub
~~~

Terminal B, în același director; introdu același secret:

~~~bash
read -rsp 'Token: ' LEVERAGE_TOKEN
export LEVERAGE_TOKEN
export LEVERAGE_DEVICE=laptop-local
export LEVERAGE_WORKSPACE="$PWD"
npm run agent
~~~

Deschide http://127.0.0.1:8765, introdu secretul, propune o instrucțiune și apasă **Approve DEMO task** sau **Reject**. Nici selectarea unui ID existent, nici aprobarea nu creează sau reia o conversație Codex. Oprește procesele cu Ctrl+C.

Comenzile sunt pentru Bash/Linux/WSL. Aplicația nu încarcă automat fișiere .env; variabilele se exportă în terminal. .env.example este doar un șablon, iar .env este ignorat de Git.

## Configurație și inventar

- LEVERAGE_HOST: implicit 127.0.0.1; sunt acceptate numai 127.0.0.1, ::1 și localhost (normalizat la 127.0.0.1).
- LEVERAGE_PORT: implicit 8765, între 1 și 65535.
- LEVERAGE_URL: implicit http://127.0.0.1:8765; numai origine HTTP loopback, fără credențiale, cale, query sau fragment. Redirecționările sunt refuzate.
- LEVERAGE_TOKEN: minimum 24 caractere, fără spații sau caractere de control; folosește un secret aleatoriu.
- LEVERAGE_WORKSPACE: director absolut, existent și lizibil. Starea workspaceReady verifică doar aceste condiții, nu siguranța proiectului.
- LEVERAGE_DEVICE: nume local, maximum 64 caractere. ID-ul demonstrativ derivă din nume; numele identice produc același ID.
- LEVERAGE_CODEX_HOME, apoi CODEX_HOME, apoi ~/.codex: sursa inventarului când operatorul pornește agentul. config.toml este citit local, dar sunt raportate numai numele MCP. Conținutul transcripturilor nu este citit.

Inventarul MCP recunoaște antetele de tabele mcp_servers cu nume simple sau citate; nu este un parser TOML complet și nu validează configurația. Configurațiile peste 1 MiB și fișierele simbolice sunt refuzate. Sunt raportate maximum 100 nume.

Scanarea sesiunilor vizitează maximum 10000 intrări, până la cinci niveluri sub sessions, și returnează maximum 40 UUID-uri distincte, sortate după modificarea fișierului. Nu urmărește intrările simbolice. Dashboardul afișează disponibilitatea inventarului și scanările incomplete. Data modificării și existența unui fișier nu confirmă activitatea sau posibilitatea reluării unei sesiuni.

## Limite și siguranță

Hub-ul și agentul sunt exclusiv locale în ETAPA 1. Nu există autentificare separată pentru operator și dispozitive: toate folosesc aceeași credențială demonstrativă. Un deținător al secretului poate folosi toate endpointurile; aprobarea din dashboard nu oferă separare de roluri.

Dispozitivele devin offline după 15 secunde fără heartbeat. Sarcinile sunt păstrate numai în memorie; nu există recuperare după restart sau după întreruperea unui agent în timpul unei sarcini. Interfața dezactivează trimiterea când hub-ul nu este disponibil sau nu există dispozitive online.

Nu sunt implementate execuția reală Codex, aprobările tehnice ale comenzilor, verificarea MCP live, sincronizarea VS Code, conectarea privată a două laptopuri sau securitatea pentru producție. ETAPA 2 nu a fost începută.

Dezvoltarea locală autorizată se desfășoară autonom în sandbox, conform AGENTS.md. Sudo, operațiunile externe, alte dispozitive, commiturile și publicarea pe GitHub cer aprobare separată. Nu include secrete, date personale, configurații reale sau transcripturi în repository.

Licență MIT; vezi LICENSE.
