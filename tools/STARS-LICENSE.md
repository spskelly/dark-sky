# Star catalogue and constellation figures: license check

Checked September 16, 2026, for the horizon panorama's sky layer
(part 2 of its design spec, which is kept out of the public repository).
Every claim below was read at the URL given, not inferred from a summary.

Outcome: both the stars and the stick figures shipped, from sources with
explicit, verifiable licenses. The design spec's expected answer for the stars
(Yale BSC via ADC/CDS) was checked first and **rejected**, because CDS does not
actually grant redistribution. See the table.

## Verdicts

| Source | What it is | License found | Verified at | Verdict |
| --- | --- | --- | --- | --- |
| **HYG Database v4.1** | Compiled star catalogue: Hipparcos + Yale Bright Star (5th ed.) + Gliese, with positions, magnitudes, proper names, constellation ids. | Creative Commons Attribution-ShareAlike 4.0 International, stated in a `LICENSE` file that sits beside the data files themselves. | [`hyg/CURRENT/LICENSE`](https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/LICENSE) (identical text at the repo root), and the project page [astronexus.com/projects/hyg](https://astronexus.com/projects/hyg): "The HYG database is licensed with the Creative Commons Attribution-ShareAlike 4.0 license." | **USED.** Clear grant, share-alike, attribution required. Same shape as the ODbL parkway extract already shipped in `index.html`. |
| **Yale Bright Star Catalogue, 5th rev. ed. (V/50) via CDS/VizieR** | The catalogue the spec expected to use. | **No redistribution grant found.** VizieR's rules of usage say data are "free of usage in a scientific context" with citation, and that "the commercial usage of the data is subject to rules depending of the origin", deferring to each catalogue's own ReadMe. The V/50 ReadMe contains no license, copyright or acknowledging statement at all; it says only that this preliminary version was "available only for dissemination on the Astronomical Data Center CD ROM". | [cds.unistra.fr/vizier-org/licences_vizier.html](https://cds.unistra.fr/vizier-org/licences_vizier.html) and [cdsarc.cds.unistra.fr/viz-bin/ReadMe/V/50](https://cdsarc.cds.unistra.fr/viz-bin/ReadMe/V/50) | **REJECTED as a direct source.** "Free for scientific use, cite the authors, commercial use unclear" is a use permission, not a redistribution license, and this repository ships its data inline on a public site. This is the same gap already documented for Lorenz's tiles in `ATTRIBUTION.md`. The BSC content reaches the page anyway, but through HYG's explicit CC BY-SA 4.0 compilation rather than on an assumption about V/50. |
| **d3-celestial `data/constellations.lines.json`** | Constellation stick figures as GeoJSON MultiLineStrings at J2000. | BSD 3-Clause, "Copyright (c) 2015, Olaf Frohn". | [`LICENSE`](https://github.com/ofrohn/d3-celestial/blob/master/LICENSE) and the repo page [github.com/ofrohn/d3-celestial](https://github.com/ofrohn/d3-celestial) | **USED**, after tracing the provenance below. |
| **IAU constellation charts** (the upstream of those lines) | The charts d3-celestial digitised. | Creative Commons Attribution 4.0 International. Page states: "The charts below were produced in collaboration with Sky & Telescope magazine (Roger Sinnott and Rick Fienberg)", "Alan MacRobert's constellation patterns, drawn in green on the charts, were influenced by those of H. A. Rey but, in many cases, were adjusted to preserve earlier traditions", and "The images are released under the Creative Commons Attribution 4.0 International license." | [iauarchive.eso.org/public/themes/constellations/](https://iauarchive.eso.org/public/themes/constellations/) | **USED**, with the caveat recorded below. CC BY 4.0 permits adaptations under different terms so long as attribution survives, so the BSD relicensing of a digitisation is legitimate, and there is no GPL anywhere in this chain. |
| **Stellarium sky cultures** | The GPL concern the spec raised. | Not used, and not in the chain for what is shipped. | d3-celestial's own source list, [readme.md](https://github.com/ofrohn/d3-celestial/blob/master/readme.md) items \[1c\] and \[10\] | **NOT USED.** d3-celestial draws on Stellarium only for star-name *translations* (\[1c\]) and for the traditional Chinese constellations in the `*.cn.json` files (\[10\]). The default IAU-culture `constellations.lines.json` is item \[3\], the IAU page. Neither Stellarium file is fetched by `build-starcat.mjs`. This was the specific risk to check, and it does not apply. |
| **d3-celestial `data/stars.*.json`** | The obvious one-source alternative for the stars. | BSD 3-Clause as shipped, but the underlying data is XHIP, VizieR V/137D, which lands back in the same unresolved VizieR terms as V/50. | d3-celestial [readme.md](https://github.com/ofrohn/d3-celestial/blob/master/readme.md) item \[1\] | **NOT USED.** HYG states its license over the data itself; this states it over a repository that is mostly software. HYG is the better-evidenced grant, so the stars come from HYG even though it costs a second source and a second credit. |

### The one caveat worth writing down

The IAU's CC BY 4.0 grant is worded over "the images". The vertex list in
`constellations.lines.json` is a digitisation of those images by Olaf Frohn,
plus (his words) "some line modifications by me". The stick figures themselves
are Alan MacRobert's, "influenced by" H. A. Rey's, whose 1952 book is still in
copyright. So the chain is: Rey's patterns influenced MacRobert's patterns,
which the IAU published as CC BY 4.0 charts, which Frohn digitised and released
BSD.

That chain holds, because a set of line segments joining catalogued star
positions is closer to a fact than to an expressive work, and because every step
after Rey carries a license that permits the next one. It is recorded here
rather than glossed over, and the credit line names every party in it.

## Verification of the built data

Run by `tools/build-starcat.mjs` itself, so a bad download or a changed upstream
column order fails the build rather than shipping silently:

```
ok  Sirius   [0]  ra 101.29 dec -16.72 mag -1.44 (0.0000 deg from expected)
ok  Polaris  [47] ra 37.95  dec 89.26  mag 1.97  (0.0000 deg from expected)
ok  Vega     [4]  ra 279.23 dec 38.78  mag 0.03  (0.0000 deg from expected)
```

Independent evidence that the line indices are right: all 893 line vertices in
`constellations.lines.json` match an HYG star to a **median separation of
0.0000 degrees** and a worst case of 0.0045 degrees, measured before rounding.
d3-celestial's XHIP positions and HYG's Hipparcos positions are the same
measurements, so the nearest-star index mapping is exact, not approximate. The
0.35 degree match tolerance in the script has four orders of magnitude of
headroom.

The generated file was also evaluated in a `node:vm` and checked independently
of the builder: 1,046 records, every record 3 to 5 elements, every ra in
[0, 360), every |dec| <= 90, the array sorted by magnitude, every `lineOnly`
flag set on exactly the records fainter than 4.5 and on no others, every
constellation index a valid integer index into `STARS`, every run at least 2
long, and every line vertex pointing at a star that is either within the
magnitude limit or flagged.

## What the catalogue actually contains

Every star to magnitude 4.5, **plus** the 121 fainter stars that a constellation
line needs in order to close its figure. Nothing else fainter than 4.5 is
admitted, so the selection rule is a sentence you can defend rather than a
cutoff nobody chose. The extras are stored at their true magnitude and carry a
flag, so the renderer draws them as faint as they are and never promotes them.

Record format in `tools/stars.js`:

```js
[ra, dec, mag, name?, lineOnly?]
[101.29,-16.72,-1.44,"Sirius"]   // named, in the magnitude 4.5 catalogue
[17.92,30.09,4.51,0,1]           // unnamed, present only to close a figure
[284.05,4.2,4.62,"Alya",1]       // named, and also only present for a figure
```

Arrays rather than objects, because nothing looks these up by key. `ra` and
`dec` are rounded to 0.01 degree, which is 36 arcsec: at the panorama's roughly
3 px per degree that is 0.03 px, invisible by three orders of magnitude, and
precession is corrected at render time anyway. `mag` keeps 2 decimals because it
drives the symbol size. Unnamed stars are 3-element arrays with no `null`
placeholder; an unnamed line-only star carries `0` in the name slot purely to
hold the flag's position.

## Measured results, 2026-09-16

| Quantity | Value |
| --- | --- |
| Stars in `STARS` | **1,046** (295 with proper names) |
| of which, magnitude <= 4.5 | 925 |
| of which, fainter, required by a line | 121 (magnitude 4.51 to 6.62; 7 of them named) |
| `tools/stars.js` total | **29,868 bytes** |
| of that, the `STARS` block | **25,678 bytes** |
| Same file, gzip -9 / brotli | 12,875 / 10,698 bytes |
| Constellation line runs | **150, from 150 source polylines** |
| Vertices dropped | **0**, out of 893 |
| Constellations still incomplete | **none, 0 of 88** |
| Build time, warm cache | 1.1 s |
| HYG download, cached | 33,932,548 bytes |
| d3-celestial lines download, cached | 27,136 bytes |

Every one of the 88 constellations is complete: the emitted run count equals the
source polyline count exactly, so no figure was broken anywhere. This replaces
the earlier state of the build, where a strict magnitude 4.5 cut left 7
constellations with no line at all and 47 partially broken, Ursa Minor among
them with an open Little Dipper bowl.

Two design-spec estimates were wrong and are being corrected in the spec, not
worked around here:

- "About 500 stars to magnitude 4.5" is really the count to magnitude 4.0. The
  true count at 4.5 is 925, and the shipped catalogue is 1,046 with the figure
  stars.
- "Roughly 15 KB" was never reachable at that star count. 25.7 KB for the star
  block is the honest figure in the array format, and GitHub Pages serves it
  gzipped at 12.9 KB. No hand-rolled packing or base64 codec is used, and none
  is warranted: gzip already does that work, and a custom codec is something
  somebody would have to decode at 3am.

## Draft credit line for the `#credits` block in `index.html`

To be inserted after the `<b>moon.</b>` item, matching the existing entries'
wording style. Not applied by this document.

```html
<li><b>stars &amp; constellations.</b> Star positions, magnitudes and proper names from the <a href="https://astronexus.com/projects/hyg">HYG Database</a> v4.1 by Astronomy Nexus, <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>, itself compiled from the Hipparcos, Yale Bright Star (5th ed.) and Gliese catalogues. Constellation stick figures from <a href="https://github.com/ofrohn/d3-celestial">d3-celestial</a> by Olaf Frohn, BSD 3-Clause, digitised from the <a href="https://iauarchive.eso.org/public/themes/constellations/">IAU constellation charts</a> made with Sky &amp; Telescope magazine (Roger Sinnott and Rick Fienberg; patterns by Alan MacRobert), <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. The extract covers every star to magnitude 4.5 plus the fainter ones the figures need, and is available under its own license in this page&rsquo;s source (<code>STARS</code>, <code>CONSTELLATION_LINES</code>).</li>
```

## Draft `ATTRIBUTION.md` rows

Two rows for the inventory table, matching the existing column pattern
(Material / Source and terms / Credit and handling here).

```markdown
| Star catalogue | [HYG Database](https://astronexus.com/projects/hyg) v4.1, Astronomy Nexus, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) per the [LICENSE beside the data](https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/LICENSE). A compilation of the Hipparcos, Yale Bright Star (5th ed.) and Gliese catalogues. | An extract of 1,046 stars with right ascension, declination, magnitude and proper name, being every star to magnitude 4.5 plus the 121 fainter ones a constellation line needs, is available under CC BY-SA 4.0 in `index.html` (`STARS`); `tools/build-starcat.mjs` contains the source URL, the selection rule and the rounding. The Yale BSC was checked at CDS/VizieR first and not used directly: VizieR grants scientific use with citation, not redistribution, and catalogue V/50's ReadMe carries no license statement. See `tools/STARS-LICENSE.md`. |
| Constellation figures | [d3-celestial](https://github.com/ofrohn/d3-celestial) `constellations.lines.json`, (c) 2015 Olaf Frohn, BSD 3-Clause, digitised from the [IAU constellation charts](https://iauarchive.eso.org/public/themes/constellations/) produced with Sky & Telescope magazine (Roger Sinnott and Rick Fienberg), patterns by Alan MacRobert, images [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). | Line vertices are resolved to indices into `STARS` and distributed in `index.html` (`CONSTELLATION_LINES`). Frohn, the IAU, Sky & Telescope and MacRobert are all credited on the page. Stellarium's sky cultures are GPL and are **not** used: d3-celestial draws on them only for name translations and its separate Chinese files, neither of which is fetched. Provenance chain and its one caveat: `tools/STARS-LICENSE.md`. |
```

## Does ShareAlike over a database extract need more than the ODbL precedent got?

Short answer: no. The draft credit line above follows the established pattern
exactly, and that pattern is the right one for CC BY-SA 4.0 as well, for a
reason written into the license rather than by analogy.

The parkway precedent says, in `ATTRIBUTION.md`, "The simplified coordinate
extract is distributed under ODbL in `index.html` (`PARKWAY`)", and on the page,
"available under ODbL in this page's source". It names the license, scopes it to
the named extract, points at the builder, and does not relicense the page. The
star draft does the same three things for `STARS`.

Why that scoping is correct here and not just convenient: CC BY-SA 4.0 section
4(b) is the database clause, and it says that where you include a substantial
portion of the contents in a database of your own, "the database in which You
have Sui Generis Database Rights (but not its individual contents) is Adapted
Material". The adapted thing is the extract, not the page around it and not the
canvas drawn from it. That is the same shape as ODbL's split between a
Derivative Database and a Produced Work, reached by a different route. So
`STARS` carries CC BY-SA 4.0, and `index.html` does not become CC BY-SA.

Three things worth doing anyway, two of which are already done:

1. **Keep the license next to the data, not only in the credits.** The generated
   block carries its own attribution comment immediately above `const STARS`, so
   anyone who copies the array out of the page copies the license with it. The
   parkway block does not do this. It is a small improvement over the precedent
   and costs one line. Done.
2. **Do not merge the two licenses into one sentence.** `STARS` is CC BY-SA 4.0
   and `CONSTELLATION_LINES` is BSD 3-Clause over CC BY 4.0 material. The draft
   credit keeps them in separate clauses. Merging them would be the actual
   mistake here, and it is an easy one to make because they arrive together.
   Done.
3. **If this repository ever gets a LICENSE file, name both inlined extracts in
   it**, the way the ODbL parkway data would need naming. Not actionable yet, no
   LICENSE file exists. This is the one item left open.

One thing the record should not overstate: star positions and magnitudes are
measurements, the United States has no sui generis database right, and under
Feist a compilation of facts is thin copyright at best. The obligation being
honoured here is largely the stated wishes of the compiler rather than a
provable legal duty. That is the same posture this project already takes with
Lorenz's tiles, in the opposite direction: absence of a grant is treated as
absence of permission, and presence of a grant is honoured on its own terms,
without lawyering either one.

## Re-running

```sh
node tools/build-starcat.mjs
```

About 20 seconds on a cold cache, dominated by the 34 MB HYG download; 1.1 s
once `tools/.starcat-cache/` exists (gitignored). Downloads are written
to a temp name and renamed, so an interrupted fetch does not poison the cache.
Delete a cached file to force a re-fetch. The script asserts Sirius, Polaris and
Vega before writing, so a changed upstream column order fails loudly.
