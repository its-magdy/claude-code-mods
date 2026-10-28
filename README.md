# claude-code-mods

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

### Releasing

Each mod's `plugin.json` carries a `version`. Installed copies update only
when it changes, so bump it with every release you push (`0.1.0` → `0.1.1`).
Keep the version in `plugin.json` only, never in `marketplace.json` too.
