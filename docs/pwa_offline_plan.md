# PWA and offline-use plan

Status: PWA shell and forecast cache proposed; optional map package implemented

Date investigated: 2026-09-20 to 2026-09-21

## Recommendation

Turn Blue Ridge Skyline into an installable PWA whose complete planning core is
available offline after one successful online visit. Include a bounded,
time-labelled cache of forecasts the user has already viewed. Keep the current
online topo map as the default, and offer the bounded orthophoto and terrain
reference as a separate, explicit 6.2 MB device download. Keep third-party map
tiles, directions, and land-manager links explicitly online-only.

This is a good fit for the current application. The moon and calendar maths,
spot catalogue, terrain horizons, canopy profiles, skyglow summaries, Parkway
geometry, overlooks, and sky renderer already ship with the page. The work is
mostly packaging, dependency localization, cache lifecycle management, and
honest offline states. It does not require an application server or a framework
rewrite.

The first release should promise this:

> Once the app says it is available offline, it can be closed, reopened, and
> refreshed without a connection. The calendar, places, saved home, terrain
> horizons, sky viewer, and recently viewed forecasts work. If you chose to
> download the regional maps, they work too. Saved forecasts always show when they were retrieved. Live
> updates, detailed map imagery, directions, and external status pages clearly
> say that they need a connection.

It should not promise that all maps work offline or that a saved forecast is a
live report.

## Current state

The site is a static, single-page application deployed under the GitHub Pages
project path `https://spskelly.github.io/dark-sky/`.

| Area | Current behavior | Offline consequence |
| --- | --- | --- |
| Main page | One 7,351,113-byte `index.html` | Cacheable as one application shell |
| Generated horizons | About 6.75 million characters embedded in the page | Already available offline once the page is cached |
| Canopy, sky, skyglow, Parkway, overlooks | Embedded in the page | Already available offline once the page is cached |
| Moon texture | Local `assets/moon-full.jpg`, 189,098 bytes | Add to the application-shell cache |
| Fonts | Google Fonts at `index.html:24-26` | Must be self-hosted for a consistent offline render |
| Leaflet | cdnjs CSS and JavaScript at `index.html:27-28` | Must be self-hosted or the map code cannot start offline |
| Forecast | Open-Meteo fetch at `index.html:7379-7395` | The current 30-minute cache is memory-only and vanishes on reload |
| Basemaps | OpenTopoMap and USGS tiles at `index.html:7175-7181` | Remote tiles disappear offline |
| Skyglow overlay | David Lorenz tile service at `index.html:6495` | Remote tiles disappear offline |
| User state | Defensive `localStorage` wrappers at `index.html:5815-5827` | Home and interface choices already survive offline restarts |
| Deployment | Fixed copy list in `.github/workflows/deploy-pages.yml:52-60` | New PWA files will not deploy until the assembly step changes |
| Browser tests | `tools/check-tabs.mjs` uses `file://` | Preserves static behavior but cannot prove a service worker works |

The raw HTML is large because the useful field data is embedded, but it is
highly compressible. On 2026-09-20, the local file measured 7,351,113 bytes raw,
671,390 bytes with gzip, and 560,848 bytes with Brotli. Cache accounting may be
closer to the decoded size, but transfer cost on a compressed server should be
much smaller than the raw file. The core cache should remain under roughly 9 MB
before optional map downloads. The bounded forecast store is negligible by
comparison.

The current visual and browser baseline is healthy. On 2026-09-20,
`node tools/check-tabs.mjs --shots` passed all checks for desktop and phone
layouts, tab navigation, map degradation, storage restoration, spot and
overlook horizons, and the sky viewer. The screenshots also confirm that the
calendar, place cards, horizon drawings, and sky viewer remain useful when the
live forecast is unavailable.

## Offline behavior by feature

### Available offline in version 1

- Current moon phase, illumination, calendar, and dark-sky windows, because
  they are calculated from the device clock.
- The 38 curated spots and 116 Parkway overlooks.
- Saved home location, filtering, sorting, selected place, map view, and sky
  viewer state already stored in `localStorage`.
- Drive-time estimates currently calculated from straight-line distance.
- Terrain, canopy, structure, and ridge profiles already embedded in the page.
- Spot and overlook descriptions and their generated skyglow summaries.
- The interactive sky viewer, including date and time controls.
- The local Parkway line and all local markers, provided Leaflet is vendored.
- Field notes, limitations, provenance, and credits.

