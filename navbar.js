function toggleMenu() {
  const nav = document.getElementById("navMenu");
  nav.classList.toggle("open");
}

// Close menu after clicking a link (mobile UX improvement)
document.addEventListener("DOMContentLoaded", () => {
  const nav = document.getElementById("navMenu");

  nav.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", () => {
      nav.classList.remove("open");
    });
  });
});

// Close menu when clicking outside of navbar
document.addEventListener("click", (e) => {
  const nav = document.getElementById("navMenu");
  const toggle = document.querySelector(".nav-toggle");
  const navbar = document.querySelector(".navbar");

  if (!navbar) return;

  const clickedInside = navbar.contains(e.target);

  if (!clickedInside) {
    nav.classList.remove("open");
  }
});

// Register the offline shell on static hosting and explain when live data is unavailable.
document.addEventListener("DOMContentLoaded", () => {
  const navbar = document.querySelector(".navbar");
  let status = document.getElementById("networkStatus");

  if (!status && navbar) {
    status = document.createElement("div");
    status.id = "networkStatus";
    status.className = "network-status";
    status.setAttribute("role", "status");
    status.hidden = true;
    navbar.insertAdjacentElement("afterend", status);
  }

  const updateNetworkStatus = () => {
    if (!status) return;
    status.hidden = navigator.onLine;
    status.textContent = navigator.onLine
      ? ""
      : "Няма интернет връзка. Показваме кешираните данни, когато са налични; realtime пристиганията не са актуални.";
  };

  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  updateNetworkStatus();

  if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
    navigator.serviceWorker.register(new URL("./service-worker.js", document.baseURI))
      .catch(error => console.warn("GTSofia: service worker registration failed.", error));
  }
});
