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
   if(u.pathname.endsWith('/items/itemA'))return r.fulfill({json:{...items[0],balances:[]}});
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
 await page.goto(ORIGIN+'/#/overview');
 await page.locator('#phone').fill('9999999999');await page.locator('#pin').fill('123456');
 await page.locator('#loginForm button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#inventoryActiveItems').textContent==='2');
 await page.waitForTimeout(200);
 assert.deepEqual(errors, [], 'no startup errors');
 assert.equal(await page.locator('#stockCatalogue').isVisible(),false);
 for(const name of ['items','movements','transfers','centers','reports','settings']){
   await page.locator('[data-page="'+name+'"]').click();
   await page.waitForTimeout(200);
   assert.ok(page.url().includes('#/'+name));
   assert.equal(await page.locator('.inventory-metrics').isVisible(),false);
   if(name==='items')assert.equal(await page.locator('#stockCatalogue').isVisible(),true);
   else assert.equal(await page.locator('#stockCatalogue').isVisible(),false);
   await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
   const violations=await page.evaluate(async()=> (await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,reason:n.failureSummary}))})));
   assert.deepEqual(violations,[],name);
   for (const width of [320,390,768,1440]) {
     await page.setViewportSize({width,height:900});
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' overflow '+width);
     const controls=await page.evaluate(()=>{
       const select=document.querySelector('#inventoryBranchSelect').getBoundingClientRect();
       const menu=document.querySelector('.more-menu summary').getBoundingClientRect();
       return {height:select.height,menuHeight:menu.height,top:select.top,menuTop:menu.top};
     });
     assert.equal(controls.height,44);assert.equal(controls.menuHeight,44);
     assert.ok(Math.abs(controls.top-controls.menuTop)<1,'center controls aligned');
   }
 }
 await page.goBack();await page.waitForTimeout(150);assert.ok(page.url().includes('#/reports'));
 await page.reload();await page.locator('#reportStatus').waitFor();
 await page.locator('[data-page="items"]').click();
 await page.locator('.item-detail-link').first().click();
 await page.locator('#routeContent h2').waitFor();
 assert.equal(await page.locator('#routeContent h2').innerText(),'Center A books');
 assert.equal(await page.locator('#stockCatalogue').isVisible(),false);
 await page.reload();await page.locator('#routeContent h2').waitFor();
 await page.locator('[data-page="overview"]').click();
 await page.screenshot({path:'/tmp/octominds-routed-overview.png',fullPage:true});
 await page.locator('[data-page="items"]').click();
 await page.screenshot({path:'/tmp/octominds-routed-items.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('[data-page="movements"]').click();await page.locator('#historyType').selectOption('issue');
 await page.waitForTimeout(200);
 assert.ok(requests.some(u=>u.includes('movement_type=issue')));
 await page.locator('[data-page="transfers"]').click();await page.waitForTimeout(200);
 assert.ok(requests.some(u=>u.includes('movement_type=transfer')));
 await page.locator('#inventoryBranchSelect').selectOption(A);
 await page.waitForFunction(()=>!document.querySelector('#refreshInventory').disabled);
 await page.locator('[data-page-stock="transfer"]').click();
 await page.locator('#inventoryMovementDialog').waitFor();
 assert.equal(await page.locator('#movementDestinationField').isVisible(),true);
 await page.locator('#inventoryMovementDialog [data-close-dialog]').first().click();
 await page.locator('[data-page="items"]').click();
 await page.locator('[data-page-action="item"]').click();
 await page.locator('#inventoryItemDialog').waitFor();
 await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
 assert.deepEqual(await page.evaluate(async()=> (await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,reason:n.failureSummary}))}))),[]);
 await page.screenshot({path:'/tmp/octominds-premium-mobile-form.png',fullPage:true});
 await page.locator('#inventoryItemDialog [data-close-dialog]').first().click();
 await page.screenshot({path:'/tmp/octominds-premium-mobile-items.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: isolated screens, history, refresh, filters, mobile width and accessibility');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

