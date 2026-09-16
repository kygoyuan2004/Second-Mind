// Deterministic inventory cards: all labels/counts/pages come from the backend.
const labels={queued:'等待扫描',scanning:'正在枚举文件',verifying:'正在复查文件与目录变化',completed:'文件清单扫描完成',incomplete:'文件清单不完整',interrupted:'扫描已中断',cancelled:'扫描已取消',failed:'扫描失败'};
const active=new Set(['queued','scanning','verifying']);
function el(tag,text,cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; }
function time(value) { return value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'不限'; }
export function mountInventory(host,{id,conversationId,api,fileUrl,onRescan}) {
  const card=el('section',undefined,'knowledge-inventory'); card.dataset.inventoryId=id; host.append(card);
  let cursor='', stack=[],generation=0,timer;
  async function load() {
    const current=++generation;
    try {
      const query=new URLSearchParams({conversationId,cursor});
      const r=await api(`/api/knowledge/inventories/${encodeURIComponent(id)}?${query}`);
      if(current!==generation || !card.isConnected)return;
      clearTimeout(timer); card.replaceChildren(); card.dataset.status=r.status;
      card.append(el('h3',labels[r.status]||r.status),el('p',r.range.disclaimer));
      card.append(el('p',`${r.range.scope==='all'?'全部普通文件':'Markdown 文件（含 .MD）'} · Asia/Shanghai（北京时间） · ${r.range.source}`));
      card.append(el('p',`时间区间：[${time(r.range.start)}, ${time(r.range.end)})；起点包含，终点不包含。日期形式的结束值已换算至次日零点。`));
      card.append(el('p',`已发现 ${r.discovered}／已处理 ${r.processed}${r.matched===null?'':` · 匹配 ${r.matched}`} · 排除 ${r.excludedCount} · 失败 ${r.failedCount} · 变化 ${r.changedCount}`,'inventory-stats'));
      card.append(el('small',`开始：${time(r.startedAt)}；结束：${r.finishedAt?time(r.finishedAt):'扫描中'}。${r.range.exclusions}`));
      if(r.entries.length) {
        const wrap=el('div',undefined,'inventory-table-wrap'),table=el('table'),head=el('tr');
        for(const title of ['文件','大小','最后修改时间（北京时间）'])head.append(el('th',title));
        const thead=el('thead'); thead.append(head); const tbody=el('tbody');
        for(const f of r.entries) {const row=el('tr'),cell=el('td'),link=el('a',f.path); link.href=fileUrl(f.path);link.target='_blank';link.rel='noopener';cell.append(link);row.append(cell,el('td',`${f.size.toLocaleString()} B`),el('td',time(f.mtime)));tbody.append(row);}
        table.append(thead,tbody);wrap.append(table);card.append(wrap);
      } else if(!active.has(r.status)) card.append(el('p',r.status==='completed'?'没有符合范围的文件。':'本次没有可显示的匹配文件；请查看扫描缺口。'));
      const nav=el('div',undefined,'inventory-actions');
      const button=(label,handler,disabled=false)=>{const b=el('button',label);b.type='button';b.disabled=disabled;b.onclick=()=>{b.disabled=true;Promise.resolve(handler()).catch(e=>{card.append(el('p',e.message));b.disabled=false;});};nav.append(b);};
      if(!active.has(r.status)) {
        button('上一页',()=>{cursor=stack.pop()||'';return load();},!stack.length);
        nav.append(el('span',`${r.matched?Math.floor(r.offset/50)+1:0} / ${Math.ceil(r.matched/50)} 页（每页 50 条）`));
        button('下一页',()=>{stack.push(cursor);cursor=r.nextCursor;return load();},!r.nextCursor);
        const scope=el('select');scope.setAttribute('aria-label','文件清单范围');for(const [value,label]of [['markdown','Markdown 笔记'],['all','全部文件（含图片和附件）']]){const o=el('option',label);o.value=value;o.selected=value===r.range.scope;scope.append(o);}nav.append(scope);
        button('重新扫描',()=>onRescan({scope:scope.value,start:r.range.start||undefined,end:r.range.end||undefined,timeZone:'Asia/Shanghai',allTime:r.range.start===null}));
      } else {
        button('取消扫描',async()=>{await api(`/api/knowledge/inventories/${encodeURIComponent(id)}/cancel?conversationId=${encodeURIComponent(conversationId)}`,{method:'POST'});return load();});
        timer=setTimeout(()=>{if(card.isConnected)load();},800);
      }
      card.append(nav);
      for(const [key,title]of [['excluded','排除路径'],['errors','访问失败'],['changes','扫描期间变化']])if(r[key]?.length){const details=el('details'),summary=el('summary',`${title}（${r[key].length}）`),list=el('ul');for(const issue of r[key])list.append(el('li',`${issue.path}：${issue.reason}`));details.append(summary,list);card.append(details);}
    } catch(error) {if(current===generation){card.replaceChildren(el('p',`无法加载文件清单：${error.message}`));const retry=el('button','重试');retry.type='button';retry.onclick=load;card.append(retry);}}
  }
  load(); return {refresh:load};
}
