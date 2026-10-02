/* Easy Darshan – client app (wired to Express + JSON file API) */

let qrDashboardPoll = null;
let bookingDatePicker = null;

const state = {
  currentPage: "home",
  selectedSlot: null,
  slotsFromServer: [],
  notifications: [],
  currentBooking: null,
  personCount: 0,
  cocoModel: null,
  cameraStream: null,
  heatmapTimer: null,
  adminBookingsRaw: [],
  adminLoggedIn: false,
  userLoggedIn: false,
  currentUser: null,
  adminActivePanel: "overview",
  tzmCounts: null,
  _lastCrowdSosClientAt: 0,
  darshanMinuteWarnedSerial: null,
  activeSessionSerial: null,
  activeSessionExpiryMs: null,
  activeSessionStartMs: null,
};

let activeSessionPollTimer = null;
let darshanTickTimer = null;

let adminHtml5Qr = null;
let adminQrScanBusy = false;
const ADMIN_QR_DEBOUNCE_MS = 1500;
let _lastAdminQrDecode = { text: "", at: 0 };

/** Temple zone map grid (matches reference layout). */
const TZM_ZONES = [
  "Main Entrance",
  "Inner Sanctum",
  "Pradakshina Path",
  "Mandap Area",
  "Queue Lane A",
  "Queue Lane B",
  "Prasad Counter",
  "Exit Gate",
];

const ZONES = [
  "Main Sanctum",
  "Entry Gate",
  "Prasad Queue",
  "Circumambulation",
  "Side Halls",
  "Gardens",
];

/** Align with server CROWD_SOS_COOLDOWN_MS so we do not spam the endpoint. */
const CROWD_SOS_CLIENT_COOLDOWN_MS = 45000;

const TRANSLATIONS = {
  en: {
    hero_title: "EASY DARSHAN\nSmart Temple Management",
    hero_desc:
      "AI-powered crowd control, QR slot booking, and real-time monitoring for a safe and seamless darshan experience.",
  },
  hi: {
    hero_title: "ईज़ी दर्शन\nस्मार्ट मंदिर प्रबंधन",
    hero_desc:
      "AI-आधारित भीड़ नियंत्रण, QR स्लॉट बुकिंग और रियल-टाइम मॉनिटरिंग के साथ सुरक्षित दर्शन।",
  },
  mr: {
    hero_title: "इझी दर्शन\nस्मार्ट मंदिर व्यवस्थापन",
    hero_desc:
      "AI-आधारित गर्दी नियंत्रण, QR स्लॉट बुकिंग आणि रिअल-टाइम देखरेखीसह सुरक्षित दर्शन.",
  },
};

const FAQ_QA = {
  "Is booking mandatory?":
    "Yes, booking is mandatory for a smooth darshan experience. Walk-ins may be accepted if capacity permits, but booking guarantees your entry.",
  "Can I book for multiple family members?":
    "Absolutely! One QR covers up to 4 people. All family members enter together with a single QR code under your booking.",
  "What if my phone battery dies?":
    "We recommend carrying a power bank. You can also take a screenshot of the QR, or note your booking serial number to request a re-print at the Help Desk.",
  "How early should I arrive?":
    "Please arrive 10–15 minutes before your slot. The gate opens 5 minutes before the slot start time.",
  "Can QR code be reused?":
    "No. The QR becomes invalid once the exit scan is completed. A new booking is required for each visit.",
  "What happens at the temple gate?":
    "Staff scans your QR in Admin: ENTRY starts a 2-minute darshan window with SMS reminders; EXIT must happen before expiry or a ₹100 penalty applies.",
  "Can I modify booking?":
    "Contact the admin help desk at least 1 hour before your slot. Modifications are subject to slot availability.",
  "What does the heatmap show?":
    "The heatmap displays real-time crowd density across temple zones using color codes: Green (Low), Yellow (Medium), Red (High).",
  "How to book a slot?":
    "Go to Slot Booking → Fill your details → Select an available time slot → Confirm to get your QR code.",
  "QR validity?":
    "After staff ENTRY scan you have 2 minutes inside; after that the QR becomes invalid for re-entry until staff records EXIT.",
  "Penalty rules?":
    "If EXIT is scanned after the 2-minute expiry time, a ₹100 penalty is recorded and you will see a notice at the gate.",
  "Check crowd levels":
    "Current crowd is at 34% capacity. Main Sanctum has medium density. Best time to visit: 12:00 PM – 3:00 PM today.",
  "Family booking details":
    "One booking = 1 QR code = up to 4 people. All members must enter and exit together. Individual splits are not allowed.",
};

