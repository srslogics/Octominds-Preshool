const symbols = { notice: "📣", event: "🗓️", homework: "🧩", diary: "📖" };
const mark = (symbol) => `<span aria-hidden="true">${symbol}</span>`;

export function renderFamilyFeed({ route, feed, student, preview, acknowledgments, esc, stamp, formatDay, go, pagination, empty }) {
  const dayFormat = { day: "numeric", month: "short" };
  const timeFormat = { hour: "numeric", minute: "2-digit" };
  const dated = (date, format) => new Date(date).toLocaleString(undefined, format);
  const withdraw = (post) => post.can_withdraw
    ? `<button type="button" class="quiet danger" data-withdraw="${esc(post.id)}">Withdraw</button>` : "";
  const body = (post) => `<p class="feed-copy">${esc(post.body)}</p>`;
  const sample = (post) => preview ? post.family_design : null;
  const activityLink = (post) => `<a class="button home-share" href="${go("messages")}" data-home-activity="${esc(post.title)}">${mark("💬")} Share with the school</a>`;

  const diaryCard = (post) => {
    const design = sample(post);
    const time = design?.time || dated(post.created_at, timeFormat);
    if (design?.rows) return `<article class="family-card diary-nutrition">
      <header><h2>${mark("🥦")} ${esc(post.title)}</h2><span class="family-pill mint">${esc(design.status)}</span></header>
      <dl>${design.rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>${withdraw(post)}
    </article>`;
    if (design?.teacherNote) return `<article class="family-card diary-note">
      <h2>${mark("👩‍🏫")} ${esc(post.title)}</h2>${body(post)}${withdraw(post)}
    </article>`;
    return `<article class="family-card diary-entry ${design?.tone || "cream"}">
      <span class="family-entry-icon">${mark(design?.emoji || "📖")}</span>
      <div><header><h2>${esc(post.title)}</h2><time datetime="${esc(post.created_at)}">${esc(time)}</time></header>
      ${body(post)}${withdraw(post)}</div>
    </article>`;
  };

  const learningCard = (post, index) => {
    const design = sample(post);
    if (design?.rhyme) return `<article class="family-card learning-rhyme">
      <header><span class="family-pill plum">Bedtime rhyme</span></header>
      <h2>${mark("🎵")} ${esc(post.title)}</h2>${body(post)}
      <audio controls preload="metadata" aria-label="Play the sample bedtime rhyme" src="/apps/parents/preview-rhyme.mp3"></audio>${withdraw(post)}
    </article>`;
    return `<article class="family-card learning-card ${index === 0 ? "featured" : ""}">
      <header><span class="family-pill mint">${index === 0 ? "Featured activity" : "Home activity"}</span>
        ${design?.duration ? `<span class="feed-meta">${mark("⏱️")} ${esc(design.duration)}</span>` : ""}</header>
      <h2>${mark(design?.emoji || "🧩")} ${esc(post.title)}</h2>${body(post)}
      ${design?.tip ? `<p class="learning-tip">${mark("💡")} <strong>Teacher tip:</strong> ${esc(design.tip)}</p>` : ""}
      ${student.is_active ? activityLink(post) : ""}${withdraw(post)}
    </article>`;
  };

  const updateCard = (post) => {
    const design = sample(post);
    const event = post.kind === "event";
    const acknowledged = design?.urgent && acknowledgments.has(post.id);
    const category = design?.urgent ? "Urgent notice" : event ? "Event circular" :
      ({ homework: "Home learning", diary: "Daily diary" }[post.kind] || "School notice");
    return `<article class="family-card circular-card ${design?.urgent ? "urgent" : ""}">
      <header><span class="family-pill ${design?.urgent ? "rose" : event ? "cream" : "blue"}">${category}</span>
        <time datetime="${esc(post.created_at)}" title="${esc(stamp(post.created_at))}">${esc(dated(post.created_at, dayFormat))}</time></header>
      <h2>${mark(design?.emoji || symbols[post.kind] || "📣")} ${esc(post.title)}</h2>
      ${body(post)}
      ${event && post.event_date ? `<a class="family-text-link" href="${go("calendar")}">View school calendar → <span>${esc(formatDay(post.event_date))}</span></a>` : ""}
      <footer><span>From ${esc(post.author_name)}</span>
        ${design?.urgent && !post.can_withdraw ? `<button type="button" class="button acknowledge ${acknowledged ? "acknowledged" : ""}" data-sample-ack="${esc(post.id)}" ${acknowledged ? "disabled" : ""}>${acknowledged ? "✓ Acknowledged" : "Acknowledge"}</button>` : ""}
        ${withdraw(post)}
      </footer>
    </article>`;
  };

  const renderCard = route === "diary" ? diaryCard : route === "homework" ? learningCard : updateCard;
  const entries = [...feed.posts];
  if (route === "diary") entries.reverse();
  if (route === "updates" && preview) {
    const priority = (post) => sample(post)?.urgent ? 2 : Number(post.kind === "event");
    entries.sort((a, b) => priority(b) - priority(a));
  }
  return `<div class="toolbar family-feed-toolbar"><span class="count">${feed.total} ${feed.total === 1 ? "update" : "updates"} for ${esc(student.full_name)}</span>
    <span class="spacer"></span>${student.can_publish ? '<button type="button" class="primary" data-edit="post">Share an update</button>' : ""}
    <button type="button" data-refresh class="secondary" aria-label="Refresh updates">Refresh</button>
  </div>
  <div class="family-feed">${entries.map(renderCard).join("") || empty(route, "Nothing shared here yet.",
    route === "homework" ? "When your teacher shares an activity, you’ll find it here." : "Updates from your school team will appear here.")}</div>
  ${pagination(feed)}`;
}
