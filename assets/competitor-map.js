
(function(){
"use strict";

/* ---------- small utilities ---------- */
function escapeHtml(s){
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function normalizeKey(s){ return String(s || "").trim().toLowerCase().replace(/\s+/g," "); }
// The CDSS file is entirely uppercase, which is hard to scan in a long table.
// Title-casing reads better, but business suffixes have to stay uppercase or
// every other agency turns into "Llc".
var KEEP_UPPER = /\b(Llc|Llp|Lp|Usa|Ii|Iii|Pc|Rn|Lvn)\b/g;
function titleCase(s){
  return String(s || "").toLowerCase()
    .replace(/\b([a-z])([a-z'.\-]*)/g, function(_, a, b){ return a.toUpperCase() + b; })
    .replace(KEEP_UPPER, function(m){ return m.toUpperCase(); });
}
function toInt(v){ var n = parseInt(String(v || "").replace(/[^0-9\-]/g, ""), 10); return isNaN(n) ? 0 : n; }
function dateValue(s){
  var m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2]).getTime();
}
var idCounter = 0;
function nextId(){ idCounter += 1; return "hco" + idCounter; }
function haversineMiles(lat1, lng1, lat2, lng2){
  var R = 3958.8;
  var toRad = function(d){ return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.asin(Math.sqrt(a));
}

/* ---------- cache: localStorage, falls back to in-memory if unavailable ---------- */
function makeCache(namespace){
  var mem = {};
  var useLS = true;
  try{
    var t = "__cachetest__";
    localStorage.setItem(t, "1");
    localStorage.removeItem(t);
  }catch(e){ useLS = false; }
  return {
    get: function(key){
      if(useLS){
        try{
          var v = localStorage.getItem(namespace + ":" + key);
          return v === null ? undefined : JSON.parse(v);
        }catch(e){ return mem[key]; }
      }
      return mem[key];
    },
    set: function(key, value){
      mem[key] = value;
      if(useLS){
        try{ localStorage.setItem(namespace + ":" + key, JSON.stringify(value)); }catch(e){}
      }
    },
    remove: function(key){
      delete mem[key];
      if(useLS){
        try{ localStorage.removeItem(namespace + ":" + key); }catch(e){}
      }
    }
  };
}

/* Coordinates come from the shared gazetteer module: no geocoding service is
   called when a file loads. ZIP is tried before city name because it is more
   precise and survives the misspellings and neighborhood names the source
   files contain. */
function lookupZip(zip){
  var z = String(zip || "").trim().match(/^(\d{5})/);
  return z ? CA_ZIP[z[1]] || null : null;
}
function lookupPlace(city){
  if(!city) return null;
  var key = String(city).trim().toUpperCase().replace(/\s+/g, " ");
  return CA_PLACE[key] || null;
}
function locate(city, zip){
  var p = lookupZip(zip);
  if(p) return { lat: p.lat, lng: p.lng, source: "zip" };
  p = lookupPlace(city);
  if(p) return { lat: p.lat, lng: p.lng, source: "city" };
  return null;
}

/* Exact street coordinates, when the Census batch round trip has been run.
   Keyed by facility number and kept in this browser, so reloading the same
   CDSS file picks them straight back up. */
var addrCache = makeCache("rcfemap_addr");   // replaced at init by the active dataset

/* A reference address is a single lookup rather than a bulk one, so the
   embedded tables are tried first (they cover any California ZIP or city
   instantly and offline) and a geocoding service is only contacted for a full
   street address, which the tables can't resolve. */
var geoCache = makeCache("suite_ref");

function stripStateSuffix(s){
  return String(s || "").replace(/[,\s]+(ca|calif\.?|california)\s*$/i, "").trim();
}

async function geocodeAddress(query){
  var key = normalizeKey(query);
  var cached = geoCache.get(key);
  if(cached !== undefined) return cached;
  var url = "https://nominatim.openstreetmap.org/search?q=" + encodeURIComponent(query) +
    "&countrycodes=us&format=json&limit=1";
  var res = await fetch(url, { headers: { "Accept": "application/json" } });
  if(!res.ok) throw new Error("geocoder returned " + res.status);
  var data = await res.json();
  if(!data || !data[0]) return null;
  var out = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  geoCache.set(key, out);
  return out;
}

/* ---------- CSV reader (RFC 4180: quoted fields, embedded commas and newlines) ---------- */
function parseCsv(text){
  // A field boundary: comma, line break, or end of input.
  function isDelim(ch){ return ch === undefined || ch === "," || ch === "\n" || ch === "\r"; }
  var rows = [], row = [], field = "", inQuotes = false;
  text = String(text).replace(/^\uFEFF/, "");
  for(var i = 0; i < text.length; i++){
    var c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"' && !isDelim(text[i+2])){
          // A doubled quote is an escaped quote, unless a delimiter follows the
          // pair. Data like  "ZHU, XIAOTONG "SHERRY"",  ends with a stray quote
          // against the closing one; treating that as escaped swallows the
          // comma and shifts every later column in the row.
          field += '"'; i++;
        }
        else if(text[i+1] === '"'){
          field += '"'; i++; inQuotes = false;
        }
        else{
          // A lone quote only closes the field when what follows is a field or
          // record boundary. The CDSS exports carry stray quotes inside data
          // (a citation number written 87224"(a)(2), for one), and treating
          // those as closers inverts the quote state for every row after it,
          // silently swallowing thousands of records. Keep it as data instead,
          // which is how Excel reads the same file.
          if(isDelim(text[i+1])) inQuotes = false;
          else field += '"';
        }
      }else field += c;
    }else if(c === '"'){
      inQuotes = true;
    }else if(c === ","){
      row.push(field); field = "";
    }else if(c === "\n"){
      row.push(field); field = "";
      rows.push(row); row = [];
    }else if(c === "\r"){
      // swallow; the \n that follows ends the record
    }else{
      field += c;
    }
  }
  if(field !== "" || row.length){ row.push(field); rows.push(row); }
  return rows.filter(function(r){ return r.some(function(c){ return c.trim() !== ""; }); });
}

/* ---------- datasets ----------
   Residential care and home care are licensed by the same division and their
   exports share a layout: fixed columns followed by a variable-length tail of
   complaint blocks. The differences are declared here rather than forked into
   two programs, so a fix to the reader or the map reaches both. */

var DATASETS = {
  rcfe: {
    key: "rcfe",
    label: "Residential care facilities",
    tab: "RCFE",
    subjectSingular: "facility",
    subjectPlural: "facilities",
    prefix: "rcfemap",
    ccldId: "ResidentialElderCareFacility",
    fileLabel: "",
    addrFile: "rcfe-address-batch.csv",
    exportFile: "residential-care-facilities.csv",
    hint: "Get latest data downloads the current RCFE file from the CCLD Transparency Website. You can also choose a file you have downloaded yourself. Closed and on-probation facilities are left out.",
    skippedLabel: "closed and on-probation facilities skipped",
    // The RCFE export gives complaint citations their own named columns, so the
    // tail only needs counting. Its blocks are seven fields, one more than the
    // home care file, because it separates unfounded allegations.
    tailBlock: 7,
    tailTypeA: null,
    complaintTypeAColumn: "complaint type a",
    complaintTypeBColumn: "complaint type b",
    hasCapacity: true,
    hasCcrc: true,
    hasAllegations: true,
    ratios: function(agg, recs){
      var n = recs.length;
      var beds = recs.reduce(function(s, r){ return s + (r.capacity || 0); }, 0);
      return [
        ["Licensed beds", fmtCount(beds)],
        ["Beds per 1,000 residents 75+", agg.a75[0] ? (beds / agg.a75[0] * 1000).toFixed(1) : "n/a"],
        ["Beds per 1,000 residents 85+", agg.a85[0] ? (beds / agg.a85[0] * 1000).toFixed(1) : "n/a"],
        ["Residents 85+ per facility", fmtCount(agg.a85[0] / n)],
        ["Residents 65+ with an independent living difficulty, per bed", beds ? (agg.il[0] / beds).toFixed(1) : "n/a"]
      ];
    }
  },
  hco: {
    key: "hco",
    label: "Home care agencies",
    tab: "Home care",
    subjectSingular: "agency",
    subjectPlural: "agencies",
    prefix: "hcomap",
    ccldId: "HomeCare",
    fileLabel: "CCLD Home Care download",
    addrFile: "census-address-batch.csv",
    exportFile: "home-care-agencies.csv",
    hint: "Get latest data downloads the current home care file from the CCLD Transparency Website. You can also choose a file you have downloaded yourself. Closed agencies are left out.",
    skippedLabel: "closed facilities skipped",
    // The home care export carries no complaint citation columns, so Type A and
    // Type B have to be summed out of the tail itself.
    tailBlock: 6,
    tailTypeA: 4,
    tailTypeB: 5,
    complaintTypeAColumn: null,
    complaintTypeBColumn: null,
    hasCapacity: false,   // the column exists but is empty for every record
    hasCcrc: false,
    hasAllegations: false,
    ratios: function(agg, recs){
      var n = recs.length;
      return [
        ["Residents 65+ per agency", fmtCount(agg.a65[0] / n)],
        ["Residents 65+ with an independent living difficulty, per agency", fmtCount(agg.il[0] / n)],
        ["Residents 65+ living alone, per agency", fmtCount(agg.al[0] / n)],
        ["Agencies per 10,000 residents 65+", agg.a65[0] ? (n / agg.a65[0] * 10000).toFixed(1) : "n/a"]
      ];
    }
  }
};

var DS = DATASETS.rcfe;   // the active dataset

var REQUIRED_HEADERS = ["facility number", "facility name", "facility city", "county name", "facility status"];
var OPEN_STATUSES = { "LICENSED": true, "PENDING": true };
// A row whose status cell holds something outside this list has had its columns
// shifted; its other values cannot be trusted either.
var KNOWN_STATUSES = { "LICENSED": true, "PENDING": true, "CLOSED": true, "ON PROBATION": true };

var CAPACITY_BANDS = [
  { key: "1-6", label: "1 to 6 beds", min: 1, max: 6, pin: 11 },
  { key: "7-15", label: "7 to 15 beds", min: 7, max: 15, pin: 14 },
  { key: "16-49", label: "16 to 49 beds", min: 16, max: 49, pin: 17 },
  { key: "50-99", label: "50 to 99 beds", min: 50, max: 99, pin: 21 },
  { key: "100+", label: "100 beds or more", min: 100, max: Infinity, pin: 26 }
];
function capacityBand(beds){
  for(var i = 0; i < CAPACITY_BANDS.length; i++){
    if(beds >= CAPACITY_BANDS[i].min && beds <= CAPACITY_BANDS[i].max) return CAPACITY_BANDS[i];
  }
  return null;
}
function capacityBandKey(beds){ var b = capacityBand(beds); return b ? b.key : ""; }
function capacityBandLabel(key){
  for(var i = 0; i < CAPACITY_BANDS.length; i++) if(CAPACITY_BANDS[i].key === key) return CAPACITY_BANDS[i].label;
  return key;
}
var CCRC_PATTERN = /continuing\s+care/i;

/* One parser for both exports, driven by the active dataset's declaration. */
function parseFacilityFile(text){
  var cfg = DS;
  var rows = parseCsv(text);
  if(rows.length < 2) return { error: "That file has no data rows. Upload the CDSS export as a CSV." };

  var header = rows[0].map(normalizeKey);
  var idx = {};
  header.forEach(function(h, i){ if(idx[h] === undefined) idx[h] = i; });

  var missing = REQUIRED_HEADERS.filter(function(h){ return idx[h] === undefined; });
  if(missing.length){
    return { error: "This doesn't look like a CDSS licensing export. Missing column" +
      (missing.length === 1 ? "" : "s") + ": " + missing.join(", ") + "." };
  }
  // Guard against loading the wrong one of the two files.
  var looksRcfe = idx["facility capacity"] !== undefined && idx["complaint type a"] !== undefined;
  if(cfg.key === "rcfe" && !looksRcfe){
    return { error: "That looks like the home care file, not the residential care file. Switch to the Home care tab, or choose the RCFE export." };
  }
  if(cfg.key === "hco" && looksRcfe){
    return { error: "That looks like the residential care file, not the home care file. Switch to the RCFE tab, or choose the home care export." };
  }

  var complaintStart = header.length - 1;
  function get(cells, name){
    var i = name ? idx[name] : undefined;
    return (i !== undefined && cells[i] != null) ? String(cells[i]).trim() : "";
  }

  var records = [], skippedClosed = 0, skippedNoCity = 0, malformed = 0;

  for(var r = 1; r < rows.length; r++){
    var cells = rows[r];
    if(cells.length < complaintStart) continue;

    var status = get(cells, "facility status").toUpperCase();
    if(!KNOWN_STATUSES[status]){ malformed++; continue; }
    if(!OPEN_STATUSES[status]){ skippedClosed++; continue; }

    var city = get(cells, "facility city");
    if(!city){ skippedNoCity++; continue; }

    // Whole blocks only: a short trailing block is ignored rather than allowed
    // to distort the count.
    var complaintCount = 0, tailA = 0, tailB = 0;
    if(cells.length > header.length){
      for(var t = complaintStart; t + cfg.tailBlock - 1 < cells.length; t += cfg.tailBlock){
        complaintCount++;
        if(cfg.tailTypeA !== null){
          tailA += toInt(cells[t + cfg.tailTypeA]);
          tailB += toInt(cells[t + cfg.tailTypeB]);
        }
      }
    }

    var citationText = get(cells, "citation numbers");
    var citationList = citationText ? citationText.split(",").map(function(s){ return s.trim(); }).filter(Boolean) : [];

    var typeA = toInt(get(cells, "inspect typea")) + toInt(get(cells, "other typea")) +
                (cfg.complaintTypeAColumn ? toInt(get(cells, cfg.complaintTypeAColumn)) : tailA);
    var typeB = toInt(get(cells, "inspect typeb")) + toInt(get(cells, "other typeb")) +
                (cfg.complaintTypeBColumn ? toInt(get(cells, cfg.complaintTypeBColumn)) : tailB);

    var zip = get(cells, "facility zip");
    var facilityNumber = get(cells, "facility number");
    var exact = addrCache.get(facilityNumber);
    var point = exact ? { lat: exact.lat, lng: exact.lng, source: "address" } : locate(city, zip);
    var capacity = cfg.hasCapacity ? toInt(get(cells, "facility capacity")) : 0;

    records.push({
      id: nextId(),
      facilityNumber: facilityNumber,
      name: titleCase(get(cells, "facility name")),
      licensee: titleCase(get(cells, "licensee")),
      administrator: titleCase(get(cells, "facility administrator")),
      phone: get(cells, "facility telephone number"),
      address: titleCase(get(cells, "facility address")),
      city: titleCase(city),
      cityKey: city.toUpperCase(),
      state: get(cells, "facility state").toUpperCase() || "CA",
      zip: zip,
      county: titleCase(get(cells, "county name")),
      status: status,
      isCcrc: cfg.hasCcrc ? CCRC_PATTERN.test(get(cells, "facility type")) : false,
      capacity: capacity,
      capacityBand: cfg.hasCapacity ? capacityBandKey(capacity) : "",
      licenseDate: get(cells, "license first date"),
      lastVisitDate: get(cells, "last visit date"),
      inspectionVisits: toInt(get(cells, "inspection visits")),
      complaintVisits: toInt(get(cells, "complaint visits")),
      otherVisits: toInt(get(cells, "other visits")),
      totalVisits: toInt(get(cells, "total visits")),
      complaints: complaintCount,
      allegations: cfg.hasAllegations ? toInt(get(cells, "total allegations")) : 0,
      substantiated: cfg.hasAllegations ? toInt(get(cells, "substantiated allegations")) : 0,
      typeA: typeA,
      typeB: typeB,
      citations: citationList.length,
      citationText: citationText,
      lat: point ? point.lat : null,
      lng: point ? point.lng : null,
      geoSource: point ? point.source : "",
      distance: null,
      geoStatus: point ? "Mapped" : "Unmapped"
    });
  }

  if(!records.length) return { error: "No licensed or pending records found in that file." };
  return { records: records, skippedClosed: skippedClosed, skippedNoCity: skippedNoCity, malformed: malformed };
}

function severityOf(rec){
  if(rec.typeA > 0) return "A";
  if(rec.typeB > 0) return "B";
  return "clean";
}
var SEVERITY_HEX = { A: "#c62828", B: "#e8a317", clean: "#2e7d32" };
var SEVERITY_LABEL = { A: "Type A citation", B: "Type B citation", clean: "No Type A or B" };
var LOCATION_SOURCE_LABEL = { address: "Street address", zip: "ZIP center", city: "City center" };
function severityHex(s){ return SEVERITY_HEX[s] || "#8a8175"; }

/* ---------- application state ---------- */
var agencies = [];
var reference = null;
var map, refMarker;
var cityMarkers = {};
var filterState = { counties: new Set(), cities: new Set(), severities: new Set(), statuses: new Set(),
  bands: new Set(), types: new Set(), search: "" };
var sortState = { key: "name", dir: 1 };
var MAX_TABLE_ROWS = 400;

/* ---------- columns ---------- */
function buildColumns(){
  var cols = [
  { key: "name", label: "Facility", sort: function(r){ return r.name; },
    cell: function(r){
      return '<div class="agency-name"><span class="sev-dot" style="background:' + severityHex(severityOf(r)) + '"></span>' +
        escapeHtml(r.name) + (r.isCcrc ? ' <span class="type-tag">CCRC</span>' : "") + "</div>" +
        (r.licensee && r.licensee !== r.name ? '<div class="agency-sub">' + escapeHtml(r.licensee) + "</div>" : "") +
        (r.address ? '<div class="agency-sub">' + escapeHtml(r.address) + "</div>" : "");
    } },
  { key: "capacity", label: "Beds", num: true, sort: function(r){ return r.capacity; },
    cell: function(r){ return r.capacity || ""; } },
  { key: "city", label: "City", sort: function(r){ return r.city; }, cell: function(r){ return escapeHtml(r.city); } },
  { key: "county", label: "County", sort: function(r){ return r.county; }, cell: function(r){ return escapeHtml(r.county); } },
  { key: "zip", label: "ZIP", sort: function(r){ return r.zip; }, cell: function(r){ return escapeHtml(r.zip); } },
  { key: "distance", label: "Distance", num: true, sort: function(r){ return r.distance == null ? Infinity : r.distance; },
    cell: function(r){ return r.distance != null ? r.distance.toFixed(1) + " mi" : ""; } },
  { key: "status", label: "Status", sort: function(r){ return r.status; },
    cell: function(r){
      if(r.geoStatus === "Unmapped") return '<span class="pill pill-nogeo">No location</span>';
      return '<span class="pill ' + (r.status === "LICENSED" ? "pill-licensed" : "pill-pending") + '">' + titleCase(r.status) + "</span>";
    } },
  { key: "administrator", label: "Administrator", sort: function(r){ return r.administrator; }, cell: function(r){ return escapeHtml(r.administrator); } },
  { key: "phone", label: "Phone", sort: function(r){ return r.phone; }, cell: function(r){ return escapeHtml(r.phone); } },
  { key: "licenseDate", label: "Licensed", sort: function(r){ var v = dateValue(r.licenseDate); return v == null ? -Infinity : v; },
    cell: function(r){ return escapeHtml(r.licenseDate); } },
  { key: "lastVisitDate", label: "Last visit", sort: function(r){ var v = dateValue(r.lastVisitDate); return v == null ? -Infinity : v; },
    cell: function(r){ return escapeHtml(r.lastVisitDate); } },
  { key: "totalVisits", label: "Visits", num: true, sort: function(r){ return r.totalVisits; }, cell: function(r){ return r.totalVisits || ""; } },
  { key: "complaints", label: "Complaints", num: true, sort: function(r){ return r.complaints; }, cell: function(r){ return r.complaints || ""; } },
  { key: "substantiated", label: "Substantiated", num: true, sort: function(r){ return r.substantiated; },
    cell: function(r){ return r.substantiated ? '<strong>' + r.substantiated + "</strong>" : ""; } },
  { key: "typeA", label: "Type A", num: true, sort: function(r){ return r.typeA; },
    cell: function(r){ return r.typeA ? '<strong style="color:var(--sev-a)">' + r.typeA + "</strong>" : ""; } },
  { key: "typeB", label: "Type B", num: true, sort: function(r){ return r.typeB; },
    cell: function(r){ return r.typeB ? '<strong style="color:#a9750a">' + r.typeB + "</strong>" : ""; } },
  { key: "citations", label: "Citations", num: true, sort: function(r){ return r.citations; },
    cell: function(r){ return r.citations ? '<span title="' + escapeHtml(r.citationText) + '">' + r.citations + "</span>" : ""; } }
  ];
  // Beds and the allegation breakdown exist only in the residential care file.
  return cols.filter(function(c){
    if(c.key === "capacity") return DS.hasCapacity;
    if(c.key === "substantiated") return DS.hasAllegations;
    return true;
  });
}
var COLUMNS = [];

/* ---------- filtering ---------- */
function matchesSearch(rec, term){
  if(!term) return true;
  return (rec.name + " " + rec.licensee + " " + rec.administrator + " " + rec.address + " " +
          rec.city + " " + rec.zip + " " + rec.facilityNumber).toLowerCase().indexOf(term) !== -1;
}

function getFilteredAgencies(){
  var term = filterState.search.trim().toLowerCase();
  return agencies.filter(function(rec){
    if(filterState.counties.size && !filterState.counties.has(rec.county)) return false;
    if(filterState.cities.size && !filterState.cities.has(rec.city)) return false;
    if(filterState.severities.size && !filterState.severities.has(severityOf(rec))) return false;
    if(filterState.statuses.size && !filterState.statuses.has(rec.status)) return false;
    if(filterState.bands.size && !filterState.bands.has(rec.capacityBand)) return false;
    if(filterState.types.size && !filterState.types.has(rec.isCcrc ? "ccrc" : "rcfe")) return false;
    return matchesSearch(rec, term);
  });
}

function sortRecords(list){
  var col = null;
  for(var i = 0; i < COLUMNS.length; i++) if(COLUMNS[i].key === sortState.key) col = COLUMNS[i];
  if(!col) return list;
  return list.slice().sort(function(a, b){
    var va = col.sort(a), vb = col.sort(b);
    if(typeof va === "string" || typeof vb === "string"){
      return String(va).localeCompare(String(vb)) * sortState.dir;
    }
    if(va === vb) return 0;
    return (va < vb ? -1 : 1) * sortState.dir;
  });
}

/* ---------- multi-select dropdowns ---------- */
function makeMultiSelect(containerId, selectedSet, getValues, getLabel, allLabel, onChange, searchable){
  var container = document.getElementById(containerId);
  var btn = container.querySelector(".multiselect-btn");
  var panel = container.querySelector(".multiselect-panel");

  function optionsHtml(values, filterText){
    var shown = filterText
      ? values.filter(function(v){ return getLabel(v).toLowerCase().indexOf(filterText) !== -1; })
      : values;
    if(!shown.length) return '<div style="padding:4px 6px;color:var(--ink-soft);font-size:12.5px;">Nothing to filter yet</div>';
    return shown.map(function(v){
      return '<label><input type="checkbox" value="' + escapeHtml(v) + '"' +
        (selectedSet.has(v) ? " checked" : "") + "> " + escapeHtml(getLabel(v)) + "</label>";
    }).join("");
  }

  function refresh(){
    var values = getValues();
    Array.from(selectedSet).forEach(function(v){ if(values.indexOf(v) === -1) selectedSet.delete(v); });
    var searchBox = searchable ? '<input type="search" class="ms-search" placeholder="Filter list">' : "";
    panel.innerHTML = searchBox + '<div class="ms-options">' + optionsHtml(values, "") + "</div>";
    updateBtnLabel();
  }

  function updateBtnLabel(){
    if(selectedSet.size === 0) btn.textContent = allLabel;
    else if(selectedSet.size === 1) btn.textContent = getLabel(Array.from(selectedSet)[0]);
    else btn.textContent = selectedSet.size + " selected";
  }

  panel.addEventListener("input", function(e){
    if(!e.target.classList.contains("ms-search")) return;
    var opts = panel.querySelector(".ms-options");
    if(opts) opts.innerHTML = optionsHtml(getValues(), e.target.value.trim().toLowerCase());
  });

  panel.addEventListener("change", function(e){
    if(e.target.type !== "checkbox") return;
    if(e.target.checked) selectedSet.add(e.target.value);
    else selectedSet.delete(e.target.value);
    updateBtnLabel();
    onChange();
  });

  btn.addEventListener("click", function(e){
    e.stopPropagation();
    var willOpen = panel.hidden;
    document.querySelectorAll(".multiselect-panel").forEach(function(p){ p.hidden = true; });
    if(willOpen){
      panel.hidden = false;
      var s = panel.querySelector(".ms-search");
      if(s) s.focus();
    }
  });

  document.addEventListener("click", function(e){
    if(!container.contains(e.target)) panel.hidden = true;
  });

  return { refresh: refresh, setOnly: function(v){ selectedSet.clear(); selectedSet.add(v); refresh(); } };
}

function distinct(getter){
  return Array.from(new Set(agencies.map(getter).filter(Boolean))).sort();
}

var countyFilterUI = makeMultiSelect("countyFilter", filterState.counties,
  function(){ return distinct(function(r){ return r.county; }); },
  function(v){ return v; }, "All counties", onFilterChange, true);

var cityFilterUI = makeMultiSelect("cityFilter", filterState.cities,
  function(){ return distinct(function(r){ return r.city; }); },
  function(v){ return v; }, "All cities", onFilterChange, true);

var severityFilterUI = makeMultiSelect("severityFilter", filterState.severities,
  function(){ return ["A", "B", "clean"]; },
  function(v){ return SEVERITY_LABEL[v]; }, "Any", onFilterChange, false);

var statusFilterUI = makeMultiSelect("statusFilter", filterState.statuses,
  function(){ return distinct(function(r){ return r.status; }); },
  function(v){ return titleCase(v); }, "All statuses", onFilterChange, false);

// Bed count is offered as fixed bands rather than values read off the data:
// capacity runs 1 to 1,233 and a list that long is unusable, while the bands
// match how the market actually splits (six-bed homes against large communities).
var bandFilterUI = makeMultiSelect("bandFilter", filterState.bands,
  function(){
    var present = {};
    agencies.forEach(function(r){ if(r.capacityBand) present[r.capacityBand] = true; });
    return CAPACITY_BANDS.map(function(b){ return b.key; }).filter(function(k){ return present[k]; });
  },
  capacityBandLabel, "Any size", onFilterChange, false);

var typeFilterUI = makeMultiSelect("typeFilter", filterState.types,
  function(){
    var out = [];
    if(agencies.some(function(r){ return !r.isCcrc; })) out.push("rcfe");
    if(agencies.some(function(r){ return r.isCcrc; })) out.push("ccrc");
    return out;
  },
  function(v){ return v === "ccrc" ? "Continuing care community" : "Residential care, elderly"; },
  "All types", onFilterChange, false);

function applyDatasetUi(){
  document.getElementById("bandGroup").style.display = DS.hasCapacity ? "" : "none";
  document.getElementById("typeGroup").style.display = DS.hasCcrc ? "" : "none";
  if(!DS.hasCapacity) filterState.bands.clear();
  if(!DS.hasCcrc) filterState.types.clear();
  document.getElementById("loadHint").textContent = DS.hint;
  document.getElementById("resultsHeading").textContent = DS.label;
  document.querySelectorAll("[data-ds]").forEach(function(el){
    el.classList.toggle("active", el.getAttribute("data-ds") === DS.key);
    el.setAttribute("aria-selected", el.getAttribute("data-ds") === DS.key);
  });
}

function refreshFilterOptions(){
  countyFilterUI.refresh();
  cityFilterUI.refresh();
  severityFilterUI.refresh();
  statusFilterUI.refresh();
  bandFilterUI.refresh();
  typeFilterUI.refresh();
}

function onFilterChange(){
  renderTable();
  renderMarkers();
  saveView();
}

document.getElementById("clearFiltersBtn").addEventListener("click", function(){
  filterState.counties.clear();
  filterState.cities.clear();
  filterState.severities.clear();
  filterState.statuses.clear();
  filterState.bands.clear();
  filterState.types.clear();
  filterState.search = "";
  document.getElementById("searchInput").value = "";
  refreshFilterOptions();
  onFilterChange();
});

var searchTimer = null;
document.getElementById("searchInput").addEventListener("input", function(e){
  var value = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function(){
    filterState.search = value;
    onFilterChange();
  }, 200);
});

/* ---------- map ---------- */
function initMap(){
  map = L.map("map").setView([37.3, -119.5], 6);
  // Esri's basemap tile service is free for anonymous, moderate-volume use with
  // no key, and its street-map style carries visible county and city boundary
  // lines, which matter when the data itself is organized by county.
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: ""
  }).addTo(map);
}

