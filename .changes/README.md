# `.changes/` — pending changelog entries

Don't edit the `version` in `package.json` or add a `## [x.y.z]` section to
`CHANGELOG.md` yourself. Instead, describe your change in a small file in this
folder. The version number and the changelog section are assigned when the
change is released, so two changes made at the same time never collide on the
same number or conflict in `CHANGELOG.md`.

One file per change, with any unique name ending in `.md`:

```md
---
bump: patch
section: Fixed
---
- Grid bot no longer places a duplicate order after a reconnect
```

- `bump`: `patch` (default for almost everything: fixes, polish, refactors)
  or `minor` (net-new surface: a new page, bot type, integration or public
  API). Several pending files are released together under the largest bump.
- `section`: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or
  `Security`.
- Body: one or more `- ` lines, in the same terse style as `CHANGELOG.md`.
  This text is published as-is, so describe the behaviour, not who was
  affected.

When the change is released, this file is deleted and its lines move into
`CHANGELOG.md` under the new version. A pre-push hook rejects commits that set
a version or add a release header by hand.
