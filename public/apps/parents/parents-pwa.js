(() => {
  const installButtons = document.querySelectorAll("[data-install-portal]");
  const guide = document.querySelector("#installGuide");
  const instructions = document.querySelector("#installInstructions");
  const offline = document.querySelector("#offlineNotice");
  const standalone = window.matchMedia("(display-mode: standalone)");
  let installPrompt;
  let installed = navigator.standalone === true;

  function updateButtons() {
    installButtons.forEach((button) => {
      button.hidden = !window.isSecureContext || installed || standalone.matches;
    });
  }

  function showGuide() {
    const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const isMacSafari = navigator.userAgent.includes("Macintosh") &&
      navigator.userAgent.includes("Safari") && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
    instructions.textContent = isAppleMobile
      ? "In Safari, open the Share menu, tap Add to Home Screen, and turn on Open as Web App if shown. Then tap Add."
      : isMacSafari
        ? "In Safari, choose File, then Add to Dock."
        : "Open your browser’s menu and choose Install app or Add to Home screen if available.";
    if (!guide.open) guide.showModal();
  }

  async function install() {
    if (installed || standalone.matches) return;
    if (!installPrompt) return showGuide();

    const prompt = installPrompt;
    installPrompt = null;
    installButtons.forEach((button) => { button.disabled = true; });
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      installed ||= choice.outcome === "accepted";
    } catch {
      showGuide();
    } finally {
      installButtons.forEach((button) => { button.disabled = false; });
      updateButtons();
    }
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    updateButtons();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    installPrompt = null;
    if (guide.open) guide.close();
    updateButtons();
  });
  standalone.addEventListener("change", updateButtons);
  installButtons.forEach((button) => button.addEventListener("click", install));
  updateButtons();

  function updateConnection() {
    offline.hidden = navigator.onLine && !document.body.hasAttribute("data-offline-launch");
  }
  window.addEventListener("online", () => {
    document.body.removeAttribute("data-offline-launch");
    updateConnection();
  });
  window.addEventListener("offline", updateConnection);
  document.querySelector("#retryPortal").addEventListener("click", () => location.reload());
  updateConnection();

  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
