# Plan format

The plan is a JSON file that says what to chart. `viz.mjs inspect` writes a draft; you (or Claude) edit it; `viz.mjs build --plan <file>`
reads it. Every name in it is checked against the data before anything runs, and all problems are reported together.

```json
{
  "version": 1,
  "title": "Page title",
  "views": [ ... ],
  "explorers": [ ... ]
}
```

`version` must be `1`. `title` is shown on the page (up to 120 characters).

Only the fields described here exist. A field the plan does not know is an error that names it (with a "did you mean" for a
typo), so nothing is silently ignored.

## Column kinds

`inspect` gives every column a kind. The plan uses them as follows.

| Kind | Meaning | Used as |
| --- | --- | --- |
| `measure` | a number | what is added up or averaged; histogram and scatter axes |
| `dimension` | a category with up to 20 values (or a true/false column, or a small whole-number code, or a year) | groups, splits, colours; a numeric one (the report says so) can also be summed or averaged |
| `dimension_high` | a category with more than 20 values | the x of a `bar` (top N) or a `heatmap` axis |
| `temporal` | a date or timestamp (text that reads as dates is converted) | the x of a `line`; a grouping in an explorer |
| `id`, `text` | identifiers and free text | not charted (counting rows or distinct values is allowed) |
| `constant`, `empty`, `complex` | one value, no values, nested data | not charted |

Column names are matched exactly, or case-insensitively when that is unambiguous.

## Measures

```json
{ "column": "amount", "agg": "sum" }
{ "agg": "count" }
```

`agg` is one of `sum`, `avg`, `min`, `max`, `median`, `count`, `count_distinct`. `count` without a column counts rows. Only
`count` and `count_distinct` accept a non-numeric column. A measure missing from a view defaults to counting rows.

## Views

Every view has `kind` and `dataset` (`ds1`, `ds2`, ...). Optional for all: `id` (lower case letters, digits, `-`), `title`, `note`,
`filters` (see below).

| `kind` | Fields |
| --- | --- |
| `line` | `x` (temporal), `measure`, `grain` (`hour` `day` `week` `month` `quarter` `year`; default from the data), `split` (category, top 8 values) |
| `bar` | `x` (category), `measure`, `limit` (3 to 30, default 15, the top values by the measure), `split` (category, stacked) |
| `hist` | `column` (number), `bins` (5 to 100, default 30) |
| `scatter` | `x`, `y` (numbers), `color` (category). A fixed sample of 2,000 points is drawn |
| `heatmap` | `x`, `y` (categories), `measure`, `limit` (3 to 20 values per axis, default 12) |
| `corr` | `columns` (3 to 8 numbers); draws the matrix of correlations |

At most 40 views.

## Filters

A filter keeps only the rows that match; everything else (the chart, the explorer, the key numbers) is computed from the kept rows.
Filters are plain JSON, never SQL:

```json
{ "column": "department", "op": "=", "value": "emergency" }
{ "column": "visit_time", "op": "last", "n": 3, "unit": "month" }
```

They can be given at three places, and all that apply to a chart are combined with AND:

- the top level of the plan, `"filters": [ { "dataset": "ds1", "column": ..., "op": ... } ]`: applies to every chart, explorer and key
  number of that dataset (at most 16);
- a view, `"filters": [ ... ]`: only that chart (at most 8);
- an explorer, `"filters": [ ... ]`: only that explorer (at most 8).

| `op` | Needs | Keeps the rows where the column |
| --- | --- | --- |
| `=` `!=` | `value` | equals, or does not equal, the value (`!=` also keeps rows with a missing value) |
| `<` `<=` `>` `>=` | `value` (number or date) | is smaller, larger, ... |
| `between` | `value` and `to` (number or date) | is from `value` to `to`, both included |
| `in` `not_in` | `values` (a list of up to 100) | is one of, or none of, the values (`not_in` also keeps missing values) |
| `is_null` `not_null` | nothing | is missing, or is not missing |
| `contains` `starts_with` | `value` (text column) | has the text inside, or at the start; capitals do not matter, no wildcards |
| `last` | `n` (1 to 1000) and `unit` (`day` `week` `month` `quarter` `year`), date column | lies within the last n units before the latest date of the data (not before today) |

Values follow the column: a number for a number column (`60`, or `"60"`), a date for a date column (`"2025-01-31"` or
`"2025-01-31 08:30:00"`), a text for everything else. A row with a missing value never matches `=`, `<`, `between`, `in` and the like.
Every filter is shown on the page above the chart it applies to. The histogram and the first-to-last sentence of a line chart use the
range of the kept rows. A plan that filters everything away still builds, and the build says so.

## Explorers

```json
{ "dataset": "ds1", "dimensions": ["order_date", "region", "product"], "measures": [{ "column": "amount", "agg": "sum" }] }
```

Up to 5 `dimensions` (columns of the kind `dimension`, up to 20 values, or `temporal`; a `dimension_high` column such as a name or
a meter id is not allowed here; a date is cut to the data's default grain) and up to 4 `measures` (a `Rows` count is always
added). For these columns DuckDB pre-computes the total, every single grouping and every pair of groupings; the page then lets the
reader choose a measure, a grouping and an optional split. A grouping with more than 5,000 cells is not offered.
