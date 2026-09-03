// ---------------------------------------------------------------
// BKK SHARED SERVER
//
// This is the "shared whiteboard" for the three BKK apps (BKK-MDT,
// BKK-Master, BKK-Incidents). None of the apps hold their own copy of
// the data -- they all read from and write to THIS server, which is
// what keeps them in sync with each other.
//
// This stage is deliberately just the plumbing: a data store + an API.
// No screens, nothing pretty -- just confirming data goes in and comes
// back out correctly. The three apps get built next, on top of this.
//
// No SMS scanning, no external services. All data is entered manually
// by whichever app calls the API. State is saved to a local JSON file
// (bkk_data.json, next to this script) so restarting the server
// doesn't wipe your test data.
//
// Run with: node bkk_server.js
// Then point ngrok (or your phone on the same wifi) at it, same as
// the earlier sms_bridge.js setup.
// ---------------------------------------------------------------

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8790;
const DATA_FILE = path.join(__dirname, "bkk_data.json");

// ---------------------------------------------------------------
// CONSTANTS -- mirrors the values already used in the prototype, so
// the eventual apps' code and this server agree on the same shapes.
// ---------------------------------------------------------------
const VEHICLES = ["BKK1", "BKK31", "BKK32", "BKK33", "BKK36", "BKK37", "BKK44", "BKK56", "SES59", "SES43K"];

const STATUSES = [
  { id: "standby", label: "STANDBY", led: "#7C8791" },
  { id: "onalert", label: "ON ALERT", led: "#E8B23C" },
  { id: "activated", label: "ACTIVATED", led: "#3FA34D" },
  { id: "rest", label: "REST", led: "#2F8FD1" },
  { id: "stooddown", label: "STOOD DOWN", led: "#D9463D" },
];
const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

// Incident-level status lifecycle (independent of per-vehicle
// acknowledge/onsite/complete tracking, which is separate and unchanged).
const REJECT_REASONS = ["Asset N/A", "Team N/A", "Wrong Unit", "Other"];
const CANCEL_REASONS = ["Created in error", "Duplicate", "No longer required", "Not an SES task", "Other"];

const SUBURBS = [
  "Bankstown", "Chullora", "Greenacre", "Mount Lewis", "Punchbowl",
  "Bass Hill", "Birrong", "Chester Hill", "Condell Park", "Georges Hall",
  "Lansdowne", "Potts Hill", "Regents Park", "Sefton", "Villawood", "Yagoona",
  "East Hills", "Milperra", "Padstow", "Padstow Heights", "Panania",
  "Picnic Point", "Revesby", "Revesby Heights",
];

function findSuburbForAddress(addr) {
  if (!addr) return null;
  const upper = addr.toUpperCase();
  const sorted = [...SUBURBS].sort((a, b) => b.length - a.length);
  return sorted.find((s) => upper.includes(s.toUpperCase())) || null;
}

function pad4(n) { return String(n).padStart(4, "0"); }

// ---------------------------------------------------------------
// STATE
// ---------------------------------------------------------------
function initialVehicleState() {
  return {
    queue: [],
    activeJob: null,
    incomingQueue: [],
    teamStatus: STATUSES[0],
    timeline: [{ id: `seed-${Date.now()}-${Math.random()}`, main: "Vehicle initialised", time: new Date().toISOString() }],
    crew: [],
    leaderId: null,
    progress: {},
  };
}

function initialState() {
  const vehicleStates = {};
  VEHICLES.forEach((v) => { vehicleStates[v] = initialVehicleState(); });
  return {
    vehicleStates,
    autoRequestNearestAsset: true,
    suburbAssignments: {},
    completedJobs: [],
    calledOffJobs: [],
    allIncidents: [],
    unassignedIncidents: [],
    incidentNotes: {},
    incidentTimelines: {},
    incidentCounter: 1,
    ssMembers: [],
    externalPeople: [],
  };
}

