
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

/* Coordinates for the rare record without published latitude and longitude
   come from the shared gazetteer module. */
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


/* A reference address is a single lookup rather than a bulk one, so the
   embedded tables are tried first (they cover any California ZIP or city
   instantly and offline) and a geocoding service is only contacted for a full
   street address, which the tables can't resolve. */
var geoCache = makeCache("cdphmap_ref");

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

/* ---------- CDPH health facility roster parser ----------
   This roster is the easy one to place: it ships LATITUDE and LONGITUDE for
   every record but one, so nothing is geocoded at load and every pin sits at
   the facility's real coordinates rather than a ZIP center. The built-in
   gazetteer tables stay in the file only to resolve a reference location and
   to catch the occasional record with no coordinates.

   It carries no citation or inspection data at all, which suits a referral
   list: what matters here is who exists, what kind of facility they are, and
   how to reach them. */
var REQUIRED_HEADERS = ["facid", "facname", "fac_fdr", "city", "county_name"];

// The roster uses 21 facility descriptions. Mapped onto six families so the
// map carries a legend a person can actually hold in their head; the full
// 21-way list stays available as its own filter.
var TYPE_FAMILIES = [
  { key: "inhome",   label: "In-home care",        color: "#14746f" },
  { key: "facility", label: "Residential and LTC", color: "#6a3d9a" },
  { key: "hospital", label: "Hospitals",           color: "#b3261e" },
  { key: "clinic",   label: "Clinics and outpatient", color: "#1f6feb" },
  { key: "day",      label: "Day programs",        color: "#c77700" },
  { key: "other",    label: "Other",               color: "#6b6156" }
];
var FAMILY_BY_TYPE = {
  "HOME HEALTH AGENCY": "inhome",
  "HOSPICE": "inhome",
  "REFERRAL AGENCY": "inhome",
  "SKILLED NURSING FACILITY": "facility",
  "INTERMEDIATE CARE FACILITY": "facility",
  "INTERMEDIATE CARE FACILITY-DD/H/N/CN/IID": "facility",
  "CONGREGATE LIVING HEALTH FACILITY": "facility",
  "HOSPICE FACILITY": "facility",
  "PEDIATRIC DAY HEALTH & RESPITE CARE FACILITY": "facility",
  "GENERAL ACUTE CARE HOSPITAL": "hospital",
  "ACUTE PSYCHIATRIC HOSPITAL": "hospital",
  "CHEMICAL DEPENDENCY RECOVERY HOSPITAL": "hospital",
  "CORRECTIONAL TREATMENT CENTER": "hospital",
  "PRIMARY CARE CLINIC": "clinic",
  "SURGICAL CLINIC": "clinic",
  "CHRONIC DIALYSIS CLINIC": "clinic",
  "REHABILITATION CLINIC": "clinic",
  "PSYCHOLOGY CLINIC": "clinic",
  "ALTERNATIVE BIRTHING CENTER": "clinic",
  "ADULT DAY HEALTH CARE": "day",
  "OTHER": "other"
};
function familyOf(rec){ return FAMILY_BY_TYPE[String(rec.facTypeRaw || "").toUpperCase()] || "other"; }
function familyLabel(key){
  for(var i = 0; i < TYPE_FAMILIES.length; i++) if(TYPE_FAMILIES[i].key === key) return TYPE_FAMILIES[i].label;
  return key;
}
function familyHex(key){
  for(var i = 0; i < TYPE_FAMILIES.length; i++) if(TYPE_FAMILIES[i].key === key) return TYPE_FAMILIES[i].color;
  return "#6b6156";
}