### Available offline from a bounded saved-data cache

- The most recent valid Open-Meteo response for home and recently viewed
  places. It must be visibly identified as saved data, including its absolute
  retrieval time and the time range it covers.
- A small, generated western North Carolina terrain and orthophoto reference,
  if the user explicitly downloaded the 6.2 MB map bundle. Detailed online
  basemaps and light-pollution tiles remain separate layers.

### Clearly degraded offline in version 1

- Open-Meteo cannot update. If no usable saved response exists, the UI should
  say `offline: no saved forecast for this place`. If one exists, it should say
  `saved [date and time]; live update unavailable`.
- OpenTopoMap, streamed USGS imagery, and light-pollution tiles are unavailable.
  The map should retain the markers and Parkway line. It also retains the local
  orthophoto and hillshade if they were downloaded; otherwise it shows a plain
  background and `offline: map download not stored on this device`.
- Directions, Clear Outside, light-pollution-map, road-closure, and land-manager
  links still open as links, but should be identified as requiring a connection.
- Device geolocation may work without a network on some devices, but it should
  not be part of the offline guarantee.

### Deliberately deferred

- Do not automatically prefetch or retain third-party map tiles. Tile-server
  policies, attribution, storage size, and cache bounds must be handled per
  provider. The OSM Foundation's own public tile policy, for example, forbids
  bulk downloading and offline packs. OpenTopoMap, USGS imagery, and the
  light-pollution atlas each need their own confirmed terms before adding an
  offline tile feature.
- Do not show an old weather response as current. A saved response is a
  forecast snapshot, not cached current conditions.
- Do not add background sync, push notifications, or an application backend.
  None are needed for the offline planning workflow.

## Offline map options investigated

The map has two different jobs: help someone understand where a place is, and
show detailed reference imagery when a connection exists. Trying to make every
current layer available offline would make the first PWA release much larger
and would preserve the least predictable part of the current experience.

| Option | Offline value | Cost and risk | Decision |
| --- | --- | --- | --- |
| Plain local background with existing markers and Parkway line | Preserves place selection but gives little geographic context | Smallest and simplest | Keep as the final fallback |
| Generated western North Carolina orthophoto and terrain overviews | Gives recognizable land cover, ridges, valleys, Parkway geometry, and relative location | Two bounded images, measured at 6.2 MB total; no roads or detailed labels | Implemented as an optional download |
| Regional Protomaps PMTiles package | Can provide a complete interactive vector basemap with roads and labels | Requires a measured regional extract, MapLibre, local glyphs and sprites, range-request handling, storage controls, and attribution | Best candidate for a later map overhaul |
| Cache tiles as the user browses | Sometimes preserves recently seen areas | Coverage is unknowable, storage grows unpredictably, and provider terms differ | Do not use as the offline design |
| Prefetch the current remote layers | Could reproduce the online map | Potentially very large; provider permission is unresolved for some layers | Do not implement |

### Recommended first-release map

The implemented package uses USGS 3DEP data already used by the project plus
the USGS ImageryOnly service, primarily USDA NAIP in the conterminous United
States. USGS says National Map data and services are public domain and may be
used without restriction, with acknowledgement requested. Leaflet displays the
fixed images with `L.imageOverlay`, so markers, Parkway geometry, filters, and
popup behavior do not require a map-engine migration.

The 2026-09-21 build covers 34.9 to 36.6 north and 84.2 to 80.9 west in
EPSG:3857. Both images are 4096 by 2600 pixels. The orthophoto is 3,020,321
bytes and the multidirectional hillshade is 3,198,629 bytes, for 6,218,950
bytes total. This is an orientation map, not offline turn-by-turn navigation.
Directions remain an online handoff. The exact source request, build time,
dimensions, and layer sizes are recorded in `assets/offline-map/manifest.json`.

The map-layer control should make the distinction explicit:

- `Topo` remains the default online layer, with streamed `Imagery` as the other
  ordinary online choice.
- `3DEP hillshade · downloaded` and `orthophoto · downloaded` enter the layer
  picker only after the explicit download validates.
- The optional bundle has download progress, stored size, persistence across a
  reload, and a remove action that deletes only its application-owned cache.
- `Light pollution` remains an online-only overlay.

Without the optional bundle, a cold offline map retains its local markers and
Parkway geometry on the existing plain background.

