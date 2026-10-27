(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const cfg = window.OCTOMINDS_CONFIG || {};
  const KEY = 'octominds.inventory.session';
  const INVITE = 'octominds.school.invitation';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {super_admin:'Owner',management:'Management',branch_admin:'Center administrator',teacher:'Teacher',accountant:'Accountant',admission_counsellor:'Admissions counsellor',parent:'Parent or guardian'};
  let session, user, data, access, selected='', editing=null, generation=0, loading=false, noticeTimer;
  const pages = {
    overview:['Overview','A connected foundation for every center.'],
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
  const route=()=>location.hash.replace(/^#\/?/,'')||'overview';
  const globalAdmin=()=>['super_admin','management'].includes(user?.role);
  const administrator=()=>globalAdmin()||user?.role==='branch_admin';
  const canManage=branch=>globalAdmin()||data?.memberships?.some(m=>m.role==='branch_admin'&&m.branch_id===branch&&m.is_active&&(!m.expires_at||Date.parse(m.expires_at)>Date.now()));
  const rows=kind=>(data?.[kind]||[]).filter(r=>!r.branch_id||r.branch_id===selected);
  const findName=(kind,id)=>(data?.[kind]||[]).find(r=>r.id===id)?.name||'Unavailable';
  const fullName=id=>access?.users.find(r=>r.id===id)?.full_name|| (id===user?.id ? user.full_name : 'Assigned teacher');
  const notify=message=>{clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').hidden=false;noticeTimer=setTimeout(()=>$('#notice').hidden=true,6500);};
  const saveSession=(value,persistent)=>{session=value;sessionStorage.setItem(KEY,JSON.stringify(value));if(persistent)localStorage.setItem(KEY,JSON.stringify(value));else localStorage.removeItem(KEY);};
  function resetAuth(){ $('#signInForm').hidden=false; $('.auth-actions').hidden=false; $('#resetForm').hidden=true; $('#resetForm').reset(); $('#password').value=''; $('#authTitle').textContent='Welcome back'; }
  function clearSession(){resetAuth();generation++;session=null;user=null;data=null;access=null;selected='';sessionStorage.removeItem(KEY);localStorage.removeItem(KEY);$('#workspace').hidden=true;$('#auth').hidden=false;$('#content').replaceChildren();document.querySelectorAll('dialog[open]').forEach(d=>d.close());}
  async function auth(path,body,method='POST'){
    if(!cfg.supabaseUrl||!cfg.supabaseAnonKey)throw Error('School sign-in has not been configured. Contact your administrator.');
    const response=await fetch(`${cfg.supabaseUrl}/auth/v1${path}`,{method,headers:{apikey:cfg.supabaseAnonKey,'Content-Type':'application/json',...(session?.access_token?{Authorization:`Bearer ${session.access_token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){const error=Error(result.msg||result.message||result.error_description||'Unable to complete sign-in');error.status=response.status;throw error;}
    return result;
  }
  let refreshing;
  async function refresh(){
    if(refreshing)return refreshing;
    const old=session;
    refreshing=(async()=>{const result=await auth('/token?grant_type=refresh_token',{refresh_token:old?.refresh_token});if(session!==old)throw Error('Session changed. Sign in again.');saveSession(result,Boolean(localStorage.getItem(KEY)));})();
    try{await refreshing;}catch(error){if([400,401,403].includes(error.status)){clearSession();$('#authMessage').textContent='Your session expired. Please sign in again.';}throw error;}finally{refreshing=null;}
  }
  async function api(path,body,retry=true){
    if(!session?.access_token)throw Error('Please sign in');
    if(retry&&session.expires_at&&session.expires_at*1000<Date.now()+30000)await refresh();
    const token=session.access_token;
    const response=await fetch(`${cfg.apiBaseUrl||location.origin}/api/v1${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(response.status===401&&retry&&session?.access_token===token){await refresh();return api(path,body,false);}
    const result=await response.json().catch(()=>({}));
    if(!response.ok){if(response.status===401){clearSession();}throw Error(typeof result.detail==='string'?result.detail:'The request could not be completed. Please retry.');}
    return result;
  }
  async function enter(){
    const invitation=sessionStorage.getItem(INVITE);
    if(invitation){await api('/school/accept-invitation',{token:invitation});sessionStorage.removeItem(INVITE);$('#dismissInvitation').hidden=true;notify('Invitation accepted. Welcome to your school.');}
    const version=++generation;
    const current=await api('/session');if(version!==generation||!session)return;
    user=current;$('#userName').textContent=user.full_name;$('#userRole').textContent=labels[user.role]||user.role;
    $('#auth').hidden=true;$('#workspace').hidden=false;
    $('#inventoryLink').hidden=!['super_admin','management','branch_admin','accountant'].includes(user.role);
    await load();
  }
  async function load(){
    const version=++generation;loading=true;$('#content').innerHTML='<p role="status">Loading your school workspace…</p>';$('#toolbar').replaceChildren();
    try{
      const fresh=await api('/school/workspace');
      const directory=administrator()?await api('/school/access'):null;
      if(version!==generation||!session)return;
      data=fresh;access=directory;
      if(!data.centers.some(c=>c.id===selected))selected=user.branch_id||data.centers.find(c=>c.is_active)?.id||data.centers[0]?.id||'';
      $('#centerSelect').innerHTML=data.centers.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}${c.is_active?'':' (archived)'}</option>`).join('')||'<option value="">No centers yet</option>';
      $('#centerSelect').value=selected;
      loading=false;render();
    }catch(error){if(version!==generation)return;loading=false;$('#content').innerHTML=`<div class="error" role="alert">${esc(error.message)}</div><button data-action="reload">Try again</button>`;}
  }
  const button=(text,action,id='',cls='')=>`<button type="button" class="${cls}" data-action="${action}" data-id="${esc(id)}">${text}</button>`;
  const state=v=>`<span class="pill ${esc(v)}">${esc(v)}</span>`;
  function table(headers,body){return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;}
  const empty=(title,copy)=>`<div class="empty"><h2>${title}</h2><p>${copy}</p></div>`;
  function render(){
    if(!user||!data||loading)return;
    const page=route(), info=pages[page];
    $('#navigation').innerHTML=Object.entries(pages).filter(([k])=>k!=='access'||administrator()).map(([k,[name]])=>`<a href="#/${k}" ${k===page?'aria-current="page"':''}>${esc(name)}</a>`).join('');
    $('#pageTitle').textContent=info?.[0]||'Page not found';$('#pageDescription').textContent=info?.[1]||'Choose a destination from the navigation.';
    document.title=`${info?.[0]||'School'} · OctoMinds`;
    $('#toolbar').innerHTML=button('Refresh','reload');
    if(!info){$('#content').innerHTML='<a href="#/overview">Return to overview</a>';return;}
    if(page==='overview'){
      $('#content').innerHTML=`<div class="cards">${[['Centers',data.centers.length,'centers'],['Academic years',rows('years').length,'years'],['Programs',rows('programs').filter(r=>r.is_active).length,'programs'],['Classes',rows('classes').filter(r=>r.is_active).length,'classes']].map(([title,count,path])=>`<article class="card"><p>${title}</p><strong class="metric">${count}</strong><a href="#/${path}">View ${title.toLowerCase()}</a></article>`).join('')}</div><section class="card history-title"><h2>Set up a center in order</h2><p>Create a center, add its academic year and programs, then prepare classes and assign teachers.</p><p class="tip">Closing a year preserves its setup as read-only history. Student enrollment and promotion will connect through the student-record module.</p></section>`;return;
    }
    if(page==='school'){
      const row=data.school[0];if(globalAdmin())$('#toolbar').innerHTML+=button(row?'Edit school profile':'Add school profile','edit',row?.id||'','primary');
      $('#content').innerHTML=row?`<section class="card"><h2>${esc(row.name)}</h2><dl>${['email','phone','address','website'].map(k=>`<dt>${k[0].toUpperCase()+k.slice(1)}</dt><dd>${esc(row[k]||'Not set')}</dd>`).join('')}</dl></section>`:empty('Your school profile','Management can add the school name and contact details here.');return;
    }
    if(page==='account'){
      const legacy=user.email?.endsWith('@auth.octominds.invalid');
      $('#content').innerHTML=`<section class="card"><h2>${esc(user.full_name)}</h2><p>${esc(legacy?'Mobile and PIN account':user.email)}</p><h3>Assigned access</h3><ul>${data.memberships.map(m=>`<li>${esc(labels[m.role])} · ${esc(m.branch_id?findName('centers',m.branch_id):'All centers')}${m.expires_at?` · expires ${esc(new Date(m.expires_at).toLocaleDateString())}`:''}</li>`).join('')}</ul><div class="account-buttons">${button(legacy?'Change PIN':'Change password','password')}${button('Sign out on all devices','logout-all')}</div><p class="tip">${legacy?'For a forgotten PIN, contact an authorized administrator.':'Use Forgot password on the sign-in screen for email recovery.'}</p></section>`;return;
    }
    if(page==='access'){renderAccess();return;}
    const writable=page==='centers'?globalAdmin():canManage(selected);
    if(writable)$('#toolbar').innerHTML+=button(`Add ${ {centers:'center',years:'academic year',terms:'term',programs:'program',classes:'class',assignments:'teacher assignment',holidays:'holiday'}[page]}`,'edit','','primary');
    if(!selected&&page!=='centers'){$('#content').innerHTML=empty('Create a center first','School records belong to a center. Management can create one from Centers.');return;}
    const records=page==='centers'?data.centers:rows(page);
    if(!records.length){$('#content').innerHTML=empty('No records yet',writable?'Use the add button to create the first record.':'Your school has not added records for this view.');return;}
    const columns={centers:['Center','Contact','Hours','Status','Actions'],years:['Academic year','Dates','Status','Actions'],terms:['Term','Academic year','Dates','Actions'],programs:['Program','Description','Status','Actions'],classes:['Class','Program and year','Room and capacity','Status','Actions'],assignments:['Teacher','Class','Dates','Status','Actions'],holidays:['Holiday','Dates','Status','Actions']}[page];
    const dateRange=r=>`${esc(r.starts_on)} → ${esc(r.ends_on||'No end date')}`;
    const body=records.map(r=>{
      let cells;
      if(page==='centers')cells=[`${esc(r.name)}<small>${esc(r.code)} · ${esc(r.timezone)}</small>`,esc(r.email||r.phone||'Not set'),`${esc(r.opens_at?.slice(0,5)||'—')} – ${esc(r.closes_at?.slice(0,5)||'—')}`,state(r.is_active?'active':'inactive')];
      if(page==='years')cells=[esc(r.name),dateRange(r),state(r.status)];
      if(page==='terms')cells=[esc(r.name),esc(findName('years',r.academic_year_id)),dateRange(r)];
      if(page==='programs')cells=[esc(r.name),esc(r.description||'—'),state(r.is_active?'active':'inactive')];
      if(page==='classes')cells=[`${esc(r.name)} ${esc(r.section)}`,`${esc(findName('programs',r.program_id))}<small>${esc(findName('years',r.academic_year_id))}</small>`,`${esc(r.room||'Not set')}<small>Capacity ${esc(r.capacity)}</small>`,state(r.is_active?'active':'inactive')];
      if(page==='assignments')cells=[esc(fullName(r.user_id)),esc(findName('classes',r.class_id)),dateRange(r),state(!r.is_active?'inactive':r.ends_on&&r.ends_on<new Date().toLocaleDateString('en-CA')?'expired':'assigned')];
      if(page==='holidays')cells=[esc(r.name),dateRange(r),state(r.is_active?'active':'inactive')];
      const yearId=r.academic_year_id||(page==='assignments'?data.classes.find(c=>c.id===r.class_id)?.academic_year_id:null);
      const closed=r.status==='closed'||data.years.some(y=>y.id===yearId&&y.status==='closed');
      const editable=canManage(page==='centers'?r.id:r.branch_id)&&!closed;
      cells.push(editable?button('Edit','edit',r.id):'<span class="tip">Read only</span>');
      return `<tr>${cells.map(c=>`<td>${c}</td>`).join('')}</tr>`;
    }).join('');$('#content').innerHTML=table(columns,body);
  }
  function renderAccess(){
    if(!administrator()||!access){$('#content').innerHTML=empty('Restricted workspace','Account administration is available to authorized administrators.');return;}
    $('#toolbar').innerHTML+=button('Invite a person','invite','','primary')+button('Assign existing account','grant');
    const members=access.memberships.filter(m=>!selected||m.branch_id===selected||!m.branch_id);
    const body=members.map(m=>`<tr><td>${esc(fullName(m.user_id))}<small>${esc(access.users.find(u=>u.id===m.user_id)?.email)}</small></td><td>${esc(labels[m.role])}<small>${esc(m.branch_id?findName('centers',m.branch_id):'All centers')}</small></td><td>${state(!m.is_active?'revoked':m.expires_at&&Date.parse(m.expires_at)<=Date.now()?'expired':'active')}<small>${esc(m.expires_at?new Date(m.expires_at).toLocaleString():'No expiry')}</small></td><td>${m.is_active&&m.user_id!==user.id&&mayGrant(m.role)?button('Revoke','revoke',m.id):''}</td></tr>`).join('');
    let html=body?table(['Person','Access','Status','Actions'],body):empty('No memberships','Invite a person to give them access to this center.');
    const invites=access.invitations.filter(i=>!selected||i.branch_id===selected||!i.branch_id);
    html+='<h2 class="history-title">Invitations</h2>';
    html+=invites.length?table(['Recipient','Role','Status','Actions'],invites.map(i=>`<tr><td>${esc(i.full_name)}<small>${esc(i.email)}</small></td><td>${esc(labels[i.role])}</td><td>${state(i.accepted_at?'accepted':i.revoked_at?'revoked':Date.parse(i.expires_at)<Date.now()?'expired':'pending')}</td><td>${!i.accepted_at&&!i.revoked_at&&mayGrant(i.role)?button('Revoke invitation','revoke_invite',i.id):''}</td></tr>`).join('')):empty('No invitations yet','Invitation links are shown once and are accepted using the recipient’s verified email.');
    if(user.role==='super_admin')html+='<h2 class="history-title">Account status</h2>'+table(['Person','Status','Actions'],access.users.map(u=>`<tr><td>${esc(u.full_name)}</td><td>${state(u.is_active?'active':'inactive')}</td><td>${u.id!==user.id?button(u.is_active?'Suspend account':'Reactivate account','status',u.id):'Your account'}</td></tr>`).join(''));
    html+='<h2 class="history-title">Recent administration history</h2>'+table(['When','Action','Record'],access.audit.map(a=>`<tr><td>${esc(new Date(a.occurred_at).toLocaleString())}</td><td>${esc(a.event_type.replace('school.','').replaceAll('_',' '))}</td><td>${esc(a.entity_type)}</td></tr>`).join('')||'<tr><td colspan="3">No administration events yet.</td></tr>');
    $('#content').innerHTML=html;
  }
  const text=(key,label,type='text',required=true)=>({key,label,type,required});
  const select=(key,label,options)=>({key,label,type:'select',options,required:true});
  const options=kind=>rows(kind).filter(r=>r.status!=='closed'&&r.is_active!==false&&(kind!=='classes'||!data.years.some(y=>y.id===r.academic_year_id&&y.status==='closed'))).map(r=>[r.id,r.name]);
  const mayGrant=role=>user.role==='super_admin'||(globalAdmin()&&!['super_admin','management'].includes(role))||(!globalAdmin()&&['teacher','parent','accountant','admission_counsellor'].includes(role));
  function definition(kind){
    const active=[['true','Active'],['false','Archived']];
    const dates=[text('starts_on','Start date','date'),text('ends_on','End date','date')];
    const roles=Object.entries(labels).filter(([r])=>user.role==='super_admin'||(globalAdmin()&&!['super_admin','management'].includes(r))||(!globalAdmin()&&['teacher','parent','accountant','admission_counsellor'].includes(r)));
    const fields={
      school:[text('name','School name'),text('email','Contact email','email',false),text('phone','Phone','tel',false),text('address','Address','textarea',false),text('website','Website','url',false)],
      centers:[text('name','Center name'),text('code','Center code'),text('email','Contact email','email',false),text('phone','Phone','tel',false),text('address','Address','textarea',false),text('timezone','Timezone'),text('opens_at','Opens at','time',false),text('closes_at','Closes at','time',false),{key:'working_days',label:'Working days',type:'days'},text('capacity','Center capacity','number',false),...(globalAdmin()?[select('is_active','Status',active)]:[])],
      years:[text('name','Academic year name'),...dates,select('status','Status',[['planned','Planned'],['active','Active'],['closed','Closed and read only']])],
      terms:[text('name','Term name'),select('academic_year_id','Academic year',options('years')),...dates],
      programs:[text('name','Program name'),text('description','Description','textarea',false),select('is_active','Status',active)],
      classes:[text('name','Class name'),text('section','Section','text',false),select('academic_year_id','Academic year',options('years')),select('program_id','Program',options('programs')),text('room','Room','text',false),text('capacity','Capacity','number'),select('is_active','Status',active)],
      assignments:[select('class_id','Class',options('classes')),select('user_id','Teacher',(access?.users||[]).filter(u=>u.is_active&&access.memberships.some(m=>m.user_id===u.id&&m.role==='teacher'&&m.branch_id===selected&&m.is_active&&(!m.expires_at||Date.parse(m.expires_at)>Date.now()))).map(u=>[u.id,u.full_name])),text('starts_on','Start date','date'),text('ends_on','End date for temporary cover','date',false),select('is_active','Status',active)],
      holidays:[text('name','Holiday name'),...dates,select('is_active','Status',active)],
      invite:[text('full_name','Full name'),text('email','Email address','email'),select('role','Role',roles),text('expires_at','Access expires on optional','datetime-local',false)],
      grant:[select('user_id','Account',(access?.users||[]).filter(u=>u.is_active&&u.id!==user.id).map(u=>[u.id,`${u.full_name} (${u.email})`])),select('role','Role',roles),text('expires_at','Access expires on optional','datetime-local',false)],
      password:[text('password','New password or PIN','password'),text('confirm','Confirm password or PIN','password')]
    };return fields[kind]||[];
  }
  function openEditor(kind,id){
    const row=(data[kind]||[]).find(r=>r.id===id)||{};
    editing={kind,row,branch:selected};
    $('#editorTitle').textContent=kind==='invite'?'Invite a person':kind==='grant'?'Assign account access':kind==='password'?'Change your sign-in':`${id?'Edit':'Add'} ${pages[kind]?.[0].toLowerCase()}`;
    $('#editorHint').textContent=['invite','grant'].includes(kind)?`Center roles apply to ${findName('centers',selected)}. Owner and management roles apply across all centers.`:kind==='years'?'Closing a year makes it read only. Close the current year before activating another.':kind==='assignments'?'Invite the teacher and have them accept before assigning a class.':kind==='centers'?'Choose operating days and use the center’s local timezone for opening hours.':'';
    $('#formError').textContent='';
    $('#fields').innerHTML=definition(kind).map(f=>{
      let value=row[f.key]??({timezone:'Asia/Kolkata',working_days:[1,2,3,4,5],is_active:true,status:'planned',section:''}[f.key]??'');
      if(f.type==='time')value=String(value).slice(0,5);
      let control;
      if(f.type==='days'){return `<fieldset class="wide day-picker"><legend>Working days</legend>${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day,i)=>`<label><input type="checkbox" name="working_days" value="${i}" ${value.includes(i)?'checked':''}>${day}</label>`).join('')}</fieldset>`;}
      if(f.type==='select')control=`<select name="${f.key}" ${f.required?'required':''}>${f.options.length?'':'<option value="">No available records</option>'}${f.options.map(([v,label])=>`<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(label)}</option>`).join('')}</select>`;
      else if(f.type==='textarea')control=`<textarea name="${f.key}" maxlength="1000">${esc(value)}</textarea>`;
      else control=`<input name="${f.key}" type="${f.type}" value="${esc(value)}" ${f.required?'required':''} ${f.type==='number'?'min="0" max="100000" step="1"':''} ${f.type==='password'?'autocomplete="new-password" minlength="6"':'maxlength="500"'}>`;
      return `<label class="${f.type==='textarea'?'wide':''}">${esc(f.label)}${control}</label>`;
    }).join('');
    $('#editor').showModal();
  }
  $('#editorForm').addEventListener('submit',async event=>{
    event.preventDefault();const context=editing;const button=event.submitter;button.disabled=true;$('#formError').textContent='';
    try{
      const values={};for(const f of definition(context.kind)){
        let value=new FormData(event.currentTarget).get(f.key);
        if(f.type==='number')value=value===''?null:Number(value);
        else if(f.key==='is_active')value=value==='true';
        else if(f.key==='working_days')value=new FormData(event.currentTarget).getAll('working_days').map(Number);
        else if(f.type==='datetime-local')value=value?new Date(value).toISOString():null;
        else if(value==='')value=['section'].includes(f.key)?'':null;
        values[f.key]=value;
      }
      if(values.ends_on&&values.starts_on&&values.ends_on<values.starts_on)throw Error('End date cannot be before start date.');
      if(context.kind==='password'){
        if(values.password!==values.confirm)throw Error('Passwords do not match.');
        const legacy=user.email.endsWith('@auth.octominds.invalid');
        if(legacy?!/^\d{6}$/.test(values.password):values.password.length<12)throw Error(legacy?'Use a six-digit PIN.':'Use at least 12 characters.');
        await auth('/user',{password:values.password},'PUT');$('#editor').close();notify('Your sign-in has been updated.');return;
      }
      if(['invite','grant'].includes(context.kind)){
        values.branch_id=['super_admin','management'].includes(values.role)?null:context.branch;
        const result=await api(`/school/access/${context.kind}`,values);
        $('#editor').close();await load();
        if(context.kind==='invite'){$('#inviteLink').value=`${location.origin}/school#invite=${result.token}`;$('#resultDialog').showModal();}else notify('Account access assigned.');return;
      }
      if(!['school','centers'].includes(context.kind))values.branch_id=context.branch;
      if(context.row.id&&context.kind==='years'&&values.status==='closed'&&!window.confirm('Close this academic year? Its setup will become read only.'))return;
      await api(`/school/records/${context.kind}`,{id:context.row.id||null,version:context.row.version||null,data:values});
      $('#editor').close();await load();notify('Changes saved.');
    }catch(error){$('#formError').textContent=error.message;}finally{button.disabled=false;}
  });
  document.addEventListener('click',async event=>{
    const close=event.target.closest('[data-close]');if(close){close.closest('dialog').close();return;}
    const buttonEl=event.target.closest('[data-action]');if(!buttonEl||loading)return;
    const {action,id}=buttonEl.dataset;
    if(action==='reload')return load();
    if(action==='edit')return openEditor(route(),id);
    if(['invite','grant','password'].includes(action))return openEditor(action);
    if(action==='logout-all'){if(window.confirm('Sign out on all devices?'))return logout('global');return;}
    if(!window.confirm(action==='status'?'Change this account’s status? Suspension blocks application data access.':'Revoke this access?'))return;
    buttonEl.disabled=true;
    try{const body=action==='status'?{user_id:id,is_active:!access.users.find(u=>u.id===id).is_active}:{id};await api(`/school/access/${action}`,body);await load();notify('Access updated.');}catch(error){notify(error.message);}finally{buttonEl.disabled=false;}
  });
  $('#centerSelect').addEventListener('change',event=>{selected=event.target.value;render();});
  window.addEventListener('hashchange',()=>{const params=new URLSearchParams(location.hash.slice(1));if(params.has('invite')||params.has('access_token')){location.reload();return;}if(user){render();$('#main').focus();}});
  document.querySelectorAll('dialog').forEach(d=>d.addEventListener('cancel',event=>{if(d.querySelector('button[type=submit]:disabled'))event.preventDefault();}));
  $('#copyInvite').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#inviteLink').value);notify('Invitation link copied.');}catch{$('#inviteLink').select();notify('Select and copy the invitation link.');}});
  async function logout(scope='local'){
    try{await auth(`/logout?scope=${scope}`);clearSession();localStorage.setItem(`${KEY}.logout`,crypto.randomUUID());$('#authMessage').textContent='Signed out.';}
    catch(error){clearSession();localStorage.setItem(`${KEY}.logout`,crypto.randomUUID());$('#authMessage').textContent='Signed out on this device. Server session revocation could not be confirmed.';}
  }
  $('#signOut').addEventListener('click',()=>logout());
  window.addEventListener('storage',event=>{if(event.key===`${KEY}.logout`)clearSession();});
  $('#signInForm').addEventListener('submit',async event=>{
    event.preventDefault();event.submitter.disabled=true;$('#authMessage').textContent='Signing in…';
    try{
      const identity=$('#identity').value.trim(), password=$('#password').value;
      const mobile=identity.replace(/\D/g,'').slice(-10);
      if(!identity.includes('@')&&(!/^[6-9]\d{9}$/.test(mobile)||!/^\d{6}$/.test(password)))throw Error('Enter a valid mobile number and six-digit PIN, or use your email and password.');
      const email=identity.includes('@')?identity:`${mobile}@auth.octominds.invalid`;
      saveSession(await auth('/token?grant_type=password',{email,password}),$('#remember').checked);
      await enter();$('#password').value='';$('#authMessage').textContent='';
    }catch(error){$('#authMessage').textContent=error.message;}finally{event.submitter.disabled=false;}
  });
  // Keep the previously allowlisted email callback; the server redirects it to /school.
  $('#createAccount').addEventListener('click',async event=>{
    if(!sessionStorage.getItem(INVITE)){$('#authMessage').textContent='Ask your school administrator for an invitation link first.';return;}
    const email=$('#identity').value.trim(),password=$('#password').value;
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12){$('#authMessage').textContent='Enter the invited email and a password of at least 12 characters above.';return;}
    event.target.disabled=true;
    try{const result=await auth(`/signup?redirect_to=${encodeURIComponent(location.origin+'/school.html')}`,{email,password});if(result.access_token){saveSession(result,false);await enter();}else $('#authMessage').textContent='Check your email to confirm your account, then return to this invitation and sign in.';}
    catch(error){$('#authMessage').textContent=error.message;}finally{event.target.disabled=false;}
  });
  $('#recover').addEventListener('click',async event=>{
    const email=$('#identity').value.trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.endsWith('@auth.octominds.invalid')){$('#authMessage').textContent='Enter your email above for password recovery. For a mobile PIN account, contact an authorized administrator.';return;}
    event.target.disabled=true;
    try{await auth(`/recover?redirect_to=${encodeURIComponent(location.origin+'/school.html')}`,{email});$('#authMessage').textContent='If this account exists, a password reset email will arrive shortly.';}catch(error){$('#authMessage').textContent=error.message;}finally{event.target.disabled=false;}
  });
  $('#resetForm').addEventListener('submit',async event=>{
    event.preventDefault();event.submitter.disabled=true;
    try{if($('#newPassword').value!==$('#confirmPassword').value)throw Error('Passwords do not match.');await auth('/user',{password:$('#newPassword').value},'PUT');resetAuth();await enter();}
    catch(error){$('#authMessage').textContent=error.message;}finally{event.submitter.disabled=false;}
  });
  $('#dismissInvitation').addEventListener('click',()=>{sessionStorage.removeItem(INVITE);$('#dismissInvitation').hidden=true;clearSession();$('#authDescription').textContent='Sign in with your email and password or your existing mobile number and PIN.';$('#authMessage').textContent='Invitation dismissed. Sign in to access your existing account.';});
  async function start(){
    try{
      const hash=new URLSearchParams(location.hash.slice(1));
      if(hash.has('invite')){const token=hash.get('invite');if(!/^[a-f0-9]{64}$/.test(token))throw Error('This invitation link is invalid.');sessionStorage.setItem(INVITE,token);history.replaceState(null,'',location.pathname+'#/overview');$('#authDescription').textContent='Sign in with the invited email, or enter it with a new password and choose Create invited account.';}
      if(hash.has('access_token')){
        saveSession({access_token:hash.get('access_token'),refresh_token:hash.get('refresh_token'),expires_at:Math.floor(Date.now()/1000)+Number(hash.get('expires_in')||3600)},false);
        history.replaceState(null,'',location.pathname+'#/overview');
        if(hash.get('type')==='recovery'){$('#signInForm').hidden=true;$('.auth-actions').hidden=true;$('#resetForm').hidden=false;$('#authTitle').textContent='Set a new password';return;}
      }else session=JSON.parse(sessionStorage.getItem(KEY)||localStorage.getItem(KEY)||'null');
      $('#dismissInvitation').hidden=!sessionStorage.getItem(INVITE);
      if(session)await enter();
    }catch(error){$('#authMessage').textContent=error.message;}
  }
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
  start();
})();
