// Adventure World Online — motor de jogo (física estilo clássico 16-bit, arte original)
// Física calibrada para sensação SMW: aceleração progressiva, inércia, pulo variável,
// pulo com impulso de corrida, voo por velocidade (Manto), montaria Tiko, multiplayer 4P.

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

// ---------- Física (exportada para testes) ----------
const PHYSICS = {
  gravity: 0.55, maxFall: 12,
  walkMax: 3.4, runMax: 6.8,
  accelGround: 0.22, accelAir: 0.14, friction: 0.28, skidDecel: 0.35,
  jumpWalk: -11.0, jumpRun: -14.5, jumpCut: 0.45,
  stompBounce: -9.0, stompBounceHold: -12.5,
  coyote: 6, jumpBuffer: 6,
  capeMinSpeed: 5.2, capeClimb: -3.6, capeGlide: 2.6, capeDive: 8.0,
  mountJumpBoost: 1.25,
};
window.PHYSICS = PHYSICS;

// Simula 1 frame de física horizontal/vertical (usado nos testes)
function simulateStep(s, input) {
  const P = PHYSICS;
  if (input.left) s.vx -= (s.onGround ? P.accelGround : P.accelAir);
  if (input.right) s.vx += (s.onGround ? P.accelGround : P.accelAir);
  if (!input.left && !input.right && s.onGround) {
    s.vx -= Math.sign(s.vx) * Math.min(Math.abs(s.vx), P.friction);
  }
  const max = input.run ? P.runMax : P.walkMax;
  s.vx = Math.max(-max, Math.min(max, s.vx));
  if (input.jumpPressed && s.onGround) s.vy = input.run ? P.jumpRun : P.jumpWalk;
  if (!input.jump && s._pj && s.vy < 0) s.vy *= P.jumpCut; // corte único ao soltar
  s._pj = input.jump;
  s.vy = Math.min(s.vy + P.gravity, P.maxFall);
  s.x += s.vx; s.y += s.vy;
  return s;
}
window.simulateStep = simulateStep;

// ---------- Utilidades ----------
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const overlap = (a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
function rect(x,y,w,h){return{x,y,w,h};}

// ---------- Áudio (WebAudio, sons originais) ----------
let AC=null;
function beep(freq,dur,type='square',vol=0.12,slide=0){
  try{
    if(!AC) AC=new (window.AudioContext||window.webkitAudioContext)();
    const o=AC.createOscillator(),g=AC.createGain();
    o.type=type;o.frequency.value=freq;
    if(slide) o.frequency.exponentialRampToValueAtTime(Math.max(30,freq+slide),AC.currentTime+dur);
    g.gain.value=vol;g.gain.exponentialRampToValueAtTime(0.001,AC.currentTime+dur);
    o.connect(g).connect(AC.destination);o.start();o.stop(AC.currentTime+dur);
  }catch(e){}
}
const SFX={
  jump:()=>beep(520,0.12,'square',0.10,300),
  coin:()=>{beep(988,0.08,'square',0.10);setTimeout(()=>beep(1319,0.15,'square',0.10),60);},
  stomp:()=>beep(220,0.12,'square',0.14,-140),
  power:()=>{beep(523,0.1);setTimeout(()=>beep(659,0.1),90);setTimeout(()=>beep(784,0.2),180);},
  hurt:()=>beep(300,0.25,'sawtooth',0.12,-200),
  fire:()=>beep(800,0.1,'sawtooth',0.08,-400),
  break_:()=>beep(150,0.15,'square',0.14,-80),
  goal:()=>{[523,659,784,1047].forEach((f,i)=>setTimeout(()=>beep(f,0.18,'square',0.12),i*130));},
  die:()=>beep(400,0.5,'sawtooth',0.12,-350),
};

// ---------- Save ----------
const SAVE_KEY='awo_save_v1';
let save=JSON.parse(localStorage.getItem(SAVE_KEY)||'{"done":[],"secret":[],"coins":0}');
function persist(){localStorage.setItem(SAVE_KEY,JSON.stringify(save));}

// ---------- Input ----------
const keys={};
addEventListener('keydown',e=>{keys[e.code]=true;if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))e.preventDefault();});
addEventListener('keyup',e=>{keys[e.code]=false;});
const KEYMAPS=[
  {left:'KeyA',right:'KeyD',jump:'KeyW',down:'KeyS',run:'KeyE',item:'KeyQ',mount:'KeyF'},
  {left:'ArrowLeft',right:'ArrowRight',jump:'ArrowUp',down:'ArrowDown',run:'Period',item:'Comma',mount:'Slash'},
  {left:'KeyJ',right:'KeyL',jump:'KeyI',down:'KeyK',run:'KeyU',item:'KeyO',mount:'KeyP'},
  {left:'Numpad4',right:'Numpad6',jump:'Numpad8',down:'Numpad5',run:'Numpad0',item:'Numpad7',mount:'Numpad9'},
];
function readInput(idx){
  const m=KEYMAPS[idx];
  let left=!!keys[m.left],right=!!keys[m.right],jump=!!keys[m.jump],down=!!keys[m.down],run=!!keys[m.run];
  // gamepad
  const gp=navigator.getGamepads?[...navigator.getGamepads()].find(g=>g&&g.connected):null;
  if(gp){
    const ax=gp.axes[0]||0,ay=gp.axes[1]||0;
    if(ax<-0.3)left=true; if(ax>0.3)right=true; if(ay>0.5)down=true;
    if(gp.buttons[0]?.pressed||gp.buttons[1]?.pressed)jump=true;
    if(gp.buttons[2]?.pressed||gp.buttons[3]?.pressed)run=true;
    if(gp.buttons[4]?.pressed)jump=true;
  }
  const jp=jump&&!readInput._prev?.[idx];
  if(!readInput._prev)readInput._prev={};
  readInput._prev[idx]=jump;
  return{left,right,jump,down,run,jumpPressed:jp,itemPressed:!!keys[m.item]&&!readInput._pi?.[idx],mountPressed:!!keys[m.mount]&&!readInput._pm?.[idx]};
}

// ---------- Online entre abas (BroadcastChannel) ----------
let bc=null; try{bc=new BroadcastChannel('awo_room');}catch(e){}
const remotePlayers=new Map(); // id -> {x,y,color,name}
const myId='p'+Math.random().toString(36).slice(2,7);
if(bc){
  bc.onmessage=e=>{
    const d=e.data;
    if(d.id===myId)return;
    if(d.type==='pos')remotePlayers.set(d.id,d);
    if(d.type==='bye')remotePlayers.delete(d.id);
  };
  setInterval(()=>{
    if(game&&game.players&&game.players[0])
      bc.postMessage({type:'pos',id:myId,x:game.players[0].x,y:game.players[0].y});
  },100);
  addEventListener('beforeunload',()=>bc.postMessage({type:'bye',id:myId}));
}