### Implemented viewing-direction and bald overlays

The map now offers an opt-in `best sky direction` overlay for all 38 curated
places and all 116 Parkway overlooks. Each wedge is a 60 degree sector derived
from the existing 360-sample terrain plus canopy obstruction profile. The
selection minimizes mean obstruction plus 0.35 times the sector's 90th
percentile obstruction. The mean rewards a broadly open view, while the 90th
percentile prevents one ridge wall inside the sector from disappearing into an
average. These values are initial explainable heuristics, not a field-validated
quality score. The overlay shows curated-place sectors by itself; Parkway
sectors appear when both the sector and Parkway-overlook layers are enabled.

Eight places with explicit curated evidence of an open bald summit or meadow
have a green ring: Black Balsam Knob, Hooper Bald, Carvers Gap, Max Patch,
Craggy Pinnacle, Big Bald, Bearwallow Mountain, and Huckleberry Knob. A place
name alone is not treated as evidence, because several overlooks look toward a
bald rather than standing on one.

Rebuild the two map files with `node tools/build-offline-map.mjs`. A normal
2026-09-21 build took about 20 seconds and checkpoints each completed JPEG with
a temporary-file rename. A rerun skips valid finals; use `--force` only when
intentionally refreshing both source exports. If any bundle content changes,
increment the cache version in `assets/offline-map-store.mjs` so existing
downloads are offered the new package instead of silently retaining old bytes.

### Later option: regional PMTiles

Protomaps can package a geographic extract in one PMTiles archive. Its basemap
data is based on OpenStreetMap, requires OSM attribution, and is intended to be
self-hosted. The official CLI supports bounding-box extraction and a maximum
zoom. Protomaps notes that every additional zoom level roughly doubles the
archive size, so the decision cannot be made from an unmeasured estimate.

For this application, test a western North Carolina bounding box at maximum
zooms 11, 12, and 13. Record archive size, first render time, pan smoothness,
text clarity, memory use, and battery behavior on the target phone. Do not add
the archive to the install-time application shell until those measurements
exist. A larger archive should be an explicit optional download with its size,
progress, cancel, update, and delete controls visible.

Protomaps recommends MapLibre for new vector-map work. That makes PMTiles a
reasonable part of a broader mobile map redesign, but not a small change to the
current Leaflet page. A fully offline MapLibre package also needs local styles,
sprites, and font glyphs. GitHub Pages can serve PMTiles with byte ranges, but
the offline service worker must either cache and answer range requests from the
complete local archive or provide the archive through an explicitly supported
local source. That behavior needs an automated offline test.

The current remote layers should not be silently cached. The OSM Foundation's
public tile service explicitly forbids offline prefetch, although that policy
does not itself define the terms of OpenTopoMap. The September 2026 review of
the Lorenz-hosted light-pollution tiles found no explicit rendered-tile license
or hotlink permission. USGS imagery is legally easier, but a browsing cache is
still not a bounded offline product.

## Saved forecast design

Forecast persistence is both useful and inexpensive. A live request made on
2026-09-21 with the application's eight-day hourly fields returned 192 hours
and measured 10,009 bytes as JSON, 2,529 bytes with gzip, and 1,851 bytes with
Brotli. Twelve similarly sized responses would be roughly 120 KB uncompressed,
before IndexedDB overhead.

Open-Meteo publishes its API data under CC BY 4.0, which permits sharing and
adaptation with attribution. Its free/open service is restricted to
noncommercial use and currently documents rate limits of 600 calls per minute,
5,000 per hour, 10,000 per day, and 300,000 per month. The current product use
fits comfortably if forecasts continue to load only when requested. Keep an
Open-Meteo link next to displayed forecast data. Reassess the service terms if
the project adds advertising, subscriptions, or other commercial use.

### Storage model

Use an application-owned IndexedDB store, not `localStorage` and not an opaque
service-worker response cache. The page needs to inspect freshness, coverage,
provider, coordinates, and schema before displaying a saved response.

Each record should contain:

```text
key: canonical request fingerprint
schemaVersion: forecast cache schema
fetchedAt: last successful network retrieval time
validFrom / validThrough: first and last forecast timestamps
lastAccessedAt: used for bounded cleanup
target: name, latitude, longitude, elevation
request: timezone, units, variables, forecastDays
provider: Open-Meteo
data: validated API response
```

