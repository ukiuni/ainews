const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const parser = new Parser();
const fetch = (...args) => import('node-fetch').then(m=>m.default(...args));

const repoRoot = path.resolve(__dirname,'..');
const dataDir = path.join(repoRoot,'data');
const distDir = path.join(repoRoot,'dist');
const tmplDir = path.join(repoRoot,'templates');
if(!fs.existsSync(dataDir)) fs.mkdirSync(dataDir,{recursive:true});
if(!fs.existsSync(distDir)) fs.mkdirSync(distDir,{recursive:true});

const feeds = [
  'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
  'https://feeds.feedburner.com/TechCrunch/',
  'https://www.theverge.com/rss/index.xml'
];

(async()=>{
  const itemsFile = path.join(dataDir,'items.json');
  let oldItems = [];
  if(fs.existsSync(itemsFile)) oldItems = JSON.parse(fs.readFileSync(itemsFile,'utf8'));
  const seen = new Set(oldItems.map(i=>i.link));
  let newItems = [];
  for(const f of feeds){
    try{
      const feed = await parser.parseURL(f);
      for(const it of feed.items.slice(0,20)){
        if(!it.link) continue;
        if(seen.has(it.link)) continue;
        // create summary from available fields
        const rawSummary = it.contentSnippet || it.content || it.summary || '';
        newItems.push({
          title: it.title || '(no title)',
          link: it.link,
          pubDate: it.pubDate || new Date().toISOString(),
          source: feed.title || f,
          summary: rawSummary,
          short_summary: rawSummary ? (rawSummary.length>200? rawSummary.slice(0,197)+'...': rawSummary) : '',
          translated_title_ja: ''
        });
      }
    }catch(e){
      console.error('feed err',f,e.message);
    }
  }
  // Try to use Copilot SDK for translation (local copilot CLI required). If unavailable, fall back to LibreTranslate.
  let useCopilot = false;
  let CopilotClient;
  try{
    CopilotClient = require('@github/copilot-sdk').CopilotClient;
    useCopilot = true;
  }catch(e){ useCopilot = false; }

  async function translateWithLib(text){
    try{
      const res = await fetch('https://libretranslate.com/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:'en',target:'ja',format:'text'})});
      if(!res.ok) return '';
      const j = await res.json();
      return j.translatedText || '';
    }catch(e){console.error('translate err',e.message);return ''}
  }

  async function translateWithCopilot(session, text){
    // simple instruction: translate to Japanese in polite form
    const prompt = `Translate the following title to Japanese (polite form) and return only the translated text:\n\n${text}`;
    const res = await session.sendAndWait({ prompt });
    return (res && res.data && res.data.content) ? String(res.data.content).trim() : '';
  }

  async function summarizeWithCopilot(session, text){
    // instruction: produce a short Japanese summary (approx 2-3 sentences)
    const prompt = `Summarize the following article content in Japanese (polite form). Keep it concise (about 2 sentences):\n\n${text}`;
    const res = await session.sendAndWait({ prompt });
    return (res && res.data && res.data.content) ? String(res.data.content).trim() : '';
  }

  let copilotSession = null;
  if(useCopilot){
    try{
      const client = new CopilotClient({ logLevel: 'error' });
      copilotSession = await client.createSession({ tools: [] });
    }catch(e){ console.error('copilot init failed', e.message); useCopilot = false; }
  }

  for(const it of newItems){
    if(it.title){
      try{
        if(useCopilot && copilotSession){
          it.translated_title_ja = await translateWithCopilot(copilotSession, it.title);
        }else{
          it.translated_title_ja = await translateWithLib(it.title);
        }
      }catch(e){ it.translated_title_ja = ''; }
    }

    // generate summary: prefer copilot (using content if available), otherwise fallback to short_summary
    try{
      if(useCopilot && copilotSession){
        const contentText = it.content || it.contentSnippet || it.summary || '';
        if(contentText){
          const s = await summarizeWithCopilot(copilotSession, contentText);
          it.summary = s || it.summary;
        }
      }
    }catch(e){ /* ignore, keep existing summary */ }

    // ensure short_summary exists
    it.short_summary = it.summary ? (it.summary.length>200? it.summary.slice(0,197)+'...': it.summary) : '';
  }

  // close copilot session if opened
  if(copilotSession){ try{ await copilotSession.destroy(); await copilotSession.client.stop(); }catch(e){} }

  // combine and sort desc
  const items = newItems.concat(oldItems).sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
  // keep unique by link
  const uniq = [];
  const seen2 = new Set();
  for(const it of items){ if(seen2.has(it.link)) continue; seen2.add(it.link); uniq.push(it); }
  // trim to 100
  const final = uniq.slice(0,100);
  fs.writeFileSync(itemsFile,JSON.stringify(final,null,2));

  // generate paginated HTML pages (20 per page)
  const perPage = 20;
  const totalPages = Math.ceil(final.length / perPage) || 1;
  for(let p=1;p<=totalPages;p++){
    const start=(p-1)*perPage; const pageItems = final.slice(start,start+perPage);
    const rows = pageItems.map(it=>`<article><h2><a href="${it.link}" target="_blank" rel="noopener">${it.title}</a></h2>${it.translated_title_ja?`<p class="jp">${it.translated_title_ja}</p>`:''}<p class="meta">${it.source} — ${new Date(it.pubDate).toLocaleString()}</p><p class="summary">${it.short_summary||it.summary}</p></article>`).join('\n');
    const nav = `<div class="pager">${p>1?`<a href="/page/${p-1}.html">Prev</a>`:''} ${p<totalPages?`<a href="/page/${p+1}.html">Next</a>`:''}</div>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI News — page ${p}</title><link rel="stylesheet" href="/styles.css"></head><body><main><h1>AI News</h1>${rows}${nav}</main></body></html>`;
    const outdir = p===1? path.join(distDir): path.join(distDir,'page');
    if(!fs.existsSync(outdir)) fs.mkdirSync(outdir,{recursive:true});
    const out = p===1? path.join(distDir,'index.html'): path.join(outdir,`${p}.html`);
    fs.writeFileSync(out,html);
  }
  // write simple stylesheet
  fs.writeFileSync(path.join(distDir,'styles.css'),`body{font-family:Inter,system-ui,Arial;margin:24px;background:#fff;color:#111}main{max-width:800px;margin:0 auto}article{padding:12px 0;border-bottom:1px solid #eee}h1{font-size:26px}h2{font-size:18px;margin:6px 0}p.meta{color:#666;font-size:12px}p.summary{margin-top:8px}`);
  // generate RSS for latest 20
  const rssItems = final.slice(0,20).map(it=>`<item><title><![CDATA[${it.title}]]></title><link>${it.link}</link><pubDate>${new Date(it.pubDate).toUTCString()}</pubDate><description><![CDATA[${it.summary}]]></description></item>`).join('\n');
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>AI News</title><link>https://ainews.ukiuni.com/</link><description>AI related news</description>${rssItems}</channel></rss>`;
  fs.writeFileSync(path.join(distDir,'rss.xml'),rss);
  console.log('built',final.length,'items');
})();
