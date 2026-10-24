import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
const built=await build({entryPoints:['src/collaboration/pairingQr.ts'],bundle:true,write:false,format:'esm'});
const {parsePairingQr}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
test('Mac QR pixels decode to the exact one-time credential',()=>{
 const raw='employeeclient-pair:v1:0123456789ABCDEF';const qr=QRCode.create(raw,{errorCorrectionLevel:'M'});const scale=8,margin=4,width=(qr.modules.size+margin*2)*scale;
 const pixels=new Uint8ClampedArray(width*width*4).fill(255);
 for(let y=0;y<qr.modules.size;y++)for(let x=0;x<qr.modules.size;x++)if(qr.modules.get(y,x))for(let yy=0;yy<scale;yy++)for(let xx=0;xx<scale;xx++){let i=(((y+margin)*scale+yy)*width+(x+margin)*scale+xx)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;}
 const decoded=jsQR(pixels,width,width);assert.equal(parsePairingQr(decoded.data),'0123456789ABCDEF');
});
test('Scanner rejects URLs, arbitrary QR data and unsupported versions',()=>{
 for(const s of ['https://evil.example/?code=0123456789ABCDEF','employeeclient-pair:v2:0123456789ABCDEF','employeeclient-pair:v1:0123456789abcdef','employeeclient-pair:v1:0123456789ABCDEF\n','0123456789ABCDEF'])assert.throws(()=>parsePairingQr(s));
});
