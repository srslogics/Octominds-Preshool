import { createTeacherWorkspace, teacherPages } from "../teachers/teachers.js?v=1";
import { renderFamilyFeed } from "./parents-feeds.js?v=2";
import { createSchoolCalendar } from "./parents-calendar.js?v=2";
import { createGallery } from "./parents-gallery.js?v=8";
const $ = (s) => document.querySelector(s);
const cfg = window.OCTOMINDS_CONFIG || {};
const sessions = window.OctomindsSession;
const teacherPortal = document.body.dataset.portal === "teacher";
const previewRequested = !teacherPortal && new URLSearchParams(location.search).get("preview") === "1";
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
const postSymbols = { notice: "📬", homework: "📚", diary: "🎨", event: "🗓️" };
const pages = {
  today: [
    "Today at School",
    "Catch up on class updates and what’s coming up next.",
  ],
  updates: [
    "School Updates",
    "Circulars and notices from your school team.",
  ],
  homework: [
    "Play & Learn at Home",
    "Simple activities to enjoy together.",
  ],
  diary: [
    "Daily Diary",
    "Notes about your child’s school day.",
  ],
  calendar: [
    "School Calendar",
    "Class events and school holidays.",
  ],
  messages: [
    "Ask the School",
    "A shared conversation with your school team.",
  ],
  child: [
    "My Child",
    "Class details and family access.",
  ],
  gallery: [
    "Photo Gallery",
    "Albums shared privately with your family.",
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
if (teacherPortal) Object.assign(pages, teacherPages);
let teacherClass = "";
let session = null,
  user = null,
  workspace = null,
  selected = "",
  generation = 0,
  epoch = 0,
  page = 1,
  editing = null,
  messageDraft = null,
  refreshing = null,
  moduleRequest = null,
  toastTimer;
const cacheableParentModules = new Set(["updates", "homework", "calendar"]);
const moduleCacheLifetime = 30_000;
const moduleCacheLimit = 12;
let moduleCache = new Map();

function clearModuleCache() {
  moduleCache = new Map();
}

const route = () => {
  const fallback = teacherPortal ? "classroom" : "today";
  const r = location.hash.replace(/^#\/?/, "") || fallback;
  return Object.hasOwn(teacherPortal ? teacherPages : pages, r) ? r : fallback;
};
const child = () => workspace?.students.find((s) => s.id === selected);
const firstName = (name) => (name || "").trim().split(/\s+/)[0];
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
const isOffline = () => !navigator.onLine || document.body.hasAttribute("data-offline-launch");
const empty = (name, title, text, action = "") =>
  `<div class="empty">${icon(name)}<h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
const loading = () =>
  `<div class="loading${teacherPortal ? "" : " loading--octopus"}" role="status">Bringing you up to date…</div>`;
function showAuthProgress(text) {
  const status = $("#authMessage");
  status.classList.toggle("auth-loading", !teacherPortal);
  status.textContent = text;
}
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
  moduleRequest?.abort();
  $("#authMessage").classList.remove("auth-loading");
  clearModuleCache();
  calendarView.reset();
  sampleAcknowledgments.clear();
  teacherDesk?.reset();
  teacherClass = "";
  gallery.reset();
  epoch++;
  generation++;
  sessions.clear(session);
  session = null;
  refreshing = null;
  user = null;
  workspace = null;
  messageDraft = null;
  selected = "";
  $("#portal").hidden = true;
  $("#auth").hidden = false;
  $("#content").replaceChildren();
  $("#childSelect").replaceChildren();
  $("#teacherClass")?.replaceChildren();
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
  signal,
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
  signal?.throwIfAborted();
  const token = session.access_token;
  const prefix = path.startsWith("/teachers/") ? "/api/v1" : "/api/v1/parents";
  const response = await fetch(prefix + path, {
    method,
    cache: "no-store",
    signal,
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
    clearModuleCache();
    if (session.access_token === token) await refresh();
    if (version !== epoch) throw Error("Your session changed.");
    return api(path, body, method, false, responseType, extraHeaders, signal);
  }
  if (response.ok && responseType === "blob") return response.blob();
  const result = await response.json().catch(() => ({}));
  signal?.throwIfAborted();
  if (version !== epoch) throw Error("Your session changed.");
  if (!response.ok) {
    if (response.status === 403) clearModuleCache();
    if (response.status === 401 && session.access_token === token) {
      clearSession();
      $("#authMessage").textContent = "Your session expired. Please sign in again.";
    }
    const error = Error(
      typeof result.detail === "string"
        ? result.detail
        : "We couldn’t complete that request. Please try again.",
    );
    error.status = response.status;
    throw error;
  }
  if (method !== "GET") clearModuleCache();
  return result;
}

async function readParentModule(path, signal, refreshModule) {
  if (isOffline() || !(session?.expires_at * 1000 > Date.now() + 30_000)) {
    return api(path, undefined, "GET", true, "json", {}, signal);
  }
  // Replacing the map keeps an in-flight response from repopulating a cleared cache.
  const cache = moduleCache;
  const cached = cache.get(path);
  if (!refreshModule && cached?.expiresAt > Date.now()) return cached.result;
  cache.delete(path);
  const result = await api(path, undefined, "GET", true, "json", {}, signal);
  if (!signal.aborted && cache === moduleCache) {
    if (cache.size >= moduleCacheLimit) cache.delete(cache.keys().next().value);
    cache.set(path, { result, expiresAt: Date.now() + moduleCacheLifetime });
  }
  return result;
}

async function enter() {
  const version = epoch;
  let fresh;
  if (!preview) {
    const params = new URLSearchParams({ include_account: "true" });
    if (route() === "today") params.set("today_month", firstDay());
    fresh = await api(teacherPortal ? "/teachers/workspace" : `/workspace?${params}`);
  }
  if (version !== epoch) return;
  user = preview ? preview.user() : fresh.account;
  $("#auth").hidden = true;
  $("#portal").hidden = false;
  if (!teacherPortal) $("#previewBanner").hidden = !preview;
  $("#accountName").textContent = user.full_name || "Your account";
  await loadWorkspace(fresh);
}
const teacherNav = [
  ["classroom", "home", "Classroom"], ["daily-care", "check", "Attendance & care", "Attendance"],
  ["diary", "diary", "Daily diary", "Diary"], ["homework", "homework", "Home learning", "Learning"],
  ["updates", "updates", "School updates", "Updates"], ["class-calendar", "calendar", "Class events", "Events"],
  ["school-albums", "gallery", "Class albums", "Albums"], ["messages", "messages", "Family conversations", "Messages"],
  ["meal-plan", "homework", "Meal plan"], ["care-profile", "child", "Child profile", "Profiles"],
];
function navigation() {
  const items = teacherPortal ? teacherNav : [
    ["today", "home", "Today"],
    ["updates", "updates", "School updates", "Updates"],
    ["homework", "homework", "Home learning", "Learning"],
    ["diary", "diary", "Daily diary", "Diary"],
    ["calendar", "calendar", "Calendar"],
    ["gallery", "gallery", "Photo gallery", "Photos"],
    ["messages", "messages", "Ask the school", "Messages"],
    ["child", "child", "My child"],
  ];
  if (!teacherPortal && (workspace.classes.length || workspace.students.some((s) => s.can_manage)))
    items.push(["manage", "manage", "School desk"]);
  const current = !teacherPortal && route() === "school-albums" ? "manage" : route();
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
  moduleRequest?.abort();
  clearModuleCache();
  calendarView.reset();
  const version = ++generation;
  $("#content").innerHTML = loading();
  try {
    const fresh = initialData ?? await api(teacherPortal ? "/teachers/workspace" : "/workspace");
    if (version !== generation || !user) return;
    workspace = fresh;
    if (teacherPortal) {
      const { classes } = workspace;
      if (!classes.some(item => item.id === teacherClass)) teacherClass = classes[0]?.id || "";
      const input = $("#teacherClass");
      input.innerHTML = options(classes, item => `${item.name} · ${item.center_name} · ${item.year_name}`, teacherClass);
      $("#teacherClassPicker").hidden = !classes.length;
    }
    populateChildPicker();
    await render(initialData?.today);
  } catch (error) {
    if (version === generation && user) showError(error);
  }
}
const teacherRoster = () => workspace.students.filter(student => student.class_id === teacherClass);
function populateChildPicker() {
  const students = teacherPortal ? teacherRoster() : workspace.students;
  if (!students.some((s) => s.id === selected))
    selected = students.find((s) => s.is_active)?.id || students[0]?.id || "";
  $("#childSelect").innerHTML = students.map((s) =>
    `<option value="${esc(s.id)}">${esc(s.full_name)}${s.is_active ? "" : " (inactive)"}</option>`).join("");
  $("#childSelect").value = selected;
}
function showError(error) {
  $("#content").innerHTML =
    `<div class="error" role="alert"><h2>We couldn’t load this just now.</h2><p>${esc(error.message)}</p><button type="button" data-retry>Try again</button></div>`;
}
function pagination(result) {
  return result.total > result.page_size
    ? `<div class="pagination"><button data-page="${page - 1}" ${page === 1 ? "disabled" : ""} aria-label="Previous page">${icon("back")}</button><span>Page ${page} of ${Math.ceil(result.total / result.page_size)}</span><button data-page="${page + 1}" ${page * result.page_size >= result.total ? "disabled" : ""} aria-label="Next page">${icon("next")}</button></div>`
    : "";
}
const sampleAcknowledgments = new Set();
const sectionSymbols = { updates: "📣", homework: "🧩", diary: "📖", gallery: "📸", messages: "💬" };
const teacherDesk = teacherPortal ? createTeacherWorkspace({ api, esc, go, toast, render, empty, pagination, stamp }) : null;
const calendarView = createSchoolCalendar({ esc, icon, isoDate, parseDay, empty, notify: toast });
const gallery = createGallery({
  api,
  context: () => ({ student: child(), workspace, epoch, generation, preview: Boolean(preview), classId: teacherClass,
    signal: moduleRequest?.signal }),
  esc,
  icon,
  formatDay,
  toast,
  refresh: loadWorkspace,
});
async function render(initialToday, { refreshModule = false } = {}) {
  moduleRequest?.abort();
  gallery.reset();
  if (!workspace || !user) return;
  moduleRequest = new AbortController();
  const { signal } = moduleRequest;
  const r = route(),
    version = ++generation,
    s = child();
  const useCache = !teacherPortal && !preview && user.role === "parent" && cacheableParentModules.has(r);
  const read = (path) => useCache
    ? readParentModule(path, signal, refreshModule)
    : api(path, undefined, "GET", true, "json", {}, signal);
  navigation();
  const isProfile = r === "child";
  const isToday = r === "today" && Boolean(s);
  const isSection = r !== "today" && !isProfile;
  const calendarExport = $("#calendarExport");
  calendarExport.hidden = r !== "calendar" || !s;
  calendarExport.disabled = true;
  const showsChild = Boolean(s) && (teacherPortal
    ? ["daily-care", "care-profile", "messages"].includes(r)
    : r !== "manage" && r !== "school-albums");
  const canSwitch = showsChild && (teacherPortal ? teacherRoster() : workspace.students).length > 1;
  const portal = $("#portal");
  portal.dataset.route = r;
  portal.classList.toggle("view-child", isProfile);
  portal.classList.toggle("view-today", isToday);
  portal.classList.toggle("view-section", isSection);
  $("#childBack").hidden = r === "today" || r === "classroom";
  $("#childBack").href = go(teacherPortal ? "classroom" : r === "school-albums" ? "manage" : "today");
  $("#childBackLabel").textContent = teacherPortal ? "Classroom" : r === "school-albums" ? "School desk" : "Today";
  const sectionIcon = sectionSymbols[r];
  $("#childBrand").hidden = Boolean(sectionIcon);
  $("#sectionSymbol").hidden = !sectionIcon;
  $("#sectionSymbol").textContent = sectionIcon || "";
  $("#todayGreeting").hidden = !isToday;
  if (isToday) {
    $("#todayGreeting").textContent = `Hello, ${firstName(user.full_name) || "there"}! 👋`;
  }
  $("#childChoice").hidden = !showsChild;
  if (showsChild) {
    $("#childChoice").setAttribute("aria-hidden", String(canSwitch));
    $("#childChoice").title = s.full_name;
    $("#childChoiceInitials").textContent = initials(s.full_name);
    $("#childChoiceName").textContent = canSwitch ? firstName(s.full_name) : s.full_name;
    $("#childChoiceArrow").hidden = !canSwitch;
  }
  $("#childSelect").hidden = !canSwitch;
  $("#childPicker").hidden = !showsChild || (isProfile && !canSwitch);
  $("#pageTitle").textContent = pages[r][0];
  $("#pageDescription").textContent = isProfile || isToday ? "" :
    r === "diary" && s ? s.full_name : r === "updates" && s?.center_name ? `${s.center_name} circulars and notices` : pages[r][1];
  $("#content").innerHTML = loading();
  try {
    let html = "";
    if (teacherDesk && !["school-albums", "messages"].includes(r)) {
      html = await teacherDesk.screen(r, workspace.classes.find(c => c.id === teacherClass), s, teacherRoster(), page);
    } else if (r === "manage") {
      html = manageScreen();
    } else if (r === "school-albums") {
      html =
        workspace.classes.length ||
        (!teacherPortal && workspace.students.some((student) => student.can_manage))
          ? await gallery.screen(null, page, read)
          : empty(
              "gallery",
              teacherPortal ? "No classes assigned yet" : "School albums are managed by staff.",
              teacherPortal ? "Ask your school administrator to assign a class to your account." : "Open the photo gallery to view albums shared with your family.",
              teacherPortal ? "" : `<a class="button secondary" href="${go("gallery")}">Open photo gallery</a>`,
            );
    } else if (!s && teacherPortal) {
      html = empty("messages", "No student selected", "Choose a class with enrolled students to open a family conversation.");
    } else if (!s) {
      html = empty(
        "child",
        "Your family connection starts here.",
        "Your school will link your account to your child. If you’ve already accepted an invitation, ask your administrator to complete the child link.",
        `<button data-refresh type="button" class="secondary">Check again</button>`,
      );
    } else if (r === "child") {
      const profile = preview ? s.profile : await read(`/children/${s.id}/profile`);
      html = profileScreen(s, profile);
    } else if (r === "gallery") {
      html = await gallery.screen(s, page, read);
    } else if (r === "messages") {
      html = await messageScreen(s, await read(`/children/${s.id}/messages?page=${page}`));
    } else if (r === "calendar") {
      const result = await calendarView.screen(s, Boolean(preview), read, () => version === generation && Boolean(user));
      if (version !== generation || !user) return;
      html = result.html;
      calendarExport.disabled = !result.canExport;
    } else if (r === "today") {
      const todayMonth = firstDay();
      if (initialToday?.student_id === s.id && initialToday.month === todayMonth) {
        html = todayScreen(s, initialToday, initialToday.calendar, initialToday.care);
      } else if (preview) {
        const [feed, calendar] = await Promise.all([
          read(`/children/${s.id}/posts`),
          read(`/children/${s.id}/calendar?month=${todayMonth}&include_care=true`),
        ]);
        html = todayScreen(s, feed, calendar, feed.care || calendar.care);
      } else {
        const today = await read(`/children/${s.id}/today?month=${todayMonth}`);
        html = todayScreen(s, today, today.calendar, today.care);
      }
    } else {
      const kind = r === "updates" ? "circulars" : r;
      const feed = await read(
        `/children/${s.id}/posts?kind=${kind}&page=${page}`,
      );
      html = renderFamilyFeed({ route: r, feed, student: s, preview: Boolean(preview), acknowledgments: sampleAcknowledgments,
        esc, stamp, formatDay, go, pagination, empty });
    }
    if (version !== generation || !user) return;
    $("#content").innerHTML = html;
    if (r === "messages" && messageDraft?.student === s?.id) {
      const input = $("#messageBody");
      if (input) {
        input.value = messageDraft.text;
        if (messageDraft.topic) setMessageTopic(input.form, messageDraft.topic);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      messageDraft = null;
    }
    if (r === "gallery" || r === "school-albums") gallery.mount();
  } catch (error) {
    if (signal.aborted || version !== generation || !user) return;
    if (refreshModule && error.status === 403) return loadWorkspace();
    showError(error);
  }
}
const profileIcon = (emoji) => `<span aria-hidden="true">${emoji}</span>`;

function todayMoment(post) {
  const feature = preview ? post.today_feature : null;
  const symbol = feature?.symbol || postSymbols[post.kind] || "✨";
  return `<article class="today-card today-moment">
    <div class="today-moment-heading">
      <span class="today-moment-icon">${profileIcon(symbol)}</span>
      <div><h3>${esc(post.title)}</h3>
        <p><time datetime="${esc(post.created_at)}">${esc(stamp(post.created_at))}</time> · ${esc(post.author_name)}</p>
      </div>
      <span class="today-pill">${esc(feature?.category || labels[post.kind] || "School update")}</span>
    </div>
    ${feature?.quote ? `<a href="${go("gallery")}" class="today-art">
      <span aria-hidden="true">🎨 🖐️ 🌈</span>
      <strong>“${esc(feature.quote)}”</strong>
      <span class="today-pill">View sample album →</span>
    </a>` : ""}
    <p class="today-moment-note">${feature?.quote ? "<strong>Teacher note:</strong> " : ""}${esc(post.body)}</p>
    ${post.event_date ? `<p class="support-note">${esc(formatDay(post.event_date, { weekday: "long", day: "numeric", month: "long" }))}</p>` : ""}
    ${post.can_withdraw ? `<button type="button" class="quiet danger" data-withdraw="${esc(post.id)}">Withdraw</button>` : ""}
  </article>`;
}

function schoolTime(time) {
  if (!time) return "";
  const [hour, minute] = time.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(new Date(2000, 0, 1, hour, minute));
}

function attendanceLabel(details = {}) {
  if (details.attendance === "absent") return "Absent";
  if (details.departure) return `Checked out at ${schoolTime(details.departure)}`;
  if (details.attendance === "late") return details.arrival ? `Arrived late at ${schoolTime(details.arrival)}` : "Marked late";
  if (details.attendance === "present") return details.arrival ? `Checked in at ${schoolTime(details.arrival)}` : "Present";
  return "";
}

function todayScreen(student, feed, calendar, care) {
  const sample = preview ? student.today : null;
  const today = care?.day || isoDate(new Date());
  const daily = care?.daily?.details || {};
  const meals = [["Breakfast", "breakfast"], ["Lunch", "lunch"], ["Snack", "snack"]]
    .map(([label, field]) => [label, care?.meals?.details?.[field]]).filter(([, value]) => value);
  const routines = sample?.routines || [
    ["🥪", "Lunch & nutrition", "", daily.lunch, "mint"],
    ["😴", "Rest time", "", daily.rest, "plum"],
    ["💧", "Water & toilet", "", [daily.water && `Water: ${daily.water}`, daily.toilet && `Toilet: ${daily.toilet}`].filter(Boolean).join(" · "), "blue"],
  ].filter(([, , , description]) => description);
  const attendance = [attendanceLabel(daily), daily.mood].filter(Boolean).join(" · ");
  const recent = feed.posts.find((post) => post.kind === "diary" && isoDate(new Date(post.created_at)) === today);
  const upcoming = [...calendar.events, ...calendar.holidays.map((holiday) => ({ ...holiday, event_date: holiday.starts_on }))]
    .filter((event) => (event.ends_on || event.event_date) >= today)
    .sort((a, b) => a.event_date.localeCompare(b.event_date))[0];
  const features = sample ? feed.posts.filter((post) => post.today_feature) : [];
  const moments = (features.length ? features : feed.posts).slice(0, 3);
  const heroTitle = sample ? `${firstName(student.full_name)}’s day is in full swing!` : `${firstName(student.full_name)}’s day at school`;
  const quickActions = [
    ["messages", "🚗", "Running late", "late"],
    ["messages", "🤒", "Report absent", "absent"],
    ["messages", "💬", "Message teacher"],
    ["child", "🛡️", sample?.pickup ? "Gate pass" : "My child"],
  ];
  const draftLink = student.is_active ? `<a href="${go("messages")}">Ask the school about meals →</a>` : "";
  return `<div class="today-dashboard">
    <section class="today-hero" aria-labelledby="today-overview">
      <div class="today-hero-intro">
        <div><span class="today-location">${profileIcon("📍")} ${esc(sample?.group || student.class_name)} · ${esc(student.center_name)}</span>
          <h2 id="today-overview">${esc(heroTitle)}</h2>
          <p>${esc(sample?.arrival || attendance || (recent ? "There’s a new note in the Daily Diary today." : "See notes and moments shared by your school team."))}</p>
        </div>
        <div class="today-hero-art" aria-hidden="true">
          <span class="today-sun">☀</span>
          <div class="today-mascot"><img src="/assets/octominds-logo-horizontal.png" alt="" width="1437" height="540"></div>
        </div>
      </div>
      ${sample?.current ? `<div class="today-current">
        <span class="today-current-icon">${profileIcon("😴")}</span>
        <div><h3>${esc(sample.current.title)}</h3><p>${esc(sample.current.note)}</p></div>
        <span class="today-pill plum">${esc(sample.current.remaining)}</span>
      </div>` : ""}
      <div class="today-hero-footer">
        ${sample?.pickup ? `<a class="today-pickup" href="${go("child")}">${profileIcon("🛡️")} Gate pickup <strong>${esc(sample.pickup)}</strong></a>` : daily.pickup_note ? `<p class="today-pickup"><strong>Pickup instructions</strong> ${esc(daily.pickup_note)}</p>` : ""}
        <a class="button primary" href="${go("diary")}">${profileIcon("📖")} Open full daily diary <span aria-hidden="true">→</span></a>
      </div>
    </section>
    <section aria-labelledby="today-care">
      <div class="today-section-heading"><h2 id="today-care">${profileIcon("🥣")} Today’s Care &amp; Routine Log</h2>
        ${sample?.updated ? `<span class="today-pill mint">${esc(sample.updated)}</span>` : ""}
      </div>
      ${routines.length ? `<div class="today-routine-grid">${routines.map(([symbol, title, status, description, tone]) =>
        `<article class="today-card today-routine"><div><span>${profileIcon(symbol)}</span>${status ? `<span class="today-pill ${esc(tone)}">${esc(status)}</span>` : ""}</div>
          <h3>${esc(title)}</h3><p>${esc(description)}</p></article>`).join("")}</div>` :
        daily.note ? "" : `<div class="today-card today-routine-note"><h3>${esc(recent?.title || "Daily care notes")}</h3><p>${esc(recent?.body || "Care and routine updates appear in the Daily Diary when your school shares them.")}</p></div>`}
      ${daily.note ? `<article class="today-card today-routine-note"><h3>Note from school</h3><p>${esc(daily.note)}</p></article>` : ""}
    </section>
    <section aria-labelledby="today-moments">
      <div class="today-section-heading"><h2 id="today-moments">${profileIcon("🎨")} Little Moments Captured</h2><a href="${go("updates")}">School updates →</a></div>
      <div class="today-moments">${moments.map(todayMoment).join("") || '<div class="today-card today-routine-note"><p>School updates will appear here when they’re shared.</p></div>'}</div>
    </section>
    <div class="today-plans">
      <section class="today-card today-plan">
        <div class="today-section-heading"><h2>${profileIcon("🗓️")} Coming Up</h2>
          ${upcoming ? `<span class="today-pill">${esc(formatDay(upcoming.event_date))}</span>` : ""}
        </div>
        ${upcoming ? `<h3>${esc(upcoming.title || upcoming.name)}</h3><p>${esc(upcoming.body || "School holiday")}</p>` : '<p>No upcoming events this month.</p>'}
        <a href="${go("calendar")}">View calendar →</a>
      </section>
      <section class="today-card today-plan today-menu">
        <div class="today-section-heading"><h2>${profileIcon("🥗")} Kitchen Menu</h2>
          ${sample?.menu ? '<span class="today-pill mint">Sample menu</span>' : ""}
        </div>
        ${sample?.menu ? `<h3>Fresh from the school kitchen</h3><p>${esc(sample.menu.snack)}<br>${esc(sample.menu.evening)}</p>
          <details><summary>Full menu plan</summary><p>${esc(sample.menu.lunch)}</p></details>` : meals.length
          ? meals.map(([label, value]) => `<p><strong>${label}</strong> · ${esc(value)}</p>`).join("")
          : `<p>Contact your school for this week’s meal plan.</p>${draftLink}`}
      </section>
    </div>
    <nav class="today-card today-actions" aria-label="Quick actions">
      ${quickActions.filter(([route]) => student.is_active || route !== "messages")
        .map(([route, emoji, label, draft]) => `<a href="${go(route)}"${draft ? ` data-today-draft="${draft}"` : ""}>
          <span class="today-action-icon">${profileIcon(emoji)}</span><strong>${label}</strong></a>`).join("")}
    </nav>
  </div>`;
}

const profileLink = (route, label, style = "") =>
  `<a class="profile-button ${style}" href="${go(route)}">${label}</a>`;

function profileScreen(s, profile = {}) {
  const { team = [], office_phone: phone } = profile;
  const display = preview ? profile : (profile.family_profile || {});
  const care = preview ? display.care || [] : [
    ["Allergies", "❤️", display.allergies], ["Diet plan", "🥦", display.diet],
    ["Blood group", "🩸", display.blood_group], ["Nap routine", "😴", display.nap],
  ].filter(([, , value]) => value);
  const milestones = preview ? display.milestones || [] : (display.milestones || "")
    .split("\n").map(name => name.trim()).filter(Boolean).map(name => ["⭐", name]);
  const family = display.pickups || [{
    full_name: user.full_name,
    relationship: s.relationship || "Your account",
  }];
  const status = display.check_in || attendanceLabel(profile.attendance?.details) || (s.is_active ? "Enrollment active" : "Enrollment inactive");
  const officeNumber = phone?.replace(/[\s().-]/g, "");
  const contact = /^\+?[0-9]{6,15}$/.test(officeNumber || "")
    ? `tel:${officeNumber}` : go("messages");
  const officeTitle = s.center_name ? `Contact ${esc(s.center_name)} Center Office` : "Contact the school office";
  const familyTitle = display.pickups ? "Authorized Pickups" : "Family Access";
  return `<div class="child-profile">
    <section class="child-card child-hero" aria-labelledby="child-name">
      <div class="child-identity">
        <div class="child-portrait" aria-hidden="true">
          <span>${display.avatar || esc(initials(s.full_name))}</span>
          <img src="/assets/octominds-icon-192.png" width="28" height="28" alt="">
        </div>
        <div class="child-identity-details">
          <div class="child-name-line"><h2 id="child-name">${esc(s.full_name)}</h2>
            ${display.nickname ? `<span class="child-nickname">“${esc(display.nickname)}” ${profileIcon("⭐")}</span>` : ""}
          </div>
          <p class="child-class">${profileIcon("🚀")} ${esc(display.class_label || s.class_name)}</p>
          <div class="child-tags">
            <span>${profileIcon("📍")} ${esc(s.center_name)}</span>
            ${display.cubby ? `<span class="child-cubby">${profileIcon("🐬")} ${esc(display.cubby)}</span>` : ""}
          </div>
        </div>
      </div>
      <div class="child-summary">
        <span class="child-status ${s.is_active ? "" : "inactive"}"><i></i>${esc(status)}</span>
        <span>${profileIcon(display.age ? "🎂" : "📅")} ${esc(display.age || s.year_name)}</span>
      </div>
    </section>
    <section class="child-card child-green" aria-labelledby="child-office">
      <span class="child-green-icon">${profileIcon(display.pickup_code ? "🛡️" : "💬")}</span>
      <div>
        <h2 id="child-office">${display.pickup_code ? 'Gate Pickup Pass <span class="child-pass-status">Sample</span>' : "School Office"}</h2>
        <p>${display.pickup_code ? "Example pickup at 1:30 PM" : "Get help with pickup or your child’s school day."}</p>
      </div>
      ${display.pickup_code
        ? `<span class="profile-button pickup-code">${esc(display.pickup_code)}</span>`
        : `<a class="profile-button" href="${contact}">${contact.startsWith("tel:") ? "Call school" : "Message school"}</a>`}
    </section>
    <section class="child-team" aria-labelledby="child-team">
      <div class="child-section-title"><h2 id="child-team">${profileIcon("👩‍🏫")} Teachers &amp; Caregivers</h2><span>${esc(s.class_name)}</span></div>
      ${team.length ? `<div class="child-team-grid">${team.map((member) => `<article class="child-card child-team-member">
        <div class="child-member"><span class="child-person-avatar" aria-hidden="true">${esc(member.avatar || initials(member.full_name))}</span>
          <div><h3>${esc(member.full_name)}</h3><p>${esc(member.role)}</p></div></div>
        ${member.description ? `<p class="child-card-copy">${esc(member.description)}</p>` : ""}
        ${profileLink("messages", member.role === "Class Caregiver" ? "Ask about care" : "Message school")}
      </article>`).join("")}</div>`
      : `<div class="child-card child-section"><p class="child-card-copy">No classroom team is listed here yet.</p></div>`}
    </section>
    <section class="child-card child-section" aria-labelledby="child-care">
      <div class="child-section-title"><h2 id="child-care">${profileIcon("❤️")} Care &amp; Well-being</h2></div>
      ${care.length ? `<dl class="child-care-grid">${care.map(([label, emoji, value]) =>
        `<div><dt>${esc(label)}</dt><dd>${profileIcon(emoji)} ${esc(value)}</dd></div>`).join("")}</dl>`
      : `<p class="child-card-copy">Ask the school about allergies, meals or daily care routines.</p>${profileLink("messages", "Ask about care", "profile-inline")}`}
    </section>
    <section class="child-card child-section" aria-labelledby="child-family">
      <div class="child-section-title"><h2 id="child-family">${profileIcon("👥")} ${familyTitle}</h2>
        ${s.can_manage ? '<button class="profile-button profile-inline" type="button" data-edit="guardian">+ Add guardian</button>' : ""}
      </div>
      <ul class="child-family-list">${family.map((guardian) => `<li>
        <span class="child-person-avatar" aria-hidden="true">${esc(initials(guardian.full_name))}</span>
        <div><h3>${esc(guardian.full_name)}</h3><p>${esc(guardian.relationship)}</p></div>
        ${display.pickups ? '<span class="child-pickup-badge">Example</span>' : ""}
      </li>`).join("")}</ul>
    </section>
    <section class="child-card child-section" aria-labelledby="child-milestones">
      <div class="child-section-title"><h2 id="child-milestones">${profileIcon("🏆")} Little Milestones${milestones.length ? " Unlocked" : ""}</h2></div>
      ${milestones.length ? `<ul class="child-milestones">${milestones.map(([emoji, name]) =>
        `<li>${profileIcon(emoji)}<strong>${esc(name)}</strong></li>`).join("")}</ul>`
      : `<p class="child-card-copy">Explore the daily diary for updates from your child’s class.</p>${profileLink("diary", "Open daily diary", "profile-inline")}`}
    </section>
    <a class="profile-button child-contact" href="${contact}">${profileIcon("📞")} ${officeTitle}</a>
  </div>`;
}
const messageTopics = {
  teacher: ["Class teacher", "👩‍🏫", "Write a note to the school team…"],
  care: ["Medicine / diet", "💊", "Write a care note for the school team…"],
  transport: ["Transport / late", "🚗", "Write a transport or arrival note…"],
};
const messageTemplates = {
  late: ["🚗", "Running 15m late", "transport", name => `Hello, ${name} is running about 15 minutes late today. `],
  early: ["🕒", "Early pickup today", "transport", name => `Hello, I’d like to pick up ${name} early today. Pickup time: `],
  care: ["💊", "Medicine note", "care", name => `Hello, I have a care note for ${name}: `],
};
const topicPrefix = (topic) => topic === "teacher" ? "" : `[${messageTopics[topic][0]}] `;
function setMessageTopic(form, topic) {
  form.dataset.topic = topic;
  const input = form.elements.body;
  input.placeholder = messageTopics[topic][2];
  input.maxLength = 2000 - topicPrefix(topic).length;
  document.querySelectorAll("[data-message-topic]").forEach(button =>
    button.setAttribute("aria-pressed", String(button.dataset.messageTopic === topic)));
}
function messageScreen(s, result) {
  return `<div class="school-conversation">
    ${teacherPortal ? `<div class="toolbar"><strong>${esc(s.full_name)}</strong><span class="spacer"></span>
      <button type="button" data-refresh class="secondary">Refresh</button></div>` : s.is_active ? `<div class="message-topics" role="group" aria-label="Message topic">
      ${Object.entries(messageTopics).map(([key, [label, emoji]]) => `<button type="button" data-message-topic="${key}" aria-pressed="${key === "teacher"}">${profileIcon(emoji)} ${label}</button>`).join("")}
    </div>` : ""}
    <details class="conversation-access"><summary>Who can read this conversation?</summary><p>Linked guardians and the assigned school team share this thread. For anything urgent, contact your school directly.</p></details>
    ${pagination(result)}
    <div class="thread">${result.messages.map((m) => `<article class="message ${m.is_own ? "own" : ""}">
      ${m.is_own ? "" : `<span class="avatar" aria-hidden="true">${esc(initials(m.author_name))}</span>`}
      <div class="message-copy"><p>${esc(m.body)}</p>
        <div class="message-meta"><time datetime="${esc(m.created_at)}">${esc(stamp(m.created_at))}</time> · ${esc(m.is_own ? "You" : m.author_name)}</div>
      </div>
    </article>`).join("") || empty("messages", "Start a conversation.", "Ask about their day, share a little update, or let the school know what’s on your mind.")}</div>
    ${s.is_active ? `<form id="messageForm" class="message-form" data-topic="teacher">
      ${teacherPortal ? "" : `<div class="message-templates" role="group" aria-label="Quick message drafts">
        ${Object.entries(messageTemplates).map(([key, [emoji, label]]) => `<button type="button" data-message-template="${key}">${profileIcon(emoji)} ${label}</button>`).join("")}
      </div>`}
      <div class="message-compose"><label for="messageBody" class="sr-only">Your message</label>
        <textarea id="messageBody" name="body" maxlength="2000" required placeholder="${teacherPortal ? "Write a reply to the family…" : messageTopics.teacher[2]}" rows="2"></textarea>
        <button class="primary" type="submit" aria-label="Send message">${profileIcon("➤")}</button>
      </div>
      <p class="field-error" id="messageError" role="alert"></p>
    </form>` : ""}
  </div>`;
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
    ${!preview && workspace.classes.length ? `<a class="staff-action" href="/teachers">
      ${icon("manage")}<span><strong>Open Teacher App</strong><small>Manage the class and share family updates.</small></span>
    </a>` : ""}
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
  const classSelect = `<label>Class<select name="class_id" required ${row ? "disabled" : ""}>${options(classes, (c) => `${c.name} · ${c.center_name} · ${c.year_name}`, row?.class_id || (teacherPortal ? teacherClass : child()?.class_id))}</select></label>`;
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
    fields = `${classSelect}<label>Share with<select name="student_id"></select></label><label>Update type<select name="kind"><option value="notice">School notice</option><option value="homework" ${route() === "homework" ? "selected" : ""}>Home learning</option><option value="diary" ${route() === "diary" ? "selected" : ""}>Daily diary</option><option value="event" ${route() === "class-calendar" ? "selected" : ""}>Calendar event</option></select></label><label>Title<input name="title" maxlength="160" required></label><label>Message<textarea name="body" maxlength="10000" required></textarea></label><label id="eventDateField" hidden>Event date<input name="event_date" type="date"></label>`;
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
  if (kind === "post") {
    updateAudience();
    if (route() === "class-calendar") {
      $("#eventDateField").hidden = false;
      $("#eventDateField input").required = true;
    }
  }
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
      const relationship = values.relationship.trim();
      if (!/\p{L}/u.test(relationship) || relationship.includes("@"))
        throw Error("Enter a relationship such as Mother, Father, or Guardian.");
      await api("/guardians", { ...values, relationship, is_active: true });
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
    await api(`/children/${student}/messages`, { body: topicPrefix(event.target.dataset.topic) + body });
    if (version === epoch && student === selected && route() === "messages") {
      page = 1;
      await render();
      toast(teacherPortal ? "Message sent to the family conversation." : "Message sent to your school conversation.");
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
  if (el.dataset.sampleAck && preview && route() === "updates") {
    sampleAcknowledgments.add(el.dataset.sampleAck);
    el.textContent = "✓ Acknowledged";
    el.classList.add("acknowledged");
    el.disabled = true;
    return;
  }
  if (el.dataset.messageTopic || el.dataset.messageTemplate) {
    const form = $("#messageForm");
    if (!form) return;
    if (el.dataset.messageTopic) setMessageTopic(form, el.dataset.messageTopic);
    else {
      const [, , topic, text] = messageTemplates[el.dataset.messageTemplate];
      const input = form.elements.body;
      if (input.value.trim() && !window.confirm("Replace your current draft with this quick message?")) return;
      setMessageTopic(form, topic);
      input.value = text(child().full_name);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    return;
  }
  if (el.dataset.homeActivity && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && child()?.is_active) {
    messageDraft = { student: child().id, text: `Hello, we tried “${el.dataset.homeActivity}” at home. ` };
  }
  if (el.dataset.todayDraft && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    const s = child();
    if (s?.is_active) {
      messageDraft = {
        student: s.id,
        text: el.dataset.todayDraft === "late"
          ? `Hello, ${s.full_name} will be arriving late today. Expected arrival time: `
          : `Hello, ${s.full_name} will be absent today. `,
      };
    }
  }
  if (el.matches("[data-close]")) {
    if (!$("#editorForm button[type=submit]").disabled) $("#editor").close();
    return;
  }
  if (el.matches("[data-follow]")) {
    clearModuleCache();
    selected = el.dataset.follow;
    $("#childSelect").value = selected;
    page = 1;
  }
  if (el.matches("[data-edit]"))
    return openEditor(el.dataset.edit, el.dataset.id);
  if (el.matches("[data-retry]")) return workspace ? render() : loadWorkspace();
  if (el.matches("[data-refresh]")) {
    if (!teacherPortal && !preview && child() && ["updates", "homework", "diary", "gallery"].includes(route())) {
      return render(undefined, { refreshModule: true });
    }
    return loadWorkspace();
  }
  if (el.matches("[data-page]")) {
    page = Number(el.dataset.page);
    return render();
  }
  if (el.matches("[data-school-calendar]")) {
    event.preventDefault();
    if (route() !== "calendar") return;
    const { schoolCalendar: action, value } = el.dataset;
    if (calendarView.handle(action, value)) {
      const version = generation + 1;
      await render();
      if (route() === "calendar" && version === generation) {
        const selector = `[data-school-calendar="${action}"]${value ? `[data-value="${CSS.escape(value)}"]` : ""}`;
        (document.querySelector(selector) || document.querySelector('[data-school-calendar="filter"]'))?.focus({ preventScroll: true });
      }
    }
    return;
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
$("#teacherClass")?.addEventListener("change", (event) => {
  teacherClass = event.target.value;
  teacherDesk.reset();
  populateChildPicker();
  page = 1;
  render();
});
$("#childSelect").addEventListener("change", (event) => {
  clearModuleCache();
  calendarView.reset();
  messageDraft = null;
  selected = event.target.value;
  page = 1;
  render();
});
window.addEventListener("hashchange", () => {
  if ($("#portal").hidden) return;
  page = 1;
  if (route() !== "messages") messageDraft = null;
  if (route() !== "calendar") calendarView.reset();
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
  showAuthProgress("Signing in…");
  try {
    if (isOffline()) throw Error("Reconnect to sign in.");
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
    if (version === epoch) $("#authMessage").classList.remove("auth-loading");
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
$("#previewRole")?.addEventListener("change", async (event) => {
  gallery.reset();
  epoch++;
  generation++;
  preview.setRole(event.target.value);
  workspace = null;
  messageDraft = null;
  $("#editor").close();
  selected = "";
  page = 1;
  await enter();
});
let restoreWhenOnline = false;
async function start() {
  const form = $("#loginForm");
  const version = epoch;
  try {
    if (previewRequested) {
      $("#loginForm button[type=submit]").disabled = true;
      const { createPreview } = await import("./parents-preview.js?v=6");
      preview = createPreview();
      await enter();
      return;
    }
    session = sessions.restore();
    if (!session) return;
    if (isOffline()) {
      restoreWhenOnline = true;
      return;
    }
    form.hidden = true;
    showAuthProgress("Checking your saved session…");
    await enter();
    if (version === epoch) $("#authMessage").textContent = "";
  } catch (error) {
    if (version === epoch) {
      restoreWhenOnline = Boolean(session) && isOffline();
      $("#authMessage").textContent = restoreWhenOnline ? "" : error.message;
    }
  } finally {
    if (version === epoch) $("#authMessage").classList.remove("auth-loading");
    form.hidden = false;
    if (previewRequested) $("#loginForm button[type=submit]").disabled = false;
  }
}
window.addEventListener("online", () => {
  if (!restoreWhenOnline) return;
  restoreWhenOnline = false;
  start();
});
window.addEventListener("offline", clearModuleCache);
if (teacherPortal && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
sessions.protectHistory($("#portal"), () => Boolean(session));
start();