async function api(path, options = {}) {
  const opts = {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  };
  if (opts.body && typeof opts.body === "object") {
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showPage(id) {
  if (id === "admin" && !state.adminLoggedIn) {
    id = "admin-login";
  }

  if ((id === "booking" || id === "monitor") && !state.userLoggedIn) {
    showToast("Please sign in to access this page", "warning");
    id = "auth";
  }

  if (id !== "admin" && id !== "admin-login") {
    stopAdminQrScanner();
  }

  document.querySelectorAll(".page").forEach((p) => {
    p.classList.remove("active");
    p.classList.remove("tzm-page-active");
  });
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  const pageEl = document.getElementById("page-" + id);
  if (pageEl) {
    pageEl.classList.add("active");
    if (id === "heatmap") pageEl.classList.add("tzm-page-active");
  }
  const btns = document.querySelectorAll(".nav-btn");
  btns.forEach((b) => {
    if (b.textContent.toLowerCase().includes(id.substring(0, 4)))
      b.classList.add("active");
  });
  if (id === "admin-login" || id === "admin") {
    const navAd = document.getElementById("nav-admin-btn");
    if (navAd) navAd.classList.add("active");
  }
  state.currentPage = id;

  if (id !== "admin") stopQrDashboardPoll();

  if (id === "booking") initBookingSlots();
  if (id === "heatmap") initHeatmap();
  if (id === "chatbot") initChatbot();
  if (id === "admin") initAdmin();
  if (id === "monitor") initMonitorZones();
}

function openAdminGate() {
  showPage(state.adminLoggedIn ? "admin" : "admin-login");
}

async function doAdminLogin() {
  const u = document.getElementById("admin-login-user").value;
  const p = document.getElementById("admin-login-pass").value;
  if (!u || !p) {
    showToast("Enter admin username and password", "warning");
    return;
  }
  try {
    await api("/api/admin/auth/login", {
      method: "POST",
      body: { username: u, password: p },
    });
    state.adminLoggedIn = true;
    document.getElementById("admin-login-pass").value = "";
    showToast("✅ Admin access granted");
    showPage("admin");
  } catch (e) {
    showToast(e.message || "Admin login failed", "error");
  }
}

async function doAdminLogout() {
  try {
    await api("/api/admin/auth/logout", { method: "POST" });
  } catch (e) {
    /* ignore */
  }
  state.adminLoggedIn = false;
  showToast("Logged out of admin");
  showPage("home");
}

async function refreshAdminSession() {
  try {
    const r = await api("/api/admin/auth/me");
    state.adminLoggedIn = !!r.admin;
  } catch (e) {
    state.adminLoggedIn = false;
  }
}

async function refreshUserSession() {
  try {
    const r = await api("/api/me");
    state.userLoggedIn = !!(r && r.user);
    state.currentUser = (r && r.user) || null;
  } catch (e) {
    state.userLoggedIn = false;
    state.currentUser = null;
  }
  updateNavUserUi();
  syncActiveSessionPolling();
}

function updateNavUserUi() {
  const lo = document.getElementById("nav-user-logout");
  if (lo) lo.style.display = state.userLoggedIn ? "inline-flex" : "none";
}

async function goUserPage(pageId) {
  await refreshUserSession();
  if (
    (pageId === "booking" || pageId === "monitor") &&
    !state.userLoggedIn
  ) {
    showToast(
      "Please sign in to use " +
        (pageId === "booking" ? "Slot Booking" : "Monitoring"),
      "warning"
    );
    showPage("auth");
    return;
  }
  showPage(pageId);
}

async function doUserLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (e) {
    /* ignore */
  }
  state.userLoggedIn = false;
  state.currentUser = null;
  updateNavUserUi();
  syncActiveSessionPolling();
  showToast("Signed out");
  showPage("home");
}

function stopQrDashboardPoll() {
  if (qrDashboardPoll) {
    clearInterval(qrDashboardPoll);
    qrDashboardPoll = null;
  }
}

function stopActiveSessionPolling() {
  if (activeSessionPollTimer) {
    clearInterval(activeSessionPollTimer);
    activeSessionPollTimer = null;
  }
}

function stopDarshanTick() {
  if (darshanTickTimer) {
    clearInterval(darshanTickTimer);
    darshanTickTimer = null;
  }
}

function hideDarshanSessionBar() {
  stopDarshanTick();
  state.darshanMinuteWarnedSerial = null;
  const bar = document.getElementById("darshan-session-bar");
  if (bar) {
    bar.style.display = "none";
    bar.classList.remove("darshan-session-bar--warning");
  }
  document.body.classList.remove("has-darshan-bar");
  state.activeSessionSerial = null;
  state.activeSessionExpiryMs = null;
  state.activeSessionStartMs = null;
}

function showDarshanSessionBar() {
  const bar = document.getElementById("darshan-session-bar");
  if (bar) bar.style.display = "block";
  document.body.classList.add("has-darshan-bar");
}

function syncActiveSessionPolling() {
  stopActiveSessionPolling();
  stopDarshanTick();
  if (!state.userLoggedIn) {
    hideDarshanSessionBar();
    return;
  }
  pollActiveSession();
  activeSessionPollTimer = setInterval(pollActiveSession, 3000);
}

async function pollActiveSession() {
  if (!state.userLoggedIn) return;
  try {
    const r = await api("/api/bookings/active-session");
    const a = r.active;
    if (a && a.expiryTime) {
      const expMs = new Date(a.expiryTime).getTime();
      const startMs = a.entryTime
        ? new Date(a.entryTime).getTime()
        : expMs - 2 * 60 * 1000;
      if (state.activeSessionSerial !== a.serial) {
        state.darshanMinuteWarnedSerial = null;
      }
      state.activeSessionSerial = a.serial;
      state.activeSessionExpiryMs = expMs;
      state.activeSessionStartMs = startMs;
      showDarshanSessionBar();
      if (!darshanTickTimer) {
        darshanTickTimer = setInterval(updateDarshanSessionUi, 1000);
      }
      updateDarshanSessionUi();
    } else {
      state.darshanMinuteWarnedSerial = null;
      hideDarshanSessionBar();
    }
  } catch (e) {
    if (e.status === 401) hideDarshanSessionBar();
  }
}

function updateDarshanSessionUi() {
  const exp = state.activeSessionExpiryMs;
  const start = state.activeSessionStartMs;
  if (exp == null) return;
  const left = exp - Date.now();
  const cdEl = document.getElementById("darshan-session-countdown");
  const barEl = document.getElementById("darshan-session-bar");
  const hintEl = document.getElementById("darshan-session-hint");
  const progEl = document.getElementById("darshan-session-progress");
  const total = Math.max(1, exp - (start || exp - 120000));

  if (left <= 0) {
    if (cdEl) cdEl.textContent = "0:00";
    if (progEl) progEl.style.width = "0%";
    stopDarshanTick();
    void pollActiveSession();
    return;
  }

  const pct = Math.min(100, Math.max(0, (left / total) * 100));
  if (progEl) progEl.style.width = pct + "%";
  const sec = Math.ceil(left / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (cdEl) cdEl.textContent = m + ":" + String(s).padStart(2, "0");

  if (left <= 60000) {
    if (barEl) barEl.classList.add("darshan-session-bar--warning");
    if (hintEl) {
      hintEl.textContent =
        "Less than 1 minute left — please scan exit at the gate now to avoid the ₹100 penalty.";
    }
    if (state.darshanMinuteWarnedSerial !== state.activeSessionSerial) {
      state.darshanMinuteWarnedSerial = state.activeSessionSerial;
      playAudioBeep("warning");
      addNotification(
        "⏱️",
        "1 minute remaining",
        "Scan exit at the gate before time ends to avoid the ₹100 penalty."
      );
      showToast(
        "1 minute left — scan exit at the gate to avoid ₹100 penalty",
        "warning"
      );
    }
  } else {
    if (barEl) barEl.classList.remove("darshan-session-bar--warning");
    if (hintEl) {
      hintEl.textContent =
        "Staff scanned your entry. Complete exit scan at the gate before the timer ends to avoid a ₹100 penalty.";
    }
  }
}

function switchAuth(tab) {
  document.getElementById("login-form").style.display =
    tab === "login" ? "block" : "none";
  document.getElementById("signup-form").style.display =
    tab === "signup" ? "block" : "none";
  document.getElementById("tab-login").classList.toggle("active", tab === "login");
  document.getElementById("tab-signup").classList.toggle("active", tab === "signup");
}

async function doLogin() {
  const u = document.getElementById("login-user").value;
  const p = document.getElementById("login-pass").value;
  if (!u || !p) {
    showToast("⚠️ Please fill all fields", "warning");
    return;
  }
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: { username: u, password: p },
    });
    state.userLoggedIn = true;
    state.currentUser = data.user || null;
    updateNavUserUi();
    syncActiveSessionPolling();
    showToast("✅ Welcome back, " + u + "!");
    addNotification("🔑", "Login successful", "Welcome to Easy Darshan");
    setTimeout(() => showPage("booking"), 800);
  } catch (e) {
    showToast("❌ " + (e.message || "Login failed"), "error");
  }
}

async function doSignup() {
  const name = document.getElementById("sig-name").value;
  const email = document.getElementById("sig-email").value;
  const phone = document.getElementById("sig-phone").value;
  const user = document.getElementById("sig-user").value;
  const pass = document.getElementById("sig-pass").value;
  const cpass = document.getElementById("sig-cpass").value;
  if (!name || !user || !pass) {
    showToast("⚠️ Please fill required fields", "warning");
    return;
  }
  if (pass !== cpass) {
    showToast("❌ Passwords do not match", "error");
    return;
  }
  try {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: {
        username: user,
        password: pass,
        full_name: name,
        email,
        phone,
      },
    });
    state.userLoggedIn = true;
    state.currentUser = data.user || null;
    updateNavUserUi();
    syncActiveSessionPolling();
    showToast("✅ Account created! You are signed in.");
    addNotification("👤", "Account created", "Welcome, " + name + "!");
    setTimeout(() => showPage("booking"), 600);
  } catch (e) {
    showToast("❌ " + (e.message || "Signup failed"), "error");
  }
}

async function fetchSlotsForDate(dateStr) {
  const data = await api("/api/slots?date=" + encodeURIComponent(dateStr));
  state.slotsFromServer = data;
  return data;
}

async function initBookingSlots() {
  const dateInput = document.getElementById("b-date");
  const todayStr = new Date().toISOString().split("T")[0];

  if (!dateInput._fpInited) {
    dateInput._fpInited = true;
    if (typeof flatpickr !== "undefined") {
      const maxD = new Date();
      maxD.setDate(maxD.getDate() + 90);
      bookingDatePicker = flatpickr(dateInput, {
        minDate: "today",
        maxDate: maxD,
        dateFormat: "Y-m-d",
        defaultDate: todayStr,
        disableMobile: true,
        onChange: () => loadSlotsForSelectedDate(),
      });
    } else {
      dateInput.type = "date";
      dateInput.value = todayStr;
      dateInput.min = todayStr;
      dateInput.max = new Date(Date.now() + 90 * 864e5).toISOString().split("T")[0];
      dateInput.addEventListener("change", () => loadSlotsForSelectedDate());
    }
  }

  await loadSlotsForSelectedDate();
}

