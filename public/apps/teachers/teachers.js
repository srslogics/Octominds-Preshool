// Staff views use the shared portal's session, publishing, messages, and gallery.
export const teacherPages = {
  classroom: ["Teacher workspace", "Choose a class to see its roster and share updates."],
  "daily-care": ["Attendance & daily care", "Share today’s attendance, routine, and pickup notes with linked families."],
  "meal-plan": ["Class meal plan", "Share the menu for the selected class and day."],
  "care-profile": ["Child profile", "Update classroom details and milestones that appear in My Child."],
  diary: ["Daily diary", "Share classroom notes or a private note with one family."],
  homework: ["Home learning", "Share an activity with families in this class."],
  updates: ["School updates", "Publish notices and event announcements."],
  "class-calendar": ["Class events", "Publish events that appear on the family calendar."],
  "school-albums": ["Class albums", "Upload and publish private albums for linked families."],
  messages: ["Family conversations", "Read and reply to the selected child’s shared conversation."],
};

const actions = [
  ["daily-care", "📋", "Attendance & care", "Check-in, rest, meals, and daily notes"],
  ["diary", "📖", "Daily diary", "Classroom moments and private notes"],
  ["homework", "🧩", "Home learning", "Activities to try at home"],
  ["updates", "📣", "School updates", "Notices and circulars"],
  ["class-calendar", "📅", "Class events", "Dates and preparation details"],
  ["school-albums", "📸", "Class albums", "Upload and publish photos"],
  ["messages", "💬", "Conversations", "Messages from linked families"],
  ["meal-plan", "🍲", "Meal plan", "Breakfast, lunch, and snack"],
  ["care-profile", "🌱", "Child profile", "Classroom details and milestones"],
];

