(function(){
"use strict";

/* ============================================================
   Growth Trends
   The licensing files are snapshots with no history inside them, but each
   record carries the date its licence began and, where it has closed, the date
   it closed. That is enough to reconstruct openings, closures and the number
   in operation at the end of each year.

   One limit governs everything here. The state keeps closed records for about
   five years: the earliest closing date in the September 2026 files is 2021.
   From 2021 onward both sides of the ledger are complete, because a facility
   alive at the end of any year since then is either still open or closed
   within the retention window, and both appear in the file. Before 2021 only
   the survivors appear, so openings are understated and closures are absent
   altogether. The page defaults to the complete window and labels the rest.
   ============================================================ */

var RETENTION_START = null;     // measured from the loaded file, not assumed
var records = [];               // every record, including closed ones
var currentYear = new Date().getFullYear();

var filterState = { counties: new Set(), cities: new Set(), bands: new Set(), from: null };

/* ---------- small helpers ---------- */
function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmtCount(n){ return n === null || n === undefined || !isFinite(n) ? "n/a" : Math.round(n).toLocaleString("en-US"); }
function fmtSigned(n){ return n > 0 ? "+" + fmtCount(n) : fmtCount(n); }
function fmtPct(x){ return x === null || !isFinite(x) ? "n/a" : (x > 0 ? "+" : "") + x.toFixed(1) + "%"; }
function yearOf(text){
  var m = String(text || "").match(/(\d{4})\s*$/);
  if(!m) return null;
  var y = +m[1];
  return (y >= 1960 && y <= currentYear + 1) ? y : null;
}

/* ---------- loading ---------- */
function showMessage(text, kind){
  var el = document.getElementById("loadMessage");
  if(!text){ el.style.display = "none"; el.className = ""; return; }
  el.style.display = "block";
  el.className = kind || "";
  el.textContent = text;
}

function ingestText(text, origin, name){
  // Closed records are the point of this page, so they are kept.
  var result = parseFacilityFile(String(text || ""), DS, { includeClosed: true });
  if(result.error){ showMessage(result.error, "error"); return false; }

  records = result.records;
  RETENTION_START = null;
  records.forEach(function(r){
    var y = yearOf(r.closedDate);
    if(y && (RETENTION_START === null || y < RETENTION_START)) RETENTION_START = y;
  });

  var opened = records.filter(function(r){ return yearOf(r.licenseDate); }).length;
  var closed = records.filter(function(r){ return r.status === "CLOSED"; }).length;
  showMessage((origin === "download" ? "Latest data downloaded. " : "") +
    fmtCount(records.length) + " records read, " + fmtCount(records.length - closed) +
    " current and " + fmtCount(closed) + " closed. " + fmtCount(opened) + " carry a licence date.", "ok");
  saveMeta(metaFor(origin, name));
  renderFreshness();

  filterState.counties.clear(); filterState.cities.clear(); filterState.bands.clear();
  filterState.from = RETENTION_START || 2021;
  refreshFilters();
  buildYearSelect();
  render();
  restoring = false;
  saveRecords();
  saveView();
  saveActive();
  return true;
}

document.getElementById("csvUploadBtn").addEventListener("click", function(){
  document.getElementById("csvFileInput").click();
});
document.getElementById("csvFileInput").addEventListener("change", function(e){
  var file = e.target.files[0];
  e.target.value = "";
  if(!file) return;
  showMessage("Reading " + file.name + "...", "ok");
  var reader = new FileReader();
  reader.onload = function(evt){ ingestText(evt.target.result, "file", file.name); };
  reader.onerror = function(){ showMessage("That file couldn't be read. Try saving it again as CSV.", "error"); };
  reader.readAsText(file);
});
document.getElementById("fetchLatestBtn").addEventListener("click", async function(){
  var btn = this;
  btn.disabled = true;
  showMessage("Downloading the latest file from the CCLD Transparency Website. This can take up to a minute.", "ok");
  try {
    var text = await fetchCcld(DS.ccldId);
    ingestText(text, "download", DS.fileLabel);
  } catch(e){
    showMessage("Couldn't download the latest data because " + e.message +
      ". Nothing has changed. You can also download the file yourself and use Choose file.", "error");
  }
  btn.disabled = false;
});
document.getElementById("clearAllBtn").addEventListener("click", function(){
  records = [];
  clearMeta();
  clearSession();
  filterState.counties.clear(); filterState.cities.clear(); filterState.bands.clear();
  refreshFilters();
  render();
  showMessage(null);
  renderFreshness();
});

/* ---------- freshness, shared shape with the other pages ---------- */
var SESSION_VERSION = 1;
// Keys are per market, so loading home care never displaces the RCFE file.
function recordsKey(){ return "trends_" + DS.key + "_records"; }
function viewKey(){ return "trends_" + DS.key + "_view"; }
function metaKey(){ return "trends_" + DS.key + "_meta"; }
function saveMeta(m){ try{ localStorage.setItem(metaKey(), JSON.stringify(m)); }catch(e){} }
function loadMeta(){ try{ return JSON.parse(localStorage.getItem(metaKey()) || "null"); }catch(e){ return null; } }
function clearMeta(){ try{ localStorage.removeItem(metaKey()); }catch(e){} }
function metaFor(origin, name){
  var today = new Date().toISOString();
  if(origin === "download") return { asOf: today, basis: "download", name: name };
  var m = String(name || "").match(/(\d{2})(\d{2})(\d{4})\D*$/);
  if(m){
    var mo = +m[1], d = +m[2], y = +m[3];
    if(mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { asOf: new Date(y, mo - 1, d).toISOString(), basis: "file", name: name };
  }
  return { asOf: today, basis: "load", name: name };
}
function renderFreshness(){
  var el = document.getElementById("dataAge");
  var meta = loadMeta();
  if(!records.length){
    el.className = "stale";
    el.textContent = "No data loaded yet. Get latest data downloads the current file, or choose a file you have saved.";
    return;
  }
  if(!meta){ el.className = "stale"; el.textContent = "The date of the loaded data is unknown."; return; }
  var age = Math.round((Date.now() - Date.parse(meta.asOf)) / 86400000);
  el.className = age > 7 ? "stale" : "fresh";
  el.textContent = (meta.basis === "download" ? "Downloaded on " : "Data as of ") +
    new Date(meta.asOf).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) +
    " (" + (age <= 0 ? "today" : age === 1 ? "1 day old" : age + " days old") + ")." +
    (age > 7 ? " Newer data is probably available." : "");
}


/* ---------- saved session ----------
   This page needs only a few fields per record, so the stored form is far
   smaller than the map's: geography, size, status and the two dates the whole
   trend is built from. Compressed through the shared session store, a full
   residential care file costs well under a megabyte. */
var RECORD_FIELDS = ["facilityNumber", "city", "county", "status", "capacity", "licenseDate", "closedDate"];

function encodeRecords(list){
  return list.map(function(r){
    return RECORD_FIELDS.map(function(f){ return r[f] == null ? "" : r[f]; });
  });
}
function decodeRecords(raw){
  return raw.map(function(cells){
    var r = {};
    RECORD_FIELDS.forEach(function(f, i){ r[f] = cells[i]; });
    r.capacity = Number(r.capacity) || 0;
    r.capacityBand = DS.hasCapacity ? capacityBandKey(r.capacity) : "";
    return r;
  });
}

var restoring = true;   // no saving until the stored view has been read back
var storageWarned = false;
function warnStorage(){
  if(storageWarned) return;
  storageWarned = true;
  showMessage("This browser wouldn't save the loaded file, so a refresh will start empty. Everything else still works.", "error");
}

function saveRecords(){
  writeSession(recordsKey(), JSON.stringify({
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    retentionStart: RETENTION_START,
    records: encodeRecords(records)
  }), warnStorage);
}

function saveView(){
  if(restoring) return;
  try{
    localStorage.setItem(viewKey(), JSON.stringify({
      version: SESSION_VERSION,
      counties: Array.from(filterState.counties),
      cities: Array.from(filterState.cities),
      bands: Array.from(filterState.bands),
      from: filterState.from,
      chart: document.getElementById("chartMeasure").value
    }));
  }catch(e){ /* the view is small and non-essential */ }
}

var ACTIVE_KEY = "trends_active";
function saveActive(){ try{ localStorage.setItem(ACTIVE_KEY, DS.key); }catch(e){} }
function loadActive(){ try{ return localStorage.getItem(ACTIVE_KEY); }catch(e){ return null; } }

function clearSession(){
  try{
    localStorage.removeItem(recordsKey());
    localStorage.removeItem(viewKey());
  }catch(e){}
}

async function restoreSession(){
  var recordsRaw, viewRaw;
  try{
    recordsRaw = JSON.parse((await readSession(recordsKey())) || "null");
    viewRaw = JSON.parse((await readSession(viewKey())) || "null");
  }catch(e){ return false; }
  if(!recordsRaw || recordsRaw.version !== SESSION_VERSION || !recordsRaw.records || !recordsRaw.records.length) return false;

  records = decodeRecords(recordsRaw.records);
  RETENTION_START = recordsRaw.retentionStart || null;

  if(viewRaw && viewRaw.version === SESSION_VERSION){
    (viewRaw.counties || []).forEach(function(v){ filterState.counties.add(v); });
    (viewRaw.cities || []).forEach(function(v){ filterState.cities.add(v); });
    (viewRaw.bands || []).forEach(function(v){ filterState.bands.add(v); });
    if(viewRaw.from) filterState.from = viewRaw.from;
    if(viewRaw.chart){
      var sel = document.getElementById("chartMeasure");
      if(sel.querySelector('option[value="' + viewRaw.chart + '"]')) sel.value = viewRaw.chart;
    }
  }
  if(!filterState.from) filterState.from = RETENTION_START || 2021;

  refreshFilters();
  buildYearSelect();
  render();

  var when = "";
  var t = Date.parse(recordsRaw.savedAt || "");
  if(!isNaN(t)) when = " loaded " + new Date(t).toLocaleDateString();
  var closed = records.filter(function(r){ return r.status === "CLOSED"; }).length;
  showMessage(fmtCount(records.length) + " records restored from the file you" + when + ", " +
    fmtCount(records.length - closed) + " current and " + fmtCount(closed) + " closed.", "ok");
  return true;
}

/* ---------- filters ---------- */
function makeMultiSelect(containerId, selectedSet, getValues, getLabel, allLabel, onChange, searchable){
  var container = document.getElementById(containerId);
  var btn = container.querySelector(".multiselect-btn");
  var panel = container.querySelector(".multiselect-panel");
  function optionsHtml(values, filterText){
    var shown = filterText ? values.filter(function(v){ return getLabel(v).toLowerCase().indexOf(filterText) !== -1; }) : values;
    if(!shown.length) return '<div class="ms-empty">Nothing to filter yet</div>';
    return shown.map(function(v){
      return '<label><input type="checkbox" value="' + esc(v) + '"' + (selectedSet.has(v) ? " checked" : "") + "> " + esc(getLabel(v)) + "</label>";
    }).join("");
  }
  function refresh(){
    var values = getValues();
    Array.from(selectedSet).forEach(function(v){ if(values.indexOf(v) === -1) selectedSet.delete(v); });
    panel.innerHTML = (searchable ? '<input type="search" class="ms-search" placeholder="Filter list">' : "") +
      '<div class="ms-options">' + optionsHtml(values, "") + "</div>";
    btn.textContent = selectedSet.size === 0 ? allLabel
      : selectedSet.size === 1 ? getLabel(Array.from(selectedSet)[0]) : selectedSet.size + " selected";
  }
  panel.addEventListener("input", function(e){
    if(!e.target.classList.contains("ms-search")) return;
    var opts = panel.querySelector(".ms-options");
    if(opts) opts.innerHTML = optionsHtml(getValues(), e.target.value.trim().toLowerCase());
  });
  panel.addEventListener("change", function(e){
    if(e.target.type !== "checkbox") return;
    if(e.target.checked) selectedSet.add(e.target.value); else selectedSet.delete(e.target.value);
    refresh();
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

function distinct(get){
  return Array.from(new Set(records.map(get).filter(Boolean))).sort();
}
var countyUI = makeMultiSelect("countyFilter", filterState.counties,
  function(){ return distinct(function(r){ return r.county; }); }, function(v){ return v; },
  "All counties", render, true);
var cityUI = makeMultiSelect("cityFilter", filterState.cities,
  function(){ return distinct(function(r){ return r.city; }); }, function(v){ return v; },
  "All cities", render, true);
var bandUI = makeMultiSelect("bandFilter", filterState.bands,
  function(){
    var present = {};
    records.forEach(function(r){ if(r.capacityBand) present[r.capacityBand] = true; });
    return CAPACITY_BANDS.map(function(b){ return b.key; }).filter(function(k){ return present[k]; });
  }, capacityBandLabel, "Any size", render, false);

function refreshFilters(){ countyUI.refresh(); cityUI.refresh(); bandUI.refresh(); }

document.getElementById("clearFiltersBtn").addEventListener("click", function(){
  filterState.counties.clear(); filterState.cities.clear(); filterState.bands.clear();
  refreshFilters();
  render();
});
document.getElementById("fromYear").addEventListener("change", function(e){
  filterState.from = +e.target.value;
  render();
});
document.getElementById("chartMeasure").addEventListener("change", render);

function buildYearSelect(){
  var sel = document.getElementById("fromYear");
  var earliest = 2000;
  records.forEach(function(r){
    var y = yearOf(r.licenseDate);
    if(y && y < earliest) earliest = Math.max(y, 1990);
  });
  var html = "";
  for(var y = currentYear - 1; y >= earliest; y--){
    var incomplete = RETENTION_START && y < RETENTION_START;
    html += '<option value="' + y + '"' + (y === filterState.from ? " selected" : "") + ">" +
      y + (incomplete ? " (partial)" : "") + "</option>";
  }
  sel.innerHTML = html;
}

function inScope(){
  return records.filter(function(r){
    if(filterState.counties.size && !filterState.counties.has(r.county)) return false;
    if(filterState.cities.size && !filterState.cities.has(r.city)) return false;
    if(filterState.bands.size && !filterState.bands.has(r.capacityBand)) return false;
    return true;
  });
}

/* ---------- the year series ----------
   Opened and closed are counted by their dates. In operation at year end is
   every record licensed on or before that year that had not closed by the end
   of it, which is exact for years inside the retention window. */
function series(){
  var scope = inScope();
  var from = filterState.from || RETENTION_START || 2021;
  var rows = [];
  for(var y = from; y <= currentYear; y++){
    var opened = 0, bedsAdded = 0, closed = 0, bedsLost = 0, live = 0, liveBeds = 0;
    scope.forEach(function(r){
      var ly = yearOf(r.licenseDate), cy = yearOf(r.closedDate);
      var beds = r.capacity || 0;
      if(ly === y){ opened++; bedsAdded += beds; }
      if(cy === y){ closed++; bedsLost += beds; }
      if(ly !== null && ly <= y && (cy === null || cy > y)){ live++; liveBeds += beds; }
    });
    rows.push({ year: y, opened: opened, bedsAdded: bedsAdded, closed: closed, bedsLost: bedsLost,
                net: opened - closed, netBeds: bedsAdded - bedsLost, live: live, liveBeds: liveBeds,
                partial: RETENTION_START !== null && y < RETENTION_START });
  }
  // Growth is measured against the previous year end, so the first row has none.
  rows.forEach(function(row, i){
    var prev = i > 0 ? rows[i - 1].live : null;
    row.growth = (prev && prev > 0) ? (row.live - prev) / prev * 100 : null;
  });
  return rows;
}

/* ---------- chart ----------
   Drawn as inline SVG: one dependency fewer, and it prints cleanly. */
function drawChart(rows){
  var box = document.getElementById("chart");
  var note = document.getElementById("chartNote");
  if(!rows.length){ box.innerHTML = ""; note.textContent = ""; return; }
  var measure = document.getElementById("chartMeasure").value;

  var W = 900, H = 320, padL = 64, padR = 20, padT = 18, padB = 46;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var n = rows.length;
  var slot = plotW / n;

  var svg = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Trend chart">'];
  var bars = [], lines = [], maxV, minV = 0;

  function xMid(i){ return padL + slot * (i + 0.5); }
  function yFor(v){ return padT + plotH - (v - minV) / (maxV - minV || 1) * plotH; }

  if(measure === "stock"){
    maxV = Math.max.apply(null, rows.map(function(r){ return r.live; }));
    maxV = maxV * 1.08 || 1;
    var pts = rows.map(function(r, i){ return xMid(i) + "," + yFor(r.live); }).join(" ");
    lines.push('<polyline fill="none" stroke="#6a3d9a" stroke-width="2.5" points="' + pts + '"/>');
    rows.forEach(function(r, i){
      lines.push('<circle cx="' + xMid(i) + '" cy="' + yFor(r.live) + '" r="3.5" fill="#6a3d9a"/>');
      lines.push('<text class="pt" x="' + xMid(i) + '" y="' + (yFor(r.live) - 9) + '">' + fmtCount(r.live) + "</text>");
    });
    note.textContent = "Facilities in operation at the end of each year, within the current filters.";
  } else if(measure === "flow"){
    maxV = Math.max.apply(null, rows.map(function(r){ return Math.max(r.opened, r.closed); })) * 1.15 || 1;
    rows.forEach(function(r, i){
      var w = slot * 0.32;
      bars.push('<rect x="' + (xMid(i) - w - 2) + '" y="' + yFor(r.opened) + '" width="' + w +
        '" height="' + (padT + plotH - yFor(r.opened)) + '" fill="#2e7d32"/>');
      bars.push('<rect x="' + (xMid(i) + 2) + '" y="' + yFor(r.closed) + '" width="' + w +
        '" height="' + (padT + plotH - yFor(r.closed)) + '" fill="#c62828"/>');
      // A bar without its number makes the reader estimate; give them the figure.
      bars.push('<text class="pt" x="' + (xMid(i) - w / 2 - 2) + '" y="' + (yFor(r.opened) - 5) + '">' + fmtCount(r.opened) + "</text>");
      bars.push('<text class="pt" x="' + (xMid(i) + w / 2 + 2) + '" y="' + (yFor(r.closed) - 5) + '">' + fmtCount(r.closed) + "</text>");
    });
    note.textContent = "Green is newly licensed, red is closed. Both are complete only inside the retention window.";
  } else if(measure === "netBeds" || measure === "growth"){
    var key = measure === "netBeds" ? "netBeds" : "growth";
    var vals = rows.map(function(r){ return r[key] === null ? 0 : r[key]; });
    maxV = Math.max.apply(null, vals);
    minV = Math.min.apply(null, vals);
    var span = (maxV - minV) || 1;
    maxV += span * 0.12; minV -= span * 0.12;
    var zero = yFor(0);
    svg.push('<line x1="' + padL + '" y1="' + zero + '" x2="' + (W - padR) + '" y2="' + zero + '" stroke="#b9b1a4"/>');
    rows.forEach(function(r, i){
      var v = r[key];
      if(v === null) return;
      var w = slot * 0.5;
      var y = yFor(Math.max(v, 0)), h = Math.abs(yFor(v) - zero);
      bars.push('<rect x="' + (xMid(i) - w / 2) + '" y="' + y + '" width="' + w + '" height="' + h +
        '" fill="' + (v >= 0 ? "#2e7d32" : "#c62828") + '"/>');
      bars.push('<text class="pt" x="' + xMid(i) + '" y="' + (v >= 0 ? y - 6 : y + h + 13) + '">' +
        (key === "growth" ? fmtPct(v) : fmtSigned(v)) + "</text>");
    });
    note.textContent = key === "growth"
      ? "Change in the number in operation against the previous year end."
      : "Beds added by new licences minus beds lost to closures.";
  }

  // axes and year labels
  svg.push('<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '" stroke="#8a8175"/>');
  rows.forEach(function(r, i){
    svg.push('<text class="ax" x="' + xMid(i) + '" y="' + (padT + plotH + 18) + '">' + r.year + "</text>");
    if(r.partial) svg.push('<text class="ax partial" x="' + xMid(i) + '" y="' + (padT + plotH + 32) + '">partial</text>');
  });
  svg.push(bars.join("") + lines.join(""));
  svg.push("</svg>");
  box.innerHTML = svg.join("");
}

/* ---------- table ---------- */
var COLUMNS = [
  { key: "year", label: "Year", cell: function(r){ return r.year + (r.partial ? ' <span class="flag">partial</span>' : ""); } },
  { key: "opened", label: "Newly licensed", num: true, cell: function(r){ return fmtCount(r.opened); } },
  { key: "bedsAdded", label: "Beds added", num: true, beds: true, cell: function(r){ return fmtCount(r.bedsAdded); } },
  { key: "closed", label: "Closed", num: true, cell: function(r){ return r.partial ? "n/a" : fmtCount(r.closed); } },
  { key: "bedsLost", label: "Beds lost", num: true, beds: true, cell: function(r){ return r.partial ? "n/a" : fmtCount(r.bedsLost); } },
  { key: "net", label: "Net change", num: true, cell: function(r){ return r.partial ? "n/a" : fmtSigned(r.net); } },
  { key: "netBeds", label: "Net beds", num: true, beds: true, cell: function(r){ return r.partial ? "n/a" : fmtSigned(r.netBeds); } },
  { key: "live", label: "In operation", num: true, cell: function(r){ return fmtCount(r.live); } },
  { key: "liveBeds", label: "Licensed beds", num: true, beds: true, cell: function(r){ return fmtCount(r.liveBeds); } },
  { key: "growth", label: "Growth", num: true, cell: function(r){ return fmtPct(r.growth); } }
];
function columns(){ return COLUMNS.filter(function(c){ return !c.beds || DS.hasCapacity; }); }

function renderTable(rows){
  var cols = columns();
  document.getElementById("tableHead").innerHTML = cols.map(function(c){
    return "<th" + (c.num ? ' class="num"' : "") + ">" + esc(c.label) + "</th>";
  }).join("");
  document.getElementById("tableBody").innerHTML = rows.length
    ? rows.slice().reverse().map(function(r){
        return "<tr>" + cols.map(function(c){
          return "<td" + (c.num ? ' class="num"' : "") + ">" + c.cell(r) + "</td>";
        }).join("") + "</tr>";
      }).join("")
    : '<tr><td colspan="' + cols.length + '" class="empty-note">Load a file to see the trend.</td></tr>';
}

/* ---------- render ---------- */
function render(){
  saveView();
  var scope = inScope();
  document.getElementById("scopeSummary").textContent = records.length
    ? fmtCount(scope.length) + " of " + fmtCount(records.length) + " records in scope, current and closed"
    : "";
  var note = document.getElementById("windowNote");
  if(!records.length){ note.textContent = ""; }
  else if(RETENTION_START){
    note.textContent = "The state keeps closed records for about five years: the earliest closing date in this file is " +
      RETENTION_START + ". From " + RETENTION_START + " onward both openings and closures are complete. Earlier years are marked partial: " +
      "they show only facilities that survived into the retention window, so openings are understated and closures are missing.";
  } else {
    note.textContent = "This file contains no closed records, so only openings can be counted.";
  }
  var rows = records.length ? series() : [];
  drawChart(rows);
  renderTable(rows);
  document.getElementById("tableNote").textContent = rows.length
    ? "Counts reflect the current filters. " + (DS.hasCapacity ? "Bed figures use each facility's capacity as recorded now." : "")
    : "";
}

/* ---------- dataset switching ---------- */
function applyDatasetUi(){
  document.getElementById("bandGroup").style.display = DS.hasCapacity ? "" : "none";
  if(!DS.hasCapacity) filterState.bands.clear();
  // Home care licences carry no bed count, so a beds chart would plot zeros.
  var chart = document.getElementById("chartMeasure");
  var bedsOption = chart.querySelector('option[value="netBeds"]');
  if(DS.hasCapacity && !bedsOption){
    var opt = document.createElement("option");
    opt.value = "netBeds";
    opt.textContent = "Net beds added";
    chart.insertBefore(opt, chart.querySelector('option[value="growth"]'));
  }else if(!DS.hasCapacity && bedsOption){
    if(chart.value === "netBeds") chart.value = "stock";
    bedsOption.remove();
  }
  document.getElementById("loadHint").textContent =
    "Get latest data downloads the current " + (DS.key === "rcfe" ? "RCFE" : "home care") +
    " file from the CCLD Transparency Website. Closed records are kept here on purpose: they are what makes a trend possible.";
  document.querySelectorAll("[data-ds]").forEach(function(el){
    var on = el.getAttribute("data-ds") === DS.key;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", on);
  });
}
document.querySelectorAll("[data-ds]").forEach(function(el){
  el.addEventListener("click", function(){
    var key = el.getAttribute("data-ds");
    if(DS.key === key) return;
    restoring = true;
    DS = DATASETS[key];
    saveActive();
    records = [];
    RETENTION_START = null;
    filterState.counties.clear(); filterState.cities.clear(); filterState.bands.clear();
    filterState.from = null;
    applyDatasetUi();
    refreshFilters();
    render();
    showMessage(null);
    restoreSession().then(function(){ restoring = false; renderFreshness(); });
  });
});

/* ---------- export and print ---------- */
document.getElementById("csvBtn").addEventListener("click", function(){
  var rows = records.length ? series() : [];
  if(!rows.length) return;
  var cols = columns();
  function f(v){ var s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
  var lines = [cols.map(function(c){ return c.label; }).concat(["Complete window"]).join(",")];
  rows.forEach(function(r){
    lines.push(cols.map(function(c){
      if(c.key === "growth") return r.growth === null ? "" : r.growth.toFixed(1);
      return r[c.key];
    }).concat([r.partial ? "no" : "yes"]).map(f).join(","));
  });
  var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "growth-trends-" + DS.key + ".csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
});
document.getElementById("printBtn").addEventListener("click", function(){ window.print(); });

/* ---------- init ---------- */
DS = DATASETS[loadActive() === "hco" ? "hco" : "rcfe"];
applyDatasetUi();
refreshFilters();
buildYearSelect();
render();
// Reading a saved session is asynchronous because it is decompressed on the
// way in. Paint the empty state first, then fill it once the session arrives,
// and only then allow saving, so startup cannot overwrite what it is reading.
restoreSession().then(function(){ restoring = false; renderFreshness(); });
})();
