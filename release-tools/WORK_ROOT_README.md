# THEIA Local Workspace

This directory is the single local home for THEIA development and releases.

```text
THEIA/
  source/       Git repository and local development workspace
  releases/     Immutable, versioned release artifacts
  staging/      Builds waiting for validation
```

Rules:

- Develop only in `source`.
- Put new builds in `staging/vX.Y.Z` first.
- Move validated artifacts to `releases/vX.Y.Z`.
- Run `npm run release:index` from `source` after release artifacts change.
- Never place chats, API keys, settings, logs, downloaded avatars, or other private runtime data in `releases`.
- See `source/docs/VERSIONING.md` for the complete workflow.

Generated release indexes:

- `releases/INDEX.md`
- `releases/INDEX.json`
- `releases/SHA256SUMS.txt`