// ---------- Entidades ----------
const COLORS=['#ff5d5d','#4dd0e1','#ffd93b','#b388ff'];
const NAMES=['Nilo','Luma','Bento','Nina'];

class Player{
  constructor(idx,x,y){
    this.idx=idx;this.x=x;this.y=y;this.w=24;this.h=30;
    this.vx=0;this.vy=0;this.dir=1;this.onGround=false;
    this.state='small'; // small|big|fire|cape
    this.star=0;this.invuln=0;this.dead=false;this.deadTimer=0;
    this.reserve=null;this.coyote=0;this.jbuf=0;this.skid=false;
    this.flying=false;this.mount=null;this.finished=false;this.finishTime=0;
    this.anim=0;this.color=COLORS[idx];this.name=NAMES[idx];
  }
  get big(){return this.state!=='small';}
  get hNow(){return this.big?38:30;}
  hurt(){
    if(this.invuln>0||this.star>0||this.dead)return false;
    if(this.mount){this.dismount(true);this.invuln=90;SFX.hurt();return true;}
    if(this.state==='fire'||this.state==='cape'){this.state='big';}
    else if(this.state==='big'){this.state='small';}
    else{this.die();return true;}
    this.invuln=120;SFX.hurt();return true;
  }
  die(){
    if(this.dead)return;
    this.dead=true;this.deadTimer=180;this.vy=-10;SFX.die();
    game.lives--;
  }
  powerUp(type){
    if(type==='mushroom'){if(this.state==='small')this.state='big';}
    if(type==='flower')this.state='fire';
    if(type==='cape')this.state='cape';
    if(type==='star')this.star=600;
    if(type==='1up'){game.lives++;}
    SFX.power();
  }
  dismount(lost){
    if(this.mount){this.mount.rider=null;this.mount=null;}
    if(lost&&game.mountEntity){game.mountEntity.lost=true;game.mountEntity.lostTimer=600;}
  }
}

class Enemy{
  constructor(type,x,y){
    this.type=type;this.x=x;this.y=y;this.w=28;this.h=24;
    this.vx=type==='walker'?-1:type==='chaser'?0:0;this.vy=0;
    this.dir=-1;this.hp=type==='armored'?2:1;this.dead=false;
    this.t=Math.random()*100;this.shootT=120;this.hidden=type==='hider';
    this.shell=false;this.flash=0;
  }
  update(dt){
    if(this.dead)return;
    this.t++;if(this.flash>0)this.flash--;
    const near=game.players.some(p=>!p.dead&&Math.abs(p.x-this.x)<220);
    if(this.type==='walker'){
      this.x+=this.vx*this.dir;
      if(this.t%60===0&&Math.random()<0.02)this.dir*=-1;
    }else if(this.type==='flyer'){
      this.y+=Math.sin(this.t*0.08)*1.2;
      const p=nearestPlayer(this.x,this.y);
      if(p){this.x+=Math.sign(p.x-this.x)*0.7;}
    }else if(this.type==='chaser'){
      const p=nearestPlayer(this.x,this.y);
      if(p&&Math.abs(p.x-this.x)<260){this.dir=Math.sign(p.x-this.x)||1;this.x+=this.dir*1.4;}
    }else if(this.type==='shooter'){
      this.shootT--;
      if(this.shootT<=0&&near){
        this.shootT=150;
        const p=nearestPlayer(this.x,this.y);
        const dx=p?p.x-this.x:1,dy=p?p.y-this.y:0;
        const m=Math.hypot(dx,dy)||1;
        game.projectiles.push({x:this.x,y:this.y,vx:dx/m*3,vy:dy/m*3,hostile:true,r:6,life:240});
        SFX.fire();
      }
    }else if(this.type==='hider'){
      if(this.hidden&&near){this.hidden=false;SFX.stomp();}
      if(!this.hidden)this.x+=this.dir*0.9;
    }else if(this.type==='armored'){
      this.x+=this.dir*0.7;
    }
    // gravidade simples p/ terrestres
    if(['walker','chaser','hider','armored'].includes(this.type)){
      this.vy=Math.min(this.vy+0.5,10);this.y+=this.vy;
      const t=tileAt(this.x+14,this.y+this.h+2);
      if(solidTile(t)){this.y=Math.floor((this.y+this.h)/TILE)*TILE-this.h;this.vy=0;}
      const wall=tileAt(this.x+(this.dir<0?-2:this.w+2),this.y+10);
      if(solidTile(wall))this.dir*=-1;
    }
    // contato com jogadores
    for(const p of game.players){
      if(p.dead)continue;
      const pr=rect(p.x,p.y,p.w,p.hNow);
      if(overlap(this,pr)){
        if(p.star>0){this.kill();continue;}
        const stomp=p.vy>0&&(p.y+p.hNow)-this.y<16;
        if(stomp){
          this.hp--;this.flash=10;SFX.stomp();
          p.vy=keys[KEYMAPS[p.idx].jump]?PHYSICS.stompBounceHold:PHYSICS.stompBounce;
          if(this.hp<=0)this.kill();
        }else if(p.hurt()){/* dano */}
      }
    }
  }
  kill(){this.dead=true;game.score+=100;SFX.stomp();spawnParticles(this.x+14,this.y+12,'#fff',8);}
}
function nearestPlayer(x,y){
  let best=null,bd=1e9;
  for(const p of game.players){if(p.dead)continue;const d=Math.hypot(p.x-x,p.y-y);if(d<bd){bd=d;best=p;}}
  return best;
}

class Mount{
  constructor(x,y,variant){
    this.x=x;this.y=y;this.w=52;this.h=40;this.vx=0;this.vy=0;
    this.variant=variant||'green';this.rider=null;this.lost=false;this.lostTimer=0;
    this.dir=1;this.anim=0;this.tongue=0;this.egg=null;
    const stats={green:{speed:5.2,jump:1.15},blue:{speed:4.6,jump:1.35},yellow:{speed:6.0,jump:1.1}};
    this.stats=stats[this.variant]||stats.green;
  }
  update(){
    this.anim++;
    if(this.lost){this.lostTimer--;if(this.lostTimer<=0){this.lost=false;this.x=game.checkpoint.x;this.y=game.checkpoint.y;}return;}
    const r=this.rider;
    let move=0;
    if(r&&!r.dead){
      const inp=readInput(r.idx);
      if(inp.left){move=-1;this.dir=-1;}
      if(inp.right){move=1;this.dir=1;}
      // língua: pular perto de inimigo engole
      if(inp.jumpPressed){
        for(const e of game.enemies){
          if(!e.dead&&Math.abs(e.x-this.x)<70&&Math.abs(e.y-this.y)<50){
            e.kill();this.tongue=20;game.score+=200;SFX.power();
            this.egg={x:this.x+this.dir*30,y:this.y,vx:this.dir*6,vy:-6,life:180};
            break;
          }
        }
      }
    }
    const max=this.stats.speed*(r&&readInput(r.idx).run?1.25:1);
    this.vx+=move*0.3;
    if(!move)this.vx-=Math.sign(this.vx)*Math.min(Math.abs(this.vx),0.25);
    this.vx=clamp(this.vx,-max,max);
    this.vy=Math.min(this.vy+0.55,12);
    this.x+=this.vx;this.y+=this.vy;
    const t=tileAt(this.x+26,this.y+this.h+2);
    if(solidTile(t)){this.y=Math.floor((this.y+this.h)/TILE)*TILE-this.h;this.vy=0;}
    if(this.egg){
      this.egg.x+=this.egg.vx;this.egg.y+=this.egg.vy;this.egg.vy+=0.4;this.egg.life--;
      for(const e of game.enemies)if(!e.dead&&overlap(this.egg,e)){e.kill();this.egg=null;break;}
      if(this.egg&&this.egg.life<=0)this.egg=null;
    }
  }
}

