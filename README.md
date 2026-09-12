# dark sky calendar

A single-page planner for stargazing and astrophotography nights in the
North Carolina mountains: when the moon is out of the way, whether the sky
will be clear, and where to drive.

**[spskelly.github.io/dark-sky](https://spskelly.github.io/dark-sky/)**

![dark sky calendar](og.png)

## What it does

- **Moon phase calendar.** True phase times from the Meeus algorithm
  (*Astronomical Algorithms*, ch. 49), converted to your local time zone, so
  dates match published almanacs to the day. Phases are drawn at 9pm local —
  roughly when you'd be looking up — and the lit limb flips for the southern
  hemisphere.
- **Dark-sky windows.** A 3, 5 or 7 day band centred on each new moon,
  highlighted on the calendar and listed for the next twelve months, with the
  Friday and Saturday nights in each one called out and a note on where the
  Milky Way core sits that month.
- **Hourly sky forecast.** Cloud cover, temperature, wind and dew point for
  tonight, sunset to sunrise, from [Open-Meteo](https://open-meteo.com/)
  (no API key). Each night in the calendar also carries its mean 9pm–3am
  cloud cover.
- **20 dark-sky spots.** Overlooks, balds and campgrounds within a few hours
  of Waynesville, on a topo map, ranked by drive time or straight-line
  distance from a home point you can set. Each links to its Clear Outside
  forecast, light-pollution map and driving directions.

## Running it

The site is one `index.html` with no build step and no runtime dependencies.
Open it directly, or serve the directory:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

The map (Leaflet, from cdnjs) and the forecast (Open-Meteo) need network
access; everything else — the phase maths, the calendar, the spot list —
works offline, and the map degrades to the list with a note.

## The moon is always current

Two things show tonight's real phase, and neither is hand-drawn.

- **The tab icon** is generated in the browser on every render, from the same
  `moonPath()` the calendar icons use, and follows the hemisphere toggle. The
  icon in `<head>` is only the no-script fallback.
- **`og.png`**, the link-preview image, is rebuilt daily by
  [a GitHub Action](.github/workflows/og-card.yml). It doesn't recompute
  anything: `tools/build-og.mjs` loads this very page in headless Chromium and
  calls the page's own `lunationFraction()`, `moonSvg()` and `phaseWord()`, so
  the card cannot drift from the calendar it advertises. It commits only when
  the image actually changes.

The npm dependencies exist for that generator alone — the site itself ships
nothing from `node_modules`. To rebuild the card by hand:

```sh
npm ci && npx playwright install chromium && npm run build:og
```

## Notes

- The window is a planning heuristic. The moon also rises and sets, so a
  waxing crescent a few days past new is gone by late evening and a waning
  crescent doesn't rise until the small hours; those edge days are often
  darker than they look.
- Drive times assume the Blue Ridge Parkway is open. The high sections close
  for ice from November into April — check
  [NPS road status](https://www.nps.gov/blri/planyourvisit/roadclosures.htm)
  before committing to a gate.
- Tiles: [OpenTopoMap](https://opentopomap.org/) (CC-BY-SA) and USGS
  imagery via The National Map.
