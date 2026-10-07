const MODE=document.body.dataset.mode,M=MODE=='m',K='td_'+MODE;
const $=s=>document.querySelector(s);
const F=n=>Number(n).toLocaleString('fr-FR')+' FCFA';
const E=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let TOK='';try{TOK=localStorage.getItem(K)||''}catch(e){}
const S={pg:TOK?(M?'home':'dash'):'splash',id:0,sh:0,pm:'Wave',info:'',me:null,ton:[],pays:[],N:[],msgs:[],refs:[],st:null,mem:[],at:[],tx:[],rep:[],
 f:{mem:'Tous',aton:'Tous',pay:'Toutes'},q:{mem:'',aton:'',pay:''}};
const CH={mem:['Tous','Actifs','Inactifs'],aton:['Tous','En cours','Terminées'],pay:['Toutes','En cours','Terminées']};
const PH={mem:'Rechercher un membre…',aton:'Rechercher une tontine…',pay:'Rechercher une transaction…'};
const EM={mem:['🧑‍🤝‍🧑','Aucun membre enregistré','Les membres apparaîtront ici une fois inscrits.'],aton:['👥','Aucune tontine enregistrée','Les tontines apparaîtront ici.'],pay:['💳','Aucune transaction enregistrée','Les transactions apparaîtront ici.']};
const T={home:'Tontine Digital 1.0',ton:'Mes tontines',det:'Détail de la tontine',new:'Créer une tontine',payf:'Déclarer un paiement',cot:'Cotisations',par:'Parrainage',disc:'Discussion',chat:'Discussion',prof:'Mon profil',pedit:'Modifier mon profil',pw:'Changer le mot de passe',not:'Notifications',login:'Connexion',signup:'Créer un compte',forgot:'Mot de passe oublié',dash:'Tableau de bord',aton:'Gestion des tontines',mem:'Gestion des membres',pay:'Gestion des paiements',plus:'Plus',aprof:'Mon profil',rap:'Rapports',set:'Paramètres'};
const NAV=M?[['home','🏠','Accueil'],['ton','👥','Tontines'],['disc','💬','Messages'],['prof','👤','Profil']]:[['dash','🏠','Accueil'],['aton','👥','Tontines'],['mem','🧑‍🤝‍🧑','Membres'],['pay','💳','Transactions'],['plus','⋯','Plus']];
const PAR={det:'ton',new:'ton',payf:'det',chat:'disc',cot:'home',par:'home',not:'home',pedit:'prof',pw:M?'prof':'aprof',rap:'plus',aprof:'plus',set:'plus',login:'splash',signup:'splash',forgot:'splash'};
const ROOT=NAV.map(n=>n[0]);

async function api(p,o={}){const r=await fetch('/api'+p,{method:o.m||'GET',headers:{'Content-Type':'application/json',...(TOK?{Authorization:'Bearer '+TOK}:{})},body:o.b?JSON.stringify(o.b):undefined});let d={};try{d=await r.json()}catch(e){}if(r.status==401&&TOK)out();if(!r.ok)throw new Error(d.error||'Une erreur est survenue.');return d}
const tr=async f=>{try{return await f()}catch(e){toast(e.message)}};
function tok(t){TOK=t;try{localStorage.setItem(K,t)}catch(e){}}
function out(){TOK='';try{localStorage.removeItem(K)}catch(e){}S.me=null;S.pg='splash';R()}
function toast(m){const t=$('#toast');if(!t)return;t.textContent=m;t.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove('show'),3200)}
function go(p,i){S.pg=p;if(i!=null)S.id=i;R();load(p)}
async function load(p){if(!TOK)return;await tr(async()=>{
 if(M){
  if(['home','prof','par'].includes(p))S.me=await api('/me');
  if(['ton','det','disc','payf'].includes(p))S.ton=await api('/tontines');
  if(p=='payf'&&!S.info)S.info=(await api('/config')).payInfo;
  if(p=='cot')S.pays=await api('/payments');
  if(p=='not')S.N=await api('/notifications');
  if(p=='par')S.refs=await api('/referrals');
  if(p=='chat')S.msgs=await api('/tontines/'+S.id+'/messages');
 }else{
  if(p=='dash'){S.st=await api('/admin/stats');S.tx=await api('/admin/payments')}
  if(p=='mem')S.mem=await api('/admin/members');
  if(p=='aton')S.at=await api('/admin/tontines');
  if(p=='pay')S.tx=await api('/admin/payments');
  if(p=='rap')S.rep=await api('/admin/reports');
 }
 if(S.pg==p)R()})}
