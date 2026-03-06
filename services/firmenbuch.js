'use strict';
const axios = require('axios');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const dbService = require('./db');

function getTochtergesellschaften(fnr) {
  return dbService.getTochtergesellschaften(fnr);
}

function persistToDb(fnr, name, gesellschafter, geschaeftsfuehrer, vorstand, geburtsdatumMap = {}) {
  dbService.upsertCompany(fnr, { name });
  dbService.updateGesellschafter(fnr, gesellschafter.map(g => ({
    name: g.name,
    fnr: g.fnr ? g.fnr.replace(/ /g, '') : null,
    quelle: g.quelle || 'EVI',
    geburtsdatum: g.geburtsdatum || null,
  })));
  dbService.updatePersonenRollen(fnr, [
    ...(geschaeftsfuehrer || []).map(n => ({ name: n, rolle: 'GF', fkentext: 'Geschäftsführer/in', geburtsdatum: geburtsdatumMap[n] || null })),
    ...(vorstand || []).map(n => ({ name: n, rolle: 'VM', fkentext: 'Vorstand', geburtsdatum: geburtsdatumMap[n] || null })),
  ]);
  dbService.getDb().prepare(`
    UPDATE companies
    SET scrape_status = 'done', scraped_at = datetime('now'),
        last_attempt_at = datetime('now'), scrape_error = NULL
    WHERE fnr = ?
  `).run(fnr);
}

const ENDPOINT = 'https://justizonline.gv.at/jop/api/at.gv.justiz.fbw/ws';