function clusterIcon(count, severity){
  var size = count >= 100 ? 44 : count >= 50 ? 38 : count >= 10 ? 32 : 26;
  var font = size >= 38 ? 13 : size >= 32 ? 12 : 11;
  var html = '<div class="cluster-pin" style="width:' + size + "px;height:" + size + "px;background:" +
    severityHex(severity) + ";font-size:" + font + 'px;">' + count + "</div>";
  return L.divIcon({ html: html, className: "", iconSize: [size, size], iconAnchor: [size/2, size/2] });
}

function refIcon(){
  return L.divIcon({ html: '<div class="ref-pin"></div>', className: "", iconSize: [18,16], iconAnchor: [9,16] });
}

function clusterTooltip(group){
  var withA = group.records.filter(function(r){ return r.typeA > 0; }).length;
  var withB = group.records.filter(function(r){ return r.typeB > 0 && r.typeA === 0; }).length;
  var lines = ["<b>" + escapeHtml(group.city) + (group.county ? ", " + escapeHtml(group.county) + " County" : "") + "</b>"];
  lines.push(group.records.length + " " + (group.records.length === 1 ? DS.subjectSingular : DS.subjectPlural));
  var beds = DS.hasCapacity ? group.records.reduce(function(sum, r){ return sum + r.capacity; }, 0) : 0;
  if(beds) lines.push(beds.toLocaleString() + " licensed beds in total");
  if(withA) lines.push(withA + " with a Type A citation");
  if(withB) lines.push(withB + " with a Type B citation");
  if(!withA && !withB) lines.push("No Type A or B citations");
  if(group.records[0].distance != null) lines.push(group.records[0].distance.toFixed(1) + " mi from reference");
  lines.push('<span style="color:var(--ink-soft)">Click to filter the table to this city</span>');
  return '<div class="map-tooltip">' + lines.join("<br>") + "</div>";
}

