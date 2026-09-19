/* Live-only page behavior. Secrets remain request-scoped and are never stored in browser storage. */
"use strict";
if (document.body.dataset.page === "orders") {
  let orders=[], currentDetailId=null, accountsBusy=true, accountsFailed=false, createBusy=false;
  const eligibleProviders=new Set(), providerInput=document.getElementById("oProvider"), launch=document.querySelector('[data-action="open-create"]'), submit=document.getElementById("btnCreate");
  const amountInput=document.getElementById("oAmount"), descInput=document.getElementById("oDesc"), consentInput=document.getElementById("labConsent"), errorBox=document.getElementById("createError"), hintBox=document.getElementById("providerHint");
  const providerCards=[...document.querySelectorAll(".provider-radio")];

  function syncProviderCards(){
    for(const card of providerCards){
      const ok=eligibleProviders.has(card.dataset.provider);
      const active=ok&&providerInput.value===card.dataset.provider;
      card.classList.toggle("disabled",!ok);
      card.classList.toggle("active",active);
      card.setAttribute("aria-disabled",String(!ok));
      card.setAttribute("aria-checked",String(active));
    }
  }
  function syncCreate(){
    const ok=!accountsBusy&&!accountsFailed&&eligibleProviders.size>0;
    launch.disabled=!ok;
    submit.disabled=createBusy||!ok||!eligibleProviders.has(providerInput.value);
    hintBox.textContent=accountsBusy?"Memuat akun...":accountsFailed?"Status akun gagal dimuat. Buat tagihan dinonaktifkan.":ok?"Pilih akun yang sudah aktif dan lolos pemeriksaan.":"Belum ada akun aktif. Hubungkan dulu di halaman Akun Pembayaran.";
    syncProviderCards();
  }
  function selectProvider(provider){
    if(!eligibleProviders.has(provider))return;
    providerInput.value=provider;
    syncCreate();
  }
  async function loadOrderProviders(){
    accountsBusy=true;accountsFailed=false;eligibleProviders.clear();providerInput.value="";
    for(const o of providerInput.options)o.disabled=true;
    syncCreate();
    try{
      const {accounts=[],lab}=await PayGate.api("/api/accounts");
      if(document.body.dataset.labOwner==="true"&&lab?.enabled===true&&lab?.owner===true) for(const p of ["gopay","shopeepay"]){
        const a=accounts.find(x=>x.provider===p),m=lab.providers?.find(x=>x.provider===p);
        if(m?.configured===true&&(a?.status||m.status)==="active"&&a?.last_validated_at>0)eligibleProviders.add(p)
      }
      for(const o of providerInput.options)o.disabled=!eligibleProviders.has(o.value);
      providerInput.value=[...eligibleProviders][0]||""
    }catch(e){accountsFailed=true;PayGate.toast(e.message,"error")}
    finally{accountsBusy=false;syncCreate()}
  }
  function timeAgo(ts){
    const diff=Date.now()-Number(ts);
    if(!ts||!Number.isFinite(diff)||diff<0)return null;
    if(diff<60000)return "baru saja";
    if(diff<3600000)return Math.floor(diff/60000)+" menit lalu";
    if(diff<86400000)return Math.floor(diff/3600000)+" jam lalu";
    return null;
  }
  async function loadOrders(){
    try{
      orders=(await PayGate.api("/api/orders")).orders||[];
      const rows=document.getElementById("orderRows");
      rows.innerHTML=orders.length?orders.map(o=>{
        const ago=timeAgo(o.created_at);
        const created=ago?`${PayGate.esc(ago)}<br><span class="muted small">${PayGate.esc(PayGate.fmtDate(o.created_at))}</span>`:PayGate.esc(PayGate.fmtDate(o.created_at));
        return `<tr><td class="mono">${PayGate.esc(o.id)}</td><td>${PayGate.esc(o.provider)}</td><td>${PayGate.fmtRupiah(o.amount)}</td><td>${badge(o.status,o.payment_origin)}</td><td>${created}</td><td><button class="btn btn-outline btn-sm" data-action="open-detail" data-id="${PayGate.esc(o.id)}">Detail</button></td></tr>`
      }).join(""):'<tr><td colspan="6"><div class="empty-state"><p class="empty-title">Belum ada order.</p><p class="empty-copy">Order baru akan muncul di sini.</p></div></td></tr>'
    }catch(e){PayGate.toast(e.message,"error")}
  }
  async function createOrder(){
    if(submit.disabled||!amountInput.reportValidity())return;
    const amount=Number(amountInput.value),provider=providerInput.value;
    errorBox.classList.add("hidden");
    if(!eligibleProviders.has(provider)||!Number.isInteger(amount)||amount>100000||!consentInput.checked){
      errorBox.textContent="Maksimal Rp 100.000. Konfirmasi risiko dana nyata.";
      errorBox.classList.remove("hidden");
      return
    }
    createBusy=true;syncCreate();
    try{
      const r=await PayGate.api("/api/orders/create",{method:"POST",body:JSON.stringify({amount,provider,description:descInput.value})});
      PayGate.closeModal("createModal");
      await loadOrders();
      await openDetail(r.order_id)
    }catch(e){errorBox.textContent=e.message;errorBox.classList.remove("hidden")}
    finally{createBusy=false;await loadOrderProviders()}
  }
  function stopOrderTimers(){
    clearTimeout(window._orderTimer);
    clearInterval(window._orderTick);
    window._orderTimer=null;window._orderTick=null;
  }
  function startCountdown(expiresAt){
    clearInterval(window._orderTick);window._orderTick=null;
    if(!expiresAt)return;
    const pill=document.querySelector("#detailBody .order-countdown");
    const text=pill?.querySelector(".countdown-text");
    if(!pill||!text)return;
    const tick=()=>{
      const left=expiresAt-Date.now();
      if(left<=0){text.textContent="Waktu habis";pill.classList.add("urgent");clearInterval(window._orderTick);window._orderTick=null;return}
      const total=Math.floor(left/1000),m=Math.floor(total/60),s=total%60;
      text.textContent=`Sisa ${m}:${String(s).padStart(2,"0")}`;
      pill.classList.toggle("urgent",left<60000)
    };
    tick();window._orderTick=setInterval(tick,1000);
  }
  function statusHero(o){
    if(o.status==="paid"){
      const verified=o.payment_origin==="live";
      return `<div class="order-paid-hero"><span class="paid-check" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg></span><span class="paid-label">${verified?"Pembayaran terverifikasi":"Pembayaran tercatat"}</span><span class="paid-copy">${verified?"Dana sudah masuk dan dipastikan oleh sistem.":"Tercatat dari riwayat lama, belum diverifikasi otomatis."}</span></div>`
    }
    if(o.status==="expired")return '<div class="order-expired-hero"><span class="expired-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span><span class="expired-label">Tagihan kedaluwarsa</span><span class="expired-copy">QR sudah tidak berlaku. Buat tagihan baru bila masih diperlukan.</span></div>';
    return "";
  }
  function detailHTML(o){
    const live=o.payment_origin === "live"&&o.lab_unofficial === true&&["gopay","shopeepay"].includes(o.provider);
    const pending=o.status==="pending"&&o.expires_at>Date.now();
    const safe=live&&pending&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(o.qris_image||"");
    const parts=[];
    if(!live)parts.push('<p class="muted small">Order lama dari sistem sebelumnya. QR dan kode pembayaran tidak ditampilkan.</p>');
    parts.push(`<div class="flex items-center justify-between gap-12 mb-16"><span class="order-id-pill">${PayGate.esc(o.order_id)}</span>${badge(o.status,o.payment_origin)}</div>`);
    parts.push(statusHero(o));
    if(safe){
      parts.push(`<div class="qr-hero"><div class="qr-box"><img src="${PayGate.esc(o.qris_image)}" alt="QRIS merchant"></div><span class="order-countdown" data-expires="${PayGate.esc(o.expires_at)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span class="countdown-text">Menghitung...</span></span></div>`);
      parts.push(`<div class="order-key-section"><p class="order-key-label">Kode pembayaran</p><div class="key-box"><span id="qrisPayloadText">${PayGate.esc(o.qris_payload)}</span><button data-action="copy" data-target="qrisPayloadText" aria-label="Salin kode">Salin</button></div></div>`);
    }else if(pending){
      parts.push('<p class="muted">QR pembayaran tidak ditampilkan.</p>');
    }
    parts.push(`<dl class="order-meta"><dt>Nominal</dt><dd>${PayGate.fmtRupiah(o.amount)}</dd><dt>Metode</dt><dd>${PayGate.esc(o.provider)}</dd><dt>Kedaluwarsa</dt><dd>${PayGate.esc(PayGate.fmtDate(o.expires_at))}</dd></dl>`);
    if(live&&pending)parts.push('<p class="order-refresh-note">Status diperbarui otomatis setiap 3 detik.</p>');
    return parts.join("");
  }
  async function openDetail(id){
    currentDetailId=id;
    const box=document.getElementById("detailBody");
    delete box.dataset.loaded;delete box.dataset.status;
    box.innerHTML='<div class="skeleton" style="height:200px"></div>';
    PayGate.openModal("detailModal");
    await refreshOrder()
  }
  async function refreshOrder(){
    if(!currentDetailId)return;
    const requestedId=currentDetailId;
    const box=document.getElementById("detailBody");
    try{
      const o=await PayGate.api(`/api/orders/${encodeURIComponent(requestedId)}/status`);
      if(requestedId!==currentDetailId)return;
      const live=o.payment_origin === "live"&&o.lab_unofficial === true&&["gopay","shopeepay"].includes(o.provider);
      const pending=o.status==="pending"&&o.expires_at>Date.now();
      const wasPending=box.dataset.status==="pending";
      const qr=box.querySelector(".qr-box");
      if(wasPending&&o.status==="paid"&&qr){
        qr.classList.add("qr-fade-out");
        await new Promise(r=>setTimeout(r,400));
        if(requestedId!==currentDetailId)return
      }
      box.dataset.loaded="1";box.dataset.status=o.status||"";
      box.innerHTML=detailHTML(o);
      startCountdown(pending?o.expires_at:0);
      clearTimeout(window._orderTimer);window._orderTimer=null;
      if(live&&pending&&document.getElementById("detailModal").open)window._orderTimer=setTimeout(refreshOrder,3000)
    }catch(e){
      box.dataset.loaded="1";
      box.innerHTML=`<div class="alert alert-error">${PayGate.esc(e.message)}</div>`;
      stopOrderTimers()
    }
  }
  function badge(status,origin){
    const verified=origin==="live";
    let cls="neutral",label=status;
    if(status==="paid"){cls=verified?"success":"warning";label=verified?"Lunas":"Tercatat (belum diverifikasi)"}
    else if(status==="pending"){cls="warning";label="Menunggu"}
    else if(status==="expired"){cls="neutral";label="Kedaluwarsa"}
    return `<span class="badge badge-${cls}"><span class="dot"></span>${PayGate.esc(label)}</span>`
  }

  for(const card of providerCards){
    card.addEventListener("click",()=>selectProvider(card.dataset.provider));
    card.addEventListener("keydown",event=>{
      if(event.key===" "||event.key==="Enter"){event.preventDefault();selectProvider(card.dataset.provider)}
    });
  }
  providerInput.addEventListener("change",syncCreate);
  document.getElementById("detailModal").addEventListener("close",()=>{currentDetailId=null;stopOrderTimers()});
  PayGate.bindActions({
    "open-create":async()=>{await loadOrderProviders();if(!launch.disabled){consentInput.checked=false;errorBox.classList.add("hidden");PayGate.openModal("createModal")}},
    "create-order":createOrder,
    "create-provider":el=>selectProvider(el.dataset.provider),
    "open-detail":el=>openDetail(el.dataset.id),
    "refresh-order":refreshOrder
  });
  loadOrderProviders();
  loadOrders();
  setInterval(()=>{if(!document.hidden&&!document.querySelector("dialog[open]"))void loadOrders()},15000);
}
if (document.body.dataset.page === "accounts") {
  let snapshot=null, attemptId=null, busy=new Set(), messages=new Map();
  const $=id=>document.getElementById(id);
  const errorLabels = {AUTH_REJECTED:"Sesi ditolak atau sudah berakhir. Hubungkan ulang lewat akun sendiri.",CHALLENGE:"Akun memerlukan verifikasi tambahan. Selesaikan di aplikasi resmi.",RATE_LIMITED:"Terlalu banyak percobaan. Tunggu sebentar sebelum mencoba lagi.",NETWORK:"Koneksi terputus. Pemeriksaan berhenti.",BAD_RESPONSE:"Data dari akun tidak cocok. Pemeriksaan berhenti.",ENV_INCOMPLETE:"Sesi belum lengkap.",PAGE_LIMIT:"Data belum lengkap. Belum dapat diaktifkan."};
  function restoreAccountFocus({action,provider}){
    const controls=[...document.querySelectorAll('#providerCards [data-action]')].filter(x=>x.dataset.provider===provider&&!x.disabled);
    (controls.find(x=>x.dataset.action===action)||controls[0])?.focus();
  }
  function renderAccounts() {
    const { accounts = [], lab, login = {} } = snapshot;
    const owner = document.body.dataset.labOwner === "true" && lab?.enabled === true && lab?.owner === true;
    const labels = {configured:"Tersimpan",unconfigured:"Belum terhubung",active:"Aktif",paused:"Dijeda",blocked:"Perlu tindakan",error:"Perlu diperiksa"};
    const focused = document.activeElement?.closest('#providerCards [data-action]');
    const focusKey = focused && {action:focused.dataset.action,provider:focused.dataset.provider};
    for (const [prefix, provider] of [["gp","gopay"],["sp","shopeepay"]]) {
      const a=accounts.find(x=>x.provider===provider),m=lab?.providers?.find(x=>x.provider===provider);
      const configured=m?.configured===true && !!a, status=configured?a.status:"unconfigured",box=$(prefix+"Body");
      $(prefix+"Badge").innerHTML=`<span class="badge badge-${status==="active"?"success":"neutral"}">${PayGate.esc(labels[status]||"Perlu diperiksa")}</span>`;
      if(!owner){box.textContent="Koneksi hanya dapat dikelola pemilik instalasi.";continue}
      const locked=busy.has(provider),cooldown=configured && a.next_poll_at>Date.now();
      const blocked=status==="blocked" && ["AUTH_REJECTED","CHALLENGE"].includes(a.last_error);
      const available=provider==="shopeepay"?(snapshot?.login?.shopeepay?.available===true||snapshot?.connection?.shopeepay?.available===true):login[provider]?.available===true;
      const connectAction=provider==="gopay"?"gopay-login":"shopee-guide",connectLabel=provider==="gopay"?"Hubungkan GoPay":"Hubungkan ShopeePay";
      const button=(action,label,primary=false)=>`<button class="btn ${primary?"btn-primary":"btn-outline"}" data-action="${action}" data-provider="${provider}" ${locked?"disabled":""}>${label}</button>`;
      let controls="",note="";
      if(!configured){note=provider==="gopay"?"Hubungkan dengan nomor telepon dan OTP GoBiz.":"Login dengan nomor, email, atau username dan password Shopee.";}
      else if(status==="active"){note="Pemeriksaan order berjalan di server. Browser boleh ditutup.";controls=button("lab-pause","Jeda otomatis",true)}
      else if(blocked){note="Pemeriksaan berhenti. Selesaikan verifikasi di aplikasi resmi, lalu hubungkan ulang.";}
      else if(cooldown){note="Pemeriksaan dijeda sampai "+PayGate.fmtDate(a.next_poll_at)+". Tidak mengulang otomatis.";}
      else {note=status==="paused"?"Pemeriksaan otomatis sedang dijeda.":"Sesi tersimpan; perlu pemeriksaan sebelum aktif.";controls=button(status==="paused"?"lab-resume":"lab-test",status==="error"?"Cek kembali":"Aktifkan otomatis",true)}
      const connect=available?button(connectAction,connectLabel,!controls):"";
      const result=messages.get(provider)||(configured?(errorLabels[a.last_error]||(a.last_error?"Pemeriksaan gagal. Periksa akun melalui provider.":"")):"");
      box.innerHTML=`<p class="account-note muted">${PayGate.esc(note)}</p><div class="account-actions">${controls}${connect}</div>
        ${!available?`<p class="small muted">${PayGate.esc(typeof login[provider]?.reason==="string"?login[provider].reason:"Koneksi belum diaktifkan oleh pengelola instalasi.")}</p>`:""}
        <p class="account-result" role="status">${PayGate.esc(result)}</p>
        ${configured&&a.last_validated_at>0?`<p class="account-note small muted">Terakhir dicek ${PayGate.fmtDate(a.last_validated_at)}</p>`:""}`;
      if(locked)box.setAttribute("aria-busy","true");else box.removeAttribute("aria-busy");
    }
    if(focusKey)restoreAccountFocus(focusKey);
  }
  let loadingAccounts=null;
  async function loadAccounts(force=true){
    while(loadingAccounts){await loadingAccounts;if(!force)return}
    loadingAccounts=(async()=>{
      try{const next=await PayGate.api("/api/accounts");const changed=JSON.stringify(next)!==JSON.stringify(snapshot);snapshot=next;if(force||changed)renderAccounts()}
      catch(e){snapshot=null;$("gpBody").textContent=$("spBody").textContent="Status gagal dimuat. Gunakan Perbarui status. "+e.message}
    })();
    try{await loadingAccounts}finally{loadingAccounts=null}
  }
  async function afterSave(provider,check){
    messages.set(provider,check?"Sesi tersimpan. Memeriksa koneksi…":"Sesi tersimpan. Otomatisasi belum aktif.");
    await loadAccounts();
    if(!check)return;
    try{const r=await PayGate.api("/api/accounts/test",{method:"POST",body:JSON.stringify({provider})});if(r?.ok!==true)throw new Error("Hasil pemeriksaan belum terkonfirmasi.");messages.set(provider,"Koneksi lolos pemeriksaan. Order dipantau otomatis; settlement tetap dicek lewat provider.")}
    catch(e){messages.set(provider,"Sesi tersimpan, tetapi belum aktif: "+e.message)}
  }
  function clearShopeeConnect(){
    $("spConnectForm").reset();
    $("spConnectAutoCheck").checked=true;
    $("spConnectSubmit").textContent="Simpan & aktifkan";
    $("spConnectError").textContent="";$("spConnectError").classList.add("hidden");
  }
  function openShopeeGuide(){
    if(!shopeeImportReady()&&!shopeeReady()||busy.has("shopeepay"))return;
    PayGate.openModal("spGuideDialog");
  }
  function openShopeeConnect(){
    if(!shopeeImportReady()||busy.has("shopeepay"))return;
    clearShopeeConnect();PayGate.closeModal("spGuideDialog");PayGate.openModal("spConnectDialog");$("spToken").focus();
  }
  function cancelShopeeConnect(){
    if($("spConnectDialog").getAttribute("aria-busy")==="true")return;
    clearShopeeConnect();PayGate.closeModal("spConnectDialog");
  }
  // Shopee session-import controls are owner-only markup; non-owners must still get the
  // rest of this page (status render + refresh) instead of a null deref aborting init.
  const spConnectDialog=$("spConnectDialog"),spConnectForm=$("spConnectForm");
  if(spConnectDialog&&spConnectForm){
  spConnectDialog.addEventListener("cancel",e=>{e.preventDefault();cancelShopeeConnect()});
  spConnectDialog.addEventListener("close",clearShopeeConnect);
  $("spConnectAutoCheck").addEventListener("change",()=>{$("spConnectSubmit").textContent=$("spConnectAutoCheck").checked?"Simpan & aktifkan":"Simpan saja"});
  spConnectForm.addEventListener("submit",async e=>{
    e.preventDefault();
    const dialog=$("spConnectDialog"),submit=$("spConnectSubmit"),error=$("spConnectError");
    if(dialog.getAttribute("aria-busy")==="true"||busy.has("shopeepay")||!$("spConnectForm").reportValidity())return;
    if(!shopeeImportReady()){clearShopeeConnect();PayGate.closeModal("spConnectDialog");messages.set("shopeepay","Impor sesi tidak tersedia. Perbarui status akun.");await loadAccounts();return}
    const autoCheck=$("spConnectAutoCheck").checked;
    busy.add("shopeepay");renderAccounts();dialog.setAttribute("aria-busy","true");
    for(const el of dialog.querySelectorAll("input,textarea,button"))if(el.dataset.action!=="shopee-connect-cancel")el.disabled=true;
    error.classList.add("hidden");
    try{
      const r=await PayGate.api("/api/accounts/shopee/connect",{method:"POST",body:JSON.stringify({token:$("spToken").value,merchant_id:$("spMerchant").value,store_id:$("spStore").value,qris_static:$("spCQris").value,password:$("spPassword").value,consent:$("spConnectConsent").checked})});
      if(r?.ok!==true||r.expiry_source!=="local_lease"||!Number.isSafeInteger(r.expires_at))throw new Error("Respons simpan tidak lengkap. Perbarui status akun; jangan mengulang otomatis.");
      PayGate.closeModal("spConnectDialog");await afterSave("shopeepay",autoCheck);
    }catch(err){error.textContent=err.message;error.classList.remove("hidden")}
    finally{$("spToken").value=$("spPassword").value="";$("spCQris").value="";submit.disabled=false;dialog.removeAttribute("aria-busy");busy.delete("shopeepay");await loadAccounts()}
  });
  }
  let spAttemptId=null, spStep="start", spExpires=0, spVersion=0;
  const shopeeReady=()=>snapshot?.login?.shopeepay?.available===true&&snapshot?.lab?.enabled===true&&snapshot?.lab?.owner===true&&document.body.dataset.labOwner==="true";
  const shopeeImportReady=()=>snapshot?.connection?.shopeepay?.available===true&&snapshot?.lab?.enabled===true&&snapshot?.lab?.owner===true&&document.body.dataset.labOwner==="true";
  function shopeeStep(step){spStep=step;for(const [name,value] of [["Start","start"],["Otp","otp"],["Store","store"]])$("sp"+name+"Form").hidden=value!==step}
  function clearShopee(){
    spAttemptId=null;spExpires=0;shopeeStep("start");
    for(const name of ["Start","Otp","Store"])$("sp"+name+"Form").reset();
    $("spChoice").innerHTML="";$("spAutoCheck").checked=true;$("spFinishSubmit").textContent="Simpan & aktifkan";
    $("spLoginError").textContent="";$("spLoginError").classList.add("hidden");$("spLoginExpiry").hidden=true;$("spLoginExpiry").textContent="";
  }
  function openShopee(){
    if(!shopeeReady()||busy.has("shopeepay")||$("spLoginDialog").open)return;
    spVersion++;clearShopee();for(const el of $("spLoginDialog").querySelectorAll("input,select,textarea,button"))el.disabled=false;PayGate.openModal("spLoginDialog");$("spIdentifier").focus();
  }
  async function cancelShopeeAttempt(id){if(id)try{await PayGate.api("/api/accounts/shopee/login/cancel",{method:"POST",body:JSON.stringify({attempt_id:id})})}catch{messages.set("shopeepay","Pembatalan server belum terkonfirmasi. Percobaan akan kedaluwarsa; tidak diulang otomatis.")}}
  async function cancelShopee(){
    const id=spAttemptId;spVersion++;clearShopee();
    if($("spLoginDialog").open)PayGate.closeModal("spLoginDialog");
    await cancelShopeeAttempt(id);
  }
  function shopeeError(message){$("spLoginError").textContent=message;$("spLoginError").classList.remove("hidden")}
  async function shopeeSubmit(step){
    const dialog=$("spLoginDialog"),form=$("sp"+({start:"Start",otp:"Otp",store:"Store"}[step])+"Form");
    if(!dialog.open||busy.has("shopeepay")||dialog.getAttribute("aria-busy")==="true")return;
    if(!shopeeReady()){
      $("spMerchantPassword").value=$("spPaygatePassword").value=$("spOtp").value="";
      shopeeError(!snapshot?"Status akun gagal dimuat. Batalkan lalu gunakan Perbarui status.":"Login ShopeePay tidak tersedia. Batalkan lalu perbarui status akun.");return;
    }
    if(spStep!==step||!form.reportValidity())return;
    if(step!=="start"&&(!spAttemptId||spExpires<=Date.now())){spStep="stopped";$("spOtp").value="";shopeeError("Percobaan login kedaluwarsa. Batalkan lalu login kembali.");return}
    const version=spVersion,check=$("spAutoCheck").checked;
    const route={start:"start",otp:"verify",store:"finish"}[step];
    const body=JSON.stringify(step==="start"?{identifier:$("spIdentifier").value.trim(),merchant_password:$("spMerchantPassword").value,password:$("spPaygatePassword").value,consent:$("spConsent").checked}:step==="otp"?{attempt_id:spAttemptId,otp:$("spOtp").value}:{attempt_id:spAttemptId,choice:$("spChoice").value,qris_static:$("spQris").value});
    busy.add("shopeepay");renderAccounts();dialog.setAttribute("aria-busy","true");
    for(const el of dialog.querySelectorAll("input,select,textarea,button"))if(el.dataset.action!=="shopee-cancel")el.disabled=true;
    $("spLoginError").classList.add("hidden");
    $("spMerchantPassword").value=$("spPaygatePassword").value=$("spOtp").value="";
    if(step==="start")$("spIdentifier").value="";
    if(step==="store")$("spQris").value="";
    let focusId=null;
    try{
      const r=await PayGate.api("/api/accounts/shopee/login/"+route,{method:"POST",body});
      if(version!==spVersion){if(step!=="store"&&typeof r?.attempt_id==="string")await cancelShopeeAttempt(r.attempt_id);return}
      if(r?.ok!==true)throw new Error("Permintaan login belum terkonfirmasi. Batalkan dan perbarui status; jangan ulang otomatis.");
      if(step==="store"){
        if(!["provider","local_lease"].includes(r.expiry_source)||!Number.isSafeInteger(r.expires_at)||r.expires_at<=Date.now())throw new Error("Respons simpan tidak lengkap. Perbarui status akun sebelum mencoba lagi.");
        spAttemptId=null;PayGate.closeModal("spLoginDialog");await afterSave("shopeepay",check);
      }else{
        if(typeof r.attempt_id!=="string"||!r.attempt_id||!Number.isSafeInteger(r.expires_at)||r.expires_at<=Date.now()||!["otp","store"].includes(r.step))throw new Error("Respons login tidak lengkap. Batalkan lalu perbarui status akun.");
        spAttemptId=r.attempt_id;spExpires=r.expires_at;
        if(r.step==="store"){
          if(!Array.isArray(r.choices)||!r.choices.length||r.choices.some(c=>typeof c.id!=="string"||!c.id||typeof c.label!=="string"))throw new Error("Toko tidak ditemukan. Batalkan lalu periksa akun provider.");
          $("spChoice").innerHTML=r.choices.map(c=>`<option value="${PayGate.esc(c.id)}">${PayGate.esc(c.label)}</option>`).join("");
        }
        shopeeStep(r.step);$("spLoginExpiry").textContent="Batas percobaan: "+PayGate.fmtDate(spExpires);$("spLoginExpiry").hidden=false;focusId=r.step==="otp"?"spOtp":"spChoice";
      }
    }catch(e){if(version===spVersion){spStep="stopped";shopeeError(e.message+" Batalkan untuk memulai percobaan baru; permintaan tidak diulang otomatis.")}}
    finally{
      const active=document.activeElement;
      const disabledFocus=active?.disabled&&(dialog.contains(active)||active.closest('#providerCards [data-action]')?.dataset.provider==="shopeepay")?active:null;
      for(const el of dialog.querySelectorAll("input,select,textarea,button"))el.disabled=spStep==="stopped"&&el.dataset.action!=="shopee-cancel";
      dialog.removeAttribute("aria-busy");busy.delete("shopeepay");
      if(focusId&&version===spVersion&&dialog.open)$(focusId).focus();
      await loadAccounts();
      // Closing while busy cannot focus the disabled opener; wait for its usable replacement.
      if(!dialog.open&&!document.querySelector("dialog[open]")&&(document.activeElement===document.body||(disabledFocus&&document.activeElement===disabledFocus)))restoreAccountFocus({action:"shopee-guide",provider:"shopeepay"});
    }
  }
  $("spLoginDialog").addEventListener("cancel",e=>{e.preventDefault();void cancelShopee()});
  $("spLoginDialog").addEventListener("close",()=>{void cancelShopee()});
  for(const [name,step] of [["Start","start"],["Otp","otp"],["Store","store"]])$("sp"+name+"Form").addEventListener("submit",e=>{e.preventDefault();return shopeeSubmit(step)});
  PayGate.bindActions({"shopee-guide":openShopeeGuide,"shopee-login":openShopee,"shopee-browser":()=>{PayGate.closeModal("spGuideDialog");openShopee()},"shopee-connect":openShopeeConnect,"shopee-connect-cancel":cancelShopeeConnect,"shopee-cancel":cancelShopee,"refresh-accounts":()=>loadAccounts()});
  for(const [id,buttonId] of [["spAutoCheck","spFinishSubmit"],["gpAutoCheck",null]])$(id).addEventListener("change",()=>{(buttonId?$(buttonId):document.querySelector('[data-action="gopay-finish"]')).textContent=$(id).checked?"Simpan & aktifkan":"Simpan saja"});
  $("spQrisPreviewBtn")?.addEventListener("click",async()=>{
    const box=$("spQrisPreview"),payload=$("spQris").value.trim();
    box.classList.remove("hidden");
    if(!payload){box.textContent="Tempel payload QRIS dulu.";return}
    try{
      const r=await PayGate.api("/api/qris/analyze",{method:"POST",body:JSON.stringify({payload})});
      const lines=[];
      lines.push(r.valid?"✓ Valid QRIS.":"⚠ QRIS tidak valid: "+(r.errors||[]).join("; "));
      if(r.merchant_name)lines.push("Merchant: "+r.merchant_name);
      if(r.city)lines.push("Kota: "+r.city);
      if(r.country)lines.push("Negara: "+r.country+" · Mata uang: "+(r.currency==="360"?"IDR":r.currency||"-"));
      if(r.pan_masked)lines.push("PAN merchant: "+r.pan_masked);
      if(r.has_amount)lines.push("Nominal (dinamis): "+r.amount);
      else lines.push("Tipe: "+(r.type==="dynamic"?"dinamis":"statis"));
      box.textContent=lines.join("\n");
    }catch(e){box.textContent=e.message}
  });
  function setStep(step){for(const x of ["start","otp","merchant"])$("gpStep"+x[0].toUpperCase()+x.slice(1)).hidden=x!==step}
  function openLogin(){if(busy.has("gopay")||snapshot?.login?.gopay?.available!==true||snapshot?.lab?.owner!==true||document.body.dataset.labOwner!=="true")return;$("gpPhone").value=$("gpPaygatePassword").value=$("gpOtp").value="";$("gpOtpChannel").value="sms";$("gpRiskConsent").checked=false;$("gpLoginError").classList.add("hidden");attemptId=null;$("gpAutoCheck").checked=true;document.querySelector('[data-action="gopay-finish"]').textContent="Simpan & aktifkan";setStep("start");PayGate.openModal("gpLoginDialog");$("gpPhone").focus()}
  async function wizard(el,route,body,next){
    const dialog=$("gpLoginDialog"),section=el.closest("[id^=gpStep]");
    if(dialog.getAttribute("aria-busy")==="true"||busy.has("gopay")||[...section.querySelectorAll("input,select")].some(x=>!x.reportValidity()))return;
    if(!snapshot){$("gpLoginError").textContent="Status akun gagal dimuat. Batalkan lalu gunakan Perbarui status.";$("gpLoginError").classList.remove("hidden");$("gpPaygatePassword").value=$("gpOtp").value="";return}
    const autoCheck=$("gpAutoCheck").checked;busy.add("gopay");renderAccounts();el.disabled=true;dialog.setAttribute("aria-busy","true");
    try{
      const r=await PayGate.api(route,{method:"POST",body:JSON.stringify(body())});
      if(r?.ok!==true)throw new Error(r?.error||"Permintaan gagal");
      if(next==="otp"&&(r.step!=="otp"||typeof r.attempt_id!=="string"||!Number.isFinite(r.expires_at)))throw new Error("Respons login tidak lengkap.");
      if(next==="merchant"&&(r.step!=="merchant"||!Array.isArray(r.merchants)||!r.merchants.length||r.merchants.some(m=>typeof m.id!=="string"||typeof m.label!=="string")))throw new Error("Merchant tidak ditemukan. Batalkan dan periksa provider resmi.");
      attemptId=r.attempt_id||attemptId;
      if(r.merchants)$("gpMerchant").innerHTML=r.merchants.map(m=>`<option value="${PayGate.esc(m.id)}">${PayGate.esc(m.label)}</option>`).join("");
      if(next==="otp"){const info=$("gpOtpChannelInfo"),ch=typeof r.channel==="string"?r.channel:"";info.hidden=!ch;info.textContent=ch?("GoPay mengirim kode lewat "+ch.toUpperCase()+" ke nomor ini. Kode cuma berlaku sebentar — masukkan segera."):""}
      $("gpLoginError").classList.add("hidden");
      if(next==="done"){attemptId=null;PayGate.closeModal("gpLoginDialog");await afterSave("gopay",autoCheck)}
      else {setStep(next);$(next==="otp"?"gpOtp":"gpMerchant").focus()}
    }catch(e){$("gpLoginError").textContent=e.message;$("gpLoginError").classList.remove("hidden")}
    finally{$("gpPaygatePassword").value="";$("gpOtp").value="";el.disabled=false;dialog.removeAttribute("aria-busy");busy.delete("gopay");await loadAccounts()}
  }
  async function cancelLogin(){if($("gpLoginDialog").getAttribute("aria-busy")==="true")return;if(attemptId)try{await PayGate.api("/api/accounts/login/cancel",{method:"POST",body:JSON.stringify({provider:"gopay",attempt_id:attemptId})})}catch{}attemptId=null;$("gpPhone").value=$("gpPaygatePassword").value=$("gpOtp").value="";PayGate.closeModal("gpLoginDialog")}
  async function control(el,action){const p=el.dataset.provider;if(!snapshot||snapshot.lab?.owner!==true||snapshot.lab?.enabled!==true||document.body.dataset.labOwner!=="true"||!["gopay","shopeepay"].includes(p)||busy.has(p))return;const focused=document.activeElement===el;busy.add(p);el.closest(".card-pad").setAttribute("aria-busy","true");el.closest(".card-pad").querySelectorAll("button").forEach(b=>{b.disabled=true});try{const r=await PayGate.api(`/api/accounts/${action}`,{method:"POST",body:JSON.stringify({provider:p})});messages.set(p,r.detail||"Status diperbarui") }catch(e){messages.set(p,e.message)}finally{busy.delete(p);await loadAccounts();if(focused&&document.activeElement===document.body&&!document.querySelector("dialog[open]"))restoreAccountFocus(el.dataset)}}
  $("gpLoginDialog").addEventListener("cancel",e=>{e.preventDefault();cancelLogin()});PayGate.bindActions({"gopay-login":openLogin,"gopay-start":el=>wizard(el,"/api/accounts/login/start",()=>({provider:"gopay",phone:PayGate.formatPhoneID($("gpPhone").value),password:$("gpPaygatePassword").value,otp_channel:$("gpOtpChannel").value,consent:$("gpRiskConsent").checked}),"otp"),"gopay-verify":el=>wizard(el,"/api/accounts/login/verify",()=>({provider:"gopay",attempt_id:attemptId,otp:$("gpOtp").value}),"merchant"),"gopay-finish":el=>wizard(el,"/api/accounts/login/finish",()=>({provider:"gopay",attempt_id:attemptId,merchant:$("gpMerchant").value}),"done"),"gopay-cancel":cancelLogin,"lab-test":el=>control(el,"test"),"lab-pause":el=>control(el,"pause"),"lab-resume":el=>control(el,"resume")});loadAccounts();
  setInterval(()=>{if(!document.hidden&&!busy.size&&!document.querySelector("dialog[open]"))void loadAccounts(false)},15000);
}
if (document.body.dataset.page === "apikeys") {

async function loadKeys() {
  try {
    const d = await PayGate.api("/api/api-keys");
    const tbody = document.getElementById("keyRows");
    if (!d.keys.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p class="empty-title">Belum ada API key.</p><p class="empty-copy">Buat key untuk akses integrasi.</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = d.keys.map(k => `
      <tr>
        <td style="font-weight:600;">${PayGate.esc(k.name)}</td>
        <td><span class="mono small">${PayGate.esc(k.prefix)}</span></td>
        <td class="muted small">${k.last_used ? PayGate.fmtDate(k.last_used) : '-'}</td>
        <td class="muted small">${PayGate.fmtDate(k.created_at)}</td>
        <td>${k.revoked ? '<span class="badge badge-danger"><span class="dot"></span>Dicabut</span>' : '<span class="badge badge-success"><span class="dot"></span>Aktif</span>'}</td>
        <td>
          <div class="actions">
            ${k.revoked ? '' : `<button class="btn btn-outline btn-sm" data-action="regenerate-key" data-id="${PayGate.esc(k.id)}">Ganti Kunci</button>
            <button class="btn btn-danger-ghost btn-sm" data-action="revoke-key" data-id="${PayGate.esc(k.id)}">Cabut</button>`}
          </div>
        </td>
      </tr>`).join("");
  } catch (e) { PayGate.toast(e.message, "error"); }
}

function openCreate() {
  document.getElementById("newKeyBox").classList.add("hidden");
  document.getElementById("keyError").classList.add("hidden");
  document.getElementById("keyName").value = "";
  PayGate.openModal("createModal");
}

async function createKey() {
  if (!document.getElementById("keyName").reportValidity()) return;
  const name = document.getElementById("keyName").value;
  const errBox = document.getElementById("keyError");
  const btn = document.getElementById("btnGen");
  errBox.classList.add("hidden");
  btn.disabled = true;
  try {
    const res = await PayGate.api("/api/api-keys", { method: "POST", body: JSON.stringify({ name }) });
    document.getElementById("newKeyValue").textContent = res.key;
    document.getElementById("newKeyBox").classList.remove("hidden");
    loadKeys();
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove("hidden");
  } finally { btn.disabled = false; }
}

async function revokeKey(id) {
  if (!confirm("Cabut kunci ini? Semua permintaan yang memakai kunci ini langsung ditolak.")) return;
  try {
    await PayGate.api("/api/api-keys/" + id + "/revoke", { method: "POST" });
    PayGate.toast("Kunci dicabut.", "success");
    loadKeys();
  } catch (e) { PayGate.toast(e.message, "error"); }
}

async function regenerateKey(id) {
  if (!confirm("Ganti kunci ini? Kunci lama langsung mati dan diganti yang baru.")) return;
  try {
    const res = await PayGate.api("/api/api-keys/" + id + "/regenerate", { method: "POST" });
    document.getElementById("newKeyValue").textContent = res.key;
    document.getElementById("newKeyBox").classList.remove("hidden");
    document.getElementById("keyName").value = "";
    PayGate.openModal("createModal");
    loadKeys();
  } catch (e) { PayGate.toast(e.message, "error"); }
}


loadKeys();

  PayGate.bindActions({
    "open-create": el => openCreate(),
    "create-key": el => createKey(),
    "regenerate-key": el => regenerateKey(el.dataset.id),
    "revoke-key": el => revokeKey(el.dataset.id)
  });
}

if (document.body.dataset.page === "settings") {

async function loadSettings() {
  try {
    const s = await PayGate.api("/api/settings");
    document.getElementById("setProvider").value = "Otomatis: pakai akun yang sudah terhubung";
    document.getElementById("setPoll").value = Math.round(s.poll_interval_ms / 1000);
    document.getElementById("setTolerance").value = s.payment_tolerance;
    document.getElementById("setTtl").value = s.order_ttl_minutes;
  } catch (e) { PayGate.toast(e.message, "error"); }
}

async function changePassword() {
  const cur = document.getElementById("pwCurrent").value;
  const nw = document.getElementById("pwNew").value;
  const cf = document.getElementById("pwConfirm").value;
  if (nw !== cf) return PayGate.toast("Password baru tidak cocok.", "error");
  try {
    await PayGate.api("/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: cur, new_password: nw, confirm_password: cf })
    });
    PayGate.toast("Password diganti! Sesi di perangkat lain sudah keluar.", "success");
    document.getElementById("pwCurrent").value = "";
    document.getElementById("pwNew").value = "";
    document.getElementById("pwConfirm").value = "";
  } catch (e) { PayGate.toast(e.message, "error"); }
}

async function logoutAll() {
  if (!confirm("Logout dari semua perangkat (termasuk yang ini)? Kamu akan diarahkan ke login.")) return;
  try {
    await PayGate.api("/api/logout-all", { method: "POST" });
    window.location.href = "/login";
  } catch (e) { PayGate.toast(e.message, "error"); }
}

// ---------- 2FA (TOTP) ----------
const totpStatus = document.getElementById("totpStatus");
const totpSetup = document.getElementById("totpSetup");
const totpDisable = document.getElementById("totpDisable");
const totpStartBtn = document.getElementById("totpStartBtn");

async function loadTotp() {
  try {
    const s = await PayGate.api("/api/settings/2fa");
    totpSetup.hidden = true;
    totpStartBtn.hidden = true;
    if (s.enabled) {
      totpStatus.className = "alert alert-success";
      totpStatus.textContent = "2FA aktif. Akun kamu terlindungi kode autentikator.";
      totpDisable.hidden = false;
    } else {
      totpStatus.className = "alert alert-info";
      totpStatus.textContent = "2FA belum aktif. Aktifkan untuk keamanan tambahan.";
      totpDisable.hidden = true;
      totpStartBtn.hidden = false;
    }
  } catch (e) { totpStatus.textContent = "Status 2FA belum bisa dimuat."; }
}

async function totpStart() {
  try {
    const r = await PayGate.api("/api/settings/2fa/setup", { method: "POST" });
    document.getElementById("totpQr").src = r.qr;
    document.getElementById("totpSecret").value = r.secret;
    document.getElementById("totpCode").value = "";
    totpStatus.className = "alert alert-info";
    totpStatus.textContent = "Scan QR lalu masukkan kode 6 digit untuk mengaktifkan 2FA.";
    totpSetup.hidden = false;
    totpStartBtn.hidden = true;
    document.getElementById("totpCode").focus();
  } catch (e) { PayGate.toast(e.message, "error"); }
}

async function totpEnable() {
  const code = document.getElementById("totpCode").value.trim();
  if (!/^\d{6}$/.test(code)) return PayGate.toast("Masukkan kode 6 digit.", "error");
  try {
    await PayGate.api("/api/settings/2fa/enable", { method: "POST", body: JSON.stringify({ code }) });
    PayGate.toast("2FA aktif!", "success");
    await loadTotp();
  } catch (e) { PayGate.toast(e.message, "error"); }
}

async function totpDisableFn() {
  const password = document.getElementById("totpPassword").value;
  if (!password) return PayGate.toast("Masukkan password PayGate.", "error");
  if (!confirm("Matikan 2FA? Akun jadi kurang aman.")) return;
  try {
    await PayGate.api("/api/settings/2fa/disable", { method: "POST", body: JSON.stringify({ password }) });
    PayGate.toast("2FA dimatikan.", "success");
    document.getElementById("totpPassword").value = "";
    await loadTotp();
  } catch (e) { PayGate.toast(e.message, "error"); }
}

function totpCancel() {
  totpSetup.hidden = true;
  totpStartBtn.hidden = false;
  loadTotp();
}

// ---------- Pajak ----------
const taxEnabled = document.getElementById("taxEnabled");
const taxMode = document.getElementById("taxMode");
const taxValue = document.getElementById("taxValue");
const taxDirection = document.getElementById("taxDirection");
const taxStatus = document.getElementById("taxStatus");

function taxValueText(mode, value) {
  if (mode === "percent") { const p = value / 100; return (Number.isInteger(p) ? p : String(p).replace(".", ",")) + "%"; }
  return "Rp" + Number(value || 0).toLocaleString("id-ID");
}

function syncTaxHints() {
  const mode = taxMode.value;
  document.getElementById("taxValueHint").textContent = mode === "percent"
    ? "Isi 11 untuk 11%. Isi 250 untuk 2,5%."
    : "Isi angka rupiah, contoh 2500 untuk Rp2.500.";
  taxValue.placeholder = mode === "percent" ? "11" : "2500";
  const d = taxDirection.value;
  document.getElementById("taxDirectionHint").textContent =
    d === "deduct" ? "Contoh: customer bayar Rp50.000, pajak jadi Rp5.500, uang masuk Rp44.500."
    : d === "add" ? "Contoh: customer bayar Rp50.000, pajak jadi Rp5.500, uang masuk Rp55.500."
    : "Pajak cuma dicatat sebagai info. Uang masuk tetap Rp50.000.";
}

async function loadTax() {
  try {
    const t = await PayGate.api("/api/settings/tax");
    taxEnabled.value = t.enabled ? "1" : "0";
    taxMode.value = t.mode;
    // persen disimpan sebagai basis poin (1100 -> tampil 11)
    taxValue.value = t.mode === "percent" ? (t.value ? String(t.value / 100).replace(".", ",") : "") : (t.value ? String(t.value) : "");
    taxDirection.value = t.direction;
    taxStatus.className = t.enabled ? "alert alert-success" : "alert alert-info";
    taxStatus.textContent = t.enabled
      ? `Pajak aktif: ${taxValueText(t.mode, t.value)} (${t.direction === "deduct" ? "dipotong dari uang masuk" : t.direction === "add" ? "ditambahkan ke uang masuk" : "cuma catatan"}).`
      : "Pajak belum dipakai. Semua uang masuk dicatat utuh.";
    syncTaxHints();
  } catch (e) { taxStatus.textContent = "Pengaturan pajak belum bisa dimuat."; }
}

function taxRawFromInput() {
  const cleaned = String(taxValue.value).replace(/[^\d]/g, "");
  if (!cleaned) return 0;
  if (taxMode.value === "percent") {
    // input pakai koma/titik desimal, simpan sebagai basis poin
    const normalized = String(taxValue.value).trim().replace(",", ".");
    const pct = Number(normalized);
    return Number.isFinite(pct) && pct >= 0 ? Math.round(pct * 100) : 0;
  }
  return Number(cleaned);
}

async function saveTax() {
  const value = taxRawFromInput();
  const enabled = taxEnabled.value === "1";
  if (enabled && value <= 0) return PayGate.toast("Isi angka pajak dulu.", "error");
  try {
    await PayGate.api("/api/settings/tax", { method: "POST", body: JSON.stringify({ enabled, mode: taxMode.value, direction: taxDirection.value, value }) });
    PayGate.toast("Pajak disimpan.", "success");
    await loadTax();
  } catch (e) { PayGate.toast(e.message, "error"); }
}

function previewTax() {
  const value = taxRawFromInput(), mode = taxMode.value, dir = taxDirection.value;
  const gross = 50000;
  const taxAmount = mode === "percent" ? Math.round((gross * value) / 10000) : value;
  const net = dir === "deduct" ? gross - taxAmount : dir === "add" ? gross + taxAmount : gross;
  const box = document.getElementById("taxPreview");
  box.className = "alert alert-info";
  box.textContent = `Customer bayar Rp${gross.toLocaleString("id-ID")}. Pajak ${taxValueText(mode, value)} = Rp${taxAmount.toLocaleString("id-ID")}. Uang kamu masuk Rp${net.toLocaleString("id-ID")}.`;
}

loadSettings();
loadTotp();
loadTax();
taxMode.addEventListener("change", syncTaxHints);
taxDirection.addEventListener("change", syncTaxHints);

  PayGate.bindActions({
    "change-password": el => changePassword(),
    "logout-all": el => logoutAll(),
    "totp-start": el => totpStart(),
    "totp-enable": el => totpEnable(),
    "totp-disable": el => totpDisableFn(),
    "totp-cancel": el => totpCancel(),
    "tax-save": el => saveTax(),
    "tax-preview": el => previewTax()
  });
}

