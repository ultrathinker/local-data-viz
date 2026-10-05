# Contributing

Thanks for looking. This plugin is small on purpose: a skill, a command, a dependency-free Node script and one static page. Please
keep it that way: no runtime packages, no network access, nothing that writes outside the new folders it creates.

## Development setup

Node 18 or newer, and the DuckDB command-line tool on the `PATH` (or `LOCAL_DATA_VIZ_DUCKDB` pointing at it). There is nothing to
install with npm.

    node --test tests/*.test.mjs

Tests use synthetic data only and never touch the network. Tests that need DuckDB are skipped, with a note, when it is not
installed. The page tests also need Chrome or Edge (set `LDV_BROWSER` to the program if it is not found) and Node 22 or newer;
they open a headless browser with a temporary profile and close it when they finish. Tests leave folders named `ldv-test-*`
(small) and `ldv-browser-*` (about 25 MB each, the browser profiles) in the system temp directory; remove them when you like.

## Pull requests

- One logical change per pull request, with a test that fails without it.
- Keep `README.md`, `PRIVACY.md`, `SECURITY.md`, `docs/PLAN-FORMAT.md` and the skill text true: if behaviour changes, the words
  change in the same pull request.
- Column names and values from the data must never reach SQL text, a chart spec field name or `innerHTML`; see `SECURITY.md`.
- No third-party code is bundled, and none should be: the page draws its charts itself (`viewer/charts.js`), in readable code.
- Keep every file under 256 KiB, with no minified lines, and keep the sources ASCII.
- Run `claude plugin validate .` if you have Claude Code installed.

## Reporting problems

Bugs and ideas: open an issue. Security problems: see `SECURITY.md` and do not open a public issue.