function groupByCity(list){
  var groups = {};
  list.forEach(function(rec){
    if(rec.lat == null) return;
    var key = rec.cityKey + "|" + rec.state;
    if(!groups[key]) groups[key] = { city: rec.city, county: rec.county, records: [] };
    groups[key].records.push(rec);
  });
  // Points are ZIP-level, so a city's marker sits at the center of its own
  // agencies rather than at a nominal city center.
  Object.keys(groups).forEach(function(key){
    var g = groups[key];
    g.lat = g.records.reduce(function(sum, r){ return sum + r.lat; }, 0) / g.records.length;
    g.lng = g.records.reduce(function(sum, r){ return sum + r.lng; }, 0) / g.records.length;
  });
  return groups;
}

// In per-facility mode the pin is sized by licensed beds. City pins stay sized
// by facility count, since one pin cannot carry both and a count is what a
// cluster means.
function agencyIcon(rec){
  var band = DS.hasCapacity ? capacityBand(rec.capacity) : null;
  var size = band ? band.pin : 12;
  var html = '<div class="agency-pin" style="width:' + size + "px;height:" + size + "px;background:" +
    severityHex(severityOf(rec)) + ';"></div>';
  return L.divIcon({ html: html, className: "", iconSize: [size,size], iconAnchor: [size/2,size/2] });
}

