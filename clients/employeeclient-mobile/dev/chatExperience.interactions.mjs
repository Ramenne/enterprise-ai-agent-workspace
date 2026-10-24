import assert from 'node:assert/strict';

// Real ChatView + actual attachment components. Only transport/store data are fixtures.
export async function auditChatExperience(page, report, output) {
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(async()=>{
    await window.audit.go('/chat');
    window.audit.ui.toasts=[];
    window.auditDownloadHold={voice1:true};
    const now=Date.now(), file=(id,mime,name)=>({id,mime,name,purpose:id.startsWith('voice')?'voice':'file',size:id.startsWith('voice')?44+8000*12*2:undefined,file_id:id,ver:1,address:''});
    const message=(id,own,body,attachments=[])=>({id,seq:Number(id.slice(1)),author_username:own?'audit-user':'colleague',author_name:own?'我':'林然',body,attachments,mention_usernames:[],created_at:now-30000,allowed_actions:['hide']});
    window.audit.chat.messages=[
      message('m1',false,'新版讨论页的建议我录了语音，重点是消息层级。'),
      message('m2',false,'',[file('voice1','audio/wav','voice.wav')]),
      message('m3',true,'',[file('voice2','audio/wav','voice.wav')]),
      {...message('m4',true,'收到，先处理语音，再核对正文和输入框的可读性。'),reply_to:{id:'m1',author_name:'林然',author_username:'colleague',body:'新版讨论页的建议我录了语音，重点是消息层级。'}},
      message('m5',false,'',[file('img1','image/svg+xml','布局对照.svg')]),
      message('m6',false,'',[file('file1','application/pdf','本轮设计检查清单.pdf')]),
      message('m7',false,'',[file('audio-file','audio/mp4','会议音频资料.m4a')]),
    ];
  });
  const first=page.locator('[data-message-id="m2"] .voice-bubble');
  const second=page.locator('[data-message-id="m3"] .voice-bubble');
  await first.scrollIntoViewIfNeeded();
  assert.equal(await page.locator('[data-message-id="m7"] .voice-bubble').count(),0);
  assert.equal(await page.locator('[data-message-id="m7"] .attachment-info strong').count(),1);
  const voiceBox=await first.boundingBox();assert.ok(voiceBox.width<160 && voiceBox.height>=44 && voiceBox.height<=46,JSON.stringify(voiceBox));
  assert.equal(await page.locator('.chat-bubble.media-message .chat-file.audio-file').count(),0);
  assert.equal(await page.locator('.voice-message .voice-player').count(),0);
  assert.equal(await page.locator('.voice-message').count(),2);
  assert.equal(await page.locator('[data-message-id="m3"]').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
  assert.equal(await second.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(223, 234, 255)');
  // Long press on the real play button opens reply without triggering playback.
  const box=await first.boundingBox();await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.waitForTimeout(520);await page.mouse.up();
  await page.getByRole('dialog',{name:'消息操作'}).waitFor();
  assert.equal(await first.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  await page.screenshot({path:`${output}/chat-voice-actions-390.png`});
  await page.locator('.message-actions-mask').click({position:{x:3,y:3}});
  await page.getByRole('dialog',{name:'消息操作'}).waitFor({state:'hidden'});
  assert.equal(await page.locator('.actions-active').count(),0);
  assert.equal(await page.locator('[data-message-id="m2"] .chat-bubble').evaluate(el=>document.activeElement===el),false);
  await page.locator('[data-message-id="m2"] .chat-bubble').dispatchEvent('contextmenu');
  await page.getByRole('dialog',{name:'消息操作'}).waitFor();
  assert.equal(await page.locator('.voice-message audio').evaluateAll(items=>items.some(el=>!el.paused)),false);
  await page.getByRole('button',{name:'引用回复',exact:true}).click();
  assert.match(await page.locator('.chat-quote').innerText(),/林然/);
  await page.getByRole('button',{name:'取消引用'}).click();
  // Transcription is an explicit long-press action, never autoplay/auto-upload.
  await first.scrollIntoViewIfNeeded();await page.waitForTimeout(100);
  await page.evaluate(()=>window.auditTranscriptionFail=true);
  await page.locator('[data-message-id="m2"] .chat-bubble').dispatchEvent('contextmenu');
  await page.getByRole('button',{name:'转文字',exact:true}).click();
  await page.locator('.voice-transcript [role=alert]').waitFor();
  await page.evaluate(()=>window.auditTranscriptionFail=false);
  await page.locator('.voice-transcript').getByRole('button',{name:'重试',exact:true}).click();
  await page.locator('.voice-transcript').getByText('明天下午三点开项目会议。',{exact:true}).waitFor();
  await page.screenshot({path:`${output}/chat-voice-transcript-390.png`});
  assert.equal(await page.locator('.voice-transcript').getByRole('button',{name:'收起',exact:true}).count(),0);
  await page.locator('.voice-transcript').dispatchEvent('contextmenu');
  await page.getByRole('button',{name:'收起文字',exact:true}).click();
  assert.equal(await page.locator('.voice-transcript').count(),0);
  await page.evaluate(()=>window.auditTranscriptionHold=true);
  await second.scrollIntoViewIfNeeded();await page.waitForTimeout(100);
  await page.locator('[data-message-id="m3"] .chat-bubble').dispatchEvent('contextmenu');
  await page.getByRole('button',{name:'转文字',exact:true}).click();
  await page.locator('.voice-transcript').getByRole('button',{name:'取消',exact:true}).click();
  await page.evaluate(()=>window.auditTranscriptionHold=false);await page.waitForTimeout(60);
  assert.equal(await page.locator('.voice-transcript').count(),0);
  // Switching while URL 1 is pending invalidates it, even if its transport ignores abort.
  await page.evaluate(()=>window.auditDownloadHold={voice1:true});
  await first.click();await second.click();
  await second.getByText('12″',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-message-id="m3"] audio')?.paused===false);
  await page.evaluate(()=>window.auditDownloadHold.voice1=false);await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-message-id="m2"] audio').count(),0);
  await first.click();await page.waitForFunction(()=>document.querySelector('[data-message-id="m2"] .voice-bubble')?.getAttribute('aria-label')==='暂停语音');
  assert.equal(await page.locator('[data-message-id="m3"] audio').evaluate(el=>el.paused),true);
  await first.click();assert.equal(await first.getAttribute('aria-label'),'继续播放语音');
  await first.click();await page.waitForFunction(()=>document.querySelector('[data-message-id="m2"] .voice-bubble')?.getAttribute('aria-label')==='暂停语音');
  // Scroll movement cancels both long press and accidental play.
  await first.click();const moved=await first.boundingBox();await page.mouse.move(moved.x+20,moved.y+20);await page.mouse.down();await page.mouse.move(moved.x+42,moved.y+20);await page.mouse.up();
  assert.equal(await first.getAttribute('aria-label'),'继续播放语音');
  // Visibility-loaded image is already the message, with one click to enlarge.
  await page.locator('[data-message-id="m5"]').scrollIntoViewIfNeeded();
  const image=page.getByRole('button',{name:'查看原图 布局对照.svg'});await image.scrollIntoViewIfNeeded();
  const imageBox=await image.boundingBox();await page.mouse.move(imageBox.x+imageBox.width/2,imageBox.y+imageBox.height/2);await page.mouse.down();await page.waitForTimeout(520);await page.mouse.up();
  await page.getByRole('dialog',{name:'消息操作'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'转文字',exact:true}).count(),0);
  await page.locator('.message-actions-mask').click({position:{x:3,y:3}});
  await page.getByRole('dialog',{name:'消息操作'}).waitFor({state:'hidden'});
  assert.equal(await page.locator('[data-message-id="m5"] .chat-bubble').evaluate(el=>document.activeElement===el),false);
  assert.equal(await image.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  await image.click();
  await page.getByRole('dialog',{name:'布局对照.svg'}).waitFor();await page.keyboard.press('Escape');
  await page.locator('.chat-stream').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:`${output}/chat-experience-390.png`});
  await page.setViewportSize({width:1440,height:960});await page.screenshot({path:`${output}/chat-experience-1440.png`});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{
    const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{window.auditCapture=await capture(constraints);return window.auditCapture;};
  });
  await page.getByRole('button',{name:'切换语音输入',exact:true}).click();
  await page.locator('.member-count').click();await page.locator('#chat-member-status').waitFor();
  await page.locator('#chat-member-status').click();assert.equal(await page.locator('#chat-member-status').count(),1);
  await page.locator('.chat-stream').dispatchEvent('pointerdown');assert.equal(await page.locator('#chat-member-status').count(),0);
  await page.getByRole('button',{name:'更多群聊入口'}).click();await page.locator('.chat-navigation').waitFor();
  await page.keyboard.press('Escape');assert.equal(await page.locator('.chat-navigation').count(),0);
  await page.getByRole('button',{name:'更多消息工具'}).click();
  await page.locator('[data-member-picker-trigger]').click();await page.locator('.chat-member-picker').waitFor();
  await page.locator('.chat-member-picker label').first().click();assert.equal(await page.locator('.chat-member-picker').count(),1);
  await page.locator('.chat-stream').dispatchEvent('pointerdown');assert.equal(await page.locator('.chat-member-picker').count(),0);
  await page.getByRole('button',{name:'切换语音输入',exact:true}).click();
  const hold=page.locator('.composer-hold');let holdBox=await hold.boundingBox();
  await first.click();await page.waitForFunction(()=>document.querySelector('[data-message-id="m2"] audio')?.paused===false);
  await page.mouse.move(holdBox.x+60,holdBox.y+20);await page.mouse.down();
  await page.waitForFunction(()=>!!window.auditCapture);await page.waitForTimeout(1100);
  assert.equal(await page.locator('.voice-message audio').evaluateAll(items=>items.some(el=>!el.paused)),false,'playback continued while recording');
  assert.equal(await first.getAttribute('aria-label'),'播放语音');
  const during=await hold.boundingBox();assert.ok(Math.abs(during.y-holdBox.y)<=1,'hold button jumped: '+JSON.stringify({before:holdBox,after:during}));
  assert.equal(await page.locator('.composer-expanded').isVisible(),false,'attachment panel appeared while holding');
  await page.screenshot({path:`${output}/chat-holding-stable-390.png`});
  await page.mouse.up();
  await page.getByRole('button',{name:'发送语音',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.voice-draft .voice-track small')?.textContent.includes('0:01'));
  assert.equal(await page.evaluate(()=>window.auditCapture.getTracks().every(t=>t.readyState==='ended')),true);
  await page.screenshot({path:`${output}/chat-voice-preview-390.png`});
  await page.locator('.voice-draft').getByRole('button',{name:'取消',exact:true}).click();
  holdBox=await hold.boundingBox();await page.mouse.move(holdBox.x+60,holdBox.y+20);await page.mouse.down();
  await page.waitForTimeout(1100);
  await page.mouse.move(holdBox.x+60,holdBox.y-65);assert.match(await hold.innerText(),/松开取消/);await page.mouse.up();
  await page.waitForTimeout(100);assert.equal(await page.locator('.voice-draft').count(),0);
  assert.equal(await page.evaluate(()=>window.auditCapture.getTracks().every(t=>t.readyState==='ended')),true);
  await page.getByRole('button',{name:'切换文字输入',exact:true}).click();
  // Session replacement must remove any old signed media and stop its audio.
  await first.click();await page.waitForFunction(()=>document.querySelector('[data-message-id="m2"] audio')?.paused===false);
  await page.evaluate(()=>window.audit.session.user={username:'other',nickname:'另一个账号'});
  await page.waitForFunction(()=>document.querySelectorAll('.voice-message audio').length===0);
  report.interactions.push({name:'chat-real-media',passed:true,checks:['voice is a message','long-press reply without autoplay','voice/image dismiss without persistent frame','explicit transcription failure retry collapse cancel','member lists outside-dismiss and inside-preserve','tools to voice transition','stable hold button without attachment expansion','stale URL race','single playback','pause resume','scroll no accidental play','inline image preview','hold to record and release to preview','slide to cancel releases microphone','account cleanup']});
}