async function loadSlotsForSelectedDate() {
  const dateInput = document.getElementById("b-date");
  const dateVal = dateInput.value || new Date().toISOString().split("T")[0];

  const container = document.getElementById("slots-container");
  container.innerHTML =
    '<div style="color:var(--muted);grid-column:1/-1;">Loading slots…</div>';
  state.selectedSlot = null;

  try {
    const slots = await fetchSlotsForDate(dateVal);
    container.innerHTML = "";
    slots.forEach((s, i) => {
      const avail = s.cap - s.booked;
      const full = avail <= 0;
      const low = avail < 20 && avail > 0;
      const div = document.createElement("div");
      div.className = "slot-card" + (full ? " full" : "");
      div.innerHTML = `
      <div class="slot-time">${s.time}</div>
      <div class="slot-avail ${low ? "low" : ""}">${full ? "No seats" : avail + " seats left"}</div>
      <span class="slot-badge ${full ? "badge-full" : low ? "badge-few" : "badge-available"}">
        ${full ? "FULL" : low ? "FEW LEFT" : "AVAILABLE"}
      </span>`;
      if (!full) div.onclick = () => selectSlot(i, div, s.time);
      container.appendChild(div);
    });
  } catch (e) {
    if (e.status === 401) {
      state.userLoggedIn = false;
      updateNavUserUi();
      showToast("Please sign in to view slots", "warning");
      showPage("auth");
      return;
    }
    container.innerHTML =
      '<div class="alert-box alert-danger" style="grid-column:1/-1;">Could not load slots. Is the server running?</div>';
  }
}

function selectSlot(idx, el, time) {
  document.querySelectorAll(".slot-card").forEach((c) => c.classList.remove("selected"));
  el.classList.add("selected");
  state.selectedSlot = { index: idx, time };
  document.getElementById("slot-full-msg").style.display = "none";
}

async function generateBooking() {
  const name = document.getElementById("b-name").value;
  const people = document.getElementById("b-people").value;
  const date = document.getElementById("b-date").value;
  const phone = document.getElementById("b-phone").value;

  if (!name) {
    showToast("⚠️ Please enter visitor name", "warning");
    return;
  }
  if (!state.selectedSlot) {
    showToast("⚠️ Please select a time slot", "warning");
    return;
  }

  try {
    const { booking } = await api("/api/bookings", {
      method: "POST",
      body: {
        visitor_name: name,
        people: parseInt(people, 10),
        date,
        phone,
        slot_time: state.selectedSlot.time,
      },
    });

    state.currentBooking = booking;
    document.getElementById("booking-form-section").style.display = "none";
    document.getElementById("qr-result-section").style.display = "block";
    renderBookingQR(booking.serial);

    document.getElementById("qr-info-display").innerHTML = `
    <div class="qr-field"><div class="qr-field-label">VISITOR NAME</div><div class="qr-field-val">${booking.name}</div></div>
    <div class="qr-field"><div class="qr-field-label">SERIAL NO.</div><div class="qr-field-val">${booking.serial}</div></div>
    <div class="qr-field"><div class="qr-field-label">PEOPLE</div><div class="qr-field-val">${booking.people}</div></div>
    <div class="qr-field"><div class="qr-field-label">SLOT TIME</div><div class="qr-field-val">${booking.slot}</div></div>
    <div class="qr-field"><div class="qr-field-label">DATE</div><div class="qr-field-val">${booking.date}</div></div>
    <div class="qr-field"><div class="qr-field-label">STATUS</div><div class="qr-field-val text-green">✅ Confirmed</div></div>`;

    addNotification(
      "📅",
      "Booking Confirmed!",
      `Slot: ${booking.slot} | Serial: ${booking.serial}`
    );
    showToast("✅ Booking confirmed! QR generated.");

    const heatEl = document.getElementById("tzm-total");
    const inside = heatEl
      ? parseInt(String(heatEl.textContent).replace(/,/g, ""), 10) || 323
      : 323;
    const rate = 25;
    const wait = Math.round((inside / rate) * 10);
    document.getElementById("expected-darshan").style.display = "block";
    document.getElementById("expected-darshan").innerHTML =
      `⏱️ Your expected darshan time is approximately <strong>${wait} minutes</strong> based on current crowd of ${inside} visitors.`;
  } catch (e) {
    if (e.status === 401) {
      state.userLoggedIn = false;
      updateNavUserUi();
      showToast("Please sign in to complete booking", "warning");
      showPage("auth");
      return;
    }
    if (e.status === 409) {
      document.getElementById("slot-full-msg").style.display = "block";
    }
    showToast("❌ " + (e.message || "Booking failed"), "error");
  }
}

/** Encode only the booking serial for a small, reliable, scannable QR. */
function renderBookingQR(serial, containerOrId) {
  const container =
    typeof containerOrId === "string"
      ? document.getElementById(containerOrId)
      : containerOrId || document.getElementById("qr-canvas");
  if (!container) return;
  container.innerHTML = "";
  const text = String(serial || "").trim();
  if (!text) return;

  if (typeof QRCode !== "undefined") {
    try {
      new QRCode(container, {
        text,
        width: 240,
        height: 240,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H,
      });
      return;
    } catch (err) {
      console.warn("QRCode.js:", err);
    }
  }

  const img = document.createElement("img");
  img.alt = "Booking QR";
  img.width = 220;
  img.height = 220;
  img.src =
    "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" +
    encodeURIComponent(text);
  img.style.background = "#fff";
  img.style.padding = "8px";
  img.style.borderRadius = "12px";
  container.appendChild(img);
}

function downloadQR() {
  const canvas = document.querySelector("#qr-canvas canvas");
  const img = document.querySelector("#qr-canvas img");
  let dataUrl = null;
  if (canvas) dataUrl = canvas.toDataURL("image/png");
  else if (img && img.src.startsWith("data:")) dataUrl = img.src;
  if (!dataUrl && img) {
    showToast("Open image in new tab to save, or use screenshot", "warning");
    return;
  }
  if (!dataUrl) {
    showToast("No QR to download", "warning");
    return;
  }
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = "easy-darshan-qr.png";
  a.click();
  showToast("⬇ QR downloaded");
}

async function resetBooking() {
  state.selectedSlot = null;
  state.currentBooking = null;
  document.getElementById("booking-form-section").style.display = "block";
  document.getElementById("qr-result-section").style.display = "none";
  document.getElementById("b-name").value = "";
  await initBookingSlots();
}

function tzmLevelForCount(n) {
  if (n <= 30) return "low";
  if (n <= 60) return "medium";
  return "high";
}

function renderTempleZoneMap() {
  const grid = document.getElementById("tzm-zone-grid");
  if (!grid) return;

  if (!state.tzmCounts || state.tzmCounts.length !== TZM_ZONES.length) {
    state.tzmCounts = TZM_ZONES.map(() => Math.round(10 + Math.random() * 72));
  } else {
    state.tzmCounts = state.tzmCounts.map((c) =>
      Math.max(5, Math.min(95, c + Math.round((Math.random() - 0.45) * 12)))
    );
  }

  let total = 0;
  let highAlert = 0;
  grid.innerHTML = "";

  TZM_ZONES.forEach((name, i) => {
    const count = state.tzmCounts[i];
    total += count;
    const level = tzmLevelForCount(count);
    if (level === "high") highAlert += 1;
    const barPct = Math.min(100, Math.round((count / 80) * 100));
    const label = level === "low" ? "● LOW" : level === "medium" ? "● MEDIUM" : "● HIGH";

    const card = document.createElement("div");
    card.className = "tzm-card " + level;
    card.innerHTML = `
      <div class="tzm-card-name">${name}</div>
      <div class="tzm-card-count">${count}</div>
      <div class="tzm-card-status">${label}</div>
      <div class="tzm-card-bar"><div class="tzm-card-bar-fill" style="width:${barPct}%"></div></div>
    `;
    grid.appendChild(card);
  });

  const avgDensity = Math.round((total / (TZM_ZONES.length * 80)) * 100);
  const totalEl = document.getElementById("tzm-total");
  const avgEl = document.getElementById("tzm-avg-density");
  const hiEl = document.getElementById("tzm-high-alert");
  if (totalEl) totalEl.textContent = total.toLocaleString();
  if (avgEl) avgEl.textContent = Math.min(100, avgDensity) + "%";
  if (hiEl) hiEl.textContent = String(highAlert);
}