const parser = new xml2js.Parser({
  explicitArray: false,
  tagNameProcessors: [xml2js.processors.stripPrefix],
  attrNameProcessors: [xml2js.processors.stripPrefix],
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function postSoap(body) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    ${body}
  </soap:Body>
</soap:Envelope>`;

  const response = await axios.post(ENDPOINT, envelope, {
    headers: {
      'Content-Type': 'application/soap+xml; charset=utf-8',
      'X-API-KEY': process.env.FIRMENBUCH_API_KEY || '',
    },
    validateStatus: () => true,
  });

  const parsed = await parser.parseStringPromise(response.data);
  const soapBody = parsed['Envelope']['Body'];

  if (soapBody['Fault']) {
    const fault = soapBody['Fault'];
    const reason = fault['Reason']
      ? fault['Reason']['Text']
      : fault['faultstring'];
    const msg = reason && typeof reason === 'object' ? reason['_'] : reason;
    throw new Error(msg || 'SOAP Fault');
  }

  return soapBody;
}

async function sucheFirma({
  firmenwortlaut,
  suchbereich = 1,
  gericht = '',
  rechtsform = '',
  ortnr = '',
}) {
  const body = `<SUCHEFIRMAREQUEST xmlns="ns://firmenbuch.justiz.gv.at/Abfrage/SucheFirmaRequest">
    <FIRMENWORTLAUT>${firmenwortlaut}</FIRMENWORTLAUT>
    <EXAKTESUCHE>false</EXAKTESUCHE>
    <SUCHBEREICH>${suchbereich}</SUCHBEREICH>
    <GERICHT>${gericht}</GERICHT>
    <RECHTSFORM>${rechtsform}</RECHTSFORM>
    <RECHTSEIGENSCHAFT></RECHTSEIGENSCHAFT>
    <ORTNR>${ortnr}</ORTNR>
  </SUCHEFIRMAREQUEST>`;

  const soapBody = await postSoap(body);
  const response = soapBody['SUCHEFIRMARESPONSE'];

  if (!response) return [];

  let ergebnisse = response['ERGEBNIS'] || [];
  if (!Array.isArray(ergebnisse)) ergebnisse = [ergebnisse];

  return ergebnisse.map((e) => ({
    fnr: e['FNR'],
    status: e['STATUS'],
    name: Array.isArray(e['NAME']) ? e['NAME'].join(' ') : (e['NAME'] || ''),
    sitz: e['SITZ'],
    rechtsform: (e['RECHTSFORM'] && e['RECHTSFORM']['TEXT']) || '',
    gericht: (e['GERICHT'] && e['GERICHT']['TEXT']) || '',
  }));
}

async function getAuszug({ fnr, stichtag, umfang = 'Kurzinformation' }) {
  const datum = stichtag || today();
  const body = `<AUSZUG_V2_REQUEST xmlns="ns://firmenbuch.justiz.gv.at/Abfrage/v2/AuszugRequest">
    <FNR>${fnr}</FNR>
    <STICHTAG>${datum}</STICHTAG>
    <UMFANG>${umfang}</UMFANG>
  </AUSZUG_V2_REQUEST>`;

  const soapBody = await postSoap(body);
  return soapBody['AUSZUG_V2_RESPONSE'];
}

async function sucheUrkunde({ fnr, az }) {
  const inner = fnr
    ? `<FNR>${fnr}</FNR>`
    : `<AZ>${az}</AZ>`;

  const body = `<SUCHEURKUNDEREQUEST xmlns="ns://firmenbuch.justiz.gv.at/Abfrage/SucheUrkundeRequest">
    ${inner}
  </SUCHEURKUNDEREQUEST>`;

  const soapBody = await postSoap(body);
  const response = soapBody['SUCHEURKUNDERESPONSE'];

  if (!response) return [];

  let ergebnisse = response['ERGEBNIS'] || [];
  if (!Array.isArray(ergebnisse)) ergebnisse = [ergebnisse];

  return ergebnisse.map((e) => ({
    key: e['KEY'],
    fnr: e['FNR'],
    az: e['AZ'],
    dokumentart: (e['DOKUMENTART'] && e['DOKUMENTART']['TEXT']) || '',
    dokumentendatum: e['DOKUMENTENDATUM'] || '',
    contenttype: e['CONTENTTYPE'] || '',
    dateiendung: e['DATEIENDUNG'] || '',
    groesse: Number(e['GROESSE']) || 0,
    bemerkung: e['BEMERKUNG'] || '',
    stichtag: e['STICHTAG'] || '',
    vnr: e['VNR'] || '',
    eingereicht: e['EINGEREICHT'] || '',
  }));
}

async function getUrkunde({ key }) {
  const body = `<URKUNDEREQUEST xmlns="ns://firmenbuch.justiz.gv.at/Abfrage/UrkundeRequest">
    <KEY>${key}</KEY>
  </URKUNDEREQUEST>`;

  const soapBody = await postSoap(body);
  const response = soapBody['URKUNDERESPONSE'];

  if (!response) throw new Error('Keine Urkunde gefunden');

  const dokument = response['DOKUMENT'];
  if (!dokument) throw new Error('Kein Dokumentinhalt verfügbar');

  return {
    contentType: dokument['CONTENTTYPE'],
    extension: dokument['DATEIENDUNG'],
    content: Buffer.from(dokument['CONTENT'], 'base64'),
  };
}

/**
 * Interne Funktion: Holt EVI-Seite und gibt sowohl Gesellschafter-Liste
 * als auch eine vollständige name→geburtsdatum Map (inkl. GF/Vorstand) zurück.
 */
async function fetchEviData({ fnr }) {
  const response = await axios.get(`https://www.evi.gv.at/f/${fnr}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Firmenbuch-App/1.0)' },
    validateStatus: () => true,
    timeout: 10000,
  });

  if (response.status !== 200) return { gesellschafter: [], geburtsdatumMap: {} };

  // Geburtsdaten aller Personen (GF, Vorstand, Gesellschafter) aus React-Payload extrahieren.
  const geburtsdatumMap = {};
  const unescaped = response.data.replace(/\\"/g, '"');
  const bdRegex = /"name":"([^"]+)","geburtsdatum":"(\d{4}-\d{2}-\d{2})"/g;
  let bdMatch;
  while ((bdMatch = bdRegex.exec(unescaped)) !== null) {
    geburtsdatumMap[bdMatch[1]] = bdMatch[2];
  }

  const $ = cheerio.load(response.data);
  const gesellschafter = [];

  $('#personen h3').each(function () {
    if (!$(this).text().includes('Gesellschafter')) return;

    $(this).parent().find('li').each(function () {
      const firstP = $(this).find('p').first();
      const link = firstP.find('a[href^="/f/"]');

      if (link.length > 0) {
        const name = link.text().trim();
        const gsFnr = link.attr('href').replace('/f/', '');
        if (name) gesellschafter.push({ name, fnr: gsFnr, fkentext: 'GESELLSCHAFTER/IN', quelle: 'EVI' });
      } else {
        const name = firstP.text().trim();
        if (name) gesellschafter.push({
          name,
          fkentext: 'GESELLSCHAFTER/IN',
          quelle: 'EVI',
          geburtsdatum: geburtsdatumMap[name] || null,
        });
      }
    });
  });

  return { gesellschafter, geburtsdatumMap };
}

