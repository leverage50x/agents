import { workspaceReady } from './local-config.mjs';

/**
 * Safety contract: this prototype never launches a live Codex turn remotely.
 * Per-command approvals cannot currently be forwarded to its dashboard.
 * All queued tasks are explicitly marked DEMO in their results.
 */
export async function runCodexJob(job, env = process.env) {
  if (env.LEVERAGE_ENABLE_LIVE_CODEX === '1') {
    throw new Error('LIVE CODEX BLOCKED: individual command approval forwarding is not implemented.');
  }
  if (!workspaceReady(env.LEVERAGE_WORKSPACE)) {
    throw new Error('LEVERAGE_WORKSPACE must point to an existing readable absolute directory. Git is not required for DEMO.');
  }
  if (!job || typeof job.prompt !== 'string' || !job.prompt.trim() || job.prompt.length > 2000) {
    throw new Error('A demo instruction is required (max 2000 characters).');
  }
  return { threadId: job.threadId || null, output: `DEMO ONLY — no Codex or shell command executed. Would submit a ${job.prompt.length}-character instruction to a local Codex thread.` };
}
