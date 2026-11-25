$(document).ready(function () {
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const DB_NAME = "MangaFlipLibraryDB";
  const DB_VERSION = 1;
  const STORE_NAME = "mangaBooks";

  const TURN_DURATIONS = {
    crisp: 450,
    smooth: 650,
    slow: 950,
  };

  // Detect optimal spread mode based on device viewport & orientation
  function getRecommendedDisplay() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const isPortrait = h > w;
    // Mobile (< 768px) or Portrait Tablet (< 1024px in portrait) -> single page
    if (w < 768 || (w < 1024 && isPortrait)) {
      return "single";
    }
    return "double";
  }

  const state = {
    bookId: null,
    bookTitle: "Sample Volume",
    pages: [],
    currentPage: 1,
    mode: "flip", // 'flip' | 'webtoon' | 'horizontal'
    direction: "rtl", // 'rtl' (Manga) | 'ltr'
    display: getRecommendedDisplay(),
    userOverrodeSpread: false, // Tracks if user manually clicked Single/Double
    turnStyle: "smooth",
    zoom: 1,
    panX: 0,
    panY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
    library: [],
  };

  let db = null;
  const viewportEl = document.getElementById("viewport");

  // --- INDEXEDDB LAYER ---
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetAllBooks() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function dbPutBook(bookRecord) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(bookRecord);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function dbDeleteBook(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function revokeActiveUrls() {
    state.pages.forEach((src) => {
      if (typeof src === "string" && src.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    });
  }

  function blobsToUrls(blobs) {
    revokeActiveUrls();
    return blobs.map((b) => (typeof b === "string" ? b : URL.createObjectURL(b)));
  }

  // --- DASHBOARD RENDERING ---
  async function refreshLibrary(filterText = "") {
    if (!db) return;
    $("#library-grid img").each(function () {
      if (this.src.startsWith("blob:")) URL.revokeObjectURL(this.src);
    });
    state.library = await dbGetAllBooks();
    state.library.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const q = filterText.trim().toLowerCase();
    const list = q
      ? state.library.filter((b) => (b.title || "").toLowerCase().includes(q))
      : state.library;

    const $grid = $("#library-grid").empty();
    if (!list.length) {
      $grid.append(
        `<div style="opacity:0.7;font-size:14px;">No saved manga yet. Click <b>＋ Add Manga</b> to upload images, CBZ, ZIP, or PDF.</div>`
      );
      return;
    }

    list.forEach((book) => {
      const coverUrl = book.coverBlob ? URL.createObjectURL(book.coverBlob) : "";
      const lastPage = book.lastPage || 1;
      const total = book.pageBlobs ? book.pageBlobs.length : 0;

      const $card = $(`
        <div class="manga-card" data-id="${book.id}">
          <div class="manga-cover-wrap" title="Open ${escapeHtml(book.title)}">
            <img src="${coverUrl}" alt="${escapeHtml(book.title)}" loading="lazy" />
            <span class="manga-progress-badge">P.${lastPage}/${total}</span>
          </div>
          <div class="manga-card-body">
            <div>
              <div class="manga-title">${escapeHtml(book.title)}</div>
              <div class="manga-meta">${total} pages • ${(book.direction || "rtl").toUpperCase()}</div>
            </div>
            <div class="manga-card-btns">
              <button class="btn primary-btn open-book-btn">Read</button>
              <button class="btn rename-book-btn" title="Rename">✎</button>
              <button class="btn del-book-btn" title="Delete">🗑</button>
            </div>
          </div>
        </div>
      `);

      $card.find(".manga-cover-wrap, .open-book-btn").on("click", () => {
        loadBookFromLibrary(book.id);
        toggleLibraryDrawer(false);
      });

      $card.find(".rename-book-btn").on("click", async (e) => {
        e.stopPropagation();
        const nextName = prompt("Rename manga title:", book.title);
        if (nextName && nextName.trim()) {
          book.title = nextName.trim();
          await dbPutBook(book);
          if (state.bookId === book.id) {
            state.bookTitle = book.title;
            $("#file-status").text(`${state.bookTitle} (${state.pages.length}p)`);
          }
          refreshLibrary($("#library-search").val());
        }
      });

      $card.find(".del-book-btn").on("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${book.title}" from your saved shelf?`)) {
          await dbDeleteBook(book.id);
          refreshLibrary($("#library-search").val());
        }
      });

      $grid.append($card);
    });
  }

  async function loadBookFromLibrary(bookId) {
    const all = await dbGetAllBooks();
    const book = all.find((b) => b.id === bookId);
    if (!book || !book.pageBlobs || !book.pageBlobs.length) return;

    state.bookId = book.id;
    state.bookTitle = book.title;
    state.pages = blobsToUrls(book.pageBlobs);
    state.currentPage = Math.min(state.pages.length, Math.max(1, book.lastPage || 1));
    state.direction = book.direction || state.direction;
    resetTransform();
    $("#file-status").text(`${state.bookTitle} (${state.pages.length}p)`);
    renderAll();
  }

  async function saveCurrentProgress() {
    if (!state.bookId || !db) return;
    const id = state.bookId,
      page = state.currentPage,
      direction = state.direction;
    const all = await dbGetAllBooks();
    const book = all.find((b) => b.id === id);
    if (!book) return;
    book.lastPage = page;
    book.direction = direction;
    book.updatedAt = Date.now();
    await dbPutBook(book);
  }

  function toggleLibraryDrawer(forceState) {
    const isHidden = $("#library-drawer").hasClass("hidden");
    const show = typeof forceState === "boolean" ? forceState : isHidden;
    if (show) {
      refreshLibrary($("#library-search").val());
      $("#library-drawer").removeClass("hidden");
    } else {
      $("#library-drawer").addClass("hidden");
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // --- SAMPLE DECK ---
  function loadSampleDeck() {
    const colors = ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51", "#1d3557"];
    revokeActiveUrls();
    state.bookId = null;
    state.bookTitle = "Sample Deck";
    state.pages = colors.map((hex, i) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850">
        <rect width="100%" height="100%" fill="${hex}"/>
        <text x="50%" y="44%" font-family="sans-serif" font-size="40" fill="#fff" text-anchor="middle">Page ${i + 1}</text>
        <text x="50%" y="52%" font-family="sans-serif" font-size="18" fill="#eee" text-anchor="middle">Add Manga to Save to Shelf</text>
      </svg>`;
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
    state.currentPage = 1;
    $("#file-status").text("Sample Deck");
    renderAll();
  }

  const naturalSort = (a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

  // --- MULTI-FORMAT UPLOAD ---
  $("#file-upload").on("change", async function (e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    $("#file-status").text("Extracting & saving...");
    try {
      files.sort((a, b) => naturalSort(a.name, b.name));

      const pageBlobs = [];
      let inferredTitle = files[0].name.replace(/\.(cbz|zip|pdf|jpe?g|png|webp|gif|bmp|avif)$/i, "");

      for (const file of files) {
        const ext = file.name.split(".").pop().toLowerCase();

        if (["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"].includes(ext)) {
          pageBlobs.push(file);
        } else if (ext === "cbz" || ext === "zip") {
          const zip = await JSZip.loadAsync(file);
          const imgEntries = Object.keys(zip.files)
            .filter((name) => !zip.files[name].dir && /\.(jpe?g|png|webp|gif|avif)$/i.test(name))
            .sort(naturalSort);

          for (const name of imgEntries) {
            const blob = await zip.files[name].async("blob");
            pageBlobs.push(blob);
          }
        } else if (ext === "pdf") {
          const arrayBuffer = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const viewport = page.getViewport({ scale: 1.6 });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.88));
            if (blob) pageBlobs.push(blob);
          }
        }
      }

      if (!pageBlobs.length) {
        $("#file-status").text("No valid images found");
        return;
      }

      const id = "manga_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      const record = {
        id,
        title: inferredTitle || "Untitled Manga",
        coverBlob: pageBlobs[0],
        pageBlobs,
        lastPage: 1,
        direction: state.direction,
        updatedAt: Date.now(),
      };

      await dbPutBook(record);
      await loadBookFromLibrary(id);
      toggleLibraryDrawer(false);
    } catch (err) {
      console.error(err);
      alert("Import failed: " + err.message);
      $("#file-status").text("Import failed");
    } finally {
      e.target.value = "";
    }
  });

  // --- STACKED PAGE THICKNESS & BOOK RENDERING ---
  function updateStackThickness() {
    const total = Math.max(1, state.pages.length);
    const cur = Math.min(total, Math.max(1, state.currentPage));
    const maxPx = 14;
    const minPx = 2;

    const beforeRatio = (cur - 1) / total;
    const afterRatio = (total - cur) / total;

    const leftPx = Math.round(minPx + beforeRatio * (maxPx - minPx));
    const rightPx = Math.round(minPx + afterRatio * (maxPx - minPx));

    document.documentElement.style.setProperty("--left-stack", `${leftPx}px`);
    document.documentElement.style.setProperty("--right-stack", `${rightPx}px`);
    $("#book-stage").toggleClass("single-book", state.display === "single");
  }

  function renderAll() {
    $("#page-total").text(`/ ${state.pages.length}`);
    $("#page-input").attr("max", state.pages.length).val(state.currentPage);
    $("#spread-btn").text(state.display === "double" ? "🗐 Double" : "🗎 Single");
    $("#dir-btn").text(state.direction === "rtl" ? "⬅ RTL (Manga)" : "LTR ➔");

    updateStackThickness();
    updateProgress();
    renderThumbnails();

    if (state.mode === "flip") {
      $("#book-stage").removeClass("hidden");
      $("#scroll-reader").addClass("hidden");
      $("#zone-left, #zone-right").removeClass("hidden");
      initFlipbook();
    } else {
      $("#book-stage").addClass("hidden");
      $("#zone-left, #zone-right").addClass("hidden");
      $("#scroll-reader")
        .removeClass("hidden")
        .toggleClass("horizontal", state.mode === "horizontal");
      renderScrollReader();
      requestAnimationFrame(() => {
        const img = document.querySelector(`#scroll-reader img[data-page="${state.currentPage}"]`);
        if (img) img.scrollIntoView({ block: "start", inline: "start" });
      });
    }
  }

  function initFlipbook() {
    const $wrapper = $("#flipbook-wrapper");
    if ($("#flipbook").turn("is")) {
      $("#flipbook").turn("destroy");
    }
    $wrapper.html('<div id="flipbook" class="flipbook"></div>');
    const $fb = $("#flipbook");

    state.pages.forEach((src, idx) => {
      const realPageNum = idx + 1;
      const isFirst = idx === 0;
      const isLast = idx === state.pages.length - 1;
      const hardClass = isFirst || isLast ? "hard" : "";

      $fb.append(
        `<div class="page ${hardClass}" data-real-page="${realPageNum}">
          <img src="${src}" alt="Page ${realPageNum}" />
        </div>`
      );
    });

    const dims = calculateBookDimensions();
    // Lock exact stage dimensions so it never shifts during page flips
    $("#book-stage").css({ width: dims.width, height: dims.height });

    $fb.turn({
      width: dims.width,
      height: dims.height,
      display: state.display,
      direction: state.direction,
      autoCenter: false, // FIXED: Prevents turn.js from shifting marginLeft on cover turns
      gradients: true,
      acceleration: true,
      duration: TURN_DURATIONS[state.turnStyle] || 650,
      page: state.currentPage,
      when: {
        turning: function () {
          // Ensure book stays locked at marginLeft: 0 during turn
          $(this).css("margin-left", "0px");
        },
        turned: function (e, page) {
          $(this).css("margin-left", "0px");
          state.currentPage = page;
          $("#page-input").val(page);
          updateStackThickness();
          highlightThumbnail(page);
          saveCurrentProgress();
        },
      },
    });

    // Disable corner drag-peeling if currently zoomed in so panning doesn't trigger accidental flips
    $fb.turn("disable", state.zoom > 1);
  }

  function calculateBookDimensions() {
    const padW = window.innerWidth < 768 ? 16 : 36;
    const padH = window.innerWidth < 768 ? 16 : 28;
    const availW = Math.max(120, viewportEl.clientWidth - padW);
    const availH = Math.max(120, viewportEl.clientHeight - padH);
    const aspect = 0.7;

    let pageH = availH;
    let pageW = pageH * aspect;

    const totalW = state.display === "double" ? pageW * 2 : pageW;
    if (totalW > availW) {
      const scale = availW / totalW;
      pageW *= scale;
      pageH *= scale;
    }
    return {
      width: Math.round(state.display === "double" ? pageW * 2 : pageW),
      height: Math.round(pageH),
    };
  }

  function resizeBook() {
    if (state.mode === "flip" && $("#flipbook").turn("is")) {
      const d = calculateBookDimensions();
      $("#book-stage").css({ width: d.width, height: d.height });
      $("#flipbook").turn("size", d.width, d.height).css("margin-left", "0px");
      applyTransform(); // Re-clamp pan bounds for new size
    }
  }

  function renderScrollReader() {
    const $sr = $("#scroll-reader").empty();
    $sr.attr("dir", state.mode === "horizontal" ? state.direction : "ltr");
    state.pages.forEach((src, idx) => {
      const $img = $(`<img src="${src}" data-page="${idx + 1}" loading="lazy" />`);
      $img.on("click", () => {
        state.currentPage = idx + 1;
        $("#page-input").val(state.currentPage);
        updateStackThickness();
        highlightThumbnail(state.currentPage);
        saveCurrentProgress();
      });
      $sr.append($img);
    });
  }

  function renderThumbnails() {
    const $strip = $("#thumbnail-strip").empty();
    state.pages.forEach((src, idx) => {
      const pNum = idx + 1;
      const $slide = $(`
        <div class="thumb-slide ${pNum === state.currentPage ? "active" : ""}" data-page="${pNum}">
          <img src="${src}" loading="lazy" />
          <span class="thumb-num">${pNum}</span>
        </div>
      `);
      $slide.on("click", () => goToPage(pNum, true));
      $strip.append($slide);
    });
  }

  function highlightThumbnail(pageNum) {
    updateProgress();
    $(".thumb-slide").removeClass("active");
    const $active = $(`.thumb-slide[data-page="${pageNum}"]`).addClass("active");
    if ($active.length) {
      $active[0].scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }

  function goToPage(targetPage) {
    targetPage = Math.max(1, Math.min(state.pages.length, parseInt(targetPage, 10)));
    if (isNaN(targetPage)) return;

    if (state.mode !== "flip") {
      state.currentPage = targetPage;
      $("#page-input").val(targetPage);
      updateStackThickness();
      highlightThumbnail(targetPage);
      saveCurrentProgress();
      const $img = $(`#scroll-reader img[data-page="${targetPage}"]`);
      if ($img.length) $img[0].scrollIntoView({ behavior: "smooth" });
      return;
    }

    const $fb = $("#flipbook");
    if ($fb.turn("is")) {
      // Temporarily allow programmatic page turn even when zoomed in
      const wasDisabled = $fb.turn("disabled");
      if (wasDisabled) $fb.turn("disable", false);
      $fb.turn("page", targetPage);
      if (wasDisabled) $fb.turn("disable", true);
    }
  }

  function navigate(delta) {
    if (state.mode === "flip" && $("#flipbook").turn("is")) {
      const $fb = $("#flipbook");
      if (!$fb.turn("animating")) {
        const wasDisabled = $fb.turn("disabled");
        if (wasDisabled) $fb.turn("disable", false);
        $fb.turn(delta > 0 ? "next" : "previous");
        if (wasDisabled) $fb.turn("disable", true);
      }
    } else {
      goToPage(state.currentPage + delta);
    }
  }

  function physical(side) {
    navigate(side * (state.direction === "rtl" ? -1 : 1));
  }

  $("#zone-right").on("click", () => physical(1));
  $("#zone-left").on("click", () => physical(-1));

  $(document).on("keydown", (e) => {
    if (e.key === "Escape") {
      toggleLibraryDrawer(false);
      setFocus(false);
      return;
    }
    if ($(e.target).is("input, select, textarea, button") || !$("#library-drawer").hasClass("hidden")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      physical(e.key === "ArrowRight" ? 1 : -1);
    }
    if (e.key === " ") {
      e.preventDefault();
      navigate(1);
    }
    if (e.key.toLowerCase() === "f") setFocus(!document.body.classList.contains("focus-mode"));
  });

  // --- ANCHORED ZOOM & BOUNDED PAN ---
  function clampPan() {
    if (state.zoom <= 1) {
      state.panX = 0;
      state.panY = 0;
      return;
    }
    const stage = document.getElementById("book-stage");
    const maxPanX = Math.max(0, (stage.offsetWidth * state.zoom - viewportEl.clientWidth) / 2 + 40);
    const maxPanY = Math.max(0, (stage.offsetHeight * state.zoom - viewportEl.clientHeight) / 2 + 40);
    state.panX = Math.max(-maxPanX, Math.min(maxPanX, state.panX));
    state.panY = Math.max(-maxPanY, Math.min(maxPanY, state.panY));
  }

  function applyTransform() {
    if (state.mode !== "flip") {
      $("#pan-zoom-layer").css("transform", "none");
      $("#scroll-reader").css("--reader-zoom", state.zoom);
      $("#zoom-level").text(`${Math.round(state.zoom * 100)}%`);
      return;
    }

    // Anchor at 1.0 minimum so book never shrinks away from center
    state.zoom = Math.max(1, Math.min(4, state.zoom));
    clampPan();

    const $layer = $("#pan-zoom-layer");
    // Disable CSS transition while actively dragging so pan tracks finger/mouse 1:1 without lag
    $layer.css("transition", state.isDragging ? "none" : "transform 0.12s ease-out");
    $layer.css(
      "transform",
      `translate3d(${state.panX}px, ${state.panY}px, 0) scale(${state.zoom})`
    );
    $("#zoom-level").text(`${Math.round(state.zoom * 100)}%`);
    $("#viewport").toggleClass("is-zoomed", state.zoom > 1);

    // Prevent turn.js corner drag from fighting pan gestures when zoomed in
    if ($("#flipbook").turn("is")) {
      $("#flipbook").turn("disable", state.zoom > 1);
    }
  }

  function resetTransform() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.isDragging = false;
    applyTransform();
  }

  $("#zoom-in").on("click", () => {
    state.zoom = Math.min(4, +(state.zoom + 0.25).toFixed(2));
    applyTransform();
  });

  $("#zoom-out").on("click", () => {
    state.zoom = Math.max(1, +(state.zoom - 0.25).toFixed(2));
    applyTransform();
  });

  $("#zoom-reset").on("click", resetTransform);

  $("#viewport").on("wheel", function (e) {
    if (state.mode !== "flip" || !e.originalEvent.ctrlKey) return;
    e.preventDefault();
    const delta = e.originalEvent.deltaY < 0 ? 0.15 : -0.15;
    state.zoom = Math.min(4, Math.max(1, +(state.zoom + delta).toFixed(2)));
    applyTransform();
  });

  viewportEl.addEventListener("pointerdown", (e) => {
    if (state.zoom <= 1 || state.mode !== "flip") return;
    if (e.target.closest(".nav-zone")) return;
    state.isDragging = true;
    state.startX = e.clientX - state.panX;
    state.startY = e.clientY - state.panY;
  });

  window.addEventListener("pointermove", (e) => {
    if (!state.isDragging) return;
    state.panX = e.clientX - state.startX;
    state.panY = e.clientY - state.startY;
    applyTransform();
  });

  window.addEventListener("pointerup", () => {
    if (state.isDragging) {
      state.isDragging = false;
      applyTransform();
    }
  });

  // --- CONTROLS ---
  $("#library-btn").on("click", () => toggleLibraryDrawer());
  $("#close-library-btn").on("click", () => toggleLibraryDrawer(false));
  $("#library-search").on("input", function () {
    refreshLibrary($(this).val());
  });

  $("#mode-select").on("change", function () {
    state.mode = $(this).val();
    resetTransform();
    renderAll();
  });

  $("#dir-btn").on("click", function () {
    state.direction = state.direction === "rtl" ? "ltr" : "rtl";
    renderAll();
    saveCurrentProgress();
  });

  $("#spread-btn").on("click", function () {
    state.userOverrodeSpread = true;
    state.display = state.display === "double" ? "single" : "double";
    resetTransform();
    renderAll();
  });

  $("#jump-btn").on("click", () => goToPage($("#page-input").val()));
  $("#page-input").on("keypress", (e) => {
    if (e.key === "Enter") goToPage($("#page-input").val());
  });

  $("#book-style-select").on("change", function () {
    $("html").attr("data-book-style", $(this).val());
  });

  $("#paper-select").on("change", function () {
    $("html").attr("data-paper", $(this).val());
  });

  $("#turn-style-select").on("change", function () {
    state.turnStyle = $(this).val();
    if (state.mode === "flip" && $("#flipbook").turn("is")) {
      $("#flipbook").turn("options", { duration: TURN_DURATIONS[state.turnStyle] });
    }
  });

  $("#theme-btn").on("click", function () {
    const isDark = $("html").attr("data-theme") === "dark";
    $("html").attr("data-theme", isDark ? "light" : "dark");
    $(this).text(isDark ? "☀️" : "🌙");
  });

  // --- AUTOMATIC DEVICE & VIEWPORT ADAPTATION ---
  function handleResponsiveAdaptation() {
    const recommended = getRecommendedDisplay();
    if (!state.userOverrodeSpread && state.display !== recommended) {
      state.display = recommended;
      resetTransform();
      renderAll();
    } else {
      resizeBook();
    }
  }

  let resizeTimer;
  $(window).on("resize orientationchange", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(handleResponsiveAdaptation, 80);
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => resizeBook()).observe(viewportEl);
  }

  function updateProgress() {
    const total = state.pages.length || 1;
    $("#reading-progress").text(
      `${state.currentPage} / ${total} · ${Math.round((state.currentPage / total) * 100)}%`
    );
    $("#scrub").attr("max", total).val(state.currentPage);
    $("#bookmark-btn").text(getMarks().includes(state.currentPage) ? "★ Marked" : "☆ Mark");
  }

  function getMarks() {
    try {
      return JSON.parse(localStorage.getItem("mv-marks-" + (state.bookId || "demo")) || "[]");
    } catch {
      return [];
    }
  }

  function setFocus(on) {
    document.body.classList.toggle("focus-mode", on);
    $("#exit-focus").toggleClass("hidden", !on);
    requestAnimationFrame(resizeBook);
  }

  $("#focus-btn").on("click", () => setFocus(true));
  $("#exit-focus").on("click", () => setFocus(false));
  $("#settings-btn").on("click", () => {
    document.body.classList.toggle("show-settings");
    requestAnimationFrame(resizeBook);
  });
  $("#thumb-toggle").on("click", () => {
    $(".thumbnail-dock").toggleClass("hidden");
    requestAnimationFrame(resizeBook);
  });
  $("#prev-btn").on("click", () => navigate(-1));
  $("#next-btn").on("click", () => navigate(1));
  $("#scrub").on("change", function () {
    goToPage(this.value);
  });
  $("#fullscreen-btn").on("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setFocus(true);
    }
  });
  $("#bookmark-btn").on("click", () => {
    let m = getMarks();
    m = m.includes(state.currentPage)
      ? m.filter((x) => x !== state.currentPage)
      : [...m, state.currentPage];
    try {
      localStorage.setItem("mv-marks-" + (state.bookId || "demo"), JSON.stringify(m));
      updateProgress();
    } catch {
      alert("Bookmark storage unavailable");
    }
  });
  $("#marks-btn").on("click", () => {
    const m = getMarks().sort((a, b) => a - b);
    if (!m.length) return alert("No bookmarks yet.");
    const d = document.createElement("dialog");
    const title = document.createElement("h2");
    title.textContent = "Bookmarks";
    d.append(title);
    m.forEach((n) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = "Page " + n;
      b.onclick = () => {
        goToPage(n);
        d.close();
      };
      d.append(b);
    });
    const close = document.createElement("button");
    close.className = "btn";
    close.textContent = "Close";
    close.onclick = () => d.close();
    d.append(close);
    d.onclose = () => d.remove();
    document.body.append(d);
    d.showModal();
  });

  let scrollTimer;
  $("#scroll-reader").on("scroll", function () {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (state.mode === "flip") return;
      const r = this.getBoundingClientRect();
      let best = null,
        dist = Infinity;
      for (const img of this.querySelectorAll("img")) {
        const b = img.getBoundingClientRect();
        const d =
          state.mode === "horizontal"
            ? Math.abs((b.left + b.right - r.left - r.right) / 2)
            : Math.abs((b.top + b.bottom - r.top - r.bottom) / 2);
        if (d < dist) {
          dist = d;
          best = img;
        }
      }
      if (best) {
        state.currentPage = Number(best.dataset.page);
        $("#page-input").val(state.currentPage);
        highlightThumbnail(state.currentPage);
        saveCurrentProgress();
      }
    }, 180);
  });

  let touchStart = null,
    pinch = null;
  viewportEl.addEventListener(
    "touchstart",
    (e) => {
      if (state.mode !== "flip") return;
      if (e.touches.length === 2) {
        pinch = {
          distance: Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          ),
          zoom: state.zoom,
        };
        touchStart = null;
      } else if (e.touches.length === 1) {
        touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    },
    { passive: true }
  );

  viewportEl.addEventListener(
    "touchmove",
    (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        state.zoom = Math.max(
          1,
          Math.min(
            4,
            (pinch.zoom *
              Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
              )) /
              Math.max(1, pinch.distance)
          )
        );
        applyTransform();
      }
    },
    { passive: false }
  );

  viewportEl.addEventListener("touchend", (e) => {
    if (pinch) {
      if (!e.touches.length) pinch = null;
      return;
    }
    if (
      touchStart &&
      state.zoom <= 1 &&
      e.changedTouches.length &&
      !e.target.closest(".flipbook")
    ) {
      const dx = e.changedTouches[0].clientX - touchStart.x,
        dy = e.changedTouches[0].clientY - touchStart.y;
      if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5) physical(dx < 0 ? 1 : -1);
    }
    touchStart = null;
  });

  $("#viewport").on("dblclick", (e) => {
    if (e.target.closest(".nav-zone")) return;
    if (state.zoom > 1) resetTransform();
    else {
      state.zoom = 2;
      applyTransform();
    }
  });

  // --- BOOTSTRAP ---
  openDB()
    .then(async () => {
      const books = await dbGetAllBooks();
      if (books && books.length) {
        books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        await loadBookFromLibrary(books[0].id);
        $("#library-drawer").addClass("hidden");
      } else {
        loadSampleDeck();
        $("#library-drawer").addClass("hidden");
      }
    })
    .catch(() => {
      loadSampleDeck();
      $("#library-drawer").addClass("hidden");
    });
});
