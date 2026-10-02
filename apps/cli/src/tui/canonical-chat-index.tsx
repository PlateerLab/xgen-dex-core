import { render } from 'ink';
import { stdout } from 'node:process';
import { DexError } from '@dex/engine';
import { CanonicalTuiChatModel } from './canonical-chat-model';
import { CanonicalChatScreen } from './canonical-chat-screen';
import { createScreenGuard } from './screen';
import type { CanonicalTuiAccount, CanonicalTuiSource } from './canonical-types';
import type { CanonicalTuiChatSource } from './canonical-chat-types';

export async function runCanonicalChatTui(account:CanonicalTuiAccount,source:CanonicalTuiSource):Promise<void>{
  if(!['binding','catalog','create','select','send'].every((key)=>typeof (source as unknown as Record<string,unknown>)[key]==='function')){
    throw new DexError('usage_error','Canonical TUI 쓰기 호스트가 필요합니다.');
  }
  const model=new CanonicalTuiChatModel(account,source as CanonicalTuiChatSource);
  const screen=createScreenGuard(stdout);
  let exit:(()=>void)|undefined;let closing=false;
  const close=()=>{if(closing)return;closing=true;void model.stop();exit?.();};
  const restore=()=>screen.restore();
  process.once('exit',restore);process.on('SIGINT',close);process.on('SIGTERM',close);screen.enter();
  try{
    const instance=render(<CanonicalChatScreen account={account} model={model} onExit={close}/>,{exitOnCtrlC:false,patchConsole:true});
    exit=()=>instance.unmount();if(closing)exit();else void model.read();
    await instance.waitUntilExit();
  }finally{
    try{await model.dispose();}finally{restore();process.off('exit',restore);process.off('SIGINT',close);process.off('SIGTERM',close);}
  }
}
