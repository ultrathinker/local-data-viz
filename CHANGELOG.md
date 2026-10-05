# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.4.0]

### Added

- **Row filters.** The plan can keep only some rows: `{ "column": "department", "op": "=", "value": "emergency" }`, or the last
  months of the data: `{ "column": "visit_time", "op": "last", "n": 3, "unit": "month" }`. Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`,
  `between`, `in`, `not_in`, `is_null`, `not_null`, `contains`, `starts_with`, `last`. Filters can be given for the whole page
  (per dataset), for one chart or for one explorer, and combine with AND. They are plain JSON checked against the columns, never SQL
  text, and every value is quoted. Charts, explorers and key numbers are computed from the kept rows only; a histogram and the
  first-to-last sentence of a line chart use the range of the kept rows; the page says above each chart which rows it shows; a
  filter that leaves no rows is reported by the build.
- Charts can be saved as an SVG file or a PNG picture; tooltips on every mark; a line chart follows the pointer with a guide at the
  nearest date and every line's value there.

### Changed

- **The page draws its charts itself**, as plain SVG, in about a thousand lines of readable code. The bundled Vega, Vega-Lite and
  Vega-Embed (868 KB of minified code) are gone: nothing third-party is shipped, the page's content policy no longer allows `eval`,
  and a chart spec now holds only titles as text. The numbers on every chart are unchanged.
- Numbers are cut to 12 significant digits before they are rounded to six places, so building twice from the same data gives the same
  page: an average that fell exactly between two roundings used to come out one way or the other depending on the order DuckDB added
  the rows in.
- One number format per axis (`0`, `10K`, `20K` rather than a mix of `5,000` and `10K`); scatter plots follow their data instead of
  starting at the next round number.

## [1.3.0]

Found by two more AI testers who used 1.2.0 on ten more folders of invented data. Every
number they checked matched an independent recomputation; what they found was in the files the plugin could not read, in what it said
about the numbers, and in the draft plan.

### Fixed

- CSV files saved as UTF-16 (Notepad and Excel "Unicode" text) were skipped with a raw DuckDB error, although the README said they work.
  They are now detected (byte order mark, or the zero bytes of ASCII text), a UTF-8 copy is written to the work folder and read, and
  the report says so. The original is untouched.
- Comment lines (`# exported ...`) before the header hid the repeated header lines in the middle of a file, so those lines were
  counted as data. The header is now found after the comments.
- A field the plan does not know (`filter`, `where`, a misspelt `measure`) was ignored in silence: the page showed all rows, or
  counted rows instead of summing. It is now an error that names the field, says there are no row filters, and suggests the nearest name.
- The sentence "the last point is X% below the first" was misleading for a first or last week, month, quarter or year that the data
  only partly covers, and for a negative start. It is now given only for amounts that add up, from a positive start, over whole
  periods; averages get "the first point is A, the last is B".
- Insights no longer rank equal bars ("highest 5, lowest 5"), no longer name missing values as the highest group, and no longer call
  four points a correlation.
- The draft plan drew the time chart on the end time instead of the start time, had no count of rows for event data (trips, requests),
  charted a two-row sheet, drew histograms of a handful of values, and added up durations (`length_of_stay_hours`) while averaging
  energy (`kwh`) and rain.

### Added

- The report explains numbers that stayed text: values such as "$12.30", "1,234.50" or "12%", and number columns with some "N/A" cells.
- The report names a number column whose lowest or highest value is a code for "missing" (-999, 9999), a "Total" line at the end of
  a CSV, a column that is 20% or more empty (was 50%), and category columns listed without their values on a wide table.
- The build summary says which files were not read, so the page is not taken for the whole folder.
- The skill says what to answer when the user asks for filters, joins, a reshaped wide table, pie charts or maps, what to do when
  `${CLAUDE_PLUGIN_ROOT}` is empty in the shell, and to decide about `--no-values` before the first command.

## [1.2.0]

The first published version. 0.1.0 and 0.1.1 (below) were internal builds that were never published. This version contains the fixes
found by two AI testers who used the plugin on data they invented.

### Fixed

- A header line repeated in the middle of a CSV (files joined by hand) was read as data and turned the number columns into text.
  It is now removed from a copy in the work folder (the original is untouched) and reported.
- An Excel sheet with a title row above the table gave `column_2`, `column_3`, ...; a leading row with a single filled cell is now
  skipped and reported.
- The numbers of different values in the report were estimates and could be wrong or impossible (22,267 values in 20,000 rows, "5 values"
  for six categories). They are now exact (up to 2,000,000 rows; beyond that an estimate, clamped, and shown as "about").
- A file that could not be read had its reason cut in the middle of a word; the reason now says what it means and is cut at a word.
- Histogram bin edges no longer carry floating-point noise (40.849999999999994).
- A web address given instead of a folder is explained ("download the data into a folder") instead of "does not exist".
- The insight of a split chart added up averages of different groups; it now looks at single points for averages, minimums and
  maximums, adds up only sums and counts, and says when only the 8 largest groups are drawn.

### Added

- One level of nested objects in JSON (`{"user": {"country": "NL"}}`) becomes columns named `user.country`, so web-analytics style
  data can be charted by country, device or page. Arrays and deeper objects stay listed as not charted.

### Changed

- The draft plan writes the title of every chart into the plan, and no longer charts a category that has about as many values as
  rows (an average per teacher when every teacher is one row).
- `--no-values` now means structure only: the report shows no values, ranges, averages or correlations, and the skill tells Claude
  not to open the page files. The page itself still shows the numbers (it is for the owner of the data).
- `viz.mjs --help` and `-h` work; the report names the files that are ignored (`.txt x2 (a.txt, b.txt)`).

## [0.1.0]

First version.

### Added

- `/local-data-viz:charts` command and the `local-data-viz` skill: Claude inspects a folder of data files, writes a plan and builds
  a page of charts.
- `scripts/viz.mjs` with `doctor`, `inspect`, `plan` and `build`; reads CSV, TSV, JSON, JSON lines, Excel (.xlsx) and Parquet
  through DuckDB; files with the same columns become one dataset.
- The page: menu, draggable splitter (mouse and keyboard, width remembered), overview, line, bar, histogram, scatter, heatmap and
  correlation charts (Vega-Lite), and an explorer over a pre-aggregated cube with CSV download.
- A strict content policy on the page, fixed chart field names, and tests with hostile file names, column names and values.
