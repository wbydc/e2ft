// Runs before first paint (classic script in <head>), so a saved theme never flashes the other one. It cannot
// import, so the keys are literals: keep them in step with KEYS in src/store.ts.
try {
  var t = localStorage.getItem("wb-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  var c = localStorage.getItem("share-calm");
  localStorage.removeItem("share-fun");
  if (!(c === "1" || (c === null && matchMedia("(prefers-reduced-motion: reduce)").matches)))
    document.documentElement.classList.add("fun");
} catch {}
