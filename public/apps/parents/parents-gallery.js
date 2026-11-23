// Gallery UI owns only transient image URLs. Auth/session and child state stay in the portal.
export function createGallery({
  api,
  context,
  esc,
  icon,
  formatDay,
  toast,
  refresh,
}) {
  const $ = (s) => document.querySelector(s);
  let staffView = false,
    albums = [],
    urls = new Set(),
    view = null,
    upload = null,
    thumbnailObserver = null,
    viewerRequest = 0;
  const photoLabel = (p) => p.caption || "School photo";
  const option = (id, text, selected) =>
    `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(text)}</option>`;
  const blobURL = (blob) => {
    const url = URL.createObjectURL(blob);
    urls.add(url);
    return url;
  };
  const release = (url) => {
    if (url) {
      URL.revokeObjectURL(url);
      urls.delete(url);
    }
  };
  const current = (c) =>
    context().epoch === c.epoch &&
    context().generation === c.generation &&
    context().student?.id === c.student?.id;
  document.body.insertAdjacentHTML(
    "beforeend",
    `
    <dialog id="photoViewer" class="photo-viewer" aria-labelledby="photoViewerTitle">
      <div class="photo-viewer-heading"><h2 id="photoViewerTitle"></h2><button type="button" class="quiet" data-gallery-close="viewer" aria-label="Close photo viewer">×</button></div>
      <div id="photoStage" class="photo-stage" aria-live="polite"></div>
      <div class="photo-viewer-controls"><button type="button" data-gallery-step="-1" aria-label="Previous photo">${icon("back")}</button><span id="photoPosition"></span><button type="button" data-gallery-step="1" aria-label="Next photo">${icon("next")}</button></div>
      <div class="photo-viewer-footer"><p id="photoCaption"></p><div><button type="button" id="savePhoto" data-gallery-download class="secondary">Save photo</button><button type="button" id="shareViewedPhoto" class="secondary" data-gallery-share-file hidden>Share photo</button><button type="button" id="removePhoto" data-gallery-remove class="danger">Remove photo</button></div></div>
    </dialog>
    <dialog id="albumEditor" class="album-editor" aria-labelledby="albumEditorTitle"><form id="albumForm">
      <div class="dialog-heading"><h2 id="albumEditorTitle">Share a school memory</h2><button type="button" class="quiet" data-gallery-close="upload" aria-label="Close album editor">×</button></div>
      <div class="album-form-body">
      <p class="support-note">Add up to 12 photos. Only the selected families can see the album after you publish it.</p>
      <fieldset id="albumDetails"><legend class="sr-only">Album details</legend>
      <label>Class<select name="class_id" required></select></label><label>Share with<select name="student_id"></select></label>
      <label>Album title<input name="title" maxlength="160" required placeholder="For example, Our colour explorers"></label>
      <label>Photo date<input name="taken_on" type="date" required></label><label>A little about the day<textarea name="description" maxlength="2000" placeholder="Tell families about these moments…"></textarea></label></fieldset>
      <label class="upload-drop">Choose photos<input id="albumFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple><span>JPEG, PNG, or WebP · up to 10 MiB each</span></label>
      <div id="uploadQueue" class="upload-queue" aria-live="polite"></div><p id="albumError" class="field-error" role="alert"></p>
      </div>
      <div class="dialog-actions"><button type="button" data-gallery-close="upload" class="secondary">Close</button><button id="discardAlbum" type="button" class="danger" data-gallery-discard hidden>Discard draft</button><button id="publishAlbum" type="submit" class="primary">Upload & publish</button></div>
    </form></dialog>`,
  );

  function closeViewer() {
    viewerRequest++;
    if (view?.url) release(view.url);
    view = null;
    $("#photoStage").replaceChildren();
    $("#photoViewer").close();
  }
  function closeUploader() {
    if (!upload) return;
    upload.cancelled = true;
    upload.files.forEach((f) => release(f.url));
    upload = null;
    $("#albumForm").reset();
    $("#uploadQueue").replaceChildren();
    $("#albumEditor").close();
  }
  function reset() {
    thumbnailObserver?.disconnect();
    thumbnailObserver = null;
    closeViewer();
    closeUploader();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    albums = [];
  }

  async function screen(student, page) {
    const c = context();
    const result = await api(student ? `/children/${student.id}/gallery?page=${page}` : `/gallery/staff?page=${page}`);
    if (!current(c)) return "";
    staffView = !student;
    albums = result.albums;
    const cards = albums.map((album) => {
      const ready = album.photos.filter((photo) => photo.status === "ready");
      const topic = c.preview ? album.symbol : "";
      return `<article class="album-card">
        <div class="album-card-heading"><div>
          <h2>${topic ? `<span aria-hidden="true">${esc(topic)}</span> ` : ""}${esc(album.title)}</h2>
          <p><time datetime="${esc(album.taken_on)}">${esc(formatDay(album.taken_on))}</time> · ${ready.length} ${ready.length === 1 ? "photo" : "photos"}${album.class_name ? ` · ${esc(album.class_name)}` : ""}</p>
        </div>${ready.length ? `<button type="button" class="album-open" data-gallery-view="${esc(album.id)}">View album <span aria-hidden="true">→</span></button>` : ""}</div>
        <div class="album-mosaic">
          ${ready.slice(0, 3).map((photo, index) => `<button type="button" data-gallery-photo="${esc(photo.id)}" data-gallery-album="${esc(album.id)}"
            aria-label="View ${esc(photoLabel(photo))} in ${esc(album.title)}"><img data-gallery-thumb="${esc(photo.id)}" alt="${esc(photoLabel(photo))}" width="480" height="360">
            <span class="photo-loading">Loading photo…</span>${index === 2 && ready.length > 3 ? `<span class="photo-more" aria-hidden="true">+${ready.length - 3}</span>` : ""}</button>`).join("")
            || '<div class="album-no-photos">Your draft is waiting for its first photo.</div>'}
        </div>
        ${album.description ? `<p class="album-description">${esc(album.description)}</p>` : ""}
        ${staffView && album.student_name ? `<p class="album-description">Shared with ${esc(album.student_name)}</p>` : ""}
        ${album.status === "draft" || album.can_manage || ready.length ? `<div class="album-actions">
          ${album.status === "draft" ? '<span class="badge album-draft">Draft · school team only</span>' : ""}
          ${album.can_manage ? `${album.status === "draft" ? `<button type="button" class="secondary" data-gallery-resume="${esc(album.id)}">Review draft</button>` : ""}
            <button type="button" class="quiet danger" data-gallery-withdraw="${esc(album.id)}">${album.status === "draft" ? "Discard" : "Withdraw"} album</button>`
            : ready.length ? `<button type="button" class="album-share" data-gallery-view="${esc(album.id)}"><span aria-hidden="true">📲</span> Save or share a photo</button>` : ""}
        </div>` : ""}
      </article>`;
    }).join("");
    return `<div class="toolbar"><span class="count">${result.total} ${result.total === 1 ? "album" : "albums"}${student ? ` shared with ${esc(student.full_name)}` : " you manage"}</span><span class="spacer"></span>${(!student || student.can_publish) && c.workspace.classes.length ? '<button type="button" class="primary" data-gallery-upload>Share photos</button>' : ""}<button type="button" class="secondary" data-refresh aria-label="Refresh gallery">Refresh</button></div>
      ${cards ? `<div class="album-grid">${cards}</div>` : `<div class="empty">${icon("gallery")}<h2>Little moments are on their way.</h2><p>When the school team shares photos, you’ll find them here.</p></div>`}
      ${result.total > result.page_size ? `<div class="pagination"><button data-page="${page - 1}" ${page === 1 ? "disabled" : ""} aria-label="Previous page">${icon("back")}</button><span>Page ${page} of ${Math.ceil(result.total / result.page_size)}</span><button data-page="${page + 1}" ${page * result.page_size >= result.total ? "disabled" : ""} aria-label="Next page">${icon("next")}</button></div>` : ""}`;
  }
  async function image(photo, thumbnail = false) {
    const student = staffView ? null : context().student;
    return api(
      `/photos/${photo.id}/image?thumbnail=${thumbnail}${student ? `&student_id=${student.id}` : ""}`,
      undefined,
      "GET",
      true,
      "blob",
    );
  }
  function mount() {
    const c = context();
    const images = document.querySelectorAll("[data-gallery-thumb]");
    const waiting = [];
    let active = 0;
    async function loadThumbnail(el) {
      try {
        const blob = await image({ id: el.dataset.galleryThumb }, true);
        if (!current(c) || !el.isConnected) return;
        el.onload = () => el.parentElement?.classList.add("loaded");
        el.src = blobURL(blob);
      } catch {
        if (current(c) && el.isConnected) {
          el.parentElement.classList.add("photo-failed");
          el.parentElement.querySelector(".photo-loading").textContent =
            "Photo unavailable · tap to retry";
        }
      } finally {
        active--;
        loadReadyThumbnails();
      }
    }
    function loadReadyThumbnails() {
      while (active < 3 && waiting.length && current(c)) {
        active++;
        void loadThumbnail(waiting.shift());
      }
    }
    if (!("IntersectionObserver" in window)) {
      waiting.push(...images);
      loadReadyThumbnails();
      return;
    }
    thumbnailObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        waiting.push(entry.target.querySelector("[data-gallery-thumb]"));
      }
      loadReadyThumbnails();
    }, { rootMargin: "200px 0px" });
    for (const el of images) thumbnailObserver.observe(el.parentElement);
  }
  async function showPhoto(index) {
    if (!view) return;
    const c = context(),
      request = ++viewerRequest,
      album = view.album;
    view.index = (index + view.photos.length) % view.photos.length;
    const photo = view.photos[view.index];
    release(view.url);
    view.url = null;
    view.file = null;
    $("#shareViewedPhoto").hidden = true;
    $("#photoViewerTitle").textContent = album.title;
    $("#photoCaption").textContent = photo.caption || album.description;
    $("#photoPosition").textContent =
      `${view.index + 1} of ${view.photos.length}`;
    $("#removePhoto").hidden = !album.can_manage;
    $("#savePhoto").disabled = true;
    document
      .querySelectorAll("[data-gallery-step]")
      .forEach((b) => (b.disabled = view.photos.length < 2));
    $("#photoStage").innerHTML =
      '<p role="status">Loading this little moment…</p>';
    if (!$("#photoViewer").open) $("#photoViewer").showModal();
    try {
      const blob = await image(photo);
      if (!current(c) || !view || request !== viewerRequest) return;
      view.url = blobURL(blob);
      view.extension = {
        "image/png": "png",
        "image/webp": "webp",
        "image/svg+xml": "svg",
      }[blob.type] || "jpg";
      $("#photoStage").innerHTML = `<img alt="${esc(photoLabel(photo))}">`;
      $("#photoStage img").src = view.url;
      $("#savePhoto").disabled = false;
      const file = new File([blob], `octominds-${photo.id}.${view.extension}`, { type: blob.type });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        view.file = file;
        $("#shareViewedPhoto").hidden = false;
      }
    } catch (error) {
      if (view && request === viewerRequest && current(c))
        $("#photoStage").innerHTML =
          `<div class="photo-view-error" role="alert"><p>${esc(error.message)}</p><button type="button" data-gallery-retry>Try again</button></div>`;
    }
  }
  function queue() {
    if (!upload) return;
    $("#uploadQueue").innerHTML = upload.files
      .map(
        (f) =>
          `<div class="upload-item"><div class="upload-mini">${f.url ? `<img src="${esc(f.url)}" alt="">` : icon("gallery")}</div><div><strong>${esc(f.name)}</strong><label class="photo-caption-label">Photo caption<input data-photo-caption="${f.id}" value="${esc(f.caption)}" maxlength="200" ${f.attempted || f.status === "ready" || f.status === "uploading" ? "disabled" : ""}></label><span class="upload-state ${f.status === "failed" ? "failed" : ""}">${esc(f.message || { queued: "Ready to upload", uploading: "Uploading…", ready: "Uploaded · not published yet", failed: "Upload interrupted" }[f.status])}</span></div><button type="button" class="quiet danger" data-gallery-skip="${f.id}" ${upload.busy ? "disabled" : ""} aria-label="Remove ${esc(f.name)} from this album">Remove</button></div>`,
      )
      .join("");
    $("#publishAlbum").textContent = upload.files.some(
      (f) => f.status === "failed",
    )
      ? "Retry & publish"
      : upload.files.length && upload.files.every((f) => f.status === "ready")
        ? "Publish album"
        : "Upload & publish";
    $("#albumFiles").disabled = upload.busy;
    $("#publishAlbum").disabled = upload.busy;
    $("#discardAlbum").hidden = !upload.album;
    $("#albumDetails").disabled = Boolean(upload.album) || upload.busy;
  }
  function audience() {
    const form = $("#albumForm"),
      classId = form.elements.class_id.value;
    form.elements.student_id.innerHTML =
      option("", "Everyone in this class", "") +
      context()
        .workspace.students.filter((s) => s.class_id === classId && s.is_active)
        .map((s) => option(s.id, s.full_name, ""))
        .join("");
  }
  async function openUploader(albumId) {
    const c = context();
    if (!c.workspace.classes.length) {
      toast("Create a class and assign its school team before sharing photos.");
      return;
    }
    upload = {
      files: [],
      album: null,
      busy: false,
      cancelled: false,
      epoch: c.epoch,
    };
    $("#albumForm").reset();
    $("#albumError").textContent = "";
    $("#albumDetails").disabled = false;
    const form = $("#albumForm");
    form.elements.class_id.innerHTML = c.workspace.classes
      .map((cls) =>
        option(cls.id, `${cls.name} · ${cls.center_name}`, c.student?.class_id),
      )
      .join("");
    audience();
    const today = new Date();
    form.elements.taken_on.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (albumId) {
      try {
        const album = await api(`/albums/${albumId}`);
        if (!current(c)) return;
        if (!album.can_manage || album.status !== "draft")
          throw Error("Only draft albums can receive uploads.");
        upload.album = album;
        form.elements.class_id.value = album.class_id;
        audience();
        form.elements.student_id.value = album.student_id || "";
        form.elements.title.value = album.title;
        form.elements.description.value = album.description;
        form.elements.taken_on.value = album.taken_on;
        upload.files = album.photos.map((p) => ({
          id: p.id,
          file: null,
          url: null,
          name: p.caption || "Existing photo",
          caption: p.caption,
          status: p.status === "ready" ? "ready" : "failed",
          message:
            p.status === "pending"
              ? "Upload interrupted. Remove this entry and choose the file again."
              : "",
        }));
      } catch (error) {
        closeUploader();
        toast(error.message);
        return;
      }
    }
    queue();
    $("#albumEditor").showModal();
  }
  $("#albumFiles").addEventListener("change", (event) => {
    if (!upload) return;
    $("#albumError").textContent = "";
    for (const file of event.target.files) {
      if (upload.files.length >= 12) {
        $("#albumError").textContent = "An album can contain up to 12 photos.";
        break;
      }
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size > 10 * 1024 * 1024 ||
        !file.size
      ) {
        $("#albumError").textContent =
          `${file.name}: choose a JPEG, PNG, or WebP photo up to 10 MiB.`;
        continue;
      }
      upload.files.push({
        id: crypto.randomUUID(),
        file,
        url: blobURL(file),
        name: file.name,
        caption: "",
        status: "queued",
      });
    }
    event.target.value = "";
    queue();
  });
  $("#albumForm").addEventListener("change", (event) => {
    if (event.target.name === "class_id") audience();
  });
  $("#albumForm").addEventListener("input", (event) => {
    if (event.target.dataset.photoCaption && upload) {
      const f = upload.files.find(
        (f) => f.id === event.target.dataset.photoCaption,
      );
      if (f) f.caption = event.target.value;
    }
  });
  $("#albumForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const task = upload;
    if (!task || task.busy) return;
    $("#albumError").textContent = "";
    if (!task.files.length) {
      $("#albumError").textContent = "Choose at least one photo.";
      return;
    }
    task.busy = true;
    queue();
    try {
      if (!task.album) {
        const form = $("#albumForm");
        task.album = await api("/albums", {
          class_id: form.elements.class_id.value,
          student_id: form.elements.student_id.value || null,
          title: form.elements.title.value,
          description: form.elements.description.value,
          taken_on: form.elements.taken_on.value,
        });
      }
      for (const file of task.files) {
        if (task.cancelled || context().epoch !== task.epoch) return;
        if (file.status === "ready") continue;
        if (!file.file) {
          file.status = "failed";
          continue;
        }
        file.attempted = true;
        file.status = "uploading";
        file.message = "";
        queue();
        try {
          await api(
            `/albums/${task.album.id}/photos/${file.id}`,
            file.file,
            "POST",
            true,
            "json",
            { "X-Photo-Caption": encodeURIComponent(file.caption) },
          );
          file.status = "ready";
          file.message = "";
        } catch (error) {
          file.status = "failed";
          file.message = error.message;
        }
        if (!task.cancelled) queue();
      }
      if (task.cancelled || context().epoch !== task.epoch) return;
      if (task.files.some((f) => f.status !== "ready")) {
        throw Error(
          "Some photos need attention. Retry the failed uploads, or remove them before publishing. Your successful uploads are saved in this private draft.",
        );
      }
      await api(`/albums/${task.album.id}/publish`, {});
      if (task.cancelled || context().epoch !== task.epoch) return;
      closeUploader();
      await refresh();
      toast("Your photo album is shared with families.");
    } catch (error) {
      if (!task.cancelled && context().epoch === task.epoch)
        $("#albumError").textContent = error.message;
    } finally {
      task.busy = false;
      if (upload === task) queue();
    }
  });
  async function withdraw(albumId) {
    if (
      !confirm("Withdraw this album? Families will no longer see its photos.")
    )
      return;
    const c = context();
    try {
      await api(`/albums/${albumId}`, null, "DELETE");
      if (!current(c)) return;
      closeUploader();
      await refresh();
      toast("Album withdrawn.");
    } catch (error) {
      toast(error.message);
    }
  }
  document.addEventListener("click", async (event) => {
    const el = event.target.closest("button");
    if (!el) return;
    if (el.matches("[data-gallery-upload]")) return openUploader();
    if (el.matches("[data-gallery-resume]"))
      return openUploader(el.dataset.galleryResume);
    if (el.matches("[data-gallery-photo], [data-gallery-view]")) {
      const album = albums.find((a) => a.id === (el.dataset.galleryAlbum || el.dataset.galleryView));
      if (!album) return;
      view = {
        album,
        photos: album.photos.filter((p) => p.status === "ready"),
        index: 0,
        url: null,
      };
      if (!view.photos.length) return;
      return showPhoto(el.dataset.galleryPhoto ? view.photos.findIndex((p) => p.id === el.dataset.galleryPhoto) : 0);
    }
    if (el.matches("[data-gallery-step]") && view)
      return showPhoto(view.index + Number(el.dataset.galleryStep));
    if (el.matches("[data-gallery-retry]") && view)
      return showPhoto(view.index);
    if (el.matches("[data-gallery-close]")) {
      if (el.dataset.galleryClose === "viewer") closeViewer();
      else if (upload && !upload.busy) {
        const hasDraft = Boolean(upload.album);
        closeUploader();
        if (hasDraft) {
          await refresh();
          toast("Draft saved. Open Review draft to continue.");
        }
      }
      return;
    }
    if (el.matches("[data-gallery-download]") && view?.url) {
      const a = document.createElement("a");
      a.href = view.url;
      a.download = `octominds-${view.photos[view.index].id}.${view.extension}`;
      document.body.append(a);
      a.click();
      a.remove();
      return;
    }
    if (el.matches("[data-gallery-share-file]") && view?.file) {
      try { await navigator.share({ files: [view.file] }); }
      catch (error) { if (error.name !== "AbortError") toast("Sharing is unavailable. You can still save this photo."); }
      return;
    }
    if (el.matches("[data-gallery-withdraw]"))
      return withdraw(el.dataset.galleryWithdraw);
    if (el.matches("[data-gallery-discard]") && upload && !upload.busy)
      return withdraw(upload.album.id);
    if (el.matches("[data-gallery-remove]") && view) {
      if (!confirm("Remove this photo from the album?")) return;
      const c = context(),
        album = view.album,
        photo = view.photos[view.index];
      el.disabled = true;
      try {
        await api(
          `/albums/${album.id}/photos/${photo.id}`,
          null,
          "DELETE",
        );
        if (!current(c)) return;
        closeViewer();
        await refresh();
        toast("Photo removed.");
      } catch (error) {
        toast(error.message);
      } finally {
        el.disabled = false;
      }
    }
    if (el.matches("[data-gallery-skip]") && upload && !upload.busy) {
      const task = upload,
        file = task.files.find((f) => f.id === el.dataset.gallerySkip);
      el.disabled = true;
      try {
        if (task.album) {
          await api(
            `/albums/${task.album.id}/photos/${file.id}`,
            null,
            "DELETE",
          );
        }
        if (task !== upload) return;
        release(file.url);
        task.files = task.files.filter((f) => f !== file);
        queue();
      } catch (error) {
        if (task === upload) $("#albumError").textContent = error.message;
      } finally {
        el.disabled = false;
      }
    }
  });
  $("#photoViewer").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeViewer();
  });
  $("#photoViewer").addEventListener("keydown", (event) => {
    if (view && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      showPhoto(view.index + (event.key === "ArrowLeft" ? -1 : 1));
    }
  });
  $("#albumEditor").addEventListener("cancel", async (event) => {
    event.preventDefault();
    if (upload?.busy) return;
    const hasDraft = Boolean(upload?.album);
    closeUploader();
    if (hasDraft) await refresh();
  });
  return { screen, mount, reset };
}
