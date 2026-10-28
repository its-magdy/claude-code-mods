# claude-code-mods

[![check](https://github.com/its-magdy/claude-code-mods/actions/workflows/check.yml/badge.svg)](https://github.com/its-magdy/claude-code-mods/actions/workflows/check.yml)

Mods for [Claude Code](https://code.claude.com): each lives in its own folder,
and `.claude-plugin/marketplace.json` lists them so each installs and turns on
or off on its own.

| Mod | What it does |
| --- | --- |
| [image-peek](./image-peek) | See the images you paste instead of just `[Image #N]`. |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install image-peek --marketplace its-magdy/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:
`claude plugin install image-peek --marketplace its-magdy/claude-code-mods`.
In the desktop app: click + next to the prompt box, then Plugins, Add
marketplace with `its-magdy/claude-code-mods`, then Add plugin.

Each mod turns off and on by itself: `claude plugin disable <mod>`,
`claude plugin enable <mod>`.

## Developing

Run a mod straight from its folder; saving a file reloads it:

```
claude --plugin-dir ./image-peek
```

Check it with `claude plugin validate ./image-peek --strict` and `claude plugin test ./image-peek`.
Once Claude Code has loaded a mod from its folder (the command above) it writes
the API types into `<mod>/.claude-plugin/types/` (ignored by git), and
`npx -p typescript tsc -p <mod>` type-checks it.

### CI

[`check.yml`](.github/workflows/check.yml) runs on pushes to `main`, pull
requests, every Monday at 06:00 UTC and on demand:

- **mods:** validates the marketplace and each mod with `--strict`, then runs
  `claude plugin test` on each mod. It runs on Node.js 24 against two Claude
  Code versions: the pinned one the mods were verified on (`2.1.312`), which
  must pass, and `latest`, which only warns.
- **versions:** writes a table to the run summary comparing the pinned Claude
  Code, the Node.js major and TypeScript with their newest releases, and warns
  when Claude Code or Node.js is behind.

After checking a mod on a newer Claude Code release, raise the pin in the
matrix. Keep it first in the list: the `versions` job reads the first entry as
the pin. Dependabot bumps the SHA-pinned actions monthly.

### Releasing

Each mod's `plugin.json` carries a `version`. Installed copies update only
when it changes, so bump it with every release you push (`0.1.0` → `0.1.1`).
Keep the version in `plugin.json` only, never in `marketplace.json` too.

In the same PR, add the version's entry to `<mod>/CHANGELOG.md` under a
`## <version>` heading; `check` fails without it. Once the PR is merged,
[`release.yml`](.github/workflows/release.yml) tags the merge commit
`<mod>-v<version>` and publishes a release with that entry and the install
command as notes. It skips versions that already have a tag, so you can re-run
it from the Actions tab if a release fails.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
