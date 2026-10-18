# Leverage50xAgents — instructions for Codex

## Mission and current stage
Leverage50xAgents was renamed from an earlier prototype. Build a personal, local-first developer productivity tool for owned devices, locally discovered Codex session identifiers and configured MCP server names. The operator subsequently requested a real local browser demonstration, a local Git restore point and a security architecture document for ETAPA 2. That preparation is authorized; implementing or enabling remote execution is not.

## Authorized local autonomy
The operator authorized local inspection, code/documentation changes, local dependencies and tests inside this workspace and the sandbox. Do not request APROB for each local command or change. Local demo services may start on loopback. When explicitly asked to start the application for use, they may remain running; report their location and how to stop them. Avoid unnecessary dependencies.

Maintain `comenzi executate agent.md` chronologically with literal executed commands, working directory, exit status, results, errors, modified files and tests. Distinguish execution from proposals, blocks, mocks and unverified integrations. Never invent results or record secrets.

## Restrictions that remain mandatory
- Stay within the workspace and sandbox. Never disable protections or use full-access, auto-approve, never-ask or sandbox-bypass modes.
- Ask separately before sudo, privileged actions, operations outside the workspace, external service/network requests, MCP invocations, Codex jobs, another device, Git commits, remote repository actions or GitHub publication/push. Local dependency authorization does not authorize unrelated network activity.
- Report sandbox blocks. Any permission exception must use the platform's explicit approval flow. This file is not a technical access control.
- Do not expose passwords, keys, tokens, environment contents, auth files, browser state, personal data or session transcripts in output, logs or Git history.
- Never work on employer/client repositories or third-party systems without separately established permission. Do not initialize or publish a repository as an incidental step.

## Application safety contract
- Remain DEMO ONLY. Never launch real Codex, shell commands or MCP tools from dashboard instructions.
- Queued instructions require explicit dashboard approval. Instruction approval is not approval of executable commands.
- Hub and agent are localhost-only in ETAPA 1 and require a long secret. Shared credentials are a demo limitation, not per-device authentication.
- Session filenames do not prove sessions are live or resumable. Configured MCP names do not prove connectivity, health, tools or permissions.
- Keep remote execution blocked, including LEVERAGE_ENABLE_LIVE_CODEX=1. Future activation requires validated event-driven approval mediation, independent per-device authorization and audit records.
- Test inventory with synthetic fixtures. Do not inspect real home-directory configurations or transcripts without separate authorization.

## Technical conventions and stage boundary
Use Node.js >=22, ES modules and `node --test`; prefer built-in modules. Preserve the dashboard structure. Report actual tests and unverified real integrations. Separate per-device authentication, persistent application audit, Codex App Server, live MCP verification and private two-device connectivity belong to ETAPA 2.