The key must include rounded latitude, rounded longitude, elevation, timezone,
units, hourly and daily variable lists, forecast-day count, and schema version.
The current in-memory key uses only coordinates even though elevation changes
the API's downscaled result. Do not carry that collision into persistent data.

### Read and write behavior

1. Reuse a response from the current 30-minute in-memory cache to avoid repeat
   requests during one session.
2. Otherwise request the network with a finite timeout.
3. Validate required arrays and timestamps before replacing the saved record.
4. On success, render the live response and atomically write the record to
   IndexedDB.
5. On network failure, load the saved record for the exact request key.
6. If it still contains forecast hours at or after the selected time, render it
   with an always-visible absolute retrieval time and `live update unavailable`.
7. If its last forecast hour has passed, report that the saved forecast is
   expired. Do not stretch its meaning beyond the API's covered interval.

The 30-minute value is request deduplication, not a claim that weather becomes
invalid at minute 31. Open-Meteo says contributing models update at different
intervals, generally every few hours, and its Best Match response combines
models. The displayed snapshot therefore should not invent a model-run age.
Show `retrieved Sunday, Sep 21 at 8:10 PM` and the covered interval instead.

Keep no more than the 12 most recently accessed targets, or set a similarly
small measured byte cap. Always retain home if it has a usable response. Add a
`Clear saved forecasts` control. Changing requested variables or summary logic
increments `schemaVersion` and makes incompatible records ineligible; cleanup
can remove them later.

Preserve the current on-demand overlook behavior. Fetching forecasts for all
116 overlooks would spend bandwidth and storage on places the user did not ask
about. A later `Prepare this trip` action could deliberately refresh home plus
one chosen destination, show the resulting retrieval time, and confirm when
both records are ready offline.

Stored records remain on the device unless the user clears site data or uses
the clear control. The API request still sends coordinates to Open-Meteo; its
terms say server logs can contain location data and are deleted after 90 days.

## Mobile redesign findings

The phone screenshots pass the current regression checks, but those checks
mostly prove that controls render and interactions function. They do not prove
that the page is comfortable as an installed field app. A larger mobile
redesign is justified before committing to MapLibre or a downloaded map pack.

The main issues visible at the current phone viewport are:

- The marketing hero and home controls occupy most of the first screen on every
  tab. An installed app should lead with the active task, not repeat its landing
  page introduction.
- The sticky four-tab bar sits at the top of a very long document and can cover
  content while scrolling. It also competes with the browser or standalone
  safe area rather than behaving like primary mobile navigation.
- Calendar cells and secondary text are dense, while each upcoming window
  expands into a long vertical card.
- The Places panel puts a map, filters, legend, and many detailed cards into one
  continuous scroll. It is hard to move between geographic browsing and place
  comparison without losing position.
- The Sky canvas uses 72 percent of the viewport height, followed by wrapping
  controls, an all-day strip, and extensive explanation. The result is capable
  but tiring to operate one-handed.
- Field Notes is long-form reference copy below the full hero instead of a
  scannable field reference.

### Recommended mobile information architecture

Treat the installed experience as a task-focused application while retaining a
more explanatory landing state for first-time web visitors:

1. Use a compact app header after onboarding. Put the saved home, offline
   readiness, and last forecast update into a small status surface.
2. Move primary navigation to a safe-area-aware bottom bar: `Tonight`,
   `Places`, and `Sky`. Put Field Notes, methodology, attributions, storage, and
   install help under an `Info` sheet or menu.
3. Make `Tonight` the home screen. Lead with the next useful dark window, moon
   state, forecast freshness, and one primary action. Collapse the full
   calendar and explanatory copy behind progressive disclosure.
4. Give `Places` a map/list switch or a split sheet. Show compact comparable
   rows first; open one place in a bottom sheet or focused detail view. Keep
   filter chips reachable without repeating the legend and full card prose.
5. Give `Sky` compact place, date, and time controls above a canvas closer to
   half the small viewport. Offer a deliberate full-screen view. Make the
   all-day strip and methodology collapsible rather than permanent vertical
   content.
6. Turn Field Notes into indexed topics or accordions with a prominent offline
   preparation checklist.

Use `100dvh` and safe-area insets for the installed layout, with a fallback for
older browsers. Preserve all touch targets at 44 CSS pixels or larger. Do not
hide critical forecast freshness or offline status inside hover states,
tooltips, or color alone.

### Redesign sequence

