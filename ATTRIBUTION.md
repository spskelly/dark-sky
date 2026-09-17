# Third-party sources and attribution

Checked September 13, 2026 against the sources linked below. The site exposes
credits beside forecasts and the map, in its footer, and in **sources & credits**.
This inventory covers the runtime data and assets, the generated social image,
and the development dependencies present in this repository.

| Material | Source and terms | Credit / handling here |
| --- | --- | --- |
| Light-pollution overlay | [David Lorenz's atlas](https://djlorenz.github.io/astronomy/lp/), currently the 2025 tiles. A separate license for the rendered tiles was not found; see the open question below. | Author and atlas links on the map and below it. Reduced opacity is disclosed. Colors describe simulated zenith brightness, not Bortle classes. The per-point readings (`SKY`, `OVERLOOK_SKY`) sample the same atlas at each of the 40 curated spots and the 122 parkway overlooks. |
| Underlying nighttime lights | [EOG VIIRS Nighttime Lights](https://eogdata.mines.edu/products/vnl/), Earth Observation Group, Payne Institute for Public Policy, Colorado School of Mines. [EOG license and credit instructions](https://eogdata.mines.edu/files/EOG_products_CC_License.pdf), CC BY 4.0 for VNL. | The map carries EOG's compact source credit. Expanded credits identify EOG and NOAA VIIRS, and distinguish Lorenz's atmospheric model from satellite observations. |
| Topographic tiles | [OpenTopoMap usage instructions](https://opentopomap.org/about#verwendung), CC BY-SA 3.0; data from OpenStreetMap and SRTM. | Linked map/data/license credits. The site's dimming is disclosed; map imagery retains its source license. |
| Parkway geometry | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), obtained using Overpass. | OSM attribution persists on the imagery basemap. The simplified coordinate extract is distributed under ODbL in `index.html` (`PARKWAY`); `tools/build-parkway.mjs` contains the query, bounds and simplification method. The overlook points are the same source and licence, distributed in `index.html` as `OVERLOOKS`; the query is in `tools/build-overlooks.mjs`. |
| Imagery basemap | [USGSImageryOnly service metadata](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer), which credits USDA and USGS The National Map: Orthoimagery. | Both agencies credited and linked. Expanded credits include USGS's [requested acknowledgment](https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map). The service mentions restrictions on Alaska SPOT imagery; do not assume every image served worldwide is public domain. This project's area is western North Carolina. |
| Forecast data | [Open-Meteo license](https://open-meteo.com/en/license), CC BY 4.0. | Provider and license links beside both hourly forecast panels and the calendar's cloud summaries. Rounding, nightly aggregation and derived conditions are identified as this site's calculations. The API's software license (AGPL) is separate from the data license; we consume the API, not its server code. |
| Moon surface | [NASA SVS full-moon still](https://svs.gsfc.nasa.gov/5415/), visualization by Ernie Wright from LRO data. [SVS usage policy](https://svs.gsfc.nasa.gov/help/) and [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/). | NASA source credit on the main site, standalone preview and `og.png`. The crop, rotation and phase mask are disclosed. Original file and source details: [assets/README.md](assets/README.md). |
| Fonts | Fraunces Project Authors and IBM (IBM Plex Sans), SIL Open Font License 1.1. The installed Fontsource packages include the actual notices. | [Fraunces notice](assets/licenses/fraunces-OFL.txt) and [Plex notice](assets/licenses/ibm-plex-sans-OFL.txt) retained. Fonts load through Google Fonts on the site; local Fontsource fonts are used when rendering the social card. The exported PNG does not redistribute font software. |
| Map software | [Leaflet 1.9.4](https://github.com/Leaflet/Leaflet/blob/v1.9.4/LICENSE), BSD 2-Clause. | Leaflet's map credit remains; the [complete notice](assets/licenses/leaflet-BSD.txt) is retained and linked. Loaded from cdnjs. |
| Development tooling | Playwright / playwright-core, Apache-2.0, with additional bundled notices in the installed packages. | Used only for local/CI rendering. Package licenses stay in `node_modules`; the browser/tooling is not bundled into the site or image. GitHub Actions are CI services, not shipped assets. |
| Astronomy and editorial material | Phase calculations identify Jean Meeus, *Astronomical Algorithms*, chapter 49. Site SVG icons and spot notes are authored in the page. | Meeus credited in the footer. There are no copied book pages, external icon packs or embedded photos of the destinations in the inspected source. Links to Clear Outside, lightpollutionmap.info, Google Maps and land managers lead to their sites; their maps/content are not embedded here. |

## Open question: Lorenz's rendered tiles

The atlas page explicitly discusses other sites using his maps and asks users
not to equate their colors with Bortle classes. It identifies the EOG input
data and Cinzano model. I did not find an explicit license or hotlinking grant
for the rendered tiles on the atlas page or in the repository audit below.
EOG's CC BY 4.0 input-data license does not establish the terms of Lorenz's
separate rendered product.

How that sentence is read here, as of 2026-09-17. The atlas page says: "If you
use my maps on your site, I ask that you do not conflate the Bortle Scale with
my maps." That presumes reuse and sets one condition on it, so it is taken as
conditional permission given informally, and relied on for a non-commercial
site that credits and links the atlas. It is not a license: it says nothing of
terms, redistribution, direct tile requests, or sampling the tiles into a
per-spot reading, which is what `tools/build-skyglow.mjs` does. The condition
is met: the page uses the word Bortle once, in the credits, to say the colors
"describe modelled artificial sky brightness at zenith, not Bortle classes",
which is his own point restated. The only other occurrence in the repository
is the URL of his legend page inside that script. Keep it that way.

The follow-up repository check examined the complete current file tree
(24,151 entries, not truncated), the 24 README/homepage/astronomy text files,
all four issues/pull requests and their comments, and available commit messages.
GitHub reports no repository license, and there is no license file in the tree.
The root README contains only the repository name. Licenses found inside
bundled JavaScript apply to those libraries, not the atlas tiles.

Most directly, [issue #2, “Missing licence info”](https://github.com/djlorenz/djlorenz.github.io/issues/2),
opened February 22, 2022, remains open with zero comments as of this check.
No permission statement was found in the other issue comments. Snapshot checked:
`afb94a2627325fc0915b66240050d67b95d12a74`.

The source code's unsupported claim that these tiles are free to hotlink has
been removed. Existing layer behavior is retained with clearer attribution;
that change is not a claim that reuse permission has been confirmed.

For a definitive answer, the atlas lists David Lorenz at `dlorenz@wisc.edu`.
The question to resolve is permission to display his hosted 2025 tiles on this
public, non-commercial stargazing site, whether direct tile requests are
acceptable, and which credit/license he wants attached. No message has been sent.

### Request volume, measured 2026-09-17

The build script now caches every tile and legend page it reads
(`tools/.skyglow-cache/`, gitignored; see
[docs/horizon_panorama.md](docs/horizon_panorama.md#caches)), so a normal run
of `build-skyglow.mjs` asks djlorenz.github.io for nothing once the cache is
warm. Building this feature cost that host 34 requests from the build script
(24 tile, 10 legend page), including one diagnostic re-run of the old,
uncached script.

Worth telling the atlas's author directly: until 2026-09-17, every run of
this project's own browser check (`tools/check-tabs.mjs`) also pulled live
atlas tiles, because the light pollution layer is on by default and the check
did not handle that host. That traffic was never counted, including in the 34
above. The check now answers those requests locally instead.

## Maintenance

- Keep source/license credits when changing map providers. The tile URL repair
  tool now preserves the curated atlas credit instead of replacing it with a
  directory URL.
- The [Open-Meteo free API terms](https://open-meteo.com/en/terms) permit
  non-commercial use within stated request limits. Revisit the API plan if the
  site adds advertising, subscriptions or other commercial use.
- When sharing map screenshots, retain the relevant map credits and license
  links/text. The exported social card contains the moon, not these map layers.
