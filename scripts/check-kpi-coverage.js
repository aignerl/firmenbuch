'use strict';
const { sucheUrkunde, getUrkunde } = require('../services/firmenbuch');
const { parseJahresabschluss } = require('../services/jahresabschluss');

const testFirmen = [
  { fnr: '66763k', name: 'voestalpine AG' },
  { fnr: '93050d', name: 'OMV AG' },
  { fnr: '34261i', name: 'JUFA Holding GmbH' },
  { fnr: '41387p', name: 'MediaMarkt Graz' },
  { fnr: '200751g', name: 'Spar Österreich' },
  { fnr: '111420m', name: 'Lidl Austria' },
  { fnr: '78998m', name: 'Österreichische Post AG' },
  { fnr: '100014f', name: 'F.X. Mayr Holding GmbH' },
  { fnr: '100017i', name: 'Accenture GmbH' },
];

async function checkFirma(fnr, name) {
  try {
    const urkunden = await sucheUrkunde({ fnr });
    const xmlU = urkunden.filter(u => u.dateiendung === 'xml');
    if (!xmlU.length) { console.log(`keine XML:  ${name} (${fnr})`); return null; }
    const newest = xmlU.sort((a, b) => (b.stichtag || '').localeCompare(a.stichtag || ''))[0];
    const { content } = await getUrkunde({ key: newest.key });
    const { kpis } = await parseJahresabschluss(content);
    const entries = Object.entries(kpis);
    const available = entries.filter(([, v]) => v && (v.betrag !== null || v.betragVJ !== null));
    const missing   = entries.filter(([, v]) => !v || (v.betrag === null && v.betragVJ === null));
    console.log(`${available.length}/${entries.length}  ${name} (${fnr})  GJ: ${newest.stichtag || newest.dokumentendatum || '?'}`);
    if (missing.length) console.log(`         fehlt: ${missing.map(([k]) => k).join(', ')}`);
    return { fnr, name, available: available.length };
  } catch (e) {
    console.log(`Fehler: ${name} (${fnr}): ${e.message.slice(0, 80)}`);
    return null;
  }
}

(async () => {
  const results = [];
  for (const f of testFirmen) {
    const r = await checkFirma(f.fnr, f.name);
    if (r) results.push(r);
  }
  results.sort((a, b) => b.available - a.available);
  console.log('\n── Ranking ──');
  results.forEach((r, i) => console.log(`${i + 1}. ${r.name} (${r.fnr}): ${r.available} KPIs`));
})();
