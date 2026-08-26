async function getAlerts() {
  const res = await fetch("alerts.json");
  return await res.json();
}

/* =========================
ICON + COLOR CONFIG
========================= */

const ICONS = {
  bus: "https://raw.githubusercontent.com/nikolay5555/gtsofia/refs/heads/main/Icons/Active%20icons/bus.svg",
  tourist: "https://raw.githubusercontent.com/nikolay5555/gtsofia/refs/heads/main/Icons/Active%20icons/torist-bus.svg",
  night: "https://raw.githubusercontent.com/nikolay5555/gtsofia/refs/heads/main/Icons/Active%20icons/night-bus.svg",
  trolley: "https://raw.githubusercontent.com/nikolay5555/gtsofia/refs/heads/main/Icons/Active%20icons/trolley.svg",
  tram: "https://raw.githubusercontent.com/nikolay5555/gtsofia/refs/heads/main/Icons/Active%20icons/tram.svg",
  metro: "https://raw.githubusercontent.com/nikolay5555/gtsofia/refs/heads/main/Icons/Active%20icons/metro.svg"
};

/* =========================
COLORS
========================= */

function getMetroColor(line) {
  switch (String(line)) {
    case "1": return "#ec2029";
    case "2": return "#1077bc";
    case "3": return "#3bb44b";
    case "4": return "#fcd403";
    default: return "#111827";
  }
}

function getMetroTextColor(line) {
  return String(line) === "4" ? "black" : "white";
}

function getTypeColor(type) {
  switch (type) {
    case "bus": return "#BD202E";
    case "tourist": return "#006838";
    case "night": return "#000000";
    case "trolley": return "#2AA9E0";
    case "tram": return "#F7941F";
    case "metro": return "#111827";
    default: return "#111827";
  }
}

function getIcon(type) {
  return ICONS[type] || ICONS.bus;
}

/* =========================
ALERT LINES HTML
========================= */

function renderAlertLines(lines = []) {
  if (!lines.length) return "";

  const grouped = lines.reduce((acc, line) => {
    if (!acc[line.type]) {
      acc[line.type] = [];
    }

    acc[line.type].push(line.number);
    return acc;
  }, {});

  return Object.entries(grouped).map(([type, numbers]) => {

    const icon = getIcon(type);
    const isMetro = type === "metro";

    return `
      <div class="alert-line-group">

        <div class="alert-line-icon">
          <img src="${icon}" alt="">
        </div>

        <div class="alert-line-badges">

          ${
            isMetro
              ? numbers.map(number => `
                  <div
                    class="alert-metro-pill"
                    style="
                      background:${getMetroColor(number)};
                      color:${getMetroTextColor(number)};
                    "
                  >
                    ${number}
                  </div>
                `).join("")
              : numbers.map(number => `
                  <div
                    class="alert-line-pill"
                    style="
                      background:${getTypeColor(type)};
                    "
                  >
                    ${number}
                  </div>
                `).join("")
          }

        </div>

      </div>
    `;
  }).join("");
}

/* =========================
HOME PAGE ALERTS
========================= */

async function loadHomeAlerts() {
  const container = document.getElementById("alertsContainer");
  if (!container) return;

  const alerts = await getAlerts();

  if (!alerts.length) {
    container.innerHTML = "<p>Няма активни маршрутни промени.</p>";
    return;
  }

  container.innerHTML = alerts.map(alert => {

    const linesHTML = renderAlertLines(alert.lines || []);

    return `
      <div class="info-card" style="margin-bottom:10px;">

        <div style="margin-bottom:10px;">
          ${linesHTML}
        </div>

        <div style="margin-bottom:10px;font-size:15px;color:#374151;">
          ${alert.text}
        </div>

        ${
          alert.to
            ? `
              <div style="font-size:14px;color:#6b7280;">
                До: ${alert.to}
              </div>
            `
            : ""
        }

      </div>
    `;
  }).join("");
}

/* =========================
TRANSPORT PAGE ALERTS
========================= */

async function showLineAlerts(lineNumber, lineType) {
  const container = document.getElementById("lineAlerts");
  if (!container) return;

  const alerts = await getAlerts();

  // Tourist alerts that also need to appear
  // on the corresponding normal bus page.
  const touristLines = ["X43"];

  const filtered = alerts.filter(alert =>
    (alert.lines || []).some(line => {

      // Normal exact match
      if (
        line.type === lineType &&
        String(line.number) === String(lineNumber)
      ) {
        return true;
      }

      // Tourist -> bus special case
      if (
        line.type === "tourist" &&
        lineType === "bus" &&
        touristLines.includes(String(lineNumber)) &&
        String(line.number) === String(lineNumber)
      ) {
        return true;
      }

      return false;
    })
  );

  if (!filtered.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = filtered.map((alert, index) => `
<button
  type="button"
  class="info-card transport-alert-card"
  onclick="openTransportAlert(${index})"
>
  <span class="transport-alert-label">
    <strong>Промяна на маршрута или разписанието</strong>
  </span>

  <span class="transport-alert-hint">
    Натисни за повече подробности
  </span>
</button>
  `).join("");

  // Make the currently displayed alerts available
  // to the modal functions.
  window.currentTransportAlerts = filtered;
}

/* =========================
TRANSPORT ALERT MODAL
========================= */

function openTransportAlert(index) {
  const alerts = window.currentTransportAlerts || [];
  const alert = alerts[index];

  if (!alert) return;

  closeTransportAlert();

  const modal = document.createElement("div");
  modal.className = "transport-alert-modal";
  modal.id = "transportAlertModal";

  modal.innerHTML = `
    <div
      class="transport-alert-backdrop"
      onclick="closeTransportAlert()"
    ></div>

    <div
      class="transport-alert-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Промяна на маршрута или разписанието"
    >

      <button
        type="button"
        class="transport-alert-close"
        onclick="closeTransportAlert()"
        aria-label="Затвори"
      >
        ×
      </button>

      <div class="transport-alert-dialog-title">
        Промяна на маршрута или разписанието
      </div>

      <div class="transport-alert-dialog-lines">
        ${renderAlertLines(alert.lines || [])}
      </div>

      ${
        alert.title
          ? `
            <div class="transport-alert-dialog-subtitle">
              ${alert.title}
            </div>
          `
          : ""
      }

      <div class="transport-alert-dialog-text">
        ${alert.text}
      </div>

      ${
        alert.to
          ? `
            <div class="transport-alert-dialog-to">
              До: ${alert.to}
            </div>
          `
          : ""
      }

    </div>
  `;

  document.body.appendChild(modal);

  document.body.classList.add("transport-alert-modal-open");

  requestAnimationFrame(() => {
    modal.classList.add("is-visible");
  });

  // ESC closes the modal
  document.addEventListener(
    "keydown",
    handleTransportAlertEscape
  );
}

function handleTransportAlertEscape(event) {
  if (event.key === "Escape") {
    closeTransportAlert();
  }
}

function closeTransportAlert() {
  const modal = document.getElementById("transportAlertModal");

  if (!modal) return;

  modal.classList.remove("is-visible");

  setTimeout(() => {
    modal.remove();
    document.body.classList.remove("transport-alert-modal-open");
  }, 180);

  document.removeEventListener(
    "keydown",
    handleTransportAlertEscape
  );
}
