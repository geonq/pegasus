# Pegasus 1.1.0

The backend moves into a Rust host, Pegasus gets a phone, and the core lane was run file by file on
Windows with every failure it found fixed or explained.

## Rust backend host

- `pegasus-host`, one long-lived process per profile behind a typed protocol (schema in Rust,
  TypeScript generated and checked in `pnpm check`).
- Terminals run in the host (ConPTY), batch output every 8 ms and survive a window reload;
  node-pty is gone.
- Git review runs in the host: identical results to the old code, a 2000-file review in 0.5 s
  instead of 1.6 s, nothing on Electron's main thread.
- The remote API for the Mac client and phones is served by the host; calls from one connection
  run in order (this also fixed possible reordering of terminal keystrokes).
- Usage is scanned by the host. Every session is read, however large: on a real 1.8 GB history,
  six sessions over 64 MiB that Usage skipped are now counted, and a refresh takes 0.43 s in the
  host instead of 7.3 s on the main thread.

## Phone

- Settings › Phone pairs an iPhone with a QR code over Tailscale. Each phone has its own token and
  can be revoked; with no phone paired the remote API stays off.
- The iPhone app (`apps/mobile`, Expo, built the T3 Code way) lists chats, streams replies and
  sends messages. It is built from source on a Mac for now.

## New in the desktop app

- Compare models: Shift-click more models in the new-chat picker; the prompt starts once per
  model, each in its own worktree. Ctrl/Cmd+Enter starts a new chat without leaving the view.
- Pull request feedback: the Review header shows the open PR's checks and comments, and sends
  failing checks and review comments to the chat in one click.
- Snooze a chat for an hour or until tomorrow; it returns unread.
- Usage lists plan limits tightest first with a Low badge at 80 % used.
- Code fences in chat are syntax highlighted.
- Windows absolute paths in replies (`D:\repo\src\app.ts:12`) open in the Files panel.

## Fixed

- Dark themes with glass off no longer flash white while resizing on Windows.
- Dialog descriptions (custom endpoints) could collapse to zero height.
- Sidebar folder names and icons now line up with chat titles.
- The active side-panel tab is no longer cut off in the narrowest panel.
- Scrolled up during a reply, the jump-to-latest button now appears: new text was missed while
  the Working row sat last.
