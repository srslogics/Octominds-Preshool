(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const cfg = window.OCTOMINDS_CONFIG || {};
  const sessions = window.OctomindsSession;
  const INVITE = 'octominds.school.invitation';
  const INVITE_METHOD = 'octominds.school.invitation.method';
  const mobileInvite = () => sessionStorage.getItem(INVITE_METHOD) === 'mobile' && Boolean(sessionStorage.getItem(INVITE));
  const contact = person => person?.phone || person?.email || '';
  const authDescription = 'Sign in with your email and password or your mobile number and PIN.';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {super_admin:'Owner',management:'Management',branch_admin:'Center administrator',teacher:'Teacher',accountant:'Accountant',admission_counsellor:'Admissions counsellor',parent:'Parent or guardian'};
  let emailCode, session, user, data, access, selected='', editing=null, generation=0, loading=false, noticeTimer;
  let authEpoch = 0, refreshing;
  let accessSection = 'members';
  let accessRequest = null, accessError = null;
  const pages = {
    overview:['Overview','See what’s in place and what your center needs next.'],
    school:['School profile','Maintain the identity and contact details shared by your centers.'],
    centers:['Centers','Manage locations, working days, operating hours, and capacity.'],
    years:['Academic years','Prepare the next year and preserve closed years as history.'],
    terms:['Terms','Organize the selected center’s academic years into terms.'],
    programs:['Programs','Define Playgroup, Nursery, KG, and other programs at this center.'],
    classes:['Classes and sections','Set up classrooms for a program and academic year.'],
    assignments:['Teacher assignments','Assign teachers and time-limited substitute coverage.'],
    holidays:['Holidays','Maintain the center’s calendar of closures.'],
    access:['People and access','Invite people, assign roles, and review account access.'],
    account:['My account','Review your access and manage your sign-in.']
  };
  const navigation = {
    'Workspace': ['overview'],
    'School setup': ['school', 'centers', 'years'],
    'Learning': ['programs', 'classes', 'terms', 'assignments', 'holidays'],
    'Accounts': ['access', 'account'],
  };
  const recordNames = {school:'school profile',centers:'center',years:'academic year',terms:'term',
    programs:'program',classes:'class',assignments:'teacher assignment',holidays:'holiday'};
  const route=()=>location.hash.replace(/^#\/?/,'')||'overview';
  const globalAdmin=()=>['super_admin','management'].includes(user?.role);
  const administrator=()=>globalAdmin()||user?.role==='branch_admin';
  const needsAccess=page=>administrator()&&['access','assignments'].includes(page);
  const workingCenter=()=>data?.centers.find(center => center.id === selected);
  const canManage=branch=>globalAdmin()||data?.memberships?.some(m=>m.role==='branch_admin'&&m.branch_id===branch&&m.is_active&&(!m.expires_at||Date.parse(m.expires_at)>Date.now()));
  const className = classroom => [classroom.name, classroom.section].filter(Boolean).join(' ');
  const canEnroll = classroom => classroom?.is_active && classroom.branch_id === selected &&
    workingCenter()?.is_active && canManage(classroom.branch_id) &&
    data.years.some(year => year.id === classroom.academic_year_id && year.status !== 'closed');
  const rows=kind=>(data?.[kind]||[]).filter(r=>!r.branch_id||r.branch_id===selected);
  const findName=(kind,id)=>(data?.[kind]||[]).find(r=>r.id===id)?.name||'Unavailable';
  const fullName=id=>access?.users.find(r=>r.id===id)?.full_name|| (id===user?.id ? user.full_name : 'Assigned teacher');
  const notify=message=>{clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').hidden=false;noticeTimer=setTimeout(()=>$('#notice').hidden=true,6500);};
  function forgetInvitation() {
    sessionStorage.removeItem(INVITE);
    sessionStorage.removeItem(INVITE_METHOD);
  }
  function showInvitationControls(existingPin = false) {
    const invited = Boolean(sessionStorage.getItem(INVITE));
    const mobile = mobileInvite();
    const settingPin = mobile && !existingPin;
    $('#mobileSignupForm').hidden = !settingPin;
    $('#signInForm').hidden = settingPin;
    $('.auth-actions').hidden = mobile;
    $('#createAccount').hidden = !invited || mobile;
    $('#useExistingPin').hidden = !settingPin;
    $('#useNewPin').hidden = !mobile || !existingPin;
    $('#dismissInvitation').hidden = !invited;
    $('#authTitle').textContent = settingPin ? 'Set up your parent account' : 'Welcome back';
    $('#authDescription').textContent = mobile
      ? (settingPin ? 'Enter the mobile number your school invited and choose a six-digit PIN.'
        : 'Sign in with the invited mobile number and your existing PIN to accept.')
      : invited
      ? 'Enter the email address on your invitation. If this is your first visit, choose Create invited account.'
      : authDescription;
  }
  function resetAuth(){ $('#resetForm').hidden=true; $('#resetForm').reset(); $('#mobileSignupForm').reset(); $('#password').value=''; showInvitationControls(); }
  function setMenu(open) {
    $('#schoolSidebar').toggleAttribute('data-open', open);
    $('#navToggle').setAttribute('aria-expanded', String(open));
  }
  function clearSession(){
    authEpoch++;generation++;sessions.clear(session);
    session=null;refreshing=null;user=null;data=null;access=null;selected='';accessSection='members';
    editing=null;accessRequest=null;accessError=null;loading=false;
    resetAuth();$('#signInForm').reset();setMenu(false);
    $('#workspace').hidden=true;$('#auth').hidden=false;$('#content').replaceChildren();
    document.querySelectorAll('dialog[open]').forEach(d=>d.close());
  }
  async function auth(path,body,method='POST',token=session?.access_token){
    const response=await fetch(`${cfg.apiBaseUrl||location.origin}/api/v1/auth${path}`,{method,keepalive:path.startsWith('/logout'),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){const detail=typeof result.detail==='string'?result.detail:null;const error=Error(detail||result.msg||result.message||result.error_description||'Unable to complete sign-in');error.status=response.status;throw error;}
    return result;
  }
  const revokeSession = (token, scope) => auth(`/logout?scope=${scope}`, null, 'POST', token);
  async function refresh(){
    if(refreshing)return refreshing;
    const old=session, version=authEpoch;
    const task=(async()=>{
      try{
        const next=await sessions.refresh(old,()=>version===authEpoch&&session===old,
          refresh_token=>auth('/token?grant_type=refresh_token',{refresh_token}),revokeSession);
        if(version===authEpoch&&session===old) session=next;
      }catch(error){
        if(version===authEpoch&&[400,401,403].includes(error.status)) expireSession();
        throw error;
      }
    })();
    refreshing=task;
    try{await task;}finally{if(refreshing===task)refreshing=null;}
  }
  function expireSession(){
    clearSession();
    $('#authMessage').textContent='Your session expired. Please sign in again.';
  }
  async function api(path,body,retry=true){
    if(!session?.access_token)throw Error('Please sign in');
    const version=authEpoch;
    if(retry&&session.expires_at&&session.expires_at*1000<Date.now()+30000)await refresh();
    if(version!==authEpoch)throw Error('Your session changed.');
    const token=session.access_token;
    const response=await fetch(`${cfg.apiBaseUrl||location.origin}/api/v1${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(version!==authEpoch)throw Error('Your session changed.');
    if(response.status===401&&retry){
      if(session.access_token===token)await refresh();
      if(version!==authEpoch)throw Error('Your session changed.');
      return api(path,body,false);
    }
    const result=await response.json().catch(()=>({}));
    if(version!==authEpoch)throw Error('Your session changed.');
    if(!response.ok){
      if(response.status===401&&session.access_token===token)expireSession();
      const error=Error(typeof result.detail==='string'?result.detail:'The request could not be completed. Please retry.');
      error.status=response.status;throw error;
    }
    return result;
  }
  async function enter(){
    const version=authEpoch;
    const invitation=sessionStorage.getItem(INVITE);
    if(invitation){
      const mobile = mobileInvite();
      await api('/school/accept-invitation',{token:invitation});
      if(version!==authEpoch)return;
      forgetInvitation();
      if (mobile) {
        location.replace('/parents');
        return;
      }
      showInvitationControls();
      notify('Invitation accepted. Welcome to your school.');
    }
    await load();
  }
  function showWorkspace(account) {
    user=account;$('#userName').textContent=user.full_name;$('#userRole').textContent=labels[user.role]||user.role;
    $('#userInitials').textContent = (user.full_name || '').trim().split(/\s+/).slice(0, 2).map(name => name[0]).join('').toUpperCase();
    $('#auth').hidden=true;$('#workspace').hidden=false;
    $('#inventoryLink').hidden=!['super_admin','management','branch_admin','accountant'].includes(user.role);
  }
  function loadAccess(){
    if(accessRequest) return;
    const version=generation;
    accessRequest=api('/school/access').then(directory=>{
      if(version===generation) access=directory;
    }).catch(error=>{
      if(version===generation) accessError=error;
    }).finally(()=>{
      if(version!==generation) return;
      accessRequest=null;
      if(needsAccess(route())) render();
    });
  }
  async function load(){
    const version=++generation;loading=true;$('#content').innerHTML='<p role="status">Loading your school workspace…</p>';$('#toolbar').replaceChildren();
    access=null;accessRequest=null;accessError=null;
    try{
      const params=new URLSearchParams({include_account:'true'});
      if(['access','assignments'].includes(route())) params.set('include_directory','true');
      const fresh=await api(`/school/workspace?${params}`);
      if(version!==generation||!session)return;
      data=fresh;
      access=fresh.directory || null;
      showWorkspace(fresh.account);
      if(!data.centers.some(c=>c.id===selected))selected=user.branch_id||data.centers.find(c=>c.is_active)?.id||data.centers[0]?.id||'';
      $('#centerSelect').innerHTML=data.centers.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}${c.is_active?'':' (archived)'}</option>`).join('')||'<option value="">No centers yet</option>';
      $('#centerSelect').value=selected;
      $('#centerSelect').disabled = !data.centers.length;
      loading=false;render();
    }catch(error){
      if(version!==generation)return;
      loading=false;
      if(!user) throw error;
      $('#content').innerHTML=`<div class="error" role="alert">${esc(error.message)}</div><button data-action="reload">Try again</button>`;
    }
  }
  const button=(text,action,id='',cls='')=>`<button type="button" class="${cls}" data-action="${action}" data-id="${esc(id)}">${text}</button>`;
  const state=v=>`<span class="pill ${esc(v)}">${esc(v)}</span>`;
  function table(headers, records) {
    const head = headers.map(title => `<th role="columnheader" scope="col">${esc(title)}</th>`).join('');
    const body = records.map(cells => `<tr role="row">${cells.map((cell, index) =>
      `<td role="cell"><span class="cell-label" aria-hidden="true">${esc(headers[index])}</span><div>${cell}</div></td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table role="table"><thead role="rowgroup"><tr role="row">${head}</tr></thead><tbody role="rowgroup">${body}</tbody></table></div>`;
  }
  const empty=(title,copy,link='')=>`<div class="empty"><h2>${title}</h2><p>${copy}</p>${link}</div>`;
  const linkTo=(label,page)=>`<a class="button-link" href="#/${page}">${label}</a>`;
  function renderNavigation(page) {
    $('#navigation').innerHTML = Object.entries(navigation).map(([heading, routes]) => {
      const links = routes.filter(key => key !== 'access' || administrator()).map(key =>
        `<a href="#/${key}" ${key === page ? 'aria-current="page"' : ''}>${pages[key][0]}</a>`).join('');
      return `<div class="nav-group"><p class="nav-heading">${heading}</p>${links}</div>`;
    }).join('');
  }
  function renderOverview() {
    const counts = [
      ['Centers', 'centers', data.centers.filter(center => center.is_active).length],
      ['Academic years', 'years', options('years').length],
      ['Programs', 'programs', options('programs').length],
      ['Classes', 'classes', options('classes').length],
    ];
    const metrics = counts.map(([title, path, count]) =>
      `<a class="metric-card" href="#/${path}"><span class="metric-label">${title}<span aria-hidden="true">↗</span></span><strong class="metric">${count}</strong></a>`).join('');
    const steps = [
      ['Create a center', 'centers', Boolean(workingCenter()?.is_active)],
      ['Add an academic year', 'years', Boolean(counts[1][2])],
      ['Add a program', 'programs', Boolean(counts[2][2])],
      ['Create a class', 'classes', Boolean(counts[3][2])],
    ];
    const complete = steps.filter(([, , done]) => done).length;
    const setup = administrator() ? `
      <section class="card setup-card">
        <div class="section-head"><h2>Center setup</h2><p>${complete} of ${steps.length} complete</p></div>
        <progress class="setup-progress" aria-label="Center setup progress" value="${complete}" max="${steps.length}"></progress>
        <ul class="setup-list">${steps.map(([title, path, done]) => `<li><a href="#/${path}">${title}<span class="setup-status ${done ? 'complete' : ''}">${done ? 'Complete' : 'Open →'}</span></a></li>`).join('')}</ul>
      </section>` : '';
    const shortcuts = [
      ...(administrator() ? [['Invite staff or parents', '#/access']] : []),
      ['View classes', '#/classes'],
      ['View school holidays', '#/holidays'],
      ['Open the family portal', '/parents'],
    ];
    $('#content').innerHTML = `
      <div class="cards">${metrics}</div>
      <div class="overview-grid">${setup}
        <section class="card"><div class="section-head"><h2>Quick actions</h2></div>
          <ul class="quick-links">${shortcuts.map(([title, href]) => `<li><a href="${href}">${title}<span aria-hidden="true">↗</span></a></li>`).join('')}</ul>
        </section>
      </div>`;
  }
  function render(){
    if(!user||!data||loading)return;
    const page=route(), info=pages[page];
    renderNavigation(page);
    $('#pageTitle').textContent=info?.[0]||'Page not found';$('#pageDescription').textContent=info?.[1]||'Choose a destination from the navigation.';
    document.title=`${info?.[0]||'School'} · OctoMinds`;
    $('#toolbar').innerHTML=button('Refresh','reload');
    if(needsAccess(page)&&!access){
      $('#content').innerHTML=accessError
        ? `<div class="error" role="alert">${esc(accessError.message)}</div>`
        : '<p role="status">Loading people and access…</p>';
      if(!accessError) loadAccess();
      return;
    }
    if(!info){$('#content').innerHTML='<a href="#/overview">Return to overview</a>';return;}
    if(page==='overview'){renderOverview();return;}
    if(page==='school'){
      const row=data.school[0];if(globalAdmin())$('#toolbar').insertAdjacentHTML('afterbegin',button(row?'Edit school profile':'Add school profile','edit',row?.id||'','primary'));
      $('#content').innerHTML=row?`<section class="card"><h2>${esc(row.name)}</h2><dl>${['email','phone','address','website'].map(k=>`<dt>${k[0].toUpperCase()+k.slice(1)}</dt><dd>${esc(row[k]||'Not set')}</dd>`).join('')}</dl></section>`:empty('Your school profile','Management can add the school name and contact details here.');return;
    }
    if(page==='account'){
      const legacy=user.email?.endsWith('@auth.octominds.invalid');
      $('#content').innerHTML=`<section class="card"><h2>${esc(user.full_name)}</h2><p>${esc(legacy?'Mobile and PIN account':user.email)}</p><h3>Assigned access</h3><ul>${data.memberships.map(m=>`<li>${esc(labels[m.role])} · ${esc(m.branch_id?findName('centers',m.branch_id):'All centers')}${m.expires_at?` · expires ${esc(new Date(m.expires_at).toLocaleDateString())}`:''}</li>`).join('')}</ul><div class="account-buttons">${button(legacy?'Change PIN':'Change password','password')}${button('Sign out on all devices','logout-all')}</div><p class="tip">${legacy?'For a forgotten PIN, contact an authorized administrator.':'Use Forgot password on the sign-in screen for email recovery.'}</p></section>`;return;
    }
    if(page==='access'){renderAccess();return;}
    const writable=page==='centers'?globalAdmin():Boolean(workingCenter()?.is_active && canManage(selected));
    if(!selected&&page!=='centers'){$('#content').innerHTML=empty('Set up a center first','School records are organized by center.',globalAdmin()?linkTo('Go to Centers','centers'):'');return;}
    const prerequisite = writable && recordPrerequisite(page);
    if(writable && !prerequisite)$('#toolbar').insertAdjacentHTML('afterbegin',button(`Add ${recordNames[page]}`,'edit','','primary'));
    const records=page==='centers'?data.centers:rows(page);
    const setupNotice = prerequisite ? `<p class="setup-alert">${prerequisite}</p>` : '';
    if(!records.length){$('#content').innerHTML=setupNotice+empty('No records yet',writable&&!prerequisite?'Use the add button to create the first record.':'Records will appear here once they’re added.');return;}
    const columns={centers:['Center','Contact','Hours','Status','Actions'],years:['Academic year','Dates','Status','Actions'],terms:['Term','Academic year','Dates','Actions'],programs:['Program','Description','Status','Actions'],classes:['Class','Program and year','Room and capacity','Status','Actions'],assignments:['Teacher','Class','Dates','Status','Actions'],holidays:['Holiday','Dates','Status','Actions']}[page];
    const dateRange=r=>`${esc(r.starts_on)} → ${esc(r.ends_on||'No end date')}`;
    const body=records.map(r=>{
      let cells;
      if(page==='centers')cells=[`${esc(r.name)}<small>${esc(r.code)} · ${esc(r.timezone)}</small>`,esc(r.email||r.phone||'Not set'),`${esc(r.opens_at?.slice(0,5)||'—')} – ${esc(r.closes_at?.slice(0,5)||'—')}`,state(r.is_active?'active':'inactive')];
      if(page==='years')cells=[esc(r.name),dateRange(r),state(r.status)];
      if(page==='terms')cells=[esc(r.name),esc(findName('years',r.academic_year_id)),dateRange(r)];
      if(page==='programs')cells=[esc(r.name),esc(r.description||'—'),state(r.is_active?'active':'inactive')];
      if(page==='classes')cells=[esc(className(r)),`${esc(findName('programs',r.program_id))}<small>${esc(findName('years',r.academic_year_id))}</small>`,`${esc(r.room||'Not set')}<small>Capacity ${esc(r.capacity)}</small>`,state(r.is_active?'active':'inactive')];
      if(page==='assignments')cells=[esc(fullName(r.user_id)),esc(findName('classes',r.class_id)),dateRange(r),state(assignmentStatus(r))];
      if(page==='holidays')cells=[esc(r.name),dateRange(r),state(r.is_active?'active':'inactive')];
      const yearId=r.academic_year_id||(page==='assignments'?data.classes.find(c=>c.id===r.class_id)?.academic_year_id:null);
      const closed=r.status==='closed'||data.years.some(y=>y.id===yearId&&y.status==='closed');
      const editable=canManage(page==='centers'?r.id:r.branch_id)&&!closed&&(page==='centers'||workingCenter()?.is_active);
      const edit = editable ? button('Edit','edit',r.id) : '<span class="tip">Read only</span>';
      cells.push(page==='classes' && canEnroll(r)
        ? `<div class="class-actions">${button('Add student','add-student',r.id,'primary')}${edit}</div>`
        : edit);
      return cells;
    });$('#content').innerHTML=setupNotice+table(columns,body);
  }
  function renderAccess(){
    if(!administrator()||!access){$('#content').innerHTML=empty('Restricted workspace','Account administration is available to authorized administrators.');return;}
    const activeCenter = workingCenter()?.is_active;
    if (activeCenter || user.role === 'super_admin') {
      const canAssign = access.users.some(account => account.is_active && account.id !== user.id);
      $('#toolbar').insertAdjacentHTML('afterbegin', button('Invite a person','invite','','primary') +
        (canAssign ? button('Assign existing account','grant') : ''));
    }
    const sections = {members: 'Members', invitations: 'Invitations', history: 'Activity'};
    if (user.role === 'super_admin') sections.accounts = 'Account status';
    const tabs = Object.entries(sections).map(([key,title]) =>
      `<button type="button" data-action="access-section" data-id="${key}" aria-controls="accessPanel" aria-pressed="${key===accessSection}">${title}</button>`).join('');
    const message = activeCenter ? '' : '<p class="setup-alert">Parent and staff invitations need an active working center. <a href="#/centers">Go to Centers</a> to set one up, or select an active center above.</p>';
    $('#content').innerHTML = `${message}<div class="access-switch" role="group" aria-label="People and access views">${tabs}</div><section id="accessPanel" class="access-panel" aria-label="${sections[accessSection]}">${accessTable()}</section>`;
  }
  function accessTable() {
    const inScope = row => !selected || row.branch_id === selected || !row.branch_id;
    if (accessSection === 'members') {
      const body = access.memberships.filter(inScope).map(m=>[
        `${esc(fullName(m.user_id))}<small>${esc(contact(access.users.find(u=>u.id===m.user_id)))}</small>`,
        `${esc(labels[m.role])}<small>${esc(m.branch_id?findName('centers',m.branch_id):'All centers')}</small>`,
        `${state(!m.is_active?'revoked':m.expires_at&&Date.parse(m.expires_at)<=Date.now()?'expired':'active')}<small>${esc(m.expires_at?new Date(m.expires_at).toLocaleString():'No expiry')}</small>`,
        m.is_active&&m.user_id!==user.id&&mayGrant(m.role)?button('Revoke','revoke',m.id):'',
      ]);
      return body.length ? table(['Person','Access','Status','Actions'],body) : empty('No members yet','Invite a person to give them access.');
    }
    if (accessSection === 'invitations') {
      const body=access.invitations.filter(inScope).map(i=>[
        `${esc(i.full_name)}<small>${esc(contact(i))}</small>${i.student_name ? `<small>Student: ${esc(i.student_name)}</small>` : ''}`,
        esc(labels[i.role]),
        state(i.accepted_at?'accepted':i.revoked_at?'revoked':Date.parse(i.expires_at)<Date.now()?'expired':'pending'),
        !i.accepted_at&&!i.revoked_at&&mayGrant(i.role)?button('Revoke invitation','revoke_invite',i.id):'',
      ]);
      return body.length ? table(['Recipient','Role','Status','Actions'],body) : empty('No invitations yet','New and accepted invitations will appear here.');
    }
    if (accessSection === 'accounts') {
      return table(['Person','Status','Actions'],access.users.map(u=>[
        esc(u.full_name), state(u.is_active?'active':'inactive'),
        u.id!==user.id?button(u.is_active?'Suspend account':'Reactivate account','status',u.id):'Your account',
      ]));
    }
    const activity = access.audit.filter(inScope).map(a=>[
      esc(new Date(a.occurred_at).toLocaleString()),
      esc(a.event_type.replace('school.','').replaceAll('_',' ')),
      esc(a.entity_type),
    ]);
    return activity.length ? table(['When','Action','Record'],activity) : empty('No recent activity','Record changes and access updates will appear here.');
  }
  const text=(key,label,type='text',required=true)=>({key,label,type,required});
  const select=(key,label,options,placeholder='')=>({key,label,type:'select',options,required:true,placeholder});
  const signInMethods = [['mobile','Mobile number'],['email','Email address']];
  const enrollmentOptions = () => rows('students').map(student => {
    const classroom = data.classes.find(record => record.id === student.class_id);
    return [student.id, [student.full_name, classroom && className(classroom), student.guardian?.full_name].filter(Boolean).join(' · ')];
  });
  const options=kind=>rows(kind).filter(r=>r.status!=='closed'&&r.is_active!==false&&(kind!=='classes'||!data.years.some(y=>y.id===r.academic_year_id&&y.status==='closed'))).map(r=>[r.id,r.name]);
  const mayGrant=role=>user.role==='super_admin'||(globalAdmin()&&!['super_admin','management'].includes(role))||(!globalAdmin()&&['teacher','parent','accountant','admission_counsellor'].includes(role));
  const teachers = () => (access?.users || []).filter(account => account.is_active && access.memberships.some(m =>
    m.user_id===account.id && m.role==='teacher' && m.branch_id===selected && m.is_active &&
    (!m.expires_at || Date.parse(m.expires_at)>Date.now()))).map(account => [account.id,account.full_name]);
  function recordPrerequisite(page) {
    if (['classes','terms'].includes(page) && !options('years').length) {
      return 'Add an <a href="#/years">academic year</a> first.';
    }
    if (page==='classes' && !options('programs').length) return 'Add a <a href="#/programs">program</a> before creating a class.';
    if (page==='assignments' && !options('classes').length) return 'Add a <a href="#/classes">class</a> before assigning a teacher.';
    if (page==='assignments' && !teachers().length) return 'Invite a teacher from <a href="#/access">People and access</a>. They can be assigned after accepting.';
    return '';
  }
  function assignmentStatus(assignment) {
    if (!assignment.is_active) return 'inactive';
    const today = new Date().toLocaleDateString('en-CA',{timeZone:workingCenter()?.timezone});
    if (assignment.starts_on > today) return 'scheduled';
    if (assignment.ends_on && assignment.ends_on < today) return 'expired';
    return 'assigned';
  }
  function definition(kind){
    const active=[['true','Active'],['false','Archived']];
    const dates=[text('starts_on','Start date','date'),text('ends_on','End date','date')];
    const roles=Object.entries(labels).filter(([role]) => mayGrant(role) && (workingCenter()?.is_active || ['super_admin','management'].includes(role)));
    const familyFields = [
      {...select('student_id','Student',enrollmentOptions(),'Choose a student (optional)'),required:false},
      text('relationship','Relationship','text',false),
    ];
    const fields={
      school:[text('name','School name'),text('email','Contact email','email',false),text('phone','Phone','tel',false),text('address','Address','textarea',false),text('website','Website','url',false)],
      centers:[text('name','Center name'),text('code','Center code'),text('email','Contact email','email',false),text('phone','Phone','tel',false),text('address','Address','textarea',false),text('timezone','Timezone'),text('opens_at','Opens at','time',false),text('closes_at','Closes at','time',false),{key:'working_days',label:'Working days',type:'days'},text('capacity','Center capacity','number',false),...(globalAdmin()?[select('is_active','Status',active)]:[])],
      years:[text('name','Academic year name'),...dates,select('status','Status',[['planned','Planned'],['active','Active'],['closed','Closed and read only']])],
      terms:[text('name','Term name'),select('academic_year_id','Academic year',options('years')),...dates],
      programs:[text('name','Program name'),text('description','Description','textarea',false),select('is_active','Status',active)],
      classes:[text('name','Class name'),text('section','Section','text',false),select('academic_year_id','Academic year',options('years')),select('program_id','Program',options('programs')),text('room','Room','text',false),text('capacity','Capacity','number'),select('is_active','Status',active)],
      student:[text('full_name','Student’s full name'),{type:'guardian-heading'},
        text('guardian_name','Parent or guardian name','text',false),
        select('method','Parent sign-in method',signInMethods),
        text('phone','Mobile number','tel',false),text('email','Email address','email',false),
        text('relationship','Relationship','text',false)],
      assignments:[select('class_id','Class',options('classes')),select('user_id','Teacher',teachers()),text('starts_on','Start date','date'),text('ends_on','End date for temporary cover','date',false),select('is_active','Status',active)],
      holidays:[text('name','Holiday name'),...dates,select('is_active','Status',active)],
      invite:[select('role','Role',roles,'Choose a role'),...familyFields,text('full_name','Full name'),
        select('method','Sign-in method',signInMethods),
        text('email','Email address','email'),text('phone','Mobile number','tel'),
        text('expires_at','Access expiry (optional)','datetime-local',false)],
      grant:[select('role','Role',roles,'Choose a role'),...familyFields,
        select('user_id','Account',(access?.users||[]).filter(u=>u.is_active&&u.id!==user.id).map(u=>[u.id,`${u.full_name} (${contact(u)})`]),'Choose an account'),
        text('expires_at','Access expiry (optional)','datetime-local',false)],
      password:[text('current_password','Current password or PIN','password'),text('password','New password or PIN','password'),text('confirm','Confirm password or PIN','password')]
    };return fields[kind]||[];
  }
  function toggleField(field, visible, required = visible) {
    field.closest('.form-field').hidden = !visible;
    field.disabled = !visible;
    field.required = required && visible;
  }
  function updateContactFields(isEnrollment = false) {
    const mobile = $('#field-method').value === 'mobile';
    toggleField($('#field-email'), !mobile, !isEnrollment);
    toggleField($('#field-phone'), mobile, !isEnrollment);
  }
  function updateAccessFields(kind, changed = '') {
    const parent = $('#field-role').value === 'parent';
    const studentField = $('#field-student_id');
    const droppedStudent = !parent && Boolean(studentField.value);
    if (!parent) studentField.value = '';
    const guardian = rows('students').find(student => student.id === studentField.value)?.guardian;
    toggleField(studentField, parent, false);
    toggleField($('#field-relationship'), parent && Boolean(studentField.value));
    if (changed === 'student_id' || droppedStudent) {
      $('#field-relationship').value = guardian?.relationship || '';
      if (kind === 'invite') {
        $('#field-method').value = guardian?.email ? 'email' : 'mobile';
        $('#field-full_name').value = guardian?.full_name || '';
        $('#field-phone').value = guardian?.phone || '';
        $('#field-email').value = guardian?.email || '';
      }
      if (kind === 'grant') {
        const account = guardian && access.users.find(person => person.id !== user.id && person.is_active &&
          (guardian.phone ? person.phone === guardian.phone : person.email === guardian.email));
        $('#field-user_id').value = account?.id || '';
      }
    }
    if (kind === 'invite') {
      const method = $('#field-method');
      if (!parent || changed === 'role') method.value = parent ? 'mobile' : 'email';
      toggleField(method, parent);
      updateContactFields();
    }
  }
  function openEditor(kind,id){
    const classroom = kind==='student' ? data.classes.find(record => record.id === id) : null;
    if (kind==='student' && !canEnroll(classroom)) return;
    const row=(data[kind]||[]).find(r=>r.id===id)||{};
    editing={kind,row,branch:selected,classroom};
    $('#editorTitle').textContent=classroom?'Add student':kind==='invite'?'Invite a person':kind==='grant'?'Assign account access':kind==='password'?'Change your sign-in':`${id?'Edit':'Add'} ${recordNames[kind]}`;
    $('#editor button[type=submit]').textContent=classroom?'Save student':kind==='invite'?'Create invitation':kind==='grant'?'Assign access':'Save changes';
    const center=workingCenter();
    $('#editorHint').textContent=classroom
      ? `${className(classroom)} · ${center.name} · ${findName('years',classroom.academic_year_id)}`
      : ['invite','grant'].includes(kind)?(center?.is_active?`Working center: ${center.name}. Owner and management roles apply across all centers.`:'Only school-wide roles are available until you select an active center.'):kind==='years'?'Closing a year makes it read only. Close the current year before activating another.':kind==='assignments'?'The dates determine when the teacher gets access to this class.':kind==='centers'?'Opening hours use the center’s local time.':'';
    $('#formError').textContent='';
    $('#fields').innerHTML=definition(kind).map(f=>{
      if (f.type==='guardian-heading') {
        return '<div class="wide enrollment-heading"><h3>Parent or guardian details <small>(optional)</small></h3><p>Saved details fill in the parent invitation in People and access.</p></div>';
      }
      let value=row[f.key]??({timezone:'Asia/Kolkata',working_days:[1,2,3,4,5],is_active:true,status:'planned',section:''}[f.key]??'');
      if(f.type==='time')value=String(value).slice(0,5);
      const fieldId = `field-${f.key}`;
      let control;
      if(f.type==='days'){return `<fieldset class="wide day-picker"><legend>Working days</legend>${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day,i)=>`<label><input type="checkbox" name="working_days" value="${i}" ${value.includes(i)?'checked':''}>${day}</label>`).join('')}</fieldset>`;}
      if(f.type==='select')control=`<select id="${fieldId}" name="${f.key}" ${f.required?'required':''}>${f.placeholder||!f.options.length?`<option value="">${f.placeholder||'No available records'}</option>`:''}${f.options.map(([v,label])=>`<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(label)}</option>`).join('')}</select>`;
      else if(f.type==='textarea')control=`<textarea id="${fieldId}" name="${f.key}" maxlength="1000">${esc(value)}</textarea>`;
      else control=`<input id="${fieldId}" name="${f.key}" type="${f.type}" value="${esc(value)}" ${f.required?'required':''} ${f.type==='number'?'min="0" max="100000" step="1"':''} ${f.type==='password'?'autocomplete="new-password" minlength="6"':'maxlength="500"'}>`;
      return `<div class="form-field${f.type==='textarea'?' wide':''}"><label for="${fieldId}">${esc(f.label)}</label>${control}</div>`;
    }).join('');
    if (['invite','student'].includes(kind)) {
      const phone = $('#field-phone');
      phone.maxLength = 30;
      phone.autocomplete = 'tel';
      phone.placeholder = 'e.g. +91 98765 43210';
    }
    if (['invite','grant'].includes(kind)) updateAccessFields(kind);
    if (classroom) {
      const name = $('#field-full_name');
      name.maxLength = 120;
      name.closest('.form-field').classList.add('wide');
      name.autofocus = true;
      $('#field-guardian_name').maxLength = 120;
      updateContactFields(true);
    }
    if ($('#field-relationship')) {
      $('#field-relationship').maxLength = 40;
      $('#field-relationship').placeholder = 'e.g. Mother, Father, Guardian';
    }
    $('#editor').showModal();
  }
  $('#editorForm').addEventListener('change', event => {
    const field = event.target.name;
    if (['invite','grant'].includes(editing?.kind) && ['role','method','student_id'].includes(field)) {
      updateAccessFields(editing.kind, field);
    }
    if (editing?.kind==='student' && field==='method') updateContactFields(true);
  });
  $('#editorForm').addEventListener('submit',async event=>{
    event.preventDefault();const context=editing;const button=event.submitter;button.disabled=true;$('#formError').textContent='';
    try{
      const form = new FormData(event.currentTarget);
      const values={};for(const f of definition(context.kind)){
        if (!f.key) continue;
        let value=form.get(f.key);
        if(f.type==='number')value=value===''?null:Number(value);
        else if(f.key==='is_active')value=value==='true';
        else if(f.key==='working_days')value=form.getAll('working_days').map(Number);
        else if(f.type==='datetime-local')value=value?new Date(value).toISOString():null;
        else if(value==='')value=['section'].includes(f.key)?'':null;
        values[f.key]=value;
      }
      if(values.ends_on&&values.starts_on&&values.ends_on<values.starts_on)throw Error('End date cannot be before start date.');
      if (context.classroom) {
        const studentName = values.full_name?.trim();
        if (!studentName) throw Error('Enter the student’s full name.');
        const guardianName = values.guardian_name?.trim();
        const recipient = (values.phone || values.email)?.trim();
        const relationship = values.relationship?.trim();
        const hasGuardian = Boolean(guardianName || recipient || relationship);
        if (hasGuardian && !(guardianName && recipient && relationship)) {
          throw Error('Enter the parent’s name, contact and relationship, or leave the parent details blank.');
        }
        if (hasGuardian && values.method === 'mobile' && !/^(?:\+?91)?[6-9]\d{9}$/.test(recipient.replace(/[\s()-]/g, ''))) {
          throw Error('Enter a 10-digit Indian mobile number for the parent.');
        }
        await api('/parents/students', {
          full_name: studentName,
          branch_id: context.classroom.branch_id,
          class_id: context.classroom.id,
          ...(hasGuardian ? {guardian: {full_name: guardianName, relationship,
            [values.method === 'mobile' ? 'phone' : 'email']: recipient}} : {}),
        });
        $('#editor').close();
        await load();
        notify(`${studentName} was added to ${className(context.classroom)}.`);
        return;
      }
      if(context.kind==='password'){
        if(values.password!==values.confirm)throw Error('Passwords do not match.');
        const legacy=user.email.endsWith('@auth.octominds.invalid');
        if(legacy?!/^\d{6}$/.test(values.password):values.password.length<12)throw Error(legacy?'Use a six-digit PIN.':'Use at least 12 characters.');
        await auth('/user',{password:values.password,current_password:values.current_password},'PUT');$('#editor').close();notify('Your sign-in has been updated.');return;
      }
      if(['invite','grant'].includes(context.kind)){
        const schoolWide = ['super_admin','management'].includes(values.role);
        if (!schoolWide && !data.centers.some(center => center.id === context.branch && center.is_active)) {
          throw Error('Select an active working center before assigning this role.');
        }
        values.branch_id=schoolWide?null:context.branch;
        const inviteByMobile = context.kind === 'invite' && values.method === 'mobile';
        delete values.method;
        const result=await api(`/school/access/${context.kind}`,values);
        accessSection = context.kind==='invite' ? 'invitations' : 'members';
        $('#editor').close();await load();
        if(context.kind==='invite'){
          const fragment = inviteByMobile ? 'mobile-invite' : 'invite';
          $('#copyStatus').textContent='';
          const instructions = inviteByMobile
            ? 'Send this link directly to the invited mobile number. The parent has seven days to set up a PIN or accept with their existing PIN.'
            : 'Send this link directly to the person you invited. They have seven days to accept it with their invited email address.';
          $('#inviteInstructions').textContent = values.student_id
            ? `${instructions} The parent will be linked to the student when they accept.`
            : instructions;
          $('#inviteLink').value=`${location.origin}/school#${fragment}=${result.token}`;
          $('#resultDialog').showModal();
        }else notify(values.student_id ? 'Parent connected to the student.' : 'Account access assigned.');return;
      }
      if(!['school','centers'].includes(context.kind))values.branch_id=context.branch;
      if(context.row.id&&context.kind==='years'&&values.status==='closed'&&!window.confirm('Close this academic year? Its setup will become read only.'))return;
      await api(`/school/records/${context.kind}`,{id:context.row.id||null,version:context.row.version||null,data:values});
      $('#editor').close();await load();notify('Changes saved.');
    }catch(error){$('#formError').textContent=error.message;}finally{button.disabled=false;}
  });
  document.addEventListener('click',async event=>{
    const close=event.target.closest('[data-close]');if(close){const dialog=close.closest('dialog');if(!dialog.querySelector('button[type=submit]:disabled'))dialog.close();return;}
    const buttonEl=event.target.closest('[data-action]');if(!buttonEl||loading)return;
    const {action,id}=buttonEl.dataset;
    if(action==='reload')return load();
    if(action==='access-section'){
      accessSection=id;
      render();
      $('#content button[aria-pressed="true"]').focus();
      return;
    }
    if(action==='edit')return openEditor(route(),id);
    if(action==='add-student')return openEditor('student',id);
    if(['invite','grant','password'].includes(action))return openEditor(action);
    if(action==='logout-all'){if(window.confirm('Sign out on all devices?'))return logout('global');return;}
    if(!window.confirm(action==='status'?'Change this account’s status? Suspension blocks application data access.':'Revoke this access?'))return;
    buttonEl.disabled=true;
    try{const body=action==='status'?{user_id:id,is_active:!access.users.find(u=>u.id===id).is_active}:{id};await api(`/school/access/${action}`,body);await load();notify('Access updated.');}catch(error){notify(error.message);}finally{buttonEl.disabled=false;}
  });
  $('#navToggle').addEventListener('click', () => {
    const open = $('#navToggle').getAttribute('aria-expanded') !== 'true';
    setMenu(open);
    if (open) ($('#navigation [aria-current="page"]') || $('#navigation a'))?.focus();
  });
  $('#navigation').addEventListener('click',event=>{
    const link = event.target.closest('a');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    setMenu(false);
    if (link.hash === `#/${route()}`) $('#main').focus();
  });
  $('#schoolSidebar').addEventListener('keydown',event=>{
    if (event.key==='Escape' && $('#navToggle').getAttribute('aria-expanded')==='true') {
      setMenu(false);
      $('#navToggle').focus();
    }
  });
  $('.skip').addEventListener('click',event=>{
    event.preventDefault();
    const target = !$('#workspace').hidden ? '#main'
      : !$('#resetForm').hidden ? '#newPassword' : !$('#mobileSignupForm').hidden ? '#invitedMobile' : '#identity';
    $(target).focus();
  });
  $('#centerSelect').addEventListener('change',event=>{selected=event.target.value;render();});
  window.addEventListener('hashchange',()=>{const params=new URLSearchParams(location.hash.slice(1));if(['invite','mobile-invite','confirm','recovery'].some(key=>params.has(key))){location.reload();return;}if(user){setMenu(false);render();$('#main').focus();}});
  document.querySelectorAll('dialog').forEach(d=>d.addEventListener('cancel',event=>{if(d.querySelector('button[type=submit]:disabled'))event.preventDefault();}));
  $('#copyInvite').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#inviteLink').value);$('#copyStatus').textContent='Invitation link copied.';}catch{$('#inviteLink').focus();$('#inviteLink').select();$('#copyStatus').textContent='Select and copy the invitation link.';}});
  async function logout(scope='local'){
    const revocation=sessions.signOut(session,user?.id,scope,revokeSession);
    clearSession();
    const version=authEpoch;
    const allDevices=scope==='global';
    const submit=$('#signInForm [type="submit"]');
    if(allDevices)submit.disabled=true;
    $('#authMessage').textContent=allDevices?'Signing out on all devices…':'Signed out.';
    try{
      await revocation;
      if(allDevices&&version===authEpoch)$('#authMessage').textContent='Signed out on all devices.';
    }catch{
      if(version===authEpoch)$('#authMessage').textContent='Signed out on this device. Your school could not confirm server sign-out.';
    }finally{
      if(allDevices)submit.disabled=false;
    }
  }
  $('#signOut').addEventListener('click',()=>logout());
  window.addEventListener('storage',async event=>{
    const version=authEpoch;
    if(await sessions.signedOut(event,session,user?.id)&&version===authEpoch){
      clearSession();$('#authMessage').textContent='Signed out.';
    }
  });
  $('#signInForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const version=++authEpoch, remember=$('#remember').checked;
    event.submitter.disabled=true;$('#authMessage').textContent='Signing in…';
    try{
      const identity=$('#identity').value.trim(), password=$('#password').value;
      if (mobileInvite() && identity.includes('@')) throw Error('Enter the mobile number on your invitation.');
      const mobile=identity.replace(/\D/g,'').slice(-10);
      if(!identity.includes('@')&&(!/^[6-9]\d{9}$/.test(mobile)||!/^\d{6}$/.test(password)))throw Error('Enter a valid mobile number and six-digit PIN, or use your email and password.');
      const email=identity.includes('@')?identity:`${mobile}@auth.octominds.invalid`;
      const result=await auth('/token?grant_type=password',{email,password});
      if(version!==authEpoch)return;
      session=sessions.save(result,remember,session);
      $('#password').value='';
      await enter();
      if(version===authEpoch)$('#authMessage').textContent='';
    }catch(error){if(version===authEpoch)$('#authMessage').textContent=error.message;}finally{event.submitter.disabled=false;}
  });
  $('#useExistingPin').addEventListener('click', () => {
    $('#identity').value = $('#invitedMobile').value;
    $('#mobileSignupForm').reset();
    $('#authMessage').textContent = '';
    showInvitationControls(true);
    $('#identity').focus();
  });
  $('#useNewPin').addEventListener('click', () => {
    $('#invitedMobile').value = $('#identity').value;
    $('#password').value = '';
    $('#authMessage').textContent = '';
    showInvitationControls();
    $('#invitedMobile').focus();
  });
  $('#mobileSignupForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    const pin = $('#newPin').value;
    if (pin !== $('#confirmPin').value) {
      $('#authMessage').textContent = 'The PINs do not match.';
      $('#confirmPin').focus();
      return;
    }
    button.disabled = true;
    const version = ++authEpoch;
    $('#authMessage').textContent = 'Setting up your account…';
    try {
      const result = await auth('/claim-mobile-invitation', {
        phone: $('#invitedMobile').value,
        pin,
        invitation_token: sessionStorage.getItem(INVITE),
      });
      if (version !== authEpoch) return;
      session = sessions.save(result, false, session);
      forgetInvitation();
      $('#mobileSignupForm').reset();
      location.replace('/parents');
    } catch (error) {
      if (version === authEpoch) $('#authMessage').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('#createAccount').addEventListener('click',async event=>{
    const email=$('#identity').value.trim(), invitation_token=sessionStorage.getItem(INVITE);
    if(!invitation_token){$('#authMessage').textContent='Ask your school administrator for an invitation link first.';return;}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){$('#authMessage').textContent='Enter your invited email address above.';return;}
    event.target.disabled=true;
    try{await auth('/signup',{email,invitation_token});$('#authMessage').textContent='Check your email for a link to confirm your address and set your password. If you already have an account, sign in to accept.';}
    catch(error){$('#authMessage').textContent=error.message;}finally{event.target.disabled=false;}
  });
  $('#recover').addEventListener('click',async event=>{
    const email=$('#identity').value.trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.endsWith('@auth.octominds.invalid')){$('#authMessage').textContent='Enter your email above. For mobile PIN accounts, contact your school.';return;}
    event.target.disabled=true;
    try{await auth('/recover',{email});$('#authMessage').textContent='If this account exists, a password reset email will arrive shortly.';}catch(error){$('#authMessage').textContent=error.message;}finally{event.target.disabled=false;}
  });
  $('#resetForm').addEventListener('submit',async event=>{
    event.preventDefault();event.submitter.disabled=true;
    const version=++authEpoch;
    try{
      if($('#newPassword').value!==$('#confirmPassword').value)throw Error('Passwords do not match.');
      const result=await auth('/reset',{code:emailCode,password:$('#newPassword').value});
      if(version!==authEpoch)return;
      emailCode=null;session=sessions.save(result,false,session);resetAuth();
      try{await enter();}catch(error){if(version===authEpoch)$('#authMessage').textContent=error.status===403?'Password saved. Open your original school invitation to finish joining.':error.message;}
    }catch(error){if(version===authEpoch)$('#authMessage').textContent=error.message;}finally{event.submitter.disabled=false;}
  });
  $('#dismissInvitation').addEventListener('click',()=>{forgetInvitation();clearSession();$('#authMessage').textContent='Invitation dismissed. Sign in to access your existing account.';});
  async function start(){
    const version=authEpoch;
    let checking=false;
    try{
      const hash=new URLSearchParams(location.hash.slice(1));
      if(hash.has('invite') || hash.has('mobile-invite')){
        const mobile = hash.has('mobile-invite');
        const token = hash.get(mobile ? 'mobile-invite' : 'invite');
        if(!/^[a-f0-9]{64}$/.test(token))throw Error('This invitation link is invalid.');
        sessionStorage.setItem(INVITE,token);
        sessionStorage.setItem(INVITE_METHOD,mobile ? 'mobile' : 'email');
        history.replaceState(null,'',location.pathname+'#/overview');
      }
      const emailLink=hash.get('confirm')||hash.get('recovery');
      if(emailLink){
        if(!/^[A-Za-z0-9_-]{32,128}$/.test(emailLink))throw Error('This email link is invalid.');
        emailCode=emailLink;history.replaceState(null,'',location.pathname+'#/overview');
        $('#signInForm').hidden=true;$('.auth-actions').hidden=true;$('#resetForm').hidden=false;$('#authTitle').textContent='Set a new password';$('#authDescription').textContent='Choose a password with at least 12 characters.';return;
      }
      showInvitationControls();
      if (mobileInvite()) return;
      session=sessions.restore();
      if(!session)return;
      checking=true;
      $('#signInForm').hidden=true;$('.auth-actions').hidden=true;
      $('#authMessage').textContent='Checking your saved session…';
      await enter();
      if(version===authEpoch)$('#authMessage').textContent='';
    }catch(error){if(version===authEpoch)$('#authMessage').textContent=error.message;}
    finally{if(checking&&version===authEpoch)showInvitationControls();}
  }
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
  sessions.protectHistory($('#workspace'),()=>Boolean(session));
  start();
})();
