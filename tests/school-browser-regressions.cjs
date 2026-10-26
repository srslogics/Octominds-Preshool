// Local UI behavior with synthetic API responses; never changes live school data.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {mkdir}=require('node:fs/promises');
const origin=process.env.TEST_APP_ORIGIN||'http://127.0.0.1:4180';
const screenshotDir=process.env.TEST_SCREENSHOT_DIR;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block'});
 const page=await context.newPage(),errors=[],writes=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 let role='super_admin', conflict=false, delay=0, reject=false;
 const workspace={school:[{id:'s',name:'OctoMinds Preschool',version:1}],centers:[{id:'a',name:'Green Park',code:'GP',timezone:'Asia/Kolkata',working_days:[1,2,3,4,5],is_active:true,version:1},{id:'b',name:'Lake Road',code:'LR',timezone:'Asia/Kolkata',working_days:[1,2,3,4,5],is_active:true,version:1}],years:[{id:'y',branch_id:'a',name:'2026–27',starts_on:'2026-04-01',ends_on:'2027-03-31',status:'active',version:1},{id:'old',branch_id:'a',name:'2025–26',status:'closed',version:1}],terms:[],programs:[{id:'p',branch_id:'a',name:'Nursery',description:'Learning through play',is_active:true,version:1},{id:'bp',branch_id:'b',name:'Kindergarten',is_active:true,version:1}],classes:[{id:'c',branch_id:'a',name:'Nursery',section:'A',academic_year_id:'y',program_id:'p',room:'Sunflower',capacity:24,is_active:true,version:1},{id:'closed',branch_id:'a',name:'Historical class',section:'A',academic_year_id:'old',program_id:'p',capacity:20,is_active:true,version:1}],assignments:[],holidays:[],memberships:[{id:'m',user_id:'owner',role:'super_admin',branch_id:null,is_active:true}]};
 const directory={users:[{id:'owner',full_name:'School Owner',email:'owner@test.invalid',is_active:true},{id:'teacher',full_name:'Anika Sharma',email:'teacher@test.invalid',is_active:true}],memberships:[...workspace.memberships,{id:'tm',user_id:'teacher',role:'teacher',branch_id:'a',is_active:true}],invitations:[],audit:[]};
 await page.route('**/config.js',r=>r.fulfill({contentType:'application/javascript',body:`window.OCTOMINDS_CONFIG={supabaseUrl:'https://school-test.supabase.co',supabaseAnonKey:'test',apiBaseUrl:'${origin}'};`}));
 await page.route('https://school-test.supabase.co/**',r=>{requests.push(r.request().url());return r.fulfill({json:{access_token:'test',refresh_token:'refresh',expires_at:Math.floor(Date.now()/1000)+3600}});});
 await page.route('**/api/v1/**',async r=>{
  const path=new URL(r.request().url()).pathname;requests.push(path);
  if(reject)return r.fulfill({status:401,json:{detail:'Invalid session'}});
  if(path.endsWith('/session'))return r.fulfill({json:{id:'owner',email:'owner@test.invalid',full_name:'School Owner',role,branch_id:null}});
  if(r.request().method()==='POST'){
   const body=r.request().postDataJSON();writes.push({path,body});
   if(conflict)return r.fulfill({status:409,json:{detail:'This record changed. Reload before saving.'}});
   return r.fulfill({json:{id:'new',token:'a'.repeat(64),version:2}});
  }
  if(path.endsWith('/workspace')){if(delay)await new Promise(r=>setTimeout(r,delay));return r.fulfill({json:workspace});}
  if(path.endsWith('/access'))return r.fulfill({json:directory});
  return r.fulfill({status:404,json:{detail:'Unknown test route'}});
 });
 let checks=0;function pass(label){checks++;console.log('PASS:',label);}
 async function go(route){await page.locator(`#navigation a[href="#/${route}"]`).click();await page.waitForFunction(r=>location.hash==='#/'+r,route);}
 async function login(){await page.locator('#identity').fill('owner@test.invalid');await page.locator('#password').fill('a-valid-test-password');await page.locator('#signInForm button').click();await page.locator('#navigation a').first().waitFor();}
 await page.goto(origin+'/school.html');await login();
 assert.equal(await page.locator('#pageTitle').innerText(),'Overview');pass('email login loads school workspace');
 await go('centers');await page.locator('[data-action=edit][data-id=a]').click();
 await page.locator('[name=name]').fill('Green Park Updated');await page.locator('[name=working_days][value="6"]').check();await page.locator('#editorForm button[type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
 const saved=writes.at(-1).body;assert.equal(saved.id,'a');assert.equal(saved.version,1);assert.deepEqual(saved.data.working_days,[1,2,3,4,5,6]);pass('center form submits operating days with edit version');
 await go('classes');assert.equal(await page.locator('[data-action=edit][data-id=closed]').count(),0);pass('closed-year classes display as read only');
 if(screenshotDir){await mkdir(screenshotDir,{recursive:true});await page.screenshot({path:screenshotDir+'/school-classes-desktop.png',fullPage:true});}
 await go('programs');await page.locator('#centerSelect').selectOption('b');assert.ok((await page.locator('#content').innerText()).includes('Kindergarten'));assert.ok(!(await page.locator('#content').innerText()).includes('Learning through play'));pass('center switching filters school records');
 await page.locator('#centerSelect').selectOption('a');await page.locator('[data-action=edit][data-id=p]').click();conflict=true;await page.locator('#editorForm button[type=submit]').click();await page.locator('#formError').filter({hasText:'record changed'}).waitFor();assert.equal(await page.locator('[name=name]').inputValue(),'Nursery');conflict=false;await page.locator('#editor [data-close]').first().click();pass('stale edit preserves input and explains reload');
 await go('access');await page.locator('[data-action=invite]').click();await page.locator('[name=full_name]').fill('New Teacher');await page.locator('[name=email]').fill('new@test.invalid');await page.locator('[name=role]').selectOption('teacher');await page.locator('#editorForm button[type=submit]').click();await page.locator('#resultDialog').waitFor();assert.equal(writes.at(-1).body.branch_id,'a');assert.ok((await page.locator('#inviteLink').inputValue()).endsWith('#invite='+'a'.repeat(64)));await page.locator('#resultDialog [data-close]').click();pass('invitation creates a center-scoped one-time share link');
 await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
 const a11y=await page.evaluate(async()=> (await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})));
 assert.deepEqual(a11y,[]);pass('access screen passes automated WCAG A/AA checks');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));pass('mobile workspace fits viewport');
 if(screenshotDir)await page.screenshot({path:screenshotDir+'/school-access-mobile.png',fullPage:true});
 await page.locator('#signOut').click();await page.locator('#auth').waitFor();assert.equal(await page.locator('#content').innerText(),'');assert.equal(await page.locator('#password').inputValue(),'');pass('logout clears school data and credentials');
 role='teacher';workspace.memberships=[{id:'tm',role:'teacher',branch_id:'a',is_active:true}];await login();await go('programs');assert.equal(await page.locator('[data-action=edit]').count(),0);assert.equal(await page.locator('#navigation a[href="#/access"]').count(),0);assert.equal(await page.locator('#inventoryLink').isVisible(),false);pass('teacher view hides administration and inventory controls');
 delay=700;await page.locator('[data-action=reload]').click();await page.locator('#signOut').click();await page.waitForTimeout(900);assert.equal(await page.locator('#workspace').isVisible(),false);assert.equal(await page.locator('#content').innerText(),'');delay=0;pass('late response after logout cannot restore school data');
 requests.length=0;await page.goto(origin+'/school.html#invite='+'b'.repeat(64));await page.waitForURL('**/school.html#/overview');await login();assert.ok(requests.includes('/api/v1/school/accept-invitation'));assert.ok(requests.indexOf('/api/v1/school/accept-invitation')<requests.indexOf('/api/v1/session'));assert.ok(!page.url().includes('invite='));pass('invitation is consumed before membership lookup and removed from URL');
 await page.goto(origin+'/school.html#access_token=test&refresh_token=refresh&type=recovery');await page.locator('#newPassword').fill('new-strong-test-password');await page.locator('#confirmPassword').fill('new-strong-test-password');await page.locator('#resetForm button').click();await page.locator('#workspace').waitFor();await page.locator('#signOut').click();await page.locator('#auth').waitFor();assert.equal(await page.locator('.auth-actions').isVisible(),true);pass('recovery returns to usable normal sign-in after logout');
 await login();reject=true;await page.locator('[data-action=reload]').click();await page.locator('#auth').waitFor();assert.equal(await page.locator('#workspace').isVisible(),false);pass('rejected refreshed session clears the workspace');
 assert.deepEqual(errors,[]);pass('no uncaught browser errors');
 console.log(`${checks} school browser checks passed`);await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