function parseCdphFile(text){
  var rows = parseCsv(text);
  if(rows.length < 2) return { error: "That file has no data rows. Upload the CDPH health facility roster as a CSV." };

  var header = rows[0].map(normalizeKey);
  var idx = {};
  header.forEach(function(h, i){ if(idx[h] === undefined) idx[h] = i; });

  var missing = REQUIRED_HEADERS.filter(function(h){ return idx[h] === undefined; });
  if(missing.length){
    return { error: "This doesn't look like the CDPH health facility roster. Missing column" +
      (missing.length === 1 ? "" : "s") + ": " + missing.join(", ") + "." };
  }

  function get(cells, name){
    var i = idx[name];
    return (i !== undefined && cells[i] != null) ? String(cells[i]).trim() : "";
  }

  var records = [], skippedNoCity = 0, noCoords = 0;
  var dataDate = "";

  for(var r = 1; r < rows.length; r++){
    var cells = rows[r];
    if(cells.length < header.length) continue;

    if(!dataDate) dataDate = get(cells, "data_date");
    var city = get(cells, "city");
    if(!city){ skippedNoCity++; continue; }

    var lat = parseFloat(get(cells, "latitude"));
    var lng = parseFloat(get(cells, "longitude"));
    var geoSource = "address";
    if(isNaN(lat) || isNaN(lng)){
      // Fall back to the built-in tables for the rare record with no coordinates.
      var point = locate(city, get(cells, "zip"));
      if(point){ lat = point.lat; lng = point.lng; geoSource = point.source; }
      else { lat = null; lng = null; geoSource = ""; }
      noCoords++;
    }

    var facTypeRaw = get(cells, "fac_fdr");
    var rec = {
      id: nextId(),
      facilityNumber: get(cells, "facid"),
      name: titleCase(get(cells, "facname")),
      businessName: titleCase(get(cells, "business_name")),
      administrator: titleCase(get(cells, "facadmin")),
      phone: get(cells, "contact_phone_number"),
      fax: get(cells, "contact_fax"),
      email: get(cells, "contact_email").toLowerCase(),
      address: titleCase(get(cells, "address")),
      city: titleCase(city),
      cityKey: city.toUpperCase(),
      state: "CA",
      zip: get(cells, "zip"),
      county: titleCase(get(cells, "county_name")),
      facTypeRaw: facTypeRaw,
      facType: titleCase(facTypeRaw),
      facTypeCode: get(cells, "fac_type_code"),
      capacity: toInt(get(cells, "capacity")),
      isLtc: get(cells, "ltc").toUpperCase() === "LTC",
      isMain: get(cells, "isfacmain").toUpperCase() !== "N",
      licenseStatus: get(cells, "license_status_description").toUpperCase(),
      licensure: get(cells, "licensed_certified"),
      entityType: titleCase(get(cells, "entity_type_description")),
      licenseNumber: get(cells, "license_number"),
      npi: get(cells, "npi"),
      initialLicenseDate: get(cells, "initial_license_date"),
      licenseExpiration: get(cells, "license_expiration_date"),
      lat: lat, lng: lng,
      geoSource: geoSource,
      distance: null,
      geoStatus: lat == null ? "Unmapped" : "Mapped"
    };
    rec.family = familyOf(rec);
    records.push(rec);
  }

  if(!records.length) return { error: "No facilities found in that file." };
  return { records: records, skippedNoCity: skippedNoCity, noCoords: noCoords, dataDate: dataDate };
}

/* ---------- application state ---------- */
var agencies = [];
var reference = null;
var map, refMarker;
var cityMarkers = {};
var filterState = { counties: new Set(), cities: new Set(), families: new Set(), types: new Set(),
  statuses: new Set(), scope: new Set(), contact: new Set(), search: "" };
var sortState = { key: "name", dir: 1 };
var MAX_TABLE_ROWS = 400;

/* ---------- columns ---------- */
function mailtoCell(addr){
  if(!addr) return "";
  return '<a href="mailto:' + escapeHtml(addr) + '" class="lead-link">' + escapeHtml(addr) + "</a>";
}
function telCell(num){
  if(!num) return "";
  return '<a href="tel:' + escapeHtml(num.replace(/[^0-9+]/g, "")) + '" class="lead-link">' + escapeHtml(num) + "</a>";
}

