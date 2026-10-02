const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const smsMock = require("./sms-mock");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "database.json");

/** Wall-clock session length after admin ENTRY scan (QR timer). */
const SESSION_MS = 2 * 60 * 1000;
/** 1-minute warning SMS before SESSION_MS elapses. */
const WARNING_MS = 1 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SLOT_DEFS = [
  { time: "6:00–8:00 AM", cap: 100 },
  { time: "8:00–10:00 AM", cap: 100 },
  { time: "10:00 AM–12:00 PM", cap: 100 },
  { time: "12:00–2:00 PM", cap: 100 },
  { time: "2:00–4:00 PM", cap: 100 },
  { time: "4:00–6:00 PM", cap: 100 },
  { time: "6:00–8:00 PM", cap: 100 },
  { time: "8:00–10:00 PM", cap: 100 },
];

const VALID_BOOKING_STATUS = new Set([
  "confirmed",
  "active",
  "expired",
  "completed",
  "overstayed",
]);

function defaultDb() {
  return {
    nextUserId: 1,
    nextStaffId: 1,
    nextBookingId: 1,
    users: [],
    bookings: [],
    staff: [
      {
        id: 1,
        name: "Ramesh Gupta",
        position: "Gate Security",
        phone: "+91 98100 11111",
        status: "On Duty",
      },
      {
        id: 2,
        name: "Priya Sharma",
        position: "Queue Manager",
        phone: "+91 98200 22222",
        status: "On Duty",
      },
      {
        id: 3,
        name: "Arun Patel",
        position: "Zone Monitor",
        phone: "+91 98300 33333",
        status: "Break",
      },
    ],
  };
}

function normalizeBookings(data) {
  data.bookings.forEach((b) => {
    if (b.penalty === undefined || b.penalty === null) b.penalty = 0;
    if (b.entryTime === undefined) b.entryTime = null;
    if (b.expiryTime === undefined) b.expiryTime = null;
    if (b.exitTime === undefined) b.exitTime = null;
    if (!VALID_BOOKING_STATUS.has(b.status)) b.status = "confirmed";
  });
}

function ensureAdminCredentials(data) {
  if (!data.admin_username) {
    data.admin_username = process.env.ADMIN_USER || "admin";
  }
  if (!data.admin_password_hash) {
    data.admin_password_hash = bcrypt.hashSync(
      process.env.ADMIN_PASSWORD || "admin123",
      10
    );
  }
}

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    const d = defaultDb();
    d.nextStaffId = 4;
    ensureAdminCredentials(d);
    saveDb(d);
    return d;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users)) data.users = [];
    if (!Array.isArray(data.bookings)) data.bookings = [];
    if (!Array.isArray(data.staff)) data.staff = defaultDb().staff;
    if (!data.nextUserId) data.nextUserId = 1;
    if (!data.nextStaffId) data.nextStaffId = data.staff.length + 1;
    if (!data.nextBookingId) {
      data.nextBookingId =
        data.bookings.length > 0
          ? Math.max(...data.bookings.map((b) => b.id || 0)) + 1
          : 1;
    }
    ensureAdminCredentials(data);
    normalizeBookings(data);
    saveDb(data);
    return data;
  } catch {
    const d = defaultDb();
    ensureAdminCredentials(d);
    saveDb(d);
    return d;
  }
}

function localDateKeyFromIso(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function saveDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
}

let db = loadDb();

/**
 * In-memory timeouts for SMS + auto-expire. Cleared on EXIT scan or after expiry fires.
 * One pair per serial — avoids duplicate timers / leaks.
 */
const sessionTimers = new Map();

function clearSessionTimers(serial) {
  const t = sessionTimers.get(serial);
  if (!t) return;
  if (t.warningId) clearTimeout(t.warningId);
  if (t.expireId) clearTimeout(t.expireId);
  sessionTimers.delete(serial);
}

function resolvePhoneForBooking(b) {
  if (b.phone) return String(b.phone).trim();
  if (b.user_id) {
    const u = db.users.find((x) => x.id === b.user_id);
    if (u && u.phone) return String(u.phone).trim();
  }
  return null;
}