async function login(){const id=$('#u').value.trim(),pw=$('#pw').value;if(!id||!pw){toast('Saisissez vos identifiants.');return}
 await tr(async()=>{const d=await api('/login',{m:'POST',b:{id,password:pw}});if(d.role!=(M?'member':'admin'))throw new Error('Ce compte n\u2019a pas accès à cet espace.');tok(d.token);go(M?'home':'dash')})}
async function signup(){const name=$('#sn').value.trim(),phone=$('#st').value.trim(),password=$('#pw').value,referral=$('#sr').value.trim();
 await tr(async()=>{const d=await api('/register',{m:'POST',b:{name,phone,password,referral}});tok(d.token);go('home')})}
async function mk(){await tr(async()=>{await api('/tontines',{m:'POST',b:{name:$('#nn').value,amount:$('#na').value,max_members:$('#nm').value||10}});toast('Tontine créée.');go('ton')})}
async function join(id){await tr(async()=>{await api('/tontines/'+id+'/join',{m:'POST'});toast('Vous avez rejoint la tontine.');S.ton=await api('/tontines');R()})}
async function decl(){await tr(async()=>{await api('/payments',{m:'POST',b:{tontine_id:S.id,method:S.pm,reference:$('#rf').value}});toast('Paiement déclaré. En attente de confirmation.');go('cot')})}
async function snd(){const v=$('#mi').value.trim();if(!v)return;await tr(async()=>{await api('/tontines/'+S.id+'/messages',{m:'POST',b:{body:v}});S.msgs=await api('/tontines/'+S.id+'/messages');R();const b=$('.body');b.scrollTop=b.scrollHeight})}
function cp(){const c=S.me&&S.me.referral_code;try{navigator.clipboard.writeText(c).then(()=>toast('Code copié.'),()=>toast('Copie impossible, notez le code.'))}catch(e){toast('Copie impossible, notez le code.')}}
async function sv(){await tr(async()=>{await api('/me',{m:'PUT',b:{name:$('#en').value,phone:$('#et').value,email:$('#ee').value}});S.me=await api('/me');go('prof');toast('Profil mis à jour.')})}
async function chpw(){await tr(async()=>{await api('/me/password',{m:'POST',b:{old:$('#po').value,neu:$('#pn').value}});toast('Mot de passe modifié.');go(PAR.pw)})}
async function conf(id,st){await tr(async()=>{await api('/admin/payments/'+id,{m:'PATCH',b:{status:st}});S.tx=await api('/admin/payments');R();toast(st=='Terminée'?'Paiement confirmé.':'Paiement rejeté.')})}
async function setm(id,st){await tr(async()=>{await api('/admin/members/'+id,{m:'PATCH',b:{status:st}});S.mem=await api('/admin/members');R()})}
async function sett(id){await tr(async()=>{await api('/admin/tontines/'+id,{m:'PATCH',b:{status:'Terminée'}});S.at=await api('/admin/tontines');R()})}

