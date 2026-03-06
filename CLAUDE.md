

du# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start the server (default port 3000)
npm start

# Start on a custom port
PORT=8080 npm start
```

There are no configured test or lint scripts.

## Architecture

This is an Express.js web application (Node.js) intended to integrate with the Austrian business register (Firmenbuch) web services provided by `firmenbuch.justiz.gv.at`.

**Request flow:**
1. `bin/www` — HTTP server entry point, binds port and starts listening
2. `app.js` — Express app setup: middleware stack, route registration, error handlers
3. `routes/` — Route handlers mounted in `app.js`
4. `views/` — Pug templates rendered by route handlers

**Routes:**
- `GET /` → renders `views/in[demo.html](demo.html)dex.pug` (search form)
- `POST /suchen` → calls `sucheFirma`, renders `views/suche-ergebnis.pug`
- `GET /firma/:fnr` → calls `getAuszug`, renders `views/firma.pug`
- `GET /api/firma/suchen?name=` → JSON search results
- `GET /api/firma/:fnr/auszug?umfang=Kurzinformation` → JSON company extract
- `GET /users` → plain text response

**Services:**
- `services/firmenbuch.js` — SOAP 1.2 client for JustizOnline HVD
  - `sucheFirma({ firmenwortlaut, exaktesuche, suchbereich, gericht, rechtsform })` → array of results
  - `getAuszug({ fnr, stichtag, umfang })` → raw parsed `AUSZUG_V2_RESPONSE`
  - SOAP endpoint: `https://justizonline.gv.at/jop/api/at.gv.justiz.fbw/ws`
  - Auth: `X-API-KEY` header from `process.env.FIRMENBUCH_API_KEY`

**Environment:**
- Copy `.env` and set `FIRMENBUCH_API_KEY=<your_key>` before starting

## External Web Service (Firmenbuch HVD)

The `API Doku/` folder contains XSD schemas and a PDF interface description for the SOAP/XML web service at `firmenbuch.justiz.gv.at`. The intended integration involves these operations:

| Operation | Request XSD | Response XSD |
|-----------|-------------|--------------|
| Auszug (company extract) | `auszugRequest_v2.xsd` | `auszugResponse_v2.xsd` |
| Firma suchen (search company) | `sucheFirmaRequest.xsd` | `sucheFirmaResponse.xsd` |
| Urkunde suchen (search document) | `sucheUrkundeRequest.xsd` | `sucheUrkundeResponse.xsd` |
| Urkunde abrufen (fetch document) | `urkundeRequest.xsd` | `urkundeResponse.xsd` |
| Veränderungen Firma (company changes) | `veraenderungenFirmaRequest.xsd` | `veraenderungenFirmaResponse.xsd` |
| Veränderungen Urkunden (document changes) | `veraenderungenUrkundenRequest.xsd` | `veraenderungenUrkundenResponse.xsd` |

Key field in `auszugRequest_v2.xsd`: `FNR` (Firmenbuchnummer, e.g. `"000187a"`), `STICHTAG` (date), `UMFANG` (`"aktueller Auszug"` / `"historischer Auszug"` / `"Kurzinformation"`).