if (document.body.dataset.page === "transactions") {

async function loadTx() {
  try {
    const d = await PayGate.api("/api/transactions");
    const tbody = document.getElementById("txRows");
    if (!d.transactions.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><p class="empty-title">Belum ada transaksi.</p><p class="empty-copy">Pembayaran yang cocok akan muncul di sini.</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = d.transactions.map(t => `
      <tr>
        <td><span class="badge badge-neutral" style="text-transform:capitalize;">${PayGate.esc(t.provider)}</span></td>
        <td class="mono small">${PayGate.esc(t.txid)}</td>
        <td style="font-weight:700;">${PayGate.fmtRupiah(t.amount)}</td>
        <td class="muted small">${PayGate.fmtDate(t.tx_time || t.seen_at)}</td>
        <td>${t.payment_origin === "live" && t.consumed_by ? '<span class="badge badge-success"><span class="dot"></span>Cocok tagihan</span>' : '<span class="badge badge-info"><span class="dot"></span>Belum ada tagihan</span>'}</td>
      </tr>`).join("");
  } catch (e) { PayGate.toast(e.message, "error"); }
}

loadTx();
setInterval(loadTx, 8000);

}

if (document.body.dataset.page === "income") {

function incomeStat(label, value, sub, color) {
  return `<div class="stat fade-up"><div class="stat-content">
      <div class="stat-label">${label}</div>
      <div class="stat-value" style="color:var(--${color})">${value}</div>
      <div class="stat-sub">${sub}</div></div></div>`;
}

async function loadIncome() {
  try {
    const d = await PayGate.api("/api/income");
    const s = d.totals || {};
    document.getElementById("incomeTotals").innerHTML = [
      incomeStat("Total Dibayar Customer", PayGate.fmtRupiah(s.gross || 0), (s.count || 0) + " pembayaran", "text"),
      incomeStat("Total Pajak", PayGate.fmtRupiah(s.tax || 0), (s.with_tax || 0) + " pembayaran berpajak", "warning"),
      incomeStat("Uang Masuk Bersih", PayGate.fmtRupiah(s.net || 0), "Setelah pajak", "success"),
      incomeStat("Hari Ini", PayGate.fmtRupiah(s.today || 0), "Pemasukan sejak 00:00", "info")
    ].join("");

    const t = d.tax || {};
    document.getElementById("taxSummary").innerHTML = t.enabled
      ? `<p><strong>Pajak aktif.</strong> ${t.mode === "percent" ? "Persen" : "Nominal"} ${t.mode === "percent" ? (t.value / 100).toString().replace(".", ",") + "%" : PayGate.fmtRupiah(t.value)}, ${t.direction === "deduct" ? "dipotong dari uang masuk" : t.direction === "add" ? "ditambahkan ke uang masuk" : "cuma dicatat sebagai info"}.</p>`
      : `<p class="muted">Belum pakai pajak. Semua uang masuk dicatat utuh.</p>`;

    const tbody = document.getElementById("incomeRows");
    if (!(d.income || []).length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p class="empty-title">Belum ada pemasukan.</p><p class="empty-copy">Pembayaran QRIS yang cocok akan muncul di sini otomatis.</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = (d.income || []).map(i => `
      <tr>
        <td class="muted small">${PayGate.fmtDate(i.created_at)}</td>
        <td>${PayGate.esc(i.label || "Pembayaran QRIS")}<div class="muted small mono">${PayGate.esc(i.order_id || "")}</div></td>
        <td>${PayGate.fmtRupiah(i.gross_amount)}</td>
        <td>${i.tax_amount ? '<span class="badge badge-warning">' + PayGate.fmtRupiah(i.tax_amount) + '</span>' : '<span class="muted small">—</span>'}</td>
        <td style="font-weight:700;">${PayGate.fmtRupiah(i.net_amount)}</td>
        <td><span class="badge badge-success"><span class="dot"></span>Masuk</span></td>
      </tr>`).join("");
  } catch (e) { PayGate.toast(e.message, "error"); }
}

loadIncome();
setInterval(loadIncome, 10000);

}

if (document.body.dataset.page === "dashboard") {

(async function () {
  try {
    const d = await PayGate.api("/api/dashboard/summary");
    const s = d.stats;

    const statCards = document.getElementById("statCards");
    statCards.innerHTML = [
      card("Uang Masuk", PayGate.fmtRupiah(s.revenue_paid || 0), "Dari pembayaran yang cocok", "c-success", svgMoney),
      card("Tagihan Menunggu", s.orders_pending, "Belum dibayar", "c-warning", svgClock),
      card("Tagihan Lunas", s.orders_paid + " / " + s.orders_total, "Dari total tagihan", "c-info", svgCheck),
      card("Kunci API", (s.api_keys || 0) + " kunci", "Untuk integrasi website", "c-soft", svgKey)
    ].join("");

    // Recent orders
    const tbody = document.getElementById("recentOrders");
    if (!d.recentOrders.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><p class="empty-title">Belum ada order.</p><p class="empty-copy">Order terbaru akan muncul di sini.</p></div></td></tr>';
    } else {
      tbody.innerHTML = d.recentOrders.map(o => `
        <tr>
          <td class="mono">${PayGate.esc(o.id)}</td>
          <td style="font-weight:700;">${PayGate.fmtRupiah(o.amount)}</td>
          <td>${badge(o.is_expired ? "expired" : o.status)}</td>
          <td class="muted small">${PayGate.esc(o.created_at_label)}</td>
        </tr>`).join("");
    }

    document.getElementById("accountStatus").innerHTML = `
      <div class="account-intro">
        <p class="account-label">GoPay / ShopeePay</p>
        <p class="account-note muted small">${document.body.dataset.labOwner === "true" ? "Kelola akun, periksa koneksi, dan pantau order." : "Akses dibatasi ke pemilik akun."}</p>
      </div>
      <div class="account-actions"><a class="btn btn-outline" href="/accounts">Lihat status integrasi</a></div>`;
  } catch (e) {
    PayGate.toast(e.message, "error");
  }
})();

function card(label, value, sub, color, icon) {
  return `<div class="stat fade-up">
    <div class="stat-icon ${color}" aria-hidden="true">${icon}</div>
    <div class="stat-content"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>
  </div>`;
}
function badge(status) {
  const map = {
    pending: ['badge-warning','Menunggu'], paid: ['badge-success','Lunas'], expired: ['badge-danger','Kadaluarsa'],
    active: ['badge-success','Aktif'], error: ['badge-danger','Error'], failed: ['badge-danger','Gagal']
  };
  const [cls,label] = map[status] || ['badge-neutral', status];
  return `<span class="badge ${cls}"><span class="dot"></span>${PayGate.esc(label)}</span>`;
}
const svgMoney = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/></svg>';
const svgClock = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
const svgCheck = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>';
const svgKey = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';

  PayGate.bindActions({

  });
}