function formatIstStamp() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

let lastSentSmsHash = new Map();
const DUPLICATE_SMS_COOLDOWN_MS = 30000;

function notifyAllStaff(message, phase) {
  const now = Date.now();
  // Filter out invalid/empty phones dynamically from db.staff
  const phones = db.staff
    .map((s) => (s.phone ? String(s.phone).trim() : ""))
    .filter(Boolean);

  // Prevent identical duplicate SMS to same set of numbers within cooldown
  const hashKey = `${phase}:${message}:${phones.join(",")}`;
  const lastSent = lastSentSmsHash.get(hashKey) || 0;
  if (now - lastSent < DUPLICATE_SMS_COOLDOWN_MS) {
    console.log(`[SMS Deduplicate] Skipped duplicate alert: ${phase}`);
    return Promise.resolve({
      staffCount: phones.length,
      phonesNotified: phones,
      smsStatus: "skipped_duplicate",
      duplicateCooldown: true,
      provider: smsMock.getSmsProviderStatus(),
    });
  }
  lastSentSmsHash.set(hashKey, now);

  return smsMock.sendSmsToMany(phones, message, phase || "staff_alert").then(
    (result) => ({
      staffCount: result.staffCount,
      phonesNotified: result.phonesNotified,
      smsStatus: result.status,
      smsError: result.error,
      provider: smsMock.getSmsProviderStatus(),
    })
  );
}

/**
 * Arm exactly two timeouts per serial (warning + expiry). clearSessionTimers prevents leaks
 * and duplicate timers if ENTRY is retried (should not happen) or EXIT clears early.
 */
function scheduleSessionTimers(booking) {
  const serial = booking.serial;
  clearSessionTimers(serial);

  const phone = resolvePhoneForBooking(booking);

  void smsMock.sendSms({
    to: phone,
    message:
      "Your darshan session has started. You have 2 minutes inside — please scan exit before time runs out.",
    serial,
    phase: "entry_immediate",
  });

  const warningId = setTimeout(() => {
    const b = db.bookings.find((x) => x.serial === serial);
    if (b && b.status === "active") {
      void smsMock.sendSms({
        to: resolvePhoneForBooking(b),
        message:
          "Reminder: Your QR will become invalid within 1 minute. Please complete darshan and head to the exit gate to scan out.",
        serial,
        phase: "warning_1min",
      });
    }
  }, WARNING_MS);

  const expireId = setTimeout(() => {
    const b = db.bookings.find((x) => x.serial === serial);
    if (b && b.status === "active") {
      b.status = "expired";
      saveDb(db);
      void smsMock.sendSms({
        to: resolvePhoneForBooking(b),
        message:
          "Your darshan window ended without an exit scan. You must pay a penalty fee of ₹100 at the counter. Please scan exit at the gate to record your visit.",
        serial,
        phase: "expired_2min",
      });
    }
    clearSessionTimers(serial);
  }, SESSION_MS);

  sessionTimers.set(serial, { warningId, expireId });
}

/** If server restarts: close sessions past expiry (no SMS replay). */
function reconcileStaleActiveSessions() {
  const now = Date.now();
  let changed = false;
  db.bookings.forEach((b) => {
    if (b.status !== "active" || !b.expiryTime) return;
    const exp = new Date(b.expiryTime).getTime();
    if (now >= exp) {
      b.status = "expired";
      changed = true;
    }
  });
  if (changed) saveDb(db);
}

reconcileStaleActiveSessions();

function findBookingBySerial(serial) {
  const s = String(serial || "").trim();
  return db.bookings.find((b) => b.serial === s);
}

function bookingToAdminDto(b) {
  return {
    serial: b.serial,
    visitor_name: b.visitor_name,
    people: b.people,
    date: b.date,
    slot_time: b.slot_time,
    status: b.status,
    is_walkin: b.is_walkin,
    created_at: b.created_at,
    entryTime: b.entryTime,
    expiryTime: b.expiryTime,
    exitTime: b.exitTime,
    penalty: b.penalty,
  };
}