/** Öffentliche Funktion — gibt nur die Gesellschafter-Liste zurück (Abwärtskompatibilität). */
async function scrapeEviGesellschafter({ fnr }) {
  const { gesellschafter } = await fetchEviData({ fnr });
  return gesellschafter;
}

async function getOwnershipTree(rootFnr) {
  function toArr(v) {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  }

  const auszugCache = {};
  const eviCache = {};
  const visited = new Set();

  async function getAuszugCached(fnr) {
    const key = fnr.replace(/ /g, '');
    if (!auszugCache[key]) {
      auszugCache[key] = getAuszug({ fnr, umfang: 'Kurzinformation' }).catch(() => null);
    }
    return auszugCache[key];
  }

  async function getEviCached(fnr) {
    const key = fnr.replace(/ /g, '');
    if (!eviCache[key]) {
      eviCache[key] = scrapeEviGesellschafter({ fnr }).catch(() => []);
    }
    return eviCache[key];
  }

  async function buildNode(fnr) {
    const normFnr = fnr.replace(/ /g, '');
    if (visited.has(normFnr)) return null;
    visited.add(normFnr);

    // Fetch SOAP and EVI data in parallel
    const [auszug, eviGesellschafter] = await Promise.all([
      getAuszugCached(normFnr),
      getEviCached(normFnr),
    ]);

    // Extract firm name from SOAP
    let name = normFnr;
    let geschaeftsfuehrer = [];
    let vorstand = [];

    if (auszug) {
      const firma = auszug['FIRMA'] || {};
      const namen = toArr(firma['FI_DKZ02'])
        .flatMap((d) => toArr(d['BEZEICHNUNG']))
        .filter(Boolean);
      if (namen[0]) name = namen[0];

      // Build person map for Geschäftsführer from SOAP
      const perMap = {};
      toArr(auszug['PER']).forEach((p) => {
        const pnr = ((p['$'] && p['$']['PNR']) || '').trim();
        if (!pnr) return;
        const dkz02 = toArr(p['PE_DKZ02'])[0];
        let personName = '';
        if (dkz02) {
          const nameFormatiert = toArr(dkz02['NAME_FORMATIERT']).filter(Boolean).join(' ');
          const parts = [dkz02['TITELVOR'], dkz02['VORNAME'], dkz02['NACHNAME'], dkz02['TITELNACH']].filter(Boolean).join(' ');
          const bezeichnung = toArr(dkz02['BEZEICHNUNG']).join(', ');
          personName = nameFormatiert || parts || bezeichnung || '';
        }
        perMap[pnr] = personName;
      });

      toArr(auszug['FUN']).forEach((f) => {
        const a = f['$'] || {};
        const fken = (a['FKEN'] || '').trim();
        const personName = perMap[(a['PNR'] || '').trim()];
        if (!personName) return;
        if (fken === 'GF' && !geschaeftsfuehrer.includes(personName)) geschaeftsfuehrer.push(personName);
        if (fken === 'VM' && !vorstand.includes(personName)) vorstand.push(personName);
      });
    }

    // Persist to DB
    persistToDb(normFnr, name, eviGesellschafter, geschaeftsfuehrer, vorstand);

    // Build children from EVI Gesellschafter
    const children = [];
    for (const g of eviGesellschafter) {
      if (g.fnr) {
        const childFnr = g.fnr.replace(/ /g, '');
        const child = await buildNode(childFnr);
        if (child) children.push(child);
      } else {
        children.push({
          id: 'person:' + g.name + ':' + normFnr,
          name: g.name || '(unbekannt)',
          fnr: null,
          type: 'person',
          children: [],
          geschaeftsfuehrer: [],
        });
      }
    }

    return { id: normFnr, name, fnr: normFnr, type: 'firma', children, geschaeftsfuehrer, vorstand, tochter: getTochtergesellschaften(normFnr) };
  }

  return buildNode(rootFnr);
}

