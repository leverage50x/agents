# Autonomia Codex în Leverage50xAgents

Politica din [AGENTS.md](AGENTS.md) se aplică agentului principal și tuturor subagenților. Autorizarea explicită rămâne valabilă pentru sarcina curentă; comenzile locale obișnuite nu necesită confirmări repetate. Protecțiile și aprobările impuse de platformă rămân obligatorii.

## Ce se execută autonom

În workspace și în limitele sarcinii: citirea și analiza codului, modificările de cod/documentație, testele și depanarea, verificările sintactice, Git read-only și delegarea. Operațiunile reale, rezultatele, erorile și modificările se centralizează cronologic în `comenzi executate agent.md`, fără secrete sau date personale.

Ștergerile importante, modificările distructive ori de sistem, sudo, accesul sensibil extern și schimbările de autentificare/securitate cer autorizare separată dacă nu sunt deja explicit incluse în sarcină. Push-ul și publicarea cer autorizare pentru sarcina respectivă. Publicarea branch-ului curent `stage2b-local-control` este autorizată; main, tagurile existente și istoricul rămân protejate. Nu se deduce o autorizare pentru alte dispozitive sau sarcini viitoare.

Sunt interzise ocolirea sandboxului, dezactivarea protecțiilor, extragerea credențialelor, force push și ștergerea istoricului fără autorizare separată. Nu se folosesc full-access, auto-approve, never-ask sau moduri de bypass.

## Configurația dezvoltării

Configurația de proiect a fost creată local în `.codex/config.toml` și verificată prin metadatele Codex config/read: workspace-write, on-request, reviewer user, network_access false; originea setărilor este proiectul. Nu au fost schimbate setări globale. Șablonul fără secrete publicat este [codex-project.example.toml](codex-project.example.toml); directorul local `.codex` rămâne ignorat de Git.

Setările agentului care dezvoltă proiectul sunt:

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"
approvals_reviewer = "user"

[sandbox_workspace_write]
network_access = false
```

Configurația proiectului se aplică numai dacă proiectul este de încredere pentru Codex. Cerințele administrate, profilurile și opțiunile CLI pot modifica sau restrânge rezultatul; existența unui fișier nu dovedește configurația efectivă. Configurațiile și regulile globale nu se modifică implicit. `AGENTS.md` este o instrucțiune pentru agent, nu un mecanism tehnic de izolare. Vezi [configurarea oficială Codex](https://learn.chatgpt.com/docs/config-file/config-basic).

Controllerul Codex al aplicației are o politică separată: READ-ONLY, aprobări on-request cu reviewer user, instrumente dezactivate și escaladări respinse. Autonomia agentului de dezvoltare nu acordă dashboard-ului drept de scriere, execuție privilegiată sau control pe alte dispozitive.

## Reguli de prefix propuse — neinstalate

Aceste exemple sunt propuneri pentru evaluare separată. Documentul nu instalează reguli și nu declară că ele sunt active:

```python
prefix_rule(pattern=["git", "status", "--short", "--branch"], decision="allow")
prefix_rule(pattern=["git", "diff", "--check"], decision="allow")
prefix_rule(pattern=["git", "diff", "--cached", "--check"], decision="allow")
prefix_rule(pattern=["node", "--check", "src/agent.mjs"], decision="allow")
prefix_rule(pattern=["node", "--check", "src/launcher.mjs"], decision="allow")
prefix_rule(pattern=["node", "--test", "test/agent-recovery.test.mjs"], decision="allow")
prefix_rule(pattern=["npm", "test"], decision="allow")
prefix_rule(pattern=["git", "push"], decision="prompt")
```

Propunerea `git push` cu `prompt` privește protejarea operațiunilor viitoare; nu anulează autorizarea explicită pentru publicarea branch-ului sarcinii curente. Dacă platforma solicită o aprobare suplimentară, aceasta se respectă.

Regulile sunt prefixe, nu o limitare tehnică la directorul curent. Ele pot influența aprobarea execuției în afara sandboxului și, dacă sunt globale, pot afecta alte proiecte. `npm test` execută scriptul definit în `package.json`, care trebuie verificat. O regulă nu garantează siguranța codului și nu elimină restricțiile platformei. Nu se propun prefixe generice pentru `bash`, `python`, `python3`, `node` sau wrappere shell arbitrare. Vezi [regulile oficiale Codex](https://learn.chatgpt.com/docs/agent-configuration/rules).

Nicio regulă pentru dezvoltarea obișnuită nu autorizează implicit sudo, configurații globale, schimbări de securitate, operațiuni distructive ori publicări viitoare. O aprobare deja acordată se reutilizează numai în limitele ei; un blocaj de sandbox se raportează și se rezolvă prin fluxul platformei.