function initHeatmap() {
  renderTempleZoneMap();
  if (state.heatmapTimer) clearInterval(state.heatmapTimer);
  state.heatmapTimer = setInterval(() => {
    if (state.currentPage === "heatmap") renderTempleZoneMap();
  }, 10000);
}

function refreshHeatmap() {
  renderTempleZoneMap();
  showToast("🔄 Zone map refreshed");
}

function initChatbot() {
  const fc = document.getElementById("faq-chips");
  if (fc.children.length > 0) return;
  Object.keys(FAQ_QA).forEach((q) => {
    const chip = document.createElement("button");
    chip.className = "faq-chip";
    chip.textContent = q;
    chip.onclick = () => handleFAQ(q);
    fc.appendChild(chip);
  });
}

function handleFAQ(q) {
  appendMsg(q, "user");
  setTimeout(
    () =>
      appendMsg(
        FAQ_QA[q] ||
          "I'll check that for you! Please contact the Help Desk at the temple entrance.",
        "bot"
      ),
    500
  );
}

function sendChat() {
  const inp = document.getElementById("chat-input");
  const q = inp.value.trim();
  if (!q) return;
  inp.value = "";
  appendMsg(q, "user");

  const lower = q.toLowerCase();
  let reply =
    "I understand your query! For specific help, please visit our Help Desk at the temple entrance, or call our support line. 🙏";

  Object.keys(FAQ_QA).forEach((k) => {
    if (lower.includes(k.toLowerCase().substring(0, 8))) reply = FAQ_QA[k];
  });
  if (lower.includes("book")) reply = FAQ_QA["How to book a slot?"];
  if (lower.includes("crowd") || lower.includes("density"))
    reply = FAQ_QA["Check crowd levels"];
  if (lower.includes("qr")) reply = FAQ_QA["QR validity?"];
  if (lower.includes("penalty") || lower.includes("fine"))
    reply = FAQ_QA["Penalty rules?"];
  if (lower.includes("time") || lower.includes("opening"))
    reply =
      "Temple is open Monday–Friday 6AM–9PM and weekends 5AM–10PM. Festival days may have extended hours.";
  if (lower.includes("hello") || lower.includes("hi") || lower.includes("namaste"))
    reply =
      "Jai Shri Ram! 🙏 How can I assist you today? You can ask me about booking slots, QR codes, crowd levels, or temple rules.";

  setTimeout(() => appendMsg(reply, "bot"), 600);
}

function appendMsg(text, type) {
  const msgs = document.getElementById("chat-msgs");
  const d = document.createElement("div");
  d.className = "msg msg-" + type;
  d.textContent = (type === "bot" ? "🤖 " : "") + text;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
}

function initMonitorZones() {
  const list = document.getElementById("zone-monitor-list");
  if (list.children.length > 0) return;
  const zones = [
    "Main Sanctum",
    "Entry Gate",
    "Prasad Queue",
    "Circumambulation",
  ];
  zones.forEach((z) => {
    const cnt = Math.floor(Math.random() * 6);
    const color =
      cnt >= 4 ? "var(--red)" : cnt >= 3 ? "var(--gold)" : "var(--green)";
    list.innerHTML += `
      <div class="zone-item">
        <div class="zone-name">${z}</div>
        <div class="zone-bar"><div class="zone-fill" style="width:${cnt * 20}%;background:${color};"></div></div>
        <div class="zone-count" style="color:${color};">${cnt}</div>
      </div>`;
  });
}

async function startCamera() {
  try {
    const video = document.getElementById("webcam-video");
    const canvas = document.getElementById("detection-canvas");
    const placeholder = document.getElementById("cam-placeholder");
    const startBtn = document.getElementById("cam-start-btn");
    const stopBtn = document.getElementById("cam-stop-btn");

    startBtn.style.display = "none";
    stopBtn.style.display = "inline-flex";
    placeholder.innerHTML =
      '<div style="color:var(--gold);font-family:\'Cinzel\',serif;">Loading AI Model…</div><div style="color:var(--muted);font-size:.8rem;margin-top:8px;">Downloading COCO-SSD model…</div>';

    document.getElementById("model-progress").style.display = "block";
    document.getElementById("model-status-text").textContent =
      "Loading TensorFlow.js COCO-SSD model…";
    document.getElementById("model-status-sub").textContent =
      "This may take 10–30 seconds on first load";
    document.getElementById("model-icon").textContent = "⏳";

    let prog = 0;
    const progInterval = setInterval(() => {
      prog = Math.min(prog + 3, 90);
      document.getElementById("model-progress-bar").style.width = prog + "%";
    }, 300);

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });
    state.cameraStream = stream;
    video.srcObject = stream;
    await new Promise((r) => {
      video.onloadedmetadata = r;
    });
    await video.play();

    state.cocoModel = await cocoSsd.load();
    clearInterval(progInterval);
    document.getElementById("model-progress-bar").style.width = "100%";

    document.getElementById("model-status-text").textContent =
      "COCO-SSD Model Active ✓";
    document.getElementById("model-status-sub").textContent =
      "Detecting: people, vehicles, objects in real-time";
    document.getElementById("model-icon").textContent = "🟢";
    document.getElementById("live-indicator").style.display = "inline-block";
    placeholder.style.display = "none";

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    showToast("✅ Camera and AI model ready!");
    addNotification("🎥", "Monitoring Started", "COCO-SSD model active on webcam feed");

    runDetection();
  } catch (err) {
    console.error(err);
    document.getElementById("cam-placeholder").innerHTML = `<div style="color:var(--red);text-align:center;padding:20px;">
      <div style="font-size:2rem;margin-bottom:8px;">❌</div>
      <div>Camera access denied or unavailable</div>
      <div style="font-size:.8rem;color:var(--muted);margin-top:6px;">${err.message}</div>
      <div style="font-size:.75rem;color:var(--muted);margin-top:8px;">Please allow camera permissions and reload</div>
    </div>`;
    document.getElementById("cam-start-btn").style.display = "inline-flex";
    document.getElementById("cam-stop-btn").style.display = "none";
    document.getElementById("model-status-text").textContent = "Camera unavailable";
    document.getElementById("model-icon").textContent = "❌";
    showToast("❌ Camera access denied", "error");
  }
}