function getBookedBySlot(date) {
  const map = {};
  db.bookings.forEach((b) => {
    if (b.date === date) {
      map[b.slot_time] = (map[b.slot_time] || 0) + b.people;
    }
  });
  return map;
}

function slotsForDate(date) {
  const bookedMap = getBookedBySlot(date);
  return SLOT_DEFS.map((s) => ({
    time: s.time,
    cap: s.cap,
    booked: bookedMap[s.time] || 0,
  }));
}

const app = express();
app.use(express.json());
app.use(
  session({
    secret:
      process.env.SESSION_SECRET || "easy-darshan-change-me-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true },
  })
);

function currentUser(req) {
  const id = req.session && req.session.userId;
  if (!id) return null;
  return db.users.find((u) => u.id === id) || null;
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.adminLoggedIn) {
    return res.status(401).json({ error: "Admin authentication required" });
  }
  next();
}

/** Cooldown so webcam overcrowding does not spam staff every frame. */
let lastCrowdSosAt = 0;
const CROWD_SOS_COOLDOWN_MS = 45000;

app.post("/api/monitor/crowd-alert", async (req, res) => {
  const now = Date.now();
  const { count, zone, threshold, manual } = req.body || {};
  const isManual = !!manual;
  if (!isManual) {
    if (now - lastCrowdSosAt < CROWD_SOS_COOLDOWN_MS) {
      return res.json({ ok: true, notified: false, cooldown: true });
    }
    lastCrowdSosAt = now;
  }
  const z = String(zone || "Monitoring zone").trim() || "Monitoring zone";
  const c = count != null && count !== "" ? count : "?";
  const th = threshold != null && threshold !== "" ? threshold : "?";
  const time = formatIstStamp();
  const message = isManual
    ? `MANUAL SOS — Immediate assistance needed. Location: ${z}. Crowd on camera: ~${c} people (safe threshold: ${th}). Time (IST): ${time}. Action: stop entry, redirect visitors, assist crowd control.`
    : `SOS ALERT — Crowd exceeded safe threshold. Location: ${z}. Detected: ${c} people (threshold: ${th}). Time (IST): ${time}. Action: attend immediately, stop entry, and redirect crowd.`;
  const result = await notifyAllStaff(
    message,
    isManual ? "manual_sos_staff" : "crowd_sos_staff"
  );
  res.json({ ok: true, notified: true, zone: z, count: c, threshold: th, ...result });
});

app.post("/api/admin/staff/test-sms", requireAdmin, async (req, res) => {
  const time = formatIstStamp();
  const message = `TEST SMS ALERT — Easy Darshan Staff Notification System Operational. Time (IST): ${time}.`;
  const result = await notifyAllStaff(message, "staff_test_sms");
  res.json({ ok: true, message: "Test SMS triggered to all staff members", ...result });
});

app.post("/api/admin/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = String(username || "").trim();
  const p = String(password || "");
  if (!u || !p) {
    return res.status(400).json({ error: "Credentials required" });
  }
  if (
    u !== db.admin_username ||
    !bcrypt.compareSync(p, db.admin_password_hash)
  ) {
    return res.status(401).json({ error: "Invalid admin credentials" });
  }
  req.session.adminLoggedIn = true;
  req.session.adminUsername = u;
  res.json({ ok: true, username: u });
});

app.get("/api/admin/auth/me", (req, res) => {
  res.json({
    admin: !!(req.session && req.session.adminLoggedIn),
    username: (req.session && req.session.adminUsername) || null,
  });
});

app.post("/api/admin/auth/logout", (req, res) => {
  req.session.adminLoggedIn = false;
  delete req.session.adminUsername;
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({
    user: {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      email: u.email,
      phone: u.phone,
    },
  });
});