class Boss{
  constructor(kind,x,y){
    this.kind=kind;this.x=x;this.y=y;this.w=kind==='king'?64:56;this.h=kind==='king'?64:56;
    this.vx=0;this.vy=0;this.hp=kind==='king'?3:5;this.maxHp=this.hp;
    this.t=0;this.dead=false;this.phase=1;this.shootT=90;this.flash=0;
  }
  update(){
    if(this.dead)return;
    this.t++;if(this.flash>0)this.flash--;
    const p=nearestPlayer(this.x,this.y);
    const speed=1+this.phase*0.5;
    if(this.kind==='king'){
      // Rei Pedra: pula em direção ao jogador e joga rochas
      if(this.t%70===0&&p){this.vy=-11;this.vx=Math.sign(p.x-this.x)*3.2;}
      this.shootT--;
      if(this.shootT<=0){this.shootT=Math.max(50,110-this.phase*20);
        game.projectiles.push({x:this.x+30,y:this.y,vx:(p?p.x-this.x:0)/60,vy:-4,hostile:true,r:9,life:300,rock:true});}
    }else{
      // Rainha Sombra: flutua, teleporta e atira em leque
      this.y+=Math.sin(this.t*0.05)*1.5;
      if(this.t%240===0&&p){this.x=clamp(p.x+(Math.random()<0.5?-200:200),100,game.levelW*TILE-200);spawnParticles(this.x+28,this.y+28,'#b388ff',12);}
      this.shootT--;
      if(this.shootT<=0){this.shootT=Math.max(40,100-this.phase*15);
        for(let i=-1;i<=1;i++)game.projectiles.push({x:this.x+28,y:this.y+40,vx:i*1.6+(p?Math.sign(p.x-this.x)*1.5:0),vy:2.5,hostile:true,r:6,life:240});}
    }
    this.vy=Math.min(this.vy+0.5,12);this.y+=this.vy;this.x+=this.vx;
    const t=tileAt(this.x+this.w/2,this.y+this.h+2);
    if(solidTile(t)){this.y=Math.floor((this.y+this.h)/TILE)*TILE-this.h;this.vy=0;this.vx*=0.8;}
    this.phase=this.hp>=this.maxHp-1?1:this.hp>=3?2:3;
    for(const pl of game.players){
      if(pl.dead)continue;
      if(overlap(this,rect(pl.x,pl.y,pl.w,pl.hNow))){
        if(pl.star>0){this.hit();continue;}
        const stomp=pl.vy>0&&(pl.y+pl.hNow)-this.y<20;
        if(stomp){this.hit();pl.vy=PHYSICS.stompBounce;}
        else pl.hurt();
      }
    }
    // fogo dos jogadores
    for(const pr of game.projectiles){
      if(!pr.hostile&&overlap(pr,this)){pr.life=0;this.hit();}
    }
  }
  hit(){this.hp--;this.flash=12;SFX.stomp();if(this.hp<=0){this.dead=true;game.score+=2000;spawnParticles(this.x+30,this.y+30,'#ffd93b',30);SFX.goal();}}
}

// ---------- Tiles ----------
function tileAt(px,py){
  const tx=Math.floor(px/TILE),ty=Math.floor(py/TILE);
  if(ty<0||ty>=game.tiles.length)return'#';
  if(tx<0||tx>=game.tiles[0].length)return'#';
  return game.tiles[ty][tx];
}
function solidTile(t){return['#','=','X','B','?','U','S','P','p','D'].includes(t)||(t==='T'&&game.switchOn);}
function setTile(px,py,ch){
  const tx=Math.floor(px/TILE),ty=Math.floor(py/TILE);
  if(game.tiles[ty]&&game.tiles[ty][tx]!==undefined)game.tiles[ty][tx]=ch;
}

// ---------- Partículas ----------
let particles=[];
function spawnParticles(x,y,color,n){for(let i=0;i<n;i++)particles.push({x,y,vx:(Math.random()-0.5)*6,vy:(Math.random()-0.5)*6-2,life:30+Math.random()*20,color});}

// ---------- Jogo ----------
let game=null;
function newGame(levelIdx,mode,playerCount){
  const L=LEVELS[levelIdx];
  const tiles=L.map.map(r=>r.split(''));
  const players=[];
  for(let i=0;i<playerCount;i++)players.push(new Player(i,L.spawn.x+i*40,L.spawn.y));
  game={
    level:L,levelIdx,mode,tiles,players,
    levelW:tiles[0].length,levelH:tiles.length,
    enemies:L.enemies.map(e=>new Enemy(e.type,e.x,e.y)),
    items:L.items.map(it=>({...it,w:22,h:22,vy:0,vx:it.type==='coin'?0:1.2,t:0})),
    platforms:(L.platforms||[]).map(p=>({...p,ox:p.x,oy:p.y,t:Math.random()*100})),
    projectiles:[],boss:L.boss?new Boss(L.boss,100*TILE,200):null,
    mountEntity:L.mount?new Mount(L.mount.x,L.mount.y,L.mount.variant):null,
    coins:0,score:0,lives:5,time:L.time||300,timeAcc:0,
    checkpoint:{x:L.spawn.x,y:L.spawn.y},switchOn:false,
    cam:{x:0,y:0,scale:1},tempBlocks:{},raceDone:false,survivalT:0,spawnT:0,
    finished:false,paused:false,msg:'',msgT:0,
  };
  particles=[];
  showScreen('screen-game');
  document.getElementById('hud-level').textContent=L.name;
  document.getElementById('hud-mode').textContent={campaign:'Campanha',race:'Corrida',time:'Tempo',survival:'Sobrevivência'}[mode];
  if(L.secret)game.msg=L.secret,game.msgT=300;
}