async function runDetection() {
  const video = document.getElementById("webcam-video");
  const canvas = document.getElementById("detection-canvas");
  const ctx = canvas.getContext("2d");

  async function detect() {
    if (!state.cocoModel || !state.cameraStream) return;

    try {
      const predictions = await state.cocoModel.detect(video);
      const people = predictions.filter((p) => p.class === "person");
      state.personCount = people.length;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const scaleX = canvas.width / (video.videoWidth || 640);
      const scaleY = canvas.height / (video.videoHeight || 480);

      predictions.forEach((pred) => {
        const [x, y, w, h] = pred.bbox;
        const isPerson = pred.class === "person";
        const color = isPerson ? "#FF6B00" : "#4A9FFF";

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);

        ctx.fillStyle = color + "CC";
        ctx.fillRect(
          x * scaleX,
          y * scaleY - 22,
          (pred.class.length * 8 + 50) * scaleX,
          22
        );

        ctx.fillStyle = "#fff";
        ctx.font = `${12 * Math.min(scaleX, scaleY)}px Nunito`;
        ctx.fillText(
          `${pred.class} ${(pred.score * 100).toFixed(0)}%`,
          x * scaleX + 4,
          y * scaleY - 6
        );
      });

      document.getElementById("person-count-badge").textContent =
        `👤 ${state.personCount} person${state.personCount !== 1 ? "s" : ""} detected`;

      const threshold =
        parseInt(document.getElementById("crowd-threshold").value, 10) || 3;
      const alertPanel = document.getElementById("alert-panel");

      if (state.personCount >= threshold + 1) {
        alertPanel.innerHTML = `<div class="alert-box alert-danger">🚨 OVERCROWDED! ${state.personCount} people detected in zone — Threshold: ${threshold}. SMS alert sent to staff!</div>`;
        const now = Date.now();
        if (now - (state._lastCrowdSosClientAt || 0) >= CROWD_SOS_CLIENT_COOLDOWN_MS) {
          state._lastCrowdSosClientAt = now;
          const zoneSel = document.getElementById("zone-select");
          api("/api/monitor/crowd-alert", {
            method: "POST",
            body: {
              count: state.personCount,
              zone: zoneSel ? zoneSel.value : "Monitoring zone",
            },
          })
            .then((r) => {
              if (r && r.notified) {
                addNotification(
                  "🚨",
                  "Overcrowding Alert",
                  `${state.personCount} people — SOS SMS sent to all staff phones`
                );
                logSMSAlert(state.personCount);
                showToast("Staff notified (crowd SOS)", "error");
              }
            })
            .catch(() => {});
        }
      } else if (state.personCount >= threshold) {
        alertPanel.innerHTML = `<div class="alert-box alert-warning">⚠️ Near Limit: ${state.personCount} people detected — threshold is ${threshold}</div>`;
      } else {
        alertPanel.innerHTML = `<div class="alert-box alert-success">✅ Normal: ${state.personCount} ${state.personCount === 1 ? "person" : "people"} detected</div>`;
        state._lastCrowdSosClientAt = 0;
      }

      if (predictions.length > 0) {
        const log = document.getElementById("detection-log");
        const entry = document.createElement("div");
        const time = new Date().toLocaleTimeString();
        entry.style.cssText = "padding:4px 0;border-bottom:1px solid var(--border);";
        entry.innerHTML = `<span style="color:var(--muted);">${time}</span> — <span style="color:var(--saffron);">${state.personCount} people</span>, ${predictions.length} objects total`;
        log.insertBefore(entry, log.firstChild);
        if (log.children.length > 20) log.removeChild(log.lastChild);
      }
    } catch (e) {
      console.warn("Detection error:", e);
    }

    if (state.cameraStream) requestAnimationFrame(detect);
  }

  detect();
}

function stopCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  state.cocoModel = null;
  document.getElementById("webcam-video").srcObject = null;
  const canvas = document.getElementById("detection-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width || 640, canvas.height || 480);
  document.getElementById("cam-placeholder").style.display = "flex";
  document.getElementById("cam-placeholder").innerHTML =
    '<div style="font-size:3rem;margin-bottom:12px;">📷</div><div style="color:var(--muted);font-size:.9rem;">Camera stopped</div>';
  document.getElementById("cam-start-btn").style.display = "inline-flex";
  document.getElementById("cam-stop-btn").style.display = "none";
  document.getElementById("live-indicator").style.display = "none";
  document.getElementById("person-count-badge").textContent = "👤 0 detected";
  document.getElementById("model-progress").style.display = "none";
  document.getElementById("model-progress-bar").style.width = "0%";
  document.getElementById("model-status-text").textContent = "Model not loaded";
  document.getElementById("model-status-sub").textContent =
    'Click "Start Camera" to load the detection model';
  document.getElementById("model-icon").textContent = "⏳";
  showToast("📷 Camera stopped");
}

function logSMSAlert(count) {
  const log = document.getElementById("sms-log");
  const time = new Date().toLocaleTimeString();
  const zone = document.getElementById("zone-select").value;
  log.innerHTML =
    `<div style="color:var(--red);padding:4px 0;border-bottom:1px solid var(--border);">📱 ${time} – ALERT sent | Zone: ${zone} | ${count} people detected</div>` +
    log.innerHTML;
}

async function triggerSOS() {
  const sel = document.getElementById("zone-select");
  const zone = sel ? sel.value : "Main Sanctum";
  const thresholdEl = document.getElementById("crowd-threshold");
  const threshold = thresholdEl ? (parseInt(thresholdEl.value, 10) || 3) : 3;
  const count = state.personCount || 0;

  try {
    const res = await api("/api/monitor/crowd-alert", {
      method: "POST",
      body: { manual: true, zone, count, threshold },
    });
    if (res && res.notified) {
      addNotification(
        "🚨",
        "SOS Alert Sent!",
        `Location: ${zone}. Staff notified via SMS. Actions: stop entry & redirect crowd.`
      );
      showToast(`🚨 SOS Alert sent for ${zone}!`, "error");
      logSMSAlert(count);
      playAudioBeep("warning");
    } else if (res && res.cooldown) {
      showToast("SOS alert on cooldown for this zone.", "warning");
    }
  } catch (err) {
    showToast("SOS Alert failed: " + (err.message || "Network error"), "error");
  }
}

function showAdminPanel(id, el) {
  stopQrDashboardPoll();
  if (state.adminActivePanel === "qrscan" && id !== "qrscan") {
    stopAdminQrScanner();
  }
  state.adminActivePanel = id;

  document.querySelectorAll(".admin-panel").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".admin-menu-item").forEach((m) => m.classList.remove("active"));
  const panel = document.getElementById("panel-" + id);
  if (panel) panel.classList.add("active");
  if (el) el.classList.add("active");

  if (id === "qrscan") {
    refreshQrAdminFull();
    qrDashboardPoll = setInterval(refreshQrAdminFull, 3000);
    setTimeout(() => startAdminQrScanner(), 400);
  }
  if (id === "analytics") loadAdminAnalytics();
}

async function stopAdminQrScanner() {
  if (!adminHtml5Qr) return;
  try {
    await adminHtml5Qr.stop();
  } catch (e) {
    /* not running or already stopped */
  }
  try {
    adminHtml5Qr.clear();
  } catch (e) {
    /* ignore */
  }
  adminHtml5Qr = null;
}

async function startAdminQrScanner() {
  await stopAdminQrScanner();
  const mount = document.getElementById("admin-qr-reader");
  if (!mount || typeof Html5Qrcode === "undefined") {
    if (mount && typeof Html5Qrcode === "undefined") {
      showToast("QR camera library failed to load", "error");
    }
    return;
  }
  mount.innerHTML = "";
  adminHtml5Qr = new Html5Qrcode("admin-qr-reader");
  const config = {
    fps: 15,
    qrbox: (viewfinderWidth, viewfinderHeight) => {
      const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
      return {
        width: Math.floor(minEdge * 0.75),
        height: Math.floor(minEdge * 0.75),
      };
    },
    aspectRatio: 1.0,
    experimentalFeatures: {
      useBarCodeDetectorIfSupported: true,
    },
  };
  const onOk = (decodedText) => {
    onAdminQrDecoded(decodedText);
  };
  const onErr = () => {};
  try {
    await adminHtml5Qr.start(
      { facingMode: "environment" },
      config,
      onOk,
      onErr
    );
  } catch (e1) {
    try {
      await adminHtml5Qr.start(
        { facingMode: "user" },
        config,
        onOk,
        onErr
      );
    } catch (e2) {
      console.warn(e2);
      showToast("Could not start camera — check permissions", "error");
    }
  }
}