function pc(k,s){return k=='pay'?(s=='Terminée'?'':s=='En cours'?'wait':'off'):(s=='Actif'||s=='En cours'?'':'off')}
function lst(k){const q=S.q[k].toLowerCase(),f=S.f[k],map={'Actifs':'Actif','Inactifs':'Inactif','En cours':'En cours','Terminées':'Terminée'};
 const src=k=='mem'?S.mem:k=='aton'?S.at:S.tx,nm=i=>k=='pay'?i.who:i.name;
 const r=src.filter(i=>(f=='Tous'||f=='Toutes'||i.status==map[f])&&nm(i).toLowerCase().includes(q));
 if(!r.length){if(src.length)return `<div class="empty">Aucun résultat pour cette recherche.</div>`;const e=EM[k];return `<div class="empty"><i>${e[0]}</i><b>${e[1]}</b>${e[2]}</div>`}
 return r.map(i=>{let sub,right='',act='';
  if(k=='mem'){sub=i.phone||i.email||'';act=`<button class="lnk" onclick="setm(${i.id},'${i.status=='Actif'?'Inactif':'Actif'}')">${i.status=='Actif'?'Désactiver':'Réactiver'}</button>`}
  if(k=='aton'){sub=F(i.amount)+' · '+i.members+' membres';if(i.status=='En cours')act=`<button class="lnk" onclick="sett(${i.id})">Clôturer</button>`}
  if(k=='pay'){sub=i.tontine+' · '+i.method+' · réf. '+i.reference+' · '+i.date;right=F(i.amount);if(i.status=='En cours')act=`<button class="lnk" onclick="conf(${i.id},'Terminée')">Confirmer</button><button class="lnk" onclick="conf(${i.id},'Rejetée')">Rejeter</button>`}
  return `<div class="row" style="flex-wrap:wrap"><div class="av">${E(nm(i)[0])}</div><div class="gr"><b>${E(nm(i))}</b><br><span class="mut">${E(sub)}</span></div>${right?`<b>${right}</b>`:''}<span class="pill ${pc(k,i.status)}">${i.status}</span>${act?`<div style="width:100%;display:flex;gap:6px;justify-content:flex-end">${act}</div>`:''}</div>`}).join('')}
