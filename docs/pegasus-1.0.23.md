# Pegasus 1.0.23

This release fixes the baseline failures left open in 1.0.22 rather than carrying
them forward as release limitations.

- Apply the pinned formatter and keep text checkouts on LF across platforms.
- Normalize Windows paths in architecture/typecheck diagnostics and test discovery.
- Correct the compiler-contract test's virtual source lookup on Windows.
- Gate updater requests and renderer performance reports on owned main frames.
  One-way reports from foreign, destroyed, or child frames are ignored.
- Handle rejected asynchronous notification callbacks, update cleanup, worker
  termination, and agent cancellation. Interactive answer failures remain visible
  and can be retried.
- Preserve the types of readonly saved-choice answers instead of narrowing them
  through an untyped array check.
- Narrow the PR-review lifecycle event before reading its prompt.
- Make offline GitHub fixtures executable on Windows and explicitly verify the
  fixture selected for the file-based PR integration test.
- Refresh all five example browser bundles and use Pi's cross-platform Bash
  resolver for Linux release-version tests on Windows.
- Remove redundant blank lines between App JSX attributes to satisfy the existing
  file-size guard without weakening the guard or introducing another component.

The skill-access, SSH signing, PowerShell 7 argument preservation, and isolated
worker guidance from 1.0.22 remain included. No failing check is disabled or skipped
to obtain a passing result. Final check results and deployment provenance are
retained with the local release artifacts.
