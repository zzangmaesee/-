(()=>{"use strict";
  const intro=document.getElementById("appIntro");
  if(!intro)return;
  let closing=false;
  const close=()=>{
    if(closing)return;
    closing=true;
    intro.classList.add("out");
    window.setTimeout(()=>intro.remove(),320);
  };
  intro.addEventListener("pointerup",close,{once:true});
  const reduced=window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const start=()=>{
    intro.classList.add("ready");
    window.setTimeout(close,reduced?800:2000);
  };
  if(document.fonts?.ready)document.fonts.ready.then(start,start);
  else start();
})();
