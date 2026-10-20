'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'nba-perfect-player.html'), 'utf8');
const user = { _isUser:true, ovr:70 };
const stars = Array.from({length:10}, () => ({ovr:90}));
const context = {
  window:{}, console, Math, STATE:{careerTeam:'TEST', finalOVR:70, attrs:{}, career:{seasonCount:0,flags:{}}, season:{_usageBias:1, games:[], playerStats:{}}},
  calcTeamLineup:() => ({allPlayers:stars.concat(user), starters:Object.fromEntries(stars.slice(0,5).map((p,i)=>[i,p])), bench:[user].concat(stars.slice(5)), isUserStarter:false}),
  calcOVR:()=>70, simGaussian:mean=>mean, getHupuDisplayName:()=> 'Test', syncUserStarterStatus:()=>context.STATE.season.isUserStarter,
};
vm.createContext(context);
const start = html.indexOf('function getPlayerRotationMinutes(');
vm.runInContext(html.slice(start, html.indexOf('function syncUserStatsIntoBoxScore', start)), context);
context.getSeasonUsageBias = () => 1;
const awardSource = fs.readFileSync(path.join(root, 'assets/js/perfect-player-awards.js'), 'utf8');
vm.runInContext(awardSource.replace('var api = {', 'var api = { buildUserCandidate:buildUserCandidate, userIndividualRank:userIndividualRank, individualAwardRecord:individualAwardRecord,'), context);
const engine = context.window.PERFECT_PLAYER_AWARD_ENGINE;
// Use the production lineup builder as well as the production minute allocator.
context.NBA2K_DATA = {TEST:stars.map((p,i)=>({...p,name:'Star'+i,pos:['PG','SG','SF','PF','C'][i%5]}))};
context.STATE.position='PG';
vm.runInContext(html.slice(html.indexOf('function getPlayerPositions('), html.indexOf('function clearLineupCache()')),context);
assert.equal(context.calcTeamLineup('TEST').bench[0]._isUser,true);
const minutes = context.getPlayerRotationMinutes({}, 'PG', false);
context.STATE.finalOVR=99;
context.STATE._lineupCache={};
assert.equal(context.getPlayerRotationMinutes({},'PG',false),36,'starter minutes must remain unchanged');
context.STATE.finalOVR=70;
context.STATE._lineupCache={};
assert.equal(minutes, 25, 'designated sixth man must use rotation slot, not overall roster OVR rank');
function season(bench, starts, mpg=25) {
  const logs = Array.from({length:bench+starts}, (_,i)=>({stats:{mins:mpg},isUserStarter:i>=bench}));
  context.STATE.season = {isUserStarter:starts>0, games:logs, playerStats:{games:logs.length, mins:logs.length*mpg, pts:logs.length*30,reb:logs.length*8,ast:logs.length*8}};
  return engine.buildUserCandidate({});
}
let candidate = season(60,22,minutes);
assert.equal(candidate.games,82);
assert.equal(candidate.minutes,25);
assert.equal(candidate.starts,22);
assert.equal(candidate.benchGames,60);
assert.equal(engine.eligibility(candidate,'sixthman').eligible,true);
assert.equal(engine.userIndividualRank([candidate],[], 'sixthman'), '未进入前五');
assert.equal(engine.eligibility(candidate,'mvp').eligible,true);
assert.equal(engine.eligibility(candidate,'roty').eligible,true);
assert.equal(engine.eligibility(candidate,'allRookie').eligible,true);
candidate=season(22,60);
context.STATE.season.isUserStarter=false;
candidate=engine.buildUserCandidate({});
assert.equal(engine.eligibility(candidate,'sixthman').eligible,false);
assert.equal(engine.eligibility(candidate,'mvp').eligible,true);
assert.equal(engine.eligibility(season(39,0),'sixthman').eligible,false);
assert.equal(engine.eligibility(season(40,0,15),'sixthman').eligible,true);
assert.equal(engine.eligibility(season(82,0,14),'sixthman').eligible,false);
assert.equal(engine.eligibility(season(82,0,19),'mvp').eligible,false);
assert.equal(engine.eligibility(season(34,0),'roty').eligible,false);
assert.equal(engine.eligibility(season(35,0,14),'roty').eligible,true);
// Missed games do not add appearances; injury minutes count toward the 65-game rule.
season(65,0,20);
context.STATE.season.games.push({stats:null,suspended:true});
candidate=engine.buildUserCandidate({});
assert.equal(candidate.games,65);
assert.equal(candidate.benchGames,65);
assert.equal(candidate.eligibleGames,65);
context.STATE.season.games[0].stats.mins=14;
assert.equal(engine.eligibility(engine.buildUserCandidate({}),'dpoy').eligible,false);
// Legacy saves have no role snapshots; preserve the existing fallback for unknown games.
season(82,0);
context.STATE.season.games.forEach(g=>delete g.isUserStarter);
assert.equal(engine.buildUserCandidate({}).benchGames,82);
// Execute the production regular-season accumulation block for a complete season.
const accumulationStart = html.indexOf('      var ps = STATE.season.playerStats;', html.indexOf('      var stats = generatePlayerStatsNew(STATE.attrs, result, false);', html.indexOf('function quickSimAllGames()')));
const accumulationEnd = html.indexOf('      simDayLeagueGames(g.day);', accumulationStart);
const accumulation = html.slice(accumulationStart, accumulationEnd);
context.STATE.season = {isUserStarter:false,games:[],playerStats:Object.fromEntries(['pts','reb','ast','stl','blk','tov','fgm','fga','ftm','fta','threeM','threeA','mins','games'].map(k=>[k,0]))};
context.result = {};
for(let i=0;i<82;i++) {
  context.STATE.season.isUserStarter=i>=60;
  context.g={day:i};
  context.stats={pts:30,reb:8,ast:8,stl:2,blk:1,tov:2,fgm:10,fga:20,ftm:7,fta:8,threeM:3,threeA:7,mins:minutes};
  vm.runInContext(accumulation, context);
}
candidate=engine.buildUserCandidate({});
assert.equal(candidate.games,82);
assert.equal(candidate.minutes,25);
assert.equal(candidate.starts,22);
assert.equal(candidate.benchGames,60);
const award=engine.individualAwardRecord('sixthman','最佳第六人',[candidate]);
assert.equal(award.record.isUser,true, 'eligible sixth man must be able to win through production ballot and settlement record');
assert.match(award.record.userRank,/第一名/);
// Injury appearances use the same role snapshots and totals; missed games never do.
const hurtStart=html.indexOf('          var psH = STATE.season.playerStats;',html.indexOf('function quickSimAllGames()'));
const hurtEnd=html.indexOf('          var worsenText',hurtStart);
context.hurtStats={...context.stats,mins:12};
context.hurtResult={};
context.STATE.season.isUserStarter=false;
vm.runInContext(html.slice(hurtStart,hurtEnd),context);
candidate=engine.buildUserCandidate({});
assert.equal(candidate.games,83);
assert.equal(candidate.benchGames,61);
assert.equal(candidate.starts,22);
assert.equal(candidate.eligibleGames,82);
context.STATE.career.seasonCount=1;
assert.equal(engine.eligibility(engine.buildUserCandidate({}),'roty').eligible,false);
console.log('sixth-man regression passed');