function agencyTooltip(rec){
  var lines = ["<b>" + escapeHtml(rec.name) + "</b>"];
  if(rec.address) lines.push(escapeHtml(rec.address));
  lines.push(escapeHtml(rec.city) + ", " + escapeHtml(rec.zip));
  if(DS.hasCapacity && rec.capacity) lines.push(rec.capacity + " licensed bed" + (rec.capacity === 1 ? "" : "s") + (rec.isCcrc ? ", continuing care" : ""));
  if(rec.substantiated) lines.push(rec.substantiated + " substantiated allegation" + (rec.substantiated === 1 ? "" : "s"));
  if(rec.typeA) lines.push(rec.typeA + " Type A citation" + (rec.typeA === 1 ? "" : "s"));
  if(rec.typeB) lines.push(rec.typeB + " Type B citation" + (rec.typeB === 1 ? "" : "s"));
  if(!rec.typeA && !rec.typeB) lines.push("No Type A or B citations");
  if(rec.distance != null) lines.push(rec.distance.toFixed(1) + " mi from reference");
  if(rec.geoSource !== "address") lines.push('<span class="src-tag">Placed at ' + rec.geoSource + " center</span>");
  return '<div class="map-tooltip">' + lines.join("<br>") + "</div>";
}

// Drawing every agency individually is only readable once the list is narrowed.
// Past this many, the city view is used regardless of the control's setting.
var MAX_INDIVIDUAL_PINS = 600;

function renderAgencyMarkers(list){
  var bounds = [];
  list.forEach(function(rec){
    if(rec.lat == null) return;
    var marker = L.marker([rec.lat, rec.lng], { icon: agencyIcon(rec) });
    marker.bindTooltip(agencyTooltip(rec), { direction: "top", sticky: true });
    marker.addTo(map);
    cityMarkers[rec.id] = marker;
    bounds.push([rec.lat, rec.lng]);
  });
  return bounds;
}

function renderMarkers(){
  renderMarketPanel();
  if(!map) return; // map engine failed to start; table and CSV still work
  Object.keys(cityMarkers).forEach(function(k){ map.removeLayer(cityMarkers[k]); });
  cityMarkers = {};

  var filtered = getFilteredAgencies();
  var wantAgencyPins = document.getElementById("pinDetail").value === "address";
  var tooMany = filtered.length > MAX_INDIVIDUAL_PINS;
  var legend = document.getElementById("legendNote");

  if(wantAgencyPins && !tooMany){
    var b = renderAgencyMarkers(filtered);
    if(reference) b.push([reference.lat, reference.lng]);
    if(b.length) map.fitBounds(b, { padding: [30,30], maxZoom: 15 });
    legend.textContent = (DS.hasCapacity ? "One pin per facility. Pin size is licensed beds, color is the worst citation level." : "One pin per agency. Color is the worst citation level.");
    return;
  }

  legend.textContent = wantAgencyPins
    ? "Showing one pin per city: " + filtered.length.toLocaleString() + " records is too many to draw individually. Filter below " + MAX_INDIVIDUAL_PINS + " to see each one."
    : "Pin number is the " + DS.subjectSingular + " count in that city. Color shows the worst citation level present.";

  var groups = groupByCity(filtered);
  var bounds = [];
  Object.keys(groups).forEach(function(key){
    var group = groups[key];
    var severity = group.records.some(function(r){ return r.typeA > 0; }) ? "A"
      : group.records.some(function(r){ return r.typeB > 0; }) ? "B" : "clean";
    var marker = L.marker([group.lat, group.lng], { icon: clusterIcon(group.records.length, severity) });
    marker.bindTooltip(clusterTooltip(group), { direction: "top", sticky: true });
    marker.on("click", function(){
      cityFilterUI.setOnly(group.city);
      onFilterChange();
    });
    marker.addTo(map);
    cityMarkers[key] = marker;
    bounds.push([group.lat, group.lng]);
  });

  if(reference) bounds.push([reference.lat, reference.lng]);
  if(bounds.length) map.fitBounds(bounds, { padding: [30,30], maxZoom: 11 });
}

function recomputeDistances(){
  agencies.forEach(function(rec){
    rec.distance = (reference && rec.lat != null)
      ? haversineMiles(reference.lat, reference.lng, rec.lat, rec.lng)
      : null;
  });
}

/* ---------- table ---------- */
function renderHead(){
  document.getElementById("tableHead").innerHTML = COLUMNS.map(function(col){
    var arrow = sortState.key === col.key ? '<span class="arrow">' + (sortState.dir === 1 ? "\u25B2" : "\u25BC") + "</span>" : "";
    return '<th class="sortable" data-sort="' + col.key + '">' + escapeHtml(col.label) + arrow + "</th>";
  }).join("");
}

document.getElementById("tableHead").addEventListener("click", function(e){
  var th = e.target.closest("th[data-sort]");
  if(!th) return;
  var key = th.getAttribute("data-sort");
  if(sortState.key === key) sortState.dir = -sortState.dir;
  else { sortState.key = key; sortState.dir = 1; }
  renderHead();
  renderTable();
  saveView();
});

function renderTable(){
  var body = document.getElementById("tableBody");
  var visible = sortRecords(getFilteredAgencies());
  var shown = visible.slice(0, MAX_TABLE_ROWS);

  body.innerHTML = shown.map(function(rec){
    return "<tr>" + COLUMNS.map(function(col){
      return "<td" + (col.num ? ' class="num"' : "") + ">" + col.cell(rec) + "</td>";
    }).join("") + "</tr>";
  }).join("") || ('<tr><td colspan="' + COLUMNS.length + '" class="empty-note">' +
    (agencies.length === 0 ? "Nothing loaded yet. Use Get latest data, or choose a file." : "Nothing matches the current filters.") + "</td></tr>");

  var summary = document.getElementById("resultsSummary");
  summary.textContent = agencies.length === 0 ? "" :
    "Showing " + visible.length.toLocaleString() + " of " + agencies.length.toLocaleString() + " " + DS.subjectPlural;

  var note = document.getElementById("tableNote");
  note.textContent = visible.length > MAX_TABLE_ROWS
    ? "Table shows the first " + MAX_TABLE_ROWS + " rows. Narrow the filters to see the rest, or export the CSV for all " + visible.length.toLocaleString() + "."
    : "";
}

/* ---------- messages ---------- */
function showProgress(text){
  var el = document.getElementById("geoProgress");
  if(text){ el.style.display = "block"; el.textContent = text; }
  else el.style.display = "none";
}
function showMessage(text, kind){
  var el = document.getElementById("loadMessage");
  if(!text){ el.style.display = "none"; el.className = ""; return; }
  el.style.display = "block";
  el.className = kind || "";
  el.textContent = text;
}

