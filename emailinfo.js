// Pulls the device / profile / location out of a Netflix sign-in email so the bot can remember
// WHICH device asked for the code. Heuristic: Netflix's wording varies, so every field can be null.
const DEVICE_RE =
  /\b(samsung|lg|sony|vizio|hisense|tcl|panasonic|philips|roku|fire\s?tv|firestick|chromecast|apple\s?tv|android\s?tv|google\s?tv|xbox|playstation|ps[45]|nintendo|iphone|ipad|android|pixel|galaxy|oneplus|xiaomi|redmi|realme|oppo|vivo|motorola|windows|mac(?:book|os)?|linux|chrome(?:book)?|safari|firefox|edge|web\s?browser)\b[^.,;|·•\n]{0,30}/i;

function clean(raw) {
  return (raw || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDeviceInfo(raw) {
  const text = clean(raw);
  if (!text) return null;

  // Netflix "A new device is using your account" layout:
  //   Hi LOKESH, ... The details  Device <name>  Location <place> (This location may not be exact.)  Time <when>
  const dev = text.match(/\bDevice\s+(.{2,60}?)\s+(?:Location|Time)\b/);
  const loc = text.match(/\bLocation\s+(.{2,80}?)(?:\s*\(This location|\s+Time\b|$)/);
  const when = text.match(/\bTime\s+(\d{1,2} [A-Za-z]+ \d{1,2}:\d{2}\s?[ap]m(?: [A-Z]{2,5})?)/i);
  const hi = text.match(/\bHi\s+([^,<]{1,25}),/);
  if (dev) {
    return {
      device: dev[1].trim(),
      location: loc ? loc[1].trim() : null,
      profile: hi ? hi[1].trim() : null, // the name in the "Hi NAME," greeting
      when: when ? when[1].trim() : null,
      raw: text.slice(Math.max(0, dev.index - 10), dev.index + 140),
    };
  }

  // Fallback for other wordings (sign-in code emails etc.)
  const start = text.search(/requested|sign(?:ed)?[- ]?in (?:attempt|request|from|on|by)|new device|device:|attempt/i);
  const hay = start >= 0 ? text.slice(start, start + 400) : text.slice(0, 1500);
  const dm = hay.match(DEVICE_RE) || (start >= 0 ? text.match(DEVICE_RE) : null);
  const device = dm
    ? dm[0].split(/\s+(?:in|at|on|from|near|requested|using|for)\s+/i)[0].replace(/[\s,.:;-]+$/, "").trim()
    : null;
  const lm = hay.match(/\b(?:in|from|near)\s+([A-Z][\p{L}' -]{2,30}(?:,\s*[A-Z][\p{L} -]{2,30}){0,2})/u);
  const location = lm ? lm[1].split(/\s+(?:at|on|using|for|profile|your|code)\b/i)[0].trim() : null;
  const pm = text.match(/profile\s*:\s*["“]?([\p{L}0-9 _-]{1,25})/iu) || text.match(/for the profile\s+["“]?([\p{L}0-9 _-]{1,25})/iu);
  return { device, profile: pm ? pm[1].trim() : null, location, when: null, raw: hay.slice(0, 140) };
}

module.exports = { parseDeviceInfo };
