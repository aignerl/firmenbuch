'use strict';
const express = require('express');
const router = express.Router();
const { sucheFirma, getAuszug } = require('../../services/firmenbuch');

router.get('/suchen', async (req, res) => {
  const { name, exakt, suchbereich, gericht, rechtsform } = req.query;
  if (!name) return res.status(400).json({ error: 'Parameter "name" fehlt' });

  try {
    const ergebnisse = await sucheFirma({
      firmenwortlaut: name,
      exaktesuche: exakt === 'true',
      suchbereich: Number(suchbereich) || 1,
      gericht: gericht || '',
      rechtsform: rechtsform || '',
    });
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

module.exports = router;