Before changing production markup, add screenshot and interaction cases for a
small phone, a typical modern phone, landscape, and standalone display mode.
Prototype the compact Tonight screen and the Places map/list transition with
the existing Leaflet map. This separates the information-architecture decision
from the later question of whether PMTiles and MapLibre earn their added size
and complexity.

Once that structure is accepted, implement the PWA shell and forecast cache
against the new navigation. The service worker itself is independent, but its
status and update controls need a stable home in the mobile interface. Then
test the local terrain overlay. Only after those pieces work on a real phone
should the project measure and consider a regional PMTiles download.

## Proposed architecture

Keep the application static and use browser-native PWA features. Workbox is not
needed for this small, explicit asset set, and adding it would introduce a build
layer that the site does not otherwise need.

### 1. Web app manifest

Add `manifest.webmanifest` and link it from `index.html` with a relative URL.
Use relative GitHub Pages paths throughout:

```json
{
  "id": "./",
  "name": "Blue Ridge Skyline",
  "short_name": "Skyline",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#0f1a34",
  "theme_color": "#0f1a34"
}
```

Add at least 192 by 192 and 512 by 512 PNG icons, maskable versions, and a 180
by 180 Apple touch icon. Derive them from the existing moon and ridge visual
language. Keep the existing data-URL favicon as a no-script/browser fallback.

The relative `./` values matter. Root-absolute paths such as `/sw.js` or
`/manifest.webmanifest` would refer to `spskelly.github.io`, outside the
`/dark-sky/` project scope.

### 2. Local boot dependencies

Replace the remote font and Leaflet tags with local files:

- Copy the four WOFF2 files actually used by the page from the already pinned
  Fontsource packages into `assets/fonts/` and define local `@font-face` rules
  with `font-display: swap`.
- Add pinned Leaflet 1.9.4 CSS and JavaScript under
  `assets/vendor/leaflet-1.9.4/`. Add Leaflet itself to `package.json` so the
  source and license version remain reproducible.
- Keep the existing license files and update attribution documentation with the
  exact vendored filenames and versions.

The page should make no remote CSS or JavaScript request during startup. Remote
links and live data calls remain allowed.

### 3. Service worker

Add `sw.js` beside `index.html`. Register it with a relative URL and scope only
on HTTP or HTTPS, so the existing direct `file://` tools continue to work.

Use a cache name prefixed specifically for this project, for example
`blue-ridge-skyline-app-<build-id>`. During deployment, replace a source token
with the Git commit SHA. This makes every code deployment produce different
service-worker bytes and a new application-shell cache. The scheduled social
card build can reuse the same SHA because its daily metadata change does not
change offline application behavior.

Precache only the files needed to start and use the core application:

- `./` as the canonical navigation response;
- `manifest.webmanifest`;
- `assets/moon-full.jpg`;
- local font files;
- local Leaflet CSS and JavaScript;
- PWA and Apple icons; and
- a small local status asset, if one is added.

Do not precache `og.png`, moon-preview files, documentation, weather responses,
the optional orthophoto or hillshade, or remote tiles. The map bundle belongs
to its separate opt-in `blue-ridge-skyline-offline-map-*` cache.

Use these request policies:

| Request | Policy | Reason |
| --- | --- | --- |
| App navigation | Cache first, network fallback | Field launches should not wait on a marginal connection |
| Precached local assets | Cache first | They are revisioned as one release |
| Open-Meteo | Network request managed by the page, then labelled IndexedDB fallback | Preserves useful snapshots without disguising their age |
| Map and skyglow tiles | Network only, no service-worker retention | Avoids unbounded storage and unconfirmed offline-use terms |
| External links | Do not intercept | Preserve ordinary browser behavior |

The install event should use one atomic `cache.addAll()` operation. If any core
asset fails, the new worker should not activate or replace the last complete
offline release. Activation should delete only older caches whose names start
with this project's prefix. It must not delete unrelated caches on the shared
`spskelly.github.io` origin.

Do not force a waiting worker into the middle of an open session. Detect a new
worker and offer a small `update ready` action. Apply it on the user's request,
then reload once `controllerchange` fires.

### 4. Offline readiness and failure UI

Add a compact status near the existing home controls:

- `saving for offline use...` while the worker installs;
- `available offline` only after the worker is active and the core cache is
  complete;
- `offline` when the browser reports a disconnected state; and
- `could not save offline, reconnect and retry` if installation fails.

