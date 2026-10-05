# Security Policy

## Reporting a vulnerability

Please report security issues through GitHub Private Vulnerability Reporting: open the **Security** tab of this repository and
choose **Report a vulnerability**. Do not open a public issue for a suspected vulnerability.

## Supported versions

Only the latest release is supported.

## Scope

The plugin reads files you point it at, which can come from anywhere, so the main boundary is: data must never become
instructions. What it does about that:

- **SQL.** DuckDB runs with SQL the script writes. Every column name goes through one quoting function (`ident`, double quotes
  doubled), every path and value through another (`lit`/`pathLit`), and no data value is ever placed in SQL text. Tests use
  names with quotes, semicolons, line breaks and DuckDB shell commands (`.shell`, `.print` at the start of a line inside a
  quoted name) and check that nothing runs. DuckDB runs in memory with automatic extension install and load switched off.
- **The page.** Text from the data is put into the page with `textContent` only: the page code builds no HTML from strings and
  uses no `eval`. Chart specifications hold titles as text only, and the data rows have fixed field names (never a column name). A content policy forbids all network access
  and inline scripts; the page can load only files from its own folder. Tests load a page made from HTML-laden names and
  values in a real browser and check that no element is created and no script runs. CSV export from the page prefixes cells
  that start with `=`, `+`, `-` or `@` so spreadsheets do not read them as formulas.
- **Files.** The data folder is only read; links, hidden folders and `node_modules` are skipped; file count, depth and size
  limits apply. Excel files are read by a small built-in ZIP and XML reader with a size cap on every entry (a "zip bomb" is
  refused), and are never opened by Excel. Output goes only to new files, created exclusively, never over an existing file and
  never inside the data folder. A saved profile is used again only if its file paths lie inside the data folder or the work folder.
- **The report.** Names and values from the data are printed on one line each, with control characters removed and a length
  limit, and the skill tells Claude to treat them as data, never as instructions.
- **No bundled code.** The page draws its charts itself, in about a thousand lines of readable code (`viewer/charts.js`); there is
  no chart library, nothing minified, and the content policy allows scripts from the page's own folder only (no `unsafe-eval`).

Relevant reports are about a data file that makes the script or the page do something other than draw charts, writing outside the
named locations, any network access, and bugs in the bundled ZIP, XLSX or JSON-output readers.
