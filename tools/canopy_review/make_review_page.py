"""build the standing-spot review page from the saved suggest rows and the
crops make_crops.py wrote. reads tools/.canopy-cache/suggest/*.json (current
params only) and tools/.canopy-cache/review/crops/<slug>.jpg; writes
tools/.canopy-cache/review/review.html. naip imagery is usgs public domain;
the road/path/parking overlay in each crop is openstreetmap data, (c)
OpenStreetMap contributors, ODbL."""
import base64, glob, html, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import build_canopy as bc
import build_horizons as bh

REVIEW = os.path.join(bc.CACHE, 'review')
CROPS = os.path.join(REVIEW, 'crops')
OUT = os.path.join(REVIEW, 'review.html')
params = bc.suggest_params()
decks = {s['key']: s['deck'] for s in bc.site_list(bh.read_html())}
rows = []
for p in glob.glob(os.path.join(bc.CACHE, 'suggest', '*.json')):
    with open(p, encoding='utf-8') as f:
        r = json.load(f)
    if r.get('params') == params:
        rows.append(r)
assert rows, 'no suggest rows for current params'
print('rows: %d' % len(rows))
SAT = 'https://www.google.com/maps/@%.6f,%.6f,40m/data=!3m1!1e3'


def group(r):
    if r['spot'] is None:
        return 'none'
    return 'move' if r['before'] - r['after'] >= 5 else 'marginal'


order = {'move': 0, 'marginal': 1, 'none': 2}
rows.sort(key=lambda r: (order[group(r)], -r['before']))
e = html.escape


def bar(v):
    """tree altitude on the page's 0 to 80 scale, as a width percent"""
    return max(0.0, min(80.0, v)) / 80 * 100


def row_html(n, r):
    g = group(r)
    flags = []
    if decks.get(r['key']):
        flags.append('<span class="flag warn">tower site: the page defaults to the ground view, the deck is what people climb</span>')
    if r['spot'] is not None:
        if abs(r['dz_m']) >= 5:
            flags.append('<span class="flag">%s %.1f m %s the pin</span>' % ('climbs' if r['dz_m'] > 0 else 'drops', abs(r['dz_m']), 'above' if r['dz_m'] > 0 else 'below'))
        if r['under_trees_m'] and r['under_trees_m'] >= 0.8 * r['moved_m']:
            flags.append('<span class="flag">the straight walk is under trees the whole way</span>')
    kind = 'overlook' if r['key'].startswith('ov:') else 'spot'
    head = '<div class="site"><span class="rid">R%d</span><b>%s</b> <span class="kind">%s</span><code>%s</code></div>' % (
        n, e(r['name']), kind, e(r['key']))
    pin = '<a href="%s" target="_blank" rel="noopener">pin</a>' % (SAT % (r['lat'], r['lon']))
    if r['spot'] is None:
        if r.get('best_median') is not None:
            best = 'best within %g m: %.0f&deg; at %.0f m, %.0f m %s%s' % (
                bc.SEARCH_R, r['best_median'], r['best_m'], abs(r['best_dz_m']), 'up' if r['best_dz_m'] >= 0 else 'down',
                ' (grid estimate, reads high)' if r.get('best_by') == 'grid' else '')
        else:
            best = 'no level ground within %g m' % bc.SEARCH_R
        body = ('<div class="nums"><div class="alt"><span class="lbl">trees now</span><span class="v">%.0f&deg;</span>'
                '<span class="track"><i class="now" style="width:%.1f%%"></i></span></div>'
                '<div class="open"><span class="lbl">open sky now</span><span class="v">%.0f%%</span></div></div>'
                '<p class="best">%s</p>' % (r['before'], bar(r['before']), r['open_before'], best))
        links = pin
    else:
        body = ('<div class="nums"><div class="alt"><span class="lbl">trees</span><span class="v">%.0f&deg; &rarr; %.0f&deg;</span>'
                '<span class="track"><i class="now" style="width:%.1f%%"></i><i class="then" style="width:%.1f%%"></i></span></div>'
                '<div class="open"><span class="lbl">open sky</span><span class="v">%.0f%% &rarr; %.0f%%</span></div>'
                '<div class="walk"><span class="lbl">move</span><span class="v">%.0f m at %03d&deg;, %+.1f m</span></div></div>' % (
                    r['before'], r['after'], bar(r['before']), bar(r['after']), r['open_before'], r['open_after'],
                    r['moved_m'], round(r['bearing']) % 360, r['dz_m']))
        links = '%s <a href="%s" target="_blank" rel="noopener">spot</a> <span class="coord">%.6f, %.6f</span>' % (
            pin, SAT % tuple(r['spot']), r['spot'][0], r['spot'][1])
    slug = os.path.splitext(bh.cache_name({'name': r['name'], 'ov_id': r['key'][3:] if r['key'].startswith('ov:') else None}))[0]
    with open(os.path.join(CROPS, slug + '.jpg'), 'rb') as f:
        src = 'data:image/jpeg;base64,' + base64.b64encode(f.read()).decode()
    alt = 'aerial view of %s: the pin%s, the 60 m search ring and nearby roads and paths' % (
        e(r['name']), '' if r['spot'] is None else ' and the proposed spot')
    fl = '<div class="flags">%s</div>' % ''.join(flags) if flags else ''
    return ('<li class="row %s"><img class="crop" src="%s" alt="%s" width="560" height="560">'
            '<div class="info">%s%s%s<div class="links">%s</div></div></li>') % (g, src, alt, head, body, fl, links)


sections = [
    ('move', 'Real moves', 'The spot opens the sky by 5 degrees or more. Approve, reject, or give a better coordinate; say if the walk needs a line on the card.'),
    ('marginal', 'Marginal moves', 'The pin was barely over 30 and the spot gains under 5 degrees. My suggestion: reject these and keep the pin.'),
    ('none', 'No clear spot within 60 m', 'Nothing level within 60 m gets the trees under 30. These stay as they are unless you know a better place to stand.'),
]
n = 0
parts = []
counts = {}
for key, title, blurb in sections:
    items = [r for r in rows if group(r) == key]
    counts[key] = len(items)
    lis = []
    for r in items:
        n += 1
        lis.append(row_html(n, r))
    first, last = n - len(items) + 1, n
    parts.append('<section id="%s"><h2>%s <span class="count">R%d to R%d &middot; %d sites</span></h2><p class="blurb">%s</p><ol class="rows">%s</ol></section>' % (
        key, title, first, last, len(items), blurb, ''.join(lis)))

page = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'review_template.html'), encoding='utf-8').read()
page = page.replace('{{SECTIONS}}', ''.join(parts))
for k, v in counts.items():
    page = page.replace('{{%s}}' % k.upper(), str(v))
os.makedirs(REVIEW, exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(page)
print('wrote', OUT, counts)
