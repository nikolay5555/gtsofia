(() => {
  const THEME_KEY = "gtsofia.theme";
  const THEMES = ["light", "dark", "auto"];

  function getStoredTheme() {
    try {
      const value = localStorage.getItem(THEME_KEY);
      return THEMES.includes(value) ? value : "auto";
    } catch {
      return "auto";
    }
  }

  function getEffectiveTheme(theme) {
    if (theme === "auto") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return theme;
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = getEffectiveTheme(theme);
    document.documentElement.dataset.themePreference = theme;
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Keep the current theme for this page if storage is unavailable.
    }
    applyTheme(theme);
    updateThemeControls(theme);
  }

  function updateThemeControls(theme) {
    const button = document.getElementById("themeToggle");
    const menu = document.getElementById("themeMenu");
    if (!button || !menu) return;

    const labels = {
      light: "Светъл режим",
      dark: "Тъмен режим",
      auto: "Автоматичен режим"
    };

    button.setAttribute("aria-label", labels[theme]);
    button.setAttribute("title", labels[theme]);
    button.setAttribute("aria-expanded", menu.hidden ? "false" : "true");

    menu.querySelectorAll("[data-theme-choice]").forEach(option => {
      const active = option.dataset.themeChoice === theme;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function closeThemeMenu() {
    const menu = document.getElementById("themeMenu");
    const button = document.getElementById("themeToggle");
    if (!menu || !button) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  function initTheme() {
    const theme = getStoredTheme();
    applyTheme(theme);

    const switcher = document.querySelector(".theme-switcher");
    const button = document.getElementById("themeToggle");
    const menu = document.getElementById("themeMenu");
    if (!switcher || !button || !menu) return;

    button.addEventListener("click", event => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      updateThemeControls(themeState());
    });

    menu.querySelectorAll("[data-theme-choice]").forEach(option => {
      option.addEventListener("click", () => {
        saveTheme(option.dataset.themeChoice);
        closeThemeMenu();
      });
    });

    document.addEventListener("click", event => {
      if (!switcher.contains(event.target)) closeThemeMenu();
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeThemeMenu();
    });

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemChange = () => {
      if (themeState() === "auto") applyTheme("auto");
    };
    if (media.addEventListener) {
      media.addEventListener("change", handleSystemChange);
    } else {
      media.addListener(handleSystemChange);
    }

    updateThemeControls(themeState());
  }

  function themeState() {
    return document.documentElement.dataset.themePreference || getStoredTheme();
  }

  // Apply the saved choice as early as possible. The small inline bootstrap
  // in each page prevents a visible light-theme flash before this file loads.
  document.addEventListener("DOMContentLoaded", initTheme);
  window.addEventListener("pageshow", () => {
    const theme = getStoredTheme();
    applyTheme(theme);
    updateThemeControls(theme);
  });
})();