'use strict';
const express = require('express');
const router = express.Router();
const { sucheFirma, getAuszug, sucheUrkunde, getUrkunde, getOwnershipTree } = require('../../services/firmenbuch');
const { parseJahresabschluss, extractKpis } = require('../../services/jahresabschluss');
const db = require('../../services/db');

router.get('/suchen', async (req, res) => {
  const { name, exakt, suchbereich, gericht, rechtsform, nurAktiv } = req.query;
  if (!name) return res.status(400).json({ error: 'Parameter "name" fehlt' });

  try {
    let ergebnisse = await sucheFirma({
      firmenwortlaut: name,
      exaktesuche: exakt === 'true',
      suchbereich: Number(suchbereich) || 1,
      gericht: gericht || '',
      rechtsform: rechtsform || '',
    });
    if (nurAktiv === 'true') ergebnisse = ergebnisse.filter((e) => !e.status);
    res.json(ergebnisse);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const METRICS = {
  roa:           { path: '$.roa.betrag',          label: 'ROA',           suffix: '%' },
  roe:           { path: '$.roe.betrag',           label: 'ROE',           suffix: '%' },
  umsatzrendite: { path: '$.umsatzrendite.betrag', label: 'Umsatzrendite', suffix: '%' },
  ek_quote:      { path: '$.ekQuote.betrag',       label: 'EK-Quote',      suffix: '%' },
};

router.get('/bestenliste', (req, res) => {
  const { metric = 'roa', limit = '20', minBilanzsumme = '0', jahr } = req.query;
  const metricDef = METRICS[metric];
  if (!metricDef) return res.status(400).json({ error: 'Unbekannte Kennzahl' });

  const limitN = Math.min(parseInt(limit, 10) || 20, 100);
  const minBS = parseFloat(minBilanzsumme) || 0;
  const database = db.getDb();

  const conditions = [
    `json_extract(j.kpis, '${metricDef.path}') IS NOT NULL`,
    `COALESCE(CAST(json_extract(j.kpis, '$.bilanzsumme.betrag') AS REAL), 0) >= ?`,
  ];
  const params = [minBS];

  if (jahr) {
    conditions.push(`j.gj_jahr = ${parseInt(jahr, 10)}`);
  } else {
    conditions.push(`j.gj_jahr = (SELECT MAX(j2.gj_jahr) FROM jahresabschluesse j2 WHERE j2.company_fnr = j.company_fnr)`);
  }

  const sql = `
    SELECT
      j.company_fnr AS fnr,
      COALESCE(cn.name, j.company_fnr) AS name,
      c.rechtsform,
      j.gj_jahr,
      CAST(json_extract(j.kpis, '${metricDef.path}') AS REAL) AS wert,
      CAST(json_extract(j.kpis, '$.bilanzsumme.betrag') AS REAL) AS bilanzsumme
    FROM jahresabschluesse j
    JOIN companies c ON c.fnr = j.company_fnr
    LEFT JOIN company_names cn ON cn.company_fnr = j.company_fnr AND cn.valid_to IS NULL
    WHERE ${conditions.join(' AND ')}
    ORDER BY wert DESC
    LIMIT ?
  `;
  params.push(limitN);

  try {
    const rows = database.prepare(sql).all(...params);
    res.json({ metric, label: metricDef.label, suffix: metricDef.suffix, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:fnr/auszug', async (req, res) => {
  const { fnr } = req.params;
  const { umfang, stichtag } = req.query;

  try {
    const data = await getAuszug({
      fnr,
      stichtag: stichtag || null,
      umfang: umfang || 'Kurzinformation',
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/:fnr/urkunden', async (req, res) => {
  const { fnr } = req.params;
  try {
    const ergebnisse = await sucheUrkunde({ fnr });
    res.json(ergebnisse);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/:fnr/baum', async (req, res) => {
  try {
    const tree = await getOwnershipTree(req.params.fnr);
    res.json(tree);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/:fnr/jahresabschluss', async (req, res) => {
  const { fnr } = req.params;
  const { key, raw } = req.query;
  if (!key) return res.status(400).json({ error: 'Parameter "key" fehlt' });
  try {
    // Cache-Check (nur für normale Anfragen, nicht für raw-Debug)
    if (raw !== '1') {
      const cached = db.getJahresabschluss(key);
      if (cached) {
        // KPIs aus gecachten positions neu berechnen (damit neue KPI-Felder enthalten sind)
        cached.kpis = cached.positions ? extractKpis(cached.positions) : cached.kpis;
        return res.json(cached);
      }
    }

    const { content } = await getUrkunde({ key });

    if (raw === '1') {
      const xmlString = content.toString('latin1');
      return res.json({ xml: xmlString.slice(0, 5000) });
    }

    const result = await parseJahresabschluss(content);

    // In DB persistieren (fire-and-forget, Fehler nicht an Client weitergeben)
    try { db.upsertJahresabschluss(fnr, key, result); } catch (_) {}

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