`navigator.onLine` is useful for immediate copy changes but is only a hint.
Actual fetch and tile errors remain authoritative.

Avoid a large install banner. Chromium can expose its normal install UI. On
iPhone and iPad, a short help disclosure can explain Share, then Add to Home
Screen. A manifest with `display: "standalone"` makes the saved site open as a
web app on supported Apple devices.

Do not request persistent storage in version 1. The cached content is
reconstructible, not irreplaceable user data. Installation and regular use
improve retention, but the UI and documentation should still say that browser
storage can be cleared and the app may need to be saved again.

### 5. Deployment assembly

Replace the workflow's growing shell copy block with a small Node script such as
`tools/build-site.mjs`. It should:

1. Create `_site` from an explicit allowlist.
2. Copy the current page, social image, manifest, service worker, icons, and
   runtime assets, including the optional map files without adding them to the
   application-shell precache.
3. Apply the existing dated `og.png` query stamp to the staged `index.html`.
4. Replace the service worker's build token with the Git SHA supplied by CI.
5. Verify that every local manifest and precache URL exists under `_site`.
6. Fail if a remote startup script or stylesheet has returned to `index.html`.

Use the same script locally and in GitHub Actions so the artifact tested is the
artifact deployed. Keep `.nojekyll` in the artifact.

## Tests-first implementation sequence

### Phase 0: protect the current baseline

The sky-viewer work observed at the start of this investigation was committed
separately as `ea3532b` while the investigation ran. Keep the PWA work in its
own logical commits. If another session remains active in this checkout, use a
separate worktree before implementation so the sessions do not share an index.

Keep the existing `file://` integration test. It protects direct-open behavior
and proves that a conditional service-worker registration does not break tools
that intentionally block the network.

### Phase 1: write failing PWA checks

Add a Node and Playwright check that serves an assembled `_site` over localhost
under a `/dark-sky/` prefix. Testing at `/` would miss the most likely GitHub
Pages scope bug.

The initial red checks should assert:

- the manifest is discovered and its `id`, `start_url`, and `scope` stay inside
  `/dark-sky/`;
- all declared icon files exist at the expected sizes;
- the service worker registers, installs, activates, and controls the page;
- the core cache contains every required response;
- after the app reports `available offline`, a fresh page load and a reload work
  with the browser context offline;
- `#when`, `#where`, `#sky`, and nested in-page hashes still open the right
  panel offline;
- the calendar, spot cards, one curated horizon, and the sky viewer render
  offline;
- weather and map imagery show explicit offline states;
- an incomplete new installation leaves the previous complete cache usable;
- activating a new build removes only older Blue Ridge Skyline caches; and
- the assembled Pages artifact contains every manifest and precache target.

Run the offline browser check in a new browser context, not merely by blocking a
few requests in an already loaded page. The acceptance case is a cold PWA
launch after the online preparation has completed.

### Phase 2: localize assets and add the manifest

Vendor the fonts and Leaflet, create the icon set, add the manifest link, and
make the static artifact checks pass. Re-run the existing browser suite and
inspect fresh desktop and phone screenshots before proceeding.

### Phase 3: add the service worker and status UI

Implement registration, precaching, project-scoped cleanup, update handling,
and the readiness status. Make the cold offline launch and refresh checks pass.

Measure and record:

- staged application-shell bytes, both raw and gzip;
- install time on a normal connection and a throttled connection;
- cache storage use in a clean browser profile; and
- whether phone and desktop show `available offline` only after all core assets
  have been stored.

### Phase 4: add the bounded forecast store and map fallback

Add the tested IndexedDB forecast repository and connect the implemented
optional map bundle to the service worker's offline shell. Add distinct offline
states for saved weather and remote map imagery. Keep
local markers, Parkway geometry, cards, and horizon interactions working.
Confirm that returning online refreshes live forecasts and layers without
clearing user choices.

### Phase 5: deploy and verify on real devices

After local tests pass:

1. Build the exact Pages artifact locally.
2. Verify the workflow syntax and named artifact contents.
3. Deploy through the existing Pages workflow.
4. Install from Chrome or Edge and from Safari on an iPhone or iPad.
5. Wait for the in-app `available offline` signal.
6. Enable airplane mode, fully close the app, reopen it, visit each panel, and
   refresh on `#sky` and `#where`.
7. Restore connectivity and verify the forecast and map tiles recover.
8. Deploy a harmless version change and verify the update-ready path and old
   cache cleanup.

