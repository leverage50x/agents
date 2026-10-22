# Leverage50xAgents — instructions for Codex

## Mission and current stage
Stage 1 is published as v0.1.1-stage1-demo. The operator explicitly authorized Stage 2A on branch stage2-device-discovery: private multi-device discovery, separate revocable agent credentials, read-only Codex session metadata and an SSH tunnel guide. Local implementation, tests, commits and publication of that branch are authorized. Do not modify or merge into main, rewrite history or move the Stage 1 tag. Stage 2B session control and real instruction execution are not authorized.

## Authorized local autonomy
The operator authorized local inspection, code/documentation changes, local dependencies and tests inside this workspace and the sandbox. Do not request APROB for each local command or change. Local demo services may start on loopback. When explicitly asked to start the application for use, they may remain running; report their location and how to stop them. Avoid unnecessary dependencies.

Maintain `comenzi executate agent.md` chronologically with literal executed commands, working directory, exit status, results, errors, modified files and tests. Distinguish execution from proposals, blocks, mocks and unverified integrations. Never invent results or record secrets.

## Restrictions that remain mandatory
- Stay within the workspace and sandbox. Never disable protections or use full-access, auto-approve, never-ask or sandbox-bypass modes.
- Ask separately before sudo, privileged actions, operations outside the workspace, unrelated external requests, MCP invocations, Codex jobs or changes on another physical device. The current Stage 2A request explicitly authorizes Git commits and publication of stage2-device-discovery to the existing PRIVATE leverage50x/agents repository; platform sandbox approvals still apply.
- Report sandbox blocks. Any permission exception must use the platform's explicit approval flow. This file is not a technical access control.
- Do not expose passwords, keys, tokens, environment contents, auth files, browser state, personal data or session transcripts in output, logs or Git history.
- Never work on employer/client repositories or third-party systems without separately established permission. Do not initialize or publish a repository as an incidental step.

## Application safety contract
- Instruction dispatch remains DEMO ONLY. Never launch real Codex turns, shell commands or MCP tools from dashboard instructions. An independently configured local read-only App Server adapter may perform initialize/initialized/thread/list only, with strict version/schema compatibility and no conversation resume, turn or tool requests.
- Queued instructions require explicit dashboard approval. Instruction approval is not approval of executable commands.
- Hub and agent HTTP destinations remain loopback-only. Another owned device connects through an authenticated SSH tunnel over existing LAN/VPN. Operator credentials and each persistent agent UUID/token are separate; revocation must survive restart. Never expose the Hub publicly or reuse an operator token for an agent.
- Session filenames do not prove sessions are live or resumable. Configured MCP names do not prove connectivity, health, tools or permissions.
- Keep remote execution blocked, including LEVERAGE_ENABLE_LIVE_CODEX=1. Future activation requires validated event-driven approval mediation, independent per-device authorization and audit records.
- Test inventory with synthetic fixtures. The current request permits local version/capability and read-only inventory integration checks, but never read or publish transcripts, auth files or raw configuration. Report synthetic two-agent tests separately from physical laptop 2 verification. Do not run PowerShell, Windows executables or automatically launch a browser.

## Technical conventions and stage boundary
Use Node.js >=22, ES modules and `node --test`; prefer built-in modules. Preserve the dashboard structure. Report actual tests and unverified real integrations. Stage 2A stores credential hashes/revocations persistently; device inventory and DEMO jobs remain in memory. Execution approval mediation, session control, persistent execution audit and live MCP verification remain outside Stage 2A.
