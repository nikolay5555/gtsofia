(() => {
  const SOFIA_TIME_ZONE = "Europe/Sofia";

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatClockTime(totalSeconds) {
    const seconds = Math.max(0, Number(totalSeconds) || 0);
    const hour = Math.floor(seconds / 3600) % 24;
    const minute = Math.floor((seconds % 3600) / 60);
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function parseGtfsTime(value) {
    if (!value) return null;
    const parts = String(value).trim().split(":");
    if (parts.length !== 3) return null;
    const [hour, minute, second] = parts.map(Number);
    if (![hour, minute, second].every(Number.isFinite)) return null;
    return hour * 3600 + minute * 60 + second;
  }

  function getArrivalMinutes(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, (seconds - Date.now() / 1000) / 60);
  }

  function formatArrivalCountdown(timestamp, nowSeconds = Date.now() / 1000) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return "";
    const remainingSeconds = seconds - nowSeconds;
    if (remainingSeconds <= 0) return "0 мин.";
    const minutes = Math.max(1, Math.round(remainingSeconds / 60));
    return `${minutes} мин.`;
  }

  function formatArrivalClock(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return "—";
    return new Intl.DateTimeFormat("bg-BG", {
      timeZone: SOFIA_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(seconds * 1000));
  }

  function normalizeStopKey(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const withoutMetroPrefix = raw.replace(/^M/i, "");
    const numeric = withoutMetroPrefix.replace(/^0+(?=\d)/, "");
    return numeric || "0";
  }

  function stopIdsMatch(left, right) {
    const leftRaw = String(left ?? "").trim();
    const rightRaw = String(right ?? "").trim();
    if (!leftRaw || !rightRaw) return false;

    const leftMetro = /^M/i.test(leftRaw);
    const rightMetro = /^M/i.test(rightRaw);
    if (leftMetro !== rightMetro) return false;
    if (leftMetro && rightMetro) {
      return leftRaw.toUpperCase() === rightRaw.toUpperCase();
    }
    return normalizeStopKey(leftRaw) === normalizeStopKey(rightRaw);
  }

  function normalizeDirectionText(value) {
    return String(value ?? "")
      .trim()
      .toLocaleLowerCase("bg-BG")
      .replace(/\s+/g, " ")
      .replace(/[–—]/g, "-")
      .replace(/[.]/g, "")
      .trim();
  }

  function normalizeStopName(value) {
    return String(value ?? "")
      .trim()
      .toLocaleLowerCase("bg-BG")
      .replace(/["„“”'’]/g, "")
      .replace(/[–—-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  window.GTSofiaVirtualBoardUtils = Object.freeze({
    escapeHtml,
    formatClockTime,
    parseGtfsTime,
    getArrivalMinutes,
    formatArrivalCountdown,
    formatArrivalClock,
    normalizeStopKey,
    stopIdsMatch,
    normalizeDirectionText,
    normalizeStopName
  });
})();