app.post("/api/auth/register", (req, res) => {
  const { username, password, full_name, email, phone } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  const un = String(username).trim();
  if (db.users.some((x) => x.username.toLowerCase() === un.toLowerCase())) {
    return res.status(409).json({ error: "Username already taken" });
  }
  const hash = bcrypt.hashSync(password, 10);
  const user = {
    id: db.nextUserId++,
    username: un,
    password_hash: hash,
    full_name: full_name || null,
    email: email || null,
    phone: phone || null,
  };
  db.users.push(user);
  saveDb(db);
  req.session.userId = user.id;
  res.json({
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      email: user.email,
      phone: user.phone,
    },
  });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }
  const row = db.users.find(
    (u) => u.username.toLowerCase() === String(username).trim().toLowerCase()
  );
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  req.session.userId = row.id;
  res.json({
    user: {
      id: row.id,
      username: row.username,
      full_name: row.full_name,
      email: row.email,
      phone: row.phone,
    },
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/slots", (req, res) => {
  const date =
    (req.query.date && String(req.query.date)) ||
    new Date().toISOString().split("T")[0];
  res.json(slotsForDate(date));
});

app.post("/api/bookings", (req, res) => {
  const { visitor_name, people, date, phone, slot_time, is_walkin } =
    req.body || {};
  const walkin = !!is_walkin;
  if (!walkin && !currentUser(req)) {
    return res.status(401).json({ error: "Please sign in to book a slot" });
  }
  const ppl = parseInt(people, 10);
  if (!visitor_name || !date || !slot_time || !ppl || ppl < 1 || ppl > 4) {
    return res.status(400).json({ error: "Invalid booking data" });
  }
  const def = SLOT_DEFS.find((s) => s.time === slot_time);
  if (!def) return res.status(400).json({ error: "Unknown slot" });

  const slot = slotsForDate(date).find((s) => s.time === slot_time);
  if (!slot) return res.status(400).json({ error: "Slot not found" });
  if (slot.booked + ppl > slot.cap) {
    return res.status(409).json({ error: "Slot full" });
  }

  const serial = "ED" + Date.now().toString().slice(-6);
  const user = currentUser(req);
  const booking = {
    id: db.nextBookingId++,
    user_id: user ? user.id : null,
    visitor_name: String(visitor_name).trim(),
    phone: phone ? String(phone).trim() : null,
    people: ppl,
    date,
    slot_time,
    serial,
    status: "confirmed",
    is_walkin: is_walkin ? 1 : 0,
    created_at: new Date().toISOString(),
    entryTime: null,
    expiryTime: null,
    exitTime: null,
    penalty: 0,
  };
  db.bookings.push(booking);
  saveDb(db);

  res.json({
    booking: {
      name: booking.visitor_name,
      people: String(booking.people),
      date,
      phone: phone || "",
      slot: slot_time,
      serial,
    },
  });
});

app.get("/api/bookings/mine", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const rows = db.bookings
    .filter((b) => b.user_id === user.id)
    .sort((a, b) => b.id - a.id)
    .map((b) => ({
      serial: b.serial,
      visitor_name: b.visitor_name,
      people: b.people,
      date: b.date,
      slot_time: b.slot_time,
      status: b.status,
      created_at: b.created_at,
      entryTime: b.entryTime,
      expiryTime: b.expiryTime,
      penalty: b.penalty,
    }));
  res.json({ bookings: rows });
});

/** Logged-in visitor: current in-temple session after gate ENTRY scan (for UI countdown). */
app.get("/api/bookings/active-session", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const b = db.bookings.find(
    (x) => x.user_id === user.id && x.status === "active"
  );
  if (!b || !b.expiryTime) return res.json({ active: null });
  res.json({
    active: {
      serial: b.serial,
      visitor_name: b.visitor_name,
      entryTime: b.entryTime,
      expiryTime: b.expiryTime,
    },
  });
});

app.get("/api/admin/bookings", requireAdmin, (req, res) => {
  const rows = db.bookings
    .slice()
    .sort((a, b) => b.id - a.id)
    .slice(0, 200)
    .map((b) => bookingToAdminDto(b));
  res.json({ bookings: rows });
});

