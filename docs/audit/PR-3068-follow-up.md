# PR #3068 audit follow-up: serialize directory migration with downloads and clear

The previous implementation left a live temporary file in the old directory,
then published the new cache directory while the transfer was still active.
The transfer subsequently renamed its data in the old directory but wrote its
CACHED sidecar using the new directory. The content read therefore failed with
ENOENT and the old payload escaped the new directory's accounting and clear.

## Changes

Clear and migration now share a serialized maintenance barrier. Before touching
files, they abort and await all admitted transfers, including checksum and
sidecar completion. New fetches wait outside the ongoing-request map; putting a
waiter in the map would make maintenance wait for a request waiting for itself.
The identity-checked map cleanup from the earlier follow-up is preserved.

Migration resolves its source directory after acquiring the barrier, copies
only complete entries to an exclusive destination, rolls back its own copies
on copy failure, and publishes the destination only after the copy pass. The
copy-first path supports cross-volume destinations and refuses to overwrite an
existing destination cache. Stale temporary files are removed. A failed old-copy
unlink is logged; filesystem permission failures are not claimed to be repaired.
A queued clear runs after migration against the published directory. Content
reads waiting on a completing transfer also wait for maintenance to finish.

## Validation

Four focused scenarios ran using the modified production CacheManager class
transpiled with TypeScript, real temporary filesystem directories, and mocked
Electron/download dependencies: abort cleanup plus replacement admission;
success-path completion; clear queued after migration; and copy-failure rollback
with subsequent requests unblocked. All four passed. Corresponding Jest tests
are added in CacheManager.migration.test.ts.

Full repository Jest, ESLint, type-check, and live Electron/Windows integration
have not run in this environment. Runtime filesystem races with a separate
external process or an OS crash mid-copy are outside these tests.

## Integration and signing

Preserve this barrier and identity cleanup alongside the retry/gateway and
metadata-budget changes in the other open PRs when resolving overlap in
CacheManager.ts. No existing PR history was rewritten. This update is published
unsigned with the owner's permission; the owner will apply their signing workflow.

The upstream GitHub integration denied both Conversation comments and reviews
with HTTP 403. This tracked note retains the full explanation for review.