// Colisão do jogador com tiles (AABB, resolve eixo a eixo)
function collidePlayer(p){
  const P=PHYSICS;
  p.h=p.hNow;
  // X
  p.x+=p.vx;
  let box=rect(p.x,p.y,p.w,p.h);
  for(let ty=Math.floor(box.y/TILE);ty<=Math.floor((box.y+box.h)/TILE);ty++)
  for(let tx=Math.floor(box.x/TILE);tx<=Math.floor((box.x+box.w)/TILE);tx++){
    const t=game.tiles[ty]?.[tx];
    if(solidTile(t)){
      if(p.vx>0)p.x=tx*TILE-p.w; else if(p.vx<0)p.x=(tx+1)*TILE;
      p.vx=0;p.skid=true;
    }
  }
  // Y
  p.y+=p.vy;p.onGround=false;
  box=rect(p.x,p.y,p.w,p.h);
  for(let ty=Math.floor(box.y/TILE);ty<=Math.floor((box.y+box.h)/TILE);ty++)
  for(let tx=Math.floor(box.x/TILE);tx<=Math.floor((box.x+box.w)/TILE);tx++){
    const t=game.tiles[ty]?.[tx];
    if(solidTile(t)){
      if(p.vy>0){p.y=ty*TILE-p.h;p.onGround=true;p.vy=0;p.coyote=P.coyote;}
      else if(p.vy<0){
        p.y=(ty+1)*TILE;p.vy=0;
        hitBlockFromBelow(p,tx,ty,t);
      }
    }
    if(t==='^'||t==='~'){
      if(overlap(rect(p.x,p.y,p.w,p.h),rect(tx*TILE,ty*TILE,TILE,TILE)))p.hurt();
    }
    if(t==='C'){game.checkpoint={x:tx*TILE,y:ty*TILE-40};}
    if(t==='G'||t==='g'){
      if(overlap(rect(p.x,p.y,p.w,p.h),rect(tx*TILE,ty*TILE,TILE,TILE)))completeLevel(t==='g');
    }
    if(t==='D'||t==='P'||t==='p'){
      // cano/porta: segurar ↓ entra → teletransporta p/ saída secreta
      const inp=readInput(p.idx);
      if(inp.down&&overlap(rect(p.x,p.y,p.w,p.h),rect(tx*TILE,ty*TILE,TILE,TILE))){
        const sg=game.level.secretGoal;
        if(sg){p.x=sg.x;p.y=sg.y;}
      }
    }
    if(t==='S'){
      if(overlap(rect(p.x,p.y,p.w,p.h),rect(tx*TILE,ty*TILE,TILE,TILE))&&!game.switchOn){
        game.switchOn=true;SFX.power();game.msg='Interruptor ativado! Blocos temporários sólidos.';game.msgT=200;
      }
    }
  }
  // rampas R/r: altura interpolada
  const footT=tileAt(p.x+p.w/2,p.y+p.h+2);
  if(footT==='R'||footT==='r'){
    const tx=Math.floor((p.x+p.w/2)/TILE),ty=Math.floor((p.y+p.h+2)/TILE);
    const frac=(p.x+p.w/2-tx*TILE)/TILE;
    const slope=footT==='R'?frac:1-frac;
    const groundY=ty*TILE+(1-slope)*TILE;
    if(p.y+p.h>=groundY-2&&p.vy>=0){p.y=groundY-p.h;p.onGround=true;p.coyote=P.coyote;}
  }
  // plataformas móveis
  for(const pl of game.platforms){
    if(overlap(rect(p.x,p.y,p.w,p.h),rect(pl.x,pl.y,pl.w,pl.h))){
      if(p.vy>=0&&(p.y+p.h)-pl.y<14){p.y=pl.y-p.h;p.vy=0;p.onGround=true;p.coyote=P.coyote;p.x+=pl.dx||0;p.y+=pl.dy||0;}
    }
  }
  // montaria: pular nela monta
  const m=game.mountEntity;
  if(m&&!m.lost&&!m.rider&&!p.mount){
    if(overlap(rect(p.x,p.y,p.w,p.h),rect(m.x,m.y,m.w,m.h))&&p.vy>0){
      m.rider=p;p.mount=m;p.vy=-8;SFX.jump();
    }
  }
  if(p.mount){p.x=p.mount.x+14;p.y=p.mount.y-p.h;}
  // queda no vazio
  if(p.y>game.levelH*TILE+100)p.die();
}

function hitBlockFromBelow(p,tx,ty,t){
  const cx=tx*TILE+16,cy=ty*TILE;
  if(t==='B'){
    if(p.big||p.state==='fire'||p.state==='cape'){setTile(cx,cy,' ');SFX.break_();spawnParticles(cx,cy,'#c98a4b',10);game.score+=50;}
    else{SFX.stomp();}
  }else if(t==='?'){
    setTile(cx,cy,'U');
    const types=['mushroom','flower','cape','star','1up','coin'];
    const type=types[Math.floor(Math.random()*types.length)];
    game.items.push({type,x:cx-11,y:cy-30,w:22,h:22,vy:-4,vx:0,t:0});
    SFX.power();
  }else if(t==='H'){
    setTile(cx,cy,'?');SFX.power();game.msg='Bloco oculto encontrado!';game.msgT=150;
  }else if(t==='T'){
    // temporária some
    setTile(cx,cy,' ');setTimeout(()=>setTile(cx,cy,'T'),4000);
  }
}

function completeLevel(secret){
  if(game.finished)return;
  game.finished=true;SFX.goal();
  const id=game.level.id;
  if(!save.done.includes(id))save.done.push(id);
  if(secret&&!save.secret.includes(id))save.secret.push(id);
  save.coins+=game.coins;persist();
  const next=WORLD_MAP.unlockOrder.indexOf(id)+1;
  showOverlay(`Fase concluída! ${secret?'SAÍDA SECRETA! ':''}🎉`,
    `${game.level.name} — moedas: ${game.coins} · pontos: ${game.score}`,
    [{label:'🗺 Voltar ao mapa',fn:()=>{hideOverlay();showWorldMap();}},
     {label:'↻ Jogar de novo',fn:()=>{hideOverlay();newGame(game.levelIdx,game.mode,game.players.length);}}]);
}

