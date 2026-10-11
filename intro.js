(()=>{"use strict";
  const intro=document.getElementById("appIntro");
  if(!intro)return;
  // 시작화면은 앱을 새로 실행했을 때 한 번만 재생합니다.
  // (같은 실행 중 재고 탭으로 돌아오거나 화면을 이동할 때는 다시 재생하지 않음)
  const KEY="sj-intro-played";
  let played=false;
  try{played=sessionStorage.getItem(KEY)==="1"}catch(e){}
  if(played){intro.remove();return}
  try{sessionStorage.setItem(KEY,"1")}catch(e){}
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