/** Admin: ENTRY scan — start 2-minute session + SMS schedule. */
app.post("/api/admin/scan-entry", requireAdmin, (req, res) => {
  const { serial } = req.body || {};
  const s = String(serial || "").trim();
  if (!s) return res.status(400).json({ error: "Serial required" });

  const b = findBookingBySerial(s);
  if (!b) return res.status(404).json({ error: "Booking not found" });

  if (b.status === "active") {
    return res.status(409).json({ error: "Already scanned in (session active)" });
  }
  if (b.status === "expired") {
    return res
      .status(409)
      .json({ error: "QR expired. Visitor must use a new booking." });
  }
  if (b.status === "completed" || b.status === "overstayed") {
    return res.status(409).json({ error: "This QR has already been used (exit done)" });
  }
  if (b.status !== "confirmed") {
    return res.status(409).json({ error: "Invalid state for entry scan" });
  }

  const now = Date.now();
  b.entryTime = new Date(now).toISOString();
  b.expiryTime = new Date(now + SESSION_MS).toISOString();
  b.status = "active";
  b.penalty = 0;
  saveDb(db);

  scheduleSessionTimers(b);

  res.json({
    ok: true,
    booking: bookingToAdminDto(b),
    message: "Entry recorded. 2-minute session started.",
  });
});

/**
 * EXIT: if now > expiryTime → overstayed + ₹100; else completed.
 * Still allowed when status is "expired" (2-min auto-expire) so gate can record one final exit.
 */
app.post("/api/admin/scan-exit", requireAdmin, (req, res) => {
  const { serial } = req.body || {};
  const s = String(serial || "").trim();
  if (!s) return res.status(400).json({ error: "Serial required" });

  const b = findBookingBySerial(s);
  if (!b) return res.status(404).json({ error: "Booking not found" });

  if (b.status === "confirmed") {
    return res.status(409).json({ error: "Scan entry first" });
  }
  if (b.status === "completed" || b.status === "overstayed") {
    return res.status(409).json({ error: "Exit already recorded for this QR" });
  }

  if (b.status !== "active" && b.status !== "expired") {
    return res.status(409).json({ error: "Invalid state for exit scan" });
  }

  const now = Date.now();
  const expiryMs = b.expiryTime ? new Date(b.expiryTime).getTime() : now;
  clearSessionTimers(b.serial);
  b.exitTime = new Date().toISOString();

  if (now > expiryMs) {
    b.status = "overstayed";
    b.penalty = 100;
    saveDb(db);
    return res.json({
      ok: true,
      booking: bookingToAdminDto(b),
      penaltyApplied: true,
      penalty: 100,
      message:
        "Your visit exceeded the allowed time. You must pay ₹100 penalty.",
    });
  }

  b.status = "completed";
  b.penalty = 0;
  saveDb(db);
  res.json({
    ok: true,
    booking: bookingToAdminDto(b),
    penaltyApplied: false,
    penalty: 0,
    message: "Exit recorded. Thank you for visiting.",
  });
});

/** Active = inside 2-min window; expired = auto after 2 min without exit; overstayed = exit after expiry. */
app.get("/api/admin/qr-dashboard", requireAdmin, (req, res) => {
  const active = db.bookings
    .filter((b) => b.status === "active")
    .map(bookingToAdminDto);
  const expired = db.bookings
    .filter((b) => b.status === "expired")
    .map(bookingToAdminDto);
  const overstayed = db.bookings
    .filter((b) => b.status === "overstayed")
    .map(bookingToAdminDto);
  res.json({ active, expired, overstayed });
});

app.get("/api/admin/sms-log", requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);
  res.json({
    messages: smsMock.getSmsLog(limit),
    provider: smsMock.getSmsProviderStatus(),
  });
});

app.get("/api/admin/slots-summary", requireAdmin, (req, res) => {
  const date =
    (req.query.date && String(req.query.date)) ||
    new Date().toISOString().split("T")[0];
  res.json({ date, slots: slotsForDate(date) });
});

