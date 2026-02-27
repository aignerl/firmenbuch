'use strict';
const express = require('express');
const router = express.Router();
const { sucheFirma, getAuszug, sucheUrkunde, getUrkunde, getOwnershipTree } = require('../../services/firmenbuch');
const { parseJahresabschluss } = require('../../services/jahresabschluss');
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
      if (cached) return res.json(cached);
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
