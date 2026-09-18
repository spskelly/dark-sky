"""one aerial crop per review row: usgs naip (public domain) around the pin,
osm roads, paths and parking drawn on top, the 60 m search ring, the pin and
the proposed spot. reads tools/.canopy-cache/suggest/*.json (current params
only); writes tools/.canopy-cache/review/crops/<slug>.jpg and osm.json.
naip imagery is usgs public domain; the road/path/parking overlay is
openstreetmap data, (c) OpenStreetMap contributors, ODbL. per-site
checkpoint: crops/<slug>.jpg written via .tmp and skipped when present; the
overpass answer is saved once as crops/osm.json."""
import glob, io, json, math, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import build_canopy as bc
import build_horizons as bh
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(bc.CACHE, 'review', 'crops')
os.makedirs(OUT, exist_ok=True)
HALF_M = 110.0     # metres from the pin to the crop edge: the 60 m ring plus room for the parking area
PX = 560
NAIP = ('https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage'
        '?bbox=%f,%f,%f,%f&bboxSR=3857&imageSR=3857&size=%d,%d&format=jpg&f=image')

params = bc.suggest_params()
rows = []
for p in glob.glob(os.path.join(bc.CACHE, 'suggest', '*.json')):
    with open(p, encoding='utf-8') as f:
        r = json.load(f)
    if r.get('params') == params:
        rows.append(r)
assert rows, 'no suggest rows for current params'
print('rows: %d' % len(rows))


def slug(r):
    return os.path.splitext(bh.cache_name({'name': r['name'], 'ov_id': r['key'][3:] if r['key'].startswith('ov:') else None}))[0]


def box(r):
    x, y = bc.mercator(r['lat'], r['lon'])
    h = HALF_M / math.cos(math.radians(r['lat']))
    return x - h, y - h, x + h, y + h


def osm():
    path = os.path.join(OUT, 'osm.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    parts = []
    for r in rows:
        d = HALF_M / 111320.0
        dl = d / math.cos(math.radians(r['lat']))
        bb = '%f,%f,%f,%f' % (r['lat'] - d, r['lon'] - dl, r['lat'] + d, r['lon'] + dl)
        parts += ['way["highway"](%s);' % bb, 'way["amenity"="parking"](%s);' % bb]
    q = '[out:json][timeout:90];(%s);out geom;' % ''.join(parts)
    for url in bc.OVERPASS:
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(), headers=bc.UA)
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            with open(path + '.tmp', 'w', encoding='utf-8') as f:
                json.dump(data, f)
            os.replace(path + '.tmp', path)
            return data
        except Exception as e:
            print('overpass %s failed: %s' % (url, e))
    print('no osm overlay; crops carry imagery and pins only')
    return {'elements': []}


def naip(r):
    x0, y0, x1, y1 = box(r)
    with urllib.request.urlopen(urllib.request.Request(NAIP % (x0, y0, x1, y1, PX, PX), headers=bc.UA), timeout=60) as resp:
        return resp.read()


def render(r, blob, ways):
    img = Image.open(io.BytesIO(blob)).convert('RGB')
    x0, y0, x1, y1 = box(r)
    to = lambda lat, lon: ((bc.mercator(lat, lon)[0] - x0) / (x1 - x0) * PX, (y1 - bc.mercator(lat, lon)[1]) / (y1 - y0) * PX)
    ov = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for w in ways:
        pts = [to(g['lat'], g['lon']) for g in w.get('geometry', [])]
        if len(pts) < 2:
            continue
        t = w.get('tags', {})
        if t.get('amenity') == 'parking':
            d.polygon(pts, fill=(255, 255, 255, 45), outline=(255, 255, 255, 230))
        elif t.get('highway') in bc.ROADS:
            d.line(pts, fill=(20, 20, 20, 200), width=7, joint='curve')
            d.line(pts, fill=(235, 235, 235, 235), width=4, joint='curve')
        elif t.get('highway') in bc.PATHS:
            for a, b in zip(pts, pts[1:]):
                n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) // 6))
                for k in range(0, n, 2):
                    p = (a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n)
                    q = (a[0] + (b[0] - a[0]) * min(k + 1, n) / n, a[1] + (b[1] - a[1]) * min(k + 1, n) / n)
                    d.line([p, q], fill=(255, 214, 64, 255), width=3)
    px_per_m = PX / (2 * HALF_M)
    c = PX / 2
    ring = bc.SEARCH_R * px_per_m
    for k in range(0, 360, 6):
        a0, a1 = math.radians(k), math.radians(k + 3)
        d.line([(c + ring * math.sin(a0), c - ring * math.cos(a0)), (c + ring * math.sin(a1), c - ring * math.cos(a1))], fill=(255, 255, 255, 170), width=2)
    font = ImageFont.load_default(size=15)
    if r['spot'] is not None:
        sx, sy = to(*r['spot'])
        d.line([(c, c), (sx, sy)], fill=(20, 20, 20, 220), width=5)
        d.line([(c, c), (sx, sy)], fill=(120, 200, 255, 255), width=2)
        d.ellipse([sx - 8, sy - 8, sx + 8, sy + 8], fill=(80, 170, 255, 255), outline=(255, 255, 255, 255), width=3)
        d.text((sx + 11, sy - 9), 'spot', font=font, fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0, 255))
    d.ellipse([c - 9, c - 9, c + 9, c + 9], outline=(0, 0, 0, 255), width=6)
    d.ellipse([c - 9, c - 9, c + 9, c + 9], outline=(255, 150, 40, 255), width=3)
    d.text((c + 12, c - 9), 'pin', font=font, fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0, 255))
    bar = 25 * px_per_m
    d.rectangle([14, PX - 26, 14 + bar, PX - 20], fill=(255, 255, 255, 255), outline=(0, 0, 0, 255))
    d.text((18 + bar, PX - 33), '25 m', font=font, fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0, 255))
    img = Image.alpha_composite(img.convert('RGBA'), ov).convert('RGB')
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=78, optimize=True)
    return buf.getvalue()


def ways_near(r, elements):
    x0, y0, x1, y1 = box(r)
    out = []
    for w in elements:
        for g in w.get('geometry', []):
            x, y = bc.mercator(g['lat'], g['lon'])
            if x0 <= x <= x1 and y0 <= y <= y1:
                out.append(w)
                break
    return out


def one(i_r):
    i, r = i_r
    path = os.path.join(OUT, slug(r) + '.jpg')
    if os.path.exists(path):
        return '%s cached' % r['name']
    blob = naip(r)
    jpg = render(r, blob, ways_near(r, elements))
    with open(path + '.tmp', 'wb') as f:
        f.write(jpg)
    os.replace(path + '.tmp', path)
    return '%s %d kB' % (r['name'], len(jpg) // 1024)


elements = osm().get('elements', [])
print('osm ways: %d' % len(elements))
done = 0
with ThreadPoolExecutor(4) as pool:
    for msg in pool.map(one, enumerate(rows)):
        done += 1
        print('[%s] %d/%d %s' % (time.strftime('%H:%M:%S'), done, len(rows), msg), flush=True)