let state = initialState();

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const loaded = JSON.parse(raw);
      // Merge over defaults so a data file from an older version of this
      // server (missing newer fields) doesn't crash on load.
      state = { ...initialState(), ...loaded };
      VEHICLES.forEach((v) => {
        if (!state.vehicleStates[v]) state.vehicleStates[v] = initialVehicleState();
      });
      console.log(`Loaded existing data from ${DATA_FILE}`);
    } else {
      console.log("No existing data file -- starting fresh.");
    }
  } catch (e) {
    console.error("Failed to load data file, starting fresh:", e.message);
    state = initialState();
  }
}

let saveScheduled = false;
function saveState() {
  // Debounce so a burst of actions doesn't hammer the disk.
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) console.error("Failed to save data file:", err.message);
    });
  }, 250);
}

loadState();

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
function shortId(id) { return String(id).replace(/^Incident /, ""); }

function logEventFor(vehicle, main) {
  if (!state.vehicleStates[vehicle]) return;
  state.vehicleStates[vehicle].timeline.unshift({
    id: `${Date.now()}-${Math.random()}`,
    main,
    time: new Date().toISOString(),
  });
}

// Simulated "nearest" selection among vehicles that aren't Stood Down.
// Same mock-distance approach as the prototype -- no real geolocation
// server-side; that stays a client-side concern for whichever app shows
// a map.
function pickNearestEligibleVehicle() {
  const eligible = VEHICLES.filter((v) => state.vehicleStates[v].teamStatus.id !== "stooddown");
  if (eligible.length === 0) return null;
  let best = null, bestDist = Infinity;
  eligible.forEach((v) => {
    const d = Math.random() * 9 + 1;
    if (d < bestDist) { bestDist = d; best = v; }
  });
  return { vehicle: best, dist: bestDist.toFixed(1) };
}

// Suburb assignment first (if that vehicle isn't Stood Down), then Auto
// Request to Nearest Asset, then null (pool). No longer used by
// CREATE_INCIDENT (tasking is now always a deliberate, separate action --
// see the status lifecycle below) but kept in case it's useful again later.
function resolveAutoVehicle(addr) {
  const suburb = findSuburbForAddress(addr);
  if (suburb && state.suburbAssignments[suburb]) {
    const assigned = state.suburbAssignments[suburb];
    if (state.vehicleStates[assigned] && state.vehicleStates[assigned].teamStatus.id !== "stooddown") {
      return { vehicle: assigned, reason: "suburb", suburb };
    }
  }
  if (state.autoRequestNearestAsset) {
    const nearest = pickNearestEligibleVehicle();
    if (nearest) return { vehicle: nearest.vehicle, reason: "nearest" };
  }
  return null;
}

// Updates an incident's fields wherever a copy of it might be sitting --
// allIncidents, unassignedIncidents, and any vehicle's queue/incomingQueue
// -- so the status shown is always consistent no matter where it's viewed
// from.
function updateIncidentEverywhere(incidentId, updater) {
  state.allIncidents = state.allIncidents.map((i) => (i.id === incidentId ? updater(i) : i));
  state.unassignedIncidents = state.unassignedIncidents.map((i) => (i.id === incidentId ? updater(i) : i));
  VEHICLES.forEach((v) => {
    const vs = state.vehicleStates[v];
    if (!vs) return;
    vs.queue = vs.queue.map((i) => (i.id === incidentId ? updater(i) : i));
    vs.incomingQueue = vs.incomingQueue.map((i) => (i.id === incidentId ? updater(i) : i));
  });
}

function addIncidentTimelineEntry(incidentId, status, note, timestamp) {
  if (!state.incidentTimelines[incidentId]) state.incidentTimelines[incidentId] = [];
  state.incidentTimelines[incidentId].unshift({
    id: `${Date.now()}-${Math.random()}`,
    status,
    note: note || null,
    time: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
  });
}

function setIncidentStatus(incidentId, status, note, timestamp) {
  updateIncidentEverywhere(incidentId, (i) => ({ ...i, status }));
  addIncidentTimelineEntry(incidentId, status, note, timestamp);
}

