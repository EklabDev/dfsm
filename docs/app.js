document.addEventListener("DOMContentLoaded", () => {
  // 1. Initialize Mermaid
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: true,
      theme: document.documentElement.getAttribute("data-theme") === "light" ? "default" : "dark",
      themeVariables: {
        darkMode: document.documentElement.getAttribute("data-theme") !== "light",
        primaryColor: "#38bdf8",
        primaryTextColor: "#f8fafc",
        primaryBorderColor: "#334155",
        lineColor: "#94a3b8",
        secondaryColor: "#1e293b",
        tertiaryColor: "#0f172a"
      }
    });
  }

  // 2. Syntax Highlighting
  if (window.hljs) {
    hljs.highlightAll();
  }

  // 3. Tab Switching
  document.querySelectorAll(".tabs-container").forEach((container) => {
    const btns = container.querySelectorAll(".tab-btn");
    const panes = container.querySelectorAll(".tab-pane");

    btns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetTab = btn.getAttribute("data-tab");

        btns.forEach((b) => b.classList.remove("active"));
        panes.forEach((p) => p.classList.remove("active"));

        btn.classList.add("active");
        const activePane = container.querySelector(`.tab-pane[data-tab="${targetTab}"]`);
        if (activePane) {
          activePane.classList.add("active");
        }
      });
    });
  });

  // 4. Copy Code to Clipboard
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pane = btn.closest(".tab-pane");
      const code = pane ? pane.querySelector("code") : null;
      if (code) {
        navigator.clipboard.writeText(code.innerText).then(() => {
          const orig = btn.innerText;
          btn.innerText = "Copied!";
          btn.style.color = "var(--accent-green)";
          setTimeout(() => {
            btn.innerText = orig;
            btn.style.color = "";
          }, 2000);
        });
      }
    });
  });

  // 5. Theme Toggle
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    const savedTheme = localStorage.getItem("dfsm-theme") || "dark";
    document.documentElement.setAttribute("data-theme", savedTheme);
    themeBtn.innerText = savedTheme === "light" ? "🌙 Dark" : "☀️ Light";

    themeBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("dfsm-theme", next);
      themeBtn.innerText = next === "light" ? "🌙 Dark" : "☀️ Light";
      location.reload(); // Reload to refresh Mermaid theme styles
    });
  }

  // 6. Search Filter
  const searchInput = document.getElementById("doc-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const query = e.target.value.toLowerCase().trim();
      document.querySelectorAll("section").forEach((sec) => {
        const text = sec.innerText.toLowerCase();
        if (!query || text.includes(query)) {
          sec.style.display = "";
        } else {
          sec.style.display = "none";
        }
      });
    });
  }

  // 7. Active Navigation Highlighting on Scroll
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute("id");
          document.querySelectorAll(".nav-links a").forEach((a) => {
            if (a.getAttribute("href") === `#${id}`) {
              a.classList.add("active");
            } else {
              a.classList.remove("active");
            }
          });
        }
      });
    },
    { threshold: 0.25 }
  );

  document.querySelectorAll("section[id]").forEach((sec) => observer.observe(sec));
});