const mgmt=k=>`<input aria-label="${PH[k]}" placeholder="${PH[k]}" value="${E(S.q[k])}" oninput="S.q['${k}']=this.value;$('#ml').innerHTML=lst('${k}')"><div class="chips">${CH[k].map(c=>`<button class="${S.f[k]==c?'on':''}" onclick="S.f['${k}']='${c}';R()">${c}</button>`).join('')}</div><div id="ml" style="display:flex;flex-direction:column;gap:8px">${lst(k)}</div>`;
const empty=(i,t,s,b,p)=>`<div class="empty"><i>${i}</i><b>${t}</b>${s}</div>${b?`<button class="btn" onclick="${p}">${b}</button>`:''}`;
const field=(l,id,ph,ty,v,ac)=>`<label for="${id}">${l}</label><input id="${id}" type="${ty||'text'}" placeholder="${ph||''}" value="${E(v||'')}" ${ac?`autocomplete="${ac}"`:''}>`;
const tcard=t=>`<div class="mut">Montant : ${F(t.amount)}<br>Membres : ${t.members}/${t.max_members}<br>Prochaine : ${t.next_date||'—'}</div>`;
const V={
home:()=>`<div class="hello"><div class="pic">👤</div><div><b>Bonjour${S.me?', '+E(S.me.name.split(' ')[0]):','}</b><br><small>Bienvenue sur Tontine Digital 1.0</small></div></div><div class="tiles">${[['ton','👥','Mes Tontines'],['cot','🗓️','Cotisations'],['par','🤝','Parrainage'],['disc','💬','Discussion'],['not','🔔','Notifications'],['prof','👤','Mon Profil']].map(x=>`<button class="tile" onclick="go('${x[0]}')"><span>${x[1]}</span>${x[2]}</button>`).join('')}</div>`,
ton:()=>(S.ton.length?S.ton.map(t=>`<div class="card"><b>${E(t.name)}</b>${tcard(t)}<button class="btn" onclick="go('det',${t.id})">${t.joined?'Voir détails':'Voir et rejoindre'}</button></div>`).join(''):empty('👥','Aucune tontine pour le moment','Créez la première tontine.'))+`<button class="btn gold" onclick="go('new')">Créer une tontine</button>`,
det:()=>{const t=S.ton.find(x=>x.id==S.id);if(!t)return empty('👥','Tontine introuvable','','Voir les tontines',"go('ton')");return `<div class="card"><b>${E(t.name)}</b>${tcard(t)}<span class="pill ${t.joined?'':'off'}" style="align-self:flex-start">${t.joined?'Vous êtes membre':'Non membre'}</span></div>`+(t.joined?`<button class="btn" onclick="go('payf',${t.id})">Déclarer un paiement</button><button class="btn out" onclick="go('chat',${t.id})">Écrire aux membres</button>`:`<button class="btn gold" onclick="join(${t.id})">Rejoindre cette tontine</button>`)},
new:()=>`<div class="card">${field('Nom de la tontine','nn','Ex. Tontine du quartier')}${field('Montant de la cotisation (FCFA)','na','Ex. 25000','number')}${field('Nombre de membres maximum','nm','10','number')}</div><button class="btn gold" onclick="mk()">Créer la tontine</button>`,
payf:()=>{const t=S.ton.find(x=>x.id==S.id);if(!t)return empty('💳','Chargement…','');return `<div class="card"><b>${E(t.name)}</b><span class="mut">Cotisation : ${F(t.amount)}</span>${S.info?`<span class="mut">${E(S.info)}</span>`:''}</div><div class="chips">${['Wave','Orange Money','MTN MoMo'].map(c=>`<button class="${S.pm==c?'on':''}" onclick="S.pm='${c}';R()">${c}</button>`).join('')}</div><div class="card">${field('Référence de la transaction','rf','Ex. TX123456')}</div><button class="btn gold" onclick="decl()">Déclarer mon paiement</button><p class="mut" style="text-align:center;margin:0">L\u2019administrateur confirmera votre paiement après vérification.</p>`},
cot:()=>S.pays.length?S.pays.map(c=>`<div class="row"><span class="ic">🗓️</span><div class="gr"><b>${E(c.tontine)}</b><br><span class="mut">${c.method} · ${c.date}</span></div><div style="text-align:right"><b>${F(c.amount)}</b><br><span class="pill ${pc('pay',c.status)}">${c.status}</span></div></div>`).join(''):empty('🗓️','Aucune cotisation en cours','Vous n\u2019avez pas encore de cotisation à effectuer.','Voir les tontines',"go('ton')"),
par:()=>{const has=S.refs.length;return (has?S.refs.map(r=>`<div class="row"><span class="ic">🤝</span><div class="gr"><b>${E(r.name)}</b><br><span class="mut">Inscrit le ${r.date}</span></div></div>`).join(''):empty('🤝','Aucun parrainage pour le moment','Partagez votre code parrain pour inviter des amis et gagner des commissions.'))+(S.sh||has?`<div class="code">${S.me?E(S.me.referral_code):'…'}</div><button class="btn out" onclick="cp()">Copier mon code</button>`:`<button class="btn" onclick="S.sh=1;R()">Mon code parrain</button>`)},
disc:()=>{const j=S.ton.filter(t=>t.joined);return j.length?j.map(t=>`<button class="row" onclick="go('chat',${t.id})"><span class="ic">💬</span><div class="gr"><b>${E(t.name)}</b><br><span class="mut">${t.members} membres</span></div></button>`).join(''):empty('💬','Aucune discussion pour le moment','Rejoignez une tontine pour échanger avec les autres membres.','Voir les tontines',"go('ton')")},
chat:()=>(S.msgs.length?S.msgs.map(m=>`<div class="msg ${m.mine?'me':''}"><small>${E(m.mine?'Vous':m.who)}</small>${E(m.body)}</div>`).join(''):`<div class="mut" style="text-align:center">Écrivez le premier message à vos co-membres.</div>`)+`<div class="send"><input id="mi" maxlength="500" aria-label="Message" placeholder="Écrire un message" onkeydown="if(event.key=='Enter')snd()"><button class="btn gold" onclick="snd()">Envoyer</button></div>`,
prof:()=>{const u=S.me||{};return `<div class="avt">👤</div>`+[['👤','Nom complet',u.name],['📞','Téléphone',u.phone],['✉️','Email',u.email],['#️⃣','Code parrain',u.referral_code]].map(x=>`<div class="row"><span class="ic">${x[0]}</span><div class="gr"><span class="mut">${x[1]}</span><br><b>${x[2]?E(x[2]):'—'}</b></div></div>`).join('')+`<button class="btn" onclick="go('pedit')">Modifier mon profil</button><button class="btn out" onclick="go('pw')">Changer le mot de passe</button><button class="btn out" onclick="out()">Se déconnecter</button>`},
pedit:()=>{const u=S.me||{};return `<div class="card">${field('Nom complet','en','Votre nom','text',u.name)}${field('Téléphone','et','Votre numéro','tel',u.phone)}${field('Email','ee','Votre email','email',u.email)}</div><button class="btn" onclick="sv()">Enregistrer</button>`},
pw:()=>`<div class="card">${field('Ancien mot de passe','po','','password','','current-password')}${field('Nouveau mot de passe (8 caractères min.)','pn','','password','','new-password')}</div><button class="btn" onclick="chpw()">Modifier le mot de passe</button>`,
not:()=>S.N.length?S.N.map(n=>`<div class="row"><span class="ic">🔔</span><div class="gr">${E(n.body)}<br><span class="mut">${n.date}</span></div></div>`).join(''):empty('🔔','Aucune notification pour le moment','Vous serez informé de tout ce qui concerne vos tontines.','Voir les tontines',"go('ton')"),
login:()=>`<div class="card">${field(M?'Téléphone':'Email','u',M?'07 00 00 00 00':'admin@tontinedigital.com',M?'tel':'email','',M?'tel':'username')}${field('Mot de passe','pw','••••••••','password','','current-password')}</div><button class="btn" onclick="login()">Se connecter</button>${M?`<button class="lnk" onclick="go('signup')">Créer un compte</button>`:`<button class="lnk" onclick="go('forgot')">Mot de passe oublié ?</button>`}`,
signup:()=>`<div class="card">${field('Nom complet','sn','Votre nom','text','','name')}${field('Téléphone','st','07 00 00 00 00','tel','','tel')}${field('Mot de passe (8 caractères min.)','pw','','password','','new-password')}${field('Code parrain (facultatif)','sr','TD-XXXXXX')}</div><button class="btn gold" onclick="signup()">Créer mon compte</button>`,
forgot:()=>`<div class="card"><b>Mot de passe oublié</b><span class="mut">Pour réinitialiser votre mot de passe, contactez l\u2019administrateur principal de la plateforme.</span></div><button class="btn out" onclick="go('login')">Retour à la connexion</button>`,
dash:()=>{const st=S.st||{members:0,tontines:0,confirmed:0,payments:0};return `<div class="stats">${[['👥','Membres',st.members],['🗂️','Tontines',st.tontines],['🗓️','Cotisations',st.confirmed],['💳','Transactions',st.payments]].map(x=>`<div class="stat"><span class="mut">${x[0]} ${x[1]}</span><b>${x[2]}</b></div>`).join('')}</div><b>Activité récente</b>`+(S.tx.length?S.tx.slice(0,4).map(x=>`<div class="row"><div class="av">${E(x.who[0])}</div><div class="gr"><b>${E(x.who)}</b><br><span class="mut">${E(x.tontine)} · ${x.date}</span></div><b>${F(x.amount)}</b></div>`).join(''):empty('📊','Aucune activité pour le moment',''))},
aton:()=>mgmt('aton'),mem:()=>mgmt('mem'),pay:()=>mgmt('pay'),
plus:()=>[['aprof','👤','Mon profil'],['rap','📈','Rapports'],['set','⚙️','Paramètres']].map(x=>`<button class="row" onclick="go('${x[0]}')"><span class="ic">${x[1]}</span>${x[2]}</button>`).join('')+`<button class="row" onclick="out()"><span class="ic">🚪</span>Déconnexion</button>`,
aprof:()=>`<div class="avt">👤</div><b style="text-align:center">Administrateur</b><button class="row" onclick="go('pw')"><span class="ic">🔑</span>Changer le mot de passe</button><button class="row" onclick="go('set')"><span class="ic">⚙️</span>Paramètres</button><button class="row" onclick="out()"><span class="ic">🚪</span>Déconnexion</button>`,
rap:()=>{const tot=S.rep.reduce((a,x)=>a+x.total,0);if(!tot)return empty('📈','Aucun rapport disponible','Les rapports apparaîtront ici.');const mx=Math.max(1,...S.rep.map(x=>x.total));return `<div class="stats"><div class="stat"><span class="mut">Total confirmé</span><b style="font-size:16px">${F(tot)}</b></div><div class="stat"><span class="mut">Commission 1 %</span><b style="font-size:16px">${F(Math.round(tot*.01))}</b></div></div><b>Collecte par tontine</b>`+S.rep.map(x=>`<div class="card"><span>${E(x.name)}</span><div class="bar" style="width:${Math.max(4,x.total/mx*100)}%"></div><span class="mut">${F(x.total)}</span></div>`).join('')},
set:()=>['🔔 Notifications','🛡️ Sécurité','💾 Sauvegarde des données','ℹ️ À propos','❓ Aide'].map(x=>`<button class="row" onclick="toast('Bientôt disponible.')">${x}</button>`).join('')
};
function R(){const p=S.pg,ph=$('#ph'),keep={};['mi','rf'].forEach(i=>{const e=$('#'+i);if(e)keep[i]=e.value});ph.className='phone'+(M?'':' a');
 if(p=='splash'){ph.innerHTML=`<div class="splash"><div class="logo"><span>👥</span><i>🪙</i></div><h1>Tontine<br><em>Digital 1.0</em></h1><p>${M?'Ensemble pour un avenir meilleur':'Espace Administrateur'}</p><div class="sb"><button class="btn" onclick="go('login')">Se connecter</button><button class="btn o2" onclick="go('${M?'signup':'forgot'}')">${M?'Créer un compte':'Mot de passe oublié ?'}</button></div></div><div id="toast" role="status"></div>`;return}
 const auth=['login','signup','forgot'].includes(p),sub=!ROOT.includes(p)&&p!='home',on=PAR[p]||p;
 ph.innerHTML=`<div class="top">${sub?`<button class="bk" aria-label="Retour" onclick="go('${PAR[p]||ROOT[0]}')">←</button>`:'<span>🌿</span>'}<span class="sp">${T[p]}</span>${auth?'':`<button class="bl" aria-label="Notifications" onclick="${M?"go('not')":"go('plus')"}">${M?'🔔':'⋯'}</button>`}</div><div class="body">${V[p]()}</div>${auth?'':`<div class="nav">${NAV.map(n=>`<button class="${n[0]==on?'on':''}" onclick="go('${n[0]}')"><i>${n[1]}</i>${n[2]}</button>`).join('')}</div>`}<div id="toast" role="status"></div>`;
 for(const i in keep){const e=$('#'+i);if(e)e.value=keep[i]}}
setInterval(()=>{if(TOK&&S.pg=='chat'&&M)api('/tontines/'+S.id+'/messages').then(d=>{if(S.pg=='chat'&&JSON.stringify(d)!=JSON.stringify(S.msgs)){S.msgs=d;R()}}).catch(()=>{})},10000);
R();if(TOK)load(S.pg);
