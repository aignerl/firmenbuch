'use strict';
const axios = require('axios');
const xml2js = require('xml2js');

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
  exaktesuche = false,
  suchbereich = 1,
  gericht = '',
  rechtsform = '',
}) {
  const body = `<SUCHEFIRMAREQUEST xmlns="ns://firmenbuch.justiz.gv.at/Abfrage/SucheFirmaRequest">
    <FIRMENWORTLAUT>${firmenwortlaut}</FIRMENWORTLAUT>
    <EXAKTESUCHE>${exaktesuche}</EXAKTESUCHE>
    <SUCHBEREICH>${suchbereich}</SUCHBEREICH>
    <GERICHT>${gericht}</GERICHT>
    <RECHTSFORM>${rechtsform}</RECHTSFORM>
    <RECHTSEIGENSCHAFT></RECHTSEIGENSCHAFT>
    <ORTNR></ORTNR>
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

module.exports = { sucheFirma, getAuszug };
