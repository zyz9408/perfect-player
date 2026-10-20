(function installPerfectPlayerAwardEngine() {
  'use strict';

  var AWARD_ENGINE_VERSION = '2026.10.20-rotation-v2';
  var MAJOR_65_GAME_AWARDS = { mvp:true, dpoy:true, mip:true, allNBA:true, allDefense:true };
  var INDIVIDUAL_AWARD_CONFIG = {
    mvp: { ballotSize:5, points:[10,7,5,3,1], noise:5.2 },
    dpoy: { ballotSize:3, points:[5,3,1], noise:5.8 },
    roty: { ballotSize:3, points:[5,3,1], noise:6.2 },
    mip: { ballotSize:3, points:[5,3,1], noise:6.8 },
    sixthman: { ballotSize:3, points:[5,3,1], noise:6.4 }
  };

  function n(value, fallback) {
    var result = Number(value);
    return Number.isFinite(result) ? result : (fallback == null ? 0 : fallback);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round1(value) {
    return Math.round(n(value) * 10) / 10;
  }

  function hash32(text) {
    var hash = 2166136261;
    var source = String(text || '');
    for (var i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function hash01(text) {
    return hash32(text) / 4294967295;
  }

  function currentAwardSeasonStart() {
    return 2026 + n(STATE && STATE.career && STATE.career.seasonCount, 0);
  }

  function currentAwardSeasonKey() {
    var start = currentAwardSeasonStart();
    return start + '-' + String((start + 1) % 100).padStart(2, '0');
  }

  function candidateKey(player, team) {
    if (player && player._isUser) return '__USER__';
    var identity = player && (player.nameEN || player.name || player.cname);
    return 'player:' + String(identity || team || 'unknown').toLowerCase();
  }

  function teamRecord(team) {
    var standings = STATE && STATE.season && STATE.season.standings;
    var row = standings && standings[team];
    var wins = n(row && row.wins, 0);
    var losses = n(row && row.losses, 0);
    var total = wins + losses;
    return {
      wins: wins,
      losses: losses,
      winPct: total > 0 ? wins / total : 0.5
    };
  }

  function buildTeamContexts() {
    var rows = [];
    var rawDefense = {};
    (NBA2K_TEAMS || []).forEach(function(team) {
      var record = teamRecord(team);
      var lineup = calcTeamLineup(team);
      var starters = Object.values(lineup.starters || {}).sort(function(a, b) { return n(b.ovr) - n(a.ovr); });
      var rotation = starters.concat((lineup.bench || []).slice(0, 5));
      var minutes = [36,34,33,31,29,27,23,19,15,10];
      var weighted = 0;
      var minuteTotal = 0;
      rotation.forEach(function(player, index) {
        var weight = minutes[index] || 8;
        var defense = n(player.PDEF, 55) * 0.36
          + n(player.IDEF, 55) * 0.34
          + n(player.BLK, 50) * 0.16
          + n(player.REB, 50) * 0.09
          + n(player.ATH, 55) * 0.05;
        weighted += defense * weight;
        minuteTotal += weight;
      });
      rawDefense[team] = minuteTotal ? weighted / minuteTotal : 55;
      rows.push({ team:team, wins:record.wins, losses:record.losses, winPct:record.winPct });
    });

    rows.sort(function(a, b) { return b.winPct - a.winPct || b.wins - a.wins || a.team.localeCompare(b.team); });
    var defenseValues = Object.keys(rawDefense).map(function(team) { return rawDefense[team]; });
    var minDefense = Math.min.apply(null, defenseValues);
    var maxDefense = Math.max.apply(null, defenseValues);
    var contexts = {};
    rows.forEach(function(row, index) {
      var defensePct = maxDefense === minDefense ? 0.5 : (rawDefense[row.team] - minDefense) / (maxDefense - minDefense);
      contexts[row.team] = {
        team: row.team,
        wins: row.wins,
        losses: row.losses,
        winPct: row.winPct,
        leagueRank: index + 1,
        teamDefense: clamp(defensePct, 0, 1),
        rawDefense: rawDefense[row.team]
      };
    });
    return contexts;
  }

  function getRotationRole(team, player) {
    var lineup = calcTeamLineup(team);
    var starters = Object.values(lineup.starters || {});
    var starterIndex = starters.indexOf(player);
    if (starterIndex >= 0) {
      var sortedStarters = starters.slice().sort(function(a, b) { return n(b.ovr) - n(a.ovr); });
      var orderedIndex = sortedStarters.indexOf(player);
      return { starter:true, rotationIndex:orderedIndex, minutes:[36,34,33,31,29][orderedIndex] || 30 };
    }
    var benchIndex = (lineup.bench || []).indexOf(player);
    return { starter:false, rotationIndex:benchIndex, minutes:[27,23,19,15,11,8][benchIndex] || 6 };
  }

  function leagueGamesFor(player, seasonKey) {
    var age = typeof getLeaguePlayerAge === 'function' ? n(getLeaguePlayerAge(player), 26) : n(player._age, 26);
    var sampleGames = n(player.ratingSampleGames, 0);
    var priorAvailabilityPenalty = sampleGames > 0 ? Math.max(0, 72 - sampleGames) * 0.12 : 0;
    if (player.ratingBasis === 'no-2025-26-games') priorAvailabilityPenalty += 4;
    var agePenalty = age >= 37 ? 6 + (age - 37) * 1.5 : age >= 33 ? (age - 32) * 0.8 : 0;
    var durabilityBonus = (n(player.ATH, 70) - 70) * 0.035 + (n(player.STR, 70) - 70) * 0.02;
    var randomMissed = Math.floor(hash01(seasonKey + '|games|' + candidateKey(player)) * 11);
    return clamp(Math.round(82 - randomMissed - agePenalty - priorAvailabilityPenalty + durabilityBonus), 54, 82);
  }

  function estimatedLeagueStats(player, role, seasonKey) {
    var ovr = n(player.ovr, 60);
    var minutes = role.minutes;
    var form = 0.94 + hash01(seasonKey + '|form|' + candidateKey(player)) * 0.12;
    var scoringSkill = n(player.FIN, 55) * 0.25
      + n(player.MID, 55) * 0.20
      + n(player.threePT, 55) * 0.20
      + n(player.HAN, 55) * 0.20
      + n(player.CLU, 55) * 0.15;
    var ptsPer36 = 4 + Math.max(0, scoringSkill - 50) * 0.52 + Math.max(0, ovr - 80) * 0.14;
    var pts = clamp(ptsPer36 * minutes / 36 * form, 2, 36);
    var pos = String(player.pos || 'SF').split('/')[0].trim();
    var rebPer36 = 1 + Math.max(0, n(player.REB, 45) - 45) * 0.13
      + (pos === 'C' ? 1.5 : pos === 'PF' ? 0.7 : 0);
    var astPer36 = 0.8 + Math.max(0, n(player.PAS, 45) - 45) * 0.12
      + (pos === 'PG' ? 1.1 : 0)
      + (n(player.PAS, 50) >= 90 && n(player.HAN, 50) >= 85 ? 0.8 : 0);
    var stlPer36 = 0.35 + Math.max(0, n(player.PDEF, 50) - 48) * 0.023 + Math.max(0, n(player.ATH, 60) - 75) * 0.008;
    var blockPosition = pos === 'C' ? 1 : pos === 'PF' ? 0.72 : pos === 'SF' ? 0.42 : 0.25;
    var blkPer36 = 0.12 + Math.max(0, n(player.BLK, 45) - 42) * 0.032 * blockPosition;
    var shooting = (n(player.FIN, 55) + n(player.MID, 55) + n(player.threePT, 55)) / 3;
    var ts = clamp(0.505 + (shooting - 55) * 0.0017 + (ovr - 70) * 0.0008, 0.49, 0.675);
    var tov = clamp(0.8 + pts * 0.035 + (astPer36 * minutes / 36) * 0.13, 0.6, 5.2);
    return {
      pts:round1(pts),
      reb:round1(rebPer36 * minutes / 36 * (0.97 + hash01(seasonKey + '|reb|' + candidateKey(player)) * 0.06)),
      ast:round1(astPer36 * minutes / 36 * (0.96 + hash01(seasonKey + '|ast|' + candidateKey(player)) * 0.08)),
      stl:round1(stlPer36 * minutes / 36),
      blk:round1(blkPer36 * minutes / 36),
      tov:round1(tov),
      ts:round1(ts * 1000) / 1000,
      minutes:round1(minutes),
      pos:pos
    };
  }

  function isLeagueRookie(player, seasonStart) {
    if (!player) return false;
    if (player._enterYear == null && (player.type === '新秀' || /^Draft2026_|^Rookie_/.test(String(player.name || '')))) {
      player._enterYear = seasonStart;
    }
    return n(player._enterYear, -1) === seasonStart;
  }

  function syntheticPrior(candidate, seasonKey) {
    if (candidate.isRookie) return null;
    var age = n(candidate.age, 26);
    var development = age <= 21 ? 0.78 : age === 22 ? 0.84 : age === 23 ? 0.89 : age === 24 ? 0.93 : age === 25 ? 0.96 : 0.985;
    if (age >= 30) development = 1.01;
    development *= 0.98 + hash01(seasonKey + '|prior|' + candidate.key) * 0.04;
    return {
      pts:round1(candidate.pts * development),
      reb:round1(candidate.reb * (0.97 + (development - 0.9) * 0.25)),
      ast:round1(candidate.ast * development),
      stl:round1(candidate.stl * 0.98),
      blk:round1(candidate.blk * 0.98),
      tov:round1(candidate.tov * Math.min(1.05, 2 - development)),
      ts:clamp(candidate.ts - (age <= 24 ? 0.012 : 0.003), 0.45, 0.68),
      minutes:clamp(candidate.minutes - (age <= 24 ? 3.5 : 0.5), 10, 38),
      games:clamp(candidate.games + Math.round((hash01(seasonKey + '|prior-gp|' + candidate.key) - 0.5) * 8), 45, 82),
      ovr:clamp(candidate.ovr - (age <= 21 ? 4 : age <= 23 ? 3 : age <= 25 ? 2 : 0), 50, 99)
    };
  }

  function buildLeagueCandidates(teamContexts) {
    var seasonStart = currentAwardSeasonStart();
    var seasonKey = currentAwardSeasonKey();
    var history = (STATE.career && STATE.career.leagueAwardHistory) || {};
    var candidates = [];
    (NBA2K_TEAMS || []).forEach(function(team) {
      var context = teamContexts[team] || { wins:0, losses:0, winPct:0.5, leagueRank:30, teamDefense:0.5 };
      (NBA2K_DATA[team] || []).forEach(function(player) {
        if (!player || player._isUser) return;
        var role = getRotationRole(team, player);
        if (role.minutes < 10) return;
        var games = leagueGamesFor(player, seasonKey);
        var starts = role.starter
          ? Math.max(0, games - Math.floor(hash01(seasonKey + '|starts|' + candidateKey(player)) * 5))
          : Math.floor(hash01(seasonKey + '|bench-starts|' + candidateKey(player)) * Math.min(12, games * 0.18));
        var stats = estimatedLeagueStats(player, role, seasonKey);
        var key = candidateKey(player, team);
        var candidate = {
          key:key,
          player:player,
          name:player.cname || player.nameEN || player.name,
          nameEN:player.nameEN || player.name || '',
          team:team,
          pos:stats.pos,
          ovr:n(player.ovr, 50),
          age:typeof getLeaguePlayerAge === 'function' ? n(getLeaguePlayerAge(player), 25) : n(player._age, 25),
          isRookie:isLeagueRookie(player, seasonStart),
          isUser:false,
          games:games,
          eligibleGames:stats.minutes >= 20 ? games : (stats.minutes >= 15 ? Math.min(2, games) : 0),
          seasonEndingException:false,
          minutes:stats.minutes,
          starts:starts,
          benchGames:Math.max(0, games - starts),
          pts:stats.pts,
          reb:stats.reb,
          ast:stats.ast,
          stl:stats.stl,
          blk:stats.blk,
          tov:stats.tov,
          ts:stats.ts,
          pdef:n(player.PDEF, 50),
          idef:n(player.IDEF, 50),
          blockAttr:n(player.BLK, 50),
          reboundAttr:n(player.REB, 50),
          clutch:n(player.CLU, 50),
          wins:context.wins,
          losses:context.losses,
          winPct:context.winPct,
          leagueRank:context.leagueRank,
          teamDefense:context.teamDefense
        };
        candidate.prior = history[key] || syntheticPrior(candidate, seasonKey);
        candidates.push(candidate);
      });
    });
    return candidates;
  }

  function getUserEligibleGames(games, averageMinutes) {
    var logs = (STATE.season && STATE.season.games || []).filter(function(game) { return game && game.stats; });
    if (logs.length >= Math.max(1, games - 2)) {
      var twenty = 0;
      var fifteen = 0;
      logs.forEach(function(game) {
        var minutes = n(game.stats && game.stats.mins, 0);
        if (minutes >= 20) twenty++;
        else if (minutes >= 15) fifteen++;
      });
      return twenty + Math.min(2, fifteen);
    }
    if (averageMinutes >= 20) return games;
    if (averageMinutes >= 15) return Math.min(2, games);
    return 0;
  }

  function priorFromCareer() {
    var seasons = STATE.career && STATE.career.seasons || [];
    var last = seasons.length ? seasons[seasons.length - 1] : null;
    if (!last || !last.playerStats) return null;
    var stats = last.playerStats;
    var games = n(stats.games, 0);
    if (!games) return null;
    var possessions = n(stats.fga, 0) + 0.44 * n(stats.fta, 0);
    return {
      pts:round1(n(stats.pts) / games),
      reb:round1(n(stats.reb) / games),
      ast:round1(n(stats.ast) / games),
      stl:round1(n(stats.stl) / games),
      blk:round1(n(stats.blk) / games),
      tov:round1(n(stats.tov) / games),
      ts:possessions > 0 ? clamp(n(stats.pts) / (2 * possessions), 0.35, 0.75) : 0.54,
      minutes:round1(n(stats.mins, games * 30) / games),
      games:games,
      ovr:n(last.ovr, STATE.finalOVR)
    };
  }

  function buildUserCandidate(teamContexts) {
    var stats = STATE.season && STATE.season.playerStats || {};
    var games = n(stats.games, 0);
    if (!games) return null;
    syncUserStarterStatus();
    var minutes = n(stats.mins, 0) > 0 ? n(stats.mins) / games : (STATE.season.isUserStarter ? 34 : 26);
    var possessions = n(stats.fga, 0) + 0.44 * n(stats.fta, 0);
    var context = teamContexts[STATE.careerTeam] || { wins:n(STATE.season.wins), losses:n(STATE.season.losses), winPct:0.5, leagueRank:30, teamDefense:0.5 };
    var starter = !!STATE.season.isUserStarter;
    // Keep per-game roles across promotions/demotions. Old saves lack snapshots;
    // retain their previous fallback only for the unknown portion of the season.
    var roleLogs = (STATE.season.games || []).filter(function(game) {
      return game && game.stats && typeof game.isUserStarter === 'boolean';
    }).slice(0, games);
    var starts = roleLogs.filter(function(game) { return game.isUserStarter; }).length;
    starts += starter ? Math.max(0, games - roleLogs.length) : 0;
    var attrs = STATE.attrs || {};
    return {
      key:'__USER__',
      player:null,
      name:getHupuDisplayName(),
      nameEN:'',
      team:STATE.careerTeam,
      pos:STATE.position || 'SF',
      ovr:n(STATE.finalOVR, 50),
      age:n(STATE.career && STATE.career.currentAge, 22),
      isRookie:!STATE.career || n(STATE.career.seasonCount, 0) === 0,
      isUser:true,
      games:games,
      eligibleGames:getUserEligibleGames(games, minutes),
      seasonEndingException:games >= 62 && !!(STATE.season.events && STATE.season.events.majorInjuryThisSeason),
      minutes:round1(minutes),
      starts:starts,
      benchGames:games - starts,
      pts:round1(n(stats.pts) / games),
      reb:round1(n(stats.reb) / games),
      ast:round1(n(stats.ast) / games),
      stl:round1(n(stats.stl) / games),
      blk:round1(n(stats.blk) / games),
      tov:round1(n(stats.tov) / games),
      ts:possessions > 0 ? clamp(n(stats.pts) / (2 * possessions), 0.35, 0.75) : clamp(0.50 + (n(attrs.FIN, 55) + n(attrs.MID, 55) + n(attrs.threePT, 55) - 165) * 0.0007, 0.45, 0.68),
      pdef:n(attrs.PDEF, 50),
      idef:n(attrs.IDEF, 50),
      blockAttr:n(attrs.BLK, 50),
      reboundAttr:n(attrs.REB, 50),
      clutch:n(attrs.CLU, 50),
      wins:context.wins,
      losses:context.losses,
      winPct:context.winPct,
      leagueRank:context.leagueRank,
      teamDefense:context.teamDefense,
      prior:priorFromCareer()
    };
  }

  function impact(candidate) {
    return n(candidate.pts) + n(candidate.reb) * 0.72 + n(candidate.ast) * 0.95
      + n(candidate.stl) * 1.9 + n(candidate.blk) * 1.8 - n(candidate.tov) * 0.65;
  }

  function defensiveBox(candidate) {
    return n(candidate.stl) * 2.3 + n(candidate.blk) * 2.5 + n(candidate.reb) * 0.28;
  }

  function defensiveAttribute(candidate) {
    return n(candidate.pdef, 50) * 0.34 + n(candidate.idef, 50) * 0.34
      + n(candidate.blockAttr, 50) * 0.20 + n(candidate.reboundAttr, 50) * 0.12;
  }

  function improvement(candidate) {
    if (!candidate.prior) return -99;
    return impact(candidate) - impact(candidate.prior);
  }

  function eligibility(candidate, award) {
    if (!candidate) return { eligible:false, reason:'无有效赛季数据' };
    if (MAJOR_65_GAME_AWARDS[award]) {
      var eligibleGames = n(candidate.eligibleGames, candidate.minutes >= 20 ? candidate.games : 0);
      if (eligibleGames < 65 && !(candidate.seasonEndingException && eligibleGames >= 62)) {
        return { eligible:false, reason:'出勤不足（' + eligibleGames + '/65场）' };
      }
    }
    if ((award === 'mvp' || award === 'allNBA') && (candidate.minutes < 24 || impact(candidate) < 18)) {
      return { eligible:false, reason:'赛季角色或产出不足' };
    }
    if ((award === 'dpoy' || award === 'allDefense') && candidate.minutes < 20) {
      return { eligible:false, reason:'防守上场样本不足' };
    }
    if (award === 'roty' || award === 'allRookie') {
      if (!candidate.isRookie) return { eligible:false, reason:'非新秀赛季' };
      if (candidate.games < 35 || candidate.minutes < 14) return { eligible:false, reason:'新秀出勤或轮换样本不足' };
    }
    if (award === 'mip') {
      if (candidate.isRookie) return { eligible:false, reason:'新秀不进入进步最快主评选' };
      if (!candidate.prior) return { eligible:false, reason:'缺少上赛季对照' };
      if (candidate.minutes < 20 || impact(candidate) < 20 || improvement(candidate) < 1.5) {
        return { eligible:false, reason:'同比进步幅度不足' };
      }
    }
    if (award === 'sixthman') {
      if (n(candidate.benchGames) <= n(candidate.starts)) return { eligible:false, reason:'替补出场未多于首发' };
      if (candidate.games < 40 || candidate.minutes < 15) return { eligible:false, reason:'替补出勤或轮换样本不足' };
    }
    return { eligible:true, reason:'' };
  }

  function metricScale(candidates, getter) {
    var values = candidates.map(function(candidate) { return n(getter(candidate)); });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    return function(candidate) {
      var value = n(getter(candidate));
      if (max === min) return 0.5;
      return clamp((value - min) / (max - min), 0, 1);
    };
  }

  function scoreCandidates(allCandidates, award) {
    var candidates = allCandidates.filter(function(candidate) { return eligibility(candidate, award).eligible; });
    if (!candidates.length) return [];
    var impactPct = metricScale(candidates, impact);
    var efficiencyPct = metricScale(candidates, function(candidate) { return n(candidate.ts, 0.5) + Math.min(35, n(candidate.pts)) * 0.0012; });
    var teamPct = metricScale(candidates, function(candidate) { return n(candidate.winPct, 0.5); });
    var availabilityPct = metricScale(candidates, function(candidate) { return n(candidate.eligibleGames, candidate.games); });
    var defenseBoxPct = metricScale(candidates, defensiveBox);
    var defenseAttrPct = metricScale(candidates, defensiveAttribute);
    var teamDefensePct = metricScale(candidates, function(candidate) { return n(candidate.teamDefense, 0.5); });
    var versatilityPct = metricScale(candidates, function(candidate) { return Math.min(n(candidate.pdef, 50), n(candidate.idef, 50)); });
    var minutesPct = metricScale(candidates, function(candidate) { return n(candidate.minutes); });
    var clutchPct = metricScale(candidates, function(candidate) { return n(candidate.clutch, 50); });
    var gainPct = metricScale(candidates, improvement);
    var roleGainPct = metricScale(candidates, function(candidate) { return n(candidate.minutes) - n(candidate.prior && candidate.prior.minutes); });
    var efficiencyGainPct = metricScale(candidates, function(candidate) { return n(candidate.ts) - n(candidate.prior && candidate.prior.ts); });

    candidates.forEach(function(candidate) {
      var score = 0;
      if (award === 'mvp') {
        score = impactPct(candidate) * 42 + efficiencyPct(candidate) * 16 + teamPct(candidate) * 26
          + availabilityPct(candidate) * 10 + defenseAttrPct(candidate) * 6;
      } else if (award === 'dpoy') {
        score = defenseBoxPct(candidate) * 25 + defenseAttrPct(candidate) * 25 + teamDefensePct(candidate) * 25
          + teamPct(candidate) * 10 + versatilityPct(candidate) * 10 + availabilityPct(candidate) * 5;
      } else if (award === 'roty') {
        score = impactPct(candidate) * 50 + efficiencyPct(candidate) * 16 + minutesPct(candidate) * 14
          + availabilityPct(candidate) * 10 + teamPct(candidate) * 10;
      } else if (award === 'sixthman') {
        score = impactPct(candidate) * 45 + efficiencyPct(candidate) * 18 + minutesPct(candidate) * 10
          + availabilityPct(candidate) * 10 + teamPct(candidate) * 13 + clutchPct(candidate) * 4;
      } else if (award === 'mip') {
        score = gainPct(candidate) * 55 + roleGainPct(candidate) * 15 + efficiencyGainPct(candidate) * 10
          + impactPct(candidate) * 12 + teamPct(candidate) * 8;
        if (impact(candidate.prior) >= 36) score -= 10;
      } else if (award === 'allNBA') {
        score = impactPct(candidate) * 48 + efficiencyPct(candidate) * 16 + teamPct(candidate) * 18
          + availabilityPct(candidate) * 10 + defenseAttrPct(candidate) * 8;
      } else if (award === 'allDefense') {
        score = defenseBoxPct(candidate) * 28 + defenseAttrPct(candidate) * 27 + teamDefensePct(candidate) * 25
          + teamPct(candidate) * 8 + versatilityPct(candidate) * 7 + availabilityPct(candidate) * 5;
      } else if (award === 'allRookie') {
        score = impactPct(candidate) * 52 + efficiencyPct(candidate) * 16 + minutesPct(candidate) * 14
          + availabilityPct(candidate) * 10 + teamPct(candidate) * 8;
      } else if (award === 'allStar') {
        score = impactPct(candidate) * 58 + efficiencyPct(candidate) * 16 + teamPct(candidate) * 14
          + minutesPct(candidate) * 7 + clutchPct(candidate) * 5;
      }
      candidate._awardScores = candidate._awardScores || {};
      candidate._awardScores[award] = round1(score);
    });
    return candidates.sort(function(a, b) {
      return n(b._awardScores[award]) - n(a._awardScores[award]) || n(b.games) - n(a.games) || a.key.localeCompare(b.key);
    });
  }

  function runMediaBallot(scoredCandidates, award, voterCount) {
    var config = INDIVIDUAL_AWARD_CONFIG[award];
    voterCount = voterCount || 100;
    var seasonKey = currentAwardSeasonKey();
    var shortlist = scoredCandidates.slice(0, Math.max(12, config.ballotSize * 4));
    var totals = {};
    shortlist.forEach(function(candidate) {
      totals[candidate.key] = { candidate:candidate, points:0, firstPlaceVotes:0, ballotMentions:0 };
    });
    for (var voter = 0; voter < voterCount; voter++) {
      var teamPreference = hash01(seasonKey + '|' + award + '|team-pref|' + voter) - 0.5;
      var statsPreference = hash01(seasonKey + '|' + award + '|stats-pref|' + voter) - 0.5;
      var ballot = shortlist.map(function(candidate) {
        var noise = (hash01(seasonKey + '|' + award + '|voter|' + voter + '|' + candidate.key) - 0.5) * config.noise;
        var teamLean = teamPreference * (n(candidate.winPct, 0.5) - 0.5) * 12;
        var statsLean = statsPreference * (impact(candidate) - 25) * 0.14;
        return { candidate:candidate, score:n(candidate._awardScores[award]) + noise + teamLean + statsLean };
      }).sort(function(a, b) { return b.score - a.score || a.candidate.key.localeCompare(b.candidate.key); });
      ballot.slice(0, config.ballotSize).forEach(function(entry, place) {
        var total = totals[entry.candidate.key];
        total.points += config.points[place];
        total.ballotMentions++;
        if (place === 0) total.firstPlaceVotes++;
      });
    }
    var results = Object.keys(totals).map(function(key) { return totals[key]; });
    results.sort(function(a, b) {
      return b.points - a.points || b.firstPlaceVotes - a.firstPlaceVotes
        || n(b.candidate._awardScores[award]) - n(a.candidate._awardScores[award]) || a.candidate.key.localeCompare(b.candidate.key);
    });
    results.forEach(function(result, index) { result.rank = index + 1; });
    return results;
  }

  function runTeamBallot(scoredCandidates, award, teamSizes, teamPoints, voterCount) {
    voterCount = voterCount || 100;
    var totalSlots = teamSizes.reduce(function(sum, size) { return sum + size; }, 0);
    var seasonKey = currentAwardSeasonKey();
    var shortlist = scoredCandidates.slice(0, Math.max(totalSlots * 2, totalSlots + 8));
    var totals = {};
    shortlist.forEach(function(candidate) {
      totals[candidate.key] = { candidate:candidate, points:0, firstTeamVotes:0, ballotMentions:0 };
    });
    for (var voter = 0; voter < voterCount; voter++) {
      var teamPreference = hash01(seasonKey + '|' + award + '|team-ballot-pref|' + voter) - 0.5;
      var ballot = shortlist.map(function(candidate) {
        var noise = (hash01(seasonKey + '|' + award + '|team-voter|' + voter + '|' + candidate.key) - 0.5) * 5.5;
        var teamLean = teamPreference * (n(candidate.winPct, 0.5) - 0.5) * 10;
        return { candidate:candidate, score:n(candidate._awardScores[award]) + noise + teamLean };
      }).sort(function(a, b) { return b.score - a.score || a.candidate.key.localeCompare(b.candidate.key); });
      var slot = 0;
      for (var tier = 0; tier < teamSizes.length; tier++) {
        for (var tierSlot = 0; tierSlot < teamSizes[tier] && slot < ballot.length; tierSlot++, slot++) {
          var total = totals[ballot[slot].candidate.key];
          total.points += teamPoints[tier];
          total.ballotMentions++;
          if (tier === 0) total.firstTeamVotes++;
        }
      }
    }
    var results = Object.keys(totals).map(function(key) { return totals[key]; });
    results.sort(function(a, b) {
      return b.points - a.points || b.firstTeamVotes - a.firstTeamVotes
        || n(b.candidate._awardScores[award]) - n(a.candidate._awardScores[award]) || a.candidate.key.localeCompare(b.candidate.key);
    });
    results.forEach(function(result, index) { result.rank = index + 1; });
    return results;
  }

  function medalRank(rank) {
    if (rank === 1) return '🥇 第一名';
    if (rank === 2) return '🥈 第二名';
    if (rank === 3) return '🥉 第三名';
    if (rank === 4) return '第四名';
    if (rank === 5) return '第五名';
    return '未进入前五';
  }

  function userIndividualRank(candidates, results, award) {
    var user = candidates.find(function(candidate) { return candidate.isUser; });
    var check = eligibility(user, award);
    if (!check.eligible) return check.reason;
    var result = results.find(function(row) { return row.candidate.isUser; });
    return result ? medalRank(result.rank) : '未进入前五';
  }

  function resume(candidate, award, voteResult) {
    if (!candidate) return '';
    var stats;
    if (award === 'dpoy') {
      stats = candidate.stl.toFixed(1) + '断 ' + candidate.blk.toFixed(1) + '帽 · 球队防守第'
        + Math.max(1, Math.round((1 - candidate.teamDefense) * 29 + 1));
    } else if (award === 'mip') {
      stats = candidate.pts.toFixed(1) + '分 · 综合产出同比 +' + round1(improvement(candidate));
    } else if (award === 'sixthman') {
      stats = candidate.pts.toFixed(1) + '分 · 替补' + candidate.benchGames + '场/首发' + candidate.starts + '场';
    } else {
      stats = candidate.pts.toFixed(1) + '分 ' + candidate.reb.toFixed(1) + '板 ' + candidate.ast.toFixed(1) + '助';
    }
    var ballot = voteResult ? ' · ' + voteResult.points + '分/' + voteResult.firstPlaceVotes + '张第一选票' : '';
    return stats + ' · ' + candidate.wins + '-' + candidate.losses + ' · ' + candidate.games + '场' + ballot;
  }

  function individualAwardRecord(act, label, allCandidates) {
    var scored = scoreCandidates(allCandidates, act);
    var results = runMediaBallot(scored, act, 100);
    var winnerResult = results[0];
    var winner = winnerResult && winnerResult.candidate;
    var userRank = userIndividualRank(allCandidates, results, act);
    return {
      record:{
        act:act,
        label:label,
        winner:winner ? winner.name : '无符合资格球员',
        winnerEN:winner ? winner.nameEN : '',
        team:winner ? winner.team : '',
        isUser:!!(winner && winner.isUser),
        userRank:userRank,
        summary:winner ? resume(winner, act, winnerResult) : '本赛季无人达到评选门槛',
        voting:{ voters:100, points:winnerResult ? winnerResult.points : 0, firstPlaceVotes:winnerResult ? winnerResult.firstPlaceVotes : 0 }
      },
      results:results
    };
  }

  function listAwardRecord(act, label, scored, teamSizes, teamPoints, allCandidates) {
    var total = teamSizes.reduce(function(sum, size) { return sum + size; }, 0);
    var votingResults = runTeamBallot(scored, act, teamSizes, teamPoints, 100);
    var selected = votingResults.slice(0, total).map(function(result) { return result.candidate; });
    var firstTeam = selected.slice(0, teamSizes[0]);
    var user = allCandidates.find(function(candidate) { return candidate.isUser; });
    var check = eligibility(user, act);
    var userIndex = selected.findIndex(function(candidate) { return candidate.isUser; });
    var userRank = check.eligible ? '未入选' : check.reason;
    var userHonorLabel = label;
    if (userIndex >= 0) {
      var running = 0;
      for (var teamIndex = 0; teamIndex < teamSizes.length; teamIndex++) {
        running += teamSizes[teamIndex];
        if (userIndex < running) {
          if (act === 'allNBA') {
            userRank = ['🥇 最佳阵容一阵','🥈 最佳阵容二阵','🥉 最佳阵容三阵'][teamIndex];
            userHonorLabel = ['最佳阵容一阵','最佳阵容二阵','最佳阵容三阵'][teamIndex];
          } else if (act === 'allDefense') {
            userRank = ['🥇 最佳防守一阵','🥈 最佳防守二阵'][teamIndex];
            userHonorLabel = ['最佳防守一阵','最佳防守二阵'][teamIndex];
          } else {
            userRank = ['🥇 最佳新秀一阵','🥈 最佳新秀二阵'][teamIndex];
            userHonorLabel = ['最佳新秀一阵','最佳新秀二阵'][teamIndex];
          }
          break;
        }
      }
    }
    return {
      record:{
        act:act,
        label:label,
        winner:firstTeam.map(function(candidate) { return candidate.name; }).join('、'),
        winnerEN:firstTeam.map(function(candidate) { return candidate.nameEN || ''; }).join(','),
        team:'',
        isUser:userIndex >= 0,
        userRank:userRank,
        userHonorLabel:userIndex >= 0 ? userHonorLabel : '',
        isList:true,
        summary:act === 'allNBA' ? '100人媒体投票 · 5/3/1分 · 位置不限 · 展示一阵' : (act === 'allDefense' ? '100人媒体投票 · 2/1分 · 位置不限 · 展示一防' : '100人媒体投票 · 2/1分 · 位置不限 · 展示新秀一阵')
      },
      results:votingResults
    };
  }

  function serializeBallotResults(results, limit) {
    return (results || []).slice(0, limit || 15).map(function(result) {
      var candidate = result.candidate || {};
      return {
        rank:result.rank,
        name:candidate.name || '',
        team:candidate.team || '',
        isUser:!!candidate.isUser,
        points:n(result.points),
        firstPlaceVotes:n(result.firstPlaceVotes, result.firstTeamVotes),
        ballotMentions:n(result.ballotMentions)
      };
    });
  }

  function allStarRecord(allCandidates) {
    var eligible = allCandidates.filter(function(candidate) { return candidate.games >= 40 && candidate.minutes >= 18; });
    var scored = scoreCandidates(eligible, 'allStar');
    var byConference = { EAST:[], WEST:[] };
    scored.forEach(function(candidate) {
      var conference = typeof getConference === 'function' ? getConference(candidate.team) : 'WEST';
      (byConference[conference] || byConference.WEST).push(candidate);
    });
    var selected = byConference.EAST.slice(0, 12).concat(byConference.WEST.slice(0, 12));
    var user = allCandidates.find(function(candidate) { return candidate.isUser; });
    var selectedUser = selected.find(function(candidate) { return candidate.isUser; });
    var rank = -1;
    if (user) {
      var conf = typeof getConference === 'function' ? getConference(user.team) : 'WEST';
      rank = (byConference[conf] || []).findIndex(function(candidate) { return candidate.isUser; }) + 1;
    }
    var userRank = selectedUser ? '⭐ 入选' : (user && user.games < 40 ? '出勤不足' : (rank > 0 ? '分区第' + rank + '名' : '未入围'));
    return {
      act:'allStar', label:'全明星', winner:selectedUser ? user.name : userRank, winnerEN:'', team:'',
      isUser:!!selectedUser, userRank:userRank, summary:'分区各12人 · 综合个人表现、球队战绩与出勤'
    };
  }

  function storeLeagueAwardHistory(candidates) {
    if (!STATE.career) return;
    STATE.career.leagueAwardHistory = STATE.career.leagueAwardHistory || {};
    var history = STATE.career.leagueAwardHistory;
    candidates.filter(function(candidate) { return !candidate.isUser; }).forEach(function(candidate) {
      history[candidate.key] = {
        pts:candidate.pts, reb:candidate.reb, ast:candidate.ast, stl:candidate.stl, blk:candidate.blk,
        tov:candidate.tov, ts:candidate.ts, minutes:candidate.minutes, games:candidate.games, ovr:candidate.ovr,
        seasonKey:currentAwardSeasonKey()
      };
    });
  }

  function calculateRealisticSeasonAwards() {
    try {
      var playerStats = STATE.season && STATE.season.playerStats;
      if (!playerStats || !n(playerStats.games)) return;
      var seasonKey = currentAwardSeasonKey();
      if (STATE.season._awardVotingKey === seasonKey && (STATE.season.awards || []).some(function(award) { return award && award.act === 'mvp'; })) return;

      var preserved = (STATE.season.awards || []).filter(function(award) {
        return award && ['champion','fmvp'].indexOf(award.act) >= 0;
      });
      var teamContexts = buildTeamContexts();
      var leagueCandidates = buildLeagueCandidates(teamContexts);
      var userCandidate = buildUserCandidate(teamContexts);
      var allCandidates = leagueCandidates.concat(userCandidate ? [userCandidate] : []);

      var mvp = individualAwardRecord('mvp', 'MVP', allCandidates);
      var dpoy = individualAwardRecord('dpoy', 'DPOY', allCandidates);
      var mip = individualAwardRecord('mip', '进步最快球员', allCandidates);
      var sixth = individualAwardRecord('sixthman', '最佳第六人', allCandidates);
      var rookieCandidates = allCandidates.filter(function(candidate) { return candidate.isRookie; });
      var roty = individualAwardRecord('roty', '年度最佳新秀', rookieCandidates.concat(userCandidate && !userCandidate.isRookie ? [userCandidate] : []));

      var allNBA = listAwardRecord('allNBA', '最佳阵容', scoreCandidates(allCandidates, 'allNBA'), [5,5,5], [5,3,1], allCandidates);
      var allDefense = listAwardRecord('allDefense', '最佳防守阵容', scoreCandidates(allCandidates, 'allDefense'), [5,5], [2,1], allCandidates);
      var allRookie = listAwardRecord('allRookie', '最佳新秀阵容', scoreCandidates(rookieCandidates, 'allRookie'), [5,5], [2,1], allCandidates);

      var awards = [
        mvp.record,
        dpoy.record,
        mip.record,
        allStarRecord(allCandidates),
        roty.record,
        sixth.record,
        allNBA.record,
        allDefense.record,
        allRookie.record
      ];
      if (!userCandidate || !userCandidate.isRookie) {
        awards = awards.filter(function(award) { return award.act !== 'roty' && award.act !== 'allRookie'; });
      }
      STATE.season.awards = awards.concat(preserved);
      STATE.season.awardVoting = {
        version:AWARD_ENGINE_VERSION,
        season:seasonKey,
        voters:100,
        eligibilityRule:'MVP/DPOY/MIP/最佳阵容/最佳防守阵容：65场（每场至少20分钟，最多两场可为15-19分钟；赛季报销例外为62场）',
        ballotPoints:{ mvp:[10,7,5,3,1], other:[5,3,1], allNBA:[5,3,1], allDefense:[2,1], allRookie:[2,1] },
        results:{
          mvp:serializeBallotResults(mvp.results, 10),
          dpoy:serializeBallotResults(dpoy.results, 10),
          mip:serializeBallotResults(mip.results, 10),
          roty:serializeBallotResults(roty.results, 10),
          sixthman:serializeBallotResults(sixth.results, 10),
          allNBA:serializeBallotResults(allNBA.results, 20),
          allDefense:serializeBallotResults(allDefense.results, 15),
          allRookie:serializeBallotResults(allRookie.results, 15)
        }
      };
      STATE.season._awardVotingKey = seasonKey;
      storeLeagueAwardHistory(leagueCandidates);
      if (typeof updateAwardStreaks === 'function') updateAwardStreaks();
    } catch (error) {
      console.error('[AwardEngine] 评奖失败:', error);
      STATE.season.awards = STATE.season.awards || [];
    }
  }

  var api = {
    version:AWARD_ENGINE_VERSION,
    major65GameAwards:Object.keys(MAJOR_65_GAME_AWARDS),
    ballotPoints:{ mvp:[10,7,5,3,1], other:[5,3,1] },
    eligibility:eligibility,
    impact:impact,
    defensiveBox:defensiveBox,
    improvement:improvement,
    scoreCandidates:scoreCandidates,
    runMediaBallot:runMediaBallot,
    runTeamBallot:runTeamBallot,
    calculate:calculateRealisticSeasonAwards
  };
  window.PERFECT_PLAYER_AWARD_ENGINE = api;
  calcSeasonAwards = calculateRealisticSeasonAwards;
})();
