'use strict';
var express = require('express');
var router = express.Router();
var { sucheFirma, getAuszug } = require('../services/firmenbuch');

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
  const { firmenwortlaut, exaktesuche, suchbereich } = req.body;
  if (!firmenwortlaut) {
    return res.render('index', { title: 'Firmenbuch Suche', error: 'Bitte Firmenwortlaut eingeben.' });
  }
  try {
    const ergebnisse = await sucheFirma({
      firmenwortlaut,
      exaktesuche: exaktesuche === 'on',
      suchbereich: Number(suchbereich) || 1,
    });
    res.render('suche-ergebnis', { title: 'Suchergebnisse', ergebnisse, firmenwortlaut });
  } catch (err) {
    res.render('index', { title: 'Firmenbuch Suche', error: err.message });
  }
});

router.get('/firma/:fnr', async function (req, res) {
  const { fnr } = req.params;
  try {
    const raw = await getAuszug({ fnr });
    const firma = buildFirmaView(raw);
    res.render('firma', { title: `Firma ${fnr}`, firma });
  } catch (err) {
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};
    res.status(502);
    res.render('error');
  }
});

module.exports = router;
