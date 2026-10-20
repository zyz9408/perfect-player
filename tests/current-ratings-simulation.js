const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const rosterSource = fs.readFileSync(path.join(root, 'assets/js/hupu/script-01-2678-5hu3djrc-upload-1783494754597-12.js'), 'utf8');
const ratingSource = fs.readFileSync(path.join(root, 'assets/js/current-player-ratings-2026.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'nba-perfect-player.html'), 'utf8');
const ATTRS = ['threePT','MID','FIN','DNK','HAN','PAS','PDEF','IDEF','BLK','REB','ATH','STR','CLU'];

function seededMath(seed) {
  const math = Object.create(Math);
  let state = seed >>> 0;
  math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return math;
}

function loadUpdatedRoster() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(rosterSource + '\n' + ratingSource + '\n;globalThis.__DATA = NBA2K_DATA;', context);
  return { data: context.__DATA, meta: context.window.NBA_CURRENT_RATINGS_2026_META };
}

const updated = loadUpdatedRoster();
const rosterPlayers = Object.values(updated.data).flat();
assert.equal(Object.keys(updated.data).length, 30, 'ratings must preserve all 30 teams');
assert.equal(rosterPlayers.length, 525, 'ratings must cover all 525 current roster entries');
assert.equal(updated.meta.seasonMatches, 517, '2025-26 season matching coverage changed unexpectedly');
assert.equal(updated.meta.noSeasonGames, 8, 'full-season no-game fallback count changed unexpectedly');
assert.equal(rosterPlayers.filter(player => player.ratingSeason === '2025-26').length, 525, 'every current player must be season-tagged');
assert.equal(rosterPlayers.filter(player => player.ratingBasis === 'no-2025-26-games').length, 8, 'no-game players must use explicit fallback');
for (const player of rosterPlayers) {
  assert.ok(player.ovr >= 65 && player.ovr <= 99, player.name + ' OVR out of range');
  for (const attr of ATTRS) assert.ok(player[attr] >= 25 && player[attr] <= 99, player.name + ' ' + attr + ' out of range');
}
const topRatings = rosterPlayers.slice().sort((a, b) => b.ovr - a.ovr).slice(0, 5).map(player => player.name);
assert.ok(topRatings.includes('Shai Gilgeous-Alexander'), '2025-26 MVP must remain in the top rating tier');
assert.ok(topRatings.includes('Nikola Jokic'), '2025-26 MVP runner-up must remain in the top rating tier');

const statStart = html.indexOf('function simSkill01');
const statEnd = html.indexOf('// ==================== 联盟其他比赛模拟', statStart);
assert.ok(statStart >= 0 && statEnd > statStart, 'could not locate player-stat engine');
const statContext = {
  Math: seededMath(202526),
  console,
  window: {},
  SIM_CONFIG: {
    SHOOTING: {
      threePT: { min:.22, max:.45 }, MID:{ min:.25, max:.52 }, FIN:{ min:.35, max:.70 }, FT:{ min:.52, max:.90 },
    },
    SHOT_DIST: {
      PG:{ threePT:.35, MID:.25, FIN:.25 }, SG:{ threePT:.38, MID:.22, FIN:.22 }, SF:{ threePT:.30, MID:.20, FIN:.30 },
      PF:{ threePT:.20, MID:.18, FIN:.38 }, C:{ threePT:.08, MID:.18, FIN:.48 },
    },
  },
  STATE: { position:'PG', finalOVR:75, careerTeam:null, career:null, season:null },
  calcOVR(attrs) { return Math.round(ATTRS.reduce((sum, key) => sum + Number(attrs[key] || 50), 0) / ATTRS.length); },
  getSimulationPowerBaseline() { return { offense:70, defense:70, athletic:70, depth:70 }; },
  simGaussian(mean, deviation) {
    const u = Math.max(0.000001, statContext.Math.random());
    const v = Math.max(0.000001, statContext.Math.random());
    return mean + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * deviation;
  },
};
vm.createContext(statContext);
vm.runInContext(html.slice(statStart, statEnd), statContext, { filename:'player-stat-engine.js' });

function attrs(value) {
  return Object.fromEntries(ATTRS.map(key => [key, value]));
}

function averageProfile(playerAttrs, position, defense = 70, games = 4000) {
  statContext.STATE.position = position;
  statContext.STATE.finalOVR = statContext.calcOVR(playerAttrs);
  const total = { pts:0,reb:0,ast:0,stl:0,blk:0,tov:0,fgm:0,fga:0,ftm:0,fta:0,threeM:0,threeA:0,mins:0 };
  for (let i = 0; i < games; i++) {
    const line = statContext.generatePlayerStatsNew(playerAttrs, {
      scoreA:116, scoreB:114, pace:99.4, boxScore:null, teamB:{ power:{ defense } },
    }, false);
    for (const key of Object.keys(total)) total[key] += line[key] || 0;
  }
  const result = Object.fromEntries(Object.entries(total).map(([key, value]) => [key, value / games]));
  result.fgPct = total.fgm / Math.max(1, total.fga);
  result.threePct = total.threeM / Math.max(1, total.threeA);
  return result;
}

const shooterHigh = { ...attrs(70), threePT:95 };
const shooterLow = { ...attrs(70), threePT:45 };
const shooterHighAvg = averageProfile(shooterHigh, 'SG');
const shooterLowAvg = averageProfile(shooterLow, 'SG');
assert.ok(shooterHighAvg.threeA > shooterLowAvg.threeA * 1.25, 'three-point rating must materially change shot selection');
assert.ok(shooterHighAvg.threePct > shooterLowAvg.threePct + 0.09, 'three-point rating must materially change accuracy');

const equalShooter = { ...attrs(70), threePT:95, FIN:55, DNK:60 };
const equalSlasher = { ...attrs(70), threePT:45, FIN:85, DNK:80 };
assert.equal(statContext.calcOVR(equalShooter), statContext.calcOVR(equalSlasher), 'archetype comparison must keep the same test OVR');
const equalShooterAvg = averageProfile(equalShooter, 'SG');
const equalSlasherAvg = averageProfile(equalSlasher, 'SG');
assert.ok(Math.abs(equalShooterAvg.mins - equalSlasherAvg.mins) < 0.2, 'same-OVR archetypes must receive comparable minutes');
assert.ok(equalShooterAvg.threeA > equalSlasherAvg.threeA * 1.45, 'same-OVR shooter must take more threes than slasher');
assert.ok(equalSlasherAvg.fta > equalShooterAvg.fta * 1.12, 'same-OVR slasher must draw more free throws than shooter');

const creatorHigh = { ...attrs(70), HAN:92, PAS:96, CLU:86 };
const creatorLow = { ...attrs(70), HAN:52, PAS:45, CLU:60 };
const creatorHighAvg = averageProfile(creatorHigh, 'PG');
const creatorLowAvg = averageProfile(creatorLow, 'PG');
assert.ok(creatorHighAvg.ast > creatorLowAvg.ast * 1.45, 'passing and handle must materially change assists');

const equalPlaymaker = { ...attrs(70), PAS:95, HAN:85, REB:45, STR:55 };
const equalGlassCleaner = { ...attrs(70), PAS:45, HAN:55, REB:95, STR:85 };
assert.equal(statContext.calcOVR(equalPlaymaker), statContext.calcOVR(equalGlassCleaner), 'role comparison must keep the same test OVR');
const equalPlaymakerAvg = averageProfile(equalPlaymaker, 'PF');
const equalGlassCleanerAvg = averageProfile(equalGlassCleaner, 'PF');
assert.ok(equalPlaymakerAvg.ast > equalGlassCleanerAvg.ast * 1.45, 'same-OVR playmaker must create more assists');
assert.ok(equalGlassCleanerAvg.reb > equalPlaymakerAvg.reb * 1.45, 'same-OVR glass cleaner must collect more rebounds');

const reboundHigh = { ...attrs(70), REB:96, STR:90 };
const reboundLow = { ...attrs(70), REB:45, STR:65 };
const reboundHighAvg = averageProfile(reboundHigh, 'C');
const reboundLowAvg = averageProfile(reboundLow, 'C');
assert.ok(reboundHighAvg.reb > reboundLowAvg.reb * 1.55, 'rebound rating must materially change rebounds');

const rimHigh = { ...attrs(70), BLK:97, IDEF:93, ATH:84 };
const rimLow = { ...attrs(70), BLK:42, IDEF:52, ATH:70 };
const rimHighAvg = averageProfile(rimHigh, 'C');
const rimLowAvg = averageProfile(rimLow, 'C');
assert.ok(rimHighAvg.blk > rimLowAvg.blk * 1.8, 'block and interior defense must materially change blocks');

const offense = { ...attrs(82), PDEF:70, IDEF:70, BLK:60, REB:65 };
const weakDefenseAvg = averageProfile(offense, 'SF', 55);
const strongDefenseAvg = averageProfile(offense, 'SF', 85);
assert.ok(weakDefenseAvg.fgPct > strongDefenseAvg.fgPct + 0.025, 'opponent defense must reduce shooting efficiency');
assert.ok(strongDefenseAvg.tov > weakDefenseAvg.tov, 'opponent defense must increase turnovers');

// Issue #2: elite creation must not routinely turn into 40+ PPG seasons.
// Hold opponents, pace, age/season bias and RNG fixed; test the actual stat engine.
const scoringTiers = {};
for (const rating of [75, 82, 90, 95, 99]) {
  statContext.Math = seededMath(20260817 + rating);
  statContext.STATE.season = { _usageBias:1.14 };
  scoringTiers[rating] = averageProfile(attrs(rating), 'SG', 70, 4000);
}
assert.ok(scoringTiers[82].pts > 24 && scoringTiers[82].pts < 31, 'established scorers should retain their scoring role');
assert.ok(scoringTiers[95].pts < 40, 'elite season scoring inflated: ' + scoringTiers[95].pts);
assert.ok(scoringTiers[99].pts < 40, 'maximum-attribute season scoring inflated: ' + scoringTiers[99].pts);
assert.ok(scoringTiers[99].pts > 32, 'exceptional offensive builds must remain exceptional');
for (const rating of [82,90,95,99]) {
  const previous = {82:75,90:82,95:90,99:95}[rating];
  assert.ok(scoringTiers[rating].pts > scoringTiers[previous].pts, 'offensive rating progression must remain meaningful');
}
for (const position of ['PG','SG','SF','PF','C']) {
  statContext.Math = seededMath(827);
  statContext.STATE.season = { _usageBias:1.14 };
  const elite = averageProfile(attrs(99), position, 70, 4000);
  assert.ok(elite.pts > 32 && elite.pts < 40, position + ' elite scoring drifted: ' + elite.pts);
}
statContext.STATE.season = null;

function makeBoxPlayer(name, pos, offenseValue, defenseValue) {
  return {
    name, cname:name, pos, ovr:Math.round((offenseValue + defenseValue) / 2),
    threePT:offenseValue, MID:offenseValue, FIN:offenseValue, DNK:offenseValue, HAN:offenseValue, PAS:offenseValue,
    PDEF:defenseValue, IDEF:defenseValue, BLK:defenseValue, REB:defenseValue, ATH:75, STR:75, CLU:offenseValue,
  };
}
const boxTeams = {};
for (const team of ['A','B']) {
  const starters = ['PG','SG','SF','PF','C'].map((pos, i) => makeBoxPlayer(team + '-S' + i, pos, i === 0 ? 95 : 72, i === 0 ? 55 : 76));
  const bench = ['PG','SG','SF','PF','C'].map((pos, i) => makeBoxPlayer(team + '-B' + i, pos, 65, 70));
  boxTeams[team] = { starters:Object.fromEntries(starters.map(player => [player.pos, player])), bench, allPlayers:starters.concat(bench) };
}
statContext.calcTeamLineup = team => boxTeams[team];
const box = statContext.generateBoxScore('A', 'B', 116, 108);
for (const [team, score] of [['A',116],['B',108]]) {
  assert.equal(box[team].reduce((sum, row) => sum + row.pts, 0), score, team + ' box-score points must equal team score');
  assert.equal(box[team].reduce((sum, row) => sum + row.mins, 0), 240, team + ' rotation must total 240 minutes');
  assert.ok(box[team].reduce((sum, row) => sum + row.reb, 0) >= 34, team + ' rebounds below NBA range');
  assert.ok(box[team][0].pts > box[team][4].pts, team + ' primary scorer must receive more points than a low-creation starter');
}

const macroStart = html.indexOf('function simGaussian');
const macroEnd = html.indexOf('function simulateGameNew', macroStart);
assert.ok(macroStart >= 0 && macroEnd > macroStart, 'could not locate matchup engine');
const powerMap = {
  A:{ offense:75, defense:75, athletic:75, clutch:75, depth:75 },
  B:{ offense:75, defense:75, athletic:75, clutch:75, depth:75 },
};
const macroContext = {
  Math:seededMath(82526), console,
  STATE:{ careerTeam:null, career:null, finalOVR:0, _simPowerBaseline:null },
  NBA2K_TEAMS:['A','B'],
  calcTeamPowerWithPlayer:team => powerMap[team],
  getNextSeasonMods:() => ({}),
  getCareerProfileEffects:() => ({ gameOffenseBonus:0, gameDefenseBonus:0, gameVarianceBonus:0 }),
  generateBoxScore:() => null,
};
vm.createContext(macroContext);
vm.runInContext(html.slice(macroStart, macroEnd), macroContext, { filename:'matchup-engine.js' });
let points = 0;
let pace = 0;
const equalGames = 8000;
for (let i = 0; i < equalGames; i++) {
  const result = macroContext.simulate82StyleMatchup('A','B',{ teamAHome:i % 2 === 0, includeBoxScore:false, neutralState:true });
  points += result.scoreA + result.scoreB;
  pace += result.pace;
}
const avgPoints = points / equalGames / 2;
const avgPace = pace / equalGames;
assert.ok(avgPoints >= 114.5 && avgPoints <= 116.8, 'league scoring baseline drifted: ' + avgPoints);
assert.ok(avgPace >= 98.8 && avgPace <= 100.0, 'league pace baseline drifted: ' + avgPace);

Object.assign(powerMap.A, { offense:83, defense:83, depth:82 });
Object.assign(powerMap.B, { offense:67, defense:67, depth:68 });
macroContext.STATE._simPowerBaseline = null;
let strongWins = 0;
const strengthGames = 4000;
for (let i = 0; i < strengthGames; i++) {
  if (macroContext.simulate82StyleMatchup('A','B',{ teamAHome:i % 2 === 0, includeBoxScore:false, neutralState:true }).won) strongWins++;
}
const strongWinRate = strongWins / strengthGames;
assert.ok(strongWinRate > 0.84 && strongWinRate < 0.97, 'large team-strength gap must create a clear but beatable favorite: ' + strongWinRate);

console.log(JSON.stringify({
  ratings:{ teams:30, players:525, seasonMatches:517, noSeasonGames:8, top:topRatings },
  attributes:{ shooterHigh:shooterHighAvg, shooterLow:shooterLowAvg, creatorHigh:creatorHighAvg, creatorLow:creatorLowAvg, reboundHigh:reboundHighAvg, reboundLow:reboundLowAvg, rimHigh:rimHighAvg, rimLow:rimLowAvg },
  scoringTiers:Object.fromEntries(Object.entries(scoringTiers).map(([rating, profile]) => [rating, {pts:profile.pts,fga:profile.fga,fta:profile.fta,mins:profile.mins}])),
  league:{ avgPoints:Number(avgPoints.toFixed(2)), avgPace:Number(avgPace.toFixed(2)), strongWinRate:Number(strongWinRate.toFixed(3)) },
}, null, 2));
