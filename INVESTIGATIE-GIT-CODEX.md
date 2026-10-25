# Investigație Git și Codex Unavailable — Stage 2B

## Starea găsită înainte de remediere

Investigația din 25 octombrie 2026 a verificat checkout-ul WSL al proiectului, nu interfața VS Code de pe Windows. Branch-ul și upstream-ul erau `stage2b-local-control` / `origin/stage2b-local-control`. HEAD, referința locală origin și rezultatul `git ls-remote` erau identice: `b1e90058ce153bbe5249a6f16143babe4d6dc9e1`. Origin era `https://github.com/leverage50x/agents.git`, repository PRIVATE. Exista un singur worktree.

Înaintea modificărilor acestei remedieri, `git status`, diff-ul față de HEAD și diff-ul față de origin arătau **un singur fișier modificat**: `comenzi executate agent.md`, cu 35 de linii adăugate după commitul anterior. Indexul era gol. Nu existau modificări ale codului, schimbări de mode sau conversii CRLF/LF raportate de Git. Toate cele 47 de fișiere urmărite aveau LF în index și pe disc. Niciun fișier nu era ascuns cu assume-unchanged sau skip-worktree. `core.filemode=true`; `core.autocrlf` și `core.eol` nu erau configurate.

Diff-urile inițiale, statusul și referințele au fost păstrate într-o copie privată ignorată: `.local-run/investigation-backup-CmKzj7`. Nicio modificare locală necunoscută nu a fost eliminată.

## Cele 21 de fișiere din VS Code

Indexul Git conține exact 20 de fișiere cu mode 100755:

```text
.env.example
.gitignore
AGENTS.md
INSTRUCTIUNI-RO.md
LICENSE
PROMPT-CODEX-RO.md
VERIFICARE.md
leverage
package-lock.json
package.json
src/agent.mjs
src/codex-runner.mjs
src/hub.mjs
src/inventory.mjs
src/ui.css
src/ui.html
src/ui.mjs
test/hub.test.mjs
test/inventory.test.mjs
test/runner.test.mjs
```

Un alt mediu Git care vede aceste fișiere fără bitul executabil ar putea raporta 20 de diferențe de mode, plus jurnalul: 21. Aceasta este o explicație posibilă, nu dovada configurației VS Code. README.md are mode 100644 și nu face parte din cele 20; menționarea lui în interfață nu este explicată de această ipoteză. Nu au fost accesate configurațiile Windows și nu au fost rulate executabile Windows.

Această ipoteză a fost reprodusă în Linux într-o copie privată separată a celor 47 de fișiere din index, cu jurnalul local și mode 644 numai în copie: Git a raportat **exact 21 Modified**, fără README. Manifestul per fișier și copia sunt în `.local-run/git-mode-simulation-S4PbVP-manifest.json` și `.local-run/git-mode-simulation-S4PbVP`. Indexul real a fost verificat neschimbat. Aceasta confirmă mecanismul posibil, fără să dovedească mediul folosit de VS Code.

Pentru a stabili cauza exactă în VS Code: verifică în fereastra conectată la WSL repository-ul selectat în Source Control, apoi `Git: Show Git Output` pentru executabilul Git și calea checkout-ului. Compară diff-ul unui fișier precum LICENSE: schimbare de conținut sau doar mode. Folosește Refresh în Source Control și, dacă lista rămâne veche, `Developer: Reload Window`. Compară apoi cu `git status --short` din terminalul WSL al aceleiași ferestre. Nu schimba global `core.filemode` și nu aplica Discard Changes pentru a ascunde o diferență neexplicată.

Referințe: [Git core.fileMode](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefileMode), [VS Code Git Output](https://code.visualstudio.com/docs/sourcecontrol/troubleshooting), [VS Code în WSL](https://code.visualstudio.com/docs/remote/wsl). Nu a fost verificată vizual fereastra VS Code a operatorului.

## Codex: problemă de lifecycle, nu dovadă de logout

Hub-ul și agentul erau Online, dashboard-ul răspundea HTTP 200, dar adaptorul publica authentication/inventory unavailable și zero sesiuni. CLI-ul instalat era `codex-cli 0.163.0`; verificarea privată `codex login status` raporta authenticated. Nu s-a făcut login nou și nu s-au copiat sau șters autentificări, sesiuni ori credențiale.

Proba reală a folosit PATH/HOME și Codex home ale procesului agentului din fundal, după verificarea proprietarului și workspace-ului. Executabilul era disponibil, HOME era corect, iar CODEX_HOME și LEVERAGE_CODEX_HOME nu erau setate: se folosea directorul implicit `.codex`. Cu același mediu, un App Server proaspăt 0.163.0 a răspuns authenticated la account/read și available la thread/list, cu **4 sesiuni** în workspace. Acest rezultat exclude pentru moment un executabil lipsă, un HOME greșit, un login șters sau o incompatibilitate cu versiunea instalată. Au fost afișate numai stări și numere, fără date de cont, ID-uri sau conversații.

Controllerul păstra definitiv promisiunea de pornire și starea de eroare după oprirea procesului App Server. Agentul continua heartbeat-urile, dar nu crea un controller nou. O probă sintetică a reprodus tranziția authenticated/available → unavailable, fără un al doilea proces, după închiderea copilului. În plus, limita de 32 MiB număra tot traficul de la pornire, inclusiv polling-ul normal; putea opri definitiv un proces sănătos după suficient timp. Aceasta a fost reprodusă separat cu trafic sintetic. Logurile vechi nu păstrează cauza inițială a opririi procesului real, deci nu o atribuim fără probe uneia dintre aceste situații.

Remedierea reconstruiește doar controllerul inactiv după erori tranzitorii, cu așteptare de 5, 10, 20 și cel mult 30 de secunde. Noua instanță reface verificările de versiune și protocol folosind același workspace și Codex home. Închiderea explicită, revocarea, refuzul de aprobare și încălcările de politică/protocol rămân închise. Un turn eșuat nu este reluat automat. Limita de trafic este aplicată într-o fereastră de 60 de secunde; limita pe mesaj rămâne în vigoare. READ-ONLY, izolarea dispozitivelor și interdicția execuției la distanță sunt păstrate.

Rezultatele finale ale testelor, integrării reale și publicării sunt în `comenzi executate agent.md`. Nu este necesar un nou turn de model pentru a verifica account/read și thread/list.

După remediere, suita completă a trecut **117/117 teste**, fără erori sau teste sărite. `./leverage stop` a oprit numai procesele deținute de launcher; `./leverage start` a reutilizat configurația existentă. Verificarea aplicației reale după restart: dashboard HTTP 200, agent Online, **Codex authenticated**, inventar cu **4 sesiuni descoperite**, zero confirmate și zero ocupate în acel snapshot. Descoperirea nu certifică posibilitatea de Resume. Nu s-a executat un nou turn de model și nu s-a pretins verificarea vizuală a browserului/VS Code.
