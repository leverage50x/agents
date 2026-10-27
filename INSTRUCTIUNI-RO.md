# Leverage50xAgents — ghid curent pentru control local READ-ONLY

Pe branch-ul `stage2b-local-control`, aplicația oferă inventar și conversații Codex reale, locale, cu acces READ-ONLY. Ghidul complet este [ETAPA-2B-LOCAL.md](ETAPA-2B-LOCAL.md); [README.md](README.md) descrie înrolarea inițială dacă lipsesc credențialele. Main și tagul Stage 1 rămân păstrate.

## Pornire

În Linux/WSL, cu Node.js >=22 și credențialele existente în `.local-run`, rulează din rădăcina proiectului:

```bash
./leverage start
./leverage status
./leverage logs
```

Deschide manual **http://127.0.0.1:8765** și introdu tokenul operatorului, consultat privat în `.local-run/hub.env`. Agentul folosește propriul UUID/token; nu reutiliza tokenul operatorului. Codex folosește autentificarea sa locală existentă, fără copierea fișierelor de login. Dashboard-ul afișează starea autentificării separat de heartbeat.

Launcher-ul nu generează credențiale și nu configurează autostart. Dacă portul este ocupat de alt proces, raportează conflictul fără a-l opri. Logurile launcherului conțin numai evenimente operaționale filtrate; prompturile și răspunsurile Codex sunt afișate în memoria dashboard-ului.

## Inventar și instrucțiune confirmată

1. Selectează dispozitivul pentru inventar. Verifică Online/Offline, ultimul heartbeat, proiectul și ID-ul complet al sesiunii.
2. Pentru control, selectează explicit agentul principal, **New** sau **Resume** și workspace-ul autorizat. Pentru Resume selectează și sesiunea; nu este preselectată automat.
3. Introdu o instrucțiune READ-ONLY, de exemplu: `Analizează README.md și rezumă structura proiectului, fără modificări.`
4. Bifează confirmarea READ-ONLY și confirmă dialogul final. Acest pas autorizează un turn real local cu politica impusă de aplicație.
5. Urmărește progresul, răspunsul și starea finală. Verifică din nou ID-ul și proiectul înaintea fiecărei reluări. Pentru o probă New → Resume folosește o conversație nouă destinată testului.

Lista App Server folosește criteriile implicite `codex resume` pentru versiunea verificată 0.163.0: workspace-ul autorizat, nearhivate și surse interactive CLI/VS Code. Numărul nu este fix. Titlurile provin numai din metadatele oficiale sigure; în lipsa lor apare `Untitled session`, fără fallback pe preview sau transcript. Sesiunile descoperite nu sunt automat reluabile: Busy, activitatea imposibil de verificat, Offline, revocarea sau lipsa autentificării blochează controlul. Numele MCP înseamnă configurare, nu conectivitate verificată.

După o eroare tranzitorie a App Server, agentul inactiv poate reface controllerul cu backoff de 5–30 secunde și reverificarea politicii. Instrucțiunile eșuate nu sunt reluate automat. Dacă indisponibilitatea persistă, consultă status/logs și ghidul 2B; nu șterge autentificarea, sesiunile sau protecțiile.

## Oprire și limite

```bash
./leverage stop
```

Oprirea vizează numai procesele înregistrate, după verificarea identității lor. Scrierea prin Codex, comenzile shell, escaladările, instrumentele cu efecte secundare și execuția pe alte dispozitive rămân blocate. `LEVERAGE_ENABLE_LIVE_CODEX=1` nu activează controlul local. Ghidul [ETAPA-2-LAPTOP2.md](ETAPA-2-LAPTOP2.md) pregătește numai inventarierea privată ulterioară; această livrare nu conectează laptopul 2.

Dezvoltarea locală autorizată și testele se fac autonom în sandbox, conform [AGENTS.md](AGENTS.md) și [CODEX-AUTONOMIE.md](CODEX-AUTONOMIE.md). Autorizările explicite ale sarcinii curente rămân valabile; sudo, schimbările sensibile și publicările viitoare cer autorizare separată. Nu publica `.env`, tokenuri, chei, date personale, transcripturi sau configurații private.

`comenzi executate agent.md` păstrează operațiunile reale și rezultatele, fără secrete. Rapoartele istorice, inclusiv VERIFICARE.md și documentele etapelor anterioare, descriu starea verificată la data lor; nu sunt contractul funcțional al aplicației curente.