/* ---------- map view ---------- */
function zoomToResults(){
  if(!map) return;
  var bounds = [];
  var groups = groupByCity(getFilteredAgencies());
  Object.keys(groups).forEach(function(k){ bounds.push([groups[k].lat, groups[k].lng]); });
  if(reference) bounds.push([reference.lat, reference.lng]);
  if(bounds.length) map.fitBounds(bounds, { padding: [30,30], maxZoom: 12 });
  else showMessage(agencies.length === 0 ? "Upload the CDSS file first." : "Nothing to show with the current filters.", "error");
}
document.getElementById("plotMapBtn").addEventListener("click", zoomToResults);
document.getElementById("pinDetail").addEventListener("change", function(){
  renderMarkers();
  saveView();
});

/* ---------- exact street addresses via the Census batch geocoder ----------
   The Census batch endpoint answers a whole file in seconds, but it sends no
   CORS header, so a page can post to it and still not be allowed to read the
   reply. Rather than fake it with thousands of single-address calls against an
   undocumented rate limit, the exchange is handed to the person: export a file
   in the layout the Census form expects, upload it there, bring the result
   back. Matched coordinates are cached by facility number, so it is one step
   per CDSS file rather than one per session. */
function showAddrMessage(text, kind){
  var el = document.getElementById("addrMessage");
  if(!text){ el.style.display = "none"; el.className = ""; return; }
  el.style.display = "block";
  el.className = kind || "";
  el.textContent = text;
}

function addressSourceCounts(){
  var counts = { address: 0, zip: 0, city: 0, none: 0 };
  agencies.forEach(function(r){ counts[r.geoSource || "none"]++; });
  return counts;
}

document.getElementById("exportAddrBtn").addEventListener("click", function(){
  if(!agencies.length){ showAddrMessage("Load the CDSS file first.", "error"); return; }
  // Census batch layout: unique id, street, city, state, ZIP, and no header row.
  var pending = agencies.filter(function(r){ return r.geoSource !== "address" && r.address; });
  if(!pending.length){ showAddrMessage("Every record already has an exact address.", "ok"); return; }

  var lines = pending.map(function(r){
    return [r.facilityNumber, r.address, r.city, r.state, r.zip].map(csvField).join(",");
  });
  downloadFile(lines.join("\n"), DS.addrFile);
  showAddrMessage(pending.length.toLocaleString() + " addresses exported. Upload rcfe-address-batch.csv at the Census geocoder, then bring the result back with \u201cImport Census results\u201d.", "ok");
});

document.getElementById("importAddrBtn").addEventListener("click", function(){
  if(!agencies.length){ showAddrMessage("Load the CDSS file first.", "error"); return; }
  document.getElementById("addrResultInput").click();
});

document.getElementById("addrResultInput").addEventListener("change", function(e){
  var file = e.target.files[0];
  e.target.value = "";
  if(!file) return;
  var reader = new FileReader();
  reader.onload = function(evt){
    var rows = parseCsv(String(evt.target.result || ""));
    var byNumber = {};
    agencies.forEach(function(r){ byNumber[r.facilityNumber] = r; });

    var applied = 0, unmatched = 0, unknownId = 0;
    rows.forEach(function(cells){
      if(cells.length < 3) return;
      var id = String(cells[0]).trim().replace(/^"|"$/g, "");
      var rec = byNumber[id];
      if(!rec){ unknownId++; return; }
      if(String(cells[2]).trim() !== "Match"){ unmatched++; return; }
      // Census returns the coordinate pair as "longitude,latitude".
      var pair = String(cells[5] || "").split(",");
      var lng = parseFloat(pair[0]), lat = parseFloat(pair[1]);
      if(isNaN(lat) || isNaN(lng)){ unmatched++; return; }
      rec.lat = lat; rec.lng = lng; rec.geoSource = "address"; rec.geoStatus = "Mapped";
      addrCache.set(rec.facilityNumber, { lat: lat, lng: lng });
      applied++;
    });

    if(!applied && !unmatched){
      showAddrMessage("No Census results recognized in that file. Upload the result file the Census geocoder gives back, not the one you sent it.", "error");
      return;
    }

    recomputeDistances();
    renderTable();
    renderMarkers();

    var counts = addressSourceCounts();
    saveRecords();
    var parts = [applied.toLocaleString() + " " + DS.subjectPlural + " placed at their street address"];
    if(unmatched) parts.push(unmatched.toLocaleString() + " the Census couldn't match, still at their ZIP center");
    if(unknownId) parts.push(unknownId + " rows didn't match a loaded record");
    parts.push(counts.zip + " at ZIP center, " + counts.city + " at city center");
    showAddrMessage(parts.join(". ") + ".", "ok");
  };
  reader.onerror = function(){ showAddrMessage("That result file couldn't be read.", "error"); };
  reader.readAsText(file);
});

document.getElementById("forgetAddrBtn").addEventListener("click", function(){
  agencies.forEach(function(rec){
    addrCache.remove(rec.facilityNumber);
    var point = locate(rec.city, rec.zip);
    rec.lat = point ? point.lat : null;
    rec.lng = point ? point.lng : null;
    rec.geoSource = point ? point.source : "";
    rec.geoStatus = point ? "Mapped" : "Unmapped";
  });
  recomputeDistances();
  renderTable();
  renderMarkers();
  saveRecords();
  showAddrMessage("Exact addresses cleared. Records are back at their ZIP code centers.", "ok");
});

/* ---------- saved session ----------
   The loaded list and the current view are kept in this browser so a refresh
   picks up where it left off. Records are written as plain arrays in a fixed
   field order rather than objects: the same 2,762 agencies cost about 670 KB
   that way versus 1.5 MB as named fields, which keeps a full CDSS file well
   inside the storage a browser allows. The two are split across separate keys
   because view state changes on every filter click while the record set only
   changes when a file is loaded. */
var SESSION_VERSION = 1;
var RECORD_FIELDS = ["facilityNumber","name","licensee","administrator","phone","address","city",
  "state","zip","county","status","isCcrc","capacity","licenseDate","lastVisitDate","inspectionVisits",
  "complaintVisits","otherVisits","totalVisits","complaints","allegations","substantiated","typeA","typeB",
  "citations","citationText","lat","lng","geoSource"];

function encodeRecords(list){
  return list.map(function(rec){
    return RECORD_FIELDS.map(function(f){ return rec[f] == null ? "" : rec[f]; });
  });
}

function decodeRecords(raw){
  return raw.map(function(cells){
    var rec = { id: nextId() };
    RECORD_FIELDS.forEach(function(f, i){ rec[f] = cells[i]; });
    rec.lat = rec.lat === "" ? null : Number(rec.lat);
    rec.lng = rec.lng === "" ? null : Number(rec.lng);
    ["inspectionVisits","complaintVisits","otherVisits","totalVisits","complaints","allegations",
     "substantiated","typeA","typeB","citations","capacity"]
      .forEach(function(f){ rec[f] = Number(rec[f]) || 0; });
    rec.isCcrc = rec.isCcrc === true || rec.isCcrc === "true" || rec.isCcrc === 1;
    rec.capacityBand = capacityBandKey(rec.capacity);
    rec.cityKey = String(rec.city || "").toUpperCase();
    rec.geoStatus = rec.lat == null ? "Unmapped" : "Mapped";
    rec.distance = null;
    return rec;
  });
}

var storageWarned = false;
function warnStorage(){
  if(storageWarned) return;
  storageWarned = true;
  showMessage("This browser wouldn't save the loaded list, so a refresh will start empty. Everything else still works.", "error");
}

function saveRecords(){
  // Compressing is asynchronous, so this returns before the write completes.
  // Nothing downstream depends on the write, and writeSession discards a stale
  // save if a newer one starts first.
  writeSession((DS.prefix + "_records"), JSON.stringify({
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    records: encodeRecords(agencies)
  }), warnStorage);
}

function saveView(){
  try{
    writeSession((DS.prefix + "_view"), JSON.stringify({
      version: SESSION_VERSION,
      counties: Array.from(filterState.counties),
      cities: Array.from(filterState.cities),
      severities: Array.from(filterState.severities),
      statuses: Array.from(filterState.statuses),
      bands: Array.from(filterState.bands),
      types: Array.from(filterState.types),
      search: filterState.search,
      sort: sortState,
      pinDetail: document.getElementById("pinDetail").value,
      demandMeasure: document.getElementById("demandMeasure").value,
      demandGeo: document.getElementById("demandGeo").value,
      reference: reference,
      referenceText: document.getElementById("refInput").value
    }));
  }catch(e){ /* view state is small and non-essential; a failure here is silent */ }
}

function clearSession(){
  try{
    localStorage.removeItem((DS.prefix + "_records"));
    localStorage.removeItem((DS.prefix + "_view"));
  }catch(e){}
}

