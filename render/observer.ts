import {startGame} from '@game/runtime';
import {LoadingScreen} from '@game/LoadingScreen';
import {initialLoading} from '@game/loading';
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import './observer.css';

const canvas=document.querySelector('canvas')!;
const frame=document.querySelector('iframe')!;
const overlay=createRoot(document.getElementById('loading')!);
let progress=initialLoading(),status='Waiting for the local bot…',error='',ready=false,dispose:(()=>void)|undefined,currentRun='',starting=false;
const paint=()=>{(window as any).__dqObserverStatus={ready,status,error,progress};frame.style.visibility=ready&&!error?'visible':'hidden';overlay.render(!ready||error?createElement(LoadingScreen,{progress,status,error,onExit:()=>{}}):null);};

// A passive rendering transport carries actual authenticated game frames from
// the single player process. It cannot send commands or redeem a game ticket.
class ObserverSocket {
  static OPEN=1;static CLOSED=3;static CONNECTING=0;
  readyState=0;bufferedAmount=0;onopen:any;onmessage:any;onclose:any;onerror:any;stream:EventSource;
  constructor(world:string,runId:string){
    this.stream=new EventSource('/render/stream?'+new URLSearchParams({world,runId}));
    this.stream.onopen=()=>{this.readyState=1;this.onopen?.(new Event('open'));};
    this.stream.onmessage=event=>this.onmessage?.(new MessageEvent('message',{data:event.data}));
    this.stream.addEventListener('session-end',()=>this.close());
    this.stream.onerror=()=>{this.onerror?.(new Event('error'));this.close();};
  }
  send(_raw:string){ /* Read-only observer: no gameplay traffic leaves this renderer. */ }
  close(){if(this.readyState===3)return;this.readyState=3;this.stream.close();this.onclose?.(new CloseEvent('close',{code:1000,reason:'Bot observer session ended',wasClean:true}));}
  addEventListener(name:string,listener:any){(this as any)['on'+name]=listener;}
  removeEventListener(name:string,listener:any){if((this as any)['on'+name]===listener)(this as any)['on'+name]=null;}
}
async function check(){
  if(starting)return;
  try{
    const response=await fetch('/render/bootstrap',{cache:'no-store'});
    if(!response.ok){if(!currentRun){status='Start the bot to see its first-person game view.';paint();}return;}
    const boot=await response.json();
    if(boot.runId===currentRun)return;
    starting=true;dispose?.();delete (window as any).__dqObserverFrame;ready=false;error='';progress=initialLoading();status='Opening the bot’s live world…';paint();
    const character=boot.character;
    // This is an observer projection of the actual entry and authenticated
    // owned roster. It carries no ticket and grants no player authority.
    const grant={...boot.entry,characterId:boot.characterId,appearance:character.appearance,faction:character.faction,classId:character.class,
      nativeV50:character.nativeV50,equipment:character.equipment??{},contentLockSha256:boot.contentLockSha256,titleHash:boot.nativeSession.titlePackHash};
    currentRun=boot.runId;
    dispose=startGame(canvas,{characterId:boot.characterId,character,token:'',frame,
      observer:{grant,roster:boot.roster,connect:(world:string)=>new ObserverSocket(world,boot.runId)},
      exit:()=>{},status:(s:string)=>{status=s;paint();},loading:(p:any)=>{progress=p;paint();},
      ready:(r:boolean)=>{ready=r;paint();},failed:(s:string)=>{error=s;ready=false;paint();}} as any);
    // Install the real parent receiver before loading the HUD. Its one-time
    // overlayReady message must belong to this renderer, including after Stop/Start.
    frame.src='/game-ui';
  }catch(e){error=String((e as Error).message);paint();}
  finally{starting=false;}
}
paint();check();setInterval(check,2000);
window.addEventListener('beforeunload',()=>dispose?.());
