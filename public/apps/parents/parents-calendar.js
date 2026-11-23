const categories = {
  event: ["Events", "School event", "🗓️"],
  celebration: ["Celebrations", "Celebration", "🎉"],
  holiday: ["Holidays", "School holiday", "🏖️"],
  meeting: ["PTM Connect", "PTM Connect", "👥"],
  routine: ["School days", "School day", "🎒"],
};

const decoration = (symbol) => `<span aria-hidden="true">${symbol}</span>`;
const dateLabel = (date, options) => date.toLocaleDateString(undefined, options);
const shiftDay = (date, offset) => {
  const result = new Date(date);
  result.setDate(result.getDate() + offset);
  return result;
};

const calendarText = (value = "") =>
  String(value).replaceAll("\\", "\\\\").replace(/\r\n?|\n/g, "\\n").replace(/[;,]/g, "\\$&")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

const utf8 = new TextEncoder();
function foldLine(line) {
  let result = "";
  let size = 0;
  for (const char of line) {
    const bytes = utf8.encode(char).length;
    if (size + bytes > 75) {
      result += "\r\n ";
      size = 1;
    }
    result += char;
    size += bytes;
  }
  return result;
}

function downloadCalendar(entries, snapshot, reminder, parseDay, isoDate) {
  const dateValue = (value) => value.replaceAll("-", "");
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OctoMinds//School Calendar//EN", "CALSCALE:GREGORIAN"];
  for (const event of entries) {
    const summary = calendarText((snapshot.preview ? "Sample: " : "") + event.title);
    const details = [event.body, event.time, ...(event.checklist || [])].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:${calendarText(event.key)}${snapshot.preview ? "-preview" : ""}@${location.hostname}`,
      `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${dateValue(event.start)}`,
      `DTEND;VALUE=DATE:${dateValue(isoDate(shiftDay(parseDay(event.end), 1)))}`, `SUMMARY:${summary}`);
    if (details) lines.push(`DESCRIPTION:${calendarText(details)}`);
    if (snapshot.center) lines.push(`LOCATION:${calendarText(snapshot.center)}`);
    if (reminder) lines.push("BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", `DESCRIPTION:${summary}`, "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  const file = new Blob([lines.map(foldLine).join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `octominds-${snapshot.preview ? "sample-" : ""}${reminder ? "reminder" : "calendar"}-${snapshot.month.slice(0, 7)}.ics`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createSchoolCalendar({ api, esc, icon, isoDate, parseDay, empty, notify }) {
  let anchor, month, selectedDay, filter, snapshot;

  function reset() {
    anchor = isoDate(new Date());
    month = `${anchor.slice(0, 7)}-01`;
    selectedDay = "";
    filter = "all";
    snapshot = null;
  }
  reset();

  function normalize(result, preview) {
    const events = result.events.map((event) => ({
      key: `event-${event.id}`, title: event.title, body: event.body,
      start: event.event_date, end: event.event_date,
      kind: preview && ["celebration", "meeting", "routine"].includes(event.category) ? event.category : "event",
      time: preview ? event.time : "",
      checklist: preview ? event.checklist : null,
    }));
    const holidays = result.holidays.map((holiday) => ({
      key: `holiday-${holiday.id}`, title: holiday.name, body: holiday.body,
      start: holiday.starts_on, end: holiday.ends_on || holiday.starts_on, kind: "holiday",
    }));
    return [...events, ...holidays].sort((a, b) => a.start.localeCompare(b.start));
  }

  function featuredCard(event, center, today) {
    const date = parseDay(event.start);
    const days = Math.round((date - parseDay(today)) / 86400000);
    const when = days === 0 ? "Today" : days === 1 ? "Tomorrow" : `In ${days} days`;
    return `<section id="calendarFeatured" class="today-hero calendar-featured" aria-labelledby="calendarFeaturedTitle" tabindex="-1">
      <div class="today-hero-intro">
        <div><span class="calendar-feature-label">${decoration("⏳")} ${when} · ${esc(dateLabel(date, { weekday: "long" }))}</span>
          <h2 id="calendarFeaturedTitle">${esc(event.title)}</h2>
          ${event.body ? `<p>${esc(event.body)}</p>` : ""}
        </div>
        <div class="today-hero-art" aria-hidden="true">
          <div class="today-mascot"><img src="/assets/octominds-logo-horizontal.png" alt="" width="1437" height="540"></div>
        </div>
      </div>
      ${event.checklist?.length ? `<div class="calendar-prep"><h3>Parent prep checklist</h3><ul>${
        event.checklist.map(step => `<li>${esc(step)}</li>`).join("")
      }</ul></div>` : ""}
      <div class="calendar-feature-footer">
        <span>${decoration("📍")} ${esc(center)}</span>
        <button type="button" class="calendar-reminder" data-school-calendar="${days ? "reminder" : "save-event"}">${days ? `${decoration("🔔")} Add 1-day reminder` : "Add to calendar"}</button>
      </div>
    </section>`;
  }

  function agendaCard(event, isFeatured, today, firstOfMonth) {
    const [, label] = categories[event.kind];
    const shownDate = event.start < firstOfMonth ? firstOfMonth : event.start;
    const date = parseDay(shownDate);
    const end = event.end > shownDate ? `Through ${dateLabel(parseDay(event.end), { month: "short", day: "numeric" })}` : "";
    return `<li class="calendar-agenda-card calendar-${event.kind}${isFeatured ? " featured" : ""}">
      <time class="calendar-date-tile" datetime="${shownDate}">
        <span>${esc(dateLabel(date, { month: "short" }))}</span><strong>${date.getDate()}</strong><span>${esc(dateLabel(date, { weekday: "short" }))}</span>
      </time>
      <div class="calendar-agenda-copy">
        <div class="calendar-agenda-heading"><h3>${esc(event.title)}</h3>
          <span class="calendar-category">${event.kind === "routine" && event.start === today ? "Today" : label}</span>
        </div>
        ${event.body ? `<p>${esc(event.body)}</p>` : ""}
        ${event.time || end ? `<p class="calendar-event-time">${esc(event.time || end)}</p>` : ""}
        ${isFeatured ? '<a class="calendar-feature-link" href="#calendarFeatured" data-school-calendar="details">View details →</a>' : ""}
      </div>
    </li>`;
  }

  async function screen(student, preview, current) {
    const today = isoDate(new Date());
    const viewedMonth = month;
    if (!snapshot || snapshot.student !== student.id || snapshot.month !== viewedMonth || snapshot.preview !== preview) {
      const result = await api(`/children/${student.id}/calendar?month=${viewedMonth}&include_next_month=true`);
      if (!current()) return { html: "", canExport: false };
      snapshot = { student: student.id, month: viewedMonth, preview, center: student.center_name,
        entries: normalize(result, preview) };
    }
    const { entries } = snapshot;
    const feature = entries.find(event => event.start >= today && ["event", "celebration", "meeting"].includes(event.kind));
    snapshot.feature = feature;
    const types = preview ? ["celebration", "holiday", "meeting"] : ["event", "holiday"];
    if (preview && entries.some(event => event.kind === "event")) types.unshift("event");
    if (filter !== "all" && !types.includes(filter)) filter = "all";
    const inFilter = entries.filter(event => filter === "all" || event.kind === filter);
    const onDay = (date) => entries.filter(event => event.start <= date && event.end >= date);
    const shown = selectedDay ? inFilter.filter(event => event.start <= selectedDay && event.end >= selectedDay) : inFilter;
    const focusDate = parseDay(anchor);
    const weekStart = shiftDay(focusDate, -focusDate.getDay());
    const monthName = dateLabel(parseDay(viewedMonth), { month: "long", year: "numeric" });
    const nextMonth = parseDay(viewedMonth);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const weekLabel = Math.ceil((focusDate.getDate() + parseDay(viewedMonth).getDay()) / 7);
    const count = (kind) => entries.filter(event => event.kind === kind).length;
    const arrow = (control, offset, label) => `<button type="button" class="calendar-arrow" data-school-calendar="${control}" data-value="${offset}" aria-label="${label}">${icon(offset < 0 ? "back" : "next")}</button>`;
    return { html: `<div class="school-calendar">
      ${feature ? featuredCard(feature, snapshot.center, today) : ""}
      <section class="calendar-week" aria-labelledby="calendarMonth">
        <div class="calendar-month-heading">
          <h2 id="calendarMonth">${decoration("📅")} ${esc(monthName)}</h2>
          <div>${arrow("month", -1, "Previous month")}${arrow("month", 1, "Next month")}</div>
        </div>
        <div class="calendar-week-controls">
          <span>Week ${weekLabel}</span>
          <div>${arrow("week", -1, "Previous week")}${arrow("week", 1, "Next week")}</div>
        </div>
        <div class="calendar-week-strip" aria-label="Days of the week">${Array.from({ length: 7 }, (_, index) => {
          const date = shiftDay(weekStart, index);
          const value = isoDate(date);
          const events = onDay(value);
          const tone = value === today ? "is-today" : events.length ? `calendar-${events[0].kind}` : "";
          return `<button type="button" data-school-calendar="date" data-value="${value}" class="calendar-week-day ${tone}"
            aria-label="${esc(dateLabel(date, { weekday: "long", month: "long", day: "numeric" }))}${events.length ? `, ${events.length} ${events.length === 1 ? "entry" : "entries"}` : ""}"
            aria-pressed="${selectedDay === value}" ${value === today ? 'aria-current="date"' : ""}>
            <span>${value === today ? "Today" : esc(dateLabel(date, { weekday: "short" }))}</span><strong>${date.getDate()}</strong>
          </button>`;
        }).join("")}</div>
      </section>
      <section class="calendar-agenda" aria-labelledby="calendarAgenda">
        <div class="calendar-agenda-filters" role="group" aria-label="Filter calendar items">
          ${["all", ...types].map(kind => `<button type="button" class="calendar-filter" data-school-calendar="filter" data-value="${kind}" aria-pressed="${filter === kind}">${kind === "all" ? `All (${entries.length})` : `${decoration(categories[kind][2])} ${categories[kind][0]}`}</button>`).join("")}
        </div>
        <div class="calendar-agenda-title"><h2 id="calendarAgenda">${selectedDay ? esc(dateLabel(parseDay(selectedDay), { weekday: "long", month: "long", day: "numeric" })) : "Agenda"}</h2>
          ${selectedDay ? '<button type="button" class="quiet" data-school-calendar="clear-day">Show all dates</button>'
            : `<span>Through ${esc(dateLabel(nextMonth, { month: "long" }))}</span>`}
        </div>
        ${shown.length ? `<ul class="calendar-agenda-list">${shown.map(event => agendaCard(event, feature === event, today, viewedMonth)).join("")}</ul>`
          : empty("calendar", selectedDay ? "No entries for this day" : "No calendar entries", "Try a different date or filter.")}
      </section>
      ${entries.length ? `<dl class="calendar-summary">${types.map(kind => `<div><dt>${categories[kind][0]}</dt><dd>${count(kind)}</dd></div>`).join("")}</dl>` : ""}
    </div>`, canExport: Boolean(entries.length) };
  }

  function handle(action, value) {
    if (action === "export" || action === "reminder" || action === "save-event") {
      const entries = action === "export" ? snapshot?.entries : [snapshot?.feature].filter(Boolean);
      if (entries?.length) {
        downloadCalendar(entries, snapshot, action === "reminder", parseDay, isoDate);
        notify(action === "reminder" ? "Open the calendar file to add the event with its reminder." : "Open the downloaded file in your calendar app.");
      }
      return false;
    }
    if (action === "details") {
      const feature = document.querySelector("#calendarFeatured");
      feature?.focus();
      feature?.scrollIntoView({ block: "start" });
      return false;
    }
    if (action === "filter") filter = value;
    if (action === "clear-day") selectedDay = "";
    if (action === "date") {
      anchor = value;
      selectedDay = selectedDay === value ? "" : value;
    }
    if (action === "week") {
      anchor = isoDate(shiftDay(parseDay(anchor), Number(value) * 7));
      selectedDay = "";
    }
    if (action === "month") {
      const date = parseDay(month);
      date.setMonth(date.getMonth() + Number(value));
      const today = isoDate(new Date());
      anchor = today.startsWith(isoDate(date).slice(0, 7)) ? today : isoDate(date);
      selectedDay = "";
    }
    month = `${anchor.slice(0, 7)}-01`;
    return true;
  }

  return { screen, handle, reset };
}
