# Leverage50xAgents — ghid local pentru ETAPA 1

## Modul de lucru

Deschide întregul director personal leverage50xagents în editor. Dezvoltarea locală, modificările și testele sunt autorizate autonom în limitele sandboxului; nu mai sunt necesare aprobări APROB pentru fiecare comandă locală.

Păstrează protecțiile. Cere aprobare separată pentru sudo, operațiuni externe, MCP, Codex jobs, alte dispozitive, commituri și publicarea pe GitHub. Nu inspecta alte proiecte sau configurații personale din afara workspace-ului fără autorizare. Jurnalul comenzi executate agent.md trebuie să conțină comenzile reale, rezultatele, erorile și fișierele modificate, fără secrete.

Aprobarea instrucțiunilor din dashboard rămâne obligatorie. Ea permite doar o simulare, nu execuția vreunei comenzi.

## Prima probă

1. Verifică Node.js >=22 și rulează npm test din directorul proiectului. Nu sunt necesare dependențe externe.
2. Urmează pașii din README.md pentru secretul introdus ascuns și cele două terminale: npm run hub și npm run agent.
3. LEVERAGE_WORKSPACE trebuie să fie un director personal absolut, existent și lizibil. Git nu este necesar.
4. Deschide http://127.0.0.1:8765 și conectează dashboardul cu același secret.
5. Propune o instrucțiune; observă pending_approval. Fără aprobare nu este livrată.
6. Aprobă DEMO sau respinge. Rezultatul aprobat trebuie să spună DEMO ONLY. Niciun Codex, shell sau MCP nu este executat.
7. Oprește hub-ul și agentul cu Ctrl+C.

Agentul pornit de operator citește configurația Codex locală pentru numele MCP și metadatele fișierelor de sesiune. Nu citește transcripturi și nu confirmă sesiuni active sau conexiuni MCP. Testele dezvoltării folosesc numai fixture-uri sintetice.

## Ce rămâne pentru ETAPA 2

Autentificarea separată a operatorului și a dispozitivelor, auditul persistent al aplicației, aprobările tehnice Codex App Server, verificarea MCP live și conectarea privată a unui al doilea dispozitiv. Nu activa execuția reală și nu expune portul pe LAN sau internet.

Nu publica .env, tokenuri, chei, date personale, transcripturi, configurații private sau proiecte de serviciu. Nu face push fără aprobare. Rezultatele efectiv verificate sunt în VERIFICARE.md; jurnalul dezvoltării nu este un audit al aprobărilor aplicației.