app.get("/api/staff", requireAdmin, (req, res) => {
  const rows = db.staff.map((s) => ({
    id: s.id,
    name: s.name,
    position: s.position,
    phone: s.phone,
    status: s.status,
  }));
  res.json({ staff: rows, sms: smsMock.getSmsProviderStatus() });
});

app.post("/api/staff", requireAdmin, (req, res) => {
  const { name, position, phone } = req.body || {};
  if (!name || !phone) {
    return res.status(400).json({ error: "Name and phone required" });
  }
  const row = {
    id: db.nextStaffId++,
    name: String(name).trim(),
    position: position || "Staff",
    phone: String(phone).trim(),
    status: "On Duty",
  };
  db.staff.push(row);
  saveDb(db);
  res.json({ staff: row });
});

app.delete("/api/staff/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.staff = db.staff.filter((s) => s.id !== id);
  saveDb(db);
  res.json({ ok: true });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const todayBookings = db.bookings.filter((b) => b.date === today);
  const totalBookingsToday = todayBookings.length;
  const peopleBookedToday = todayBookings.reduce((s, b) => s + b.people, 0);
  const slots = slotsForDate(today);
  res.json({
    today,
    bookingsToday: totalBookingsToday,
    peopleBookedToday,
    openSlots: slots.filter((s) => s.booked < s.cap).length,
    fullSlots: slots.filter((s) => s.booked >= s.cap).length,
  });
});

app.get("/api/admin/analytics", requireAdmin, (req, res) => {
  const dateStr =
    (req.query.date && String(req.query.date)) ||
    new Date().toISOString().split("T")[0];
  const slotLabels = SLOT_DEFS.map((s) => s.time);
  const slotIndex = Object.fromEntries(
    slotLabels.map((t, i) => [t, i])
  );
  const entries = slotLabels.map(() => 0);
  const exits = slotLabels.map(() => 0);
  db.bookings.forEach((b) => {
    const si = slotIndex[b.slot_time];
    if (si === undefined) return;
    if (b.entryTime && localDateKeyFromIso(b.entryTime) === dateStr) {
      entries[si] += b.people || 1;
    }
    if (b.exitTime && localDateKeyFromIso(b.exitTime) === dateStr) {
      exits[si] += b.people || 1;
    }
  });
  const max = Math.max(1, ...entries, ...exits);
  const totalIn = entries.reduce((s, n) => s + n, 0);
  const totalOut = exits.reduce((s, n) => s + n, 0);
  let peakIdx = 0;
  entries.forEach((v, i) => {
    if (v > entries[peakIdx]) peakIdx = i;
  });
  const bookingsThatDay = db.bookings.filter((b) => b.date === dateStr).length;
  const bookingsWithScans = db.bookings.filter((b) => {
    const inDay = b.entryTime && localDateKeyFromIso(b.entryTime) === dateStr;
    const outDay = b.exitTime && localDateKeyFromIso(b.exitTime) === dateStr;
    return inDay || outDay;
  }).length;

  const slotBreakdown = slotLabels.map((slot, i) => {
    const en = entries[i] || 0;
    const ex = exits[i] || 0;
    const net = en - ex;
    const cap = SLOT_DEFS[i] ? SLOT_DEFS[i].cap : 100;
    return {
      slot,
      entries: en,
      exits: ex,
      net,
      capacity: cap,
      occupancyPct: Math.min(100, Math.round((en / cap) * 100)),
    };
  });

  res.json({
    labels: slotLabels,
    entries,
    exits,
    max,
    date: dateStr,
    granularity: "booking_slot",
    totalIn,
    totalOut,
    stillInside: Math.max(0, totalIn - totalOut),
    peakSlot: {
      label: slotLabels[peakIdx] || "",
      entries: entries[peakIdx] || 0,
      exits: exits[peakIdx] || 0,
    },
    bookingsThatDay,
    bookingsWithScans,
    slotBreakdown,
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Easy Darshan server http://localhost:${PORT}`);
});