function updatePlayer(p,dt){
  if(p.dead){
    p.deadTimer-=dt;
    if(p.deadTimer<=0){
      if(game.lives<0){gameOver();return;}
      p.dead=false;p.x=game.checkpoint.x;p.y=game.checkpoint.y;p.vx=0;p.vy=0;
      p.state='small';p.invuln=120;p.flying=false;
    }
    return;
  }
  const P=PHYSICS,inp=readInput(p.idx);
  if(p.finished)return;
  if(p.star>0)p.star-=dt;
  if(p.invuln>0)p.invuln-=dt;
  if(p.coyote>0)p.coyote--;
  if(inp.jumpPressed)p.jbuf=P.jumpBuffer; else if(p.jbuf>0)p.jbuf--;

  const maxSpeed=inp.run?P.runMax:P.walkMax;
  const accel=p.onGround?P.accelGround:P.accelAir;
  const want=(inp.right?1:0)-(inp.left?1:0);
  if(want!==0){
    p.dir=want;
    // skid: virar em velocidade
    if(p.onGround&&Math.sign(p.vx)===-want&&Math.abs(p.vx)>2){p.skid=true;p.vx+=want*P.skidDecel;}
    else p.vx+=want*accel;
  }else if(p.onGround){
    p.vx-=Math.sign(p.vx)*Math.min(Math.abs(p.vx),P.friction);
  }
  p.vx=clamp(p.vx,-maxSpeed,maxSpeed);
  if(Math.abs(p.vx)<0.05)p.vx=0;

  // pulo
  const jumpBoost=p.mount?P.mountJumpBoost:1;
  if(p.jbuf>0&&(p.onGround||p.coyote>0)){
    p.vy=(inp.run?P.jumpRun:P.jumpWalk)*jumpBoost;
    p.onGround=false;p.coyote=0;p.jbuf=0;SFX.jump();
    // decolagem do Manto: velocidade alta + pulo
    if(p.state==='cape'&&Math.abs(p.vx)>P.capeMinSpeed){p.flying=true;}
  }
  if(!inp.jump&&p.vy<0&&!p.flying)p.vy*=P.jumpCut;

  // voo do Manto (física: precisa de velocidade, perde altitude)
  if(p.flying){
    if(inp.jump)p.vy=Math.max(p.vy-0.35,P.capeClimb);
    else p.vy=Math.min(p.vy+0.18,P.capeGlide);
    if(inp.down)p.vy=Math.min(p.vy+0.5,P.capeDive);
    if(p.onGround||Math.abs(p.vx)<2){p.flying=false;}
    if(p.vy>0&&Math.random()<0.3)spawnParticles(p.x+12,p.y+p.h,'#fff',1);
  }else{
    p.vy=Math.min(p.vy+P.gravity,P.maxFall);
  }

  // item reserva
  if(inp.itemPressed&&p.reserve){p.powerUp(p.reserve);p.reserve=null;}
  // desmontar
  if(inp.mountPressed&&p.mount){p.dismount(false);p.vy=-6;}

  collidePlayer(p);
  p.anim+=Math.abs(p.vx)*0.4+(p.onGround?0:2);

  // itens coletados
  for(const it of game.items){
    if(it.taken)continue;
    if(overlap(rect(p.x,p.y,p.w,p.hNow),it)){
      it.taken=true;
      if(it.type==='coin'){game.coins++;SFX.coin();}
      else if(it.type==='1up'){p.powerUp('1up');}
      else{
        // se já tem poder, guarda na reserva
        if(p.state!=='small'&&it.type!=='star'&&!p.reserve)p.reserve=it.type;
        else p.powerUp(it.type);
      }
      spawnParticles(it.x+11,it.y+11,'#ffd93b',6);
    }
  }
  // projéteis do jogador (fogo)
  if(p.state==='fire'&&inp.jumpPressed&&!p._fireCd){/* fogo via botão de correr? usa item */}
  if(p.state==='fire'&&inp.run&&!p._fireCd){
    p._fireCd=20;
    game.projectiles.push({x:p.x+p.dir*20,y:p.y+10,vx:p.dir*7,vy:0,hostile:false,r:6,life:120});
    SFX.fire();
  }
  if(p._fireCd>0)p._fireCd--;

  // meta por posição (corrida)
  if(game.mode==='race'&&!p.finished){
    const g=game.level.goal;
    if(p.x>g.x-20){p.finished=true;p.finishTime=game.timeAcc;game.raceDone=true;
      showOverlay('🏁 Corrida terminada!',`${p.name} venceu em ${Math.round(p.finishTime)}s!`,
        [{label:'🗺 Mapa',fn:()=>{hideOverlay();showWorldMap();}},{label:'↻ De novo',fn:()=>{hideOverlay();newGame(game.levelIdx,'race',game.players.length);}}]);
    }
  }
}

function update(dt){
  if(!game||game.paused||game.finished)return;
  game.timeAcc+=dt/60;
  if(game.mode!=='survival'){
    game.time-=dt/60;
    if(game.time<=0){gameOver();return;}
  }else{
    game.survivalT+=dt/60;
    game.spawnT-=dt;
    if(game.spawnT<=0){
      game.spawnT=180;
      const types=['walker','flyer','chaser','shooter','hider','armored'];
      game.enemies.push(new Enemy(types[Math.floor(Math.random()*types.length)],game.cam.x+W+60,200+Math.random()*200));
    }
  }
  for(const p of game.players)updatePlayer(p,dt);
  for(const e of game.enemies)e.update(dt);
  game.enemies=game.enemies.filter(e=>!e.dead);
  if(game.boss)game.boss.update();
  if(game.mountEntity)game.mountEntity.update();
  // plataformas móveis
  for(const pl of game.platforms){
    pl.t+=dt*0.02*pl.speed;
    const off=Math.sin(pl.t)*pl.range;
    const nx=pl.axis==='x'?pl.ox+off:pl.ox, ny=pl.axis==='y'?pl.oy+off:pl.oy;
    pl.dx=nx-pl.x;pl.dy=ny-pl.y;pl.x=nx;pl.y=ny;
  }
  // itens
  for(const it of game.items){
    if(it.taken)continue;
    it.t++;
    if(it.type!=='coin'){
      it.vy=Math.min(it.vy+0.3,6);it.y+=it.vy;it.x+=it.vx;
      const t=tileAt(it.x+11,it.y+22);
      if(solidTile(t)){it.y=Math.floor((it.y+22)/TILE)*TILE-22;it.vy=0;it.vx*=-1;}
    }
  }
  game.items=game.items.filter(i=>!i.taken);
  // projéteis
  for(const pr of game.projectiles){
    pr.x+=pr.vx;pr.y+=pr.vy;pr.life--;
    if(pr.rock)pr.vy+=0.3;
    if(!pr.hostile){
      for(const e of game.enemies)if(!e.dead&&overlap(pr,e)){e.hp--;if(e.hp<=0)e.kill();pr.life=0;break;}
    }else{
      for(const p of game.players)if(!p.dead&&overlap(pr,rect(p.x,p.y,p.w,p.hNow))){p.hurt();pr.life=0;break;}
    }
  }
  game.projectiles=game.projectiles.filter(p=>p.life>0);
  // partículas
  for(const pt of particles){pt.x+=pt.vx;pt.y+=pt.vy;pt.vy+=0.2;pt.life--;}
  particles=particles.filter(p=>p.life>0);
  // câmera multiplayer (grupo)
  updateCamera();
  if(game.msgT>0)game.msgT--;
  // HUD
  document.getElementById('hud-coins').textContent='🪙 '+game.coins;
  document.getElementById('hud-time').textContent='⏱ '+(game.mode==='survival'?Math.round(game.survivalT):Math.max(0,Math.ceil(game.time)));
  document.getElementById('hud-players').textContent=game.players.map(p=>`${p.name}:${p.state==='small'?'P':p.state==='big'?'G':p.state==='fire'?'F':'M'}${p.reserve?'['+p.reserve+']':''}${p.dead?' ✝':''}`).join(' · ');
}

