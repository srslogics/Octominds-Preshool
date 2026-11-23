import { createGallery } from "./parents-gallery.js?v=4";
const $ = (s) => document.querySelector(s);
const cfg = window.OCTOMINDS_CONFIG || {};
const sessions = window.OctomindsSession;
const previewRequested = new URLSearchParams(location.search).get("preview") === "1";
let preview = null;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  gallery: "M3 4h18v16H3z M3 16l6-6 5 5 3-3 4 4 M16 8h1",
  home: "M3 10l9-7 9 7v10H3z M9 20v-7h6v7",
  updates: "M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5",
  homework: "M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4z M12 6v15",
  diary: "M5 3h14v18H5z M3 7h4 M3 12h4 M3 17h4 M10 8h5 M10 12h5",
  calendar: "M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16 M8 14h2 M14 14h2",
  messages: "M3 4h18v13H9l-5 4v-4H3z M7 9h10 M7 13h6",
  child: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21v-2a8 6 0 0 1 16 0v2",
  manage: "M4 21V7l8-4 8 4v14 M8 21v-6h8v6 M8 9h1 M15 9h1",
  plus: "M12 4v16 M4 12h16",
  check: "M5 12l4 4L19 6",
  back: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.updates}"/></svg>`;
const labels = {
  notice: "School notice",
  homework: "Home learning",
  diary: "Daily diary",
  event: "School event",
};
const pages = {
  today: [
    "Today at school",
    "Catch up on class updates and what’s coming up next.",
  ],
  updates: [
    "School updates",
    "Notices, activities, and events from your school team.",
  ],
  homework: [
    "Home learning",
    "Activities from the classroom to try together at home.",
  ],
  diary: [
    "Daily diary",
    "Notes about your child’s school day.",
  ],
  calendar: [
    "Calendar",
    "Class events and school holidays.",
  ],
  messages: [
    "Ask the school",
    "Send a message to your child’s school team.",
  ],
  child: [
    "My child",
    "Class details and family access.",
  ],
  gallery: [
    "Photo gallery",
    "Albums shared with your family by the school team.",
  ],
  "school-albums": [
    "School albums",
    "Review drafts, publish photos, and manage shared albums.",
  ],
  manage: [
    "School desk",
    "Manage family connections and share updates or photos.",
  ],
};
let session = null,
  user = null,
  workspace = null,
  selected = "",
  generation = 0,
  epoch = 0,
  page = 1,
  month = firstDay(),
  chosenDay = isoDate(new Date()),
  editing = null,
  refreshing = null,
  toastTimer;
