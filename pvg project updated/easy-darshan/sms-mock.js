/**
 * SMS: logs every message for the admin UI, and sends via Fast2SMS when configured.
 *
 * Env:
 *   FAST2SMS_API_KEY      – required for live SMS
 *   FAST2SMS_ROUTE        – default "q" (quick). Use "dlt" for production India DLT.
 *   FAST2SMS_SENDER_ID    – DLT sender id (optional)
 *   FAST2SMS_TEMPLATE_ID  – DLT template id (optional)
 */

const MAX_LOG = 200;
const recentLog = [];

function normalizeIndiaPhone(raw) {
  if (raw == null) return null;
  let d = String(raw).replace(/[^\d]/g, "");
  if (d.startsWith("91") && d.length === 12) d = d.slice(2);
  if (d.startsWith("0") && d.length === 11) d = d.slice(1);
  if (d.length !== 10) return null;
  return d;
}

function getSmsProviderStatus() {
  const configured = !!(process.env.FAST2SMS_API_KEY || "").trim();
  return {
    configured,
    provider: configured ? "Fast2SMS" : "log only",
    route: (process.env.FAST2SMS_ROUTE || "q").trim() || "q",
  };
}

function pushLog(entry) {
  recentLog.unshift(entry);
  if (recentLog.length > MAX_LOG) recentLog.pop();
}

async function postFast2Sms(numbers, message) {
  const key = (process.env.FAST2SMS_API_KEY || "").trim();
  const route = (process.env.FAST2SMS_ROUTE || "q").trim() || "q";
  const body = {
    route,
    numbers,
    message: String(message).slice(0, 1000),
    language: "english",
    flash: 0,
  };
  if (route === "dlt") {
    if (process.env.FAST2SMS_SENDER_ID) {
      body.sender_id = process.env.FAST2SMS_SENDER_ID;
    }
    if (process.env.FAST2SMS_TEMPLATE_ID) {
      body.template_id = process.env.FAST2SMS_TEMPLATE_ID;
    }
  }
  const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      authorization: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok && json && json.return !== false, status: res.status, json };
}

/**
 * One Fast2SMS request for many 10-digit numbers (comma-separated `numbers` field).
 * Logs one row per original phone so the admin SMS log stays readable.
 */
async function sendSmsToMany(phones, message, phase) {
  const phaseName = phase || "staff_alert";
  const seen = new Set();
  const targets = [];
  (phones || []).forEach((raw) => {
    const n = normalizeIndiaPhone(raw);
    if (!n || seen.has(n)) return;
    seen.add(n);
    targets.push({ raw: String(raw).trim(), normalized: n });
  });

  if (targets.length === 0) {
    const entry = {
      time: new Date().toISOString(),
      to: "(no staff phones)",
      message,
      serial: "",
      phase: phaseName,
      status: "skipped_no_recipients",
    };
    pushLog(entry);
    return { staffCount: 0, phonesNotified: [], status: entry.status };
  }

  const numbersCsv = targets.map((x) => x.normalized).join(",");
  const status = getSmsProviderStatus();
  let sendStatus = "log_only";
  let error = null;
  let provider;

  if (!status.configured) {
    sendStatus = "log_only";
    console.log(`[SMS LOG batch] → ${numbersCsv} | ${phaseName} | ${message}`);
  } else {
    provider = "Fast2SMS";
    try {
      const r = await postFast2Sms(numbersCsv, message);
      sendStatus = r.ok ? "sent" : "failed";
      if (!r.ok) {
        error = (r.json && (r.json.message || r.json.raw)) || `HTTP ${r.status}`;
      }
      console.log(`[SMS Fast2SMS ${sendStatus} batch] → ${numbersCsv} | ${phaseName}`);
    } catch (err) {
      sendStatus = "failed";
      error = err.message || String(err);
      console.log(`[SMS Fast2SMS failed batch] → ${error}`);
    }
  }

  const time = new Date().toISOString();
  targets.forEach((x) => {
    const entry = {
      time,
      to: x.raw,
      message,
      serial: "",
      phase: phaseName,
      status: sendStatus,
    };
    if (provider) entry.provider = provider;
    if (error) entry.error = error;
    pushLog(entry);
  });

  return {
    staffCount: targets.length,
    phonesNotified: targets.map((x) => x.raw),
    status: sendStatus,
    error: error || undefined,
  };
}

async function sendSms({ to, message, serial, phase }) {
  const safeTo = to || "(no phone)";
  const normalized = normalizeIndiaPhone(to);
  const entry = {
    time: new Date().toISOString(),
    to: safeTo,
    message,
    serial: serial || "",
    phase: phase || "info",
    status: "logged",
  };

  if (!normalized) {
    entry.status = "skipped_invalid_phone";
    console.log(`[SMS] skip invalid | ${safeTo} | ${serial || "-"} | ${message}`);
    pushLog(entry);
    return entry;
  }

  const status = getSmsProviderStatus();
  if (!status.configured) {
    entry.status = "log_only";
    console.log(`[SMS LOG] → ${normalized} | ${serial || "-"} | ${message}`);
    pushLog(entry);
    return entry;
  }

  try {
    const r = await postFast2Sms(normalized, message);
    entry.status = r.ok ? "sent" : "failed";
    entry.provider = "Fast2SMS";
    if (!r.ok) {
      entry.error = (r.json && (r.json.message || r.json.raw)) || `HTTP ${r.status}`;
    }
    console.log(
      `[SMS Fast2SMS ${entry.status}] → ${normalized} | ${serial || "-"} | ${message}`
    );
  } catch (err) {
    entry.status = "failed";
    entry.provider = "Fast2SMS";
    entry.error = err.message || String(err);
    console.log(`[SMS Fast2SMS failed] → ${normalized} | ${entry.error}`);
  }
  pushLog(entry);
  return entry;
}

/** Sync-looking alias used by older call sites; still returns a Promise. */
function sendMockSms(opts) {
  return sendSms(opts);
}

function getSmsLog(limit = 50) {
  return recentLog.slice(0, Math.min(limit, MAX_LOG));
}

module.exports = {
  sendSms,
  sendSmsToMany,
  sendMockSms,
  getSmsLog,
  normalizeIndiaPhone,
  getSmsProviderStatus,
};
