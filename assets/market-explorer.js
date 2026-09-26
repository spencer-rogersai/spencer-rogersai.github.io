
(function(){
"use strict";

/* ============================================================
   California Senior Demographics
   Source: U.S. Census Bureau, American Community Survey 2020 to 2024
   5-year estimates, tables B01001 (age), B09020 (living arrangements 65+),
   B18107 (independent living difficulty) and B19049 (median household income
   by age of householder), taken from the published bulk table files so no
   API key is involved.

   Every figure carries a coefficient of variation derived from the published
   margin of error. County estimates are almost all reliable; ZIP estimates
   often are not, which is why reliability is shown on the map itself rather
   than hidden in a tooltip.
   ============================================================ */


var ANNUAL_COST = 72000;   // the private-pay figure every affordability measure is judged against

/* Two sets of measures, one per tab. Each declares how to read a value out of
   a record, where its reliability comes from, and what it is a share of. The
   affordability set reads a different stored field depending on the income
   threshold the operator picks. */
var DEMO_MEASURES = {
  a65: { label: "Residents 65 and over", short: "65+", base: "p", baseLabel: "of all residents" },
  a75: { label: "Residents 75 and over", short: "75+", base: "p", baseLabel: "of all residents" },
  a85: { label: "Residents 85 and over", short: "85+", base: "p", baseLabel: "of all residents" },
  al:  { label: "Residents 65+ living alone", short: "living alone", base: "alB", baseLabel: "of residents 65+" },
  il:  { label: "Residents 65+ with an independent living difficulty", short: "independent living difficulty",
         base: "ilB", baseLabel: "of residents 65+" },
  "in":{ label: "Median household income, householder 65+", short: "median income", money: true }
};

var PAY_MEASURES = {
  sInc: { label: "Senior households at or above the income threshold", short: "senior income",
          field: function(){ return "s" + state.threshold; }, base: "sH", baseLabel: "of senior households" },
  own:  { label: "Senior households that own their home", short: "senior homeowners",
          field: function(){ return "own"; }, base: "hh65", baseLabel: "of senior households" },
  hv:   { label: "Median home value", short: "home value",
          field: function(){ return "hv"; }, money: true },
  mInc: { label: "Households aged 45 to 64 at or above the income threshold", short: "adult children income",
          field: function(){ return "m" + state.threshold; }, base: "mH", baseLabel: "of households aged 45 to 64" },
  cap:  { label: "Households aged 45 to 64 above the threshold, per resident 85+", short: "payers per resident 85+",
          ratio: true,
          value: function(rec){
            var n = rec["m" + state.threshold][0], d = rec.a85[0];
            return (n === null || !d) ? null : n / d;
          },
          cv: function(rec){ return rec["m" + state.threshold][1]; } }
};


/* Labor measures are county-only: neither BLS source publishes below county,
   and the wage figures are published for multi-county labor market areas. */
function areaFor(rec){ return LABOR.crosswalk[rec.n] || null; }
function occ(rec, soc, field){
  var a = areaFor(rec);
  var d = a && LABOR.oews[a] ? LABOR.oews[a][soc] : null;
  return d && d[field] !== undefined ? d[field] : null;
}
function ind(rec, code, field){
  var d = rec.f ? LABOR.qcew[rec.f] : null;
  return (d && d[code]) ? d[code][field] : null;
}
function careJobs(rec){
  var parts = ["6216", "6231", "623312"].map(function(c){ return ind(rec, c, "j"); });
  // A withheld industry makes the total incomplete rather than zero.
  if(parts.some(function(v){ return v === null; })) return null;
  return parts.reduce(function(a, b){ return a + b; }, 0);
}

var LABOR_MEASURES = {
  aideWage: { label: "Median hourly wage, home health and personal care aides", short: "aide wage",
              money: true, decimals: 2,
              value: function(rec){ return occ(rec, "311120", "med"); } },
  aideEmp:  { label: "Aides employed in the labor market area", short: "aides employed",
              value: function(rec){ return occ(rec, "311120", "emp"); } },
  cnaWage:  { label: "Median hourly wage, nursing assistants", short: "CNA wage",
              money: true, decimals: 2,
              value: function(rec){ return occ(rec, "311131", "med"); } },
  lvnWage:  { label: "Median hourly wage, licensed vocational nurses", short: "LVN wage",
              money: true, decimals: 2,
              value: function(rec){ return occ(rec, "292061", "med"); } },
  careJobs: { label: "Jobs in licensed care industries in the county", short: "care jobs",
              value: careJobs },
  alWage:   { label: "Average weekly wage, assisted living employers", short: "assisted living wage",
              money: true,
              value: function(rec){ return ind(rec, "623312", "w"); } },
  jobsPer85:{ label: "Care industry jobs per resident 85+", short: "jobs per 85+", ratio: true,
              value: function(rec){ var j = careJobs(rec); return (j === null || !rec.a85[0]) ? null : j / rec.a85[0]; } }
};
var LABOR_KEYS = ["aideWage", "cnaWage", "lvnWage", "aideEmp", "careJobs", "alWage", "jobsPer85"];

function measureSet(){ return state.tab === "pay" ? PAY_MEASURES : state.tab === "labor" ? LABOR_MEASURES : DEMO_MEASURES; }
function measureKeys(){ return state.tab === "pay" ? PAY_KEYS : state.tab === "labor" ? LABOR_KEYS : DEMO_KEYS; }
var DEMO_KEYS = ["a65", "a75", "a85", "al", "il", "in"];
var PAY_KEYS = ["sInc", "own", "hv", "mInc", "cap"];

// One accessor pair for both sets: the demographics measures store their value
// under their own key, the affordability ones name a field or compute a ratio.
function valueOf(rec, key){
  var m = measureSet()[key];
  if(m.value) return m.value(rec);
  var f = m.field ? m.field() : key;
  return rec[f] ? rec[f][0] : null;
}
function cvOf(rec, key){
  var m = measureSet()[key];
  if(m.cv) return m.cv(rec);
  var f = m.field ? m.field() : key;
  return rec[f] ? rec[f][1] : null;
}

var AREA_COLORS = ["#eef0fb", "#c7cdf0", "#9ca7e3", "#6c7acf", "#3f4fb3"];
var CIRCLE_COLORS = ["#b3bdf0", "#8a98e0", "#6474cf", "#4152b6", "#26338f"];

/* ---------- helpers ---------- */
function escapeHtml(s){
  return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function fmtCount(n){ return n === null || n === undefined || !isFinite(n) ? "n/a" : Math.round(n).toLocaleString("en-US"); }
function fmtPct(x){ return x === null || x === undefined || !isFinite(x) ? "n/a" : (x * 100).toFixed(1) + "%"; }
function fmtMoney(x, decimals){
  if(x === null || x === undefined) return "n/a";
  return "$" + (decimals ? x.toFixed(decimals) : Math.round(x).toLocaleString("en-US"));
}
function fmtValue(key, v){
  var m = measureSet()[key];
  if(m.money) return fmtMoney(v, m.decimals);
  if(m.ratio) return v === null || !isFinite(v) ? "n/a" : v.toFixed(1);
  return fmtPct(v);
}
function fmtPrimary(key, v){
  var m = measureSet()[key];
  return m.money ? fmtMoney(v, m.decimals) : m.ratio ? (v === null || !isFinite(v) ? "n/a" : v.toFixed(1)) : fmtCount(v);
}
function yearsOfCare(v){ return v === null || v === undefined ? "n/a" : (v / ANNUAL_COST).toFixed(1) + " years"; }

function reliability(cv){
  if(cv === null || cv === undefined) return { key: "low", label: "Too uncertain to rank: no margin of error could be computed" };
  if(cv > 30) return { key: "low", label: "Low reliability: margin of error is large relative to the estimate" };
  if(cv > 15) return { key: "caution", label: "Use with caution: moderate margin of error" };
  return { key: "ok", label: "Reliable" };
}
// What the map colors by: a share where one makes sense, otherwise the value.
function shareOf(rec, key){
  var m = measureSet()[key];
  if(m.money || m.ratio || state.tab === "labor") return valueOf(rec, key);
  var base = rec[m.base] ? (Array.isArray(rec[m.base]) ? rec[m.base][0] : rec[m.base]) : null;
  var v = valueOf(rec, key);
  return (base && v !== null) ? v / base : null;
}
function baseOf(rec, key){
  var m = measureSet()[key];
  if(!m.base) return null;
  var b = rec[m.base];
  return Array.isArray(b) ? b[0] : b;
}

/* ---------- areas: one flat list per geography ---------- */
var COUNTY_NAME = {};
Object.keys(DEMAND.county).forEach(function(f){ COUNTY_NAME[f] = DEMAND.county[f].n; });

function areasFor(level){
  var out = [];
  if(level === "county"){
    Object.keys(DEMAND.county).forEach(function(f){
      var d = DEMAND.county[f];
      d.f = f;   // labor data is keyed by county FIPS
      out.push({ id: f, name: d.n + " County", county: d.n, rec: d, lat: null, lng: null });
    });
  }else{
    Object.keys(DEMAND.zip).forEach(function(z){
      var d = DEMAND.zip[z];
      out.push({ id: z, name: "ZIP " + z, county: COUNTY_NAME[d.c] || "", rec: d,
                 lat: d.ll ? d.ll[0] : null, lng: d.ll ? d.ll[1] : null });
    });
  }
  return out;
}

var state = {
  tab: "demo",
  threshold: "100",
  measure: "a65",
  level: "county",
  counties: new Set(),
  rels: new Set(),
  search: "",
  sortKey: "a65",
  sortDir: -1,
  selected: null
};
var map, layer, selectionLayer;
var MAX_ROWS = 400;

function currentAreas(){ return areasFor(state.level); }

function filteredAreas(){
  var term = state.search.trim().toLowerCase();
  return currentAreas().filter(function(a){
    if(state.counties.size && !state.counties.has(a.county)) return false;
    if(state.rels.size && !state.rels.has(reliability(cvOf(a.rec, state.measure)).key)) return false;
    if(term && (a.name + " " + a.county).toLowerCase().indexOf(term) === -1) return false;
    return true;
  });
}

/* Quantile breaks across the whole geography level, so colors do not shift
   as the operator filters. */
function breaksFor(level, key){
  var vals = [];
  areasFor(level).forEach(function(a){
    var v = shareOf(a.rec, key);
    if(v !== null && v !== undefined && isFinite(v)) vals.push(v);
  });
  vals.sort(function(x, y){ return x - y; });
  var out = [];
  for(var i = 1; i < 5; i++) out.push(vals[Math.floor(vals.length * i / 5)]);
  return out;
}
function classOf(v, breaks){
  if(v === null || v === undefined || !isFinite(v)) return -1;
  for(var i = 0; i < breaks.length; i++) if(v < breaks[i]) return i;
  return breaks.length;
}

/* ---------- map ---------- */
function initMap(){
  map = L.map("map").setView([37.3, -119.5], 6);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: ""
  }).addTo(map);
  var pane = map.createPane("areas");
  pane.style.zIndex = 350;
  map.createPane("selection").style.zIndex = 420;
}

function tooltipFor(a){
  var key = state.measure, m = measureSet()[key];
  var rel = reliability(cvOf(a.rec, key));
  var lines = ["<b>" + escapeHtml(a.name) + "</b>"];
  if(state.level === "zip" && a.county) lines.push('<span class="tip-sub">' + escapeHtml(a.county) + " County</span>");
  var v = valueOf(a.rec, key);
  lines.push(m.label + ": " + (v === null && state.tab === "labor" ? "withheld by BLS" : fmtPrimary(key, v)));
  if(state.tab !== "labor" && !m.money && !m.ratio) lines.push(fmtPct(shareOf(a.rec, key)) + " " + m.baseLabel);
  if(state.tab === "labor" && areaFor(a.rec)) lines.push('<span class="tip-sub">Wages for ' + escapeHtml(areaFor(a.rec)) + "</span>");
  if(key === "hv") lines.push("Covers " + yearsOfCare(valueOf(a.rec, key)) + " of care at $72,000 a year");
  lines.push("Total residents: " + fmtCount(a.rec.p));
  if(state.tab !== "labor") lines.push('<span class="rel-' + rel.key + '">' + rel.label + "</span>");
  lines.push('<span class="tip-sub">Click for the full breakdown</span>');
  return '<div class="map-tooltip">' + lines.join("<br>") + "</div>";
}

function drawMap(){
  if(!map) return;
  if(layer){ map.removeLayer(layer); layer = null; }
  var key = state.measure;
  var breaks = breaksFor(state.level, key);
  var shown = {};
  filteredAreas().forEach(function(a){ shown[a.id] = a; });

  if(state.level === "county"){
    layer = L.geoJSON(COUNTY_SHAPES, {
      pane: "areas",
      filter: function(f){ return !!shown[f.properties.f]; },
      style: function(f){
        var a = shown[f.properties.f];
        var c = classOf(shareOf(a.rec, key), breaks);
        var rel = reliability(cvOf(a.rec, key)).key;
        return { color: "#5b6170", weight: 0.9, fillColor: c < 0 ? "#dddddd" : AREA_COLORS[c],
                 fillOpacity: rel === "ok" ? 0.72 : 0.38, dashArray: rel === "ok" ? null : "4 3" };
      },
      onEachFeature: function(f, lyr){
        var a = shown[f.properties.f];
        lyr.bindTooltip(tooltipFor(a), { sticky: true });
        lyr.on("click", function(){ select(a.id); });
      }
    }).addTo(map);
  }else{
    layer = L.layerGroup();
    filteredAreas().forEach(function(a){
      if(a.lat === null) return;
      var c = classOf(shareOf(a.rec, key), breaks);
      var rel = reliability(cvOf(a.rec, key)).key;
      var style = rel === "ok"
        ? { radius: 7, weight: 1.5, color: "#1f2533", fillColor: c < 0 ? "#999999" : CIRCLE_COLORS[c], fillOpacity: 0.92 }
        : rel === "caution"
          ? { radius: 7, weight: 1.5, color: "#1f2533", fillColor: c < 0 ? "#999999" : CIRCLE_COLORS[c], fillOpacity: 0.5 }
          : { radius: 6, weight: 1.5, color: "#5b6170", fillOpacity: 0, dashArray: "3 2" };
      style.pane = "areas";
      L.circleMarker([a.lat, a.lng], style)
        .bindTooltip(tooltipFor(a), { sticky: true })
        .on("click", function(){ select(a.id); })
        .addTo(layer);
    });
    layer.addTo(map);
  }
  drawLegend(breaks);
  markSelection();
}

function drawLegend(breaks){
  var key = state.measure, m = measureSet()[key];
  var el = document.getElementById("demandLegend");
  var palette = state.level === "zip" ? CIRCLE_COLORS : AREA_COLORS;
  var qualifier = (m.money || m.ratio) ? "" : ", as a share " + m.baseLabel;
  var html = '<div class="dl-title">' + m.label + qualifier +
             (state.level === "zip" ? ", by ZIP code" : ", by county") + "</div><div class=\"dl-row\">";
  for(var i = 0; i < 5; i++){
    var a = i === 0 ? null : breaks[i - 1], b = i < 4 ? breaks[i] : null;
    var range = a === null ? "under " + fmtValue(key, b)
      : b === null ? fmtValue(key, a) + " and up"
      : fmtValue(key, a) + " to " + fmtValue(key, b);
    html += '<span class="dl-key"><i style="background:' + palette[i] +
            (state.level === "zip" ? ";border-radius:50%" : "") + '"></i>' + range + "</span>";
  }
  html += "</div>";
  if(state.tab === "labor") html += '<div class="dl-note">Gray counties have no published figure: BLS withholds industry detail where it could identify an employer. Wage measures are published for labor market areas, so neighboring counties often share a value.</div>';
  html += state.level === "zip"
    ? '<div class="dl-note">Solid circles are reliable. Half-filled: use with caution. Empty gray rings are too uncertain to rank, and carry no color.</div>'
    : '<div class="dl-note">Dashed outlines mark counties whose estimate is less reliable.</div>';
  html += '<div class="dl-note">Ranges are quintiles across all ' + (state.level === "zip" ? "California ZIP codes" : "58 counties") + ', so colors stay comparable as you filter.</div>';
  el.innerHTML = html;
  el.style.display = "block";
}

function markSelection(){
  if(!map) return;
  if(selectionLayer){ map.removeLayer(selectionLayer); selectionLayer = null; }
  if(!state.selected) return;
  var a = byId(state.selected);
  if(!a) return;
  if(state.level === "county"){
    var feat = COUNTY_SHAPES.features.filter(function(f){ return f.properties.f === a.id; })[0];
    if(feat) selectionLayer = L.geoJSON(feat, { pane: "selection",
      style: { color: "#1f2533", weight: 3, fill: false } }).addTo(map);
  }else if(a.lat !== null){
    selectionLayer = L.circleMarker([a.lat, a.lng],
      { pane: "selection", radius: 11, weight: 3, color: "#1f2533", fill: false }).addTo(map);
  }
}

function byId(id){
  var hit = null;
  currentAreas().forEach(function(a){ if(a.id === id) hit = a; });
  return hit;
}

/* ---------- selected area panel ---------- */
function statewide(){
  var agg = { p: 0, alB: 0, ilB: 0, sH: 0, mH: 0, hh65: 0, own: 0 };
  ["a65","a75","a85","al","il","s75","s100","s150","m75","m100","m150"].forEach(function(k){ agg[k] = [0, null]; });
  Object.keys(DEMAND.county).forEach(function(f){
    var d = DEMAND.county[f];
    ["p","alB","ilB"].forEach(function(k){ agg[k] += d[k] || 0; });
    ["sH","mH","hh65","own"].forEach(function(k){ agg[k] += (d[k] && d[k][0]) || (typeof d[k] === "number" ? d[k] : 0); });
    ["a65","a75","a85","al","il","s75","s100","s150","m75","m100","m150"].forEach(function(k){
      if(d[k] && d[k][0] !== null) agg[k][0] += d[k][0];
    });
  });
  // Statewide rows are plain sums, so they carry no reliability of their own.
  ["sH","mH","hh65","own"].forEach(function(k){ agg[k] = [agg[k], null]; });
  agg.hv = [null, null];          // a median cannot be summed across counties
  return agg;
}
var STATE_TOTALS = statewide();

function rankOf(a, key){
  var vals = areasFor(state.level).map(function(x){ return shareOf(x.rec, key); })
    .filter(function(v){ return v !== null && isFinite(v); });
  vals.sort(function(x, y){ return y - x; });
  var mine = shareOf(a.rec, key);
  if(mine === null || !isFinite(mine)) return null;
  return { rank: vals.indexOf(mine) + 1, of: vals.length };
}

function select(id){
  state.selected = id;
  renderPanel();
  markSelection();
  renderTable();
}

function renderPanel(){
  var box = document.getElementById("detailPanel");
  if(!state.selected){
    box.innerHTML = '<p class="file-hint">Click a county or ZIP code on the map, or a row in the table, to see every measure for that area with its margin of error.</p>';
    return;
  }
  var a = byId(state.selected);
  if(!a){ box.innerHTML = '<p class="file-hint">That area is not in the current geography. Switch back, or pick another.</p>'; return; }

  var head = '<div class="mp-h">' + escapeHtml(a.name) +
    (state.level === "zip" && a.county ? ' <span class="tip-sub">' + escapeHtml(a.county) + " County</span>" : "") + "</div>";
  box.innerHTML = head + (state.tab === "pay" ? payPanel(a) : state.tab === "labor" ? laborPanel(a) : demoPanel(a));
}

function relCell(cv){
  var rel = reliability(cv);
  return '<span class="mp-flag ' + rel.key + '">' + (rel.key === "ok" ? "reliable" : rel.key === "caution" ? "caution" : "low") + "</span>" +
    (cv === null || cv === undefined ? "" : ' <span class="cv">CV ' + cv + "%</span>");
}

function demoPanel(a){
  var rows = "";
  measureKeys().forEach(function(k){
    var m = measureSet()[k];
    var share = m.money ? "" : fmtPct(shareOf(a.rec, k)) + " " + m.baseLabel;
    var stateShare = m.money ? "n/a" : fmtPct(shareOf(STATE_TOTALS, k));
    rows += "<tr><td>" + m.label + '</td><td class="num">' + fmtPrimary(k, valueOf(a.rec, k)) + "</td><td>" + share +
      '</td><td class="num">' + stateShare + "</td><td>" + relCell(cvOf(a.rec, k)) + "</td></tr>";
  });
  var r = rankOf(a, state.measure), m = measureSet()[state.measure];
  var rankLine = r
    ? '<p class="file-hint">Ranks <strong>' + r.rank + " of " + r.of + "</strong> among California " +
      (state.level === "zip" ? "ZIP codes" : "counties") + " on " + m.label.toLowerCase() + ".</p>"
    : '<p class="file-hint">Cannot be ranked on this measure.</p>';
  return rankLine +
    '<table class="mp-table"><thead><tr><th>Measure</th><th class="num">Estimate</th><th>Share</th><th class="num">California</th><th>Reliability</th></tr></thead><tbody>' +
    rows + "</tbody></table>" +
    '<p class="file-hint mp-src">CV is the coefficient of variation: the margin of error as a percentage of the estimate. Under 15% is reliable, 15 to 30% warrants caution, above 30% is an indication only.</p>';
}

/* The affordability panel answers three questions in order: can the senior pay
   from income, from the house, or can the family help. */
function payPanel(a){
  var d = a.rec;
  var num = function(x){ return Array.isArray(x) ? x[0] : x; };
  var pct = function(n, base){ return (base && n !== null) ? fmtPct(n / base) : "n/a"; };
  var sH = num(d.sH), mH = num(d.mH), hh65 = num(d.hh65);
  var stateSH = num(STATE_TOTALS.sH), stateMH = num(STATE_TOTALS.mH), stateHH = num(STATE_TOTALS.hh65);

  var html = '<p class="cost-line">Measured against <strong>$' + ANNUAL_COST.toLocaleString("en-US") +
             " a year</strong>, about $" + Math.round(ANNUAL_COST / 12).toLocaleString("en-US") + " a month.</p>";

  html += '<h3 class="mp-h" style="font-size:13px;margin-top:14px;">From the senior\u2019s own income</h3>';
  html += '<table class="mp-table"><thead><tr><th>Senior households (65+)</th><th class="num">Households</th><th>Share</th><th class="num">California</th><th>Reliability</th></tr></thead><tbody>';
  html += '<tr><td>All senior households</td><td class="num">' + fmtCount(sH) + "</td><td></td><td></td><td></td></tr>";
  [["75", "$75,000"], ["100", "$100,000"], ["150", "$150,000"]].forEach(function(t){
    var k = "s" + t[0];
    html += "<tr><td>Income at or above " + t[1] + '</td><td class="num">' + fmtCount(d[k][0]) + "</td><td>" +
      pct(d[k][0], sH) + '</td><td class="num">' + pct(STATE_TOTALS[k][0], stateSH) + "</td><td>" + relCell(d[k][1]) + "</td></tr>";
  });
  html += "</tbody></table>";

  html += '<h3 class="mp-h" style="font-size:13px;margin-top:16px;">From the house</h3>';
  html += '<table class="mp-table"><tbody>';
  html += '<tr><td>Senior households that own their home</td><td class="num">' + fmtCount(num(d.own)) + "</td><td>" +
    pct(num(d.own), hh65) + '</td><td class="num">' + pct(num(STATE_TOTALS.own), stateHH) + "</td><td>" + relCell(d.own[1]) + "</td></tr>";
  html += '<tr><td>Median home value</td><td class="num">' + fmtMoney(d.hv[0]) + "</td><td>" +
    (d.hv[0] === null ? "" : "covers " + yearsOfCare(d.hv[0]) + " of care") + '</td><td class="num"></td><td>' + relCell(d.hv[1]) + "</td></tr>";
  html += "</tbody></table>";

  html += '<h3 class="mp-h" style="font-size:13px;margin-top:16px;">From adult children</h3>';
  html += '<table class="mp-table"><thead><tr><th>Households aged 45 to 64</th><th class="num">Households</th><th>Share</th><th class="num">California</th><th>Reliability</th></tr></thead><tbody>';
  html += '<tr><td>All households aged 45 to 64</td><td class="num">' + fmtCount(mH) + "</td><td></td><td></td><td></td></tr>";
  [["75", "$75,000"], ["100", "$100,000"], ["150", "$150,000"]].forEach(function(t){
    var k = "m" + t[0];
    html += "<tr><td>Income at or above " + t[1] + '</td><td class="num">' + fmtCount(d[k][0]) + "</td><td>" +
      pct(d[k][0], mH) + '</td><td class="num">' + pct(STATE_TOTALS[k][0], stateMH) + "</td><td>" + relCell(d[k][1]) + "</td></tr>";
  });
  var perParent = (d["m" + state.threshold][0] !== null && d.a85[0]) ? d["m" + state.threshold][0] / d.a85[0] : null;
  var per75 = (d["m" + state.threshold][0] !== null && d.a75[0]) ? d["m" + state.threshold][0] / d.a75[0] : null;
  html += '<tr><td>At or above $' + (+state.threshold * 1000).toLocaleString("en-US") + ', per resident 85+</td><td class="num mp-big">' +
    (perParent === null ? "n/a" : perParent.toFixed(1)) + "</td><td></td><td></td><td></td></tr>";
  html += '<tr><td>At or above $' + (+state.threshold * 1000).toLocaleString("en-US") + ', per resident 75+</td><td class="num mp-big">' +
    (per75 === null ? "n/a" : per75.toFixed(1)) + "</td><td></td><td></td><td></td></tr>";
  html += "</tbody></table>";

  html += '<div class="note-box">What this is and is not. The American Community Survey never asks who pays for a parent\u2019s care, so these are proxies. Income is household income before tax, not money available for care. The $' +
    ANNUAL_COST.toLocaleString("en-US") + ' figure falls inside the Census bracket of $60,000 to $74,999, so $75,000 is the nearest boundary the data can count. Households aged 45 to 64 are not linked to the seniors in the same area: adult children frequently live elsewhere, and a cost shared between siblings may be carried by people in another county entirely. Read these as the financial capacity present in an area, not as a count of anyone\u2019s actual payers.</div>';
  return html;
}

/* The workforce panel: what employers in the county pay and employ, then what
   the occupations themselves earn across the wider labor market area. */
function laborPanel(a){
  var rec = a.rec, area = areaFor(rec);
  var wk = function(v){ return v === null ? '<span class="tip-sub">withheld</span>' : fmtMoney(v); };
  var html = "";

  html += '<h3 class="mp-h" style="font-size:13px;">Employers and jobs in ' + escapeHtml(rec.n) + " County</h3>";
  html += '<table class="mp-table"><thead><tr><th>Industry</th><th class="num">Employers</th><th class="num">Jobs</th>' +
          '<th class="num">Average weekly wage</th><th class="num">Annualized</th></tr></thead><tbody>';
  ["6216","6231","623312","624120","62","10"].forEach(function(code){
    var e = ind(rec, code, "e"), j = ind(rec, code, "j"), w = ind(rec, code, "w");
    html += "<tr><td>" + escapeHtml(LABOR.industries[code]) + '</td><td class="num">' + (e === null ? "withheld" : fmtCount(e)) +
      '</td><td class="num">' + (j === null ? "withheld" : fmtCount(j)) + '</td><td class="num">' + wk(w) +
      '</td><td class="num">' + (w === null ? "" : fmtMoney(w * 52)) + "</td></tr>";
  });
  html += "</tbody></table>";

  var jobs = careJobs(rec);
  if(jobs !== null && rec.a85[0]){
    html += '<p class="file-hint">Licensed care industries employ <strong>' + fmtCount(jobs) + "</strong> people here, or <strong>" +
      (jobs / rec.a85[0]).toFixed(1) + "</strong> jobs per resident aged 85 and over.</p>";
  }

  html += '<h3 class="mp-h" style="font-size:13px;margin-top:16px;">Occupation wages, ' +
          (area ? escapeHtml(area) : "area not matched") + "</h3>";
  if(!area){
    html += '<p class="file-hint">No labor market area matched this county.</p>';
  }else{
    html += '<table class="mp-table"><thead><tr><th>Occupation</th><th class="num">Employed</th><th class="num">25th</th>' +
            '<th class="num">Median</th><th class="num">75th</th><th class="num">Mean annual</th><th class="num">California median</th></tr></thead><tbody>';
    ["311120","311131","292061","291141","119111"].forEach(function(soc){
      var st = LABOR.oews["California"] ? LABOR.oews["California"][soc] : null;
      html += "<tr><td>" + escapeHtml(LABOR.occupations[soc]) + '</td><td class="num">' + fmtCount(occ(rec, soc, "emp")) +
        '</td><td class="num">' + fmtMoney(occ(rec, soc, "p25"), 2) + '</td><td class="num mp-big">' + fmtMoney(occ(rec, soc, "med"), 2) +
        '</td><td class="num">' + fmtMoney(occ(rec, soc, "p75"), 2) + '</td><td class="num">' + fmtMoney(occ(rec, soc, "ann")) +
        '</td><td class="num">' + (st ? fmtMoney(st.med, 2) : "n/a") + "</td></tr>";
    });
    html += "</tbody></table>";
  }

  html += '<div class="note-box">Reading these figures. Jobs and employer counts are for the county and count jobs by the employer\u2019s industry, not by what the worker does. Figures marked withheld are suppressed by BLS where publishing them could identify an employer, which happens often in small counties. Services for the elderly and disabled is dominated in California by In-Home Supportive Services providers paid through the county program, which is why its employer count and wage look unlike an agency payroll. Occupation wages are published for ' +
    (area ? escapeHtml(area) : "a labor market area") + ', which may cover several counties, so they describe the wider hiring market rather than this county alone. Employment and wages: BLS Quarterly Census of Employment and Wages, ' +
    escapeHtml(LABOR.quarter.replace("/", " quarter ")) + '; Occupational Employment and Wage Statistics via the California Employment Development Department, 2026.</div>';
  return html;
}

/* ---------- table ---------- */
function columns(){
  var cols = [
    { key: "name", label: state.level === "zip" ? "ZIP" : "County", sort: function(a){ return a.name; } },
    { key: "county", label: "County", sort: function(a){ return a.county; }, zipOnly: true },
    { key: "p", label: "Residents", num: true, sort: function(a){ return a.rec.p || 0; } }
  ];
  measureKeys().forEach(function(k){
    var m = measureSet()[k];
    cols.push({ key: k, label: m.short, num: true,
      sort: function(a){ var v = valueOf(a.rec, k); return v === null ? -1 : v; } });
    if(!m.money && !m.ratio && state.tab !== "labor"){
      cols.push({ key: k + "_s", label: m.short + " %", num: true,
        sort: function(a){ var v = shareOf(a.rec, k); return v === null ? -1 : v; } });
    }
  });
  return cols.filter(function(c){ return !c.zipOnly || state.level === "zip"; });
}

function renderHead(){
  document.getElementById("tableHead").innerHTML = columns().map(function(c){
    var arrow = state.sortKey === c.key ? '<span class="arrow">' + (state.sortDir === 1 ? "\u25B2" : "\u25BC") + "</span>" : "";
    return '<th class="sortable' + (c.num ? " num" : "") + '" data-sort="' + c.key + '">' + escapeHtml(c.label) + arrow + "</th>";
  }).join("");
}

function renderTable(){
  var cols = columns();
  var col = null;
  cols.forEach(function(c){ if(c.key === state.sortKey) col = c; });
  var list = filteredAreas().slice();
  if(col) list.sort(function(x, y){
    var a = col.sort(x), b = col.sort(y);
    if(typeof a === "string" || typeof b === "string") return String(a).localeCompare(String(b)) * state.sortDir;
    return (a < b ? -1 : a > b ? 1 : 0) * state.sortDir;
  });

  var shown = list.slice(0, MAX_ROWS);
  document.getElementById("tableBody").innerHTML = shown.map(function(a){
    var rel = reliability(cvOf(a.rec, state.measure));
    var cells = cols.map(function(c){
      if(c.key === "name") return "<td>" + escapeHtml(a.name) +
        (state.tab === "labor" ? "" : ' <span class="mp-flag ' + rel.key + '">' +
          (rel.key === "ok" ? "reliable" : rel.key === "caution" ? "caution" : "low") + "</span>") + "</td>";
      if(c.key === "county") return "<td>" + escapeHtml(a.county) + "</td>";
      if(c.key === "p") return '<td class="num">' + fmtCount(a.rec.p) + "</td>";
      if(c.key.slice(-2) === "_s"){
        var k = c.key.slice(0, -2);
        return '<td class="num">' + fmtPct(shareOf(a.rec, k)) + "</td>";
      }
      var cv2 = valueOf(a.rec, c.key);
      return '<td class="num">' + (cv2 === null && state.tab === "labor" ? '<span class="tip-sub">withheld</span>' : fmtPrimary(c.key, cv2)) + "</td>";
    }).join("");
    return '<tr data-id="' + escapeHtml(a.id) + '"' + (a.id === state.selected ? ' class="picked"' : "") + ">" + cells + "</tr>";
  }).join("") || '<tr><td colspan="' + cols.length + '" class="empty-note">Nothing matches the current filters.</td></tr>';

  document.getElementById("resultsSummary").textContent =
    "Showing " + list.length.toLocaleString("en-US") + " of " + currentAreas().length.toLocaleString("en-US") +
    (state.level === "zip" ? " ZIP codes" : " counties");
  document.getElementById("tableNote").textContent = list.length > MAX_ROWS
    ? "Table shows the first " + MAX_ROWS + " rows. Narrow the filters to see the rest, or export the CSV for all " + list.length.toLocaleString("en-US") + "."
    : "";
}

document.getElementById("tableHead").addEventListener("click", function(e){
  var th = e.target.closest("th[data-sort]");
  if(!th) return;
  var key = th.getAttribute("data-sort");
  if(state.sortKey === key) state.sortDir = -state.sortDir;
  else { state.sortKey = key; state.sortDir = key === "name" || key === "county" ? 1 : -1; }
  renderHead();
  renderTable();
});

document.getElementById("tableBody").addEventListener("click", function(e){
  var tr = e.target.closest("tr[data-id]");
  if(!tr) return;
  select(tr.getAttribute("data-id"));
  var a = byId(state.selected);
  if(map && a && a.lat !== null) map.setView([a.lat, a.lng], Math.max(map.getZoom(), 10));
});

/* ---------- filters ---------- */
function makeMultiSelect(containerId, selectedSet, getValues, getLabel, allLabel, onChange, searchable){
  var container = document.getElementById(containerId);
  var btn = container.querySelector(".multiselect-btn");
  var panel = container.querySelector(".multiselect-panel");
  function optionsHtml(values, filterText){
    var shown = filterText ? values.filter(function(v){ return getLabel(v).toLowerCase().indexOf(filterText) !== -1; }) : values;
    if(!shown.length) return '<div style="padding:4px 6px;color:var(--ink-soft);font-size:12.5px;">Nothing to filter</div>';
    return shown.map(function(v){
      return '<label><input type="checkbox" value="' + escapeHtml(v) + '"' + (selectedSet.has(v) ? " checked" : "") + "> " + escapeHtml(getLabel(v)) + "</label>";
    }).join("");
  }
  function refresh(){
    var values = getValues();
    Array.from(selectedSet).forEach(function(v){ if(values.indexOf(v) === -1) selectedSet.delete(v); });
    panel.innerHTML = (searchable ? '<input type="search" class="ms-search" placeholder="Filter list">' : "") +
      '<div class="ms-options">' + optionsHtml(values, "") + "</div>";
    updateLabel();
  }
  function updateLabel(){
    btn.textContent = selectedSet.size === 0 ? allLabel
      : selectedSet.size === 1 ? getLabel(Array.from(selectedSet)[0])
      : selectedSet.size + " selected";
  }
  panel.addEventListener("input", function(e){
    if(!e.target.classList.contains("ms-search")) return;
    var opts = panel.querySelector(".ms-options");
    if(opts) opts.innerHTML = optionsHtml(getValues(), e.target.value.trim().toLowerCase());
  });
  panel.addEventListener("change", function(e){
    if(e.target.type !== "checkbox") return;
    if(e.target.checked) selectedSet.add(e.target.value); else selectedSet.delete(e.target.value);
    updateLabel();
    onChange();
  });
  btn.addEventListener("click", function(e){
    e.stopPropagation();
    var willOpen = panel.hidden;
    document.querySelectorAll(".multiselect-panel").forEach(function(p){ p.hidden = true; });
    if(willOpen){ panel.hidden = false; var s = panel.querySelector(".ms-search"); if(s) s.focus(); }
  });
  document.addEventListener("click", function(e){ if(!container.contains(e.target)) panel.hidden = true; });
  return { refresh: refresh };
}

function onChange(){ drawMap(); renderTable(); renderPanel(); }

function measureOptions(){
  var set = measureSet(), keys = measureKeys();
  document.getElementById("measure").innerHTML = keys.map(function(k){
    return '<option value="' + k + '">' + escapeHtml(set[k].label) + "</option>";
  }).join("");
  document.getElementById("measure").value = state.measure;
}

var SUBTITLES = {
  labor: "Who is available to staff care, and what it costs. County employment and employer counts come from the Quarterly Census of Employment and Wages; occupation wages come from Occupational Employment and Wage Statistics, published for labor market areas rather than counties.",
  demo: "Resident population aged 65 and over by county and ZIP code, with the measures that indicate demand for care: age bands, living alone, independent living difficulty, and income. American Community Survey 2020 to 2024 five-year estimates, built into this file.",
  pay: "Who could fund care at $72,000 a year: senior households with the income to pay, senior homeowners and the equity behind them, and households aged 45 to 64 with the means to contribute. These are proxies drawn from published statistics, not records of who actually pays."
};

function setTab(tab){
  state.tab = tab;
  state.measure = tab === "pay" ? "sInc" : tab === "labor" ? "aideWage" : "a65";
  state.sortKey = tab === "pay" ? "sInc_s" : tab === "labor" ? "aideWage" : "a65_s";
  state.sortDir = -1;
  // Neither labor source publishes below county level.
  if(tab === "labor"){ state.level = "county"; document.getElementById("geo").value = "county"; state.selected = null; }
  ["Demo","Pay","Labor"].forEach(function(n){
    var id = "tab" + n, on = tab === n.toLowerCase();
    document.getElementById(id).classList.toggle("active", on);
    document.getElementById(id).setAttribute("aria-selected", on);
  });
  document.getElementById("thresholdGroup").style.display = tab === "pay" ? "" : "none";
  document.getElementById("geoGroup").style.display = tab === "labor" ? "none" : "";
  document.getElementById("relGroup").style.display = tab === "labor" ? "none" : "";
  document.getElementById("subtitle").textContent = SUBTITLES[tab];
  document.getElementById("detailHeading").textContent =
    tab === "pay" ? "Selected area: who could pay" : tab === "labor" ? "Selected county: workforce and wages" : "Selected area";
  measureOptions();
  state.rels.clear();
  relUI.refresh();
  renderHead();
  onChange();
}
document.getElementById("tabDemo").addEventListener("click", function(){ setTab("demo"); });
document.getElementById("tabPay").addEventListener("click", function(){ setTab("pay"); });
document.getElementById("tabLabor").addEventListener("click", function(){ setTab("labor"); });
document.getElementById("threshold").addEventListener("change", function(e){
  state.threshold = e.target.value;
  renderHead(); onChange();
});

var countyUI = makeMultiSelect("countyFilter", state.counties,
  function(){ return Object.keys(DEMAND.county).map(function(f){ return DEMAND.county[f].n; }).sort(); },
  function(v){ return v; }, "All counties", onChange, true);

var relUI = makeMultiSelect("relFilter", state.rels,
  function(){ return ["ok", "caution", "low"]; },
  function(v){ return v === "ok" ? "Reliable" : v === "caution" ? "Use with caution" : "Too uncertain"; },
  "Any", onChange, false);

document.getElementById("measure").addEventListener("change", function(e){
  var previous = state.measure;
  state.measure = e.target.value;
  // Follow the measure with the sort, unless the operator sorted by something else.
  if(state.sortKey === previous || state.sortKey === previous + "_s"){
    var m = measureSet()[state.measure];
    state.sortKey = (m.money || m.ratio) ? state.measure : state.measure + "_s";
    state.sortDir = -1;
  }
  renderHead(); onChange();
});

document.getElementById("geo").addEventListener("change", function(e){
  state.level = e.target.value;
  state.selected = null;
  var gm = measureSet()[state.measure];
  state.sortKey = (gm.money || gm.ratio) ? state.measure : state.measure + "_s";
  state.sortDir = -1;
  renderHead(); onChange(); zoomToResults();
});

var searchTimer = null;
document.getElementById("searchInput").addEventListener("input", function(e){
  var v = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function(){ state.search = v; onChange(); }, 200);
});