const route = () => {
  const r = location.hash.replace(/^#\/?/, "") || "today";
  return Object.hasOwn(pages, r) ? r : "today";
};
const child = () => workspace?.students.find((s) => s.id === selected);
const initials = (name) =>
  String(name || "")
    .split(/\s+/)
    .filter((s) => /^[\p{L}\p{N}]/u.test(s))
    .slice(0, 2)
    .map((s) => s[0] || "")
    .join("");
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function firstDay() {
  const d = new Date();
  d.setDate(1);
  return isoDate(d);
}
const parseDay = (s) => new Date(`${s}T12:00:00`);
const formatDay = (value, options = { day: "numeric", month: "short" }) =>
  value ? parseDay(value).toLocaleDateString(undefined, options) : "";
const stamp = (value) =>
  new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
const go = (r) => `${location.pathname}${location.search}#/${r}`;
const empty = (name, title, text, action = "") =>
  `<div class="empty">${icon(name)}<h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
const loading = () =>
  '<div class="loading" role="status">Bringing you up to date…</div>';
function toast(text) {
  clearTimeout(toastTimer);
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 6000);
}
function setPasswordVisibility(visible) {
  const input = $("#password");
  const toggle = $("#togglePassword");
  input.type = visible ? "text" : "password";
  toggle.firstChild.textContent = visible ? "Hide" : "Show";
}
function clearSession() {
  gallery.reset();
  epoch++;
  generation++;
  sessions.clear(session);
  session = null;
  refreshing = null;
  user = null;
  workspace = null;
  selected = "";
  $("#portal").hidden = true;
  $("#auth").hidden = false;
  $("#content").replaceChildren();
  $("#childSelect").replaceChildren();
  $("#accountName").textContent = "";
  $("#loginForm").reset();
  setPasswordVisibility(false);
  $("#editor").close();
}
async function auth(path, body, token) {
  const response = await fetch(`${cfg.apiBaseUrl || location.origin}/api/v1/auth${path}`, {
    method: "POST",
    keepalive: path.startsWith("/logout"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = Error(
      response.status >= 500
        ? "School sign-in is temporarily unavailable. Please try again."
        : (typeof result.detail === "string" && result.detail) ||
            result.msg ||
            result.error_description ||
            result.message ||
            "Unable to sign in.",
    );
    error.status = response.status;
    throw error;
  }
  return result;
}
const revokeSession = (token, scope) => auth(`/logout?scope=${scope}`, null, token);

async function refresh() {
  if (refreshing) return refreshing;
  const old = session,
    version = epoch;
  const task = (async () => {
    try {
      const next = await sessions.refresh(
        old,
        () => version === epoch && session === old,
        (refresh_token) => auth("/token?grant_type=refresh_token", { refresh_token }),
        revokeSession,
      );
      if (version === epoch && session === old) session = next;
    } catch (error) {
      if (version === epoch && [400, 401, 403].includes(error.status)) {
        clearSession();
        $("#authMessage").textContent =
          "Your session expired. Please sign in again.";
      }
      throw error;
    }
  })();
  refreshing = task;
  try {
    await task;
  } finally {
    if (refreshing === task) refreshing = null;
  }
}
async function api(
  path,
  body,
  method = body ? "POST" : "GET",
  retry = true,
  responseType = "json",
  extraHeaders = {},
) {
  if (preview) return preview.request(path, body, method, extraHeaders);
  if (!session?.access_token) throw Error("Please sign in again.");
  const version = epoch;
  if (
    retry &&
    session.expires_at &&
    session.expires_at * 1000 < Date.now() + 30000
  )
    await refresh();
  if (version !== epoch) throw Error("Your session changed.");
  const token = session.access_token;
  const response = await fetch(`/api/v1/parents${path}`, {
    method,
    cache: "no-store",
    headers: {
      ...extraHeaders,
      Authorization: `Bearer ${token}`,
      "Content-Type":
        body instanceof Blob
          ? body.type || "application/octet-stream"
          : "application/json",
    },
    ...(body
      ? { body: body instanceof Blob ? body : JSON.stringify(body) }
      : {}),
  });
  if (version !== epoch) throw Error("Your session changed.");
  if (response.status === 401 && retry) {
    if (session.access_token === token) await refresh();
    if (version !== epoch) throw Error("Your session changed.");
    return api(path, body, method, false, responseType, extraHeaders);
  }
  if (response.ok && responseType === "blob") return response.blob();
  const result = await response.json().catch(() => ({}));
  if (version !== epoch) throw Error("Your session changed.");
  if (!response.ok) {
    if (response.status === 401 && session.access_token === token) {
      clearSession();
      $("#authMessage").textContent = "Your session expired. Please sign in again.";
    }
    throw Error(
      typeof result.detail === "string"
        ? result.detail
        : "We couldn’t complete that request. Please try again.",
    );
  }
  return result;
}
async function enter() {
  const version = epoch;
  let fresh;
  if (!preview) {
    const params = new URLSearchParams({ include_account: "true" });
    if (route() === "today") params.set("today_month", firstDay());
    fresh = await api(`/workspace?${params}`);
  }
  if (version !== epoch) return;
  user = preview ? preview.user() : fresh.account;
  $("#auth").hidden = true;
  $("#portal").hidden = false;
  $("#previewBanner").hidden = !preview;
  $("#accountName").textContent = user.full_name || "Your account";
  await loadWorkspace(fresh);
}
function navigation() {
  const items = [
    ["today", "home", "Today"],
    ["updates", "updates", "School updates", "Updates"],
    ["homework", "homework", "Home learning", "Learning"],
    ["diary", "diary", "Daily diary", "Diary"],
    ["calendar", "calendar", "Calendar"],
    ["gallery", "gallery", "Photo gallery", "Photos"],
    ["messages", "messages", "Ask the school", "Messages"],
    ["child", "child", "My child"],
  ];
  if (workspace.classes.length || workspace.students.some((s) => s.can_manage))
    items.push(["manage", "manage", "School desk"]);
  const current = route() === "school-albums" ? "manage" : route();
  $("#navigation").innerHTML = items
    .map(
      ([r, i, name, shortName]) =>
        `<a href="${go(r)}" aria-label="${name}" ${current === r ? 'aria-current="page"' : ""}>
          ${icon(i)}<span class="nav-label">${name}</span>${shortName ? `<span class="nav-label-short">${shortName}</span>` : ""}
        </a>`,
    )
    .join("");
}
async function loadWorkspace(initialData) {
  const version = ++generation;
  $("#content").innerHTML = loading();
  try {
    const fresh = initialData ?? await api("/workspace");
    if (version !== generation || !user) return;
    workspace = fresh;
    if (!workspace.students.some((s) => s.id === selected))
      selected =
        workspace.students.find((s) => s.is_active)?.id ||
        workspace.students[0]?.id ||
        "";
    $("#childSelect").innerHTML = workspace.students
      .map(
        (s) =>
          `<option value="${esc(s.id)}">${esc(s.full_name)}${s.is_active ? "" : " (inactive)"}</option>`,
      )
      .join("");
    $("#childSelect").value = selected;
    await render(initialData?.today);
  } catch (error) {
    if (version === generation && user) showError(error);
  }
}
function showError(error) {
  $("#content").innerHTML =
    `<div class="error" role="alert"><h2>We couldn’t load this just now.</h2><p>${esc(error.message)}</p><button type="button" data-retry>Try again</button></div>`;
}
function postCard(p) {
  return `<article class="post-card"><div class="post-head"><span class="badge ${esc(p.kind)}">${icon(p.kind === "notice" ? "updates" : p.kind === "event" ? "calendar" : p.kind)}${esc(labels[p.kind] || p.kind)}</span><time class="post-meta" datetime="${esc(p.created_at)}">${esc(stamp(p.created_at))}</time></div><h2>${esc(p.title)}</h2>${p.event_date ? `<p class="support-note">${esc(formatDay(p.event_date, { weekday: "long", day: "numeric", month: "long" }))}</p>` : ""}<p class="post-body">${esc(p.body)}</p><div class="post-footer"><span class="author"><span class="avatar" aria-hidden="true">${esc(initials(p.author_name))}</span>${esc(p.author_name)}</span>${p.can_withdraw ? `<button type="button" class="quiet danger" data-withdraw="${esc(p.id)}">Withdraw</button>` : "<span>Shared with your family</span>"}</div></article>`;
}
function pagination(result) {
  return result.total > result.page_size
    ? `<div class="pagination"><button data-page="${page - 1}" ${page === 1 ? "disabled" : ""} aria-label="Previous page">${icon("back")}</button><span>Page ${page} of ${Math.ceil(result.total / result.page_size)}</span><button data-page="${page + 1}" ${page * result.page_size >= result.total ? "disabled" : ""} aria-label="Next page">${icon("next")}</button></div>`
    : "";
}
function eventRows(events) {
  return events
    .map(
      (e) =>
        `<div class="event-row"><div class="date-tile"><small>${esc(formatDay(e.event_date || e.starts_on, { month: "short" }))}</small><strong>${esc(formatDay(e.event_date || e.starts_on, { day: "numeric" }))}</strong></div><div><h3>${esc(e.title || e.name)}</h3><p>${esc(e.body || "School holiday")}${e.ends_on && e.ends_on !== e.starts_on ? ` · through ${esc(formatDay(e.ends_on))}` : ""}</p></div></div>`,
    )
    .join("");
}
const gallery = createGallery({
  api,
  context: () => ({ student: child(), workspace, epoch, generation }),
  esc,
  icon,
  formatDay,
  toast,
  refresh: loadWorkspace,
});
async function render(initialToday) {
  gallery.reset();
  if (!workspace || !user) return;
  const r = route(),
    version = ++generation,
    s = child();
  navigation();
  $("#childPicker").hidden =
    ["manage", "school-albums"].includes(r) || !workspace.students.length;
  $("#pageTitle").textContent = pages[r][0];
  $("#pageDescription").textContent = pages[r][1];
  $("#content").innerHTML = loading();
  try {
    let html = "";
    if (r === "manage") {
      html = manageScreen();
    } else if (r === "school-albums") {
      html =
        workspace.classes.length ||
        workspace.students.some((student) => student.can_manage)
          ? await gallery.screen(null, page)
          : empty(
              "gallery",
              "School albums are managed by staff.",
              "Open the photo gallery to view albums shared with your family.",
              `<a class="button secondary" href="${go("gallery")}">Open photo gallery</a>`,
            );
    } else if (!s) {
      html = empty(
        "child",
        "Your family connection starts here.",
        "Your school will link your account to your child. If you’ve already accepted an invitation, ask your administrator to complete the child link.",
        `<button data-refresh type="button" class="secondary">Check again</button>`,
      );
    } else if (r === "child") {
      html = profileScreen(s);
    } else if (r === "gallery") {
      html = await gallery.screen(s, page);
    } else if (r === "messages") {
      html = await messageScreen(s);
    } else if (r === "calendar") {
      html = await calendarScreen(s);
    } else if (r === "today") {
      const todayMonth = firstDay();
      const [feed, calendar] = initialToday?.student_id === s.id && initialToday.month === todayMonth
        ? [initialToday, initialToday.calendar]
        : await Promise.all([
            api(`/children/${s.id}/posts`),
            api(`/children/${s.id}/calendar?month=${todayMonth}`),
          ]);
      const upcoming = [
        ...calendar.events,
        ...calendar.holidays.map((h) => ({ ...h, event_date: h.starts_on })),
      ]
        .filter((e) => e.event_date >= isoDate(new Date()))
        .sort((a, b) => a.event_date.localeCompare(b.event_date))
        .slice(0, 3);
      html = `
        <section class="welcome-card">
          <div class="welcome-copy">
            <span class="child-badge">${esc(s.class_name)} · ${esc(s.center_name)}</span>
            <h2>See ${esc(s.full_name.split(" ")[0])}’s day</h2>
            <a class="button primary" href="${go("diary")}">Open daily diary</a>
          </div>
          <div class="welcome-art" aria-hidden="true">
            <span class="welcome-sparkle welcome-sparkle-left">✦</span>
            <div class="welcome-mascot"><img src="/assets/octominds-logo-horizontal.png" alt="" width="1437" height="540" /></div>
            <span class="welcome-sparkle welcome-sparkle-right">✧</span>
          </div>
        </section>
        <div class="dashboard-grid">
          <section>
            <div class="panel-title"><h2>The latest little moments</h2><a href="${go("updates")}">View updates</a></div>
            ${feed.posts.slice(0, 3).map(postCard).join("") || empty("updates", "No updates yet", "Updates will appear here when the school shares them.")}
          </section>
          <div>
            <section class="panel upcoming-panel">
              <div class="panel-title"><h2>Coming up this month</h2><a href="${go("calendar")}">Calendar</a></div>
              ${upcoming.length ? eventRows(upcoming) : '<p class="support-note">No upcoming events this month.</p>'}
            </section>
            <section class="panel">
              <div class="panel-title"><h2>Quick links</h2></div>
              <div class="quick-links">
                <a href="${go("homework")}">${icon("homework")}Home learning</a>
                <a href="${go("messages")}">${icon("messages")}Ask the school</a>
                <a href="${go("child")}">${icon("child")}Your child’s details</a>
              </div>
            </section>
          </div>
        </div>`;
    } else {
      const kind = r === "updates" ? "all" : r;
      const feed = await api(
        `/children/${s.id}/posts?kind=${kind}&page=${page}`,
      );
      html = `<div class="toolbar"><span class="count">${feed.total} ${feed.total === 1 ? "update" : "updates"} for ${esc(s.full_name)}</span><span class="spacer"></span>${s.can_publish ? '<button class="primary" data-edit="post">Share an update</button>' : ""}<button data-refresh class="secondary" aria-label="Refresh updates">Refresh</button></div>${feed.posts.map(postCard).join("") || empty(r, "Nothing shared here yet.", r === "homework" ? "When your teacher shares an activity, you’ll find it here." : "Updates from your school team will appear here. There’s nothing you need to do.")}${pagination(feed)}`;
    }
    if (version !== generation || !user) return;
    $("#content").innerHTML = html;
    if (r === "gallery" || r === "school-albums") gallery.mount();
  } catch (error) {
    if (version === generation && user) showError(error);
  }
}
function profileScreen(s) {
  return `<div class="profile-hero"><span class="avatar" aria-hidden="true">${esc(initials(s.full_name))}</span><div><h2>${esc(s.full_name)}</h2><p>${esc(s.class_name)} · ${esc(s.year_name)}</p></div></div><div class="profile-grid"><section class="panel"><h2>Enrollment</h2><dl class="facts">${[
    ["School center", s.center_name],
    ["Class", s.class_name],
    ["Academic year", s.year_name],
    ["Status", s.is_active ? "Active" : "Inactive"],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`)
    .join(
      "",
    )}</dl></section><section class="panel"><h2>Family access</h2><dl class="facts"><div><dt>Your account</dt><dd>${esc(user.full_name)}</dd></div>${s.relationship ? `<div><dt>Relationship</dt><dd>${esc(s.relationship)}</dd></div>` : ""}</dl><p class="support-note">Contact the school to update your child’s details or family access.</p><a class="button secondary" href="${go("messages")}">Contact the school</a></section></div>`;
}
async function messageScreen(s) {
  const result = await api(`/children/${s.id}/messages?page=${page}`);
  return `<p class="thread-note">A shared conversation about ${esc(s.full_name)}. Linked guardians and the assigned school team can read and reply. For anything urgent, contact your school directly.</p>${pagination(result)}<div class="thread">${result.messages.map((m) => `<article class="message ${m.is_own ? "own" : ""}"><strong>${esc(m.is_own ? "You" : m.author_name)}</strong><p>${esc(m.body)}</p><small>${esc(stamp(m.created_at))}</small></article>`).join("") || empty("messages", "Start a conversation.", "Ask about their day, share a little update, or let the school know what’s on your mind.")}</div>${s.is_active ? `<form id="messageForm" class="message-form"><label for="messageBody">Your message<textarea id="messageBody" name="body" maxlength="2000" required placeholder="Write to your school team…"></textarea></label><p class="field-error" id="messageError" role="alert"></p><button class="primary" type="submit">Send message</button></form>` : ""}`;
}
async function calendarScreen(s) {
  const result = await api(`/children/${s.id}/calendar?month=${month}`);
  const start = parseDay(month),
    year = start.getFullYear(),
    m = start.getMonth(),
    days = new Date(year, m + 1, 0).getDate();
  const onDay = (date) => [
    ...result.events.filter((e) => e.event_date === date),
    ...result.holidays.filter((h) => h.starts_on <= date && h.ends_on >= date),
  ];
  if (!chosenDay.startsWith(month.slice(0, 7))) chosenDay = month;
  return `<div class="calendar-layout"><section class="panel"><div class="calendar-top"><button data-month="-1" aria-label="Previous month">${icon("back")}</button><h2>${esc(start.toLocaleDateString(undefined, { month: "long", year: "numeric" }))}</h2><button data-month="1" aria-label="Next month">${icon("next")}</button></div><div class="calendar-grid">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<span class="weekday">${d}</span>`).join("")}${Array.from({ length: start.getDay() }, () => "<span></span>").join("")}${Array.from(
    { length: days },
    (_, i) => {
      const date = isoDate(new Date(year, m, i + 1)),
        events = onDay(date).length;
      return `<button class="calendar-day ${chosenDay === date ? "selected" : ""} ${isoDate(new Date()) === date ? "today" : ""}" data-day="${date}" aria-label="${esc(formatDay(date, { day: "numeric", month: "long" }))}${events ? `, ${events} events` : ""}" aria-pressed="${chosenDay === date}">${i + 1}${events ? '<i aria-hidden="true"></i>' : ""}</button>`;
    },
  ).join(
    "",
  )}</div></section><section class="panel"><div class="panel-title"><h2>${esc(formatDay(chosenDay, { day: "numeric", month: "long" }))}</h2></div>${onDay(chosenDay).length ? eventRows(onDay(chosenDay)) : '<p class="support-note">No events scheduled for this day.</p>'}</section></div>`;
}
function manageScreen() {
  const mayManage =
    workspace.classes.some((c) => c.can_manage) ||
    workspace.students.some((s) => s.can_manage);
  if (!mayManage && !workspace.classes.length)
    return empty(
      "manage",
      "This space is for the school team.",
      "Your family updates are available from Today.",
    );
  return `<div class="staff-actions">
    ${workspace.classes.length ? `<button type="button" class="staff-action" data-gallery-upload>
      ${icon("gallery")}<span><strong>Share photos</strong><small>Create a private album for families.</small></span>
    </button>` : ""}
    <a class="staff-action" href="${go("school-albums")}" aria-labelledby="manageAlbumsLabel" aria-describedby="manageAlbumsHint">
      ${icon("gallery")}<span><strong id="manageAlbumsLabel">Manage albums</strong><small id="manageAlbumsHint">Review drafts and published albums.</small></span>
    </a>
    ${mayManage ? `<button type="button" class="staff-action" data-edit="student">
      ${icon("child")}<span><strong>Register a child</strong><small>Place a child in a school class.</small></span>
    </button><button type="button" class="staff-action" data-edit="guardian">
      ${icon("plus")}<span><strong>Connect a family</strong><small>Link a parent account to their child.</small></span>
    </button>` : ""}
    ${workspace.classes.length ? `<button type="button" class="staff-action" data-edit="post">
      ${icon("updates")}<span><strong>Share an update</strong><small>Publish a notice, activity, diary note, or event.</small></span>
    </button>` : ""}
    </div><section class="panel"><div class="panel-title"><h2>Children & family connections</h2><button data-refresh class="quiet">Refresh</button></div><div class="student-list">${
    workspace.students
      .map((s) => {
        const linked = workspace.guardians.filter(
          (g) => g.student_id === s.id && g.is_active,
        ).length;
        return `<div class="student-row"><span class="avatar" aria-hidden="true">${esc(initials(s.full_name))}</span><div class="student-info"><h3>${esc(s.full_name)}${s.is_active ? "" : " · inactive"}</h3><p>${esc(s.class_name)} · ${esc(s.center_name)}${s.can_manage ? ` · ${linked} family ${linked === 1 ? "connection" : "connections"}` : ""}</p></div><a class="button secondary" href="${go("messages")}" data-follow="${esc(s.id)}">Conversation</a>${s.can_manage ? `<button data-edit="guardian" data-id="${esc(s.id)}" class="secondary">Family access</button><button data-edit="student" data-id="${esc(s.id)}" class="quiet">Edit</button>` : ""}</div>`;
      })
      .join("") ||
    '<p class="support-note">Register your first child to connect their family. Create active classes and invite parent accounts in School administration first.</p>'
  }</div></section><p class="support-note">Parents must accept their school invitation before they can be linked. Only administrators can grant or revoke family access. Teachers can share updates for their currently assigned classes.</p><a href="/school">Open school setup and invitations</a>`;
}
const options = (rows, label, selectedId = "") =>
  rows
    .map(
      (r) =>
        `<option value="${esc(r.id || r.user_id)}" ${(r.id || r.user_id) === selectedId ? "selected" : ""}>${esc(label(r))}</option>`,
    )
    .join("");
function editorClass() {
  return workspace.classes.find(
    (c) => c.id === $("#editorForm [name=class_id]")?.value,
  );
}
function updateAudience() {
  const id = $("#editorForm [name=class_id]")?.value;
  const select = $("#editorForm [name=student_id]");
  if (select)
    select.innerHTML =
      '<option value="">Everyone in this class</option>' +
      options(
        workspace.students.filter((s) => s.class_id === id && s.is_active),
        (s) => s.full_name,
      );
}
function updateGuardianAccounts() {
  const student = workspace.students.find(
    (s) => s.id === $("#editorForm [name=student_id]")?.value,
  );
  const field = $("#editorForm [name=user_id]");
  field.innerHTML =
    '<option value="">Choose a parent account</option>' +
    options(
      workspace.parent_accounts.filter(
        (a) => a.branch_id === student?.branch_id,
      ),
      (a) => `${a.full_name} · ${a.phone || a.email}`,
    );
}
function openEditor(kind, id) {
  const row = workspace.students.find((s) => s.id === id);
  editing = { kind, row, version: epoch };
  $("#editorError").textContent = "";
  $("#editorForm button[type=submit]").disabled = false;
  const classes = workspace.classes.filter(
    (c) => kind !== "student" || c.can_manage,
  );
  const classSelect = `<label>Class<select name="class_id" required ${row ? "disabled" : ""}>${options(classes, (c) => `${c.name} · ${c.center_name} · ${c.year_name}`, row?.class_id || child()?.class_id)}</select></label>`;
  let fields = "";
  if (kind === "student") {
    $("#editorTitle").textContent = row
      ? "Edit child details"
      : "Welcome a little learner";
    $("#editorDescription").textContent =
      "Use an existing class from school setup. Class transfers and academic promotion are managed separately.";
    fields = `<label>Child’s full name<input name="full_name" maxlength="120" required value="${esc(row?.full_name)}"></label>${classSelect}<label class="check"><input type="checkbox" name="is_active" ${row?.is_active !== false ? "checked" : ""}>Active child record</label>`;
  } else if (kind === "guardian") {
    $("#editorTitle").textContent = "Connect home & school";
    $("#editorDescription").textContent =
      "Choose an account with active parent access in the child’s center. Linking grants access to this child’s updates and shared school conversation.";
    fields = `<label>Child<select name="student_id" required>${options(
      workspace.students.filter((s) => s.can_manage),
      (s) => `${s.full_name} · ${s.class_name}`,
      id || selected,
    )}</select></label><div id="guardianLinks" class="link-list"></div><label>Parent account<select name="user_id" required></select></label><label>Relationship<input name="relationship" maxlength="40" required placeholder="For example, Mother, Father, or Guardian"></label>`;
  } else {
    $("#editorTitle").textContent = "Share a little moment";
    $("#editorDescription").textContent =
      "This update will be visible to linked families as soon as you publish it.";
    fields = `${classSelect}<label>Share with<select name="student_id"></select></label><label>Update type<select name="kind"><option value="notice">School notice</option><option value="homework" ${route() === "homework" ? "selected" : ""}>Home learning</option><option value="diary" ${route() === "diary" ? "selected" : ""}>Daily diary</option><option value="event">Calendar event</option></select></label><label>Title<input name="title" maxlength="160" required></label><label>Message<textarea name="body" maxlength="10000" required></textarea></label><label id="eventDateField" hidden>Event date<input name="event_date" type="date"></label>`;
  }
  $("#editorFields").innerHTML = fields;
  $("#editorForm button[type=submit]").textContent =
    kind === "post"
      ? "Publish update"
      : kind === "guardian"
        ? "Connect parent"
        : "Save child";
  if (kind === "guardian") {
    updateGuardianAccounts();
    renderGuardianLinks();
  }
  if (kind === "post") updateAudience();
  $("#editor").showModal();
}
function renderGuardianLinks() {
  const student = $("#editorForm [name=student_id]").value;
  $("#guardianLinks").innerHTML = workspace.guardians
    .filter((g) => g.student_id === student && g.is_active)
    .map((g) => {
      const name =
        workspace.parent_accounts.find((a) => a.user_id === g.user_id)
          ?.full_name || "Linked parent";
      return `<div class="link-row"><span>${esc(name)} · ${esc(g.relationship)}</span><button type="button" class="danger" data-revoke="${esc(g.id)}">Revoke access</button></div>`;
    })
    .join("");
}
$("#editorForm").addEventListener("change", (event) => {
  if (editing?.kind === "post" && event.target.name === "class_id")
    updateAudience();
  if (editing?.kind === "post" && event.target.name === "kind") {
    $("#eventDateField").hidden = event.target.value !== "event";
    $("#eventDateField input").required = event.target.value === "event";
  }
  if (editing?.kind === "guardian" && event.target.name === "student_id") {
    updateGuardianAccounts();
    renderGuardianLinks();
  }
});
$("#editorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const context = editing,
    version = epoch,
    button = event.submitter,
    values = Object.fromEntries(new FormData(event.target));
  button.disabled = true;
  $("#editorError").textContent = "";
  try {
    if (context.kind === "student") {
      const c = workspace.classes.find(
        (c) => c.id === (context.row?.class_id || values.class_id),
      );
      if (!c)
        throw Error("Create an active class in School administration first.");
      await api("/students", {
        id: context.row?.id || null,
        version: context.row?.version || null,
        branch_id: c.branch_id,
        class_id: c.id,
        full_name: values.full_name,
        is_active: event.target.elements.is_active.checked,
      });
    } else if (context.kind === "guardian") {
      await api("/guardians", { ...values, is_active: true });
    } else {
      await api("/posts", {
        ...values,
        student_id: values.student_id || null,
        event_date: values.kind === "event" ? values.event_date : null,
      });
    }
    if (version !== epoch) return;
    $("#editor").close();
    await loadWorkspace();
    toast(
      context.kind === "post"
        ? "Your update is shared with families."
        : context.kind === "guardian"
          ? "Family access connected."
          : "Child details saved.",
    );
  } catch (error) {
    if (version === epoch) $("#editorError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "messageForm") return;
  event.preventDefault();
  const version = epoch,
    student = selected,
    button = event.submitter,
    body = event.target.elements.body.value.trim();
  if (!body) {
    $("#messageError").textContent = "Write a message before sending.";
    return;
  }
  button.disabled = true;
  try {
    await api(`/children/${student}/messages`, { body });
    if (version === epoch && student === selected && route() === "messages") {
      page = 1;
      await render();
      toast("Message sent to your school conversation.");
    }
  } catch (error) {
    if (version === epoch && student === selected && $("#messageError"))
      $("#messageError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("click", async (event) => {
  const el = event.target.closest("button,a");
  if (!el) return;
  if (el.matches("[data-close]")) {
    if (!$("#editorForm button[type=submit]").disabled) $("#editor").close();
    return;
  }
  if (el.matches("[data-follow]")) {
    selected = el.dataset.follow;
    $("#childSelect").value = selected;
    page = 1;
  }
  if (el.matches("[data-edit]"))
    return openEditor(el.dataset.edit, el.dataset.id);
  if (el.matches("[data-retry]")) return workspace ? render() : loadWorkspace();
  if (el.matches("[data-refresh]")) return loadWorkspace();
  if (el.matches("[data-page]")) {
    page = Number(el.dataset.page);
    return render();
  }
  if (el.matches("[data-month]")) {
    const d = parseDay(month);
    d.setMonth(d.getMonth() + Number(el.dataset.month));
    month = isoDate(d);
    chosenDay = month;
    return render();
  }
  if (el.matches("[data-day]")) {
    chosenDay = el.dataset.day;
    return render();
  }
  if (el.matches("[data-withdraw]")) {
    if (!confirm("Withdraw this update? Families will no longer see it."))
      return;
    el.disabled = true;
    const version = epoch;
    try {
      await api(`/posts/${el.dataset.withdraw}`, null, "DELETE");
      if (version === epoch) {
        await render();
        toast("Update withdrawn.");
      }
    } catch (error) {
      if (version === epoch) toast(error.message);
    } finally {
      el.disabled = false;
    }
  }
  if (el.matches("[data-revoke]")) {
    if (!confirm("Revoke this parent’s access to this child?")) return;
    const g = workspace.guardians.find((g) => g.id === el.dataset.revoke),
      version = epoch;
    el.disabled = true;
    try {
      await api("/guardians", {
        student_id: g.student_id,
        user_id: g.user_id,
        relationship: g.relationship,
        is_active: false,
      });
      if (version !== epoch) return;
      $("#editor").close();
      await loadWorkspace();
      toast("Family access revoked.");
    } catch (error) {
      if (version === epoch) $("#editorError").textContent = error.message;
    } finally {
      el.disabled = false;
    }
  }
});
$("#editor").addEventListener("cancel", (event) => {
  if ($("#editorForm button[type=submit]").disabled) event.preventDefault();
});
$("#childSelect").addEventListener("change", (event) => {
  selected = event.target.value;
  page = 1;
  render();
});
window.addEventListener("hashchange", () => {
  if ($("#portal").hidden) return;
  page = 1;
  render();
  window.scrollTo(0, 0);
  $("#main").focus({ preventScroll: true });
});
$(".skip").addEventListener("click", (event) => {
  event.preventDefault();
  ($("#portal").hidden ? $("#identity") : $("#main")).focus();
});
$("#togglePassword").addEventListener("click", () => {
  setPasswordVisibility($("#password").type === "password");
});
$("#togglePassword").hidden = false;
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter,
    version = ++epoch,
    remember = $("#remember").checked;
  button.disabled = true;
  $("#authMessage").textContent = "Signing in…";
  try {
    let identity = $("#identity").value.trim();
    const password = $("#password").value;
    if (!identity.includes("@")) {
      const mobile = identity.replace(/\D/g, "").slice(-10);
      if (!/^[6-9]\d{9}$/.test(mobile) || !/^\d{6}$/.test(password))
        throw Error(
          "Enter your email and password, or a valid mobile number and six-digit PIN.",
        );
      identity = `${mobile}@auth.octominds.invalid`;
    }
    const result = await auth("/token?grant_type=password", {
      email: identity,
      password,
    });
    if (version !== epoch) return;
    session = sessions.save(result, remember, session);
    $("#password").value = "";
    setPasswordVisibility(false);
    await enter();
    if (version === epoch) $("#authMessage").textContent = "";
  } catch (error) {
    if (version === epoch) $("#authMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#signOut").addEventListener("click", async () => {
  if (preview) {
    location.href = "/parents";
    return;
  }
  const revocation = sessions.signOut(session, user?.id, "local", revokeSession);
  clearSession();
  const version = epoch;
  $("#authMessage").textContent = "Signed out.";
  try {
    await revocation;
  } catch {
    if (epoch === version)
      $("#authMessage").textContent =
        "Signed out on this device. Your school could not confirm server sign-out.";
  }
});
window.addEventListener("storage", async (event) => {
  if (previewRequested) return;
  const version = epoch;
  if (await sessions.signedOut(event, session, user?.id) && version === epoch) {
    clearSession();
    $("#authMessage").textContent = "Signed out.";
  }
});
$("#previewRole").addEventListener("change", async (event) => {
  gallery.reset();
  epoch++;
  generation++;
  preview.setRole(event.target.value);
  workspace = null;
  $("#editor").close();
  selected = "";
  page = 1;
  await enter();
});
async function start() {
  const form = $("#loginForm");
  const version = epoch;
  try {
    if (previewRequested) {
      $("#loginForm button[type=submit]").disabled = true;
      const { createPreview } = await import("./parents-preview.js?v=2");
      preview = createPreview();
      await enter();
      return;
    }
    session = sessions.restore();
    if (!session) return;
    form.hidden = true;
    $("#authMessage").textContent = "Checking your saved session…";
    await enter();
    if (version === epoch) $("#authMessage").textContent = "";
  } catch (error) {
    if (version === epoch) $("#authMessage").textContent = error.message;
  } finally {
    form.hidden = false;
    if (previewRequested) $("#loginForm button[type=submit]").disabled = false;
  }
}
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
sessions.protectHistory($("#portal"), () => Boolean(session));
start();
