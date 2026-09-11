// Neutral presentation vocabulary. This contains no polity roster, live state,
// relational coding, or availability oracle. Legality stays with the validator.
const f = (key, label, kind = "text", source = null, optional = false) => ({ key, label, kind, source, optional });
const unit = (optional = false) => f("unit_id", "Unit", "select", "units", optional);
const citizen = (optional = false) => f("citizen_id", "Citizen group", "select", "population_groups", optional);
const hex = (optional = false) => f("hex_id", "Destination hex", "select", "hexes", optional);
const facility = (optional = false) => f("facility_id", "Facility", "select", "facilities", optional);
const to = (optional = false) => f("to", "Recipient", "select", "contacts", optional);
const channel = (optional = false) => f("channel_id", "Private room", "select", "channels", optional);
const territory = () => f("territory_id", "Territory", "select", "territories");
const technology = (source = "technology_types") => f("technology", "Technology", "select", source);
const builders = () => f("builder_ids", "Builder groups (optional)", "multi", "builders", true);
const scientists = () => f("scientist_ids", "Scientist groups (optional)", "multi", "scientists", true);
const text = () => f("text", "Message / commitment in your own words", "textarea");
const assignment = () => [citizen(), f("assignment", "Assignment", "select", "assignments"), f("count", "Citizens", "number"), facility()];
const carrier = () => f("carrier_id", "Transport / carrier", "select", "carriers");
export const ACTION_META = Object.freeze({
  wait: { label: "Wait", group: "Orders", fields: [] },
  name: { label: "Name your civilization", group: "Orders", fields: [f("name", "Civilization name")] },
  move: { label: "Move unit", group: "Movement", fields: [unit(), hex()] },
  move_population: { label: "Move population", group: "Movement", fields: [citizen(), hex()] },
  explore: { label: "Explore", group: "Discovery", fields: [citizen(), f("hex_id", "Destination hex (known or adjacent unknown)", "text")] },
  attack: { label: "Attack observed unit", group: "Military", fields: [unit(), f("target_unit_id", "Observed target", "select", "foreign_units")] },
  fortify: { label: "Fortify unit", group: "Military", fields: [unit()] },
  recruit: { label: "Recruit operational unit", group: "Military", fields: [f("unit_type", "Unit type", "select", "unit_types", true), facility(true), f("citizen_ids", "Soldier groups (optional)", "multi", "soldiers", true), hex(true)] },
  demobilize: { label: "Demobilize unit", group: "Military", fields: [unit(), facility()] },
  reassign: { label: "Reassign citizens", group: "Population", fields: assignment() },
  train: { label: "Train citizens", group: "Population", fields: assignment() },
  build: { label: "Construct facility", group: "Construction", fields: [f("facility_type", "Facility type", "select", "facility_types"), f("hex_ids", "Contiguous footprint hexes", "multi", "hexes"), builders()] },
  resume_construction: { label: "Resume construction", group: "Construction", fields: [facility(), builders()] },
  upgrade: { label: "Upgrade facility", group: "Construction", fields: [facility(), builders()] },
  repair: { label: "Repair facility", group: "Construction", fields: [facility(), builders()] },
  destroy: { label: "Destroy facility", group: "Construction", fields: [facility()] },
  research: { label: "Research technology", group: "Technology", fields: [technology(), facility(), scientists()] },
  reverse_engineer: { label: "Reverse engineer artifact", group: "Technology", fields: [technology(), facility(), f("artifact_id", "Captured artifact", "select", "artifacts"), scientists()] },
  prospect: { label: "Prospect resources", group: "Discovery", fields: [citizen(), hex()] },
  intelligence: { label: "Collect intelligence", group: "Discovery", fields: [to()] },
  reconnaissance: { label: "Reconnaissance scan", group: "Discovery", fields: [f("hex_id", "Target hex coordinate (known or unknown, hex-q-r)"), unit(true)] },
  transfer: { label: "Transfer resources", group: "Exchange", fields: [to(), f("resource", "Resource", "select", "resources"), f("amount", "Amount", "number")] },
  transfer_unit: { label: "Transfer unit", group: "Exchange", fields: [to(), unit()] },
  transfer_population: { label: "Transfer population", group: "Exchange", fields: [to(), citizen(), f("count", "Citizens", "number")] },
  transfer_facility: { label: "Transfer facility", group: "Exchange", fields: [to(), facility()] },
  incorporate_population: { label: "Incorporate unaffiliated population", group: "Population", fields: [f("unaffiliated_population_id", "Observed unaffiliated population", "select", "unaffiliated_population"), f("count", "Citizens to incorporate", "number")] },
  reactivate_unit: { label: "Reactivate neutral unit", group: "Military", fields: [f("neutral_unit_id", "Observed inactive neutral unit", "select", "neutral_units"), f("citizen_ids", "Soldier groups", "multi", "soldiers")] },
  acquire_facility: { label: "Acquire unclaimed facility", group: "Construction", fields: [f("facility_id", "Observed unclaimed facility", "select", "unclaimed_facilities")] },
  share_technology: { label: "Share technology", group: "Exchange", fields: [to(), technology("technologies")] },
  claim: { label: "Claim territory", group: "Territory", fields: [territory()] },
  annex: { label: "Annex territory", group: "Territory", fields: [territory()] },
  abandon: { label: "Abandon territory", group: "Territory", fields: [territory()] },
  exchange_territory: { label: "Transfer territory", group: "Territory", fields: [territory(), to()] },
  channel_create: { label: "Open private room", group: "Communications", fields: [f("members", "Known participants", "multi", "contacts")] },
  channel_invite: { label: "Invite to private room", group: "Communications", fields: [channel(), to()] },
  channel_leave: { label: "Leave private room", group: "Communications", fields: [channel()] },
  message: { label: "Private message", group: "Communications", fields: [to(true), channel(true), text()] },
  promise: { label: "Statement of commitment", group: "Communications", fields: [to(true), channel(true), text()] },
  broadcast: { label: "Public broadcast", group: "Communications", fields: [text()] },
  embark: { label: "Embark", group: "Movement", fields: [carrier(), unit(true), citizen(true)] },
  disembark: { label: "Disembark", group: "Movement", fields: [carrier(), hex(), unit(true), citizen(true)] }
});
export const ASSIGNMENTS = ["Civilian", "Farmer", "Builder", "Scientist", "Soldier", "Explorer"];
export const CATALOGUE = Object.freeze({
  unit_types: ["infantry", "armor", "artillery", "fighter", "bomber", "transport", "surface_naval", "submarine", "carrier"],
  facility_types: ["industrial", "extraction", "refining", "agriculture", "research", "training", "ground_military", "aircraft", "naval_shipyard", "carrier_complex"],
  technology_types: ["agronomy", "metallurgy", "navigation", "ballistics", "flight", "sensors", "satellites"]
});
