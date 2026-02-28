'use strict';
const express = require('express');
const router  = express.Router();
const axios   = require('axios');

const GITHUB_REPO = 'aignerl/firmenbuch';
const GITHUB_API  = `https://api.github.com/repos/${GITHUB_REPO}/issues`;

router.get('/', (req, res) => {
  res.render('feedback', { title: 'Feedback', sent: false, issueUrl: null, error: null });
});

router.post('/', async (req, res) => {
  const { typ, titel, beschreibung, email, url } = req.body;

  if (!titel?.trim() || !beschreibung?.trim()) {
    return res.render('feedback', {
      title: 'Feedback', sent: false, issueUrl: null,
      error: 'Bitte Titel und Beschreibung ausfüllen.',
    });
  }

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    return res.render('feedback', {
      title: 'Feedback', sent: false, issueUrl: null,
      error: 'Feedback-Funktion nicht konfiguriert (GITHUB_PAT fehlt).',
    });
  }

  const isBug     = typ === 'bug';
  const typLabel  = isBug ? 'Bug-Report' : 'Feature-Wunsch';
  const label     = isBug ? 'bug' : 'enhancement';

  const bodyLines = [
    `**Typ:** ${typLabel}`,
    '',
    '**Beschreibung:**',
    beschreibung.trim(),
  ];
  if (url?.trim())   bodyLines.push('', `**URL:** ${url.trim()}`);
  if (email?.trim()) bodyLines.push('', `**Gemeldet von:** ${email.trim()}`);
  bodyLines.push('', '---', '*Gemeldet über das Firmenbuch Feedback-Formular*');

  try {
    const response = await axios.post(GITHUB_API, {
      title:  `[${typLabel}] ${titel.trim()}`,
      body:   bodyLines.join('\n'),
      labels: [label],
    }, {
      headers: {
        Authorization:        `Bearer ${pat}`,
        Accept:               'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    res.render('feedback', {
      title: 'Feedback', sent: true,
      issueUrl: response.data.html_url, error: null,
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.render('feedback', {
      title: 'Feedback', sent: false, issueUrl: null,
      error: `GitHub-Fehler: ${msg}`,
    });
  }
});

module.exports = router;