function updateCamera(){
  const alive=game.players.filter(p=>!p.dead);
  if(!alive.length)return;
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
  for(const p of alive){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x+p.w);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y+p.hNow);}
  const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
  const spanX=maxX-minX,spanY=maxY-minY;
  const scale=clamp(Math.min(W/(spanX+480),H/(spanY+360)),0.55,1);
  game.cam.scale+=(scale-game.cam.scale)*0.08;
  game.cam.x=clamp(cx-W/(2*game.cam.scale),0,game.levelW*TILE-W/game.cam.scale);
  game.cam.y=clamp(cy-H/(2*game.cam.scale),0,game.levelH*TILE-H/game.cam.scale);
  // retorno por distância: quem ficar >14 tiles do centro volta em bolha
  for(const p of alive){
    if(Math.abs(p.x-cx)>14*TILE||Math.abs(p.y-cy)>10*TILE){
      p.x=cx-12;p.y=cy-20;p.vx=0;p.vy=0;p.invuln=90;
      spawnParticles(p.x,p.y,'#6ee7ff',10);
    }
  }
}

// ---------- Render ----------
const THEMES={
  grass:{sky:'#5db9ff',ground:'#3fa34d',groundTop:'#7ed957',hill:'#2e7d32'},
  cave:{sky:'#1a1a2e',ground:'#4a4a6a',groundTop:'#6a6a9a',hill:'#2a2a4a'},
  beach:{sky:'#7ec8ff',ground:'#e8d27a',groundTop:'#fff3b0',hill:'#d4a017'},
  fortress:{sky:'#3a3a5a',ground:'#6a6a8a',groundTop:'#9a9aba',hill:'#4a4a6a'},
  castle:{sky:'#2a1a3a',ground:'#5a4a7a',groundTop:'#8a7aba',hill:'#3a2a5a'},
};
function draw(){
  if(!game)return;
  const th=THEMES[game.level.theme]||THEMES.grass;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle=th.sky;ctx.fillRect(0,0,W,H);
  const cam=game.cam;
  ctx.save();
  ctx.scale(cam.scale,cam.scale);
  ctx.translate(-cam.x,-cam.y);
  // colinas parallax
  ctx.fillStyle=th.hill;
  for(let i=0;i<20;i++){const hx=i*320-cam.x*0.3;ctx.beginPath();ctx.arc(hx,game.levelH*TILE-60,120,Math.PI,0);ctx.fill();}
  // tiles
  const x0=Math.floor(cam.x/TILE),x1=Math.ceil((cam.x+W/cam.scale)/TILE);
  for(let ty=0;ty<game.levelH;ty++)for(let tx=x0;tx<x1;tx++){
    const t=game.tiles[ty]?.[tx];if(!t||t===' ')continue;
    const px=tx*TILE,py=ty*TILE;
    if(t==='#'){ctx.fillStyle=th.ground;ctx.fillRect(px,py,TILE,TILE);ctx.fillStyle=th.groundTop;ctx.fillRect(px,py,TILE,8);}
    else if(t==='='){ctx.fillStyle='#c98a4b';ctx.fillRect(px,py,TILE,12);}
    else if(t==='X'){ctx.fillStyle='#8d6e63';ctx.fillRect(px,py,TILE,TILE);ctx.strokeStyle='#5d4037';ctx.strokeRect(px+2,py+2,TILE-4,TILE-4);}
    else if(t==='B'){ctx.fillStyle='#d2691e';ctx.fillRect(px,py,TILE,TILE);ctx.strokeStyle='#8b4513';ctx.strokeRect(px+3,py+3,TILE-6,TILE-6);}
    else if(t==='?'){ctx.fillStyle='#ffd93b';ctx.fillRect(px,py,TILE,TILE);ctx.fillStyle='#b3541e';ctx.font='bold 20px sans-serif';ctx.textAlign='center';ctx.fillText('?',px+16,py+23);}
    else if(t==='U'){ctx.fillStyle='#9a6206';ctx.fillRect(px,py,TILE,TILE);}
    else if(t==='H'){/* invisível */}
    else if(t==='S'){ctx.fillStyle='#ff5252';ctx.fillRect(px,py,TILE,TILE);ctx.fillStyle='#fff';ctx.fillRect(px+12,py+12,8,8);}
    else if(t==='T'){ctx.fillStyle=game.switchOn?'#6ee7ff':'#546e7a';ctx.fillRect(px,py,TILE,10);}
    else if(t==='P'||t==='p'){ctx.fillStyle='#2e7d32';ctx.fillRect(px+4,py,TILE-8,TILE);}
    else if(t==='D'){ctx.fillStyle='#8d6e63';ctx.fillRect(px+4,py,TILE-8,TILE);ctx.fillStyle='#ffd93b';ctx.fillRect(px+20,py+14,5,5);}
    else if(t==='G'){ctx.fillStyle='#e0e0e0';ctx.fillRect(px,py,TILE,TILE);ctx.fillStyle='#00c853';ctx.fillRect(px+4,py+4,6,TILE-8);}
    else if(t==='g'){ctx.fillStyle='#fff9c4';ctx.fillRect(px,py,TILE,TILE);ctx.fillStyle='#ffd700';ctx.fillRect(px+4,py+4,6,TILE-8);}
    else if(t==='C'){ctx.fillStyle='#ff80ab';ctx.fillRect(px+14,py,4,TILE);ctx.fillStyle='#ff4081';ctx.fillRect(px+18,py,12,10);}
    else if(t==='^'){ctx.fillStyle='#37474f';for(let i=0;i<4;i++){ctx.beginPath();ctx.moveTo(px+i*8,py+TILE);ctx.lineTo(px+i*8+4,py+8);ctx.lineTo(px+i*8+8,py+TILE);ctx.fill();}}
    else if(t==='~'){ctx.fillStyle='#29b6f6';ctx.fillRect(px,py,TILE,TILE);}
    else if(t==='R'||t==='r'){ctx.fillStyle='#8d6e63';ctx.beginPath();ctx.moveTo(px,py+TILE);ctx.lineTo(px+TILE,py+TILE);ctx.lineTo(px+TILE,py+(t==='R'?TILE:0));ctx.lineTo(px,py+(t==='R'?0:TILE));ctx.closePath();ctx.fill();}
    else if(t==='O'){ctx.fillStyle='#ffd700';ctx.beginPath();ctx.arc(px+16,py+16,9,0,7);ctx.fill();}
  }
  // plataformas móveis
  for(const pl of game.platforms){ctx.fillStyle='#ff7043';ctx.fillRect(pl.x,pl.y,pl.w,pl.h);ctx.fillStyle='#ffccbc';ctx.fillRect(pl.x,pl.y,pl.w,5);}
  // montaria
  if(game.mountEntity)drawMount(game.mountEntity);
  // itens
  for(const it of game.items)drawItem(it);
  // inimigos
  for(const e of game.enemies)drawEnemy(e);
  // chefe
  if(game.boss&&!game.boss.dead)drawBoss(game.boss);
  // projéteis
  for(const pr of game.projectiles){ctx.fillStyle=pr.hostile?'#ff1744':'#ff9100';ctx.beginPath();ctx.arc(pr.x,pr.y,pr.r,0,7);ctx.fill();}
  // jogadores
  for(const p of game.players)drawPlayer(p);
  // jogadores remotos (online entre abas)
  ctx.font='12px sans-serif';
  for(const [id,rp] of remotePlayers){
    ctx.fillStyle='#ffffff88';ctx.beginPath();ctx.arc(rp.x+12,rp.y+15,12,0,7);ctx.fill();
    ctx.fillStyle='#000';ctx.fillText('online',rp.x-8,rp.y-6);
  }
  // partículas
  for(const pt of particles){ctx.fillStyle=pt.color;ctx.fillRect(pt.x,pt.y,4,4);}
  ctx.restore();
  // mensagem
  if(game.msgT>0){ctx.fillStyle='rgba(0,0,0,.6)';ctx.fillRect(W/2-260,20,520,36);ctx.fillStyle='#ffd93b';ctx.font='bold 16px sans-serif';ctx.textAlign='center';ctx.fillText(game.msg,W/2,43);}
  // barra do chefe
  if(game.boss&&!game.boss.dead){
    ctx.fillStyle='rgba(0,0,0,.6)';ctx.fillRect(W/2-150,H-30,300,14);
    ctx.fillStyle='#ff1744';ctx.fillRect(W/2-148,H-28,296*(game.boss.hp/game.boss.maxHp),10);
    ctx.fillStyle='#fff';ctx.font='bold 12px sans-serif';ctx.textAlign='center';
    ctx.fillText(game.boss.kind==='king'?'REI PEDRA':'RAINHA SOMBRA',W/2,H-34);
  }
}
function drawPlayer(p){
  if(p.dead)return;
  if(p.invuln>0&&Math.floor(p.invuln/4)%2===0)return; // piscar
  const bob=p.onGround?Math.sin(p.anim)*2:0;
  const x=p.x,y=p.y+bob;
  // corpo
  ctx.fillStyle=p.star>0?'#ffd700':p.color;
  ctx.fillRect(x,y+8,p.w,p.hNow-8);
  // cabeça
  ctx.fillStyle='#ffe0b2';ctx.fillRect(x+3,y,p.w-6,12);
  ctx.fillStyle='#000';ctx.fillRect(x+(p.dir>0?14:6),y+4,4,4);
  // chapéu por poder
  if(p.state==='fire'){ctx.fillStyle='#ff5722';ctx.fillRect(x+2,y-4,p.w-4,6);}
  if(p.state==='cape'){ctx.fillStyle='#7c4dff';ctx.fillRect(x+2,y-4,p.w-4,6);
    if(p.flying){ctx.fillStyle='#b388ff';ctx.beginPath();ctx.moveTo(x,y+10);ctx.lineTo(x-16,y+20);ctx.lineTo(x,y+26);ctx.fill();}}
  if(p.state==='big'){ctx.fillStyle='#2e7d32';ctx.fillRect(x+2,y-4,p.w-4,6);}
  // nome
  ctx.fillStyle='#fff';ctx.font='bold 11px sans-serif';ctx.textAlign='center';
  ctx.fillText(p.name,x+12,y-8);
  if(p.flying){ctx.fillStyle='#fff';ctx.font='10px sans-serif';ctx.fillText('VOO!',x+12,y+p.hNow+14);}
}
function drawEnemy(e){
  if(e.hidden)return;
  const c={walker:'#8d6e63',flyer:'#ba68c8',chaser:'#ef5350',shooter:'#ffa726',hider:'#78909c',armored:'#90a4ae'}[e.type];
  ctx.fillStyle=e.flash>0?'#fff':c;
  ctx.fillRect(e.x,e.y,e.w,e.h);
  ctx.fillStyle='#000';ctx.fillRect(e.x+6,e.y+6,5,5);ctx.fillRect(e.x+17,e.y+6,5,5);
  if(e.type==='armored'){ctx.fillStyle='#546e7a';ctx.fillRect(e.x-2,e.y-4,e.w+4,8);}
  if(e.type==='flyer'){ctx.fillStyle='#e1bee7';ctx.fillRect(e.x-8,e.y+4,8,4);ctx.fillRect(e.x+e.w,e.y+4,8,4);}
}
function drawItem(it){
  const bob=Math.sin(it.t*0.1)*3;
  const y=it.y+bob;
  if(it.type==='coin'){ctx.fillStyle='#ffd700';ctx.beginPath();ctx.arc(it.x+11,y+11,9,0,7);ctx.fill();}
  else if(it.type==='mushroom'){ctx.fillStyle='#ff5252';ctx.fillRect(it.x+2,y+6,18,10);ctx.fillStyle='#ffe0b2';ctx.fillRect(it.x+6,y+14,10,8);}
  else if(it.type==='flower'){ctx.fillStyle='#ff9100';ctx.beginPath();ctx.arc(it.x+11,y+8,8,0,7);ctx.fill();ctx.fillStyle='#2e7d32';ctx.fillRect(it.x+9,y+14,4,8);}
  else if(it.type==='cape'){ctx.fillStyle='#7c4dff';ctx.fillRect(it.x+4,y+2,14,18);}
  else if(it.type==='star'){ctx.fillStyle='#ffd700';ctx.beginPath();ctx.arc(it.x+11,y+11,10,0,7);ctx.fill();}
  else if(it.type==='1up'){ctx.fillStyle='#ff4081';ctx.beginPath();ctx.arc(it.x+11,y+11,10,0,7);ctx.fill();ctx.fillStyle='#fff';ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.fillText('1UP',it.x+11,y+15);}
}
function drawMount(m){
  if(m.lost)return;
  const c={green:'#66bb6a',blue:'#42a5f5',yellow:'#ffee58'}[m.variant];
  ctx.fillStyle=c;
  ctx.fillRect(m.x,m.y+14,m.w,m.h-14);
  ctx.beginPath();ctx.arc(m.x+(m.dir>0?m.w-8:8),m.y+10,12,0,7);ctx.fill();
  ctx.fillStyle='#000';ctx.fillRect(m.x+(m.dir>0?m.w-4:2),m.y+8,4,4);
  ctx.fillStyle='#fff';ctx.font='10px sans-serif';ctx.textAlign='center';ctx.fillText('TIKO',m.x+26,m.y-4);
  if(m.tongue>0){ctx.fillStyle='#ff8a80';ctx.fillRect(m.x+(m.dir>0?m.w: -30),m.y+16,30,6);m.tongue--;}
  if(m.egg){ctx.fillStyle='#fff59d';ctx.beginPath();ctx.arc(m.egg.x,m.egg.y,8,0,7);ctx.fill();}
}
function drawBoss(b){
  ctx.fillStyle=b.flash>0?'#fff':(b.kind==='king'?'#78909c':'#5e35b1');
  ctx.fillRect(b.x,b.y,b.w,b.h);
  ctx.fillStyle='#ffd700';ctx.fillRect(b.x+10,b.y-10,b.w-20,10);
  ctx.fillStyle='#000';ctx.fillRect(b.x+12,b.y+16,8,8);ctx.fillRect(b.x+b.w-20,b.y+16,8,8);
  ctx.fillStyle='#ff1744';ctx.fillRect(b.x+18,b.y+34,b.w-36,6);
}

