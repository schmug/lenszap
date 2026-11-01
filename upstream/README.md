# Files from LensPub

These are unmodified copies of files from the [LensPub](https://github.com/schmug/lenspub) specification repository, at the commit named in `LENSPUB_COMMIT`:

| File here | In LensPub |
|---|---|
| `lens-manifest.schema.json` | `schemas/lens-manifest.schema.json` |
| `schema-check.js` | `poc/engine/schema-check.js` |

`npm test` checks that the extension's own copies in `core/` match these. To move to a newer LensPub, run `npm run check-upstream -- /path/to/lenspub`. It reports any difference; add `--update` to copy the files in and record the new commit.

Both files are Apache-2.0, like the rest of this repository.
