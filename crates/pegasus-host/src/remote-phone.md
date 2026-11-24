# Phone routes (`/v1/phone/*`)

Read-only views for the iPhone app, served by `remote.rs` and computed in `phone.rs`. They relay the
same desktop reads as `/v1/invoke` (`getState`, `getSelectedTranscript`, `getReviewFile`) and cut them
down in the host, so the phone downloads less and does no filtering or patch parsing in JS. The
existing routes stay unchanged; the desktop and the Mac client keep using them.

Gate: exactly like `/v1/invoke`. Allowed Host header, an Origin only when it is allowed (the phone sends
none), `Authorization: Bearer <token>`, no query string. Replies are
`{"version":1,"result":...}` or `{"version":1,"error":{"code","message"}}`, Brotli with
`Accept-Encoding: br` above 2 KB. TS types: `apps/mobile/src/api/phone.ts`.

## Resuming `/v1/events` and sending once

Every event frame carries `id: <host run>-<n>`. A reconnect sends the last one as `Last-Event-ID`;
when the host still logs every frame after it (the newest state plus up to 48 frames / 8 MB, kept
60 s after the client's last stream closed), `ready` says `{"version":1,"resumed":true}` and only the
missed frames follow. Otherwise `resumed` is false and the stream starts with the whole state and
transcript, as before. A new `remote.serve` (Pegasus restarted) drops the logs.

`POST /v1/invoke` takes an optional `Idempotency-Key` (8 to 128 of `A-Za-z0-9._~-`). The first call
with a key reaches the desktop; a repeat within 10 min gets that call's answer without a second call
(the phone sends one key per message, so a double tap or a resent POST cannot send it twice). A failed
call is forgotten, so a retry with its key runs again. The same key with another method or args is
`422 idempotency_key_reused`; a malformed key is `400 invalid_idempotency_key`.

## `GET /v1/phone/chats`

No body. Answers the chat list: `{ etag, revision, projects: [{id,name}], pinnedSessionOrder,
chats: [ChatSummary] }`, newest `lastActivity` first. Same rules as `apps/mobile/src/api/chats.ts`:
archived chats are left out, a settled subagent chat is only counted (`childCount` on its parent),
worktrees fold into their project (`projectId`), `section` is `needs-you | working | recent`,
`needsYou` = a pending dialog or an unseen failure, `unread` = settled with unseen news, `preview`
is at most 160 chars.

`ETag` is a hash of the list only (a revision bump that changes nothing visible keeps it). Send it back
as `If-None-Match: "<etag>"`: an unchanged list answers `304` with an empty body.

## `POST /v1/phone/transcript`

Body `{ workspaceId, sessionId, limit?: 1..200 (default 50), before?: entryId }`. Answers
`{ workspaceId, sessionId, total, start, hasMore, entries }`: the `limit` entries just before `before`
(or the newest ones), oldest first, at most ~512 KB per page (always at least one entry). Entries are
the desktop's transcript items with their stable `id`, so SSE `sessionTranscriptDelta` patches
(append/update/remove by id) merge into the paged list without a download. A tool or activity `detail`
over 8192 chars is cut and gets `detailTruncated: true`; message text is never cut.

Errors: `409 not_selected` when the PC's open chat is another one (call `selectSession` first),
`410 unknown_entry` when `before` was removed (load the newest page again), `400 invalid_request` for
unknown fields.

## `POST /v1/phone/diff`

Body `{ reviewId, fileId, maxBytes?: 4096..1048576 (default 262144) }`. Answers `getReviewFile`'s
result with `patch` replaced by `diff: { files: [{ oldPath, newPath, binary, hunks: [{ oldStart,
oldLines, newStart, newLines, header, lines }] }], truncated, omittedLines }`. `lines` keep their
` `/`+`/`-`/`\` prefix; one line is cut at 4000 chars. Past `maxBytes` of hunk text (structure
included) nothing more is added and `truncated` is true. A review issue (`stale`, `unavailable`,
`failed`) passes through unchanged.

## Measured (tests/host.rs `phone_routes_shrink_the_wire_and_keep_auth`, debug build, Brotli on)

Synthetic desktop: 12 projects x 40 chats, a 2000-entry transcript, a 200-hunk patch.

| Call                         | Wire      | JSON        | Time    |
| ---------------------------- | --------- | ----------- | ------- |
| invoke getState              | 84,042 B  | 619,988 B   | 107 ms  |
| phone/chats                  | 30,764 B  | 195,800 B   | 93 ms   |
| phone/chats, unchanged (304) | 0 B       | 0 B         | 53 ms   |
| invoke getSelectedTranscript | 998,164 B | 4,241,571 B | 1180 ms |
| phone/transcript, newest 50  | 15,657 B  | 64,794 B    | 72 ms   |
| invoke getReviewFile         | 49,833 B  | 216,316 B   | 47 ms   |
| phone/diff (default cap)     | 50,483 B  | 230,721 B   | 78 ms   |
| phone/diff maxBytes 4096     | 1,160 B   | 4,048 B     | 5 ms    |