async function restoreSession(){
  var recordsRaw, viewRaw;
  try{
    recordsRaw = JSON.parse((await readSession((DS.prefix + "_records"))) || "null");
    viewRaw = JSON.parse((await readSession((DS.prefix + "_view"))) || "null");
  }catch(e){ return false; }
  if(!recordsRaw || recordsRaw.version !== SESSION_VERSION || !recordsRaw.records || !recordsRaw.records.length) return false;

  agencies = decodeRecords(recordsRaw.records);

  if(viewRaw && viewRaw.version === SESSION_VERSION){
    (viewRaw.counties || []).forEach(function(v){ filterState.counties.add(v); });
    (viewRaw.cities || []).forEach(function(v){ filterState.cities.add(v); });
    (viewRaw.severities || []).forEach(function(v){ filterState.severities.add(v); });
    (viewRaw.statuses || []).forEach(function(v){ filterState.statuses.add(v); });
    (viewRaw.bands || []).forEach(function(v){ filterState.bands.add(v); });
    (viewRaw.types || []).forEach(function(v){ filterState.types.add(v); });
    filterState.search = viewRaw.search || "";
    document.getElementById("searchInput").value = filterState.search;
    if(viewRaw.sort && viewRaw.sort.key) sortState = viewRaw.sort;
    if(viewRaw.pinDetail) document.getElementById("pinDetail").value = viewRaw.pinDetail;
    if(viewRaw.demandMeasure !== undefined) document.getElementById("demandMeasure").value = viewRaw.demandMeasure;
    if(viewRaw.demandGeo) document.getElementById("demandGeo").value = viewRaw.demandGeo;
    document.getElementById("refInput").value = viewRaw.referenceText || "";
    if(viewRaw.reference){
      reference = viewRaw.reference;
      if(map){
        refMarker = L.marker([reference.lat, reference.lng], { icon: refIcon() }).addTo(map);
        refMarker.bindTooltip("<b>Reference point</b>", { direction: "top" });
      }
    }
  }

  recomputeDistances();
  refreshFilterOptions();
  renderHead();
  renderTable();
  renderMarkers();

  var when = "";
  var t = Date.parse(recordsRaw.savedAt || "");
  if(!isNaN(t)) when = " loaded " + new Date(t).toLocaleDateString();
  var filtersOn = filterState.counties.size || filterState.cities.size || filterState.severities.size ||
    filterState.statuses.size || filterState.bands.size || filterState.types.size || filterState.search;
  showMessage(agencies.length.toLocaleString() + " " + DS.subjectPlural + " restored from the file you" + when + "." +
    (filtersOn ? " Your filters were kept too." : ""), "ok");
  return true;
}

/* ---------- latest data and freshness ----------
   The tool can fetch its own source file. Both publishers answer browser
   requests with a header permitting cross-site downloads, so this needs no
   server. The CDSS files come from the Download Data feature of the CCLD Transparency
   Website. That address is not a published API: it was found by reading the
   code behind the site's own download button, and could change without notice.
   If it does, the download fails with a plain message and the loaded data stays.

   Freshness is recorded separately from the records so that a later save,
   such as an address import, never resets it. */
var STALE_AFTER_DAYS = 7;
var META_KEY = null;   // set per dataset by applyDataset()
var FETCH_TIMEOUT_MS = 120000;

function saveMeta(meta){ try{ localStorage.setItem(META_KEY, JSON.stringify(meta)); }catch(e){} }
function loadMeta(){ try{ return JSON.parse(localStorage.getItem(META_KEY) || "null"); }catch(e){ return null; } }
function clearMeta(){ try{ localStorage.removeItem(META_KEY); }catch(e){} }

function newGuid(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){
    var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16);
  });
}

function fetchWithTimeout(url){
  var ctl = ("AbortController" in window) ? new AbortController() : null;
  var timer = ctl ? setTimeout(function(){ ctl.abort(); }, FETCH_TIMEOUT_MS) : null;
  return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function(res){
    if(timer) clearTimeout(timer);
    if(!res.ok) throw new Error("the server answered " + res.status);
    return res;
  }, function(err){
    if(timer) clearTimeout(timer);
    throw new Error(err && err.name === "AbortError" ? "it took longer than two minutes" : "the connection failed");
  });
}

// "HomeCare09132026.csv" -> September 13, 2026. The CCLD Download Data files
// carry their date this way; files without one return null.
function dateFromFileName(name){
  var m = String(name || "").match(/(\d{2})(\d{2})(\d{4})\D*$/);
  if(!m) return null;
  var mo = +m[1], d = +m[2], y = +m[3];
  if(mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000) return null;
  return new Date(y, mo - 1, d).toISOString();
}

// "09/16/2026" -> ISO date, as carried in the CDPH DATA_DATE column.
function dateFromSlashes(s){
  var m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? new Date(+m[3], +m[1] - 1, +m[2]).toISOString() : null;
}