document.getElementById("clearFiltersBtn").addEventListener("click", function(){
  state.counties.clear(); state.rels.clear(); state.search = "";
  document.getElementById("searchInput").value = "";
  countyUI.refresh(); relUI.refresh(); onChange();
});

/* ---------- map view, export, print ---------- */
function zoomToResults(){
  if(!map) return;
  var list = filteredAreas();
  var bounds = [];
  if(state.level === "zip"){
    list.forEach(function(a){ if(a.lat !== null) bounds.push([a.lat, a.lng]); });
  }else{
    var ids = {};
    list.forEach(function(a){ ids[a.id] = true; });
    var feats = COUNTY_SHAPES.features.filter(function(f){ return ids[f.properties.f]; });
    if(feats.length){
      var g = L.geoJSON({ type: "FeatureCollection", features: feats });
      map.fitBounds(g.getBounds(), { padding: [25, 25] });
      return;
    }
  }
  if(bounds.length) map.fitBounds(bounds, { padding: [25, 25], maxZoom: 12 });
}
document.getElementById("zoomBtn").addEventListener("click", zoomToResults);
document.getElementById("printBtn").addEventListener("click", function(){ window.print(); });
window.addEventListener("beforeprint", function(){ if(map) map.invalidateSize(); });

document.getElementById("csvBtn").addEventListener("click", function(){
  function f(v){ var s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
  var keys = measureKeys(), set = measureSet();
  var headers = [state.level === "zip" ? "ZIP" : "County", "County", "Total residents"];
  if(state.tab === "pay") headers.push("Senior households 65+", "Households 45-64", "Income threshold");
  keys.forEach(function(k){
    headers.push(set[k].label, set[k].label + " margin of error", set[k].label + " CV %");
    if(!set[k].money && !set[k].ratio) headers.push(set[k].label + " share %");
  });
  if(state.tab === "pay") headers.push("Years of care at $" + ANNUAL_COST.toLocaleString("en-US") + " from median home value");
  var lines = [headers.join(",")];
  filteredAreas().forEach(function(a){
    var row = [state.level === "zip" ? a.id : a.rec.n, a.county, a.rec.p];
    if(state.tab === "pay") row.push(a.rec.sH ? a.rec.sH[0] : "", a.rec.mH ? a.rec.mH[0] : "", +state.threshold * 1000);
    keys.forEach(function(k){
      var est = valueOf(a.rec, k), cv = cvOf(a.rec, k);
      // The stored figure is the CV; the margin of error is reconstructed from it.
      var moe = (est !== null && cv !== null && cv !== undefined && !set[k].ratio) ? Math.round(cv / 100 * 1.645 * est) : "";
      row.push(est === null ? "" : (set[k].ratio ? est.toFixed(2) : est), moe, cv === null || cv === undefined ? "" : cv);
      if(!set[k].money && !set[k].ratio){ var sh = shareOf(a.rec, k); row.push(sh === null ? "" : (sh * 100).toFixed(1)); }
    });
    if(state.tab === "pay") row.push(a.rec.hv && a.rec.hv[0] ? (a.rec.hv[0] / ANNUAL_COST).toFixed(1) : "");
    lines.push(row.map(f).join(","));
  });
  var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var el = document.createElement("a");
  el.href = url;
  el.download = "california-" + (state.tab === "pay" ? "who-can-pay-" : "senior-demographics-") + state.level + ".csv";
  document.body.appendChild(el); el.click(); document.body.removeChild(el);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
});

/* ---------- init ---------- */
try{
  if(typeof L === "undefined") throw new Error("The Leaflet map library did not load.");
  initMap();
}catch(e){
  var errEl = document.getElementById("mapError");
  errEl.style.display = "block";
  errEl.textContent = "The map couldn't start (" + e.message + "). The table and CSV export below still work.";
}
countyUI.refresh();
relUI.refresh();
setTab("demo");
})();
