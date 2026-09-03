const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const BASE = "https://api.football-data.org/v4";

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function clamp(x) {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;

  if (Date.now() - v.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return v.data;
}

function cacheSet(key, data) {
  cache.set(key, {
    t: Date.now(),
    data
  });

  return data;
}

async function api(endpoint, params = {}) {
  if (!API_TOKEN) {
    throw new Error(
      "Missing FOOTBALL_DATA_TOKEN. Add it to Render Environment Variables."
    );
  }

  const url = new URL(BASE + endpoint);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);

  if (cached) return cached;

  const response = await fetch(url, {
    headers: {
      "X-Auth-Token": API_TOKEN
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.message || `Football-data API error: HTTP ${response.status}`
    );
  }

  return cacheSet(cacheKey, data);
}


/*
  Football-data.org competition codes.

  PL  = Premier League
  PD  = La Liga
  SA  = Serie A
  BL1 = Bundesliga
  FL1 = Ligue 1
  DED = Eredivisie
  PPL = Primeira Liga
  CL  = Champions League
*/

const COMPETITIONS = {
  39: "PL",
  140: "PD",
  135: "SA",
  78: "BL1",
  61: "FL1",
  88: "DED",
  94: "PPL",
  2: "CL"
};


function fixtureToMatch(match) {
  return {
    id: match.id,
    home: match.homeTeam?.name,
    away: match.awayTeam?.name,
    kickoff: match.utcDate,
    homeId: match.homeTeam?.id,
    awayId: match.awayTeam?.id,
    status: match.status
  };
}


/*
  Convert league standings into useful prediction numbers.
*/
async function getStandings(competition) {
  const data = await api(`/competitions/${competition}/standings`);

  const total =
    data.standings?.find(x => x.type === "TOTAL") ||
    data.standings?.[0];

  return total?.table || [];
}


function getTeamStats(table, teamId) {
  const row = table.find(x => x.team?.id === teamId);

  if (!row) return null;

  const played = Number(row.played) || 1;
  const points = Number(row.points) || 0;
  const wins = Number(row.won) || 0;
  const goalsFor = Number(row.goalsFor) || 0;
  const goalsAgainst = Number(row.goalsAgainst) || 0;

  return {
    position: Number(row.position) || 0,
    played,
    points,
    pointsRate: points / (played * 3),
    winRate: wins / played,
    goalsFor: goalsFor / played,
    goalsAgainst: goalsAgainst / played
  };
}


/*
  Calculate a simple prediction score.

  This is deliberately lightweight for now.
  We'll improve the model after the API connection works.
*/
function calculatePrediction(home, away) {
  if (!home || !away) {
    return {
      homeScore: 0.5,
      awayScore: 0.5,
      confidence: 0
    };
  }

  const homeStrength =
    home.pointsRate * 0.45 +
    home.winRate * 0.30 +
    clamp(home.goalsFor / 3) * 0.15 +
    clamp(1 - home.goalsAgainst / 3) * 0.10;

  const awayStrength =
    away.pointsRate * 0.45 +
    away.winRate * 0.30 +
    clamp(away.goalsFor / 3) * 0.15 +
    clamp(1 - away.goalsAgainst / 3) * 0.10;

  /*
    Home advantage.
  */
  const adjustedHome = homeStrength + 0.08;

  const total = adjustedHome + awayStrength || 1;

  const homeScore = clamp(adjustedHome / total);
  const awayScore = clamp(awayStrength / total);

  const confidence =
    Math.abs(homeScore - awayScore);

  let prediction = "DRAW";

  if (homeScore > awayScore + 0.08) {
    prediction = "HOME";
  } else if (awayScore > homeScore + 0.08) {
    prediction = "AWAY";
  }

  return {
    homeScore,
    awayScore,
    confidence,
    prediction
  };
}


app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    apiConfigured: Boolean(API_TOKEN),
    cacheEntries: cache.size
  });
});


app.get("/api/matches", async (req, res) => {
  try {
    const league = Number(req.query.league || 39);
    const date = req.query.date;

    if (!date) {
      return res.status(400).json({
        error: "Choose a date."
      });
    }

    const competition = COMPETITIONS[league];

    if (!competition) {
      return res.status(400).json({
        error:
          "This league is not currently supported by football-data.org."
      });
    }


    /*
      Get matches for the requested date.

      We use the dateFrom/dateTo filters provided by football-data.org.
    */
    const matchesData = await api(
      `/competitions/${competition}/matches`,
      {
        dateFrom: date,
        dateTo: date
      }
    );

    const fixtures = (matchesData.matches || [])
      .filter(match =>
        ["SCHEDULED", "TIMED"].includes(match.status)
      );


    /*
      Get the current league standings.
    */
    const table = await getStandings(competition);


    const output = [];

    for (const fixture of fixtures) {
      const homeStats = getTeamStats(
        table,
        fixture.homeTeam?.id
      );

      const awayStats = getTeamStats(
        table,
        fixture.awayTeam?.id
      );

if (!homeStats || !awayStats) {
  console.log("Missing standings data:", fixture.homeTeam?.name, fixture.awayTeam?.name);
}

      const prediction = calculatePrediction(
        homeStats,
        awayStats
      );

      output.push({
        ...fixtureToMatch(fixture),

        homeForm: clamp(homeStats.pointsRate),
        awayForm: clamp(awayStats.pointsRate),

        homeVenue: clamp(homeStats.winRate + 0.08),
        awayVenue: clamp(awayStats.winRate),

        homeAttack: clamp(homeStats.goalsFor / 3),
        awayAttack: clamp(awayStats.goalsFor / 3),

        homeDefense: clamp(
          1 - homeStats.goalsAgainst / 3
        ),

        awayDefense: clamp(
          1 - awayStats.goalsAgainst / 3
        ),

        /*
          Injury information is temporarily neutral.
          football-data.org does not provide the same injury
          endpoint we were using with API-Football.
        */
        homeInjuries: 0,
        awayInjuries: 0,
        homeInjuryCount: 0,
        awayInjuryCount: 0,

        homeMotivation: 0.70,
        awayMotivation: 0.70,

        homeTactical: 0.50,
        awayTactical: 0.50,

        prediction: prediction.prediction,

        homeProbability: Number(
          prediction.homeScore.toFixed(3)
        ),

        awayProbability: Number(
          prediction.awayScore.toFixed(3)
        ),

        confidence: Number(
          prediction.confidence.toFixed(3)
        ),

        homePosition: homeStats.position,
        awayPosition: awayStats.position,

        dataQuality: {
          standings: true,
          injuries: false
        }
      });
    }


    /*
      Strongest matches first.
    */
    output.sort(
      (a, b) => b.confidence - a.confidence
    );


    res.json({
      matches: output,
      count: output.length,
      fixturesFound: fixtures.length,
      competition,
      generatedAt: new Date().toISOString(),

      note:
        "Prediction currently uses league standings, win rate, points rate and goals. Injury data is not currently available from this provider."
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});


app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Football Selector running on port ${PORT}`
    );
  }
);
