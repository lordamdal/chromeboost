"use strict";(()=>{var v=document.getElementById("groups"),C=document.getElementById("status-pill"),M={claude:{src:"icons/host-claude.png",label:"Claude"},codex:{src:"icons/host-codex.png",label:"Codex"},gemini:{src:"icons/host-gemini.png",label:"Gemini"}};function B(t){let e=M[t];return e||{src:null,label:t.charAt(0).toUpperCase()+t.slice(1)}}var b=new Set;function w(){document.body.style.height="auto",document.body.style.height=document.body.scrollHeight+"px"}async function H(){let[t,e,o]=await Promise.all([chrome.storage.local.get(["chromeboostLivePorts","claudeInstances"]),chrome.windows.getCurrent(),chrome.windows.getAll()]),i=(t.chromeboostLivePorts??[]).map(s=>typeof s=="number"?{port:s}:s),c=t.claudeInstances??{},l=new Set(o.map(s=>s.id).filter(Boolean)),u=!1;for(let s of Object.keys(c))l.has(c[s])||(delete c[s],u=!0);return u&&await chrome.storage.local.set({claudeInstances:c}),{livePorts:i,instances:c,currentWindowId:e.id,validWindowIds:l}}function E(t){return t.replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e])}function q(t,e,o,a,i,c){let l=i===c,u=["instance"];l&&u.push("this-window"),a||u.push("offline");let s=e??`Port ${t}`,r=e?"instance-name":"instance-name unlabeled",p=[];e&&p.push(`Port ${t}`),a||p.push('<span class="meta-tag unassigned">offline</span>'),i?p.push(l?'<span class="meta-tag">\u2713 this window</span>':`<a class="meta-tag elsewhere go-to-window" href="#" data-window-id="${i}">go to window \u2192</a>`):p.push('<span class="meta-tag unassigned">unassigned</span>');let m=p.join('<span class="meta-sep">\xB7</span>'),d=`
    <div class="btn-row">
      <button class="btn btn-primary" data-action="set" data-port="${t}"${l?" disabled":""}>${l?"\u2713 Assigned to this window":i?"Use this window instead":"Use this window"}</button>
      ${i?`<button class="btn btn-secondary" data-action="clear" data-port="${t}">Clear</button>`:""}
    </div>
  `,g="";if(o){let h=B(o),y=h.src?`<img class="host-icon" src="${h.src}" alt="" />`:"";g=`<div class="host-badge" title="${E(h.label)} session"><span class="host-label">${E(h.label)}</span>${y}</div>`}return`
    <div class="${u.join(" ")}" style="view-transition-name: card-${t}">
      <div class="instance-row">
        <div class="dot ${a?"connected":""}"></div>
        <div class="${r}">${E(s)}</div>
        ${g}
      </div>
      <div class="instance-meta">${m}</div>
      ${d}
    </div>
  `}function L(t,e,o,a,i){if(o.length===0&&!i)return"";let c=a&&b.has(t),l=["group"];c&&l.push("collapsed");let u=a?"group-header":"group-header static",s=o.length>0?`<div class="group-body">${o.join("")}</div>`:`<div class="group-body"><div class="empty">${i}</div></div>`,r=o.length>0?`<span class="group-count">${o.length}</span>`:"",p=a?'<span class="group-toggle">\u25BE</span>':"";return`
    <div class="${l.join(" ")}" data-group="${t}">
      <div class="${u}" data-toggle-group="${a?t:""}">
        <span class="group-title">${e}</span>
        <span class="group-right">${r}${p}</span>
      </div>
      ${s}
    </div>
  `}function $(t){let e=new Map,o=new Map;for(let n of t.livePorts)n.label&&e.set(n.port,n.label),n.host&&o.set(n.port,n.host);let a=new Map,i=new Map;for(let[n,d]of e){let g=(a.get(d)??0)+1;a.set(d,g),i.set(n,g>1?`${d} (${g-1})`:d)}for(let[n,d]of e)if((a.get(d)??0)>1&&i.get(n)===d){let g=0;for(let[h]of e)e.get(h)===d&&(g++,i.set(h,g===1?d:`${d} (${g-1})`))}let c=new Set([...t.livePorts.map(n=>n.port),...Object.keys(t.instances).map(Number)]),l=Array.from(c).sort((n,d)=>n-d);if(l.length===0){v.innerHTML=`
      <div class="empty empty-onboard">
        <div class="empty-title">No Claude Code sessions yet</div>
        <div class="empty-subtitle">Get connected in two steps:</div>
        <div class="empty-steps">
          <div class="empty-step">
            <div class="step-num">1</div>
            <div class="step-body">
              Add &amp; install the ChromeBoost plugin in Claude Code:
              <code>/plugin marketplace add /path/to/ChromeBoost</code>
              <code>/plugin install chromeboost</code>
            </div>
          </div>
          <div class="empty-step">
            <div class="step-num">2</div>
            <div class="step-body">
              Open Claude Code in your project \u2014 sessions show up here automatically.
            </div>
          </div>
        </div>
      </div>
    `;return}let u=[],s=[],r=[];for(let n of l){let d=t.livePorts.some(A=>A.port===n),g=i.get(n)??e.get(n),h=o.get(n),y=t.instances[String(n)],x=q(n,g,h,d,y,t.currentWindowId);y===t.currentWindowId?u.push(x):y?s.push(x):r.push(x)}let p=[];p.push(L("this","This window",u,!1,"No session assigned to this window yet \u2014 use a card below.")),s.length>0&&p.push(L("others","Other windows",s,!0)),r.length>0&&p.push(L("unassigned","Unassigned",r,!0)),v.innerHTML=p.join("");for(let n of v.querySelectorAll(".group:not(.collapsed) .group-body"))n.style.maxHeight=n.scrollHeight+"px";w();let m=t.livePorts.length,f=C.querySelector(".pill-text");m>0?(C.classList.remove("idle"),f.textContent=`${m} active`):(C.classList.add("idle"),f.textContent="No active sessions")}function W(t){let e=document;typeof e.startViewTransition=="function"?e.startViewTransition(()=>{$(t)}):$(t)}v.addEventListener("click",async t=>{let e=t.target,o=e.closest(".go-to-window");if(o){t.preventDefault();let s=Number(o.getAttribute("data-window-id"));s&&chrome.windows.update(s,{focused:!0});return}let a=e.closest("[data-toggle-group]")?.getAttribute("data-toggle-group");if(a){let s=v.querySelector(`[data-group="${a}"]`),r=s?.querySelector(".group-body"),p=b.has(a);p?b.delete(a):b.add(a),s&&r?p?(s.classList.remove("collapsed"),r.style.maxHeight="0",requestAnimationFrame(()=>{r.style.maxHeight=r.scrollHeight+"px";let m=()=>{r.removeEventListener("transitionend",m),w()};r.addEventListener("transitionend",m),w()}),s.querySelector(".group-toggle").removeAttribute("style")):(r.style.maxHeight=r.scrollHeight+"px",requestAnimationFrame(()=>{s.classList.add("collapsed");let m=()=>{r.removeEventListener("transitionend",m),w()};r.addEventListener("transitionend",m);let f=()=>{s.classList.contains("collapsed")&&(w(),r.offsetHeight>0&&requestAnimationFrame(f))};requestAnimationFrame(f)})):$(await H());return}let i=e.getAttribute("data-action"),c=e.getAttribute("data-port");if(!i||!c)return;let{claudeInstances:l}=await chrome.storage.local.get("claudeInstances"),u=l??{};if(i==="set"){let s=await chrome.windows.getCurrent();u[c]=s.id}else i==="clear"&&delete u[c];await chrome.storage.local.set({claudeInstances:u}),W(await H())});b.add("others");b.add("unassigned");chrome.runtime.onMessage.addListener(t=>{t.source==="chromeboost-offscreen"&&t.type==="status"&&H().then(e=>{$(e),w()})});var P="cbHudState";async function S(){let e=(await chrome.storage.local.get(P))[P];return{x:e?.x??-1,y:e?.y??12,collapsed:e?.collapsed??!1,hidden:e?.hidden??!1}}function I(t){let e=document.getElementById("hud-toggle"),o=document.getElementById("hud-collapse");e&&(e.textContent=t.hidden?"Show":"Hide"),o&&(o.textContent=t.collapsed?"Expand":"Collapse",o.disabled=t.hidden)}async function T(t){let e=await S();t==="hide"&&(e.hidden=!0),t==="show"&&(e.hidden=!1),t==="collapse"&&(e.collapsed=!0),t==="expand"&&(e.collapsed=!1),await chrome.storage.local.set({[P]:e}),I(e);let[o]=await chrome.tabs.query({active:!0,currentWindow:!0});o?.id&&chrome.tabs.sendMessage(o.id,{type:"hud_control",requestId:`popup-${Date.now()}`,action:t}).catch(()=>{})}document.getElementById("hud-toggle")?.addEventListener("click",async()=>{let t=await S();await T(t.hidden?"show":"hide")});document.getElementById("hud-collapse")?.addEventListener("click",async()=>{let t=await S();await T(t.collapsed?"expand":"collapse")});S().then(I);H().then(t=>{$(t),requestAnimationFrame(()=>document.body.classList.add("ready"))});})();
