'use strict';
var express = require('express');
var router = express.Router();
var { sucheFirma, getAuszug, sucheUrkunde, getUrkunde, scrapeEviGesellschafter, getOwnershipTree } = require('../services/firmenbuch');
var db = require('../services/db');


function toArr(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function buildFirmaView(auszug) {
  if (!auszug) return null;

  const attrs = auszug['$'] || {};
  const firma = auszug['FIRMA'] || {};

  // Namen (FI_DKZ02 → BEZEICHNUNG)
  const namen = toArr(firma['FI_DKZ02'])
    .flatMap((d) => toArr(d['BEZEICHNUNG']))
    .filter(Boolean);

  // Sitz (FI_DKZ06 → SITZ)
  const sitz = toArr(firma['FI_DKZ06'])
    .map((d) => d['SITZ'])
    .find(Boolean) || '';

  // Rechtsform (FI_DKZ07 → RECHTSFORM → TEXT)
  const rechtsform = toArr(firma['FI_DKZ07'])
    .map((d) => d['RECHTSFORM'] && d['RECHTSFORM']['TEXT'])
    .find(Boolean) || '';

  // Adressen (FI_DKZ03)
  const adressen = toArr(firma['FI_DKZ03'])
    .map((d) => ({
      strasse: d['STRASSE'] || '',
      hausnummer: d['HAUSNUMMER'] || '',
      plz: d['PLZ'] || '',
      ort: d['ORT'] || '',
      staat: d['STAAT'] || '',
    }))
    .filter((a) => a.ort || a.strasse);

  // Funktionen (FUN) mit Personen-Lookup (PER)
  const pers = toArr(auszug['PER']);
  const perMap = {};
  pers.forEach((p) => {
    const pnr = (p['$'] && p['$']['PNR'] || '').trim();
    if (!pnr) return;
    const dkz02 = toArr(p['PE_DKZ02'])[0];
    if (!dkz02) return;
    const nameFormatiert = toArr(dkz02['NAME_FORMATIERT']).filter(Boolean).join(' ');
    const nameParts = [dkz02['TITELVOR'], dkz02['VORNAME'], dkz02['NACHNAME'], dkz02['TITELNACH']];
    const nameFromParts = nameParts.filter(Boolean).join(' ');
    const bezeichnung = toArr(dkz02['BEZEICHNUNG']).join(', ');
    perMap[pnr] = nameFormatiert || nameFromParts || bezeichnung || '';
  });

  const funktionen = toArr(auszug['FUN']).map((f) => {
    const a = f['$'] || {};
    const pnr = (a['PNR'] || '').trim();
    return {
      fkentext: a['FKENTEXT'] || '',
      name: perMap[pnr] || '',
    };
  });

  return {
    fnr: attrs['FNR'] || '',
    stichtag: attrs['STICHTAG'] || '',
    umfang: attrs['UMFANG'] || '',
    namen,
    sitz,
    rechtsform,
    adressen,
    funktionen,
  };
}

router.get('/', function (req, res) {
  res.render('index', { title: 'Firmenbuch Suche' });
});

router.post('/suchen', async function (req, res) {
  const { type } = req.body;

  // ── Personensuche ──────────────────────────────────────────────
  if (type === 'person') {
    const { personenwortlaut } = req.body;
    if (!personenwortlaut?.trim()) {
      return res.render('index', { title: 'Firmenbuch Suche', error: 'Bitte Namen eingeben.' });
    }
    const q = `%${personenwortlaut.trim()}%`;
    const d = db.getDb();
    // Gibt eindeutige Personen zurück: konsolidierte (personen-Tabelle) + nicht-konsolidierte (nur Name)
    const ergebnisse = d.prepare(`
      SELECT MAX(personen_id) AS personen_id, name, MAX(geburtsdatum) AS geburtsdatum,
             SUM(firmen_count) AS firmen_count
      FROM (
        SELECT p.id AS personen_id, p.name, p.geburtsdatum,
          (SELECT COUNT(DISTINCT company_fnr) FROM personen_rollen WHERE personen_id = p.id AND valid_to IS NULL) +
          (SELECT COUNT(DISTINCT company_fnr) FROM gesellschafter  WHERE personen_id = p.id AND valid_to IS NULL AND gesellschafter_fnr IS NULL) AS firmen_count
        FROM personen p WHERE p.name LIKE ?
        UNION ALL
        SELECT NULL, name, NULL,
          COUNT(DISTINCT company_fnr) AS firmen_count
        FROM (
          SELECT name, company_fnr FROM personen_rollen WHERE valid_to IS NULL AND personen_id IS NULL AND name LIKE ?
          UNION ALL
          SELECT name, company_fnr FROM gesellschafter  WHERE valid_to IS NULL AND personen_id IS NULL AND gesellschafter_fnr IS NULL AND name LIKE ?
        ) GROUP BY name
      )
      GROUP BY name
      HAVING SUM(firmen_count) > 0
      ORDER BY name
    `).all(q, q, q);
    return res.render('personen-ergebnis', {
      title: 'Personensuche', ergebnisse, personenwortlaut: personenwortlaut.trim(),
    });
  }

  // ── Firmensuche ────────────────────────────────────────────────
  const { firmenwortlaut, nurAktiv, rechtsform, bundesland } = req.body;
  if (!firmenwortlaut) {
    return res.render('index', { title: 'Firmenbuch Suche', error: 'Bitte Firmenwortlaut eingeben.' });
  }
  try {
    let ergebnisse = await sucheFirma({
      firmenwortlaut,
      suchbereich: 3,
      rechtsform: rechtsform || '',
      ortnr: bundesland || '',
    });
    if (nurAktiv === 'on') ergebnisse = ergebnisse.filter((e) => !e.status);
    res.render('suche-ergebnis', { title: 'Suchergebnisse', ergebnisse, firmenwortlaut });
  } catch (err) {
    res.render('index', { title: 'Firmenbuch Suche', error: err.message });
  }
});

router.get('/person', function (req, res) {
  const { id, name } = req.query;
  const d = db.getDb();

  let personName, geburtsdatum, rows;

  if (id) {
    const person = d.prepare(`SELECT name, geburtsdatum FROM personen WHERE id = ?`).get(id);
    if (!person) return res.redirect('/');
    personName = person.name;
    geburtsdatum = person.geburtsdatum;
    rows = d.prepare(`
      SELECT p.name, p.company_fnr, cn.name AS company_name, c.rechtsform, c.sitz, c.status, p.rolle_text
      FROM (
        SELECT name, company_fnr, fkentext AS rolle_text
        FROM personen_rollen WHERE personen_id = ? AND valid_to IS NULL
        UNION ALL
        SELECT name, company_fnr, fkentext AS rolle_text
        FROM personen_rollen WHERE personen_id IS NULL AND name = ? AND valid_to IS NULL
        UNION ALL
        SELECT name, company_fnr, 'Gesellschafter/in' AS rolle_text
        FROM gesellschafter WHERE personen_id = ? AND valid_to IS NULL AND gesellschafter_fnr IS NULL
        UNION ALL
        SELECT name, company_fnr, 'Gesellschafter/in' AS rolle_text
        FROM gesellschafter WHERE personen_id IS NULL AND name = ? AND valid_to IS NULL AND gesellschafter_fnr IS NULL
      ) p
      LEFT JOIN company_names cn ON cn.company_fnr = p.company_fnr AND cn.valid_to IS NULL
      LEFT JOIN companies c ON c.fnr = p.company_fnr
      ORDER BY cn.name
    `).all(id, personName, id, personName);
  } else if (name?.trim()) {
    personName = name.trim();
    geburtsdatum = null;
    rows = d.prepare(`
      SELECT p.name, p.company_fnr, cn.name AS company_name, c.rechtsform, c.sitz, c.status, p.rolle_text
      FROM (
        SELECT name, company_fnr, fkentext AS rolle_text
        FROM personen_rollen WHERE valid_to IS NULL AND personen_id IS NULL AND name = ?
        UNION ALL
        SELECT name, company_fnr, 'Gesellschafter/in' AS rolle_text
        FROM gesellschafter WHERE valid_to IS NULL AND personen_id IS NULL AND gesellschafter_fnr IS NULL AND name = ?
      ) p
      LEFT JOIN company_names cn ON cn.company_fnr = p.company_fnr AND cn.valid_to IS NULL
      LEFT JOIN companies c ON c.fnr = p.company_fnr
      ORDER BY cn.name
    `).all(personName, personName);
  } else {
    return res.redirect('/');
  }

  const seen = new Set();
  const firmen = rows.filter((r) => {
    const key = `${r.company_fnr}|${r.rolle_text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  res.render('person', { title: personName, name: personName, geburtsdatum, firmen });
});

router.get('/firma/:fnr', async function (req, res) {
  const { fnr } = req.params;
  try {
    const [raw, urkundenRaw, eviGesellschafter] = await Promise.all([
      getAuszug({ fnr }),
      sucheUrkunde({ fnr }).catch(() => []),
      scrapeEviGesellschafter({ fnr }).catch(() => []),
    ]);
    const firma = buildFirmaView(raw);
    firma.funktionen.push(...eviGesellschafter);

    // Stammdaten + Adressen in DB persistieren (fire-and-forget)
    try {
      const firstName = firma.namen[0] || '';
      db.upsertCompany(fnr, { name: firstName, rechtsform: firma.rechtsform, sitz: firma.sitz });
      if (firma.adressen.length > 0) db.updateAdressen(fnr, firma.adressen);
    } catch (_) {}
    const urkunden = urkundenRaw.map((u) => ({
      ...u,
      groesseFormatiert: u.groesse
        ? u.groesse >= 1024 * 1024
          ? `${(u.groesse / 1024 / 1024).toFixed(1)} MB`
          : `${Math.ceil(u.groesse / 1024)} KB`
        : '',
      datumSort: u.stichtag || u.dokumentendatum || u.eingereicht || '',
    }));
    const xmlUrkunden = Object.values(
      urkundenRaw
        .filter((u) => u.dateiendung === 'xml')
        .map((u) => ({
          key: u.key,
          label: ((u.stichtag || u.dokumentendatum || '').slice(0, 4)) || u.key,
          datum: u.stichtag || u.dokumentendatum || u.eingereicht || '',
        }))
        .reduce((acc, u) => {
          const year = u.datum.slice(0, 4) || u.label;
          if (!acc[year] || u.datum > acc[year].datum) acc[year] = u;
          return acc;
        }, {})
    ).sort((a, b) => b.datum.localeCompare(a.datum));
    res.render('firma', { title: `Firma ${fnr}`, firma, urkunden, xmlUrkunden, fnr });
  } catch (err) {
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};
    res.status(502);
    res.render('error');
  }
});

router.get('/firma/:fnr/urkunden', async function (req, res) {
  const { fnr } = req.params;
  try {
    const raw = await sucheUrkunde({ fnr });
    const urkunden = raw.map((u) => ({
      ...u,
      groesseFormatiert: u.groesse
        ? u.groesse >= 1024 * 1024
          ? `${(u.groesse / 1024 / 1024).toFixed(1)} MB`
          : `${Math.ceil(u.groesse / 1024)} KB`
        : '',
    }));
    res.render('urkunden', { title: `Urkunden ${fnr}`, urkunden, fnr });
  } catch (err) {
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};
    res.status(502);
    res.render('error');
  }
});


router.get('/urkunde/download', async function (req, res) {
  const { key } = req.query;
  if (!key) return res.status(400).send('Parameter "key" fehlt');

  try {
    const { contentType, extension, content } = await getUrkunde({ key });
    const isPdf = contentType === 'application/pdf';
    res.set('Content-Type', contentType);
    res.set(
      'Content-Disposition',
      `${isPdf ? 'inline' : 'attachment'}; filename="urkunde.${extension}"`
    );
    res.send(content);
  } catch (err) {
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};
    res.status(502);
    res.render('error');
  }
});

module.exports = router;
