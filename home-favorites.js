(() => {
  const FAVORITE_STOPS_KEY = "gtsofia.favoriteStops";

  function getFavoriteStops() {
    try {
      const value = JSON.parse(localStorage.getItem(FAVORITE_STOPS_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function renderFavoriteStops() {
    const section = document.getElementById("favoriteStopsSection");
    const list = document.getElementById("favoriteStopsList");
    if (!section || !list) return;

    const favorites = getFavoriteStops();
    if (!favorites.length) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    list.innerHTML = favorites.map(stop => `
      <a class="home-favorite-stop" href="virtual-boards.html?stop=${encodeURIComponent(stop.stop_id)}">
        <span class="home-favorite-stop-star" aria-hidden="true">★</span>
        <span class="home-favorite-stop-info">
          <strong>${escapeHtml(stop.stop_name || "Спирка")}</strong>
          <span>[${escapeHtml(stop.stop_code || stop.stop_id || "")}]</span>
        </span>
        <span class="home-favorite-stop-arrow" aria-hidden="true">→</span>
      </a>
    `).join("");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  document.addEventListener("DOMContentLoaded", renderFavoriteStops);
  window.addEventListener("pageshow", renderFavoriteStops);
})();
