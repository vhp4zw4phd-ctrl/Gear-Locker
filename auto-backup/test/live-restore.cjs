// Restores a backup written by auto-backup.js in the live Gear Locker app, then
// reads the app's database back with the module. Runs in a throwaway headless
// browser profile.  NODE_PATH=$(npm root -g) node auto-backup/test/live-restore.cjs
const { chromium } = require('playwright');
const fs = require('fs');
(async()=>{
 const b=await chromium.launch(); const ctx=await b.newContext(); const p=await ctx.newPage();
 await p.route('https://gear-locker.com/__ab/auto-backup.js', r=>r.fulfill({status:200,contentType:'text/javascript',body:fs.readFileSync(require('path').join(__dirname,'..','auto-backup.js'),'utf8')}));
 const dialogs=[]; p.on('dialog',async d=>{dialogs.push(d.type()+': '+d.message().slice(0,160)); await d.accept();});
 const mod='';
 await p.goto('https://gear-locker.com/gear-locker#/backup',{waitUntil:'networkidle'}); await p.waitForTimeout(1500);
 // build a backup file with our exporter from a seeded fake DB on this origin
 const json = await p.evaluate(async (src)=>{
   const m=await import('/__ab/auto-backup.js');
   const DB='gl-e2e-src', S=['gear','panels','patches','sessions','service','boards','photos','meta'];
   const db=await new Promise(r=>{const q=indexedDB.open(DB,2);q.onupgradeneeded=()=>S.forEach(s=>q.result.createObjectStore(s,{keyPath:s==='meta'?'key':'id'}));q.onsuccess=()=>r(q.result)});
   await new Promise(r=>{const t=db.transaction(['gear','patches'],'readwrite');
     t.objectStore('gear').put({id:'g-e2e-1',make:'Universal Audio',model:'1176LN',category:'Outboard'});
     t.objectStore('gear').put({id:'g-e2e-2',make:'Neve',model:'1073',category:'Preamp'});
     t.objectStore('patches').put({id:'p-e2e-1',gearId:'g-e2e-1',name:'Lead vox'}); t.oncomplete=r}); db.close();
   return m.readLockerFromIndexedDB(DB);
 }, mod);
 const tmp=require('path').join(require('os').tmpdir(),'gl-e2e-backup.json'); fs.writeFileSync(tmp, json);
 const body = await p.evaluate(()=>document.body.innerText.slice(0,300));
 console.log('page text:', body.replace(/\n+/g,' | '));
 // find restore input
 let input = await p.$('input[type=file][accept*="json"]');
 if(!input){ // skip onboarding if present
   for (const t of ['Skip','Continue','Get started']) { const el=await p.$(`text=${t}`); if(el){await el.click().catch(()=>{}); await p.waitForTimeout(500);} }
   await p.goto('https://gear-locker.com/gear-locker#/backup'); await p.waitForTimeout(1500);
   input = await p.$('input[type=file][accept*="json"]');
 }
 console.log('restore input found:', !!input);
 if(input){ await input.setInputFiles(tmp); await p.waitForTimeout(2500); }
 console.log('dialogs:', dialogs);
 // read back the app's real DB with our exporter (round trip)
 const rt = await p.evaluate(async (src)=>{const m=await import('/__ab/auto-backup.js');
   const j=JSON.parse(await m.readLockerFromIndexedDB('gear-locker')); return {gear:j.gear.map(g=>g.id+':'+(g.make||'')+' '+(g.model||'')), patches:j.patches.length, format:j.format};}, mod);
 console.log('round trip from app DB:', JSON.stringify(rt));
 const ok = dialogs.some(d=>/Restored 2 items/.test(d)) && rt.gear.length===2 && rt.patches===1;
 console.log(ok?'PASS  live app restores the auto-backup file':'FAIL'); process.exitCode = ok?0:1;
 await b.close();
})();
