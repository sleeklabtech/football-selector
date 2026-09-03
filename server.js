const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE = "https://v3.football.api-sports.io";
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function clamp(x){ return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function pct(x){ const n=Number(String(x??"").replace("%","")); return Number.isFinite(n)?n/100:null; }
function cacheGet(key){ const v=cache.get(key); if(!v) return null; if(Date.now()-v.t>CACHE_TTL_MS){cache.delete(key);return null;} return v.data; }
function cacheSet(key,data){cache.set(key,{t:Date.now(),data});return data;}

async function api(endpoint, params={}, ttl=CACHE_TTL_MS){
  if(!API_KEY) throw new Error("Missing API_FOOTBALL_KEY. Set it before starting the server.");
  const url = new URL(BASE + endpoint);
  Object.entries(params).forEach(([k,v])=>{ if(v!==undefined && v!=="") url.searchParams.set(k,v); });
  const key=url.toString();
  const hit=cacheGet(key); if(hit) return hit;
  const r=await fetch(url,{headers:{"x-apisports-key":API_KEY}});
  const j=await r.json();
  if(!r.ok || (j.errors && Object.keys(j.errors).length)) throw new Error(JSON.stringify(j.errors||`HTTP ${r.status}`));
  return cacheSet(key,j);
}

function fixtureToMatch(f){
  return {id:f.fixture?.id,home:f.teams?.home?.name,away:f.teams?.away?.name,kickoff:f.fixture?.date,homeId:f.teams?.home?.id,awayId:f.teams?.away?.id,status:f.fixture?.status?.short};
}

async function teamStats(league,season,team){
  try{
    const d=(await api("/teams/statistics",{league,season,team},12*60*60*1000)).response||{};
    const gf=Number(d.goals?.for?.average?.total)||0, ga=Number(d.goals?.against?.average?.total)||0;
    const form=(d.form||"").slice(-5);
    const formScore=form.length?[...form].reduce((s,c)=>s+(c==="W"?1:c==="D"?.5:0),0)/form.length:.5;
    const wins=Number(d.fixtures?.wins?.total)||0, played=Number(d.fixtures?.played?.total)||1;
    const venue=d.venue?.wins?.percentage ? Number(d.venue.wins.percentage)/100 : null;
    return {gf,ga,formScore,winRate:wins/played,venue};
  }catch{return null}
}

function injuryScores(rows, homeId, awayId){
  const out={home:0,away:0,homeCount:0,awayCount:0};
  for(const x of rows){
    const tid=x.team?.id;
    if(tid===homeId){out.homeCount++; out.home+=1;}
    if(tid===awayId){out.awayCount++; out.away+=1;}
  }
  // Count is deliberately capped: this is a simple availability signal, not a player-value model.
  return {homeInjuries:clamp(out.home/8),awayInjuries:clamp(out.away/8),homeCount:out.homeCount,awayCount:out.awayCount};
}

async function leagueInjuries(league,season,date){
  try{
    const j=await api("/injuries",{league,season,date},4*60*60*1000);
    return j.response||[];
  }catch{return []}
}

app.get("/api/health",(req,res)=>res.json({ok:true,apiKeyConfigured:Boolean(API_KEY),cacheEntries:cache.size}));

app.get("/api/matches",async(req,res)=>{
  try{
    const league=Number(req.query.league||39), date=req.query.date;
    if(!date) return res.status(400).json({error:"Choose a date."});
    const fixtures=(await api("/fixtures",{league,date,status:"NS"},10*60*1000)).response||[];
    const season=fixtures[0]?.league?.season || new Date(date).getFullYear();
    const injuries=await leagueInjuries(league,season,date);
    const teamCache=new Map();
    const getStats=async id=>{if(!teamCache.has(id))teamCache.set(id,teamStats(league,season,id));return teamCache.get(id)};
    const out=[];
    for(const f of fixtures){
      const h=f.teams.home,a=f.teams.away;
      const [hs,as]=await Promise.all([getStats(h.id),getStats(a.id)]);
      if(!hs||!as) continue;
      const ins=injuryScores(injuries,h.id,a.id);
      const homeVenue=hs.venue??hs.winRate, awayVenue=as.venue??as.winRate;
      out.push({...fixtureToMatch(f),
        homeForm:clamp(hs.formScore),awayForm:clamp(as.formScore),
        homeVenue:clamp(homeVenue),awayVenue:clamp(awayVenue),
        homeAttack:clamp(hs.gf/3),awayAttack:clamp(as.gf/3),
        homeDefense:clamp(1-hs.ga/3),awayDefense:clamp(1-as.ga/3),
        homeInjuries:ins.homeInjuries,awayInjuries:ins.awayInjuries,
        homeInjuryCount:ins.homeCount,awayInjuryCount:ins.awayCount,
        homeMotivation:.70,awayMotivation:.70,homeTactical:.50,awayTactical:.50,
        dataQuality:{stats:true,injuries:injuries.length>0,injuryRows:injuries.length}
      });
    }
    res.json({matches:out,count:out.length,fixturesFound:fixtures.length,season,injuryRows:injuries.length,generatedAt:new Date().toISOString(),note:"Motivation and tactical scores remain neutral placeholders; verify these manually."});
  }catch(e){res.status(500).json({error:e.message})}
});

app.listen(PORT,'0.0.0.0',()=>console.log(`Football Selector running on port ${PORT}`));