/**
 * Gibt alle geänderten Firmen für einen Datumsbereich zurück.
 * Liefert: [{ fnr, vnr, vollzugsdatum, art }]
 */
async function veraenderungenFirma({ von, bis }) {
  const body = `<VERAENDERUNGENFIRMAREQUEST xmlns="ns://firmenbuch.justiz.gv.at/Abfrage/VeraenderungenFirmaRequest">
    <VON>${von}</VON>
    <BIS>${bis}</BIS>
    <GERICHT></GERICHT>
    <RECHTSFORM></RECHTSFORM>
  </VERAENDERUNGENFIRMAREQUEST>`;

  const soapBody = await postSoap(body);
  const response = soapBody['VERAENDERUNGENFIRMARESPONSE'];
  if (!response) return [];

  let eintraege = response['VERAENDERUNG'] || [];
  if (!Array.isArray(eintraege)) eintraege = [eintraege];

  return eintraege.map(e => ({
    fnr: (e['FNR'] || '').replace(/ /g, ''),
    vnr: e['VNR'] || '',
    vollzugsdatum: e['VOLLZUGSDATUM'] || von,
    art: e['ARTDERVERAENDERUNG'] || 'Änderung',
  }));
}

/**
 * Scrapt eine Firma vollständig (SOAP + EVI) und persistiert in der DB.
 */
async function scrapeAndPersist(fnr) {
  const normFnr = fnr.replace(/ /g, '');
  const db = dbService.getDb();

  const [auszug, eviData] = await Promise.all([
    getAuszug({ fnr: normFnr }).catch(() => null),
    fetchEviData({ fnr: normFnr }).catch(() => ({ gesellschafter: [], geburtsdatumMap: {} })),
  ]);
  const eviGesellschafter = eviData.gesellschafter;
  const geburtsdatumMap  = eviData.geburtsdatumMap;

  let name = normFnr;
  let rechtsform = '';
  let sitz = '';
  let geschaeftsfuehrer = [];
  let vorstand = [];

  if (auszug) {
    const firma = auszug['FIRMA'] || {};
    const namen = toArr(firma['FI_DKZ02'])
      .flatMap(d => toArr(d['BEZEICHNUNG']))
      .filter(Boolean);
    if (namen[0]) name = namen[0];

    const sitzRaw = toArr(firma['FI_DKZ06']).map(d => d['SITZ']).find(Boolean);
    if (sitzRaw) sitz = sitzRaw;

    rechtsform = toArr(firma['FI_DKZ07'])
      .map(d => d['RECHTSFORM'] && d['RECHTSFORM']['TEXT'])
      .find(Boolean) || '';

    const perMap = {};
    toArr(auszug['PER']).forEach(p => {
      const pnr = ((p['$'] && p['$']['PNR']) || '').trim();
      if (!pnr) return;
      const dkz02 = toArr(p['PE_DKZ02'])[0];
      if (!dkz02) return;
      const nf = toArr(dkz02['NAME_FORMATIERT']).filter(Boolean).join(' ');
      const parts = [dkz02['TITELVOR'], dkz02['VORNAME'], dkz02['NACHNAME'], dkz02['TITELNACH']].filter(Boolean).join(' ');
      perMap[pnr] = nf || parts || toArr(dkz02['BEZEICHNUNG']).join(', ') || '';
    });

    toArr(auszug['FUN']).forEach(f => {
      const a = f['$'] || {};
      const fken = (a['FKEN'] || '').trim();
      const personName = perMap[(a['PNR'] || '').trim()];
      if (!personName) return;
      if (fken === 'GF' && !geschaeftsfuehrer.includes(personName)) geschaeftsfuehrer.push(personName);
      if (fken === 'VM' && !vorstand.includes(personName)) vorstand.push(personName);
    });
  }

  persistToDb(normFnr, name, eviGesellschafter, geschaeftsfuehrer, vorstand, geburtsdatumMap);
  dbService.upsertCompany(normFnr, { name, rechtsform, sitz });

  db.prepare(`
    UPDATE companies
    SET scrape_status = 'done', scrape_attempts = scrape_attempts + 1,
        scraped_at = datetime('now'), last_attempt_at = datetime('now'), scrape_error = NULL
    WHERE fnr = ?
  `).run(normFnr);

  return { name, rechtsform, sitz, geschaeftsfuehrer, vorstand, gesellschafter: eviGesellschafter };
}

