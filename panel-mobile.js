function panelMobileHtml(role = "client") {
  const admin = role === "admin";
  return `<style id="evetec-panel-mobile">
    .evetec-panel{color-scheme:dark;background:radial-gradient(ellipse at 85% 0,rgba(33,126,158,.14),transparent 42%),#07111e;color:#eff8ff;font-family:Inter,Segoe UI,system-ui,-apple-system,sans-serif;line-height:1.5;-webkit-text-size-adjust:100%}
    .evetec-panel *, .evetec-panel *:before, .evetec-panel *:after{box-sizing:border-box}
    .evetec-panel [hidden]{display:none!important}
    .evetec-panel main{width:min(1220px,calc(100% - 48px));max-width:1220px;margin:auto;padding:28px 0 56px;min-width:0}
    .evetec-panel h1{font-size:clamp(28px,4.2vw,44px);line-height:1.16;letter-spacing:-.035em;overflow-wrap:anywhere}
    .evetec-panel h2{font-size:21px;line-height:1.3;letter-spacing:-.025em;overflow-wrap:anywhere}
    .evetec-panel h3{line-height:1.4}.evetec-panel p{line-height:1.6}
    .evetec-panel .brand{font-size:11px;line-height:1.7;letter-spacing:.17em;color:#5ee1ee}
    .evetec-panel .muted,.evetec-panel .hint,.evetec-panel .sub{overflow-wrap:anywhere}
    .evetec-panel .top{display:flex;flex-wrap:wrap;gap:20px;align-items:center;margin:22px 0}
    .evetec-panel .top>div,.evetec-panel .top>form{min-width:0}
    .evetec-panel .top .actions{margin-top:0}
    .evetec-panel .card{min-width:0;border-color:#263d52;border-radius:20px;padding:22px;background:linear-gradient(145deg,#101f30,#0b1827);box-shadow:0 8px 26px rgba(0,0,0,.13)}
    .evetec-panel .stats{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:20px 0}
    .evetec-panel .stat{position:relative;padding:19px 20px;overflow:hidden}
    .evetec-panel .stat>span{font-size:11px;line-height:1.5;letter-spacing:.075em;font-weight:750;min-height:32px;color:#a8c1d5;overflow-wrap:anywhere}
    .evetec-panel .stat b{font-size:30px;font-weight:750;line-height:1.2;letter-spacing:-.035em;margin:8px 0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .evetec-panel .stat small{display:block;font-size:11px;line-height:1.5;color:#9bb2c6;overflow-wrap:anywhere}
    .evetec-panel .evetec-primary-stat{border-color:#23748b;background:linear-gradient(145deg,#12394a,#0c2233)}
    .evetec-panel .evetec-primary-stat b{color:#83edee}
    .evetec-panel .evetec-earnings-stat{border-top:2px solid #35bf92}.evetec-panel .evetec-earnings-stat b{color:#9aefca}
    .evetec-panel .evetec-fee-stat b{color:#ffd47b}
    .evetec-panel .columns{grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);gap:18px}
    .evetec-panel .grid,.evetec-panel .form-grid{gap:16px;min-width:0}
    .evetec-panel .grid>*,.evetec-panel .form-grid>*,.evetec-panel .field{min-width:0}
    .evetec-panel label{line-height:1.45;letter-spacing:.025em;font-weight:650;overflow-wrap:anywhere}
    .evetec-panel input:not([type=checkbox]):not([type=radio]):not([type=hidden]),.evetec-panel select,.evetec-panel textarea{min-width:0;max-width:100%;width:100%;min-height:48px;padding:12px 13px;border:1px solid #35516a;border-radius:12px;background:#081623;color:#f3f9ff;font-family:inherit;font-size:16px;line-height:1.35;box-shadow:inset 0 1px 2px #0002}
    .evetec-panel input[type=checkbox],.evetec-panel input[type=radio]{width:22px;height:22px;min-width:22px;accent-color:#36d5e5;flex:0 0 22px}
    .evetec-panel input:focus-visible,.evetec-panel select:focus-visible,.evetec-panel textarea:focus-visible,.evetec-panel a:focus-visible,.evetec-panel button:focus-visible{outline:3px solid rgba(94,225,238,.7);outline-offset:3px}
    .evetec-panel input[readonly],.evetec-panel input:disabled{color:#a8bacb;background:#111f2e}
    .evetec-panel button,.evetec-panel .btn,.evetec-panel .mini-btn{min-height:44px;touch-action:manipulation;line-height:1.3;border-radius:11px;white-space:normal;font-family:inherit;font-size:14px;padding:12px 15px;font-weight:750}
    .evetec-panel button:not(.mini-btn):not(.logout):not(.danger-mini),.evetec-panel .btn.primary{box-shadow:0 4px 12px rgba(14,140,167,.12)}
    .evetec-panel .actions{gap:10px;align-items:center}.evetec-panel .status{max-width:100%;font-size:13px;padding:10px 13px;line-height:1.5}
    .evetec-panel .switches{gap:10px}.evetec-panel .check{min-height:48px;line-height:1.5;align-items:flex-start;text-align:left;max-width:100%}
    .evetec-panel .check input{margin-top:1px}.evetec-panel .auto-share{margin-top:12px;flex-wrap:wrap}
    .evetec-panel .participant-row{min-width:0}.evetec-panel .participant-account{min-width:0}.evetec-panel .participant-account .pill{overflow-wrap:anywhere;white-space:normal}
    .evetec-panel .participant-picker{gap:16px;line-height:1.5}.evetec-panel .participant-picker select{min-width:138px}
    .evetec-panel .readonly{align-items:flex-start;gap:16px;line-height:1.6}.evetec-panel .readonly b{text-align:right;overflow-wrap:anywhere;min-width:0;max-width:62%}
    .evetec-panel .table,.evetec-panel .table-wrap{max-width:100%;min-width:0;overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;border:1px solid #233a50;border-radius:12px;scrollbar-width:thin;scrollbar-color:#315570 #081623}
    .evetec-panel table{width:100%;border-collapse:collapse}.evetec-panel th,.evetec-panel td{padding:13px 12px;line-height:1.5}.evetec-panel th{font-size:10px;letter-spacing:.075em;background:#102235;white-space:nowrap}.evetec-panel td{font-size:13px}.evetec-panel tbody tr:last-child td{border-bottom:0}
    .evetec-panel .device-tabs,.evetec-panel .tabs{max-width:100%;min-width:0;gap:10px;padding:2px 2px 8px;scrollbar-width:thin;overscroll-behavior-x:contain;scroll-snap-type:x proximity}
    .evetec-panel .device-tab,.evetec-panel .tab{min-width:190px;max-width:280px;flex-shrink:0;scroll-snap-align:start;border-radius:14px;padding:12px 14px;line-height:1.4}
    .evetec-panel .device-tab>span:not(.tab-dot),.evetec-panel .tab>span{overflow-wrap:anywhere}.evetec-panel .device-tab.active,.evetec-panel .tab.active{border-color:#39cfdf;background:linear-gradient(135deg,#12384b,#10263a)}
    .evetec-panel .evetec-jumpnav{position:sticky;top:10px;z-index:40;display:flex;gap:7px;align-items:center;overflow-x:auto;max-width:100%;min-width:0;margin:12px 0 20px;padding:7px;border:1px solid #2b465d;border-radius:16px;background:rgba(9,24,39,.95);backdrop-filter:blur(14px);box-shadow:0 8px 24px #0003;scrollbar-width:none}
    .evetec-panel .evetec-jumpnav::-webkit-scrollbar{display:none}.evetec-panel .evetec-jumpnav a{display:flex;align-items:center;justify-content:center;gap:7px;flex:1 0 auto;min-height:44px;padding:10px 14px;border-radius:10px;color:#b7cbdc;font-size:13px;font-weight:750;line-height:1.3;text-decoration:none;white-space:nowrap}
    .evetec-panel .evetec-jumpnav a[aria-current=true]{color:#a4f2f3;background:#133b4e;box-shadow:inset 0 0 0 1px #26738a}
    .evetec-panel .evetec-jumpnav svg{width:17px;height:17px;flex:0 0 17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .evetec-panel .evetec-anchor{scroll-margin-top:94px}.evetec-panel .footer{overflow-wrap:anywhere;margin-top:22px;line-height:1.7}
    .evetec-panel .client-products{min-width:0}.evetec-panel .client-product{min-width:0}.evetec-panel .client-fields{min-width:0}.evetec-panel .client-preview{min-width:0;max-width:100%}
    @media(max-width:1000px){.evetec-panel .stats{grid-template-columns:repeat(2,minmax(0,1fr))}.evetec-panel .columns{grid-template-columns:minmax(0,1fr)}.evetec-panel .top{align-items:flex-start}.evetec-panel .participant-head{display:none}}
    @media(max-width:640px){
      .evetec-panel main{width:calc(100% - 28px);padding:16px 0 calc(32px + env(safe-area-inset-bottom));margin:auto}
      .evetec-panel h1{font-size:30px}.evetec-panel h2{font-size:20px}.evetec-panel .top{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;margin:15px 0 18px;align-items:start}
      .evetec-panel .top>.actions{grid-column:1/-1;width:100%;justify-content:space-between}.evetec-panel .top>form{margin:0}.evetec-panel .top .logout{padding:10px 12px;min-width:64px}
      .evetec-panel .stats{gap:10px;margin:16px 0}.evetec-panel .stat{padding:15px 13px;border-radius:16px}.evetec-panel .stat b{font-size:25px;margin-top:9px}.evetec-panel .stat>span{font-size:10px;letter-spacing:.045em;min-height:30px}.evetec-panel .stat small{font-size:10px}
      .evetec-panel .card:not(.stat){padding:18px 16px;border-radius:18px}.evetec-panel .grid,.evetec-panel .form-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 12px}
      .evetec-panel .wide,.evetec-panel .field:has(input[name=monto]),.evetec-panel .grid>label:has(input[name=monto]){grid-column:1/-1}
      .evetec-panel label{font-size:12px}.evetec-panel .grid label{letter-spacing:.025em}.evetec-panel input:not([type=checkbox]):not([type=radio]):not([type=hidden]),.evetec-panel select,.evetec-panel textarea{font-size:16px}
      .evetec-panel .card form>button,.evetec-panel .actions>.btn.primary{width:100%;min-height:48px}.evetec-panel .actions>.btn.secondary,.evetec-panel .actions>.btn.danger{flex:1 1 130px;text-align:center}
      .evetec-panel .switches{flex-direction:column;align-items:stretch}.evetec-panel .switches .check{width:100%;font-size:13px}.evetec-panel .auto-share{font-size:13px;padding:12px}.evetec-panel .auto-share .hint{width:100%}
      .evetec-panel .participant-picker{flex-direction:column;align-items:stretch;padding:14px}.evetec-panel .participant-picker select{width:100%;min-width:0}
      .evetec-panel .participant-row{display:grid;grid-template-columns:28px minmax(0,1fr) 106px;gap:12px 10px;padding:16px 12px;margin:12px 0;border:1px solid #2b435a;border-radius:15px;background:#0a1929}
      .evetec-panel .participant-number{grid-column:1;grid-row:1;width:28px;height:28px;margin-top:10px}.evetec-panel .participant-row>input{grid-column:2/-1;grid-row:1}
      .evetec-panel .participant-row .percent-input{grid-column:1/3;grid-row:2}.evetec-panel .participant-row .percent-input:before{content:'Participación';display:block;margin-bottom:6px;color:#a0b8cd;font-size:11px;font-weight:650}.evetec-panel .percent-input span{top:auto;bottom:12px}
      .evetec-panel .participant-row>b{grid-column:3;grid-row:2;align-self:end;min-width:0;padding-bottom:11px;font-size:19px;line-height:1.5;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.evetec-panel .participant-row>b:before{content:'Ganancia neta';display:block;margin-bottom:6px;font-size:10px;font-weight:600;color:#a0b8cd}
      .evetec-panel .participant-account{grid-column:1/-1;grid-row:3;gap:8px}.evetec-panel .participant-account .pill{width:100%;text-align:center;padding:7px 9px}.evetec-panel .participant-account .mini-btn{flex:1 1 120px;margin:0;font-size:12px;padding:10px}
      .evetec-panel .test-mode,.evetec-panel .backup-head{display:flex;flex-direction:column;align-items:stretch;gap:14px}.evetec-panel .test-mode form,.evetec-panel .test-mode .btn{width:100%;min-width:0}.evetec-panel .backup-head>.pill{align-self:flex-start}
      .evetec-panel .readonly{font-size:13px}.evetec-panel .readonly b{max-width:58%}.evetec-panel .owner-line{flex-wrap:wrap;overflow-wrap:anywhere}.evetec-panel .plan-grid{grid-template-columns:minmax(0,1fr)}
      .evetec-panel .new-device-form{grid-template-columns:minmax(0,1fr)}.evetec-panel .table,.evetec-panel .table-wrap{margin-right:0}.evetec-panel .table td,.evetec-panel .table-wrap td{white-space:nowrap}.evetec-panel .table .empty,.evetec-panel .table-wrap .empty{white-space:normal;min-width:220px}
      .evetec-panel .evetec-jumpnav{top:7px;margin:12px 0 16px;padding:5px;gap:4px;border-radius:14px}.evetec-panel .evetec-jumpnav a{min-height:44px;padding:10px 12px;font-size:12px}.evetec-admin .evetec-jumpnav svg{display:none}.evetec-admin .evetec-jumpnav a{padding:10px 8px}.evetec-panel .evetec-anchor{scroll-margin-top:82px}
      .evetec-panel .client-products{max-height:none;overflow:visible;grid-template-columns:minmax(0,1fr)}.evetec-panel .client-product{grid-template-columns:minmax(0,1fr)}.evetec-panel .client-preview{width:100%;height:auto;aspect-ratio:1}.evetec-panel .client-row{grid-template-columns:repeat(2,minmax(0,1fr))}.evetec-panel .client-check{font-size:13px}
    }
    @media(max-width:380px){.evetec-panel main{width:calc(100% - 24px)}.evetec-panel .stat b{font-size:23px}.evetec-panel .stat{padding:14px 11px}.evetec-panel .evetec-jumpnav a{padding:10px}.evetec-panel .evetec-jumpnav svg{display:none}.evetec-panel .participant-row{grid-template-columns:26px minmax(0,1fr) 96px}.evetec-panel .participant-row>b{font-size:17px}}
    @media(prefers-reduced-motion:no-preference){html:has(.evetec-panel){scroll-behavior:smooth}.evetec-panel .btn,.evetec-panel button,.evetec-panel .evetec-jumpnav a{transition:background-color .16s,border-color .16s}}
    @media print{.evetec-panel .evetec-jumpnav{display:none}}
  </style><script>
  (()=>{
    if(document.body.dataset.evetecPanelReady)return;
    document.body.dataset.evetecPanelReady='1';
    document.body.classList.add('evetec-panel','evetec-${admin ? "admin" : "client"}');
    const main=document.querySelector('main');if(!main)return;
    const sections=[],headings=[...main.querySelectorAll('h2,h3')];
    function heading(pattern){return headings.find(el=>pattern.test(el.textContent.trim()))}
    function section(label,id,element,path){if(!element)return;element.id=element.id||id;element.classList.add('evetec-anchor');sections.push({label,id:element.id,path})}
    section('Resumen','evetec-summary',main.querySelector('.stats'),'M4 13h6v7H4z M14 4h6v16h-6z M4 4h6v5H4z');
    const config=heading(/configuraci[oó]n del servicio|configuraci[oó]n de la m[aá]quina|precios, tiempo|precio, duraci[oó]n|precios y tiempo|precio y duraci[oó]n|productos, precios/i);
    section('Ajustes','evetec-settings',config?.closest('.card')||config,'M4 7h10 M18 7h2 M4 17h2 M10 17h10 M14 4v6 M6 14v6');
    const activity=heading(/servicios confirmados|[uú]ltimos pagos|historial de pagos/i);
    section('Actividad','evetec-activity',activity?.closest('.card')||activity,'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5');
    ${admin ? `const clients=heading(/accesos de clientes/i);section('Clientes','evetec-clients',clients?.closest('.card')||clients,'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M17 5a3 3 0 0 1 0 6 M22 20v-2a4 4 0 0 0-3-3.87');` : ""}
    if(sections.length>1){
      const nav=document.createElement('nav');nav.className='evetec-jumpnav';nav.setAttribute('aria-label','Secciones del panel');
      sections.forEach((item,index)=>{
        const link=document.createElement('a');link.href='#'+item.id;link.setAttribute('aria-current',index===0?'true':'false');
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
        const icon=document.createElementNS('http://www.w3.org/2000/svg','path');icon.setAttribute('d',item.path);svg.append(icon);
        const text=document.createElement('span');text.textContent=item.label;link.append(svg,text);nav.append(link);
        link.addEventListener('click',()=>nav.querySelectorAll('a').forEach(a=>a.setAttribute('aria-current',a===link?'true':'false')));
      });
      const header=main.querySelector('header');if(header)header.insertAdjacentElement('afterend',nav);else main.prepend(nav);
      let scheduled=false;
      function updateSection(){scheduled=false;let id=sections[0].id;sections.forEach(item=>{if(document.getElementById(item.id).getBoundingClientRect().top<=110)id=item.id});nav.querySelectorAll('a').forEach(a=>a.setAttribute('aria-current',a.getAttribute('href')==='#'+id?'true':'false'))}
      window.addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(updateSection)}},{passive:true});
    }
    const stats=main.querySelector('.stats');if(stats){stats.querySelector('.stat')?.classList.add('evetec-primary-stat');stats.querySelectorAll('.stat').forEach(card=>{if(card.querySelector('[data-participant],[data-participant-total]'))card.classList.add('evetec-earnings-stat');if(card.querySelector('#fees,#mp-fees'))card.classList.add('evetec-fee-stat')})}
    main.querySelectorAll('.participant-row').forEach((row,index)=>{const name=row.querySelector('input[name^="participant_name_"]'),percentage=row.querySelector('input[name^="participant_pct_"]');if(name&&!name.hasAttribute('aria-label'))name.setAttribute('aria-label','Nombre del participante '+(index+1));if(percentage)percentage.setAttribute('aria-label','Porcentaje del participante '+(index+1))});
    main.querySelectorAll('.table,.table-wrap').forEach(table=>{table.setAttribute('tabindex','0');if(!table.hasAttribute('aria-label'))table.setAttribute('aria-label','Tabla: deslizar horizontalmente para ver todas las columnas')});
  })();
  </script>`;
}

module.exports = { panelMobileHtml };
