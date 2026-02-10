const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(m=>m.default(...args));
const { CopilotClient } = require('@github/copilot-sdk');

const repo = path.resolve(__dirname,'..');
const dataFile = path.join(repo,'data','items.json');
if(!fs.existsSync(dataFile)) { console.error('items.json missing'); process.exit(1); }
let items = JSON.parse(fs.readFileSync(dataFile,'utf8'));

async function main(){
  let client, session;
  try{
    client = new CopilotClient({ logLevel:'error' });
    session = await client.createSession({ tools: [] });
  }catch(e){ console.error('copilot init failed, abort',e.message); process.exit(1); }

  for(const it of items){
    try{
      if(!it.translated_title_ja || it.translated_title_ja.trim()===''){
        const prompt = `Translate the following title to Japanese (polite form) and return only the translated text:\n\n${it.title}`;
        const res = await session.sendAndWait({ prompt });
        const t = res && res.data && res.data.content ? String(res.data.content).trim() : '';
        if(t) it.translated_title_ja = t;
      }
      // if summary looks English, regenerate using full_text if present
      const looksEnglish = it.summary && /[a-z]{3,}/i.test(it.summary.slice(0,40));
      if(looksEnglish){
        const content = it.full_text || it.summary || it.short_summary || '';
        if(content){
          const sprompt = `Summarize the following article content in Japanese (polite form). Keep it concise (about 2 sentences):\n\n${content}`;
          const r2 = await session.sendAndWait({ prompt: sprompt });
          const s = r2 && r2.data && r2.data.content ? String(r2.data.content).trim() : '';
          if(s) it.summary = s;
        }
      }
    }catch(e){ console.error('item update failed', e.message); }
  }

  // write back
  fs.writeFileSync(dataFile, JSON.stringify(items,null,2));
  console.log('updated items.json with translations/summaries');
  await session.destroy();
  await client.stop();
}

main().catch(e=>{console.error(e);process.exit(1)});