var COLUMNS = [
  { key: "name", label: "Facility", sort: function(r){ return r.name; },
    cell: function(r){
      return '<div class="agency-name"><span class="sev-dot" style="background:' + familyHex(r.family) + '"></span>' +
        escapeHtml(r.name) + (r.isMain ? "" : ' <span class="type-tag">SATELLITE</span>') + "</div>" +
        (r.businessName && r.businessName !== r.name ? '<div class="agency-sub">' + escapeHtml(r.businessName) + "</div>" : "") +
        (r.address ? '<div class="agency-sub">' + escapeHtml(r.address) + "</div>" : "");
    } },
  { key: "facType", label: "Type", sort: function(r){ return r.facType; }, cell: function(r){ return escapeHtml(r.facType); } },
  { key: "phone", label: "Phone", sort: function(r){ return r.phone; }, cell: function(r){ return telCell(r.phone); } },
  { key: "email", label: "Email", sort: function(r){ return r.email; }, cell: function(r){ return mailtoCell(r.email); } },
  { key: "administrator", label: "Administrator", sort: function(r){ return r.administrator; }, cell: function(r){ return escapeHtml(r.administrator); } },
  { key: "city", label: "City", sort: function(r){ return r.city; }, cell: function(r){ return escapeHtml(r.city); } },
  { key: "county", label: "County", sort: function(r){ return r.county; }, cell: function(r){ return escapeHtml(r.county); } },
  { key: "zip", label: "ZIP", sort: function(r){ return r.zip; }, cell: function(r){ return escapeHtml(r.zip); } },
  { key: "distance", label: "Distance", num: true, sort: function(r){ return r.distance == null ? Infinity : r.distance; },
    cell: function(r){ return r.distance != null ? r.distance.toFixed(1) + " mi" : ""; } },
  { key: "capacity", label: "Beds", num: true, sort: function(r){ return r.capacity; },
    cell: function(r){ return r.capacity || ""; } },
  { key: "licenseStatus", label: "License", sort: function(r){ return r.licenseStatus; },
    cell: function(r){
      if(!r.licenseStatus) return '<span class="pill pill-pending">Not stated</span>';
      return '<span class="pill ' + (r.licenseStatus === "ACTIVE" ? "pill-licensed" : "pill-nogeo") + '">' + titleCase(r.licenseStatus) + "</span>";
    } },
  { key: "entityType", label: "Entity", sort: function(r){ return r.entityType; }, cell: function(r){ return escapeHtml(r.entityType); } },
  { key: "initialLicenseDate", label: "Licensed", sort: function(r){ var v = dateValue(r.initialLicenseDate); return v == null ? -Infinity : v; },
    cell: function(r){ return escapeHtml(r.initialLicenseDate); } }
];

/* ---------- filtering ---------- */
function matchesSearch(rec, term){
  if(!term) return true;
  return (rec.name + " " + rec.businessName + " " + rec.administrator + " " + rec.address + " " +
          rec.city + " " + rec.zip + " " + rec.phone + " " + rec.email + " " +
          rec.facType + " " + rec.facilityNumber).toLowerCase().indexOf(term) !== -1;
}

