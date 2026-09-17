// one polite, stubborn overpass client, shared by the tools that need osm.
//
// overpass-api.de answers 406 Not Acceptable to node's default user agent, so
// say who we are; the mirrors are tried in turn when one is down, busy, or in a
// mood, which for overpass is a normal tuesday.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const HEADERS = {
  'content-type': 'application/x-www-form-urlencoded',
  'accept': 'application/json',
  'user-agent': 'dark-sky-calendar tools (+https://github.com/spskelly/dark-sky)',
};

// overpass says why it said no in the body, and that is usually the useful half
const reason = async res => (await res.text().catch(() => ''))
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
const wait = ms => new Promise(r => setTimeout(r, ms));

export async function ask(query) {
  const tried = [];
  for (const url of ENDPOINTS) {
    const host = new URL(url).host;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`asking ${host}…`);
      let res;
      try {
        res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: HEADERS });
      } catch (e) { tried.push(`${host}: ${e.message}`); break; }
      if (res.ok) return res.json();
      const why = await reason(res);
      tried.push(`${host}: ${res.status} ${res.statusText}${why ? ': ' + why : ''}`);
      // busy or rate limited rather than broken: a 429 means the slot is taken
      // and clears when whatever is running finishes, which takes rather longer
      // than five seconds
      if ((res.status !== 429 && res.status !== 504) || attempt === 3) break;
      const pause = [10000, 30000][attempt - 1];
      console.log(`  ${res.status} ${res.statusText || 'busy'}${why ? ': ' + why.slice(0, 70) : ''}, waiting ${pause / 1000}s`);
      await wait(pause);
    }
  }
  throw new Error('no overpass endpoint would answer:\n  ' + tried.join('\n  '));
}
