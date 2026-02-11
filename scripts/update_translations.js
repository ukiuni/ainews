(async ()=>{
  const fs = require('fs');
  const path = require('path');
  const repo = path.resolve(__dirname,'..');
  const dataFile = path.join(repo,'data','items.json');
  if(!fs.existsSync(dataFile)) { console.error('items.json missing'); process.exit(1); }
  let items = JSON.parse(fs.readFileSync(dataFile,'utf8'));

  // dynamic import to avoid CommonJS export issues
  let copilotModule;
  try{
    copilotModule = await import('@github/copilot-sdk');
  }catch(e){
    console.error('copilot-sdk import failed:', e.message);
    process.exit(1);
  }
  const { CopilotClient } = copilotModule;

  async function run(){
    const client = new CopilotClient({ logLevel:'error' });
    await client.start();
    const session = await client.createSession({ model: 'gpt-5-mini' });

    for(const it of items){
      try{
        if(!it.translated_title_ja || it.translated_title_ja.trim()===''){
          const prompt = `Translate the following title to Japanese (polite form) and return only the translated text:\n\n${it.title}`;
          const res = await session.sendAndWait({ prompt });
          const t = res && res.data && res.data.content ? String(res.data.content).trim() : '';
          if(t) it.translated_title_ja = t;
        }
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

    fs.writeFileSync(dataFile, JSON.stringify(items,null,2));
    console.log('updated items.json with translations/summaries');
    await session.destroy();
    await client.stop();
  }

  run().catch(e=>{console.error(e);process.exit(1)});
})();
