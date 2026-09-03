# Football Selector v2

A lightweight Node/Express football match-ranking tool using API-Football.

## What changed in v2

- Server-side API key protection.
- In-memory caching to reduce duplicate API calls.
- Team statistics are cached and fetched concurrently per fixture.
- Real `/injuries` data is now included when the league/season/date has injury coverage.
- Injury counts are shown in the UI as a data-quality/availability signal.
- Explicit warning that motivation and tactical scores are still neutral placeholders.
- Health endpoint: `/api/health`.

API-Football documents fixtures, injuries, lineups, statistics, odds and historical data, and recommends checking competition coverage and caching data before making downstream calls.

## Install

Requires Node 18+ (Node 20+ recommended).

```bash
npm install
```

## Configure API key

Linux/macOS:

```bash
export API_FOOTBALL_KEY="YOUR_KEY_HERE"
npm start
```

Windows PowerShell:

```powershell
$env:API_FOOTBALL_KEY="YOUR_KEY_HERE"
npm start
```

Then open:

`http://localhost:3000`

## Important model limitation

This is intentionally not marketed as a 70% prediction machine. The current model is a transparent ranking/filtering system. Motivation and tactical fit are neutral until they are properly modeled.

For serious validation, the next stage should be a historical collector + SQLite database + walk-forward backtest. Do not train/test on the same information window, and do not use current-season aggregate statistics to predict older matches because that creates look-ahead leakage.

## API usage notes

The server caches team statistics for 12 hours, injuries for 4 hours, and fixture lists for 10 minutes. These TTLs can be adjusted at the top of `server.js`.

For large-scale use (hundreds/thousands of fixtures), move from per-team live calls toward a league-season data store and bulk fixture retrieval, then refresh only the pieces that change near kickoff.


## Deploy publicly on Render

1. Put this folder in a GitHub repository.
2. In Render, choose **New → Web Service** and connect the repository.
3. Render can use the included `render.yaml`; alternatively use build command `npm install` and start command `npm start`.
4. Add the environment variable `API_FOOTBALL_KEY` in the Render service settings.
5. Deploy. Render will give the app a public `onrender.com` URL.

The server binds to `0.0.0.0` so it can receive public traffic on Render's assigned port.
