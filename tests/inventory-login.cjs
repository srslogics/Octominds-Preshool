const { chromium } = require('playwright');
const ORIGIN=process.env.TEST_APP_ORIGIN || 'http://127.0.0.1:4179';
const assert=require('node:assert/strict');
const A='00000000-0000-0000-0000-000000000101', B='00000000-0000-0000-0000-000000000102';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
 const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 let delay=false, role='super_admin', failedOnce=false, failMovement=false, rejectAuth=false, tokenCounter=0;
 let requests=[]; const writes=[];
 const items=[{id:'itemA',branch_id:A,category_id:'catA',name:'Center A books',sku:'A-BOOK',unit:'piece',reorder_level:2,standard_cost:0,description:'notes',quantity_on_hand:10,stock_status:'healthy',category_name:'Books',location_names:['Store A']},{id:'itemB',branch_id:B,category_id:'catB',name:'Center B crayons',sku:'B-CRAYON',unit:'piece',reorder_level:2,standard_cost:5,description:null,quantity_on_hand:0,stock_status:'out',category_name:'Art',location_names:[]}];
 const lookup={branches:[{id:A,name:'Center A'},{id:B,name:'Center B'}],categories:[{id:'catA',branch_id:A,name:'Books'},{id:'catB',branch_id:B,name:'Art'}],locations:[{id:'locA',branch_id:A,name:'Store A'},{id:'locB',branch_id:B,name:'Store B'}],items};
 await page.route('**/config.js',r=>r.fulfill({contentType:'application/javascript',body:`window.OCTOMINDS_CONFIG={supabaseUrl:'https://audit.supabase.co',supabaseAnonKey:'test-public-key',apiBaseUrl:'${ORIGIN}'};`}));
 await page.route('https://audit.supabase.co/**',r=>{requests.push(r.request().url()); return r.fulfill({json:{access_token:'test-access-token-'+(++tokenCounter),refresh_token:'test-refresh-token',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'audit-user'}}});});
 await page.route('**/api/v1/**',async r=>{
   const req=r.request(),u=new URL(req.url()); requests.push(u.pathname+u.search);
   if(rejectAuth) return r.fulfill({status:401,json:{detail:'Invalid access token'}});
   if(u.pathname.endsWith('/session'))return r.fulfill({json:{id:'audit-user',full_name:'Audit User',role,role_label:role,branch_id:null}});
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
 await page.locator('#phone').click();
 assert.equal(await page.locator('#rememberSession').isChecked(),false);
 await page.locator('#phone').fill('9999999999');
 await page.waitForTimeout(200);
 assert.equal(requests.filter(x=>x.includes('grant_type=password')).length,0);
 assert.equal(await page.locator('#appView').isVisible(),false);
 await page.locator('#pin').fill('123456');
 await page.locator('#loginForm button[type=submit]').click();
 await page.locator('#appView').waitFor();
 await page.route('**/api/v1/session',async r=>{
   await new Promise(resolve=>setTimeout(resolve,1200));
   await r.fulfill({json:{id:'audit-user',full_name:'Audit User',role:'super_admin',role_label:'Super Admin',branch_id:null}});
 });
 await page.reload();
 await page.locator('#sessionCheck').waitFor();
 assert.equal(await page.locator('#loginForm').isVisible(),false);
 await page.locator('#appView').waitFor();
 await page.locator('#logoutButton').click();
 await page.locator('#phone').waitFor();
 await page.locator('#phone').click();
 assert.equal(await page.locator('#appView').isVisible(),false);
 assert.equal(await page.locator('#pin').inputValue(),'');
 assert.deepEqual(errors,[]);
 console.log('PASS: phone focus does not authenticate; remember is opt-in; saved-session check hides form; signout stays signed out');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

