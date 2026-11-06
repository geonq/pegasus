# Pegasus 1.0.22

This local release gives the accumulated 1.0.21 hotfixes a distinct version. The desktop,
workspace root, and website package versions now agree. It uses the main checkout at
`5d197d1`, including child-thread completion reports, child changes in the lead thread's
Review panel, cross-repository Review, and provider IDs in active-run reports.

The accompanying Pegasus ecosystem runtime fixes:

- Project and home skills under `.codex/skills` and `.claude/skills` are accessible while
  adjacent credentials remain protected.
- Ordinary source names such as `local/config.ts`, `auth.sh`, and `credentials-form.tsx`
  are no longer mistaken for credential files by the Mac adapter.
- Windows agent commands use verified PowerShell 7.6.9 LTS inside the existing restricted
  token sandbox. Embedded quotes survive native SSH argument passing. Provision this
  dependency with the ecosystem's `scripts/Install-AgentPowerShell.ps1` before activation.
- Mac project shells discover the current user's login SSH agent for signing, without
  opening private key files. The identity must be loaded into that agent.
- Skill discovery is explicitly distinguished from loading a skill's instructions.
  Persistent workers are instructed to run detached, with bounded progress checks.

Evidence from the DeepLife session identified native SSH quote loss and repeated long
build/simulator waits. The quote loss has a reproducing regression test and a live SSH
check. Simulator hangs and the project's build-agent scripts remain project issues;
this release does not alter DeepLife or Seher.

The Windows SSH server was separately updated to the installed Microsoft-signed 10.0
server. Its live connection negotiates `mlkem768x25519-sha256`; server configuration
and host keys are retained. This is a host update, not part of the app package.

Verification results and installation provenance are retained in the local release
evidence directory. Repository-wide formatting and lint failures inherited from 1.0.21
are reported separately from runtime, package, and real-provider checks.
