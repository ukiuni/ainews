const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const repo = path.resolve(__dirname,'..');
const dataFile = path.join(repo,'data','items.json');
let items = JSON.parse(fs.readFileSync(dataFile,'utf8'));

async function translate(text){
  try{
    const res = await fetch('https://libretranslate.de/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:'en',target:'ja',format:'text'})});
    const j = await res.json();
    return j.translatedText;
  }catch(e){console.error('libre translate failed',e.message);return '';}
}

(async()=>{
  for(const it of items){
    try{
      if(!it.translated_title_ja || it.translated_title_ja.trim()===''){
        const t = await translate(it.title);
        if(t) it.translated_title_ja = t;
        console.log('translated title:', it.title.slice(0,60), '->', (t||'') .slice(0,60));
      }
      const looksEnglish = it.summary && /[a-z]{3,}/i.test(it.summary.slice(0,40));
      if(looksEnglish){
        const content = it.full_text || it.summary || it.short_summary || '';
        if(content){
          const s = await translate(content.slice(0,8000));
          if(s) it.summary = s;
          console.log('translated summary for:', it.title.slice(0,60));
        }
      }
    }catch(e){console.error('item fail',e.message)}
  }
  fs.writeFileSync(dataFile, JSON.stringify(items,null,2));
  console.log('done writing', dataFile);
})();
