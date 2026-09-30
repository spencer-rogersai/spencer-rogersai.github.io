/* ---------- query catalog ----------
   Declaration only. Nothing here runs a query; the engine reads these tables
   and the builder draws its controls from them. Adding a field or a measure
   should mean adding an entry here and nothing else.

   Three tables:
     CATALOG.fields    what can be filtered, grouped or shown
     CATALOG.measures  what can be counted, summed or divided
     CATALOG.rules     the limits the source data imposes

   Two ideas the rest of the file leans on.

   Grain. A row in a report is a county, a ZIP, a city, or a single facility.
   Some fields and most ratio measures only make sense at some of those. A
   measure that cannot serve the chosen grain is disabled in the builder with
   its reason shown, rather than quietly returning nothing.

   Origin. A field is either parsed from the licensing export, attached at load
   from the demographic and labor tables, or computed from other fields. The
   origin decides where a missing value comes from and what to say about it. */

var CATALOG = (function(){
"use strict";

/* ---------- operators ----------
   The builder offers these by field type. An operator outside its type's list
   is a spec the engine should refuse rather than interpret. */
var TYPE_OPS = {
  // isAnyOf and isNoneOf belong on text as well as category. County, city,
  // licensee and name are text, and naming several of them in one condition is
  // the whole of the OR support this design offers.
  text:     ["is", "isNot", "isAnyOf", "isNoneOf", "contains", "startsWith", "isBlank"],
  category: ["isAnyOf", "isNoneOf"],
  number:   ["eq", "ne", "gt", "lt", "between", "isZero"],
  date:     ["before", "after", "between", "inLastYears", "isBlank"],
  boolean:  ["isTrue", "isFalse"],
  geo:      ["withinMiles"]
};

// is and isAnyOf accept a list of values. That is the whole of the OR support:
// several values on one field, never a condition tree.
var MULTI_VALUE_OPS = { is: true, isAnyOf: true, isNoneOf: true };

var OP_LABELS = {
  is: "is", isNot: "is not", contains: "contains", startsWith: "starts with",
  isBlank: "is blank", isAnyOf: "is any of", isNoneOf: "is none of",
  eq: "equals", ne: "does not equal", gt: "is more than", lt: "is less than",
  between: "is between", isZero: "is zero",
  before: "is before", after: "is after", inLastYears: "is within the last",
  isTrue: "yes", isFalse: "no", withinMiles: "is within"
};

var GRAINS = [
  { id: "county", label: "County", hasDemographics: true, hasLabor: true },
  { id: "zip", label: "ZIP code", hasDemographics: true, hasLabor: false },
  { id: "city", label: "City", hasDemographics: false, hasLabor: false },
  { id: "facility", label: "Each facility", hasDemographics: false, hasLabor: false }
];

var BOTH = ["rcfe", "hco"];

/* ---------- 1. identity and location ---------- */
var identityFields = [
  { id: "name", label: "Name", type: "text", origin: "parsed",
    roles: ["filter", "display"], datasets: BOTH },

  { id: "facilityNumber", label: "Facility number", type: "text", origin: "parsed",
    roles: ["filter", "display"], datasets: BOTH,
    note: "The state's own identifier. A person comparing their own agency enters this one." },

  { id: "licensee", label: "Licensee", type: "text", origin: "parsed",
    roles: ["filter", "group", "display"], datasets: BOTH, grains: ["facility"],
    note: "Grouping on this finds operators running more than one location." },

  { id: "administrator", label: "Administrator", type: "text", origin: "parsed",
    roles: ["filter", "display"], datasets: BOTH },

  { id: "phone", label: "Phone", type: "text", origin: "parsed",
    roles: ["filter", "display"], datasets: BOTH,
    note: "Filter on is blank to separate a reachable lead list from a bare count." },

  { id: "address", label: "Street address", type: "text", origin: "parsed",
    roles: ["display"], datasets: BOTH }
];

/* Grain fields. These are what groupBy accepts, and county and ZIP are the two
   that carry a published population, so they are the two that support ratios.

   City has no denominator anywhere in the suite. Cities span several ZIPs and
   ZIPs cross city lines, so summing ZIP populations under a city name is an
   approximation with no way to tell the reader when it went wrong. City stays
   a counting grain. */
var locationFields = [
  { id: "county", label: "County", type: "text", origin: "parsed",
    roles: ["filter", "group", "display"], datasets: BOTH, grains: ["county"],
    note: "Blank and Out-of-state both occur. Both are excluded from geographic " +
          "rollups by name, not dropped silently." },

  { id: "city", label: "City", type: "text", origin: "parsed",
    roles: ["filter", "group", "display"], datasets: BOTH, grains: ["city"] },

  { id: "zip", label: "ZIP code", type: "text", origin: "parsed",
    roles: ["filter", "group", "display"], datasets: BOTH, grains: ["zip"],
    note: "Matched to the demographic table on the first five digits." },

  { id: "state", label: "State", type: "text", origin: "parsed",
    roles: ["filter", "display"], datasets: BOTH },

  { id: "location", label: "Distance from a place", type: "geo", origin: "parsed",
    roles: ["filter"], datasets: BOTH,
    note: "Reads lat and lng. A record placed by ZIP or city center sits at the " +
          "center of that area, not at its address, so a radius result should " +
          "report how many of its records were placed exactly." },

  { id: "geoSource", label: "How the location was found", type: "category", origin: "parsed",
    roles: ["filter", "group", "display"], datasets: BOTH, grains: ["facility"],
    values: [
      { value: "address", label: "Exact address" },
      { value: "zip", label: "Center of the ZIP" },
      { value: "city", label: "Center of the city" },
      { value: "", label: "Not placed" }
    ] }
];

/* ---------- 2. status and dates ---------- */
var statusFields = [
  { id: "status", label: "License status", type: "category", origin: "parsed",
    roles: ["filter", "group", "display"], datasets: BOTH, grains: ["facility"],
    values: [
      { value: "LICENSED", label: "Licensed" },
      { value: "PENDING", label: "Pending" },
      { value: "ON PROBATION", label: "On probation" },
      { value: "CLOSED", label: "Closed" }
    ],
    defaultCondition: { op: "isAnyOf", value: ["LICENSED", "PENDING"] },
    note: "The builder opens with the default condition already in the list, " +
          "where it can be seen and removed. Closed records are loaded, so " +
          "without it every count includes them." },

  { id: "isCcrc", label: "Continuing care retirement community", type: "boolean", origin: "parsed",
    roles: ["filter", "group", "display"], datasets: ["rcfe"], grains: ["facility"] },

  { id: "licenseDate", label: "First licensed", type: "date", origin: "parsed",
    roles: ["filter", "display"], datasets: BOTH,
    note: "Empty on almost every pending record, because the license has not " +
          "been granted. Present on 99.9 per cent of licensed records." },

  { id: "closedDate", label: "Closed on", type: "date", origin: "parsed",
    roles: ["filter", "display"], datasets: BOTH,
    note: "The export retains about five years of closures. See rules.closureWindowYears." },

  { id: "lastVisitDate", label: "Last visit", type: "date", origin: "parsed",
    roles: ["filter", "display"], datasets: BOTH }
];

/* Derived from the fields above. Computed once at load, declared here so the
   builder can offer them like any other field. Each names what it reads, so a
   change upstream has one place to look. */
var derivedFields = [
  { id: "licenseYear", label: "Year first licensed", type: "number", origin: "derived",
    reads: ["licenseDate"], roles: ["filter", "group", "display"], datasets: BOTH,
    grains: ["facility"],
    note: "Blank where the license date is missing. Never zero." },

  { id: "closedYear", label: "Year closed", type: "number", origin: "derived",
    reads: ["closedDate"], roles: ["filter", "group", "display"], datasets: BOTH,
    grains: ["facility"] },

  { id: "yearsOpen", label: "Years since first licensed", type: "number", origin: "derived",
    reads: ["licenseDate"], roles: ["filter", "display"], datasets: BOTH,
    note: "Age of an operating facility. This is not tenure at closure: the " +
          "export keeps only recent closures, so a median tenure built from it " +
          "would describe short-lived operators and nobody else." },

  { id: "daysSinceVisit", label: "Days since the last visit", type: "number", origin: "derived",
    reads: ["lastVisitDate"], roles: ["filter", "display"], datasets: BOTH,
    note: "The figure that gives a citation count its meaning. No citations and " +
          "one visit is not the same as no citations and eight." },

  { id: "citationsPerVisit", label: "Citations per visit", type: "number", origin: "derived",
    reads: ["citations", "totalVisits"], roles: ["filter", "display"], datasets: BOTH,
    blankWhenZeroDenominator: true,
    note: "Blank where there have been no visits. Zero would read as a clean " +
          "record when it means the facility has never been inspected." },

  { id: "substantiatedRate", label: "Share of allegations substantiated", type: "number",
    origin: "derived", reads: ["substantiated", "allegations"],
    roles: ["filter", "display"], datasets: ["rcfe"], blankWhenZeroDenominator: true },

  { id: "complaintsPerBed", label: "Complaints per bed", type: "number", origin: "derived",
    reads: ["complaints", "capacity"], roles: ["filter", "display"], datasets: ["rcfe"],
    blankWhenZeroDenominator: true }
];

/* ---------- 3. capacity, inspections and citations ---------- */
var capacityFields = [
  { id: "capacity", label: "Licensed beds", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: ["rcfe"],
    note: "The column exists in the home care export but is empty for every " +
          "record, so it is not offered there." },

  { id: "capacityBand", label: "Size", type: "category", origin: "parsed",
    roles: ["filter", "group", "display"], datasets: ["rcfe"], grains: ["facility"],
    values: [
      { value: "1-6", label: "1 to 6 beds" },
      { value: "7-15", label: "7 to 15 beds" },
      { value: "16-49", label: "16 to 49 beds" },
      { value: "50-99", label: "50 to 99 beds" },
      { value: "100+", label: "100 beds or more" }
    ] }
];

var inspectionFields = [
  { id: "inspectionVisits", label: "Inspection visits", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: BOTH },

  { id: "complaintVisits", label: "Complaint visits", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: BOTH },

  { id: "otherVisits", label: "Other visits", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: BOTH },

  { id: "totalVisits", label: "Total visits", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: BOTH },

  { id: "complaints", label: "Complaints", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: BOTH,
    note: "Counted from whole blocks in the export's variable length tail. A " +
          "short trailing block is ignored rather than allowed to distort it." },

  { id: "allegations", label: "Allegations", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: ["rcfe"] },

  { id: "substantiated", label: "Substantiated allegations", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: ["rcfe"] },

  { id: "typeA", label: "Type A citations", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: BOTH,
    note: "The serious class. Summed from named columns in the RCFE export and " +
          "out of the tail in the home care export, which is why the two are " +
          "not strictly comparable across datasets." },

  { id: "typeB", label: "Type B citations", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: BOTH },

  { id: "citations", label: "Citations", type: "number", origin: "parsed",
    roles: ["filter", "measure", "display"], datasets: BOTH }
];

/* ---------- 4. enrichment ----------
   Attached at load from DEMAND and LABOR. Not a join the user performs: by the
   time a record reaches the engine these are its own fields.

   Every demographic figure carries a coefficient of variation from the source.
   County estimates are reliable almost everywhere. ZIP estimates are reliable
   where facilities are, because facilities sit in populated ZIPs, and much less
   so in the empty ZIPs a saturation report pulls in. */
var demographicFields = [
  { id: "zipSeniors", label: "Residents 65 and over in the ZIP", type: "number",
    origin: "demand", source: "DEMAND.zip[zip].a65", cv: true,
    roles: ["filter", "display"], datasets: BOTH, grains: ["zip", "facility"],
    note: "Blank, never zero, where the ZIP has no record or a zero estimate." },

  { id: "zipSeniors75", label: "Residents 75 and over in the ZIP", type: "number",
    origin: "demand", source: "DEMAND.zip[zip].a75", cv: true,
    roles: ["filter", "display"], datasets: BOTH, grains: ["zip", "facility"] },

  { id: "zipSeniors85", label: "Residents 85 and over in the ZIP", type: "number",
    origin: "demand", source: "DEMAND.zip[zip].a85", cv: true,
    roles: ["filter", "display"], datasets: BOTH, grains: ["zip", "facility"],
    note: "The band that actually consumes care, and the one with the weakest " +
          "estimates. Offered behind the 65 and over figure, not in front of it." },

  { id: "zipPopulation", label: "Residents in the ZIP", type: "number",
    origin: "demand", source: "DEMAND.zip[zip].p",
    roles: ["filter", "display"], datasets: BOTH, grains: ["zip", "facility"] },

  { id: "zipLivingAlone", label: "Residents 65 and over living alone", type: "number",
    origin: "demand", source: "DEMAND.zip[zip].al", cv: true,
    roles: ["filter", "display"], datasets: BOTH, grains: ["zip", "facility"] },

  { id: "zipSeniorIncome", label: "Median income, householder 65 and over", type: "number",
    origin: "demand", source: "DEMAND.zip[zip].in", cv: true, money: true,
    roles: ["filter", "display"], datasets: BOTH, grains: ["zip", "facility"] },

  { id: "zipHomeValue", label: "Median home value in the ZIP", type: "number",
    origin: "demand", source: "DEMAND.zip[zip].hv", cv: true, money: true,
    roles: ["filter", "display"], datasets: BOTH, grains: ["zip", "facility"] },

  { id: "countySeniors", label: "Residents 65 and over in the county", type: "number",
    origin: "demand", source: "DEMAND.county[fips].a65", cv: true,
    roles: ["filter", "display"], datasets: BOTH, grains: ["county", "zip", "facility"] },

  { id: "countySeniors85", label: "Residents 85 and over in the county", type: "number",
    origin: "demand", source: "DEMAND.county[fips].a85", cv: true,
    roles: ["filter", "display"], datasets: BOTH, grains: ["county", "zip", "facility"] },

  { id: "countyFips", label: "County code", type: "text",
    origin: "demand", source: "DEMAND.zip[zip].c",
    roles: ["display"], datasets: BOTH,
    note: "The key that joins a record to the labor tables." }
];

/* Labor is county only, published quarterly, and counts jobs by the employer's
   industry rather than by what the worker does. Two cautions travel with every
   figure here and belong on the face of any report that shows them.

   624120 in California is dominated by In-Home Supportive Services providers
   paid through the county programme, so its employer count is not a count of
   agencies. And wages are published for labor market areas, twenty six of
   which cover more than one county, so a wage shown against a county name is
   really the area's. */
var laborFields = [
  { id: "laborArea", label: "Labor market area", type: "text",
    origin: "labor", source: "LABOR.crosswalk[county]",
    roles: ["filter", "group", "display"], datasets: BOTH, grains: ["county"] },

  { id: "hhEmployers", label: "Home health employers in the county", type: "number",
    origin: "labor", source: "LABOR.qcew[fips]['6216'].e",
    roles: ["filter", "display"], datasets: BOTH, grains: ["county"],
    note: "An independent count of who is operating, from a different source " +
          "than the licensing file. The gap between the two is itself worth reading." },

  { id: "hhJobs", label: "Home health jobs in the county", type: "number",
    origin: "labor", source: "LABOR.qcew[fips]['6216'].j",
    roles: ["filter", "display"], datasets: BOTH, grains: ["county"] },

  { id: "hhWeeklyWage", label: "Home health weekly wage", type: "number", money: true,
    origin: "labor", source: "LABOR.qcew[fips]['6216'].w",
    roles: ["filter", "display"], datasets: BOTH, grains: ["county"] },

  { id: "alfEmployers", label: "Assisted living employers in the county", type: "number",
    origin: "labor", source: "LABOR.qcew[fips]['623312'].e",
    roles: ["filter", "display"], datasets: ["rcfe"], grains: ["county"] },

  { id: "alfWeeklyWage", label: "Assisted living weekly wage", type: "number", money: true,
    origin: "labor", source: "LABOR.qcew[fips]['623312'].w",
    roles: ["filter", "display"], datasets: ["rcfe"], grains: ["county"] },

  { id: "aideMedianWage", label: "Care aide median hourly wage", type: "number", money: true,
    origin: "labor", source: "LABOR.oews[area]['311120'].med",
    roles: ["filter", "display"], datasets: BOTH, grains: ["county"],
    areaLabelled: true },

  { id: "aideEmployment", label: "Care aides employed in the area", type: "number",
    origin: "labor", source: "LABOR.oews[area]['311120'].emp",
    roles: ["filter", "display"], datasets: BOTH, grains: ["county"],
    areaLabelled: true,
    note: "Supply of staff. High agency density against a thin pool is a kind of " +
          "saturation a headcount does not show." },

  { id: "lvnMedianWage", label: "Licensed vocational nurse median hourly wage", type: "number",
    money: true, origin: "labor", source: "LABOR.oews[area]['292061'].med",
    roles: ["filter", "display"], datasets: BOTH, grains: ["county"], areaLabelled: true },

  { id: "rnMedianWage", label: "Registered nurse median hourly wage", type: "number",
    money: true, origin: "labor", source: "LABOR.oews[area]['291141'].med",
    roles: ["filter", "display"], datasets: BOTH, grains: ["county"], areaLabelled: true }
];

/* ---------- 5. measures ----------
   A measure is what fills a cell. Ratios carry a denominator id and a scale;
   everything else is a plain aggregate.

   grains lists where the measure can be used. The builder disables it elsewhere
   and shows the reason, rather than returning an empty column.

   statuses, where present, overrides the report's own status condition. Entry
   measures use it: a pending application has no license date, so counting it as
   an entry would be counting an event that has not happened. */
var measures = [
  /* saturation */
  { id: "facilities", label: "Facilities", agg: "count", datasets: BOTH,
    grains: ["county", "zip", "city"], primary: true },

  { id: "beds", label: "Licensed beds", agg: "sum", field: "capacity", datasets: ["rcfe"],
    grains: ["county", "zip", "city"], primary: true },

  { id: "per65", label: "Facilities per 10,000 residents 65 and over", agg: "count",
    per: "a65", scale: 10000, datasets: BOTH, grains: ["county", "zip"],
    primary: true, carriesCv: true,
    note: "The headline saturation figure. The numerator is a hard count from " +
          "the licensing roster, so every bit of the uncertainty sits in the " +
          "denominator and travels with the result." },

  { id: "bedsPer100", label: "Beds per 100 residents 65 and over", agg: "sum",
    field: "capacity", per: "a65", scale: 100, datasets: ["rcfe"],
    grains: ["county", "zip"], primary: true, carriesCv: true },

  { id: "per85", label: "Facilities per 10,000 residents 85 and over", agg: "count",
    per: "a85", scale: 10000, datasets: BOTH, grains: ["county", "zip"],
    carriesCv: true,
    note: "Closer to the population that uses care, on a weaker estimate." },

  { id: "shareOfParent", label: "Share of the county total", agg: "count",
    per: "parent", scale: 1, datasets: BOTH, grains: ["county", "zip", "city"],
    note: "Needs no outside denominator, so it works at city grain where the " +
          "ratios above do not." },

  /* movement */
  { id: "entries", label: "Newly licensed", agg: "count", datasets: BOTH,
    grains: ["county", "zip", "city"], window: "licenseYear",
    statuses: ["LICENSED", "ON PROBATION"], reportsCoverage: true,
    note: "Counts licenses granted in the window. Pending applications are not " +
          "entries. Records with no license date cannot be placed and the " +
          "number of them is printed with the result." },

  { id: "exits", label: "Closed", agg: "count", datasets: BOTH,
    grains: ["county", "zip", "city"], window: "closedYear",
    statuses: ["CLOSED"], maxWindowYears: 5 },

  { id: "netChange", label: "Net change", agg: "derived", datasets: BOTH,
    grains: ["county", "zip", "city"], reads: ["entries", "exits"],
    maxWindowYears: 5,
    note: "Entries less exits. Only honest inside the window the export retains " +
          "closures for, which is why it inherits the five year cap." },

  { id: "pending", label: "Applications pending", agg: "count", datasets: BOTH,
    grains: ["county", "zip", "city"], statuses: ["PENDING"], primary: true,
    note: "Competitors who do not exist yet. A leading indicator of supply, and " +
          "one nothing else in the suite shows." },

  { id: "onProbation", label: "On probation", agg: "count", datasets: BOTH,
    grains: ["county", "zip", "city"], statuses: ["ON PROBATION"] },

  /* context and quality */
  { id: "totalCitations", label: "Citations", agg: "sum", field: "citations",
    datasets: BOTH, grains: ["county", "zip", "city"] },

  { id: "totalTypeA", label: "Type A citations", agg: "sum", field: "typeA",
    datasets: BOTH, grains: ["county", "zip", "city"] },

  { id: "medianCitations", label: "Median citations", agg: "median", field: "citations",
    datasets: BOTH, grains: ["county", "zip", "city"] },

  { id: "shareClean", label: "Share with no citations", agg: "shareWhereZero",
    field: "citations", datasets: BOTH, grains: ["county", "zip", "city"],
    note: "Read alongside visits. A facility with no citations and one visit is " +
          "not comparable to one with no citations and eight." },

  { id: "medianDaysSinceVisit", label: "Median days since the last visit", agg: "median",
    field: "daysSinceVisit", datasets: BOTH, grains: ["county", "zip", "city"] },

  { id: "medianSubstantiated", label: "Median substantiated allegations", agg: "median",
    field: "substantiated", datasets: ["rcfe"], grains: ["county", "zip", "city"] },

  /* demand and staffing context, carried through from enrichment */
  { id: "seniors", label: "Residents 65 and over", agg: "areaValue", field: "a65",
    datasets: BOTH, grains: ["county", "zip"], carriesCv: true },

  { id: "seniorsAlone", label: "Residents 65 and over living alone", agg: "areaValue",
    field: "al", datasets: BOTH, grains: ["county", "zip"], carriesCv: true },

  { id: "aideWage", label: "Care aide median hourly wage", agg: "areaValue",
    field: "aideMedianWage", datasets: BOTH, grains: ["county"],
    money: true, areaLabelled: true },

  { id: "aideSupply", label: "Care aides employed", agg: "areaValue",
    field: "aideEmployment", datasets: BOTH, grains: ["county"], areaLabelled: true }
];

/* ---------- rules ----------
   What the source data will and will not support. Each was measured on a full
   download rather than assumed, and each is a limit the builder enforces before
   a query runs, not a caveat printed afterwards. */
var rules = {
  // Closures reach back about five years in both exports and no further. A
  // window wider than this returns a truncated answer that looks complete.
  closureWindowYears: 5,

  // The home care license began in 2016 and the operators already trading
  // registered that year, which shows as a spike no later year comes near.
  // Counting it as market entry would make every year since look like collapse.
  entryFloorYear: { rcfe: null, hco: 2017 },

  // A pending application has no license date. Entry measures say so themselves
  // through statuses; this is the same fact in one place for the builder.
  entryStatuses: ["LICENSED", "ON PROBATION"],

  // The current year is incomplete whenever the file is downloaded.
  labelCurrentYearPartial: true,

  // Measured by record rather than by ZIP: facilities sit in populated ZIPs
  // where the estimates are good. Null means flag an unreliable denominator and
  // show the value anyway. It is worth setting only when a report pulls in areas
  // that hold no facilities, where the weaker distribution returns.
  reliabilityDefaults: { maxCv: null, minDenominator: null },

  // Excluded from every geographic rollup by name, so the exclusion is visible.
  nonGeographicCounties: ["", "Out-of-state"],

  // Tenure at closure would describe short lived operators and nobody else,
  // because the export keeps only recent closures. Left out rather than shipped
  // with a footnote.
  noSurvivalMeasures: true
};

/* ---------- accessors ---------- */
var fields = []
  .concat(identityFields, locationFields, statusFields, derivedFields,
          capacityFields, inspectionFields, demographicFields, laborFields);

function byId(list, id){
  for(var i = 0; i < list.length; i++) if(list[i].id === id) return list[i];
  return null;
}
function has(list, v){ return !list || list.indexOf(v) !== -1; }

function field(id){ return byId(fields, id); }
function measure(id){ return byId(measures, id); }

function fieldsFor(dataset, role){
  return fields.filter(function(f){
    return has(f.datasets, dataset) && (!role || f.roles.indexOf(role) !== -1);
  });
}

function groupFieldsFor(dataset){
  return fieldsFor(dataset, "group");
}

/* Measures the chosen grain can actually serve. Everything else is offered
   disabled, with whyDisabled saying what to change. */
function measuresFor(dataset, grain){
  return measures.filter(function(m){ return has(m.datasets, dataset); })
    .map(function(m){
      var okGrain = has(m.grains, grain);
      return {
        measure: m,
        enabled: okGrain,
        whyDisabled: okGrain ? null : whyDisabled(m, grain)
      };
    });
}

function whyDisabled(m, grain){
  var g = byId(GRAINS, grain);
  var name = g ? g.label.toLowerCase() : grain;
  if(m.per && m.per !== "parent"){
    return "No population is published for " + name + ", so this cannot be worked out. " +
           "Group by county or ZIP code instead.";
  }
  if(m.grains && m.grains.length === 1 && m.grains[0] === "county"){
    return "Employment and wage figures are published by county only.";
  }
  return "Not available at this grain.";
}

function opsFor(type){ return TYPE_OPS[type] || []; }
function opLabel(op){ return OP_LABELS[op] || op; }
function acceptsList(op){ return !!MULTI_VALUE_OPS[op]; }

/* The condition the builder starts with, so a count never quietly includes
   closed records. */
function defaultConditions(){
  var out = [];
  fields.forEach(function(f){
    if(f.defaultCondition){
      out.push({ field: f.id, op: f.defaultCondition.op, value: f.defaultCondition.value });
    }
  });
  return out;
}

function entryFloor(dataset){ return rules.entryFloorYear[dataset] || null; }

return {
  fields: fields,
  measures: measures,
  rules: rules,
  grains: GRAINS,
  typeOps: TYPE_OPS,
  field: field,
  measure: measure,
  fieldsFor: fieldsFor,
  groupFieldsFor: groupFieldsFor,
  measuresFor: measuresFor,
  opsFor: opsFor,
  opLabel: opLabel,
  acceptsList: acceptsList,
  defaultConditions: defaultConditions,
  entryFloor: entryFloor
};
})();