const dailyFields = [
  ["attendance", "Attendance", [["", "Choose a status"], ["present", "Present"], ["late", "Late"], ["absent", "Absent"]]],
  ["arrival", "Arrival time", "time"], ["departure", "Departure time", "time"],
  ["mood", "Arrival mood", "text", 200], ["lunch", "Lunch & nutrition", "textarea", 400],
  ["rest", "Rest or nap", "textarea", 400], ["water", "Water intake", "text", 200],
  ["toilet", "Toilet routine", "text", 200], ["pickup_note", "Pickup instructions", "textarea", 400],
  ["note", "Note to the family", "textarea", 1000],
];
const menuFields = [
  ["breakfast", "Breakfast", "textarea", 400], ["lunch", "Lunch", "textarea", 400], ["snack", "Snack", "textarea", 400],
];
const profileFields = [
  ["nickname", "Nickname", "text", 80], ["cubby", "Cubby", "text", 40], ["nap", "Nap routine", "textarea", 400],
  ["milestones", "Milestones (one per line)", "textarea", 1000],
];
const healthFields = [
  ["allergies", "Allergies", "textarea", 400], ["diet", "Diet plan", "textarea", 400],
  ["blood_group", "Blood group", [["", "Not recorded"], ...["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map(value => [value, value])]],
];

export function createTeacherWorkspace({ api, esc, go, toast, render, empty, pagination, stamp }) {
  let workingDay = "";

  function reset() { workingDay = ""; }

  function field([key, label, type, max], values, disabled = false) {
    const value = values[key] ?? "";
    let input;
    if (Array.isArray(type)) {
      input = `<select name="${key}" ${disabled ? "disabled" : ""}>${type.map(([v, name]) =>
        `<option value="${v}" ${v === value ? "selected" : ""}>${name}</option>`).join("")}</select>`;
    } else if (type === "textarea") {
      input = `<textarea name="${key}" maxlength="${max}" rows="2" ${disabled ? "disabled" : ""}>${esc(value)}</textarea>`;
    } else {
      input = `<input name="${key}" type="${type}" value="${esc(value)}" ${max ? `maxlength="${max}"` : ""} ${disabled ? "disabled" : ""}>`;
    }
    return `<label>${label}${input}</label>`;
  }

  async function recordForm(route, classroom, student) {
    const profile = route === "care-profile";
    const menu = route === "meal-plan";
    if (!menu && !student)
      return empty("child", "No students in this class", "School administration can add students to the class roster.");
    const day = workingDay || new Intl.DateTimeFormat("sv-SE", { timeZone: classroom.timezone || "Asia/Kolkata" }).format(new Date());
    const path = menu ? `/teachers/classes/${classroom.id}/menu/${day}`
      : `/teachers/children/${student.id}/${profile ? "profile" : `daily/${day}`}`;
    const record = await api(path);
    const values = record?.details || {};
    const fields = menu ? menuFields : profile ? profileFields : dailyFields;
    return `<section class="teacher-panel">
      <div class="teacher-panel-heading"><h2>${esc(menu ? classroom.name : student.full_name)}</h2>
        ${profile ? "" : `<label>School day<input aria-label="School day" type="date" data-teacher-day value="${day}" required></label>`}</div>
      <form data-teacher-record="${path}">
        <input type="hidden" name="version" value="${record?.version || ""}">
        <div class="teacher-fields">${fields.map(item => field(item, values)).join("")}</div>
        ${profile ? `<h3 class="teacher-health">Health &amp; diet</h3>
          ${student.can_manage ? "" : '<p class="support-note">A center administrator maintains these fields.</p>'}
          <div class="teacher-fields">${healthFields.map(item => field(item, values, !student.can_manage)).join("")}</div>` : ""}
        <p class="field-error" data-teacher-error role="alert"></p>
        <div class="teacher-form-actions"><button type="submit" class="primary">Save for families</button></div>
      </form>
    </section>`;
  }

  async function screen(route, classroom, student, roster, page) {
    if (!classroom)
      return empty("manage", "No classes assigned yet", "Ask your school administrator to assign an active class to your account.",
        '<a class="button secondary" href="/school">Open school administration</a>');
    if (route === "classroom") {
      return `<section class="teacher-hero"><div><p>${esc(classroom.center_name)} · ${esc(classroom.year_name)}</p>
        <h2>${esc(classroom.name)}</h2><p>${roster.length} ${roster.length === 1 ? "student" : "students"} enrolled</p></div>
        <button class="primary" type="button" data-edit="post">Share an update</button>
      </section>
      <div class="teacher-actions">${actions.map(([r, symbol, title, description]) => `<a href="${go(r)}">
        <span class="teacher-action-icon" aria-hidden="true">${symbol}</span><div><strong>${title}</strong><small>${description}</small></div><span aria-hidden="true">›</span></a>`).join("")}</div>
      <section class="teacher-panel"><h2>Class roster</h2>
        ${roster.length ? `<ul class="teacher-roster">${roster.map(s => `<li><strong>${esc(s.full_name)}</strong>
          <a href="${go("daily-care")}" data-follow="${esc(s.id)}">Daily care</a>
          <a href="${go("messages")}" data-follow="${esc(s.id)}">Conversation</a></li>`).join("")}</ul>`
        : "<p>No active students are enrolled in this class yet.</p>"}</section>`;
    }
    if (["daily-care", "care-profile", "meal-plan"].includes(route)) return recordForm(route, classroom, student);
    const kind = route === "updates" ? "circulars" : route === "class-calendar" ? "event" : route;
    const result = await api(`/teachers/classes/${classroom.id}/posts?kind=${kind}&page=${page}`);
    const shareLabel = { diary: "Write a diary note", homework: "Add home activity", updates: "Create notice", "class-calendar": "Add event" }[route];
    return `<div class="toolbar"><span class="count">${result.total} published</span><span class="spacer"></span>
      <button type="button" class="primary" data-edit="post">${shareLabel}</button></div>
      <div class="family-feed">${result.posts.map(post => `<article class="family-card">
        <header><span class="family-pill mint">${esc(post.student_name || "Whole class")}</span><time datetime="${esc(post.created_at)}">${esc(stamp(post.created_at))}</time></header>
        <h2>${esc(post.title)}</h2>${post.event_date ? `<p class="support-note">${esc(post.event_date)}</p>` : ""}
        <p class="feed-copy">${esc(post.body)}</p>${post.can_withdraw ? `<footer><button type="button" class="quiet danger" data-withdraw="${esc(post.id)}">Withdraw</button></footer>` : ""}</article>`).join("")
        || empty("updates", "Nothing published for this class yet", "Use the button above to share your first entry.")}</div>${pagination(result)}`;
  }

  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-teacher-day]") && event.target.value) {
      workingDay = event.target.value;
      render();
    }
  });
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!form.matches("[data-teacher-record]")) return;
    event.preventDefault();
    const button = event.submitter;
    const errorField = form.querySelector("[data-teacher-error]");
    const data = Object.fromEntries(new FormData(form));
    data.version = Number(data.version) || null;
    button.disabled = true;
    errorField.textContent = "";
    try {
      const saved = await api(form.dataset.teacherRecord, data, "PUT");
      if (!form.isConnected) return;
      form.elements.version.value = saved.version;
      toast("Saved. Linked families can see the update.");
    } catch (error) {
      if (form.isConnected) errorField.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  return { reset, screen };
}