async function onAdminQrDecoded(text) {
  if (adminQrScanBusy) return;
  const serial = parseAdminSerial(text);
  if (!serial) return;
  const now = Date.now();
  if (
    serial === _lastAdminQrDecode.text &&
    now - _lastAdminQrDecode.at < ADMIN_QR_DEBOUNCE_MS
  ) {
    return;
  }
  _lastAdminQrDecode = { text: serial, at: now };

  playAudioBeep("success");

  const modeEl = document.querySelector(
    'input[name="admin-scan-mode"]:checked'
  );
  const mode = modeEl ? modeEl.value : "entry";
  adminQrScanBusy = true;
  try {
    if (mode === "entry") await adminScanEntry(serial);
    else await adminScanExit(serial);
  } finally {
    adminQrScanBusy = false;
  }
}

/** Accept first line: plain serial or pasted JSON from legacy QR payload. */
function parseAdminSerial(raw) {
  const s = String(raw || "").trim().split(/\r?\n/)[0].trim();
  if (!s) return "";
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (j.serial) return String(j.serial).trim();
    } catch (e) {
      /* ignore */
    }
  }
  return s;
}

function showPenaltyModal(title, text) {
  const overlay = document.getElementById("penalty-modal");
  document.getElementById("penalty-modal-title").textContent = title;
  document.getElementById("penalty-modal-text").textContent = text;
  overlay.classList.add("open");
}

function closePenaltyModal() {
  document.getElementById("penalty-modal").classList.remove("open");
}

document.getElementById("penalty-modal").addEventListener("click", (e) => {
  if (e.target.id === "penalty-modal") closePenaltyModal();
});

function renderQrMiniList(el, list, emptyMsg) {
  if (!el) return;
  if (!list || list.length === 0) {
    el.innerHTML = `<span style="opacity:.7">${emptyMsg}</span>`;
    return;
  }
  el.innerHTML = list
    .map(
      (b) =>
        `<div style="margin-bottom:10px;padding:8px;background:var(--deep);border-radius:6px;border-left:3px solid var(--saffron);">
        <strong style="color:var(--text);">${b.serial}</strong> · ${b.visitor_name} · ${b.people} ppl<br/>
        <span style="font-size:.75rem;">Until: ${b.expiryTime ? new Date(b.expiryTime).toLocaleTimeString() : "—"}</span>
      </div>`
    )
    .join("");
}

function renderSmsMockLog(messages) {
  const el = document.getElementById("admin-sms-mock-log");
  if (!el) return;
  if (!messages || messages.length === 0) {
    el.innerHTML = '<span style="opacity:.6">No SMS yet.</span>';
    return;
  }
  el.innerHTML = messages
    .map(
      (m) =>
        `<div><span style="color:var(--saffron);">${m.time}</span> → <span style="color:var(--text);">${m.to}</span><br/>${m.message}<span style="opacity:.5;font-size:.7rem;"> [${m.phase}]</span></div>`
    )
    .join("");
}

function updateQrOverviewCounts(dash) {
  const a = document.getElementById("adm-qr-active");
  const e = document.getElementById("adm-qr-expired");
  const o = document.getElementById("adm-qr-overstayed");
  if (a) a.textContent = String((dash.active || []).length);
  if (e) e.textContent = String((dash.expired || []).length);
  if (o) o.textContent = String((dash.overstayed || []).length);
}

async function refreshQrAdminFull() {
  try {
    const [dash, sms] = await Promise.all([
      api("/api/admin/qr-dashboard"),
      api("/api/admin/sms-log?limit=40"),
    ]);
    updateQrOverviewCounts(dash);
    renderQrMiniList(
      document.getElementById("qr-list-active"),
      dash.active,
      "No active sessions."
    );
    renderQrMiniList(
      document.getElementById("qr-list-expired"),
      dash.expired,
      "None — visitors exited or not yet expired."
    );
    renderQrMiniList(
      document.getElementById("qr-list-overstayed"),
      dash.overstayed,
      "No overstays recorded."
    );
    renderSmsMockLog(sms.messages || []);
  } catch (err) {
    console.warn("QR dashboard refresh failed", err);
  }
}

async function adminScanEntry(serialFromCamera) {
  const serial =
    serialFromCamera != null
      ? String(serialFromCamera).trim()
      : parseAdminSerial(
          (document.getElementById("admin-qr-serial") || {}).value || ""
        );
  const statusEl = document.getElementById("admin-qr-scan-status");
  if (!serial) {
    showToast("No QR detected", "warning");
    return;
  }
  try {
    const data = await api("/api/admin/scan-entry", {
      method: "POST",
      body: { serial },
    });
    statusEl.innerHTML = `<span style="color:var(--green);">✅ ${data.message}</span>`;
    showToast(data.message);
    addNotification("🚪", "Admin ENTRY", serial);
    await refreshQrAdminFull();
    const bookings = await api("/api/admin/bookings");
    state.adminBookingsRaw = bookings.bookings || [];
    renderAdminBookings(state.adminBookingsRaw);
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red);">❌ ${e.message}</span>`;
    showToast(e.message, "error");
  }
}

async function adminScanExit(serialFromCamera) {
  const serial =
    serialFromCamera != null
      ? String(serialFromCamera).trim()
      : parseAdminSerial(
          (document.getElementById("admin-qr-serial") || {}).value || ""
        );
  const statusEl = document.getElementById("admin-qr-scan-status");
  if (!serial) {
    showToast("No QR detected", "warning");
    return;
  }
  try {
    const data = await api("/api/admin/scan-exit", {
      method: "POST",
      body: { serial },
    });
    if (data.penaltyApplied) {
      statusEl.innerHTML = `<span style="color:var(--red);">⚠️ ${data.message}</span>`;
      showPenaltyModal(
        "Penalty required",
        "Your visit exceeded the allowed time. You must pay ₹100 penalty."
      );
      showToast("Exit recorded — ₹100 penalty", "error");
      addNotification("💰", "Penalty", serial + " — ₹100");
    } else {
      statusEl.innerHTML = `<span style="color:var(--green);">✅ ${data.message}</span>`;
      showToast(data.message);
      addNotification("🏃", "Admin EXIT", serial);
    }
    await refreshQrAdminFull();
    const bookings = await api("/api/admin/bookings");
    state.adminBookingsRaw = bookings.bookings || [];
    renderAdminBookings(state.adminBookingsRaw);
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red);">❌ ${e.message}</span>`;
    showToast(e.message, "error");
  }
}

async function loadAdminAnalytics() {
  const ad = document.getElementById("admin-analytics-date");
  const d =
    (ad && ad.value) || new Date().toISOString().split("T")[0];
  try {
    const analytics = await api(
      "/api/admin/analytics?date=" + encodeURIComponent(d)
    );
    renderAnalyticsFromServer(analytics);
  } catch (e) {
    if (e.status === 401) {
      state.adminLoggedIn = false;
      showPage("admin-login");
      return;
    }
    showToast("Could not load analytics", "error");
  }
}

async function initAdmin() {
  const today = new Date().toISOString().split("T")[0];
  const ad = document.getElementById("admin-analytics-date");
  if (ad) {
    if (!ad.dataset.bound) {
      ad.dataset.bound = "1";
      ad.addEventListener("change", () => loadAdminAnalytics());
    }
    if (!ad.value) ad.value = today;
  }
  const analyticsDate = (ad && ad.value) || today;
  try {
    const [stats, slotSummary, bookings, staffList, analytics, qrDash] =
      await Promise.all([
        api("/api/admin/stats"),
        api("/api/admin/slots-summary?date=" + encodeURIComponent(today)),
        api("/api/admin/bookings"),
        api("/api/staff"),
        api(
          "/api/admin/analytics?date=" + encodeURIComponent(analyticsDate)
        ),
        api("/api/admin/qr-dashboard"),
      ]);

    const elBook = document.getElementById("adm-bookings-today");
    if (elBook) elBook.textContent = String(stats.bookingsToday);
    const openEl = document.getElementById("adm-open-slots");
    if (openEl) openEl.textContent = String(stats.openSlots);

    updateQrOverviewCounts(qrDash);

    renderAdminSlotTable(slotSummary.slots);
    state.adminBookingsRaw = bookings.bookings || [];
    renderAdminBookings(state.adminBookingsRaw);
    renderStaffTable(staffList.staff || []);
    renderAnalyticsFromServer(analytics);

    const qrPanel = document.getElementById("panel-qrscan");
    if (qrPanel && qrPanel.classList.contains("active")) {
      refreshQrAdminFull();
      setTimeout(() => startAdminQrScanner(), 400);
    }
  } catch (e) {
    console.error(e);
    if (e.status === 401) {
      state.adminLoggedIn = false;
      showToast("Admin session expired — sign in again", "warning");
      showPage("admin-login");
      return;
    }
    showToast("Admin: could not load server data", "error");
  }
}

