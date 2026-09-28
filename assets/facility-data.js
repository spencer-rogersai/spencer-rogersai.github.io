/* ---------- shared facility data ----------
   The CSV reader, the dataset declarations and the parser live here because
   more than one page reads these files. Keeping one copy is what stops a
   reader correction from having to be made twice, which has happened before
   in this project.

   parseFacilityFile takes options so each page gets what it needs: the map
   wants coordinates and skips closed records, while the trends page wants
   closed records and their closing dates and needs no coordinates at all. */

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
  }
};

var DS = DATASETS.rcfe;   // the page sets this

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
function parseFacilityFile(text, cfg, options){
  options = options || {};
  var includeClosed = !!options.includeClosed;      // the trends page needs them
  var lookupPoint = options.locate || null;         // the map needs coordinates
  var addrLookup = options.addrLookup || null;
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
    if(!OPEN_STATUSES[status]){
      skippedClosed++;
      if(!includeClosed) continue;
    }

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
    var exact = addrLookup ? addrLookup(facilityNumber) : null;
    var point = exact ? { lat: exact.lat, lng: exact.lng, source: "address" }
              : (lookupPoint ? lookupPoint(city, zip) : null);
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
      closedDate: get(cells, "closed date"),
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

