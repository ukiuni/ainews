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
  // existing sources
  'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
  'https://feeds.feedburner.com/TechCrunch/',
  'https://www.theverge.com/rss/index.xml',
  // additional sources to increase coverage
  'https://www.wired.com/feed/rss',
  'https://www.engadget.com/rss.xml',
  'https://feeds.arstechnica.com/arstechnica/index',
  'https://www.theguardian.com/technology/rss',
  'https://www.zdnet.com/news/rss.xml'
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
      for(const it of feed.items.slice(0,50)){ // increased fetch limit per feed
        if(!it.link) continue;
        // check seen by link or title+pubDate
        const linkKey = it.link;
        const titleDateKey = (it.title||'') + '|' + (it.pubDate||'');
        if(seen.has(linkKey) || seen.has(titleDateKey)) continue;
        seen.add(linkKey); seen.add(titleDateKey);
        // create summary from available fields
        const rawSummary = it.contentSnippet || it.content || it.summary || '';
        newItems.push({
          title: it.title || '(no title)',
          link: it.link,
          pubDate: it.pubDate || new Date().toISOString(),
          source: feed.title || f,
          summary: rawSummary,
          short_summary: rawSummary ? (rawSummary.length>200? rawSummary.slice(0,197)+'...': rawSummary) : '',
          translated_title_ja: '',
          full_text: '' // placeholder for full article text if we fetch it
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

  const { JSDOM } = require('jsdom');

  // utility: limited concurrency pool for async tasks
  async function mapWithConcurrency(arr, limit, fn){
    const results = new Array(arr.length);
    let idx = 0;
    const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async ()=>{
      while(true){
        const i = idx++;
        if(i>=arr.length) break;
        try{ results[i] = await fn(arr[i], i); }catch(e){ results[i]=undefined; }
      }
    });
    await Promise.all(workers);
    return results;
  }

  // fetch full article bodies with concurrency limit (3)
  await mapWithConcurrency(newItems, 3, async (it)=>{
    try{
      if(!it.summary || it.summary.length < 120){
        try{
          const r = await fetch(it.link, { timeout: 10000 });
          if(r && r.ok){
            const html = await r.text();
            const dom = new JSDOM(html);
            // naive extraction: article tag or main tag or body text
            const articleEl = dom.window.document.querySelector('article') || dom.window.document.querySelector('main') || dom.window.document.body;
            const text = articleEl ? articleEl.textContent.replace(/\s+/g,' ').trim() : '';
            if(text && text.length>50) it.full_text = text;
          }
        }catch(e){ /* ignore fetch errors */ }
      }
    }catch(e){}
  });

  // scoring for AI relevance
  const aiKeywords = ['ai','artificial intelligence','machine learning','deep learning','neural','llm','gpt','chatbot','model','openai','transformer','language model','generator','reinforcement learning'];
  function scoreRelevance(it){
    const text = ((it.title||'') + ' ' + (it.summary||'') + ' ' + (it.full_text||'')).toLowerCase();
    let score = 0;
    for(const k of aiKeywords){
      const re = new RegExp(k.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&'),'g');
      const m = text.match(re);
      if(m) score += Math.min(m.length, 5); // cap per keyword
    }
    // boost for source names that are AI-focused (simple heuristic)
    if((it.source||'').toLowerCase().includes('ai')) score += 2;
    return score;
  }

  // compute relevance scores
  for(const it of newItems){ it._rel = scoreRelevance(it); }

  // close copilot session if opened (we'll use copilot for translations per-item later only for selected ones)
  // NOTE: keep session open if we created it earlier; we'll recreate if needed below.
  if(copilotSession){ try{ await copilotSession.destroy(); await copilotSession.client.stop(); }catch(e){} }

  // combine old items and new items for chronology but select top relevant 20 from newItems + oldItems pool
  const combined = newItems.concat(oldItems).sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
  // select candidates: take up to 50 most recent from combined, then score and choose top 20
  const recentCandidates = combined.slice(0,50);
  recentCandidates.sort((a,b)=> (b._rel||0) - (a._rel||0) || (new Date(b.pubDate)-new Date(a.pubDate)));
  const selected = recentCandidates.slice(0,20);

  // mark selected set for paging/render
  const selectedSet = new Set(selected.map(i=>i.link || (i.title+'|'+i.pubDate)));

  // final list: selected only, sorted by date desc
  const final = selected.sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));

  // ensure short_summary fields for final items and run translations/summaries for those only
  // Re-init copilot if available
  if(useCopilot){
    try{
      const client = new CopilotClient({ logLevel: 'error' });
      copilotSession = await client.createSession({ tools: [] });
    }catch(e){ console.error('copilot init failed', e.message); useCopilot = false; }
  }

  // For each final item, translate title and summarize if needed (sequential but limited by 3 concurrent ops)
  await mapWithConcurrency(final, 3, async (it)=>{
    if(it.title){
      try{
        if(useCopilot && copilotSession){
          it.translated_title_ja = await translateWithCopilot(copilotSession, it.title);
        }else{
          it.translated_title_ja = await translateWithLib(it.title);
        }
      }catch(e){ it.translated_title_ja = ''; }
    }
    try{
      if(useCopilot && copilotSession){
        const contentText = it.full_text || it.content || it.contentSnippet || it.summary || '';
        if(contentText){
          const s = await summarizeWithCopilot(copilotSession, contentText);
          if(s) it.summary = s;
        }
      }
    }catch(e){ /* ignore */ }
    it.short_summary = it.summary ? (it.summary.length>200? it.summary.slice(0,197)+'...': it.summary) : '';
  });

  if(copilotSession){ try{ await copilotSession.destroy(); await copilotSession.client.stop(); }catch(e){} }

  // final is already selected and processed
  // keep unique by link + title+pubDate hash
  const uniq = [];
  const seen2 = new Set();
  for(const it of items){
    const key = (it.link||'') + '|' + (it.title||'') + '|' + (it.pubDate||'');
    if(seen2.has(key)) continue;
    seen2.add(key);
    uniq.push(it);
  }
  // trim to 300 (keep more history)
  const final = uniq.slice(0,300);
  fs.writeFileSync(itemsFile,JSON.stringify(final,null,2));

  // generate paginated HTML pages (20 per page)
  const perPage = 20;
  const totalPages = Math.ceil(final.length / perPage) || 1;
  for(let p=1;p<=totalPages;p++){
    const start=(p-1)*perPage; const pageItems = final.slice(start,start+perPage);
    const rows = pageItems.map(it=>{
      const ja = it.translated_title_ja? `<p class="jp">${it.translated_title_ja}</p>` : '';
      // prefer Japanese summary (it.summary may already be Japanese). fallback to short_summary.
      let summaryText = it.summary || it.short_summary || '';
      // normalize whitespace
      summaryText = summaryText.replace(/\s+/g,' ').trim();
      // target length: approx 100 ±20 characters -> cap at 120, don't expand short ones
      const maxLen = 120;
      if(summaryText.length > maxLen){
        summaryText = summaryText.slice(0, maxLen-1) + '…';
      }
      const summaryHtml = summaryText ? `<p class="summary">${summaryText}</p>` : '';
      return `<article><h2><a href="${it.link}" target="_blank" rel="noopener">${it.title}</a></h2>${ja}<p class="meta">${it.source} — ${new Date(it.pubDate).toLocaleString()}</p>${summaryHtml}</article>`
    }).join('\n');
    const nav = `<div class="pager">${p>1?`<a href="/page/${p-1}.html">Prev</a>`:''} ${p<totalPages?`<a href="/page/${p+1}.html">Next</a>`:''}</div>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI News — page ${p}</title><link rel="stylesheet" href="/styles.css"></head><body><main><h1>AI News</h1>${rows}${nav}</main></body></html>`;
    const outdir = p===1? path.join(distDir): path.join(distDir,'page');
    if(!fs.existsSync(outdir)) fs.mkdirSync(outdir,{recursive:true});
    const out = p===1? path.join(distDir,'index.html'): path.join(outdir,`${p}.html`);
    fs.writeFileSync(out,html);
  }
  // write simple stylesheet
  fs.writeFileSync(path.join(distDir,'styles.css'),`body{font-family:Inter,system-ui,Arial;margin:24px;background:#fff;color:#111}main{max-width:800px;margin:0 auto}article{padding:12px 0;border-bottom:1px solid #eee}h1{font-size:26px}h2{font-size:18px;margin:6px 0}p.jp{margin:4px 0 0;color:#333;font-size:14px;font-weight:600}p.meta{color:#666;font-size:12px}p.summary{margin-top:8px;font-size:14px;line-height:1.4}`);
  // generate RSS for latest 20
  const rssItems = final.slice(0,20).map(it=>`<item><title><![CDATA[${it.title}]]></title><link>${it.link}</link><pubDate>${new Date(it.pubDate).toUTCString()}</pubDate><description><![CDATA[${it.summary}]]></description></item>`).join('\n');
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>AI News</title><link>https://ainews.ukiuni.com/</link><description>AI related news</description>${rssItems}</channel></rss>`;
  fs.writeFileSync(path.join(distDir,'rss.xml'),rss);
  console.log('built',final.length,'items');
})();