function notifyVehicle(vehicle, incident) {
  const v = state.vehicleStates[vehicle];
  if (!v) return;
  const alreadyTasked = v.incomingQueue.some((i) => i.id === incident.id) || v.queue.some((i) => i.id === incident.id);
  if (alreadyTasked) return;
  const tagged = { ...incident, taskedTo: vehicle, status: "Tasked" };
  v.incomingQueue.push(tagged);
  state.unassignedIncidents = state.unassignedIncidents.filter((i) => i.id !== incident.id);
  state.allIncidents = state.allIncidents.map((i) => (i.id === incident.id ? { ...i, taskedTo: vehicle, status: "Tasked" } : i));
  addIncidentTimelineEntry(incident.id, "Tasked", `Tasked to ${vehicle}`);
  logEventFor(vehicle, `${vehicle} Tasked on incident ${shortId(incident.id)} (pending acknowledgement)`);
}

function addToPool(incident) {
  state.unassignedIncidents.unshift(incident);
}

// ---------------------------------------------------------------
// ACTIONS -- one handler per action type. Mirrors the prototype's
// existing function names/behaviour closely so wiring the real apps up
// to this server later is mostly mechanical.
// ---------------------------------------------------------------
const actions = {
  CREATE_INCIDENT(payload) {
    const { fields, vehicles } = payload;
    const incident = {
      id: `Incident 0000-${pad4(state.incidentCounter)}`,
      dist: (fields && fields.dist) || null,
      eta: (fields && fields.eta) || null,
      taskedAt: new Date().toISOString(),
      status: "New",
      ...fields,
    };
    state.incidentCounter += 1;
    state.allIncidents.unshift(incident);
    addIncidentTimelineEntry(incident.id, "New", "Incident created", incident.taskedAt);

    const chosen = Array.isArray(vehicles) ? vehicles.filter((v) => VEHICLES.includes(v)) : [];
    if (chosen.length > 0) {
      chosen.forEach((v) => notifyVehicle(v, incident));
    } else {
      // No manual vehicle assignment -- always goes to the pool as "New".
      // Auto-routing no longer happens at creation time; tasking is now
      // always a deliberate, separate action (see NOTIFY_VEHICLE / the
      // Task button), not something that happens silently on create.
      addToPool(incident);
    }
    return { incident };
  },

  NOTIFY_VEHICLE(payload) {
    const { vehicle, incidentId } = payload;
    const incident = state.allIncidents.find((i) => i.id === incidentId);
    if (!incident || !VEHICLES.includes(vehicle)) throw new Error("Unknown incident or vehicle");
    notifyVehicle(vehicle, incident);
    return {};
  },

  ACKNOWLEDGE_INCIDENT(payload) {
    const { incidentId, availableForRescue } = payload;
    updateIncidentEverywhere(incidentId, (i) => ({ ...i, availableForRescue: availableForRescue ?? i.availableForRescue ?? null }));
    setIncidentStatus(incidentId, "Active", availableForRescue != null ? `Available for Rescue: ${availableForRescue ? "Yes" : "No"}` : null);
    return {};
  },

  REJECT_INCIDENT(payload) {
    const { incidentId, reason, timestamp, note } = payload;
    if (!REJECT_REASONS.includes(reason)) throw new Error("Unknown reject reason");
    const finalNote = reason === "Other" ? (note || "").trim() || "Other" : reason;
    setIncidentStatus(incidentId, "Rejected", finalNote, timestamp);
    return {};
  },

  RECCE_INCIDENT(payload) {
    const { incidentId } = payload;
    updateIncidentEverywhere(incidentId, (i) => ({ ...i, reconnoitered: true }));
    setIncidentStatus(incidentId, "Active", "Reconnoitered");
    return {};
  },

  COMPLETE_INCIDENT(payload) {
    const { incidentId, note, timestamp } = payload;
    setIncidentStatus(incidentId, "Complete", note || null, timestamp);
    return {};
  },

  CANCEL_INCIDENT(payload) {
    const { incidentId, reason, timestamp, note } = payload;
    if (!CANCEL_REASONS.includes(reason)) throw new Error("Unknown cancel reason");
    const finalNote = reason === "Other" ? (note || "").trim() || "Other" : reason;
    setIncidentStatus(incidentId, "Cancelled", finalNote, timestamp);
    return {};
  },

  REOPEN_INCIDENT(payload) {
    const { incidentId } = payload;
    setIncidentStatus(incidentId, "Active", "Reopened");
    return {};
  },

  FINALISE_INCIDENT(payload) {
    const { incidentId, note, timestamp } = payload;
    setIncidentStatus(incidentId, "Finalised", note || null, timestamp);
    return {};
  },

  ACKNOWLEDGE_INCOMING(payload) {
    const { vehicle } = payload;
    const v = state.vehicleStates[vehicle];
    if (!v) throw new Error("Unknown vehicle");
    const job = v.incomingQueue[0];
    if (!job) return {};
    v.incomingQueue = v.incomingQueue.slice(1);
    v.queue = [job, ...v.queue];
    v.activeJob = job;
    logEventFor(vehicle, `${vehicle} Tasked on incident ${shortId(job.id)}`);
    return {};
  },

  DISMISS_INCOMING(payload) {
    const { vehicle } = payload;
    const v = state.vehicleStates[vehicle];
    if (!v) throw new Error("Unknown vehicle");
    const job = v.incomingQueue[0];
    if (!job) return {};
    v.incomingQueue = v.incomingQueue.slice(1);
    addToPool(job);
    logEventFor(vehicle, `${vehicle} dismissed incident ${shortId(job.id)}`);
    return {};
  },

  SET_ACTIVE_JOB(payload) {
    const { vehicle, jobId } = payload;
    const v = state.vehicleStates[vehicle];
    if (!v) throw new Error("Unknown vehicle");
    v.activeJob = v.queue.find((j) => j.id === jobId) || null;
    return {};
  },

  SET_PHASE(payload) {
    const { vehicle, jobId, phase } = payload;
    const v = state.vehicleStates[vehicle];
    if (!v) throw new Error("Unknown vehicle");
    const existing = v.progress[jobId] || { phase: null, times: {} };
    v.progress[jobId] = { phase, times: { ...existing.times, [phase]: new Date().toISOString() } };
    logEventFor(vehicle, `${vehicle} ${phase} on incident ${shortId(jobId)}`);
    return {};
  },

  COMPLETE_JOB(payload) {
    const { vehicle, jobId, mode, formData } = payload;
    const v = state.vehicleStates[vehicle];
    if (!v) throw new Error("Unknown vehicle");
    const job = v.queue.find((j) => j.id === jobId);
    if (!job) throw new Error("Job not found on this vehicle's queue");
    v.queue = v.queue.filter((j) => j.id !== jobId);
    v.activeJob = v.queue[0] || null;
    delete v.progress[jobId];
    const onBoard = v.crew.filter((c) => c.on).map((c) => `${c.first} ${c.last}`);
    state.completedJobs.unshift({ job, mode, formData, vehicle, onBoard });
    logEventFor(vehicle, `${vehicle} Complete on incident ${shortId(jobId)}`);
    return {};
  },

  CALL_OFF_JOB(payload) {
    const { vehicle, jobId, reason } = payload;
    const v = state.vehicleStates[vehicle];
    if (!v) throw new Error("Unknown vehicle");
    const job = v.queue.find((j) => j.id === jobId);
    if (!job) throw new Error("Job not found on this vehicle's queue");
    v.queue = v.queue.filter((j) => j.id !== jobId);
    v.activeJob = v.queue[0] || null;
    delete v.progress[jobId];
    const onBoard = v.crew.filter((c) => c.on).map((c) => `${c.first} ${c.last}`);
    state.calledOffJobs.unshift({ job, reason, vehicle, onBoard });
    logEventFor(vehicle, `${vehicle} Called Off incident ${shortId(jobId)} — ${reason}`);
    return {};
  },

  SET_TEAM_STATUS(payload) {
    const { vehicle, statusId } = payload;
    const v = state.vehicleStates[vehicle];
    const status = STATUS_BY_ID[statusId];
    if (!v || !status) throw new Error("Unknown vehicle or status");
    v.teamStatus = status;
    logEventFor(vehicle, `Team set as ${status.label}`);
    return {};
  },

  ADD_CREW_MEMBER(payload) {
    const { vehicle, ssMemberId } = payload;
    const v = state.vehicleStates[vehicle];
    const member = state.ssMembers.find((m) => m.id === ssMemberId);
    if (!v || !member) throw new Error("Unknown vehicle or SES member");
    if (v.crew.some((c) => c.id === member.id)) return {}; // already on team
    const newMember = {
      id: member.id, first: member.firstName, last: member.lastName,
      phone: member.number400, on: true, capabilities: member.capabilities || [],
    };
    v.crew.push(newMember);
    logEventFor(vehicle, `${newMember.first} ${newMember.last} added to team`);
    return {};
  },

  REMOVE_CREW_MEMBER(payload) {
    const { vehicle, memberId } = payload;
    const v = state.vehicleStates[vehicle];
    if (!v) throw new Error("Unknown vehicle");
    const member = v.crew.find((c) => c.id === memberId);
    v.crew = v.crew.filter((c) => c.id !== memberId);
    if (v.leaderId === memberId) v.leaderId = null;
    if (member) logEventFor(vehicle, `${member.first} ${member.last} removed from team`);
    return {};
  },

  SET_LEADER(payload) {
    const { vehicle, memberId } = payload;
    const v = state.vehicleStates[vehicle];
    if (!v) throw new Error("Unknown vehicle");
    const member = v.crew.find((c) => c.id === memberId);
    v.leaderId = memberId;
    if (member) logEventFor(vehicle, `${member.first} ${member.last} added to team as team leader`);
    return {};
  },

  ADD_NOTE(payload) {
    const { incidentId, text } = payload;
    if (!text || !text.trim()) return {};
    if (!state.incidentNotes[incidentId]) state.incidentNotes[incidentId] = [];
    state.incidentNotes[incidentId].unshift({
      id: `${Date.now()}-${Math.random()}`, text: text.trim(), time: new Date().toISOString(),
    });
    return {};
  },

  CREATE_SES_MEMBER(payload) {
    const member = { id: `ses-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...payload };
    state.ssMembers.unshift(member);
    return { member };
  },

  CREATE_EXTERNAL_PERSON(payload) {
    const person = {
      id: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: "Bankstown",
      ...payload,
    };
    state.externalPeople.unshift(person);
    return { person };
  },

  SET_SUBURB_ASSIGNMENT(payload) {
    const { suburb, vehicle } = payload;
    if (!SUBURBS.includes(suburb)) throw new Error("Unknown suburb");
    if (vehicle) {
      if (!VEHICLES.includes(vehicle)) throw new Error("Unknown vehicle");
      state.suburbAssignments[suburb] = vehicle;
    } else {
      delete state.suburbAssignments[suburb];
    }
    return {};
  },

  SET_AUTO_REQUEST(payload) {
    state.autoRequestNearestAsset = !!payload.value;
    return {};
  },
};

// ---------------------------------------------------------------
// HTTP SERVER
// ---------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) { req.destroy(); reject(new Error("Payload too large")); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, ngrok-skip-browser-warning");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return;
  }

  if (req.method === "POST" && url.pathname === "/action") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const handler = actions[body.type];
      if (!handler) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown action type: ${body.type}` }));
        return;
      }
      const result = handler(body.payload || {});
      saveState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result, state }));
      console.log(`[${new Date().toLocaleTimeString()}] ${body.type}`, JSON.stringify(body.payload).slice(0, 150));
    } catch (e) {
      console.error("Action failed:", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`BKK shared server running on http://localhost:${PORT}`);
  console.log(`  GET  /state   -- full current state snapshot`);
  console.log(`  POST /action  -- { type, payload } to mutate state`);
  console.log(`  GET  /health  -- connectivity check`);
  console.log(`Data persisted to: ${DATA_FILE}`);
});