// ---------- Loop ----------
let last=0,acc=0;
function loop(ts){
  requestAnimationFrame(loop);
  const dt=Math.min(50,ts-last);last=ts;acc+=dt;
  while(acc>=16.666){update(1);acc-=16.666;}
  draw();
}
requestAnimationFrame(loop);

// ---------- Overlay / telas ----------
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function showOverlay(title,body,buttons){
  const ov=document.getElementById('overlay');
  ov.innerHTML=`<div class="overlay-card"><h2>${title}</h2><p>${body}</p>${buttons.map((b,i)=>`<button class="btn" data-i="${i}">${b.label}</button>`).join('')}</div>`;
  ov.classList.add('show');
  ov.querySelectorAll('button').forEach(btn=>btn.onclick=()=>buttons[+btn.dataset.i].fn());
}
function hideOverlay(){document.getElementById('overlay').classList.remove('show');}
function gameOver(){
  if(!game)return;
  game.finished=true;SFX.die();
  showOverlay('Fim de jogo',`Pontos: ${game.score} · Moedas: ${game.coins}`,
    [{label:'🗺 Mapa',fn:()=>{hideOverlay();showWorldMap();}},{label:'↻ Tentar de novo',fn:()=>{hideOverlay();newGame(game.levelIdx,game.mode,game.players.length);}}]);
}