function formatDay(iso){
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function daysOld(iso){
  var then = new Date(iso); then.setHours(0, 0, 0, 0);
  var now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((now - then) / 86400000);
}

function renderFreshness(){
  var el = document.getElementById("dataAge");
  var btn = document.getElementById("fetchLatestBtn");
  if(!el) return;
  var meta = loadMeta();
  if(!agencies.length){
    el.className = "stale";
    el.textContent = "No data loaded yet. Get latest data downloads the current file directly, or choose a file you have saved.";
    el.style.display = "block";
    return;
  }
  if(!meta || !meta.asOf){
    el.className = "stale";
    el.textContent = "The date of the loaded data is unknown. Get latest data to be sure it is current.";
    el.style.display = "block";
    return;
  }
  var age = daysOld(meta.asOf);
  var lead = meta.basis === "download"
    ? "Downloaded from " + SOURCE.label + " on " + formatDay(meta.asOf)
    : meta.basis === "load"
      ? "Loaded on " + formatDay(meta.asOf) + " from " + (meta.name || "a file") + ", whose data date is unknown"
      : "Data as of " + formatDay(meta.asOf) + (meta.name ? ", from " + meta.name : "");
  var ageText = age <= 0 ? "today" : age === 1 ? "1 day old" : age + " days old";
  var stale = age > STALE_AFTER_DAYS;
  el.className = stale ? "stale" : "fresh";
  el.textContent = lead + " (" + ageText + ")." + (stale ? " Newer data is probably available; click Get latest data." : "");
  el.style.display = "block";
  if(btn) btn.classList.toggle("attention", stale);
}

// Work out what date the loaded data represents, and how we know it.
function metaFor(origin, name, result){
  var today = new Date().toISOString();
  if(result && result.dataDate){
    var dd = dateFromSlashes(result.dataDate);
    if(dd) return { asOf: dd, basis: "file", origin: origin, name: name };
  }
  if(origin === "download") return { asOf: today, basis: "download", origin: origin, name: name };
  var fromName = dateFromFileName(name);
  if(fromName) return { asOf: fromName, basis: "file", origin: origin, name: name };
  return { asOf: today, basis: "load", origin: origin, name: name };
}

async function getLatestData(){
  var btn = document.getElementById("fetchLatestBtn");
  btn.disabled = true;
  showMessage("Downloading the latest file from " + SOURCE.label + ". This can take up to a minute; please stay on this page.", "ok");
  try{
    var text = await SOURCE.fetch();
    ingestText(text, "download", DS.fileLabel);
  }catch(e){
    showMessage("Couldn't download the latest data because " + e.message + ". Nothing has changed; your current data is still loaded. You can also download the file yourself and use Choose file.", "error");
  }
  btn.disabled = false;
}


function fetchCcld(id){
  var url = "https://www.ccld.dss.ca.gov/transparencyapi/api/DownloadStateData?id=" +
    encodeURIComponent(id) + "&GUID=" + newGuid();
  return fetchWithTimeout(url).then(function(res){ return res.text(); });
}
var SOURCE = {
  label: "the CCLD Transparency Website",
  fileLabel: "",
  fetch: function(){ return fetchCcld(DS.ccldId); }
};

/* ---------- file load ---------- */
document.getElementById("csvUploadBtn").addEventListener("click", function(){
  document.getElementById("csvFileInput").click();
});

function ingestText(text, origin, name){
  var result = parseFacilityFile(String(text || ""));
  if(result.error){ showMessage(result.error, "error"); return false; }

  // A download that comes back far smaller than what is already loaded is more
  // likely truncated than real. Refuse it rather than replace good data with it.
  if(origin === "download" && agencies.length && result.records.length < agencies.length * 0.5){
    showMessage("The downloaded file has only " + result.records.length.toLocaleString() +
      " records, against " + agencies.length.toLocaleString() + " already loaded. That looks like an " +
      "incomplete download, so it was not used and your current data is unchanged. Try again later.", "error");
    return false;
  }

  // Downloads always replace; merging is only for combining files by hand.
  if(origin === "file" && document.getElementById("addToMap").checked){
    var seen = {};
    agencies.forEach(function(r){ seen[r.facilityNumber] = true; });
    agencies = agencies.concat(result.records.filter(function(r){ return !seen[r.facilityNumber]; }));
  }else{
    agencies = result.records;
  }

  refreshFilterOptions();
  renderTable();
  renderMarkers();

  var unmapped = agencies.filter(function(r){ return r.geoStatus === "Unmapped"; }).length;
  var parts = [result.records.length.toLocaleString() + " licensed and pending " + DS.subjectPlural + " loaded"];
  if(result.skippedClosed) parts.push(result.skippedClosed.toLocaleString() + " " + DS.skippedLabel);
  if(result.skippedNoCity) parts.push(result.skippedNoCity + " skipped with no city");
  if(result.malformed) parts.push(result.malformed + " skipped as unreadable rows");
  if(unmapped) parts.push(unmapped + " with no usable ZIP or city, listed but not mapped");
  var exactCount = addressSourceCounts().address;
  if(exactCount) parts.push(exactCount.toLocaleString() + " already placed at their street address");
  showMessage((origin === "download" ? "Latest data downloaded. " : "") + parts.join(", ") + ".", "ok");
  saveMeta(metaFor(origin, name, result));
  renderFreshness();
  saveRecords();
  saveView();
  zoomToResults();
  return true;
}

document.getElementById("fetchLatestBtn").addEventListener("click", getLatestData);

document.getElementById("csvFileInput").addEventListener("change", function(e){
  var file = e.target.files[0];
  e.target.value = ""; // allow re-selecting the same file later
  if(!file) return;
  showMessage("Reading " + file.name + "...", "ok");
  var reader = new FileReader();
  reader.onload = function(evt){ ingestText(evt.target.result, "file", file.name); };
  reader.onerror = function(){ showMessage("That file couldn't be read. Try saving it again as CSV.", "error"); };
  reader.readAsText(file);
});

document.getElementById("clearAllBtn").addEventListener("click", function(){
  agencies = [];
  clearSession();
  clearMeta();
  refreshFilterOptions();
  renderTable();
  renderMarkers();
  showMessage(null);
  renderFreshness();
});

/* ---------- reference pin ---------- */
document.getElementById("addRefBtn").addEventListener("click", async function(){
  var raw = document.getElementById("refInput").value.trim();
  if(!raw) return;
  var btn = this;

  // A ZIP or a California city resolves from the built-in tables with no
  // network call. Anything else is a street address, which needs a geocoder.
  var point = lookupZip(raw) || lookupPlace(stripStateSuffix(raw));
  if(!point){
    btn.disabled = true;
    showProgress("Looking up that address...");
    try{
      point = await geocodeAddress(raw);
    }catch(e){
      showProgress(null);
      btn.disabled = false;
      showMessage("The address lookup service didn't respond (" + e.message +
        "). A California city or 5-digit ZIP works without it.", "error");
      return;
    }
    showProgress(null);
    btn.disabled = false;
  }

  if(!point){
    showMessage("That reference location wasn't found. Try a California city, a 5-digit ZIP, or a fuller street address.", "error");
    return;
  }

  reference = { lat: point.lat, lng: point.lng };
  if(map){
    if(refMarker) map.removeLayer(refMarker);
    refMarker = L.marker([reference.lat, reference.lng], { icon: refIcon() }).addTo(map);
    refMarker.bindTooltip("<b>Reference point</b>", { direction: "top" });
  }
  recomputeDistances();
  sortState = { key: "distance", dir: 1 };
  renderHead();
  renderTable();
  renderMarkers();
  saveView();
  showMessage(null);
});

document.getElementById("clearRefBtn").addEventListener("click", function(){
  reference = null;
  if(refMarker && map){ map.removeLayer(refMarker); refMarker = null; }
  document.getElementById("refInput").value = "";
  recomputeDistances();
  renderTable();
  renderMarkers();
  saveView();
});

/* ---------- CSV export ---------- */
function csvField(v){
  var s = v === undefined || v === null ? "" : String(v);
  if(/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function downloadFile(text, filename){
  var blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}
document.getElementById("csvBtn").addEventListener("click", function(){
  var headers = ["Facility Number","Facility","Licensee","Administrator","Phone","Address","City","County","ZIP",
    "Licensed Beds","Facility Type","Status","Licensed Since","Last Visit","Inspection Visits","Complaint Visits",
    "Other Visits","Total Visits","Complaints","Total Allegations","Substantiated Allegations","Type A","Type B",
    "Citation Count","Citation Numbers","Distance (mi)","Lat","Lng","Location Source"];
  var lines = [headers.join(",")];
  sortRecords(getFilteredAgencies()).forEach(function(r){
    lines.push([
      r.facilityNumber, r.name, r.licensee, r.administrator, r.phone, r.address, r.city, r.county, r.zip,
      r.capacity || "", r.isCcrc ? "Continuing care community" : "Residential care, elderly",
      titleCase(r.status), r.licenseDate, r.lastVisitDate, r.inspectionVisits, r.complaintVisits, r.otherVisits,
      r.totalVisits, r.complaints, r.allegations, r.substantiated, r.typeA, r.typeB, r.citations, r.citationText,
      r.distance != null ? r.distance.toFixed(1) : "",
      r.lat != null ? r.lat : "", r.lng != null ? r.lng : "",
      LOCATION_SOURCE_LABEL[r.geoSource] || "Not located"
    ].map(csvField).join(","));
  });
  downloadFile(lines.join("\n"), DS.exportFile);
});

/* ---------- print ---------- */
document.getElementById("printBtn").addEventListener("click", function(){ window.print(); });
window.addEventListener("beforeprint", function(){ if(map) map.invalidateSize(); });

/* ---------- client demand: Census overlay and market panel ----------
   Data and county shapes load from the shared modules in /data/. Every figure
   carries a coefficient of variation from the published margin of error. */
var DEMAND_MEASURES = {
  a65: { label: "Residents 65 and over", short: "65+",
         share: function(d){ return d.p ? d.a65[0] / d.p : null; }, shareOf: "of all residents" },
  a75: { label: "Residents 75 and over", short: "75+",
         share: function(d){ return d.p ? d.a75[0] / d.p : null; }, shareOf: "of all residents" },
  a85: { label: "Residents 85 and over", short: "85+",
         share: function(d){ return d.p ? d.a85[0] / d.p : null; }, shareOf: "of all residents" },
  al:  { label: "Residents 65+ living alone", short: "living alone",
         share: function(d){ return d.alB ? d.al[0] / d.alB : null; }, shareOf: "of residents 65+" },
  il:  { label: "Residents 65+ with an independent living difficulty", short: "independent living difficulty",
         share: function(d){ return d.ilB ? d.il[0] / d.ilB : null; }, shareOf: "of residents 65+" },
  "in":{ label: "Median household income, householder 65+", short: "median income", money: true,
         share: function(d){ return d["in"][0]; } }
};

// Light to dark blue-violet, chosen to sit under the green, yellow and red pins
// without being mistaken for them. Circles use a darker run of the same hue,
// because a small dot in the light shades disappears against the tan basemap.
var DEMAND_COLORS = ["#eef0fb", "#c7cdf0", "#9ca7e3", "#6c7acf", "#3f4fb3"];
var CIRCLE_COLORS = ["#b3bdf0", "#8a98e0", "#6474cf", "#4152b6", "#26338f"];

var demandPane = null;
var demandLayer = null;
var countyByName = {};
COUNTY_SHAPES.features.forEach(function(f){ countyByName[f.properties.n.toUpperCase()] = f.properties.f; });

function reliabilityOf(cv){
  if(cv === null || cv === undefined) return { key: "low", label: "Low reliability: no margin of error could be computed" };
  if(cv > 30) return { key: "low", label: "Low reliability: the margin of error is large relative to the estimate" };
  if(cv > 15) return { key: "caution", label: "Use with caution: moderate margin of error" };
  return { key: "ok", label: "Reliable" };
}

function fmtCount(n){ return n === null || n === undefined ? "n/a" : Math.round(n).toLocaleString("en-US"); }
function fmtPct(x){ return x === null || x === undefined || !isFinite(x) ? "n/a" : (x * 100).toFixed(1) + "%"; }
function fmtMoney(x){ return x === null || x === undefined ? "n/a" : "$" + Math.round(x).toLocaleString("en-US"); }

// Quantile breaks across every geography of one level, so colors stay put as
// the operator filters.
function breaksFor(level, key){
  var m = DEMAND_MEASURES[key];
  var vals = [];
  var set = DEMAND[level];
  Object.keys(set).forEach(function(k){
    var v = m.share(set[k]);
    if(v !== null && v !== undefined && isFinite(v)) vals.push(v);
  });
  vals.sort(function(a, b){ return a - b; });
  var out = [];
  for(var i = 1; i < 5; i++) out.push(vals[Math.floor(vals.length * i / 5)]);
  return out;
}
function classOf(v, breaks){
  if(v === null || v === undefined || !isFinite(v)) return -1;
  for(var i = 0; i < breaks.length; i++) if(v < breaks[i]) return i;
  return breaks.length;
}
function fmtValue(key, v){ return DEMAND_MEASURES[key].money ? fmtMoney(v) : fmtPct(v); }

function demandTooltip(name, d, key){
  var m = DEMAND_MEASURES[key];
  var rel = reliabilityOf(d[key][1]);
  var lines = ["<b>" + escapeHtml(name) + "</b>"];
  if(m.money){
    lines.push(m.label + ": " + fmtMoney(d[key][0]));
  }else{
    lines.push(m.label + ": " + fmtCount(d[key][0]));
    lines.push(fmtPct(m.share(d)) + " " + m.shareOf);
  }
  lines.push('<span style="color:' + (rel.key === "ok" ? "#2e7d32" : rel.key === "caution" ? "#a9750a" : "#c62828") + '">' + rel.label + "</span>");
  return '<div class="map-tooltip">' + lines.join("<br>") + "</div>";
}

function initDemand(){
  if(!map) return;
  // Its own pane, below the facility pins, so the overlay never covers them.
  demandPane = map.createPane("demand");
  demandPane.style.zIndex = 350;
  document.getElementById("demandMeasure").addEventListener("change", function(){ drawDemand(); saveView(); });
  document.getElementById("demandGeo").addEventListener("change", function(){ drawDemand(); saveView(); });
}

function drawDemand(){
  if(!map) return;
  if(demandLayer){ map.removeLayer(demandLayer); demandLayer = null; }
  var key = document.getElementById("demandMeasure").value;
  var level = document.getElementById("demandGeo").value;
  var legend = document.getElementById("demandLegend");
  if(!key){ legend.innerHTML = ""; legend.style.display = "none"; return; }

  var m = DEMAND_MEASURES[key];
  var breaks = breaksFor(level, key);

  if(level === "county"){
    demandLayer = L.geoJSON(COUNTY_SHAPES, {
      pane: "demand",
      style: function(f){
        var d = DEMAND.county[f.properties.f];
        var c = d ? classOf(m.share(d), breaks) : -1;
        var rel = d ? reliabilityOf(d[key][1]).key : "low";
        return { color: "#5b6170", weight: 0.8, fillColor: c < 0 ? "#dddddd" : DEMAND_COLORS[c],
                 fillOpacity: rel === "ok" ? 0.55 : 0.3, dashArray: rel === "ok" ? null : "4 3" };
      },
      onEachFeature: function(f, layer){
        var d = DEMAND.county[f.properties.f];
        if(d) layer.bindTooltip(demandTooltip(f.properties.n + " County", d, key), { sticky: true });
        // Clicking a county filters to it, the same way a city pin does.
        layer.on("click", function(){
          var name = titleCase(f.properties.n);
          var present = agencies.some(function(r){ return r.county === name; });
          if(!present) return;
          countyFilterUI.setOnly(name);
          onFilterChange();
        });
      }
    }).addTo(map);
  }else{
    demandLayer = L.layerGroup();
    Object.keys(DEMAND.zip).forEach(function(z){
      var d = DEMAND.zip[z];
      var at = CA_ZIP[z];
      if(!at) return;
      var c = classOf(m.share(d), breaks);
      var rel = reliabilityOf(d[key][1]).key;
      var color = c < 0 ? "#999999" : CIRCLE_COLORS[c];
      // Reliable: solid. Caution: half-filled. Low: an empty gray dashed ring
      // with no class color at all, since the estimate is too uncertain to rank.
      var style = rel === "ok"
        ? { radius: 7, weight: 1.5, color: "#1f2533", fillColor: color, fillOpacity: 0.92 }
        : rel === "caution"
          ? { radius: 7, weight: 1.5, color: "#1f2533", fillColor: color, fillOpacity: 0.5 }
          : { radius: 6, weight: 1.5, color: "#5b6170", fillOpacity: 0, dashArray: "3 2" };
      style.pane = "demand";
      L.circleMarker([at.lat, at.lng], style)
        .bindTooltip(demandTooltip("ZIP " + z, d, key), { sticky: true })
        .addTo(demandLayer);
    });
    demandLayer.addTo(map);
  }

  // Legend: the classes with their ranges, then what the styling means.
  var lo = function(i){ return i === 0 ? null : breaks[i - 1]; };
  var html = '<div class="dl-title">' + m.label + (m.money ? "" : ", as a share " + m.shareOf) +
             (level === "zip" ? ", by ZIP code" : ", by county") + "</div><div class=\"dl-row\">";
  for(var i = 0; i < 5; i++){
    var a = lo(i), b = i < 4 ? breaks[i] : null;
    var range = a === null ? "under " + fmtValue(key, b) : b === null ? fmtValue(key, a) + " and up" : fmtValue(key, a) + " to " + fmtValue(key, b);
    html += '<span class="dl-key"><i style="background:' + (level === "zip" ? CIRCLE_COLORS[i] : DEMAND_COLORS[i]) +
            (level === "zip" ? ';border-radius:50%' : '') + '"></i>' + range + "</span>";
  }
  html += "</div>";
  html += level === "zip"
    ? '<div class="dl-note">Solid circles are reliable. Half-filled circles: use with caution. Empty gray dashed rings: too uncertain to rank; hover for the estimate.</div>'
    : '<div class="dl-note">Dashed outlines mark counties where the estimate is less reliable. Click a county to filter to it.</div>';
  html += '<div class="dl-note">Census Bureau, American Community Survey 2020 to 2024 5-year estimates.</div>';
  legend.innerHTML = html;
  legend.style.display = "block";
}

/* The market panel: demand for the selected counties set against what this
   tool counts in them. */
function sumMeasure(recs, key){
  var e = 0, m2 = 0, known = true;
  recs.forEach(function(d){
    var est = d[key][0], cv = d[key][1];
    if(est === null){ known = false; return; }
    e += est;
    if(cv === null) known = false;
    else { var moeVal = cv / 100 * 1.645 * est; m2 += moeVal * moeVal; }
  });
  var cv = (known && e > 0) ? Math.round((Math.sqrt(m2) / 1.645) / e * 100) : null;
  return [e, cv];
}

function renderMarketPanel(){
  var box = document.getElementById("marketPanel");
  if(!box) return;
  var chosen = Array.from(filterState.counties);
  if(!chosen.length){
    box.innerHTML = '<p class="file-hint">Select one or more counties in the County filter to see resident demand and how it compares with ' + DS.subjectPlural + ' there.</p>';
    return;
  }
  var recs = [], missing = [];
  chosen.forEach(function(name){
    var fips = countyByName[name.toUpperCase()];
    if(fips && DEMAND.county[fips]) recs.push(DEMAND.county[fips]);
    else missing.push(name);
  });
  if(!recs.length){
    box.innerHTML = '<p class="file-hint">No Census data for ' + escapeHtml(missing.join(", ")) + '. Records with a county of Out-of-state belong to licensees located outside California.</p>';
    return;
  }

  var agg = { p: recs.reduce(function(s, d){ return s + (d.p || 0); }, 0),
              alB: recs.reduce(function(s, d){ return s + (d.alB || 0); }, 0),
              ilB: recs.reduce(function(s, d){ return s + (d.ilB || 0); }, 0) };
  ["a65", "a75", "a85", "al", "il"].forEach(function(k){ agg[k] = sumMeasure(recs, k); });
  // A median cannot be combined across counties, so it is shown for one only.
  agg["in"] = recs.length === 1 ? recs[0]["in"] : [null, null];

  var title = chosen.length === 1 ? chosen[0] + " County" : chosen.length + " counties";
  var rows = [["Total residents", fmtCount(agg.p), "", null]];
  ["a65", "a75", "a85", "al", "il"].forEach(function(k){
    var m = DEMAND_MEASURES[k];
    rows.push([m.label, fmtCount(agg[k][0]), fmtPct(m.share(agg)) + " " + m.shareOf, agg[k][1]]);
  });
  rows.push([DEMAND_MEASURES["in"].label, recs.length === 1 ? fmtMoney(agg["in"][0]) : "n/a",
             recs.length === 1 ? "" : "not combinable across counties", recs.length === 1 ? agg["in"][1] : undefined]);

  var html = '<div class="mp-grid"><div><h3 class="mp-h">' + escapeHtml(title) + '</h3><table class="mp-table"><tbody>';
  rows.forEach(function(r){
    var rel = r[3] === undefined || r[0] === "Total residents" ? null : reliabilityOf(r[3]);
    html += "<tr><td>" + r[0] + '</td><td class="num">' + r[1] + "</td><td>" + r[2] +
      (rel && rel.key !== "ok" ? ' <span class="mp-flag ' + rel.key + '">' + (rel.key === "low" ? "low reliability" : "use with caution") + "</span>" : "") +
      "</td></tr>";
  });
  html += "</tbody></table></div>";

  // Ratios use the records matching the operator's current filters, so a
  // size or citation filter narrows the comparison on purpose.
  var covered = chosen.filter(function(n){ return missing.indexOf(n) === -1; });
  var inCounties = getFilteredAgencies().filter(function(r){ return covered.indexOf(r.county) !== -1; });
  html += '<div><h3 class="mp-h">Against ' + inCounties.length.toLocaleString("en-US") + " " +
          (inCounties.length === 1 ? DS.subjectSingular : DS.subjectPlural) + " matching your filters</h3>";
  if(!inCounties.length){
    html += '<p class="file-hint">No ' + DS.subjectPlural + ' match the current filters here, so no ratios can be computed.</p>';
  }else{
    html += '<table class="mp-table"><tbody>';
    DS.ratios(agg, inCounties).forEach(function(r){
      html += "<tr><td>" + r[0] + '</td><td class="num mp-big">' + r[1] + "</td></tr>";
    });
    html += "</tbody></table>";
    if(missing.length) html += '<p class="file-hint">Left out of the ratios: ' + escapeHtml(missing.join(", ")) + ", which has no Census data.</p>";
  }
  html += "</div></div>";
  html += '<p class="file-hint mp-src">Resident figures: U.S. Census Bureau, American Community Survey 2020 to 2024 5-year estimates, tables B01001, B09020, B18107 and B19049. Reliability from the published margins of error.</p>';
  box.innerHTML = html;
}

/* Switching datasets parks the current session and restores the other one.
   Each dataset keeps its own records, view and address cache, so moving
   between them never mixes their data. */
async function setDataset(key){
  if(DS.key === key) return;
  saveView();
  DS = DATASETS[key];
  META_KEY = DS.prefix + "_meta";
  addrCache = makeCache(DS.prefix + "_addr");
  agencies = [];
  reference = reference;   // the reference pin is shared on purpose
  filterState.counties.clear(); filterState.cities.clear();
  filterState.severities.clear(); filterState.statuses.clear();
  filterState.bands.clear(); filterState.types.clear();
  filterState.search = "";
  document.getElementById("searchInput").value = "";
  COLUMNS = buildColumns();
  sortState = { key: "name", dir: 1 };
  applyDatasetUi();
  refreshFilterOptions();
  renderHead();
  renderTable();
  renderMarkers();
  showMessage(null);
  await restoreSession();
  renderFreshness();
  drawDemand();
}
document.querySelectorAll("[data-ds]").forEach(function(el){
  el.addEventListener("click", function(){ setDataset(el.getAttribute("data-ds")); });
});

/* ---------- init ---------- */
try{
  if(typeof L === "undefined") throw new Error("The Leaflet map library did not load.");
  initMap();
  initDemand();
}catch(e){
  var errEl = document.getElementById("mapError");
  errEl.style.display = "block";
  errEl.textContent = "The map couldn't start (" + e.message + "). The agency list and CSV export below still work; try reloading, or opening this file in a different browser.";
}
META_KEY = DS.prefix + "_meta";
addrCache = makeCache(DS.prefix + "_addr");
COLUMNS = buildColumns();
applyDatasetUi();
renderHead();
renderTable();
refreshFilterOptions();
// Reading a saved session is asynchronous because it is decompressed on the
// way in. Paint the empty state first, then fill it once the session arrives.
restoreSession().then(function(){
  renderFreshness();
  drawDemand();
});
})();
