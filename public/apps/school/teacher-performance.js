window.createTeacherPerformance = function createTeacherPerformance({ content, api, esc, table, notify }) {
  const endpoint = '/school/teacher-performance';
  const dateLabel = day => new Intl.DateTimeFormat(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(day + 'T12:00:00Z'));
  const classLabel = classroom => classroom ? `${classroom.name} · ${classroom.year_name}` : 'Class unavailable';
  const earlier = day => {
    const date = new Date(day + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() - 29);
    return date.toISOString().slice(0, 10);
  };
  const option = (value, label, chosen) =>
    `<option value="${esc(value)}"${value === chosen ? ' selected' : ''}>${esc(label)}</option>`;
  let state, request = 0;

  function reset() {
    state = null;
    request++;
  }

  function classesFor(form, selected = '') {
    const teacher = state.teachers.find(person => person.id === form.elements.teacher_id.value);
    form.elements.class_id.innerHTML = option('', 'All assigned classes', selected) +
      (teacher?.classes || []).map(room => option(room.id, classLabel(room), selected)).join('');
  }

  async function render(center) {
    const previous = state?.centerId === center?.id ? state?.filters : null;
    reset();
    if (!center) {
      content.innerHTML = '<div class="empty"><h2>Select a center</h2><p>Choose a working center to view its teachers.</p></div>';
      return;
    }
    const version = request;
    content.innerHTML = '<p role="status" data-performance-loading>Loading teachers…</p>';
    const loading = content.querySelector('[data-performance-loading]');
    try {
      const params = new URLSearchParams({ branch_id: center.id });
      const { teachers, today } = await api(`${endpoint}/options?${params}`);
      if (version !== request || !loading.isConnected) return;
      if (!teachers.length) {
        content.innerHTML = '<div class="empty"><h2>No teachers in this center</h2><p>Invite teachers in People and access.</p><a class="button-link" href="#/access">People and access</a></div>';
        return;
      }
      const teacher = teachers.find(person => person.id === previous?.teacher_id) || teachers[0];
      state = { centerId: center.id, teachers, today };
      content.innerHTML = `<form class="card performance-filters" data-performance-filter aria-label="Teacher performance filters">
        <label>Teacher<select name="teacher_id" required>${teachers.map(person =>
          option(person.id, [person.full_name, person.contact].filter(Boolean).join(' · '), teacher.id)).join('')}</select></label>
        <label>Class<select name="class_id"></select></label>
        <label>From<input name="starts_on" type="date" required value="${esc(previous?.starts_on || earlier(today))}"></label>
        <label>To<input name="ends_on" type="date" required value="${esc(previous?.ends_on || today)}"></label>
        <button type="submit" class="primary">Apply filters</button>
        <p class="performance-error error" data-performance-error role="alert" hidden></p>
      </form>
      <div class="performance-report" data-performance-report aria-live="polite"></div>`;
      const form = content.querySelector('[data-performance-filter]');
      classesFor(form, previous?.class_id);
      await loadReport(form);
    } catch (error) {
      if (version === request && loading.isConnected)
        loading.outerHTML = `<div class="error" role="alert">${esc(error.message)}</div>`;
    }
  }

  async function loadReport(form, page = 1) {
    const filters = Object.fromEntries(new FormData(form));
    const errorField = form.querySelector('[data-performance-error]');
    const span = (Date.parse(filters.ends_on) - Date.parse(filters.starts_on)) / 86400000;
    errorField.textContent = span < 0 ? 'End date cannot be before start date.'
      : span > 365 ? 'Choose a date range of up to 366 days.' : '';
    errorField.hidden = !errorField.textContent;
    if (!errorField.hidden) return;
    state.filters = filters;
    const query = new URLSearchParams({ ...filters, branch_id: state.centerId, page });
    if (!filters.class_id) query.delete('class_id');
    const target = content.querySelector('[data-performance-report]');
    const version = ++request;
    target.innerHTML = '<p role="status">Loading teacher activity…</p>';
    try {
      const report = await api(`${endpoint}?${query}`);
      if (version !== request || !target.isConnected) return;
      target.innerHTML = reportScreen(report, filters, page);
    } catch (error) {
      if (version === request && target.isConnected)
        target.innerHTML = `<div class="error" role="alert">${esc(error.message)}</div>`;
    }
  }

  function reportScreen(report, filters, page) {
    const { classes, observations, older_records, total_observations, observation_page_size } = report;
    if (!classes.length) return '<div class="empty"><h2>No classes assigned to this teacher</h2><p>Assign a class to start reviewing classroom activity.</p><a class="button-link" href="#/assignments">Teacher assignments</a></div>';
    const teacher = state.teachers.find(person => person.id === filters.teacher_id);
    const classroomById = new Map(classes.map(room => [room.id, room]));
    const nameCell = room => `${esc(room.name)}<small>${esc(room.year_name)}</small>`;
    const counts = (room, keys) => keys.map(key => esc(room[key]));
    const days = ['days_logged', 'attendance_days', 'care_days'];
    const posts = ['diary', 'homework', 'notice', 'event', 'albums'];
    const lastPage = Math.ceil(total_observations / observation_page_size);
    const observationDate = filters.ends_on < state.today ? filters.ends_on : state.today;
    return `<div class="performance-context"><strong>${esc(teacher?.full_name)}</strong>
      <span>${esc(dateLabel(filters.starts_on))} – ${esc(dateLabel(filters.ends_on))}</span></div>
      <section aria-labelledby="performance-records">
        <div class="section-head"><h2 id="performance-records">Classroom records</h2>
          <p>Distinct school dates with entries saved by this teacher.</p></div>
        ${table(['Class', 'Days logged', 'Attendance days', 'Care days'],
          classes.map(room => [nameCell(room), ...counts(room, days)]))}
        ${older_records ? '<p class="tip performance-tip">Earlier saves are included in Days logged. Attendance and care totals begin when field-level tracking was enabled.</p>' : ''}
      </section>
      <section aria-labelledby="performance-publishing">
        <div class="section-head"><h2 id="performance-publishing">Family communication</h2>
          <p>Items this teacher published in the date range that are still shared with families.</p></div>
        ${table(['Class', 'Diary', 'Home activities', 'Notices', 'Events', 'Photo albums'],
          classes.map(room => [nameCell(room), ...counts(room, posts)]))}
      </section>
      <section class="card performance-observations" aria-labelledby="performance-observations">
        <div class="section-head"><h2 id="performance-observations">Classroom observations</h2><p>Private to school owners</p></div>
        <details class="performance-add">
          <summary>Add observation</summary>
          <form class="form-grid" data-performance-observation>
            <label>Class<select name="class_id" required>
              ${classes.length > 1 ? option('', 'Choose a class', '') : ''}
              ${classes.map(room => option(room.id, classLabel(room), filters.class_id)).join('')}
            </select></label>
            <label>Observation date<input name="observed_on" type="date" required
              value="${esc(observationDate)}" max="${esc(state.today)}"></label>
            <label class="wide">Feedback<textarea name="feedback" rows="3" maxlength="2000" required></textarea></label>
            <label class="wide">Follow-up goal (optional)<textarea name="follow_up" rows="2" maxlength="1000"></textarea></label>
            <p class="wide error" data-observation-error role="alert" hidden></p>
            <div class="wide"><button class="primary" type="submit">Save observation</button></div>
          </form>
        </details>
        ${observations.length ? `<ul class="performance-history">${observations.map(item => `<li>
          <div class="performance-context"><strong>${esc(classLabel(classroomById.get(item.class_id)))}</strong>
            <span><time datetime="${esc(item.observed_on)}">${esc(dateLabel(item.observed_on))}</time> · ${esc(item.author_name)}</span></div>
          <p class="performance-note">${esc(item.feedback)}</p>
          ${item.follow_up ? `<p class="performance-note"><strong>Follow-up goal</strong> · ${esc(item.follow_up)}</p>` : ''}
        </li>`).join('')}</ul>` : '<p class="performance-tip">No observations in this date range.</p>'}
        ${lastPage > 1 ? `<div class="performance-pagination">
          <button type="button" data-observation-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button>
          <span>Page ${page} of ${lastPage}</span>
          <button type="button" data-observation-page="${page + 1}" ${page >= lastPage ? 'disabled' : ''}>Next</button>
        </div>` : ''}
      </section>`;
  }

  content.addEventListener('change', event => {
    const field = event.target;
    if (field.matches('[data-performance-filter] [name=teacher_id]')) {
      classesFor(field.form);
      loadReport(field.form);
    }
  });
  content.addEventListener('click', event => {
    const button = event.target.closest('[data-observation-page]');
    if (button) {
      const form = content.querySelector('[data-performance-filter]');
      for (const [key, value] of Object.entries(state.filters)) form.elements[key].value = value;
      loadReport(form, Number(button.dataset.observationPage));
    }
  });
  content.addEventListener('submit', async event => {
    const form = event.target;
    if (form.matches('[data-performance-filter]')) {
      event.preventDefault();
      await loadReport(form);
      return;
    }
    if (!form.matches('[data-performance-observation]')) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const current = state;
    const { centerId, filters } = current;
    const error = form.querySelector('[data-observation-error]');
    error.hidden = true;
    const button = event.submitter;
    button.disabled = true;
    try {
      await api(`${endpoint}/observations`, { ...data, branch_id: centerId, teacher_id: filters.teacher_id });
      if (!form.isConnected || state !== current) return;
      const filterForm = content.querySelector('[data-performance-filter]');
      for (const [key, value] of Object.entries(filters)) filterForm.elements[key].value = value;
      if (data.observed_on < filters.starts_on || data.observed_on > filters.ends_on) {
        filterForm.elements.starts_on.value = data.observed_on;
        filterForm.elements.ends_on.value = data.observed_on;
      }
      await loadReport(filterForm);
      if (state === current) notify('Observation saved.');
    } catch (failure) {
      if (form.isConnected) {
        error.textContent = failure.message;
        error.hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  });

  return { render, reset };
};