function renderAdminSlotTable(slots) {
  const tb = document.getElementById("admin-slot-table");
  if (!tb) return;
  tb.innerHTML = "";
  (slots || []).forEach((s) => {
    const avail = s.cap - s.booked;
    const pct = Math.round((s.booked / s.cap) * 100);
    const color =
      pct > 90 ? "var(--red)" : pct > 60 ? "var(--gold)" : "var(--green)";
    tb.innerHTML += `<tr>
      <td>${s.time}</td>
      <td>${s.cap}</td>
      <td>${s.booked} <span style="color:${color};font-size:.8rem;">(${pct}%)</span></td>
      <td><span class="chip" style="background:${pct >= 100 ? "rgba(255,71,87,.15)" : "rgba(0,214,143,.15)"};color:${pct >= 100 ? "var(--red)" : "var(--green)"};">${pct >= 100 ? "FULL" : "Open"}</span></td>
    </tr>`;
  });
}

function renderAdminBookings(rows) {
  const tb = document.getElementById("admin-bookings-table");
  if (!tb) return;
  tb.innerHTML = "";
  rows.forEach((b, i) => {
    const st = b.status || "confirmed";
    const statusColor = {
      confirmed: "var(--gold)",
      active: "var(--green)",
      expired: "var(--gold)",
      completed: "var(--muted)",
      overstayed: "var(--red)",
    };
    const sc = statusColor[st] || "var(--muted)";
    const pen =
      b.penalty > 0 ? ` <span style="color:var(--red);font-size:.75rem;">(₹${b.penalty})</span>` : "";
    const walk = b.is_walkin ? " (walk-in)" : "";
    tb.innerHTML += `<tr>
      <td style="color:var(--muted);font-size:.8rem;">${b.serial}</td>
      <td>${b.visitor_name}${walk}</td>
      <td>${b.slot_time}</td>
      <td>${b.people}</td>
      <td><span style="color:${sc};">${st}</span>${pen}</td>
    </tr>`;
  });
}

function filterAdminBookings(q) {
  const lower = (q || "").toLowerCase();
  const filtered = state.adminBookingsRaw.filter((b) =>
    String(b.visitor_name || "")
      .toLowerCase()
      .includes(lower)
  );
  renderAdminBookings(filtered);
}

function renderStaffTable(staffArr) {
  const tb = document.getElementById("staff-table");
  if (!tb) return;
  tb.innerHTML = "";
  staffArr.forEach((s) => {
    const sc = s.status === "On Duty" ? "var(--green)" : "var(--gold)";
    tb.innerHTML += `<tr>
      <td>${s.name}</td><td>${s.position}</td><td>${s.phone}</td>
      <td><span style="color:${sc};">${s.status}</span></td>
      <td><button type="button" class="btn-icon-sm" onclick="removeStaff(${s.id})">Remove</button></td>
    </tr>`;
  });
}

async function removeStaff(id) {
  if (!confirm("Remove this staff member?")) return;
  try {
    await api("/api/staff/" + id, { method: "DELETE" });
    showToast("Staff removed");
    const staffList = await api("/api/staff");
    renderStaffTable(staffList.staff || []);
  } catch (e) {
    showToast("Could not remove staff", "error");
  }
}

async function addStaff() {
  const n = document.getElementById("st-name").value;
  const p = document.getElementById("st-pos").value;
  const ph = document.getElementById("st-phone").value;
  if (!n || !ph) {
    showToast("⚠️ Fill name and phone", "warning");
    return;
  }
  try {
    await api("/api/staff", {
      method: "POST",
      body: { name: n, position: p, phone: ph },
    });
    document.getElementById("st-name").value = "";
    document.getElementById("st-phone").value = "";
    const staffList = await api("/api/staff");
    renderStaffTable(staffList.staff || []);
    showToast("✅ Staff member added");
  } catch (e) {
    showToast("Could not add staff", "error");
  }
}

async function adminWalkIn() {
  const n = document.getElementById("wi-name").value;
  const ph = document.getElementById("wi-phone").value;
  const ppl = document.getElementById("wi-people").value;
  const slot = document.getElementById("wi-slot").value;
  const today = new Date().toISOString().split("T")[0];
  if (!n) {
    showToast("⚠️ Enter visitor name", "warning");
    return;
  }
  try {
    const { booking } = await api("/api/bookings", {
      method: "POST",
      body: {
        visitor_name: n,
        people: parseInt(ppl, 10),
        date: today,
        phone: ph,
        slot_time: slot,
        is_walkin: true,
      },
    });
    const qrWrap = document.getElementById("walkin-qr");
    qrWrap.innerHTML =
      '<div id="walkin-qr-canvas" style="display:inline-block;padding:12px;background:#fff;border-radius:8px;"></div>';
    qrWrap.innerHTML += `<div style="margin-top:10px;color:var(--muted);font-size:.85rem;">Walk-in Serial: <strong style="color:var(--gold);">${booking.serial}</strong></div>`;
    renderBookingQR(booking.serial, "walkin-qr-canvas");
    showToast("✅ Walk-in QR generated: " + booking.serial);
    const bookings = await api("/api/admin/bookings");
    state.adminBookingsRaw = bookings.bookings || [];
    renderAdminBookings(state.adminBookingsRaw);
  } catch (e) {
    showToast("❌ " + (e.message || "Walk-in failed"), "error");
  }
}

/** Plausible demo counts (entries / exits per slot) when there is no QR activity yet. */
const SAMPLE_ANALYTICS_ENTRIES = [14, 32, 48, 26, 20, 38, 44, 18];
const SAMPLE_ANALYTICS_EXITS = [12, 28, 44, 24, 18, 34, 40, 16];

