'use strict';
const express = require('express');
const router = express.Router();
const { sucheFirma, getAuszug, sucheUrkunde } = require('../../services/firmenbuch');

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

module.exports = router;
