# enpopa-data

Prepared wind for the [enpopa](https://github.com/k111git/enpopa) app, published on GitHub Pages at
<https://k111git.github.io/enpopa-data/>.

The app's area is small, but Open-Meteo's files each cover all of France or Europe for one forecast hour,
so reading the area out of them directly takes hundreds of requests and about 100 MB per run. A scheduled job
here does that once per new run and publishes the result compactly:

| Model | Area grid | Hours per run | Per hour | Whole run |
|---|---|---|---|---|
| AROME HD (Météo-France, 1.3 km) | 561 × 1001 | 52 | ~0.5 MB | ~26 MB |
| ICON-EU (DWD, 7 km) | 91 × 161 | 93 | ~20 KB | ~2 MB |
| EWAM waves (DWD, 0.05° × 0.1°) | 113 × 101 | 79 | ~40 KB | ~3 MB |

The values are the same as on Open-Meteo, at the steps it stores them in:

- **Wind** (AROME HD, ICON-EU): u, v and gusts at 10 m, 0.1 m/s.
- **Waves** (EWAM, runs at 00 and 12 UTC to +78 h): height (0.02 m), period (0.05 s) and direction they come from (1°), for the
  total sea, the swell and the wind waves. Land is nodata. The app doesn't use it yet.

## How it works

`.github/workflows/prepare.yml` runs every half hour (GitHub often starts scheduled jobs a few minutes late):

1. `build.mjs` looks up the newest complete run of each model (AROME HD, ICON-EU, EWAM) on Open-Meteo's open-data bucket.
2. For a run it hasn't built yet, it reads the area (38.4–44.0° N, 0–10° E) out of every hour's `.om` file and writes one
   file per hour, plus the land mask once.
3. If anything changed, or the live site differs from the built one, the site is published on GitHub Pages. The newest two runs of each model are kept, so a download
   that is under way when a new run arrives can finish.

The site folder is kept between runs in the Actions cache, so an unchanged run costs about half a minute.
If the cache is gone, the next run simply builds the newest run again (about 2 minutes).

## Files

- `latest.json`: the manifest. For each model, the grid (`rows`, `cols` of Open-Meteo's grid, `ny`, `nx`, and
  `lat0`, `lon0`, `dlat`, `dlon` of the south-west cell and the spacing), `variables` with their `scales` (value =
  stored / scale; `scale` too where all are the same), `nodata` and `runs` (newest first, each with `run` and `times` as Unix seconds, and when
  Open-Meteo `published` it).
- `<model>/<run>/<valid time>.bin`, e.g. `arome-hd/20261120T0600Z/20261120T1500Z.bin`: one forecast hour. Raw
  deflate of each variable's int16 grid in turn (rows south to north), coded as the difference from
  `left + below − below-left`, zigzag-mapped, low bytes then high bytes. See `encode()` in `build.mjs` and
  `decode()` in the app's `web/engine/prepared.js`.
- `<model>/mask.bin` (wind models): raw deflate of one byte per grid cell, 1 = water.

The app checks the manifest against its own grid. If the area or format changed, or the files are missing or
more than about 2 hours behind Open-Meteo, it reads Open-Meteo directly as before. When changing `WINDOW` here,
change it in the app's `web/engine/models.js` too.

## Setup

- Settings → Pages → Build and deployment → Source: **GitHub Actions**.
- Run it once by hand: Actions → Prepare wind → Run workflow.

Locally: `npm ci && node build.mjs site`.

## Licence

The forecast data is from [Open-Meteo](https://open-meteo.com) (CC BY 4.0), based on Météo-France AROME HD,
DWD ICON-EU and DWD EWAM.
