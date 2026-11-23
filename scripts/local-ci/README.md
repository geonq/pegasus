# Local CI/CD

Pegasus CI runs on the owner's Windows PC. GitHub Actions stays disabled on `geonq/pegasus`, and no
paid service is involved.

## What runs

`run-ci.ps1` checks one exact commit in its own worktree
(`D:\Pi\pi-ecosystem\.state\local-ci\work\pi-gui`). That worktree is reset with
`git checkout --force <sha>` and `git clean -fdx`, keeping only `node_modules`, so
uncommitted files in `D:\Pi\pi-gui` can't make a run pass or fail. Stages run in order and stop at the
first failure:

| Stage   | Steps (only for areas changed since the last green SHA)                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prepare | lock; reset the worktree; `pnpm install --frozen-lockfile` only when the lockfile hash changed                                                                                   |
| static  | desktop: build:shared, prettier, architecture guards, workspace check, eslint (cached), typecheck, example typecheck · mobile: `tsc --noEmit`                                    |
| unit    | desktop: guard tests, package tests, extension examples, release helpers, `tests/unit` (Playwright) · rust: `cargo test -p pegasus-core -p pegasus-host` · mobile: `node --test` |
| build   | iOS compile on the Mac (unsigned, `CODE_SIGNING_ALLOWED=NO`), only when native phone files changed                                                                               |
| deploy  | `apps/mobile/scripts/publish-update.mjs --json`: main only, green only, only when phone files changed, never twice for the same SHA                                              |
| verify  | GET `http://127.0.0.1:47831/v1/updates/manifest` like an iPhone. On a mismatch it runs `--rollback <previous>`, verifies the rollback and fails the run                          |

The area map (which file triggers which check) is `Get-CiAreas` in `lib/LocalCi.psm1`.

## Triggers

- **Gate (pre-push):** `pwsh -File scripts/local-ci/install-hooks.ps1` sets `core.hooksPath` to
  `scripts/local-ci/hooks`. A push of `main` to github.com/geonq/pegasus runs CI for the pushed SHA
  and is blocked when it fails. To bypass once, on purpose, run `$env:PEGASUS_CI_SKIP = '1'; git push geonq main`.
  The bypass is recorded in `history.jsonl`. Undo the hook with
  `git config --unset core.hooksPath`. The gate never deploys.
- **Deploy (scheduled, opt-in):** `pwsh -File scripts/local-ci/install-scheduler.ps1` registers the
  task "Pegasus Local CI". It runs `poll-main.ps1` every 2 minutes, hidden. Remove it with
  `install-scheduler.ps1 -Remove`.
  When geonq/main moved, the task runs CI for the new head and deploys on green. An unchanged main
  costs one `git fetch`.
- **By hand:** `pwsh -File scripts/local-ci/run-ci.ps1 [-Sha <sha>] [-Full] [-Deploy] [-WaitSeconds N] [-SkipIos]`.
  Use `-SkipIos` when the Mac is offline. The run then reports PARTIAL and is not recorded as green,
  so the next run compiles iOS again.

Exit codes: 0 green, 1 a check failed, 2 the runner failed, 3 another run holds the lock.

## Rules it enforces

- **One run at a time:** `runner.lock` is held open and records the PID and start time. A dead
  holder's file is detected by checking that exact PID and start time. A second run exits with code 3,
  or waits when given `-WaitSeconds`.
- **Every step has a timeout:** each step runs in a Windows job object, and a timeout kills its
  whole process tree. A remote iOS build is stopped by its PID file on the Mac. If the runner itself
  dies, Windows closes the jobs and every step process goes with it.
- **Rollback:** `publish-update.mjs --rollback <previousId>` republishes the previous update's
  files under a new, newer id, because iOS only loads updates newer than the one it runs. The rollback
  is verified the same way.
- **Agent sandbox:** under a restricted token (a Pegasus agent), Electron specs get
  `PI_APP_TEST_NO_SANDBOX=1`, the opt-out the specs document. Runs from the owner's terminal, the
  hook or the scheduled task keep the sandbox.
- **Retries:** only infrastructure is retried (git fetch, the copy to the Mac, the manifest GET),
  at most 2 times with backoff, and every retry is logged. A failed test gets one diagnostic rerun. If
  that rerun passes, the test is marked **flaky**, and the run still fails.

## Files (`D:\Pi\pi-ecosystem\.state\local-ci\`)

`status.json` is the last run: SHA, result, steps with durations, flaky tests. `history.jsonl` has one
line per run. `runs\<time>-<sha>\` holds the per-step logs; the last 30 are kept. `last-green.txt`
holds the diff base. `green-shas.txt` lists every SHA that passed. `deployed-shas.txt` and
`last-deployed.txt` keep deploys idempotent. `cache\` holds the install hashes and the cargo target
dir. `scheduler.log` is the poller's log.

## Self-test

`pwsh -NoProfile -File scripts/local-ci/tests/run-tests.ps1` covers change detection, the lock, the
deploy rule, the OTA verdict, timeouts, flaky detection, fail-fast and pruning.
