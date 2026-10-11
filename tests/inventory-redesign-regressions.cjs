const { chromium } = require('playwright');
const ORIGIN=process.env.TEST_APP_ORIGIN || 'http://127.0.0.1:4179';
const assert=require('node:assert/strict');
const A='00000000-0000-0000-0000-000000000101', B='00000000-0000-0000-0000-000000000102';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
 const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 let delay=false, role='super_admin', failedOnce=false, failMovement=false, rejectAuth=false, tokenCounter=0;
 let requests=[]; const writes=[]; let unavailable=false;
 const items=[{id:'itemA',branch_id:A,category_id:'catA',name:'Center A books',sku:'A-BOOK',unit:'piece',reorder_level:2,standard_cost:0,description:'notes',quantity_on_hand:10,stock_status:'healthy',category_name:'Books',location_names:['Store A']},{id:'itemB',branch_id:B,category_id:'catB',name:'Center B crayons',sku:'B-CRAYON',unit:'piece',reorder_level:2,standard_cost:5,description:null,quantity_on_hand:0,stock_status:'out',category_name:'Art',location_names:[]}];
 const lookup={branches:[{id:A,name:'Center A'},{id:B,name:'Center B'}],categories:[{id:'catA',branch_id:A,name:'Books'},{id:'catB',branch_id:B,name:'Art'}],locations:[{id:'locA',branch_id:A,name:'Store A'},{id:'locB',branch_id:B,name:'Store B'}],items};
 await page.route('**/config.js',r=>r.fulfill({contentType:'application/javascript',body:`window.OCTOMINDS_CONFIG={supabaseUrl:'https://audit.supabase.co',supabaseAnonKey:'test-public-key',apiBaseUrl:'${ORIGIN}'};`}));
 await page.route('https://audit.supabase.co/**',r=>{requests.push(r.request().url()); return r.fulfill({json:{access_token:'test-access-token-'+(++tokenCounter),refresh_token:'test-refresh-token',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'audit-user'}}});});
 await page.route('**/api/v1/**',async r=>{
   const req=r.request(),u=new URL(req.url()); requests.push(u.pathname+u.search);
   if(rejectAuth) return r.fulfill({status:401,json:{detail:'Invalid access token'}});
   if(u.pathname.endsWith('/session'))return r.fulfill({json:{id:'audit-user',full_name:'Audit User',role,role_label:role,branch_id:null}});
   if(unavailable)return r.fulfill({status:503,json:{detail:'Inventory is temporarily unavailable'}});
   if(req.method()!=='GET'){
     const body=req.postDataJSON();writes.push({url:u.pathname,body});
     if(u.pathname.endsWith('/movements')&&failMovement&&!failedOnce){failedOnce=true;return r.abort('failed');}
     if(u.pathname.includes('/items/')&&!u.searchParams.get('branch_id'))return r.fulfill({status:422,json:{detail:'Select a center before changing inventory'}});
     return r.fulfill({status:201,json:{id:'new-item',movement_id:'movement1',quantity_after:15,...body}});
   }
   const selected=u.searchParams.get('branch_id');
   if(delay) await new Promise(res=>setTimeout(res,650));
   if(u.pathname.endsWith('/lookups'))return r.fulfill({json:{...lookup,categories:lookup.categories.filter(x=>!selected||x.branch_id===selected),locations:lookup.locations.filter(x=>!selected||x.branch_id===selected),items:items.filter(x=>!selected||x.branch_id===selected)}});
   if(u.pathname.endsWith('/dashboard'))return r.fulfill({json:{active_items:selected?1:2,low_stock:0,out_of_stock:selected===A?0:1,movements_today:0}});
   if(u.pathname.endsWith('/movements'))return r.fulfill({json:{movements:[],total:0}});
   const filtered=items.filter(x=>(!selected||x.branch_id===selected)&&(!u.searchParams.get('search')||x.name.toLowerCase().includes(u.searchParams.get('search').toLowerCase()))&&(!u.searchParams.get('stock_status')||u.searchParams.get('stock_status')==='all'||x.stock_status===u.searchParams.get('stock_status')));
   return r.fulfill({json:{items:filtered,total:filtered.length,page:1,page_size:25}});
 });


 await page.goto(ORIGIN);
 const output=process.env.UI_SCREENSHOT_DIR || '/tmp/octominds-ui-redesign';
 require('fs').mkdirSync(output,{recursive:true});
 const findings=[];
 async function verify(label){
   await page.waitForTimeout(350);
   const size=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));
   assert.ok(size.width<=size.viewport,JSON.stringify({label,...size}));
   await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
   const scan=await page.evaluate(()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
   findings.push({label,...size,violations:scan.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))});
 }
 await verify('login-desktop');await page.screenshot({path:output+'/login-desktop.png',fullPage:true});
 await page.locator('#phone').fill('9999999999');await page.locator('#pin').fill('123456');
 await page.locator('#loginForm button[type=submit]').click();await page.locator('[data-edit-item="itemA"]').waitFor();
 assert.ok((await page.locator('#inventoryLowStockList').innerText()).includes('Center B crayons'));
 await page.screenshot({path:output+'/workspace-desktop.png',fullPage:true});await verify('workspace-desktop');
 unavailable=true;await page.locator('#refreshInventory').click();
 await page.locator('[data-retry-inventory]').waitFor();
 assert.equal(await page.locator('#inventoryActiveItems').innerText(),'—');
 await verify('inventory-error');
 unavailable=false;await page.locator('[data-retry-inventory]').click();
 await page.locator('[data-edit-item="itemA"]').waitFor();
 await page.locator('.metric-filter[data-stock-filter="out"]').click();
 await page.waitForFunction(()=>document.querySelector('#inventoryResultCount').textContent==='1 item');
 assert.ok((await page.locator('#inventoryItemsBody').innerText()).includes('Center B crayons'));
 assert.ok(!(await page.locator('#inventoryItemsBody').innerText()).includes('Center A books'));
 await page.locator('#clearInventoryFilters').click();
 await page.waitForFunction(()=>document.querySelector('#inventoryResultCount').textContent==='2 items');
 await page.locator('#inventorySearch').fill('zz-not-found');await page.waitForTimeout(500);
 assert.ok((await page.locator('#inventoryItemsBody').innerText()).includes('No matching items'));
 await page.screenshot({path:output+'/empty-search.png',fullPage:true});
 await page.locator('#clearInventoryFilters').click();await page.waitForFunction(()=>document.querySelector('#inventoryResultCount').textContent==='2 items');
 for(const width of [320,390,768,1024,1440,1920]){
   await page.setViewportSize({width,height:900});await verify('workspace-'+width);
   if([390,768].includes(width))await page.screenshot({path:output+'/workspace-'+width+'.png',fullPage:true});
 }
 await page.setViewportSize({width:1440,height:900});
 await page.locator('#inventoryBranchSelect').selectOption(A);await page.waitForFunction(()=>!document.querySelector('#refreshInventory').disabled);
 await page.locator('[data-stock-action="receipt"]').click();await verify('receive-dialog');
 await page.screenshot({path:output+'/receive-dialog.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await verify('receive-dialog-mobile');
 await page.screenshot({path:output+'/receive-mobile.png',fullPage:true});
 await page.locator('#inventoryMovementDialog [data-close-dialog]').first().click();
 await page.locator('[data-inventory-action="item"]').click();await verify('item-dialog-mobile');
 await page.locator('#inventoryItemDialog [data-close-dialog]').first().click();
 await page.locator('.more-menu summary').click();await page.locator('.more-menu [data-inventory-action="setup"]').click();await verify('setup-dialog-mobile');
 await page.locator('#inventorySetupDialog [data-close-dialog]').click();
 await page.locator('#logoutButton').click();
 for(const width of [320,390,768,1024,1440]){
   await page.setViewportSize({width,height:900});await verify('login-'+width);
   if(width===390)await page.screenshot({path:output+'/login-mobile.png',fullPage:true});
 }
 assert.deepEqual(errors,[]);
 require('fs').writeFileSync(output+'/verification.json',JSON.stringify(findings,null,2));
 assert.ok(findings.every(f=>f.violations.length===0),'Accessibility violations: '+JSON.stringify(findings.filter(f=>f.violations.length)));
 console.log(JSON.stringify(findings,null,2));await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