// ---------- Mapa-múndi ----------
function unlocked(id){
  const i=WORLD_MAP.unlockOrder.indexOf(id);
  if(i<=0)return true;
  return save.done.includes(WORLD_MAP.unlockOrder[i-1]);
}
function showWorldMap(){
  showScreen('screen-map');
  const mc=document.getElementById('map-canvas'),mctx=mc.getContext('2d');
  document.getElementById('map-progress').textContent=`Progresso: ${save.done.length}/${WORLD_MAP.unlockOrder.length} fases · 🪙 ${save.coins} · Saídas secretas: ${save.secret.length}`;
  mctx.clearRect(0,0,mc.width,mc.height);
  // caminhos
  mctx.strokeStyle='#8d6e63';mctx.lineWidth=6;
  for(const [a,b] of WORLD_MAP.paths){
    const na=WORLD_MAP.nodes.find(n=>n.id===a),nb=WORLD_MAP.nodes.find(n=>n.id===b);
    mctx.beginPath();mctx.moveTo(na.x,na.y);mctx.lineTo(nb.x,nb.y);mctx.stroke();
  }
  for(const n of WORLD_MAP.nodes){
    const done=save.done.includes(n.id),open=unlocked(n.id);
    mctx.fillStyle=done?'#00c853':open?'#ffd93b':'#9e9e9e';
    mctx.beginPath();mctx.arc(n.x,n.y,n.type==='level'?22:28,0,7);mctx.fill();
    mctx.strokeStyle='#5d4037';mctx.lineWidth=3;mctx.stroke();
    mctx.fillStyle='#000';mctx.font='bold 11px sans-serif';mctx.textAlign='center';
    mctx.fillText(n.type==='fortress'?'🏰':n.type==='castle'?'👑':n.type==='house'?'🏠':n.type==='secret'?'⭐':'●',n.x,n.y+4);
    mctx.fillStyle='#fff';mctx.fillText(n.label,n.x,n.y+44);
    if(open&&(n.type==='level'||n.type==='fortress'||n.type==='castle')){
      mctx.fillStyle='rgba(0,0,0,.5)';mctx.fillRect(n.x-30,n.y+50,60,20);
      mctx.fillStyle='#6ee7ff';mctx.fillText('Jogar',n.x,n.y+64);
    }
  }
  mc.onclick=e=>{
    const r=mc.getBoundingClientRect();
    const x=(e.clientX-r.left)*(mc.width/r.width),y=(e.clientY-r.top)*(mc.height/r.height);
    for(const n of WORLD_MAP.nodes){
      if(Math.hypot(x-n.x,y-n.y)<30&&unlocked(n.id)&&(n.type==='level'||n.type==='fortress'||n.type==='castle')){
        const idx=LEVELS.findIndex(l=>l.id===n.id);
        newGame(idx,'campaign',countPlayers());
      }
    }
  };
}
function countPlayers(){
  return [1,2,3,4].filter(i=>document.getElementById('slot'+i).checked).length||1;
}

// ---------- UI ----------
document.getElementById('btn-campaign').onclick=()=>showWorldMap();
document.getElementById('btn-race').onclick=()=>newGame(0,'race',countPlayers());
document.getElementById('btn-time').onclick=()=>newGame(0,'time',countPlayers());
document.getElementById('btn-survival').onclick=()=>newGame(0,'survival',countPlayers());
document.getElementById('btn-howto').onclick=()=>showScreen('screen-howto');
document.getElementById('btn-tests').onclick=()=>location.href='tests.html';
document.getElementById('btn-reset-save').onclick=()=>{save={done:[],secret:[],coins:0};persist();showWorldMap();};
document.getElementById('btn-pause').onclick=()=>{
  if(!game)return;
  game.paused=!game.paused;
  if(game.paused)showOverlay('⏸ Pausado','',
    [{label:'Continuar',fn:()=>{game.paused=false;hideOverlay();}},
     {label:'🗺 Mapa',fn:()=>{hideOverlay();showWorldMap();}}]);
};
addEventListener('keydown',e=>{
  if(e.code==='Escape'&&game&&document.getElementById('screen-game').classList.contains('active'))
    document.getElementById('btn-pause').click();
});
window.showScreen=showScreen;window.newGame=newGame;window.showWorldMap=showWorldMap;