function renderAnalyticsFromServer(analytics) {
  const bars = document.getElementById("analytics-bars");
  const labels = document.getElementById("analytics-labels");
  const metrics = document.getElementById("analytics-metrics");
  const tableBody = document.getElementById("analytics-breakdown-table");
  const chartCard = document.querySelector(".analytics-chart-card");
  if (!bars || !analytics) return;
  const slotLabels = analytics.labels || [];
  let entries = analytics.entries || [];
  let exits = analytics.exits || [];
  const n = Math.max(slotLabels.length, entries.length, exits.length);
  const sumArr = (a) => a.reduce((s, x) => s + (Number(x) || 0), 0);
  const noActivity = n > 0 && sumArr(entries) + sumArr(exits) === 0;
  if (noActivity) {
    entries = SAMPLE_ANALYTICS_ENTRIES.slice(0, n);
    exits = SAMPLE_ANALYTICS_EXITS.slice(0, n);
    while (entries.length < n) entries.push(0);
    while (exits.length < n) exits.push(0);
  }
  if (chartCard) {
    chartCard.classList.toggle("analytics-chart-sample", noActivity);
  }
  const max = Math.max(1, ...entries, ...exits);
  let totalIn = 0;
  let totalOut = 0;
  let peakIndex = 0;
  bars.innerHTML = "";
  labels.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const en = entries[i] || 0;
    const ex = exits[i] || 0;
    totalIn += en;
    totalOut += ex;
    if (en > (entries[peakIndex] || 0)) peakIndex = i;
    const hEn = (en / max) * 100;
    const hEx = (ex / max) * 100;
    bars.innerHTML += `<div class="analytics-bar-group">
      <div class="analytics-bar-tooltip">${en} in · ${ex} out</div>
      <div class="analytics-bar-pair">
        <div title="Entries" class="analytics-bar analytics-bar-entry" style="height:${en ? Math.max(hEn, 5) : 0}%"></div>
        <div title="Exits" class="analytics-bar analytics-bar-exit" style="height:${ex ? Math.max(hEx, 5) : 0}%"></div>
      </div>
    </div>`;
    const lbl = slotLabels[i] != null ? slotLabels[i] : `Slot ${i + 1}`;
    labels.innerHTML += `<div class="analytics-slot-label">${lbl}</div>`;
  }
  const netInside = Math.max(0, totalIn - totalOut);
  const peakSlotText = slotLabels[peakIndex] || "—";

  const statInEl = document.getElementById("an-stat-in");
  const statOutEl = document.getElementById("an-stat-out");
  const statInsideEl = document.getElementById("an-stat-inside");
  const statPeakEl = document.getElementById("an-stat-peak");
  if (statInEl) statInEl.textContent = String(totalIn);
  if (statOutEl) statOutEl.textContent = String(totalOut);
  if (statInsideEl) statInsideEl.textContent = String(netInside);
  if (statPeakEl) statPeakEl.textContent = peakSlotText;

  const dateStr = analytics.date || "";
  const sampleNote = noActivity
    ? `<div class="analytics-metric-row"><span class="analytics-metric-k">Preview</span><span class="analytics-metric-v" style="color:var(--gold);font-size:0.85rem;">Sample data — bars fill with real QR entry/exit scans</span></div>`
    : "";
  const sourceLabel = noActivity
    ? "Sample (no scans this date)"
    : "QR scans by slot";
  const sourceClass = noActivity ? "" : " analytics-metric-v-green";
  metrics.innerHTML = `
    <div class="analytics-metric-row"><span class="analytics-metric-k">Date</span><span class="analytics-metric-v analytics-metric-v-gold">${dateStr}</span></div>
    ${sampleNote}
    <div class="analytics-metric-row"><span class="analytics-metric-k">Total entry (people)</span><span class="analytics-metric-v">${totalIn}</span></div>
    <div class="analytics-metric-row"><span class="analytics-metric-k">Total exit (people)</span><span class="analytics-metric-v">${totalOut}</span></div>
    <div class="analytics-metric-row"><span class="analytics-metric-k">Data source</span><span class="analytics-metric-v${sourceClass}">${sourceLabel}</span></div>`;

  if (tableBody) {
    tableBody.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const en = entries[i] || 0;
      const ex = exits[i] || 0;
      const net = en - ex;
      const cap = 100;
      const pct = Math.min(100, Math.round((en / cap) * 100));
      const badgeColor = pct > 80 ? "var(--red)" : pct > 40 ? "var(--gold)" : "var(--green)";
      const lbl = slotLabels[i] != null ? slotLabels[i] : `Slot ${i + 1}`;
      tableBody.innerHTML += `<tr>
        <td><strong>${lbl}</strong></td>
        <td style="color:var(--saffron);">${en}</td>
        <td style="color:var(--blue);">${ex}</td>
        <td>${net >= 0 ? "+" + net : net}</td>
        <td><span class="chip" style="background:rgba(255,255,255,0.06);color:${badgeColor};">${en} / ${cap} (${pct}%)</span></td>
      </tr>`;
    }
  }
}

function addNotification(icon, title, body) {
  state.notifications.unshift({
    icon,
    title,
    body,
    time: new Date().toLocaleTimeString(),
  });
  renderNotifications();
}

function renderNotifications() {
  const list = document.getElementById("notif-list");
  const badge = document.getElementById("notif-badge");
  list.innerHTML = "";
  if (state.notifications.length === 0) {
    list.innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--muted);">No notifications</div>';
    badge.style.display = "none";
    return;
  }
  badge.style.display = "block";
  state.notifications.slice(0, 10).forEach((n) => {
    list.innerHTML += `<div class="notif-item">
      <div class="notif-icon">${n.icon}</div>
      <div><div class="notif-text"><strong>${n.title}</strong> – ${n.body}</div>
      <div class="notif-time">${n.time}</div></div>
    </div>`;
  });
}

document.getElementById("notif-bell").addEventListener("click", () => {
  document.getElementById("notif-drawer").classList.toggle("open");
});

document.getElementById("clear-notifs").addEventListener("click", () => {
  state.notifications = [];
  renderNotifications();
});

function showToast(msg, type = "success") {
  const t = document.getElementById("toast");
  const colors = {
    success: "var(--green)",
    error: "var(--red)",
    warning: "var(--gold)",
  };
  t.textContent = msg;
  t.style.borderColor = colors[type] || "var(--border)";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

function playAudioBeep(type) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (type === "warning") {
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } else {
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    }
  } catch (e) {
    /* ignore audio error */
  }
}

async function sendTestStaffSms() {
  try {
    const res = await api("/api/admin/staff/test-sms", { method: "POST" });
    if (res && res.ok) {
      showToast("✅ Test SMS sent to " + (res.staffCount || 0) + " staff members!");
      addNotification("📱", "Test SMS Sent", "Sent to " + (res.staffCount || 0) + " staff phone numbers");
    }
  } catch (err) {
    showToast("Failed to send test SMS: " + (err.message || "Network error"), "error");
  }
}

function setLang(lang) {
  if (typeof window.applyI18n === "function") {
    window.applyI18n(lang);
  }
  const tr = TRANSLATIONS[lang] || TRANSLATIONS.en;
  if (tr && tr.hero_title) {
    const lines = tr.hero_title.split("\n");
    const heroTitle = document.getElementById("hero-title");
    if (heroTitle) {
      heroTitle.innerHTML =
        lines[0] +
        '<br><span style="color:var(--saffron);">' +
        (lines[1] || "") +
        "</span>";
    }
  }
  const heroDesc = document.getElementById("hero-desc");
  if (heroDesc && tr && tr.hero_desc) heroDesc.textContent = tr.hero_desc;
  showToast(typeof window.t === "function" ? window.t("lang_changed") : "🌐 Language changed");
}

setInterval(() => {
  const el = document.getElementById("stat-inside");
  if (el) {
    const cur = parseInt(el.textContent.replace(/,/g, ""), 10) || 300;
    el.textContent = String(
      Math.max(50, Math.min(900, cur + Math.round((Math.random() - 0.45) * 8)))
    );
  }
}, 4000);

addNotification("🛕", "Welcome", "Easy Darshan system is online and monitoring active.");
addNotification(
  "📊",
  "Crowd Update",
  "Current occupancy: 34%. Best time to visit: 12PM–3PM."
);

let loaderHidden = false;
function hideAppLoader() {
  if (loaderHidden) return;
  loaderHidden = true;
  const loader = document.getElementById("loader");
  if (loader) {
    loader.classList.add("hide");
    setTimeout(() => {
      try {
        if (loader && loader.parentNode) loader.remove();
      } catch (e) {
        /* ignore */
      }
    }, 600);
  }
}

function initApp() {
  refreshAdminSession();
  refreshUserSession();
  if (typeof window.initI18n === "function") {
    window.initI18n();
  }
  setTimeout(hideAppLoader, 800);
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  setTimeout(initApp, 50);
} else {
  document.addEventListener("DOMContentLoaded", initApp);
  window.addEventListener("load", initApp);
}

// Guaranteed safety fallback: remove loader after 1500ms max
setTimeout(hideAppLoader, 1500);