function getFilteredAgencies(){
  var term = filterState.search.trim().toLowerCase();
  return agencies.filter(function(rec){
    if(filterState.counties.size && !filterState.counties.has(rec.county)) return false;
    if(filterState.cities.size && !filterState.cities.has(rec.city)) return false;
    if(filterState.families.size && !filterState.families.has(rec.family)) return false;
    if(filterState.types.size && !filterState.types.has(rec.facType)) return false;
    if(filterState.statuses.size && !filterState.statuses.has(rec.licenseStatus || "NOT STATED")) return false;
    if(filterState.scope.size){
      if(filterState.scope.has("main") && !filterState.scope.has("satellite") && !rec.isMain) return false;
      if(filterState.scope.has("satellite") && !filterState.scope.has("main") && rec.isMain) return false;
    }
    if(filterState.contact.size){
      if(filterState.contact.has("phone") && !rec.phone) return false;
      if(filterState.contact.has("email") && !rec.email) return false;
      if(filterState.contact.has("admin") && !rec.administrator) return false;
    }
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

var familyFilterUI = makeMultiSelect("familyFilter", filterState.families,
  function(){
    var present = {};
    agencies.forEach(function(r){ present[r.family] = true; });
    return TYPE_FAMILIES.map(function(f){ return f.key; }).filter(function(k){ return present[k]; });
  },
  familyLabel, "All categories", onFilterChange, false);

var typeFilterUI = makeMultiSelect("typeFilter", filterState.types,
  function(){ return distinct(function(r){ return r.facType; }); },
  function(v){ return v; }, "All types", onFilterChange, true);

var statusFilterUI = makeMultiSelect("statusFilter", filterState.statuses,
  function(){ return Array.from(new Set(agencies.map(function(r){ return r.licenseStatus || "NOT STATED"; }))).sort(); },
  function(v){ return titleCase(v); }, "All licenses", onFilterChange, false);

var scopeFilterUI = makeMultiSelect("scopeFilter", filterState.scope,
  function(){
    var out = [];
    if(agencies.some(function(r){ return r.isMain; })) out.push("main");
    if(agencies.some(function(r){ return !r.isMain; })) out.push("satellite");
    return out;
  },
  function(v){ return v === "main" ? "Main facilities" : "Satellite locations"; },
  "Main and satellite", onFilterChange, false);

// A lead list is only as good as its contact data, so these are filters in
// their own right rather than something to find by scrolling the table.
var contactFilterUI = makeMultiSelect("contactFilter", filterState.contact,
  function(){ return ["phone", "email", "admin"]; },
  function(v){ return v === "phone" ? "Has phone" : v === "email" ? "Has email" : "Has administrator"; },
  "Any contact info", onFilterChange, false);

function refreshFilterOptions(){
  countyFilterUI.refresh();
  cityFilterUI.refresh();
  familyFilterUI.refresh();
  typeFilterUI.refresh();
  statusFilterUI.refresh();
  scopeFilterUI.refresh();
  contactFilterUI.refresh();
}

function onFilterChange(){
  renderTable();
  renderMarkers();
  saveView();
}

document.getElementById("clearFiltersBtn").addEventListener("click", function(){
  filterState.counties.clear();
  filterState.cities.clear();
  filterState.families.clear();
  filterState.types.clear();
  filterState.statuses.clear();
  filterState.scope.clear();
  filterState.contact.clear();
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

function clusterIcon(count, family){
  var size = count >= 100 ? 44 : count >= 50 ? 38 : count >= 10 ? 32 : 26;
  var font = size >= 38 ? 13 : size >= 32 ? 12 : 11;
  var html = '<div class="cluster-pin" style="width:' + size + "px;height:" + size + "px;background:" +
    familyHex(family) + ";font-size:" + font + 'px;">' + count + "</div>";
  return L.divIcon({ html: html, className: "", iconSize: [size, size], iconAnchor: [size/2, size/2] });
}

function refIcon(){
  return L.divIcon({ html: '<div class="ref-pin"></div>', className: "", iconSize: [18,16], iconAnchor: [9,16] });
}

function clusterTooltip(group){
  var counts = {};
  group.records.forEach(function(r){ counts[r.family] = (counts[r.family] || 0) + 1; });
  var lines = ["<b>" + escapeHtml(group.city) + (group.county ? ", " + escapeHtml(group.county) + " County" : "") + "</b>"];
  lines.push(group.records.length + " facilit" + (group.records.length === 1 ? "y" : "ies"));
  TYPE_FAMILIES.forEach(function(f){
    if(counts[f.key]) lines.push('<span style="color:' + f.color + '">&#9679;</span> ' + counts[f.key] + " " + f.label.toLowerCase());
  });
  var withPhone = group.records.filter(function(r){ return r.phone; }).length;
  lines.push(withPhone + " with a phone number");
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
  var html = '<div class="agency-pin" style="width:12px;height:12px;background:' +
    familyHex(rec.family) + ';"></div>';
  return L.divIcon({ html: html, className: "", iconSize: [12,12], iconAnchor: [6,6] });
}

function agencyTooltip(rec){
  var lines = ["<b>" + escapeHtml(rec.name) + "</b>"];
  lines.push('<span class="tip-type">' + escapeHtml(rec.facType) + (rec.isMain ? "" : " (satellite)") + "</span>");
  if(rec.address) lines.push(escapeHtml(rec.address));
  lines.push(escapeHtml(rec.city) + ", " + escapeHtml(rec.zip));
  // Phone is the point of this tool, so it is always shown, and its absence is
  // stated rather than left as a silent gap in the card.
  lines.push(rec.phone ? '<b class="tip-phone">' + escapeHtml(rec.phone) + "</b>" : '<span class="tip-missing">No phone on file</span>');
  if(rec.email) lines.push(escapeHtml(rec.email));
  if(rec.administrator) lines.push("Admin: " + escapeHtml(rec.administrator));
  if(rec.capacity) lines.push(rec.capacity + " licensed beds");
  if(rec.distance != null) lines.push(rec.distance.toFixed(1) + " mi from reference");
  return '<div class="map-tooltip">' + lines.join("<br>") + "</div>";
}

// Drawing every facility individually is only readable once the list is
// narrowed. Past this many, the city view is used regardless of the setting.
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
    legend.textContent = "One pin per facility, at its own coordinates. Color shows the category.";
    return;
  }

  legend.textContent = wantAgencyPins
    ? "Showing one pin per city: " + filtered.length.toLocaleString() + " facilities is too many to draw individually. Filter below " + MAX_INDIVIDUAL_PINS + " to see each one."
    : "Pin number is the facility count in that city. Color shows the most common category there.";

  var groups = groupByCity(filtered);
  var bounds = [];
  Object.keys(groups).forEach(function(key){
    var group = groups[key];
    // A city pin takes the colour of whichever category is most common there;
    // the tooltip carries the full breakdown.
    var counts = {}, top = "other", best = 0;
    group.records.forEach(function(r){
      counts[r.family] = (counts[r.family] || 0) + 1;
      if(counts[r.family] > best){ best = counts[r.family]; top = r.family; }
    });
    var marker = L.marker([group.lat, group.lng], { icon: clusterIcon(group.records.length, top) });
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
    (agencies.length === 0 ? "No facilities loaded yet. Upload the CDPH roster to start." : "No facilities match the current filters.") + "</td></tr>");

  var summary = document.getElementById("resultsSummary");
  summary.textContent = agencies.length === 0 ? "" :
    "Showing " + visible.length.toLocaleString() + " of " + agencies.length.toLocaleString() + " facilities";

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

/* ---------- saved session ----------
   The loaded list and the current view are kept in this browser so a refresh
   picks up where it left off. Records are written as plain arrays in a fixed
   field order rather than objects: the same 2,762 agencies cost about 670 KB
   that way versus 1.5 MB as named fields, which keeps a full CDSS file well
   inside the storage a browser allows. The two are split across separate keys
   because view state changes on every filter click while the record set only
   changes when a file is loaded. */
var SESSION_VERSION = 1;
var RECORD_FIELDS = ["facilityNumber","name","businessName","administrator","phone","fax","email",
  "address","city","zip","county","facTypeRaw","facTypeCode","capacity","isLtc","isMain",
  "licenseStatus","licensure","entityType","licenseNumber","npi","initialLicenseDate",
  "licenseExpiration","lat","lng","geoSource"];

// At 15,040 records the plain form runs about 5.5 MB, just past what browsers
// allow. City, county, facility type and entity type repeat constantly across
// the roster, so those columns are stored as an index into a lookup table
// instead of a repeated string. That brings the same data to roughly 4.1 MB
// with every field intact.
var DICT_FIELDS = { city: 1, county: 1, facTypeRaw: 1, facTypeCode: 1, entityType: 1,
  licensure: 1, licenseStatus: 1 };

function encodeRecords(list){
  var dicts = {}, maps = {};
  Object.keys(DICT_FIELDS).forEach(function(f){ dicts[f] = []; maps[f] = {}; });
  var rows = list.map(function(rec){
    return RECORD_FIELDS.map(function(f){
      var v = rec[f] == null ? "" : rec[f];
      if(DICT_FIELDS[f]){
        var key = String(v);
        if(maps[f][key] === undefined){ maps[f][key] = dicts[f].length; dicts[f].push(key); }
        return maps[f][key];
      }
      return v;
    });
  });
  return { d: dicts, r: rows };
}

function decodeRecords(raw){
  var rows = raw && raw.r ? raw.r : (raw || []);
  var dicts = (raw && raw.d) || {};
  return rows.map(function(cells){
    var rec = { id: nextId() };
    RECORD_FIELDS.forEach(function(f, i){
      var v = cells[i];
      if(DICT_FIELDS[f] && dicts[f] && typeof v === "number") v = dicts[f][v];
      rec[f] = v;
    });
    rec.lat = rec.lat === "" ? null : Number(rec.lat);
    rec.lng = rec.lng === "" ? null : Number(rec.lng);
    rec.capacity = Number(rec.capacity) || 0;
    rec.isLtc = rec.isLtc === true || rec.isLtc === "true" || rec.isLtc === 1;
    rec.isMain = rec.isMain === true || rec.isMain === "true" || rec.isMain === 1;
    rec.state = "CA";
    rec.facType = titleCase(rec.facTypeRaw);
    rec.family = familyOf(rec);
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
  writeSession("cdphmap_records", JSON.stringify({
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    records: encodeRecords(agencies)
  }), warnStorage);
}

function saveView(){
  try{
    writeSession("cdphmap_view", JSON.stringify({
      version: SESSION_VERSION,
      counties: Array.from(filterState.counties),
      cities: Array.from(filterState.cities),
      families: Array.from(filterState.families),
      types: Array.from(filterState.types),
      statuses: Array.from(filterState.statuses),
      scope: Array.from(filterState.scope),
      contact: Array.from(filterState.contact),
      search: filterState.search,
      sort: sortState,
      pinDetail: document.getElementById("pinDetail").value,
      reference: reference,
      referenceText: document.getElementById("refInput").value
    }));
  }catch(e){ /* view state is small and non-essential; a failure here is silent */ }
}

function clearSession(){
  try{
    localStorage.removeItem("cdphmap_records");
    localStorage.removeItem("cdphmap_view");
  }catch(e){}
}

async function restoreSession(){
  var recordsRaw, viewRaw;
  try{
    recordsRaw = JSON.parse((await readSession("cdphmap_records")) || "null");
    viewRaw = JSON.parse((await readSession("cdphmap_view")) || "null");
  }catch(e){ return false; }
  var storedRows = recordsRaw && recordsRaw.records ? (recordsRaw.records.r || recordsRaw.records) : null;
  if(!recordsRaw || recordsRaw.version !== SESSION_VERSION || !storedRows || !storedRows.length) return false;

  agencies = decodeRecords(recordsRaw.records);

  if(viewRaw && viewRaw.version === SESSION_VERSION){
    (viewRaw.counties || []).forEach(function(v){ filterState.counties.add(v); });
    (viewRaw.cities || []).forEach(function(v){ filterState.cities.add(v); });
    (viewRaw.families || []).forEach(function(v){ filterState.families.add(v); });
    (viewRaw.types || []).forEach(function(v){ filterState.types.add(v); });
    (viewRaw.statuses || []).forEach(function(v){ filterState.statuses.add(v); });
    (viewRaw.scope || []).forEach(function(v){ filterState.scope.add(v); });
    (viewRaw.contact || []).forEach(function(v){ filterState.contact.add(v); });
    filterState.search = viewRaw.search || "";
    document.getElementById("searchInput").value = filterState.search;
    if(viewRaw.sort && viewRaw.sort.key) sortState = viewRaw.sort;
    if(viewRaw.pinDetail) document.getElementById("pinDetail").value = viewRaw.pinDetail;
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
  var filtersOn = filterState.counties.size || filterState.cities.size || filterState.families.size ||
    filterState.types.size || filterState.statuses.size || filterState.scope.size ||
    filterState.contact.size || filterState.search;
  showMessage(agencies.length.toLocaleString() + " facilities restored from the file you" + when + "." +
    (filtersOn ? " Your filters were kept too." : ""), "ok");
  return true;
}

/* ---------- latest data and freshness ----------
   The tool can fetch its own source file. Both publishers answer browser
   requests with a header permitting cross-site downloads, so this needs no
   server. The CDPH roster is located through the state open data portal's documented
   public API, which names the current file before it is downloaded.

   Freshness is recorded separately from the records so that a later save,
   such as an address import, never resets it. */
var STALE_AFTER_DAYS = 7;
var META_KEY = "cdphmap_meta";
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
    ingestText(text, "download", SOURCE.fileLabel);
  }catch(e){
    showMessage("Couldn't download the latest data because " + e.message + ". Nothing has changed; your current data is still loaded. You can also download the file yourself and use Choose file.", "error");
  }
  btn.disabled = false;
}


function fetchCdph(){
  return fetchWithTimeout("https://data.chhs.ca.gov/api/3/action/package_show?id=healthcare-facility-locations")
    .then(function(res){ return res.json(); })
    .then(function(json){
      var list = (json && json.result && json.result.resources) || [];
      var hit = list.filter(function(r){ return /health_facility_locations\.csv$/i.test(r.url || ""); })[0];
      if(!hit) throw new Error("the portal no longer lists the facility locations file");
      return fetchWithTimeout(hit.url);
    })
    .then(function(res){ return res.text(); });
}
var SOURCE = {
  label: "the California open data portal",
  fileLabel: "CDPH portal download",
  fetch: fetchCdph
};

/* ---------- file load ---------- */
document.getElementById("csvUploadBtn").addEventListener("click", function(){
  document.getElementById("csvFileInput").click();
});

function ingestText(text, origin, name){
  var result = parseCdphFile(String(text || ""));
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

  var withPhone = agencies.filter(function(r){ return r.phone; }).length;
  var parts = [result.records.length.toLocaleString() + " facilities loaded"];
  parts.push(withPhone.toLocaleString() + " with a phone number");
  if(result.skippedNoCity) parts.push(result.skippedNoCity + " skipped with no city");
  if(result.noCoords) parts.push(result.noCoords + " had no coordinates and sit at their ZIP center");
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

// Ordered for a lead list: who they are and how to reach them first, the
// licensing detail after.
document.getElementById("csvBtn").addEventListener("click", function(){
  var headers = ["Facility","Facility Type","Category","Administrator","Phone","Email","Fax",
    "Address","City","County","ZIP","Distance (mi)","Business Name","Entity Type","Beds",
    "License Status","Licensure","License Number","NPI","Initial License Date","License Expiration",
    "Main or Satellite","Facility ID","Lat","Lng"];
  var lines = [headers.join(",")];
  sortRecords(getFilteredAgencies()).forEach(function(r){
    lines.push([
      r.name, r.facType, familyLabel(r.family), r.administrator, r.phone, r.email, r.fax,
      r.address, r.city, r.county, r.zip, r.distance != null ? r.distance.toFixed(1) : "",
      r.businessName, r.entityType, r.capacity || "",
      titleCase(r.licenseStatus) || "Not stated", r.licensure, r.licenseNumber, r.npi,
      r.initialLicenseDate, r.licenseExpiration,
      r.isMain ? "Main" : "Satellite", r.facilityNumber,
      r.lat != null ? r.lat : "", r.lng != null ? r.lng : ""
    ].map(csvField).join(","));
  });
  downloadFile(lines.join("\n"), "health-facility-leads.csv");
});

/* ---------- print ---------- */
document.getElementById("printBtn").addEventListener("click", function(){ window.print(); });
window.addEventListener("beforeprint", function(){ if(map) map.invalidateSize(); });

/* ---------- init ---------- */
try{
  if(typeof L === "undefined") throw new Error("The Leaflet map library did not load.");
  initMap();
}catch(e){
  var errEl = document.getElementById("mapError");
  errEl.style.display = "block";
  errEl.textContent = "The map couldn't start (" + e.message + "). The agency list and CSV export below still work; try reloading, or opening this file in a different browser.";
}
renderHead();
renderTable();
refreshFilterOptions();
// Reading a saved session is asynchronous because it is decompressed on the
// way in. Paint the empty state first, then fill it once the session arrives.
restoreSession().then(renderFreshness);
})();
