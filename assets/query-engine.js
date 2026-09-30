/* ---------- query engine ----------
   Reads a query spec and a set of parsed records, returns rows. No controls and
   no markup: the builder produces a spec, this runs it, the report renders what
   comes back.

   Loaded after assets/facility-data.js, assets/query-catalog.js, data/demand.js
   and data/labor.js.

   Three things here are worth knowing before reading the rest.

   Status conditions are held apart from the others. A report normally shows
   licensed and pending facilities, but a closure count has to see closed ones.
   So conditions are applied in two passes: everything except status, then
   status. A measure that names its own statuses works from the first pass and
   applies its own. Without that split, asking for closures on a normal report
   returns zero, which looks like an answer and is not.

   Rows are either facilities or areas. Grouping over records can never produce
   a row for a place that holds none, and a place with demand and no supply is
   the most useful row a saturation report has. So rowsAre "areas" walks the
   demographic table instead and attaches whatever records fall in each area.

   Every ratio carries its denominator, that denominator's coefficient of
   variation, and any flags, not just a number. The numerator is a hard count
   from a licensing roster, so all of the uncertainty sits in the denominator
   and has to travel with the result. */

var ENGINE = (function(){
"use strict";

/* ---------- small helpers ---------- */
function isBlank(v){ return v === null || v === undefined || String(v).trim() === ""; }
function num(v){ var n = Number(v); return isFinite(n) ? n : null; }
function asList(v){ return Object.prototype.toString.call(v) === "[object Array]" ? v : [v]; }
function lower(v){ return String(v === null || v === undefined ? "" : v).toLowerCase(); }
function uniq(list){
  var seen = {}, out = [];
  list.forEach(function(v){ if(!seen[v]){ seen[v] = 1; out.push(v); } });
  return out;
}
function median(values){
  var v = values.filter(function(x){ return x !== null && x !== undefined && isFinite(x); })
                .sort(function(a, b){ return a - b; });
  if(!v.length) return null;
  var mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function sum(values){
  var total = 0, seen = false;
  values.forEach(function(x){ if(x !== null && isFinite(x)){ total += x; seen = true; } });
  return seen ? total : null;
}

/* A stored demographic figure is [estimate, cv]. Either part can be missing,
   and a missing estimate is not a zero. */
function estOf(pair){ return (pair && pair[0]) ? pair[0] : null; }
function cvOf(pair){ return (pair && pair.length > 1 && pair[1] !== null && pair[1] !== undefined) ? pair[1] : null; }

function haveDemand(){ return typeof DEMAND !== "undefined" && DEMAND.county && DEMAND.zip; }
function haveLabor(){ return typeof LABOR !== "undefined" && LABOR.crosswalk; }

/* County name to FIPS, built once. The licensing export is uppercase and the
   parser title-cases it, which is the form the demographic table uses. */
var _fipsByName = null;
function fipsByName(name){
  if(!haveDemand()) return null;
  if(!_fipsByName){
    _fipsByName = {};
    Object.keys(DEMAND.county).forEach(function(f){ _fipsByName[DEMAND.county[f].n] = f; });
  }
  return _fipsByName[name] || null;
}
function zipKey(zip){
  var m = String(zip || "").trim().match(/^(\d{5})/);
  return m ? m[1] : null;
}

/* ---------- enrichment ----------
   Called once after parsing, before any query. Attaches the demographic and
   labor figures and the derived fields so that by the time a record reaches a
   query it carries everything the catalog says it does. */
function enrich(records, dataset){
  var now = Date.now();
  var thisYear = new Date(now).getFullYear();

  records.forEach(function(r){
    var z = zipKey(r.zip);
    var dz = (z && haveDemand()) ? DEMAND.zip[z] : null;
    // The licensing file states the county, and that is the value the labor
    // crosswalk joins on. A ZIP centroid can sit across a county line, so it
    // places a record on a map but does not decide which county it is in.
    var fips = fipsByName(r.county) || (dz ? dz.c : null);
    var dc = (fips && haveDemand()) ? DEMAND.county[fips] : null;

    r._zipKey = z;
    r._demandZip = dz || null;
    r._demandCounty = dc || null;
    r.countyFips = fips || "";

    r.zipSeniors = estOf(dz && dz.a65);
    r.zipSeniors75 = estOf(dz && dz.a75);
    r.zipSeniors85 = estOf(dz && dz.a85);
    r.zipPopulation = dz ? (dz.p || null) : null;
    r.zipLivingAlone = estOf(dz && dz.al);
    r.zipSeniorIncome = estOf(dz && dz["in"]);
    r.zipHomeValue = estOf(dz && dz.hv);
    r.countySeniors = estOf(dc && dc.a65);
    r.countySeniors85 = estOf(dc && dc.a85);

    var area = haveLabor() ? (LABOR.crosswalk[r.county] || null) : null;
    r.laborArea = area || "";
    var q = (fips && haveLabor() && LABOR.qcew) ? LABOR.qcew[fips] : null;
    r.hhEmployers = q && q["6216"] ? q["6216"].e : null;
    r.hhJobs = q && q["6216"] ? q["6216"].j : null;
    r.hhWeeklyWage = q && q["6216"] ? q["6216"].w : null;
    r.alfEmployers = q && q["623312"] ? q["623312"].e : null;
    r.alfWeeklyWage = q && q["623312"] ? q["623312"].w : null;

    var o = (area && haveLabor() && LABOR.oews) ? LABOR.oews[area] : null;
    r.aideMedianWage = o && o["311120"] ? o["311120"].med : null;
    r.aideEmployment = o && o["311120"] ? o["311120"].emp : null;
    r.lvnMedianWage = o && o["292061"] ? o["292061"].med : null;
    r.rnMedianWage = o && o["291141"] ? o["291141"].med : null;

    // Derived. A ratio with no denominator is blank, never zero: zero would
    // read as a clean record when it means nothing has been measured.
    var lv = dateValue(r.licenseDate), cd = dateValue(r.closedDate), lvv = dateValue(r.lastVisitDate);
    r.licenseYear = lv === null ? null : new Date(lv).getFullYear();
    r.closedYear = cd === null ? null : new Date(cd).getFullYear();
    r.yearsOpen = lv === null ? null : Math.floor((now - lv) / 31557600000);
    r.daysSinceVisit = lvv === null ? null : Math.floor((now - lvv) / 86400000);
    r.citationsPerVisit = r.totalVisits > 0 ? r.citations / r.totalVisits : null;
    r.substantiatedRate = r.allegations > 0 ? r.substantiated / r.allegations : null;
    r.complaintsPerBed = r.capacity > 0 ? r.complaints / r.capacity : null;
  });

  return { records: records, dataset: dataset, enrichedAt: now, currentYear: thisYear };
}

/* ---------- conditions ---------- */
function valueFor(rec, fieldId){
  if(fieldId === "location") return { lat: rec.lat, lng: rec.lng };
  return rec[fieldId];
}

function testCondition(rec, cond, field){
  var v = valueFor(rec, cond.field);
  var op = cond.op;

  if(op === "isBlank") return isBlank(v);

  if(field.type === "geo"){
    if(op !== "withinMiles") return false;
    if(rec.lat === null || rec.lng === null) return false;
    var c = cond.value || {};
    if(c.lat === undefined || c.lng === undefined || !c.miles) return false;
    return haversineMiles(rec.lat, rec.lng, c.lat, c.lng) <= c.miles;
  }

  if(field.type === "boolean"){
    if(op === "isTrue") return !!v;
    if(op === "isFalse") return !v;
    return false;
  }

  if(field.type === "number" || (field.type === "date" && op === "inLastYears")){
    var n = num(field.type === "date" ? dateValue(v) : v);
    if(op === "isZero") return n === 0;
    if(n === null) return false;
    var t = cond.value;
    if(op === "eq") return n === num(t);
    if(op === "ne") return n !== num(t);
    if(op === "gt") return n > num(t);
    if(op === "lt") return n < num(t);
    if(op === "between") return n >= num(t.from) && n <= num(t.to);
    if(op === "inLastYears"){
      var cutoff = Date.now() - (num(t) * 31557600000);
      return n >= cutoff;
    }
    return false;
  }

  if(field.type === "date"){
    var d = dateValue(v);
    if(d === null) return false;
    if(op === "before") return d < dateValue(cond.value);
    if(op === "after") return d > dateValue(cond.value);
    if(op === "between") return d >= dateValue(cond.value.from) && d <= dateValue(cond.value.to);
    return false;
  }

  // text and category
  var s = lower(v);
  var list = asList(cond.value).map(lower);
  if(op === "is" || op === "isAnyOf") return list.indexOf(s) !== -1;
  if(op === "isNot" || op === "isNoneOf") return list.indexOf(s) === -1;
  if(op === "contains") return s.indexOf(list[0]) !== -1;
  if(op === "startsWith") return s.indexOf(list[0]) === 0;
  return false;
}

function isStatusCondition(cond){ return cond.field === "status"; }

function applyConditions(records, conds){
  if(!conds.length) return records;
  return records.filter(function(r){
    for(var i = 0; i < conds.length; i++){
      var f = CATALOG.field(conds[i].field);
      if(!f) return false;
      if(!testCondition(r, conds[i], f)) return false;
    }
    return true;
  });
}

/* ---------- grain ---------- */
function grainOf(spec){
  if(!spec.groupBy || !spec.groupBy.length) return "facility";
  var f = CATALOG.field(spec.groupBy[0]);
  return (f && f.grains && f.grains.length) ? f.grains[0] : "facility";
}

/* ---------- area frame ----------
   The demographic table is the frame, so a county or ZIP with no facilities
   still gets a row. Conditions on a grain field narrow the frame too: asking
   for Butte should not return all 58 counties with 57 of them empty. */
function areaFrame(grain, conds){
  var out = [];
  if(!haveDemand()) return out;

  if(grain === "county"){
    Object.keys(DEMAND.county).forEach(function(fips){
      var rec = DEMAND.county[fips];
      out.push({ key: fips, label: rec.n, county: rec.n, fips: fips, demand: rec, zip: null });
    });
  }else if(grain === "zip"){
    Object.keys(DEMAND.zip).forEach(function(z){
      var rec = DEMAND.zip[z];
      var c = rec.c ? DEMAND.county[rec.c] : null;
      out.push({ key: z, label: z, county: c ? c.n : "", fips: rec.c || "",
                 demand: rec, zip: z });
    });
  }
  // Only conditions on the grain fields can narrow a frame of places.
  var geoConds = conds.filter(function(c){
    return c.field === "county" || c.field === "zip" || c.field === "city";
  });
  if(!geoConds.length) return out;

  return out.filter(function(a){
    for(var i = 0; i < geoConds.length; i++){
      var c = geoConds[i];
      if(c.field === "city") continue;           // no city frame exists
      var fake = { county: a.county, zip: a.zip };
      if(!testCondition(fake, c, CATALOG.field(c.field))) return false;
    }
    return true;
  });
}

function areaKeyOf(rec, grain){
  if(grain === "county") return rec.countyFips || fipsByName(rec.county) || "";
  if(grain === "zip") return rec._zipKey || "";
  if(grain === "city") return rec.city || "";
  return rec.id;
}

/* ---------- denominators ---------- */
function denominatorFor(group, per){
  // Returns { value, cv, flags }
  if(per === "parent"){
    return { value: group._parentTotal === undefined ? null : group._parentTotal, cv: null, flags: [] };
  }
  var d = group.demand;
  if(!d) return { value: null, cv: null, flags: ["noDemographicRecord"] };
  var pair = d[per];
  var est = estOf(pair);
  if(est === null) return { value: null, cv: cvOf(pair), flags: ["noEstimate"] };
  return { value: est, cv: cvOf(pair), flags: [] };
}

/* ---------- measures ---------- */
var AREA_FIELDS = { a65: "a65", a75: "a75", a85: "a85", al: "al", "in": "in", hv: "hv", p: "p" };

function areaValue(group, fieldId){
  // Demographic figures come from the area's own record; labor figures are the
  // same for every record in a county, so the first record carries them.
  if(AREA_FIELDS[fieldId]){
    var d = group.demand;
    if(!d) return { value: null, cv: null, flags: ["noDemographicRecord"] };
    if(fieldId === "p") return { value: d.p || null, cv: null, flags: [] };
    return { value: estOf(d[fieldId]), cv: cvOf(d[fieldId]), flags: estOf(d[fieldId]) === null ? ["noEstimate"] : [] };
  }
  var r = group.records[0];
  if(!r) return { value: null, cv: null, flags: ["noRecords"] };
  var v = r[fieldId];
  return { value: (v === undefined || v === null) ? null : v, cv: null, flags: [] };
}

function poolFor(group, m, ctx){
  // A measure that names its own statuses starts from the records that passed
  // every condition except status, then applies its own.
  if(!m.statuses) return group.records;
  var base = group.baseRecords || group.records;
  return base.filter(function(r){ return m.statuses.indexOf(r.status) !== -1; });
}

function windowFilter(records, m, inst, ctx){
  var field = m.window;                     // licenseYear or closedYear
  if(!field) return { kept: records, unplaceable: 0, from: null, to: null };

  var floor = CATALOG.entryFloor(ctx.dataset);
  var thisYear = ctx.currentYear;
  var years = inst.years ? Number(inst.years) : null;
  var from = years ? (thisYear - years + 1) : null;

  if(field === "licenseYear" && floor !== null){
    from = (from === null) ? floor : Math.max(from, floor);
  }
  if(m.maxWindowYears && years && years > m.maxWindowYears){
    from = thisYear - m.maxWindowYears + 1;
  }

  var unplaceable = 0;
  var kept = records.filter(function(r){
    var y = r[field];
    if(y === null || y === undefined){ unplaceable++; return false; }
    if(from !== null && y < from) return false;
    return true;
  });
  return { kept: kept, unplaceable: unplaceable, from: from, to: thisYear };
}

function computeMeasure(group, inst, ctx){
  var m = CATALOG.measure(inst.id);
  if(!m) return { value: null, flags: ["unknownMeasure"] };

  if(m.agg === "areaValue"){
    var av = areaValue(group, m.field || inst.field);
    return { value: av.value, denominator: null, cv: av.cv, flags: av.flags, excluded: 0 };
  }

  if(m.agg === "derived" && m.id === "netChange"){
    var e = computeMeasure(group, { id: "entries", years: inst.years }, ctx);
    var x = computeMeasure(group, { id: "exits", years: inst.years }, ctx);
    var val = (e.value === null && x.value === null) ? null : (e.value || 0) - (x.value || 0);
    return { value: val, denominator: null, cv: null,
             flags: [].concat(e.flags || [], x.flags || []), excluded: (e.excluded || 0) };
  }

  var pool = poolFor(group, m, ctx);
  var win = windowFilter(pool, m, inst, ctx);
  pool = win.kept;

  var raw = null, flags = [];
  var agg = inst.agg || m.agg;
  var fieldId = inst.field || m.field;

  if(agg === "count"){
    raw = pool.length;
  }else if(agg === "shareWhereZero"){
    raw = pool.length ? pool.filter(function(r){ return !r[fieldId]; }).length / pool.length : null;
  }else{
    var vals = pool.map(function(r){ return num(r[fieldId]); });
    if(agg === "sum") raw = sum(vals);
    else if(agg === "median") raw = median(vals);
    else if(agg === "avg"){ var s = sum(vals); raw = (s === null || !vals.length) ? null : s / vals.length; }
    else if(agg === "min") raw = vals.length ? Math.min.apply(null, vals.filter(function(v){ return v !== null; })) : null;
    else if(agg === "max") raw = vals.length ? Math.max.apply(null, vals.filter(function(v){ return v !== null; })) : null;
  }

  var per = inst.per || m.per;
  if(!per){
    return { value: raw, denominator: null, cv: null,
             flags: flags, excluded: win.unplaceable, window: win.from ? { from: win.from, to: win.to } : null };
  }

  var den = denominatorFor(group, per);
  flags = flags.concat(den.flags);

  var value = null;
  if(den.value === null || den.value === 0){
    flags.push("noDenominator");
  }else{
    var scale = inst.scale || m.scale || 1;
    value = (raw === null ? 0 : raw) / den.value * scale;
  }

  // Thresholds are off by default. They earn their keep only when a report
  // pulls in areas that hold no facilities, where the weaker ZIP estimates
  // return and a ranking would otherwise put the worst of them on top.
  var rel = ctx.reliability || {};
  if(value !== null && rel.maxCv !== null && rel.maxCv !== undefined &&
     den.cv !== null && den.cv > rel.maxCv){
    flags.push("excludedUnreliable");
    value = null;
  }
  if(value !== null && rel.minDenominator !== null && rel.minDenominator !== undefined &&
     den.value < rel.minDenominator){
    flags.push("excludedThin");
    value = null;
  }
  if(value !== null && den.cv !== null && den.cv > 30) flags.push("unreliable");

  return { value: value, denominator: den.value, cv: den.cv, flags: flags,
           excluded: win.unplaceable, window: win.from ? { from: win.from, to: win.to } : null };
}

/* ---------- validation ---------- */
function validate(spec){
  var errors = [], warnings = [];
  if(!spec || typeof spec !== "object") return { errors: ["No query was given."], warnings: [] };
  if(!DATASETS[spec.dataset]) errors.push("Unknown dataset: " + spec.dataset + ".");

  var grain = grainOf(spec);
  var rowsAre = spec.rowsAre || "facilities";

  (spec.conditions || []).forEach(function(c){
    var f = CATALOG.field(c.field);
    if(!f){ errors.push("Unknown field: " + c.field + "."); return; }
    if(CATALOG.opsFor(f.type).indexOf(c.op) === -1)
      errors.push(CATALOG.opLabel(c.op) + " cannot be used with " + f.label.toLowerCase() + ".");
    if(f.datasets.indexOf(spec.dataset) === -1)
      errors.push(f.label + " is not in this dataset.");
  });

  (spec.groupBy || []).forEach(function(id){
    var f = CATALOG.field(id);
    if(!f){ errors.push("Unknown grouping field: " + id + "."); return; }
    if(f.roles.indexOf("group") === -1) errors.push(f.label + " cannot be grouped on.");
  });

  (spec.measures || []).forEach(function(inst){
    var m = CATALOG.measure(inst.id);
    if(!m){ errors.push("Unknown measure: " + inst.id + "."); return; }
    if(m.datasets.indexOf(spec.dataset) === -1)
      errors.push(m.label + " is not available for this dataset.");
    if(m.grains && m.grains.indexOf(grain) === -1)
      errors.push(m.label + ": " + (CATALOG.measuresFor(spec.dataset, grain)
        .filter(function(x){ return x.measure.id === m.id; })
        .map(function(x){ return x.whyDisabled; })[0] || "Not available at this grain."));
    if(m.maxWindowYears && inst.years && Number(inst.years) > m.maxWindowYears)
      errors.push(m.label + " can only look back " + m.maxWindowYears +
        " years. The export does not keep closures older than that.");
  });

  if(rowsAre === "areas"){
    if(grain !== "county" && grain !== "zip")
      errors.push("Areas with no facilities can only be shown when grouping by county or ZIP code.");
    if((spec.groupBy || []).length > 1)
      errors.push("A cross-tab cannot include areas with no facilities. Group by one field, or switch to facilities.");
  }
  if(spec.shape === "crosstab" && (spec.groupBy || []).length !== 2)
    errors.push("A cross-tab needs two grouping fields.");
  if(spec.shape === "detail" && (spec.groupBy || []).length)
    errors.push("A detail list does not group.");
  if(spec.shape === "summary" && (spec.groupBy || []).length !== 1)
    errors.push("A summary needs one grouping field.");

  var floor = CATALOG.entryFloor(spec.dataset);
  if(floor && (spec.measures || []).some(function(i){ return i.id === "entries" || i.id === "netChange"; }))
    warnings.push("Home care licensing began in " + floor +
      ". Entries before then are the existing operators registering, not new agencies, so they are left out.");

  return { errors: errors, warnings: warnings };
}

/* ---------- plain English ---------- */
function describeCondition(c){
  var f = CATALOG.field(c.field);
  if(!f) return c.field;
  if(c.op === "isBlank") return f.label + " is blank";
  if(f.type === "geo"){
    var v = c.value || {};
    return "within " + v.miles + " miles of " + (v.label || "a point");
  }
  if(c.op === "inLastYears") return f.label + " is within the last " + c.value + " years";
  if(c.op === "between") return f.label + " is between " + c.value.from + " and " + c.value.to;
  var vals = asList(c.value);
  var joined = vals.length > 1
    ? vals.slice(0, -1).join(", ") + " or " + vals[vals.length - 1]
    : vals[0];
  return f.label + " " + CATALOG.opLabel(c.op) + " " + joined;
}

/* ---------- run ---------- */
function run(spec, records, opts){
  opts = opts || {};
  var check = validate(spec);
  if(check.errors.length) return { ok: false, errors: check.errors, warnings: check.warnings };

  var dataset = spec.dataset;
  var grain = grainOf(spec);
  var rowsAre = spec.rowsAre || "facilities";
  var conds = (spec.conditions || []).slice();
  var ctx = {
    dataset: dataset,
    currentYear: opts.currentYear || new Date().getFullYear(),
    reliability: spec.reliability || CATALOG.rules.reliabilityDefaults
  };

  // Two passes. Everything except status first, so a measure that needs closed
  // records can still see them.
  var nonStatus = conds.filter(function(c){ return !isStatusCondition(c); });
  var statusOnly = conds.filter(isStatusCondition);
  var basePool = applyConditions(records, nonStatus);
  var mainPool = applyConditions(basePool, statusOnly);

  // Blank and out-of-state counties are named out of geographic rollups rather
  // than quietly dropped.
  if(grain !== "facility"){
    var skipCounty = CATALOG.rules.nonGeographicCounties;
    var before = mainPool.length;
    mainPool = mainPool.filter(function(r){ return skipCounty.indexOf(r.county) === -1; });
    basePool = basePool.filter(function(r){ return skipCounty.indexOf(r.county) === -1; });
    ctx.excludedNonGeographic = before - mainPool.length;
  }

  var groups = buildGroups(spec, grain, rowsAre, mainPool, basePool);
  attachParentTotals(groups, grain);

  var measureInsts = spec.measures || [];
  groups.forEach(function(g){
    g.cells = {};
    measureInsts.forEach(function(inst){ g.cells[inst.id] = computeMeasure(g, inst, ctx); });
  });

  var rows = groups.map(function(g){
    return { key: g.key, label: g.label, county: g.county, records: g.records.length,
             cells: g.cells, demand: !!g.demand };
  });

  sortRows(rows, spec.sort, measureInsts);
  if(spec.limit) rows = rows.slice(0, spec.limit);

  return {
    ok: true,
    errors: [],
    warnings: check.warnings,
    header: header(spec, dataset, grain, rowsAre, records, mainPool, ctx),
    columns: columnsFor(spec, grain, measureInsts),
    rows: rows,
    detail: spec.shape === "detail" ? mainPool : null
  };
}

function buildGroups(spec, grain, rowsAre, mainPool, basePool){
  if(grain === "facility"){
    return [{ key: "all", label: "All", county: "", records: mainPool,
              baseRecords: basePool, demand: null }];
  }

  var byKeyMain = {}, byKeyBase = {};
  mainPool.forEach(function(r){
    var k = areaKeyOf(r, grain);
    (byKeyMain[k] = byKeyMain[k] || []).push(r);
  });
  basePool.forEach(function(r){
    var k = areaKeyOf(r, grain);
    (byKeyBase[k] = byKeyBase[k] || []).push(r);
  });

  if(rowsAre === "areas"){
    return areaFrame(grain, spec.conditions || []).map(function(a){
      return { key: a.key, label: a.label, county: a.county, fips: a.fips,
               demand: a.demand,
               records: byKeyMain[a.key] || [],
               baseRecords: byKeyBase[a.key] || [] };
    });
  }

  // Groups come from the pool before the status condition, not after it. A
  // county whose only records are closed still has to exist as a row, or a
  // closure count loses it: the measure can see closed records but only inside
  // a group that something else created. Such a row shows a facility count of
  // zero, which is what it is.
  return Object.keys(byKeyBase).map(function(k){
    var mains = byKeyMain[k] || [];
    var first = mains[0] || byKeyBase[k][0];
    return {
      key: k,
      label: grain === "county" ? first.county : (grain === "zip" ? first._zipKey : first.city),
      county: first.county,
      fips: first.countyFips,
      demand: grain === "zip" ? first._demandZip : first._demandCounty,
      records: mains,
      baseRecords: byKeyBase[k]
    };
  });
}

/* Share of the parent total. For a county that is the whole result; for a ZIP
   or a city it is the county the place sits in. */
function attachParentTotals(groups, grain){
  if(grain === "county"){
    var all = groups.reduce(function(a, g){ return a + g.records.length; }, 0);
    groups.forEach(function(g){ g._parentTotal = all; });
    return;
  }
  var byCounty = {};
  groups.forEach(function(g){ byCounty[g.county] = (byCounty[g.county] || 0) + g.records.length; });
  groups.forEach(function(g){ g._parentTotal = byCounty[g.county] || 0; });
}

function sortRows(rows, sortSpec, measureInsts){
  if(!sortSpec || !sortSpec.field) return;
  var dir = sortSpec.dir === "asc" ? 1 : -1;
  var isMeasure = measureInsts.some(function(i){ return i.id === sortSpec.field; });
  rows.sort(function(a, b){
    var av, bv;
    if(isMeasure){
      av = a.cells[sortSpec.field] ? a.cells[sortSpec.field].value : null;
      bv = b.cells[sortSpec.field] ? b.cells[sortSpec.field].value : null;
    }else{
      av = a.label; bv = b.label;
    }
    // A blank is not a low number. Blanks sit at the bottom whichever way the
    // sort runs, so a flagged or missing denominator never tops a ranking.
    if(av === null && bv === null) return 0;
    if(av === null) return 1;
    if(bv === null) return -1;
    if(typeof av === "string") return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
}

function columnsFor(spec, grain, measureInsts){
  var cols = [];
  (spec.groupBy || []).forEach(function(id){
    var f = CATALOG.field(id);
    cols.push({ key: id, label: f ? f.label : id, type: "text", group: true });
  });
  measureInsts.forEach(function(inst){
    var m = CATALOG.measure(inst.id);
    cols.push({ key: inst.id, label: m ? m.label : inst.id, type: "number",
                money: !!(m && m.money), ratio: !!(m && (inst.per || m.per)),
                carriesCv: !!(m && m.carriesCv) });
  });
  return cols;
}

function header(spec, dataset, grain, rowsAre, allRecords, matched, ctx){
  var cfg = DATASETS[dataset];
  var notes = [];
  if(rowsAre === "areas")
    notes.push("Includes areas with no " + cfg.subjectPlural + ", shown as zero.");
  if(ctx.excludedNonGeographic)
    notes.push(ctx.excludedNonGeographic + " records with a blank or out-of-state county were left out of the rollup.");
  if((spec.measures || []).some(function(i){ return i.id === "exits" || i.id === "netChange"; }))
    notes.push("Closures are only kept in the export for about " +
      CATALOG.rules.closureWindowYears + " years, so anything earlier is not in the file.");
  if(CATALOG.rules.labelCurrentYearPartial)
    notes.push("The current year is incomplete, because the file is a snapshot taken partway through it.");

  return {
    dataset: dataset,
    datasetLabel: cfg.label,
    rowsAre: rowsAre,
    grain: grain,
    shape: spec.shape || "summary",
    conditions: (spec.conditions || []).map(describeCondition),
    recordsLoaded: allRecords.length,
    recordsMatched: matched.length,
    reliability: ctx.reliability,
    generatedAt: new Date().toString(),
    notes: notes
  };
}

return {
  enrich: enrich,
  validate: validate,
  run: run,
  describeCondition: describeCondition,
  grainOf: grainOf
};
})();
