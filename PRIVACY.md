# Privacy Policy

This plugin runs entirely on your machine. It makes no network requests, collects nothing and sends nothing anywhere.

- **Network:** none. The bundled script starts the DuckDB program on your computer, in memory, with automatic extension
  downloads switched off, and writes files. It does not download anything, check for updates or report usage. The pages it
  makes carry a content policy that forbids network access (`connect-src 'none'`), and load only files from their own folder.
- **What it reads:** the folder you name (CSV, TSV, JSON, JSONL, Excel and Parquet files in it and in its subfolders) and the
  work files it wrote itself. Nothing else is read: no other folders, no Claude data, no chat or session transcripts, no
  environment secrets.
- **What it writes:** only new files, next to the data folder: a `<folder>-viz` folder with a `_work` folder (Excel sheets
  converted to CSV, a saved profile and a draft plan) and one `run-<time>` folder per build (the page). It never overwrites,
  moves or deletes anything, and never writes inside the data folder.
- **What Claude sees:** the text the script prints. After `inspect` that is the file list, column names and types, ranges,
  averages, the most common values of category columns and the strongest correlations; Claude may also read the chart insights in
  the page files. With `--no-values` the report shows structure only (names, types, kinds and counts: no values, ranges, averages
  or correlations) and the skill tells Claude not to open the page files. Claude handles what it sees under the terms of your Claude
  account, like anything else you share in a session. `--no-values` limits what Claude sees; the page and the work files still
  contain your numbers, on your computer.
- **What the page contains:** summaries (sums, averages, counts per group), the names of your files and columns, the most
  common values of category columns (unless `--no-values`), and for scatter plots a fixed sample of up to 2,000 points. It does
  not contain your full tables. Review the page before you share it with anyone.
- **Third parties:** none. The page draws its charts itself; there is no library, and nothing contacts anything.

Questions: open an issue in this repository.