## Optional later release: detailed offline map pack

Treat a PMTiles basemap as a separate, deliberately designed feature. Use a
self-hosted regional extract, show the measured download size before starting,
bound its geography and zoom levels, report progress, support cancel and
delete, and retain the required attribution. Do not turn ordinary map browsing
into an unbounded tile cache.

## Acceptance criteria for version 1

- The site is installable from a secure GitHub Pages URL in Chromium-based
  browsers and opens as a Home Screen web app on current iOS and iPadOS.
- A first visit requires a connection and does not claim otherwise.
- The app says `available offline` only after the complete core cache exists.
- Airplane-mode cold launch and refresh work after that signal.
- Calendar, spots, saved home, terrain horizons, and the sky viewer work
  offline on desktop and phone layouts.
- Markers and the Parkway line render on a cold offline launch without
  contacting a tile server. If the user downloaded the optional maps, both
  local layers render too; they are not required for core PWA readiness.
- A previously viewed valid forecast survives a browser restart, shows its
  absolute retrieval time and coverage, and never presents itself as live after
  a failed update.
- An expired or schema-incompatible forecast is not used.
- Forecast storage is bounded and can be cleared without deleting the user's
  saved home.
- Fonts and Leaflet make no CDN request.
- No map, skyglow, or forecast request is silently served as current from an
  unbounded or unlabeled cache.
- Remote map and weather failures are visible and do not throw or block the
  rest of the page.
- GitHub Pages project-path scope is covered by an automated browser test.
- A failed update cannot destroy the last known complete offline release.
- A successful update does not delete caches belonging to another Pages app on
  the same origin.
- README and the field notes state exactly what works offline, what needs a
  connection, how to prepare before a trip, and how to refresh or clear saved
  content.

## Primary references

- [MDN: Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [MDN: Offline and background operation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)
- [MDN: PWA caching strategies](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Caching)
- [MDN: Using service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
- [WebKit: Web apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [MDN: Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [OpenStreetMap Foundation: Tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
- [Protomaps: basemap downloads and extracts](https://docs.protomaps.com/basemaps/downloads)
- [Protomaps: PMTiles command line interface](https://docs.protomaps.com/pmtiles/cli)
- [Protomaps: MapLibre integration](https://docs.protomaps.com/pmtiles/maplibre)
- [Protomaps: Leaflet integration](https://docs.protomaps.com/pmtiles/leaflet)
- [Protomaps: cloud storage and GitHub Pages](https://docs.protomaps.com/pmtiles/cloud-storage)
- [USGS: National Map data use and licensing](https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map?page=1)
- [Open-Meteo: forecast API](https://open-meteo.com/en/docs)
- [Open-Meteo: model update schedules](https://open-meteo.com/en/docs/model-updates)
- [Open-Meteo: data license](https://open-meteo.com/en/licence)
- [Open-Meteo: service terms](https://open-meteo.com/en/terms)

## Reproducing the measurements

From the repository root:

```powershell
node tools/check-tabs.mjs --shots
node -e "const fs=require('fs'),z=require('zlib');for(const f of ['index.html','assets/moon-full.jpg']){const b=fs.readFileSync(f);console.log(f,'raw='+b.length,'gzip='+z.gzipSync(b).length,'brotli='+z.brotliCompressSync(b).length)}"
$forecastPath = Join-Path $env:TEMP 'dark-sky-open-meteo-sample.json'; curl.exe -L --fail --silent --show-error "https://api.open-meteo.com/v1/forecast?latitude=35.4887&longitude=-82.9887&hourly=cloud_cover%2Ccloud_cover_low%2Ccloud_cover_mid%2Ccloud_cover_high%2Ctemperature_2m%2Cwind_speed_10m%2Cdew_point_2m%2Cprecipitation_probability&daily=sunrise%2Csunset&timezone=auto&forecast_days=8&temperature_unit=fahrenheit&wind_speed_unit=mph" -o $forecastPath; node -e "const fs=require('fs'),z=require('zlib');const b=fs.readFileSync(process.argv[1]);console.log({raw:b.length,gzip:z.gzipSync(b).length,brotli:z.brotliCompressSync(b).length})" $forecastPath
```

The browser check requires Chromium. On Windows, set `CHROMIUM_PATH` to the
installed Chrome executable if the bundled Playwright browser is unavailable.