function toArr(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Konvertiert den Ownership-Tree in ein flaches Nodes+Edges-Format für cytoscape.
 * Kanten: Eigentümer → Firma (Besitzrichtung)
 */
async function buildGraph(rootFnr) {
  const tree = await getOwnershipTree(rootFnr);
  const nodes = new Map();
  const edgeSet = new Set();
  const edges = [];
  const visited = new Set();

  function addEdge(source, target) {
    const key = source + '>' + target;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ data: { id: 'e:' + source + ':' + target, source, target, prozent: null, edgeSource: 'soap' } });
  }

  function traverse(node, parentId) {
    // Person-IDs kommen bereits mit 'person:'-Präfix aus dem Tree
    const id = node.fnr ? 'fnr:' + node.fnr : (node.id || ('person:' + node.name));
    if (!nodes.has(id)) {
      nodes.set(id, {
        data: {
          id,
          name: node.name,
          fnr: node.fnr || null,
          type: node.type || 'firma',
          source: 'soap',
          isRoot: node.fnr === rootFnr,
          geschaeftsfuehrer: node.geschaeftsfuehrer || [],
          vorstand: node.vorstand || [],
        }
      });
    }
    if (parentId) {
      addEdge(id, parentId); // id besitzt parentId
    }
    if (!visited.has(id)) {
      visited.add(id);
      (node.children || []).forEach(ch => traverse(ch, id));
      (node.tochter || []).forEach(t => {
        const tid = 'fnr:' + t.fnr;
        if (!nodes.has(tid)) {
          nodes.set(tid, { data: { id: tid, name: t.name || t.fnr, fnr: t.fnr, type: 'firma', source: 'soap' } });
        }
        addEdge(id, tid); // id besitzt tochter
        (t.coGesellschafter || []).forEach(cg => {
          if (!cg.fnr) return;
          const cgid = 'fnr:' + cg.fnr;
          if (!nodes.has(cgid)) {
            nodes.set(cgid, { data: { id: cgid, name: cg.name || cg.fnr, fnr: cg.fnr, type: 'firma', source: 'soap' } });
          }
          addEdge(cgid, tid);
        });
      });
    }
  }

  traverse(tree, null);
  return { nodes: Array.from(nodes.values()), edges };
}

module.exports = { sucheFirma, getAuszug, sucheUrkunde, getUrkunde, scrapeEviGesellschafter, getOwnershipTree, veraenderungenFirma, scrapeAndPersist, buildGraph };
